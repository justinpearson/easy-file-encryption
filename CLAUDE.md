# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A single static HTML file, `easy-file-encryption.html`, that encrypts or decrypts a user-selected file in the browser using the Web Crypto API. Encrypting produces a binary `<name>.enc` file; decrypting one of those restores the original. The same page does both, choosing the mode by sniffing the chosen file's magic bytes. There is no server, no build step, no package manager, and no dependencies.

## Running and testing

Open `easy-file-encryption.html` directly in a browser (e.g. `open easy-file-encryption.html` on macOS). All crypto runs client-side via `window.crypto.subtle`, which requires either `file://`, `localhost`, or HTTPS.

The repo is also served by GitHub Pages from the `main` branch root at https://justinpearson.github.io/easy-file-encryption/. `index.html` is only a meta-refresh redirect to `easy-file-encryption.html`, and `.nojekyll` skips the Jekyll build. Pushing to `main` deploys.

Unit tests for the crypto core run under Node (v20+) with nothing installed:

```
node --test tests/core.test.mjs
```

Note that `node --test tests/` (a bare directory) does not work on current Node; pass the file or a glob.

`tests/e2e.mjs` round-trips a file of any size through the page in a real browser and checks the bytes. It needs a Playwright package on disk, located via `PLAYWRIGHT_DIR`; the header comment explains the flags. Use it after any change to the UI script or the sink logic, since the unit tests do not cover those.

## Architecture: two scripts in one file

1. **`<script id="core">`** — the crypto core, an IIFE that assigns `globalThis.EFE = { encrypt, decrypt, isEncrypted, parseHeader, ... }`. It touches no DOM. `tests/core.test.mjs` extracts it from the HTML with a regex on that `id` and runs it under `vm`, so keep it free of `window` and `document` references and keep the `id` attribute intact.
2. **The UI script** — the second `<script>`, which wires the file input, password field, button, progress bar and status line to the core. It also owns the *sink*: where output bytes go. `openSink()` prefers `showSaveFilePicker` (Chrome/Edge), which streams to disk, and falls back to collecting `Blob` parts for a download link (Firefox/Safari).

The core's `encrypt(file, password, sink, opts)` and `decrypt(file, password, sink, opts)` take any Blob-like input with `.slice().arrayBuffer()` and any sink with `write(Uint8Array)`. Options: `chunkBytes`, `iterations`, `onProgress(done, total)`.

## Wire format (`ENC2`)

All integers big-endian.

```
[ MAGIC 'ENC2' (4B) ][ salt (16B) ][ nonce prefix (8B) ][ PBKDF2 iterations (u32) ]
[ chunk size (u32) ][ filename length (u16) ][ filename UTF-8 (n B) ]
then, for each chunk i:  [ AES-256-GCM ciphertext (chunk size B, last chunk shorter) + 16B tag ]
```

- Chunk `i` uses nonce `prefix || u32(i)` and additional authenticated data `header || u32(i) || u8(isLast)`. This binds the header (including filename and KDF parameters), detects reordered or dropped chunks, and detects truncation at a chunk boundary.
- An empty file encrypts to the header plus one 16-byte tag.
- The decryptor reads `chunk size + 16` bytes at a time until end of file. A wrong password and a tampered file both surface as `e.code === 'auth'`; they are not distinguished by design.
- `parseHeader` rejects chunk sizes over 256 MiB and iteration counts over 10 million as `corrupt`, so a hostile header cannot make the browser allocate or spin.

Any change to the header layout, nonce derivation or AAD must bump the magic to a new value; files written under `ENC2` must keep decrypting.

## Constraints worth knowing before changing things

- There is no input size cap. Memory use is one chunk (8 MiB) plus whatever the sink holds. The Blob fallback sink holds the whole output in browser Blob storage; Firefox 156 and WebKit 26.6 handled 900 MB in testing, while headless Chrome for Testing's download path failed between 300 MB and 600 MB (real Chrome takes the streaming sink, so this only shows up in `tests/e2e.mjs --sink blob`). The streaming sink has no such limit.
- `showSaveFilePicker` must be called while the click is still a fresh user gesture, so `openSink()` runs before key derivation. On a non-abort error from the picker the UI silently falls back to the Blob sink.
- On failure the UI calls `sink.abort()`. For the streaming sink that discards the partially written file, since `FileSystemWritableFileStream` only commits on `close()`.
- `PBKDF2_ITERATIONS = 600_000` matches OWASP guidance. The count is stored in the header, so it can be raised for new files without breaking old ones.
- The `Content-Security-Policy` meta tag forbids every network send (`default-src 'none'; connect-src 'none'; form-action 'none'`) so the browser enforces that files and passwords stay local. Inline scripts and styles are allowed because the page is a single file. `tests/e2e.mjs` fails on any console error, which is how a CSP violation would surface.
- `MIN_PASSWORD_LENGTH = 5` is a UI sanity check, not a security policy.
- Base64 was removed from the design entirely; the old data-URL trick capped files at V8's maximum string length (about 300 MB of input) and failed silently past it.
