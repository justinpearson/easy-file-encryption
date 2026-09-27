// Tests for tools/efe-cli.mjs, the command-line wrapper around the page's crypto core.
// Run with:  node --test tests/cli.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'tools', 'efe-cli.mjs');

function cli(args, stdin) {
	return spawnSync(process.execPath, [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

test('encrypt then decrypt round-trips a file, with the password on stdin', () => {
	const dir = mkdtempSync(join(tmpdir(), 'efe-cli-'));
	try {
		const plain = randomBytes(3 * 1024 * 1024 + 123);
		const input = join(dir, 'photos.zip');
		writeFileSync(input, plain);

		const enc = cli(['encrypt', '--password-stdin', input, join(dir, 'photos.zip.enc')], 'hunter2hunter2\n');
		assert.equal(enc.status, 0, enc.stderr);
		assert.ok(existsSync(join(dir, 'photos.zip.enc')));

		const dec = cli(['decrypt', '--password-stdin', join(dir, 'photos.zip.enc'), join(dir, 'restored.zip')], 'hunter2hunter2\n');
		assert.equal(dec.status, 0, dec.stderr);
		assert.deepEqual(readFileSync(join(dir, 'restored.zip')), plain);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a wrong password exits non-zero and leaves no output file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'efe-cli-'));
	try {
		const input = join(dir, 'a.bin');
		writeFileSync(input, randomBytes(1000));
		assert.equal(cli(['encrypt', '--password-stdin', input, join(dir, 'a.bin.enc')], 'right-password\n').status, 0);
		const dec = cli(['decrypt', '--password-stdin', join(dir, 'a.bin.enc'), join(dir, 'a-out.bin')], 'wrong-password\n');
		assert.notEqual(dec.status, 0);
		assert.match(dec.stderr, /Wrong password/);
		assert.equal(existsSync(join(dir, 'a-out.bin')), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('refuses to overwrite an existing output file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'efe-cli-'));
	try {
		const input = join(dir, 'a.bin');
		writeFileSync(input, randomBytes(10));
		writeFileSync(join(dir, 'a.bin.enc'), 'already here');
		const r = cli(['encrypt', '--password-stdin', input, join(dir, 'a.bin.enc')], 'some-password\n');
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /exists/);
		assert.equal(readFileSync(join(dir, 'a.bin.enc'), 'utf8'), 'already here');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the encrypted file records the input filename and the page can identify it', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'efe-cli-'));
	try {
		const input = join(dir, 'stage one.zip');
		writeFileSync(input, randomBytes(10));
		assert.equal(cli(['encrypt', '--password-stdin', input, join(dir, 'stage one.zip.enc')], 'some-password\n').status, 0);
		const head = readFileSync(join(dir, 'stage one.zip.enc'));
		assert.equal(head.subarray(0, 4).toString('latin1'), 'ENC2');
		assert.ok(head.includes(Buffer.from('stage one.zip')));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
