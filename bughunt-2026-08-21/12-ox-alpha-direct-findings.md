# Ox-alpha direct pass — MCP kernel / fsops / sandbox / exec / process-manager / search / text-match

Read-only code review, 2026-08-21. No tests run, per instruction. Line numbers verified against source.

## HIGH

### H1. Secret scrubbing allowlist is far too narrow — src/main/exec.ts:66-72
`SECRET_ENV_KEYS` only removes 5 hard-coded names (`OPENAI_API_KEY`, `CLOUDFLARED_TOKEN`, …) from the child environment. Every other secret in the parent's `process.env` — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `HUGGINGFACE_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, Mullvad/account tokens, anything else the user's shell exports — is handed verbatim to every spawned command, including the PowerShell shim path and managed processes.
The design intent ("Remove every inherited spelling of connector/control-plane secrets") is stated at exec.ts:105-107 but the implementation is an allowlist that cannot keep up with reality.
Easy fallback fix: invert to a deny-by-pattern approach (`/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i`) plus keep the explicit list, or at minimum scrub the well-known token names of the major providers. Cheap, contained, big risk reduction.

## MEDIUM

### M1. `.cmd` shim preferred over a same-directory `.exe` — src/main/exec.ts:171-186
`findWindowsCommandShim`: for a bare command name (no extension), `scriptExts = ['.cmd', '.bat']`. In each PATH directory it checks `foo.cmd` / `foo.bat` and returns the first hit — but never checks whether `foo.exe` (or `foo.com`) exists in that same directory. Windows `CreateProcess`/PATHEXT resolution would prefer the executable. Concrete scenario: a tool ships `python.exe` and a legacy `python.cmd` wrapper in one bin dir; CLF silently routes through the `.cmd` → PowerShell launcher, changing argv quoting semantics and startup cost. Fix: before accepting a `.cmd/.bat` candidate in a directory, probe for `base + '.exe'` / `'.com'` and prefer those (return null so the plain-spawn path runs).

### M2. Duplicated, divergent line counters — src/main/fsops.ts:194-198 vs src/main/mcp/kernel.ts:120-123
Two `countTextLines` implementations. Kernel's splits on `/\r\n|\n|\r/`; fsops's splits on `'\n'` only. A CR-only (classic Mac) or oddly-mixed file reports different "+N lines" depending on whether the number came from `appendTextFile`/`replaceTextFile` (fsops) or another caller (kernel). Pure bloat + drift risk. Fix: delete the private one, import the exported one.

### M3. `write_file`-sized content never passes through `assertWritableSize` on all paths?
`assertWritableSize` (fsops.ts:850) exists, but `replaceTextFile` (fsops.ts:171) performs no size check on `content` before `fs.writeFile` — only `editTextFile`/batch paths bound the *result* (`encodeEditableTextFile` checks, `prepareTextEdit` checks source size). A model-supplied multi-MB `content` to the replace path is written unbounded (the 16 MiB MAX_WRITE_BYTES contract is enforced for edits but not for whole-file replace). Verify the tool layer clamps before calling; if it relies on the MCP body cap (8 MiB) instead, the effective limit silently doubles for this one op. Fix: call `assertWritableSize(content)` at the top of `replaceTextFile`.

### M4. `linesPending` miscounts when output legitimately contains blank lines — src/main/process-manager.ts:286
`rest.toString('utf8').split(/\r?\n/).filter((line) => line !== '').length` drops empty lines from the pending count. A delta stream with blank lines (common: build output, logs) reports fewer pending lines than actually remain, so the model may believe it has consumed everything. Cosmetic-to-confusing, one-line fix: don't filter empties (count `rest.split(...).length` minus trailing-artifact adjustment).

### M5. Ctrl+D (`\x04`) as pty "close stdin" is a no-op for PowerShell — src/main/process-manager.ts:643-645
Comment says Ctrl+D is "the key a person would press". On Windows ConPTY, PowerShell does not treat `\x04` as EOF (that is a readline/POSIX convention; PS needs `Exit` or Ctrl+Z+Enter). A model told "close=true ends input" will hang waiting for programs reading until EOF inside PS. Easy fallback: document it, or send `exit\r` when the shell is known-PowerShell, or at least return a note that close was best-effort.

## LOW

### L1. `readTextFile` byte accounting overcounts by one per line — src/main/fsops.ts:445
`Buffer.byteLength(line,'utf8') + 1` charges a newline byte for the final line too (no trailing newline). Harmless (conservative), but `bytesReturned` in the result is slightly wrong and the cap trips one line early on boundary cases.

### L2. `statInfo` readOnly heuristic misses group/world-only-writable files — src/main/fsops.ts:529
`(stat.mode & 0o200) === 0` checks owner-write only. On Windows this maps to the read-only attribute so it is fine there; on any POSIX dev/test path a file writable only by group reports `readOnly: false`… inverted: it reports writable when owner bit clear but ACL allows. Low because target is Windows-only.

### L3. `listDirectory` does one `fs.stat` per file for sizes — src/main/fsops.ts:621
Bounded by maxEntries so not a blowup, but a recursive listing of thousands of files serializes N stats. Could batch with `fs.lstat` in chunks of ~32 concurrent. Only matters on network drives.

### L4. `launchCommand` error path leaks the child handle — src/main/exec.ts:548
If `error` fires, the function rejects without `unref()`; a failed spawn usually means no process, so impact ≈ 0, but symmetric cleanup costs one line.

### L5. `isExcludedFolderName` treats a bare `*` pattern as "exclude everything" — src/main/fsops.ts:572-578
A user typo `' *'`→`'*'` in the exclude config silently makes recursive listing/searching return nothing, with no warning. Consider rejecting/refusing a pattern that is exactly `*`.

### L6. `friendlyError` lets arbitrary `Error.message` through — src/main/mcp/kernel.ts:148
Known errno codes are sanitized, but a non-fs Error (e.g. from a deep library) reaches the model verbatim; several Node libraries embed absolute paths in messages (the exact leak the errno mapping exists to prevent). Fallback: wrap the final branch with a path-scrubbing regex over the roots' real paths.

### L7. `run()` keeps collecting into buffers after timeout until close — src/main/exec.ts:314-319
Post-truncation chunks are discarded correctly, but the data events still fire and run `collect` until the tree dies (up to taskkill latency). Negligible CPU; noting for completeness.

### L8. `chunkText` can split mid-word/mid-token — src/main/mcp/kernel.ts:837
Documented tradeoff ("unless a block is huge"), but the hard slice has no backoff to a whitespace boundary — a one-line `lastIndexOf(' ', …)` improvement would keep huge single blocks readable.

## Verified-clean spots (checked, no issue)
- sandbox.ts containment logic incl. symlink/junction canonicalization and native-path normalization — sound; `..` never normalized away pre-validation.
- text-match.ts `applyTextEdit` offset mapping and `$&`-safe splicing — correct; `alignTerminators` fallback logic verified line by line.
- ByteTail UTF-8 boundary alignment (alignForward/alignBack) — correct including dropped-head partial characters.
- ripgrep integration: post-kill buffered-line guard prevents maxResults overshoot; exit-code handling correct.
- editTextFiles staging/rollback — reverse-order rollback with changed-file detection is genuinely careful; temp cleanup covers all paths.
