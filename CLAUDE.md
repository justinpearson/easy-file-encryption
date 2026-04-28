# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A single static HTML file, `easy-file-encryption.html`, that encrypts a user-selected file in the browser using the Web Crypto API and emits a self-contained, self-decrypting HTML page as the output. The recipient opens the output HTML in any browser, types the password, and gets the original file back. There is no server, no build step, no package manager, and no dependencies.

## Running and testing

Open `easy-file-encryption.html` directly in a browser (e.g. `open easy-file-encryption.html` on macOS). All crypto runs client-side via `window.crypto.subtle`, which requires either `file://`, `localhost`, or HTTPS — `crypto.subtle` is unavailable on plain `http://` origins.

There is no test suite, linter, or CI configured. To verify a change end-to-end: encrypt a file, open the produced `*.html` output, decrypt with the same password, and confirm the bytes match the original (`shasum` or `cmp`).

## Architecture: the two-program structure inside one file

The file contains **two programs** that must stay in sync:

1. **The encryptor** (the outer IIFE in `easy-file-encryption.html`) — runs when a user opens this file. Reads a file + password, derives a key, encrypts, and assembles an output HTML page.
2. **The decryptor template** — a complete standalone HTML document held as a JS template string in the constant `DECRYPTOR_TEMPLATE` near the bottom of the script. It contains its own `<style>`, `<body>`, and `<script>`. The encryptor produces output by `JSON.stringify`-ing the original filename and base64 payload into the placeholders `__ORIGINAL_FILENAME__` and `__PAYLOAD_B64__` inside this template.

Because the decryptor must run standalone in the recipient's browser with no shared scope, the format constants (`MAGIC`, `SALT_BYTES`, `IV_BYTES`, `HEADER_BYTES`, `PBKDF2_ITERATIONS`) and the `deriveKey` helper are **intentionally duplicated** between the two programs. Any change to crypto parameters, header layout, or KDF settings must be made in **both** copies, or previously-encrypted files will fail to decrypt. The duplication is called out in a comment above `DECRYPTOR_TEMPLATE`.

## Wire format

Output payload bytes (before base64 encoding into the HTML):

```
[ MAGIC 'ENC1' (4B) ][ salt (16B) ][ IV (12B) ][ AES-256-GCM ciphertext + 16B auth tag ]
```

`HEADER_BYTES = 32`. The decryptor's "not-encrypted" check verifies the magic and a minimum length of `HEADER_BYTES + GCM_TAG_BYTES`. AES-GCM authentication failure (wrong password or tampered ciphertext) surfaces as "Invalid password." in the UI — the two cases are not distinguished by design.

## Constraints worth knowing before changing things

- `MAX_FILE_BYTES = 50 MB`. Encryption holds the plaintext, ciphertext, and base64-encoded payload in memory simultaneously, and the output HTML is roughly 1.33× the input size. Raising this cap risks OOM on the recipient side too.
- `PBKDF2_ITERATIONS = 600_000` matches OWASP's PBKDF2-SHA256 guidance. Lowering it weakens every previously-produced file's resistance to offline attack; raising it slows decryption noticeably on low-end devices.
- `MIN_PASSWORD_LENGTH = 5` is a UI sanity check, not a security policy.
- Base64 encoding uses `FileReader.readAsDataURL` to avoid manually chunking large `Uint8Array`s through `btoa`/`String.fromCharCode` (which blows the call-stack limit on big inputs). The decryptor uses the simple `atob` + loop because it only runs on already-base64 data already living in JS memory.
