// Static checks on easy-file-encryption.html and the files it points at: the tutorial
// videos exist and are small, the page itself stays small, and the Content-Security-Policy
// allows those videos and nothing else new.
// Run with:  node --test tests/page.test.mjs
// No dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'easy-file-encryption.html'), 'utf8');

// The page is sent around as a single file, so it should stay light. It was 18.6 KB before
// the tutorial section was added.
const MAX_PAGE_BYTES = 24 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024;

const videoTags = [...html.matchAll(/<video\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

test('the page has an encrypt and a decrypt tutorial video', () => {
	assert.deepEqual(videoTags.map((tag) => attr(tag, 'src')), ['videos/encrypt.mp4', 'videos/decrypt.mp4']);
});

test('tutorial videos are not fetched until someone plays them', () => {
	for (const tag of videoTags) {
		assert.equal(attr(tag, 'preload'), 'none', tag);
		assert.doesNotMatch(tag, /\bautoplay\b/, tag);
	}
});

test('tutorial video files exist, are MP4, are small, and have no audio track', () => {
	for (const tag of videoTags) {
		const file = join(root, attr(tag, 'src'));
		assert.ok(existsSync(file), `${file} is missing`);
		const bytes = readFileSync(file);
		assert.equal(bytes.subarray(4, 8).toString('latin1'), 'ftyp', `${file} is not an MP4`);
		assert.ok(bytes.length < MAX_VIDEO_BYTES, `${file} is ${bytes.length} bytes`);
		// An audio track would carry a 'soun' handler box.
		assert.equal(bytes.indexOf('soun'), -1, `${file} has an audio track`);
	}
});

test('the page stays small', () => {
	const size = Buffer.byteLength(html);
	assert.ok(size < MAX_PAGE_BYTES, `page is ${size} bytes`);
});

test('the Content-Security-Policy allows same-origin media and no other network access', () => {
	const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1];
	assert.ok(csp, 'no Content-Security-Policy meta tag');
	const directives = Object.fromEntries(
		csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(' ')]),
	);
	assert.deepEqual(directives, {
		'default-src': "'none'",
		'script-src': "'unsafe-inline'",
		'style-src': "'unsafe-inline'",
		'media-src': "'self'",
		'connect-src': "'none'",
		'form-action': "'none'",
		'base-uri': "'none'",
	});
});

test('every relative file the README points at exists', () => {
	const readme = readFileSync(join(root, 'README.md'), 'utf8');
	const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^[a-z]+:/.test(t) && !t.startsWith('#'));
	assert.ok(targets.includes('images/encrypt-demo.gif'), 'README does not show the encrypt walkthrough');
	assert.ok(targets.includes('images/decrypt-demo.gif'), 'README does not show the decrypt walkthrough');
	for (const target of targets) {
		assert.ok(statSync(join(root, target), { throwIfNoEntry: false }), `README points at missing file ${target}`);
	}
});
