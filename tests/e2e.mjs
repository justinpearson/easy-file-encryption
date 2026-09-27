// Real-browser round trip for easy-file-encryption.html: encrypt a file, decrypt the
// result, check the bytes match, and check a wrong password is rejected.
//
// Needs a Playwright install somewhere on disk (it is not a dependency of this repo).
// Point PLAYWRIGHT_DIR at a directory whose node_modules/ contains playwright, e.g. an
// `npx @playwright/mcp` cache under ~/.npm/_npx/*/. Examples:
//
//   PLAYWRIGHT_DIR=~/.npm/_npx/<hash> node tests/e2e.mjs --browser chrome --size 900 --sink stream
//   PLAYWRIGHT_DIR=~/.npm/_npx/<hash> node tests/e2e.mjs --browser chrome --size 300 --sink blob
//   PLAYWRIGHT_DIR=~/.npm/_npx/<hash> node tests/e2e.mjs --browser webkit --exe /path/to/Playwright.app/Contents/MacOS/Playwright
//
// --browser  chrome (your installed Google Chrome) | chromium | firefox | webkit
// --sink     stream: stub showSaveFilePicker so output streams to disk (Chrome/Edge path)
//            blob:   remove showSaveFilePicker so output goes through a download link (Firefox/Safari path)
// --size     input size in MB (random bytes); default 50
// --exe      explicit browser executable, for browser builds that do not match the Playwright version
// --persistent  use a persistent profile (lets Chromium page large Blobs to disk, as normal Chrome does)

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes('--' + name);
const browserName = opt('browser', 'chrome');
const sinkKind = opt('sink', browserName === 'chrome' || browserName === 'chromium' ? 'stream' : 'blob');
const sizeMB = Number(opt('size', '50'));
const exe = opt('exe', null);
const persistent = flag('persistent');

const pwDir = process.env.PLAYWRIGHT_DIR;
if (!pwDir) { console.error('Set PLAYWRIGHT_DIR (see header comment).'); process.exit(2); }
const pw = createRequire(path.join(pwDir, 'node_modules', 'noop.js'))('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = 'file://' + path.join(here, '..', 'easy-file-encryption.html');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'efe-e2e-'));
const PASSWORD = 'correct horse battery staple';

function sha256(file) {
	const h = crypto.createHash('sha256');
	const fd = fs.openSync(file, 'r');
	const buf = Buffer.alloc(8 * 1024 * 1024);
	for (let n; (n = fs.readSync(fd, buf)) > 0;) h.update(buf.subarray(0, n));
	fs.closeSync(fd);
	return h.digest('hex');
}

function makeInput(file, bytes) {
	const fd = fs.openSync(file, 'w');
	for (let left = bytes; left > 0;) { const n = Math.min(left, 8 * 1024 * 1024); fs.writeSync(fd, crypto.randomBytes(n)); left -= n; }
	fs.closeSync(fd);
}

const input = path.join(work, `input-${sizeMB}MB.bin`);
makeInput(input, sizeMB * 1024 * 1024);
const inputHash = sha256(input);

const launchOpts = { headless: true, ...(exe ? { executablePath: exe } : {}), ...(browserName === 'chrome' ? { channel: 'chrome' } : {}) };
const engine = browserName === 'chrome' ? pw.chromium : pw[browserName];
let browser = null, context;
if (persistent) context = await engine.launchPersistentContext(path.join(work, 'profile'), { ...launchOpts, acceptDownloads: true });
else { browser = await engine.launch(launchOpts); context = await browser.newContext({ acceptDownloads: true }); }
const page = await context.newPage();

const result = { browser: browserName, version: browser ? browser.version() : 'persistent', sink: sinkKind, sizeMB, crashes: 0, pageErrors: [] };
page.on('crash', () => { result.crashes++; });
page.on('pageerror', (e) => { result.pageErrors.push(String(e)); });
page.on('console', (m) => { if (m.type() === 'error') result.pageErrors.push('console: ' + m.text()); });

// Route the page's output to disk according to the sink under test.
const streamed = {};
if (sinkKind === 'stream') {
	await page.exposeBinding('__sinkOpen', (_s, name) => { streamed[name] = fs.openSync(path.join(work, name), 'w'); });
	await page.exposeBinding('__sinkWrite', (_s, name, b64) => { fs.writeSync(streamed[name], Buffer.from(b64, 'base64')); });
	await page.exposeBinding('__sinkClose', (_s, name) => { fs.closeSync(streamed[name]); });
	await page.addInitScript(() => {
		window.showSaveFilePicker = async ({ suggestedName }) => {
			await window.__sinkOpen(suggestedName);
			return {
				name: suggestedName,
				createWritable: async () => ({
					write: async (bytes) => {
						const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(new Blob([bytes])); });
						await window.__sinkWrite(suggestedName, b64);
					},
					close: () => window.__sinkClose(suggestedName),
					abort: () => window.__sinkClose(suggestedName),
				}),
			};
		};
	});
} else {
	await page.addInitScript(() => { delete window.showSaveFilePicker; });
}

const finished = () => {
	const s = document.getElementById('status');
	return /^(Encrypted|Decrypted)/.test(s.textContent) || s.classList.contains('error');
};

async function run(label, inputFile, password, expectButton) {
	const t0 = Date.now();
	await page.goto(PAGE);
	await page.setInputFiles('#file-input', inputFile);
	await page.waitForFunction((b) => document.getElementById('action').textContent === b, expectButton);
	const mode = await page.textContent('#mode');
	await page.fill('#password-input', password);
	const dlPromise = sinkKind === 'blob' ? page.waitForEvent('download', { timeout: 600000 }).catch(() => null) : null;
	await page.click('#action');
	await page.waitForFunction(finished, null, { timeout: 600000 });
	const status = await page.textContent('#status');
	let saved = null;
	if (sinkKind === 'blob' && !status.startsWith('Wrong')) {
		const dl = await dlPromise;
		if (dl) { saved = path.join(work, dl.suggestedFilename()); await dl.saveAs(saved); }
	} else if (sinkKind === 'stream') {
		const m = status.match(/Saved as (.+)\.$/);
		if (m) saved = path.join(work, m[1]);
	}
	result[label] = { mode, status, seconds: (Date.now() - t0) / 1000, saved: saved && path.basename(saved) };
	return saved;
}

try {
	const enc = await run('encrypt', input, PASSWORD, 'Encrypt');
	if (!enc) throw new Error('encryption produced no output file');
	result.encrypt.outputBytes = fs.statSync(enc).size;
	await run('wrongPassword', enc, 'not the password', 'Decrypt');
	const dec = await run('decrypt', enc, PASSWORD, 'Decrypt');
	if (!dec) throw new Error('decryption produced no output file');
	result.decrypt.outputBytes = fs.statSync(dec).size;
	result.decrypt.name = path.basename(dec);
	result.bytesMatch = sha256(dec) === inputHash;
	result.ok = result.bytesMatch
		&& result.decrypt.name === path.basename(input)
		&& result.wrongPassword.status.startsWith('Wrong password')
		&& result.crashes === 0
		&& result.pageErrors.length === 0;
} catch (e) {
	result.ok = false;
	result.error = String(e);
} finally {
	await context.close();
	if (browser) await browser.close();
	fs.rmSync(work, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
