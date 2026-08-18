# Tool Usability Audit — 2026-08-17

Live stress pass against the currently exposed ChatGPT Local Files Core and Desktop surfaces. Scores are model-facing ease of use, not implementation quality: 10 means a fresh coding agent can usually pick the right call, recover from mistakes in one round trip, and trust the result.

## Scorecard

| Tool | Ease | What worked well | Main friction / failure risk |
| --- | ---: | --- | --- |
| `read` | **9/10** | One primitive covers files, folders, globs and bounded ranges; headers expose size/timestamps/line numbers; multi-file range misuse now returns a short actionable `INVALID_ARGUMENT`; missing paths are explicit. | Native `C:\...` paths still fail with only `Path contains ":"`, even though command output naturally shows native paths. A broad glob can resolve >20 files only after returning the first batch plus a “narrow pattern” note; understandable, but pagination would be easier. |
| `apply_patch` | **9/10** | Best source-edit primitive. Add/update/move/delete are atomic, missing parent folders are created, CRLF/indent drift is tolerated, a failed later hunk leaves earlier files unchanged, and failure tells the model what context to add. | Patch grammar is still a learned mini-language and error recovery usually needs a read. There is no directory delete, so repo cleanup falls back to shell. Text/control-byte ambiguity remains worth guarding because source edits previously materialized raw NULs. |
| `exec_command` | **6/10** | Excellent single entry point for git/npm/tests/scripts; explicit cwd is echoed; env overrides work; PowerShell errors and non-zero outcomes are visible; long commands automatically become managed sessions. | Two live P0s: non-TTY PowerShell stdout corrupts Unicode, and `shell:"cmd"` can silently skip a quoted command such as `node -e "..."` while reporting exit 0 in **both pipe and TTY modes**. Defaulting omitted cwd is convenient but still risky in nested repos. Shell is intentionally not sandboxed, so the description has to stay loud about that. |
| `write_stdin` | **9/10** | Very good continuation model: opaque session id + cursor, raw input, polling, close, Ctrl-C/kill. Pipe-session Unicode round-tripped correctly and TTY Node REPL input/output worked. Unknown process ids fail clearly. | The caller has to understand `\r` vs `\n` for console Enter and the cursor contract. A small `send_line` convenience action would remove a common source of interactive-CLI mistakes. |
| `session` | **8.5/10** | `status` is compact and immediately useful; `history` supports kind/query/paging and call-id expansion, which is much better than scraping JSONL manually. Token estimate explicitly says it is the app’s four-chars/token estimate rather than ChatGPT’s counter. | One tool has four conceptually different actions, and `save_handoff` is a special protocol action that models must not call casually. `history` could expose an explicit `next_from` cursor to make paging mechanically obvious. |
| `agents` | **7.5/10** | Status explains roles, waiting messages and abandoned-run recovery; invalid observer messaging gives a concrete explanation; spawning one worker automatically retired the abandoned old run and returned the prime key clearly. | The key-on-every-later-tool-call rule is easy to forget and applies across Core *and Desktop*. Error text is necessarily long. The lifecycle is safe but stateful enough that a fresh model can spend calls figuring out whether it is observer/prime/worker. The product should keep agent mode optional and low-cardinality. |
| `observe` | **8/10** | `active`, `windows`, `ui`, `wait_for` and semantic refs are a strong compact surface. Missing windows and wait timeouts fail cleanly. UI-only inspection is fast and can inspect a background HWND without forcing focus. | A screenshot of a covered background window is currently the visible screen region, not an off-screen/DWM capture of that HWND. The tool **does warn explicitly** that the picture may show what covers it, and its UIA controls still came from the requested Terminal, so this is an ergonomics limitation rather than false success. Screenshot coordinates are also ephemeral by design. |
| `computer` | **7.5/10** | Semantic `click_ref`, direct `set_value`, focus/type/keypress, clipboard actions, batching and `captureAfter` are powerful. Unknown refs and stale screenshot coordinates fail explicitly instead of guessing. Unicode typed through the real TTY path worked. | `STALE_FRAME` is safe but high-friction on animated pages; there are still no `key_down`/`key_up`/held-key or relative mouse-delta primitives, which makes WebGL/pointer-lock testing awkward. Previous live tests also found partial-success ambiguity around disappearing click targets and high-DPI coordinate confusion. |

