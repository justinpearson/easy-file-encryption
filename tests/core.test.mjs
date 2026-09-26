// Tests for the streaming crypto core embedded in easy-file-encryption.html.
// Run with:  node --test tests/
// No dependencies: Node's built-in WebCrypto, Blob, File and TextEncoder stand in for the browser's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'easy-file-encryption.html'), 'utf8');
const match = html.match(/<script id="core">([\s\S]*?)<\/script>/);
assert.ok(match, 'easy-file-encryption.html must contain <script id="core">…</script>');
vm.runInThisContext(match[1], { filename: 'easy-file-encryption.html#core' });
const EFE = globalThis.EFE;

// Small chunks so the multi-chunk paths are exercised quickly. Fewer PBKDF2
// iterations keep the suite fast; the default stays at 600k in the page.
const OPTS = { chunkBytes: 1024, iterations: 1000 };
const PASSWORD = 'correct horse battery staple';

function memorySink() {
	const parts = [];
	return {
		parts,
		write(bytes) { parts.push(new Uint8Array(bytes)); },
		bytes() {
			const total = parts.reduce((n, p) => n + p.length, 0);
			const out = new Uint8Array(total);
			let off = 0;
			for (const p of parts) { out.set(p, off); off += p.length; }
			return out;
		},
	};
}

function randomBytes(n) {
	const out = new Uint8Array(n);
	for (let off = 0; off < n; off += 65536) crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, n)));
	return out;
}

async function roundTrip(plain, name, password = PASSWORD, opts = OPTS) {
	const enc = memorySink();
	await EFE.encrypt(new File([plain], name), password, enc, opts);
	const encBytes = enc.bytes();
	const dec = memorySink();
	await EFE.decrypt(new File([encBytes], name + '.enc'), password, dec, opts);
	return { encBytes, decBytes: dec.bytes(), header: await EFE.parseHeader(new File([encBytes], 'x')) };
}

test('round trip restores bytes and original filename', async () => {
	const plain = randomBytes(5000);
	const { decBytes, header, encBytes } = await roundTrip(plain, 'photo 1.jpg');
	assert.deepEqual(decBytes, plain);
	assert.equal(header.name, 'photo 1.jpg');
	assert.ok(await EFE.isEncrypted(new File([encBytes], 'x')));
	assert.equal(await EFE.isEncrypted(new File([plain], 'x')), false);
});

test('empty file round-trips', async () => {
	const { decBytes } = await roundTrip(new Uint8Array(0), 'empty.txt');
	assert.equal(decBytes.length, 0);
});

test('sizes at and around chunk boundaries round-trip', async () => {
	for (const n of [1, 1023, 1024, 1025, 2048, 2049, 3 * 1024 + 7]) {
		const plain = randomBytes(n);
		const { decBytes } = await roundTrip(plain, `size-${n}.bin`);
		assert.deepEqual(decBytes, plain, `size ${n}`);
	}
});

test('ciphertext is larger than plaintext by header plus one tag per chunk', async () => {
	const plain = randomBytes(2048 + 1);
	const { encBytes, header } = await roundTrip(plain, 'ab.bin');
	assert.equal(encBytes.length, header.headerBytes + plain.length + 3 * 16);
});

test('progress callback reports monotonically up to the file size', async () => {
	const plain = randomBytes(2500);
	const seen = [];
	await EFE.encrypt(new File([plain], 'p.bin'), PASSWORD, memorySink(), { ...OPTS, onProgress: (done, total) => seen.push([done, total]) });
	assert.deepEqual(seen, [[1024, 2500], [2048, 2500], [2500, 2500]]);
});

test('wrong password fails with an auth error and writes nothing', async () => {
	const { encBytes } = await roundTrip(randomBytes(3000), 'a.bin');
	const dec = memorySink();
	await assert.rejects(
		EFE.decrypt(new File([encBytes], 'a.bin.enc'), 'wrong password', dec, OPTS),
		(e) => e.code === 'auth',
	);
	assert.equal(dec.parts.length, 0);
});

test('truncating the ciphertext at a chunk boundary is detected', async () => {
	const { encBytes, header } = await roundTrip(randomBytes(3000), 'a.bin');
	const oneChunkShort = encBytes.slice(0, encBytes.length - (3000 - 2048 + 16));
	assert.equal((oneChunkShort.length - header.headerBytes) % (1024 + 16), 0, 'test cut lands on a boundary');
	await assert.rejects(
		EFE.decrypt(new File([oneChunkShort], 'a.bin.enc'), PASSWORD, memorySink(), OPTS),
		(e) => e.code === 'auth',
	);
});

test('reordering two chunks is detected', async () => {
	const { encBytes, header } = await roundTrip(randomBytes(3000), 'a.bin');
	const h = header.headerBytes, step = 1024 + 16;
	const swapped = new Uint8Array(encBytes);
	swapped.set(encBytes.subarray(h + step, h + 2 * step), h);
	swapped.set(encBytes.subarray(h, h + step), h + step);
	await assert.rejects(
		EFE.decrypt(new File([swapped], 'a.bin.enc'), PASSWORD, memorySink(), OPTS),
		(e) => e.code === 'auth',
	);
});

test('tampering with the header filename is detected', async () => {
	const { encBytes, header } = await roundTrip(randomBytes(100), 'ab.bin');
	const tampered = new Uint8Array(encBytes);
	tampered[header.headerBytes - 1] ^= 0xff;
	await assert.rejects(
		EFE.decrypt(new File([tampered], 'x'), PASSWORD, memorySink(), OPTS),
		(e) => e.code === 'auth',
	);
});

test('a file that is not encrypted is rejected before any password work', async () => {
	await assert.rejects(
		EFE.decrypt(new File([randomBytes(500)], 'plain.bin'), PASSWORD, memorySink(), OPTS),
		(e) => e.code === 'not-encrypted',
	);
	await assert.rejects(
		EFE.decrypt(new File([new TextEncoder().encode('ENC2')], 'stub'), PASSWORD, memorySink(), OPTS),
		(e) => e.code === 'corrupt',
	);
});

test('absurd header values are rejected as corrupt rather than allocating', async () => {
	const { encBytes } = await roundTrip(randomBytes(100), 'ab.bin');
	const bad = new Uint8Array(encBytes);
	new DataView(bad.buffer).setUint32(32, 0xffffffff); // chunk size field
	await assert.rejects(
		EFE.decrypt(new File([bad], 'x'), PASSWORD, memorySink(), OPTS),
		(e) => e.code === 'corrupt',
	);
});

test('two encryptions of the same file differ (fresh salt and nonce)', async () => {
	const plain = randomBytes(200);
	const a = memorySink(), b = memorySink();
	await EFE.encrypt(new File([plain], 'x'), PASSWORD, a, OPTS);
	await EFE.encrypt(new File([plain], 'x'), PASSWORD, b, OPTS);
	assert.notDeepEqual(a.bytes(), b.bytes());
});

test('default options use 8 MiB chunks and 600k PBKDF2 iterations', async () => {
	assert.equal(EFE.DEFAULT_CHUNK_BYTES, 8 * 1024 * 1024);
	assert.equal(EFE.DEFAULT_PBKDF2_ITERATIONS, 600_000);
	const enc = memorySink();
	await EFE.encrypt(new File([randomBytes(10)], 'x'), PASSWORD, enc, { iterations: 1000 });
	const header = await EFE.parseHeader(new File([enc.bytes()], 'x'));
	assert.equal(header.chunkBytes, 8 * 1024 * 1024);
	assert.equal(header.iterations, 1000);
});
