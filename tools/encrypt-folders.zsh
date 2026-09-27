#!/bin/zsh
# Zip each immediate subfolder of SRC and encrypt it into OUT/<subfolder>.zip.enc,
# verifying every step, and never writing anything into SRC.
#
#   tools/encrypt-folders.zsh [--password-file FILE] [--keep-zips] [--force] SRC OUT
#
# For each subfolder:
#   1. zip it (excluding .DS_Store) into a work directory under OUT
#   2. test the zip, then compare the SHA-256 of every source file with the
#      same entry read back out of the zip
#   3. encrypt the zip with tools/efe-cli.mjs (the page's own crypto core)
#   4. decrypt the .enc again and byte-compare it with the zip
#   5. delete the plaintext zip (kept with --keep-zips)
# Subfolders whose .enc already exists in OUT are skipped unless --force is given.
# The password is prompted for twice, or read from the first line of --password-file.
# OUT/MANIFEST.txt lists every .enc with its size and SHA-256; OUT/LOG.txt has details.

set -euo pipefail
setopt null_glob

script_dir="${0:A:h}"
cli="$script_dir/efe-cli.mjs"
password_file=""
keep_zips=0
force=0

while [[ $# -gt 0 && "$1" == --* ]]; do
	case "$1" in
		--password-file) password_file="$2"; shift 2 ;;
		--keep-zips) keep_zips=1; shift ;;
		--force) force=1; shift ;;
		*) print -u2 -r -- "Unknown option: $1"; exit 2 ;;
	esac
done
if [[ $# -ne 2 ]]; then
	print -u2 -r -- "Usage: $0 [--password-file FILE] [--keep-zips] [--force] SRC OUT"
	exit 2
fi
src="${1:A}"
out="${2:A}"

[[ -d "$src" ]] || { print -u2 -r -- "SRC is not a directory: $src"; exit 2 }
[[ -f "$cli" ]] || { print -u2 -r -- "Missing $cli"; exit 2 }
for tool in node zip unzip shasum cmp; do
	command -v "$tool" >/dev/null || { print -u2 -r -- "Need $tool on PATH"; exit 2 }
done
case "$out/" in "$src/"*) print -u2 -r -- "OUT must not be inside SRC"; exit 2 ;; esac

if [[ -n "$password_file" ]]; then
	password="$(head -n 1 "$password_file")"
else
	read -rs "password?Password for all archives: "; print -u2
	read -rs "confirm?Type it again: "; print -u2
	[[ "$password" == "$confirm" ]] || { print -u2 -r -- "Passwords did not match."; exit 2 }
fi
[[ ${#password} -ge 8 ]] || { print -u2 -r -- "Password must be at least 8 characters."; exit 2 }

mkdir -p "$out"
work="$out/.work"
mkdir -p "$work"
log="$out/LOG.txt"
print -r -- "== $(date '+%Y-%m-%d %H:%M:%S')  src: $src" >> "$log"

sha() { shasum -a 256 "$1" | cut -d' ' -f1 }

done_count=0 skipped=0 failed=0
for dir in "$src"/*(/N); do
	name="${dir:t}"
	enc="$out/$name.zip.enc"
	zip_path="$work/$name.zip"
	print -r -- ""
	print -r -- "### $name"

	if [[ -f "$enc" && $force -eq 0 ]]; then
		print -r -- "    skip: $enc already exists"
		skipped=$((skipped + 1))
		continue
	fi
	rm -f "$zip_path" "$enc" "$enc.part"

	# 1. zip
	( cd "$src" && zip -r -X -q "$zip_path" "$name" -x '*.DS_Store' )
	print -r -- "    zipped: $(du -h "$zip_path" | cut -f1 | tr -d ' ')"

	# 2. verify zip integrity and every file's bytes
	unzip -tqq "$zip_path"
	src_files=("${(@f)$(cd "$src" && find "$name" -type f ! -name .DS_Store | sort)}")
	zip_files=("${(@f)$(unzip -Z1 "$zip_path" | grep -v '/$' | sort)}")
	if [[ "${(j:|:)src_files}" != "${(j:|:)zip_files}" ]]; then
		print -u2 -r -- "    FAIL: zip entry list differs from source file list"
		failed=$((failed + 1)); continue
	fi
	bad=0
	for f in "${src_files[@]}"; do
		s1="$(sha "$src/$f")"
		s2="$(unzip -p "$zip_path" "$f" | shasum -a 256 | cut -d' ' -f1)"
		if [[ "$s1" != "$s2" ]]; then print -u2 -r -- "    FAIL: $f differs inside zip"; bad=1; fi
	done
	if [[ $bad -ne 0 ]]; then failed=$((failed + 1)); continue; fi
	print -r -- "    verified: ${#src_files[@]} files match source byte-for-byte"

	# 3. encrypt
	print -r -- "$password" | node "$cli" encrypt --password-stdin "$zip_path" "$enc"

	# 4. decrypt again and compare
	verify="$work/$name.verify.zip"
	rm -f "$verify"
	print -r -- "$password" | node "$cli" decrypt --password-stdin "$enc" "$verify"
	if ! cmp -s "$zip_path" "$verify"; then
		print -u2 -r -- "    FAIL: decrypted copy differs from zip"
		rm -f "$verify" "$enc"; failed=$((failed + 1)); continue
	fi
	rm -f "$verify"
	print -r -- "    encrypted and re-verified: $enc"
	print -r -- "$name.zip.enc  files=${#src_files[@]}  bytes=$(stat -f %z "$enc")  sha256=$(sha "$enc")" >> "$log"

	# 5. drop the plaintext zip
	if [[ $keep_zips -eq 1 ]]; then mv "$zip_path" "$out/$name.zip"; else rm -f "$zip_path"; fi
	done_count=$((done_count + 1))
done

# Manifest of everything now in OUT.
{
	print -r -- "Encrypted archives in $out"
	print -r -- "Generated $(date '+%Y-%m-%d %H:%M:%S'). Open with https://justinpearson.github.io/easy-file-encryption/"
	print -r -- ""
	for e in "$out"/*.enc(N); do
		print -r -- "$(stat -f %z "$e")  $(sha "$e")  ${e:t}"
	done
} > "$out/MANIFEST.txt"

rmdir "$work" 2>/dev/null || true
print -r -- ""
print -r -- "done: $done_count encrypted, $skipped skipped, $failed failed. Manifest: $out/MANIFEST.txt"
[[ $failed -eq 0 ]]