**Overall surface: 8.1/10.** The consolidation into eight top-level tools is much easier to reason about than the old many-tool surface. The highest-value next fixes are trust bugs, not more features: a tool that says success while skipping a command or corrupting output is worse than a missing convenience primitive.

## Live probes performed

### `read`

- exact ranged file read: passed;
- folder listing: passed;
- glob expansion: passed, including the >20-match cap/narrowing message;
- multi-path + line range misuse: clean `INVALID_ARGUMENT` naming both resolved files;
- missing file: clear error;
- native Windows absolute path: rejected, but the correction UX is weak.

### `apply_patch`

- add three files below a previously missing `.clf-tool-audit` folder: passed;
- update + move + delete in one call: passed;
- deliberately fail the second update after a valid first update: whole patch refused and first file remained unchanged;
- parent-folder creation: passed live.
- source-level `\\u0000` escape probe: `apply_patch` wrote the six printable source characters and byte inspection found `nul=0`, so the current CLF patch tool does **not** reproduce the raw-NUL materialisation seen in an older external structured-edit path.

### `exec_command` / `write_stdin`

- PowerShell cwd + env + Node: ran, but Unicode printed through PowerShell was corrupted;
- env value itself verified intact by writing it with Node and reading the UTF-8 file;
- explicit non-zero PowerShell error: surfaced as non-zero with readable stderr;
- missing command: surfaced as non-zero with readable PowerShell diagnostic;
- long-running pipe process: became a `session_id`, accepted Unicode stdin, emitted delta output, exited cleanly on `quit`;
- TTY Node REPL: opened correctly, Unicode input/output survived, `.exit` closed it;
- invalid process id: concise actionable error;
- `shell:"cmd"`: plain `echo` and unquoted `node -p 123` work, but quoted `node -e "..."` can silently not execute and still reports exit 0.

### `session`

- `status`: passed;
- recent `history` filtered to tool calls: passed;
- `call_id` expansion: passed and returned full recorded args/result;
- no-match history query: clear empty result.

### `agents`

- observer `status`: passed and correctly diagnosed the old run as abandoned;
- observer attempting `message`: correctly refused and explained authentication/lifecycle;
- one-worker `spawn`: passed, automatically ended the abandoned run, returned the prime key and opened exactly one worker chat for the test.

### `observe`

- active window, full window list, window UIA, and `wait_for` on an existing Terminal: passed;
- nonexistent `wait_for`: concise `WAIT_TIMEOUT`;
- nonexistent window id: concise `WINDOW_NOT_FOUND`;
- background-window screenshot while covered: reproduced. The recorded result correctly warned that the picture may show the covering window and still returned Terminal UIA controls. Treat off-screen HWND capture as a future convenience, not a correctness blocker.

### `computer`

- focus/type/keypress into the Claude terminal: passed;
- clipboard read: passed;
- invalid semantic ref: concise `UNKNOWN_UI_REF` with recovery instruction;
- stale coordinate frame: refused with exact old/current frame ids;
- current-frame mouse move + `captureAfter`: passed and returned the next frame;
- semantic refs remain preferable to coordinates and should stay the recommended default.

## Design priorities from this audit

1. **Never return false success.** Fix `cmd` quoted-command execution and wrong-window read/capture before adding convenience features.
2. **Never mutate text invisibly.** Fix non-TTY PowerShell Unicode capture and keep byte-level tests for source edits.
3. **Make path domains self-correcting.** When a model copies a native path from command output into `read`/`apply_patch`, tell it the exact virtual path to use.
4. **Keep semantic desktop refs first-class.** Coordinates should be the fallback for canvas/visual-only targets, not the normal path.
5. **Add interaction primitives only where they remove hacks.** `send_line`, `key_down`/`key_up`, relative mouse delta, and a browser DOM/CDP surface are justified because the current workaround is shell/coordinate abuse.
6. **Keep the surface consolidated.** Eight top-level tools is learnable. Prefer richer actions/diagnostics inside these tools over returning to dozens of narrowly named tools.
