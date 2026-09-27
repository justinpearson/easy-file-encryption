#!/usr/bin/env node
// Command-line encrypt/decrypt using the exact crypto core embedded in
// easy-file-encryption.html, so files made here open in the page and vice versa.
//
//   node tools/efe-cli.mjs encrypt [--password-stdin] [--force] INPUT OUTPUT
//   node tools/efe-cli.mjs decrypt [--password-stdin] [--force] INPUT OUTPUT
//
// The password is prompted for without echo, or read as the first line of stdin
// with --password-stdin (for scripts). Output is written to OUTPUT.part and renamed
// into place only after success, and an existing OUTPUT is never overwritten
// without --force. Needs Node 20 or newer; no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'easy-file-encryption.html'), 'utf8');
const core = html.match(/<script id="core">([\s\S]*?)<\/script>/);
if (!core) die('easy-file-encryption.html has no <script id="core"> block.');
vm.runInThisContext(core[1], { filename: 'easy-file-encryption.html#core' });
const EFE = globalThis.EFE;

function die(message, code = 1) {
	process.stderr.write(message + '\n');
	process.exit(code);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const [command, input, output] = positional;
if (!['encrypt', 'decrypt'].includes(command) || !input || !output || positional.length !== 3) {
	die('Usage: efe-cli.mjs encrypt|decrypt [--password-stdin] [--force] INPUT OUTPUT', 2);
}
for (const f of flags) if (!['--password-stdin', '--force'].includes(f)) die(`Unknown option ${f}`, 2);

if (!fs.existsSync(input)) die(`Input not found: ${input}`);
if (fs.existsSync(output) && !flags.has('--force')) die(`Output already exists (use --force to overwrite): ${output}`);

async function readPassword() {
	if (flags.has('--password-stdin')) {
		const text = fs.readFileSync(0, 'utf8');
		return text.split(/\r?\n/, 1)[0];
	}
	if (!process.stdin.isTTY) die('No terminal to prompt on; pass --password-stdin.', 2);
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
		const origWrite = rl._writeToOutput;
		rl.question('Password: ', (answer) => { rl._writeToOutput = origWrite; process.stderr.write('\n'); rl.close(); resolve(answer); });
		rl._writeToOutput = () => {};
	});
}

// The core needs only .size, .name and .slice(a, b).arrayBuffer(); a file-backed Blob
// from openAsBlob provides that without loading the file into memory.
const blob = await fs.openAsBlob(input);
const source = { size: blob.size, name: path.basename(input), slice: (a, b) => blob.slice(a, b) };

const partial = output + '.part';
const fd = fs.openSync(partial, 'w');
let written = 0;
const sink = {
	write(bytes) { fs.writeSync(fd, bytes); written += bytes.length; },
};
let lastPct = -1;
const onProgress = (done, total) => {
	if (!process.stderr.isTTY) return;
	const pct = total ? Math.floor((done / total) * 10) * 10 : 100;
	if (pct !== lastPct) { lastPct = pct; process.stderr.write(`\r${command}ing ${path.basename(input)}: ${pct}%`); }
};

try {
	const password = await readPassword();
	if (!password) die('Empty password.', 2);
	if (command === 'encrypt') await EFE.encrypt(source, password, sink, { onProgress });
	else await EFE.decrypt(source, password, sink, { onProgress });
	fs.closeSync(fd);
	if (process.stderr.isTTY && lastPct >= 0) process.stderr.write('\n');
	fs.renameSync(partial, output);
} catch (e) {
	try { fs.closeSync(fd); } catch {}
	fs.rmSync(partial, { force: true });
	if (process.stderr.isTTY && lastPct >= 0) process.stderr.write('\n');
	if (e.code === 'auth') die('Wrong password, or the file has been damaged.');
	if (e.code === 'not-encrypted') die('Input is not an encrypted file.');
	if (e.code === 'corrupt') die('The encrypted file header is damaged.');
	die(`Error: ${e.message}`);
}
