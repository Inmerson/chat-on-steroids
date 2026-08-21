# Codex-derived tools: runtime, resource and adversarial-input audit

**Date:** 2026-08-21 (Europe/Berlin)  
**Repository:** `C:\Users\totec\chatgpt-local-files`  
**Scope:** `src/main/codex/*`, the Core MCP wrappers in `src/main/mcp/tools-core.ts`,
`src/main/fsops.ts`, `src/main/search.ts`, `src/main/rawfs.ts`, `src/main/sandbox.ts`, and
the corresponding runtime/parity tests.  
**Boundary:** source, tests, AppData and configuration were read-only. The only repository
write from this audit is this report. No product/test code was changed, and no build or commit
was made.

## Method and evidence

I read `AGENTS.md` completely and then read
`bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md` completely before tracing the
current worktree. Existing tests were not rerun, per the parent audit instruction that they are
already green; this pass targets dimensions the ordinary tests do not bound: whole-call work,
main-process synchronous work, decoded/intermediate representations, PTY input and session
lifetime, recursive enumeration, patch commit semantics, and shutdown ownership.

The following temporary-only probes were run. They created and removed files under the OS temp
directory; no source or test file was written.

* An algorithm-equivalent probe of the current `read-backend.ts` carry loop streamed a 64 MiB
  UTF-8 file with no newline while the requested result cap was 512 KiB:

  ```text
  {"file_bytes":67108864,"requested_max_bytes":524288,"returned_bytes":0,"carry_utf16_units":67108864,"rss_before":53272576,"rss_after":210411520,"rss_delta":157138944}
  ```

* A `readDirectory`-equivalent probe created 20,000 regular entries and called Node's
  `readdir(..., {withFileTypes:true})` while the Core directory consumer's cap was 200:

  ```text
  {"directory_entries":20000,"consumer_cap":200,"readdir_returned":20000,"rss_before":58044416,"rss_after":59584512,"rss_delta":1540096}
  ```

* The fallback search regex operation was measured directly in Node with the query
  `(a+)+$` against a non-matching `a...aX` line:

  ```text
  {"n":20,"ms":140}
  {"n":24,"ms":107}
  {"n":28,"ms":1931}
  {"n":30,"ms":7161}
  ```

* An algorithm-equivalent patch update read, decoded, split and rejoined a 64 MiB one-line file:

  ```text
  {"file_bytes":67108864,"filesystem_read_limit":536870912,"lines":1,"original_utf16_units":67108864,"new_utf16_units":67108864,"rss_before":119566336,"rss_after":253796352,"rss_delta":134230016}
  ```

The probe numbers are evidence of the intermediate representation cost, not a claim that a
production call was made against a user file. The source traces below establish where the same
operations occur in the live MCP path.

## Findings

### C1 — HIGH — a giant single-line text file bypasses the `read` byte cap in the intermediate representation

**Status:** NEW, current source. This is unrelated to the prior image/read-cap and structured
output findings. **Confidence: high.**

**Evidence:**

* The public `read` schema and whole-call accounting cap the requested result at
  `MAX_READ_BYTES` (512 KiB), and `tools-core.ts:269-276` passes the remaining amount as
  `maxBytes` into `readTextFile`.
* `read-backend.ts:247-258` stores that value only as the output budget. The stream at
  `read-backend.ts:278-300` keeps appending decoded chunks to `carry` and only invokes
  `pushLine()` after finding `\n` (`:287-299`). For a text file with no newline, no line is
  pushed and the cap is never consulted until EOF (`:302-306`).
* `filesystem.ts:199-210` exposes `readFileStream()` with no byte limit; it reads until EOF.
  Unlike `readFile()`, the stream path does not enforce the 512 MiB primitive limit at
  `filesystem.ts:165-186`, and `read-backend.ts:244-247` does not reject a large metadata size.
  Thus a file larger than 512 MiB is also streamed rather than rejected.
* The comment immediately above the implementation (`read-backend.ts:237-238`) promises that a
  line range in a 2 GiB file does not load the file, but the no-newline case defeats that property.

**Trigger / repro:** grant Read files, place an approved UTF-8 file containing one very long line
(no LF), then call `read` with that path and `max_bytes: 1`. The exact carry-loop probe above
shows a 64 MiB input retaining 64 MiB of UTF-16 text and increasing RSS by about 150 MiB while
returning zero complete-line bytes. A model with command permission can create such a file; no
special filesystem feature is required.

**Impact:** main-process memory and decode/GC work scale with the entire file, not the declared
result cap. A multi-hundred-megabyte or multi-gigabyte approved text file can stall the Electron
main thread, trigger V8 OOM, or make the MCP call outlive its transport deadline. The outer
`remaining` counter cannot help because it is decremented only after `readTextFile` returns.

**Fix direction:** make the stream accept a hard byte budget and stop reading once the current
line cannot fit; cap the decoded carry itself (including a no-newline line), return a bounded
truncation/cursor result, and close the stream immediately. Apply the same bound to the metadata
scan and reject or deliberately stream-skip files above the supported input limit. The budget
must cover bytes read and decoded/intermediate text, not only emitted sections.

### C2 — HIGH/MEDIUM — directory and recursive-search caps are applied after an unbounded `readdir`

**Status:** NEW, current source. **Confidence: high for the directory/read/glob path; medium-high
for the memory size on very large Windows directories.**

**Evidence:**

* `filesystem.ts:256-274` first awaits `rawPromises.readdir(path, { withFileTypes: true })` into
  an unbounded `dirents` array, then builds another `entries` array. It has no entry limit and
  no deadline.
* `read-backend.ts:165-183` calls that primitive and sorts the complete array at `:171-176`
  before applying `maxEntries` at `:180-184`. The Core `read` cap is only 200
  (`tools-core.ts:136-145`), and `expandGlob()` can pass 5,000 (`tools-core.ts:1397-1404`),
  so neither cap protects the initial enumeration.
* The bounded BFS in `filesystem.ts:329-419` is bounded only after each directory has been fully
  returned by `readDirectory()` (`:361-370`). Its `queue.shift()` at `:356-359` also adds
  avoidable O(queue length) CPU work for broad trees.
* The fallback in `search.ts:293-325` repeats the same unbounded per-directory
  `fs.readdir()` before checking `MAX_FILES_SCANNED` at `:281-289`. A search can therefore pay
  for a huge single directory even when its file/response cap is small.

**Trigger / repro:** call `read` on an approved directory containing millions of entries, or
expand a one-level glob over that directory. The temporary probe above shows the exact mismatch
even at 20,000 entries: `readdir_returned: 20000` while the consumer cap is 200. At production
scale, the second array plus sorting and the per-file metadata calls occur before the caller can
return the first 200 entries. A broad `find` has the same initial-directory exposure in fallback
mode.

**Impact:** memory spikes and synchronous sorting can block the Electron main thread; a single
directory can consume the latency budget before the advertised cap takes effect. Recursive glob
or fallback search work can additionally build large pending queues/arrays and keep a timed-out
MCP request busy. This is an amplification of ordinary approved filesystem access, not a new
junction/reparse claim.

**Fix direction:** use an async directory handle/iterator and stop after `cap + 1` entries,
retaining only the bounded set needed to sort and report truncation. Apply the same iterator
budget to every recursive walk and search directory, with a shared deadline and a bounded queue.
Do not rely on a response-size cap as an input-enumeration cap.

### C3 — HIGH/MEDIUM — `find` has no whole-call deadline, and its fallback regex can block the main thread

**Status:** NEW, current source. The aggregate-budget issue applies to both ripgrep and fallback;
the catastrophic-regex branch is conditional on ripgrep being unavailable. **Confidence:
high for aggregate work; medium for the regex branch.**

**Evidence:**

* Each `search()` call starts a fresh ten-second budget (`search.ts:71-75`, `:272-291`), and
  `searchWithRipgrep()` independently kills its child after ten seconds (`:260-263`).
* The Core wrapper serially runs one search per scope (`tools-core.ts:401-431`). Config permits
  up to 32 roots (`config.ts:129-136`), so the local budgets permit up to 320,000 ms of work
  for one `find` request. The MCP HTTP request timeout is 300,000 ms
  (`mcp/server.ts:404`), meaning the transport can time out while the handler is still working;
  there is no remaining-deadline parameter passed from the wrapper to `search()`.
* When `locateRipgrep()` returns null, `scanOneFile()` constructs a JavaScript `RegExp` from
  model input (`search.ts:453-460`) and runs `regex.test(line)` synchronously
  (`:467-475`). The fallback's file size is capped at 2 MiB, but one line can still be nearly
  that large, and the `Date.now()` checks at `:281-291`/`:356-363` cannot interrupt a running
  regex operation. The supported fallback is reached whenever the packaged/dev/PATH `rg.exe`
  is unavailable (`ripgrep.ts:22-30`).

**Trigger / repro:** with fallback search active, call content `find` using regex
  `(a+)+$` against a file whose line is `a` repeated 30 times followed by `X`. The exact direct
  Node probe measured 7,161 ms for that one synchronous `.test()` at `n=30`, after 1,931 ms at
  `n=28`; the event loop cannot service the ten-second search timer during the call. Separately,
  point a no-path `find` at 32 approved roots that each reach the per-scope timeout: the source
  trace is 32 sequential ten-second scopes, or 320 seconds before the wrapper returns.

**Impact:** a hostile regex can freeze the main process and delay every window/MCP/bridge task;
12 fallback workers do not make synchronous regex CPU parallel. Broad multi-root searches can
consume the entire five-minute request timeout and continue after the client has stopped waiting.

**Fix direction:** do not execute model-supplied regexes on the Electron main thread. Prefer
ripgrep only, or run a safe/linear-time regex implementation in a worker with a killable
deadline and a pattern/line limit. Pass one absolute deadline through the entire `find` call,
decrement it for every scope and recursive operation, and cancel/kill child work when the client
request is cancelled or the deadline expires.

### C4 — HIGH — `apply_patch` can amplify a tiny patch into a huge double-read, and commits are not atomic

**Status:** NEW, current source. The patch path is intentionally separated from the known
junction TOCTOU finding; this finding is about representation size and commit failure semantics.
**Confidence: high.**

**Evidence (resource amplification):**

* The Core schema accepts an unconstrained `z.string()` (`tools-core.ts:443-452`); there is no
  patch-specific hunk, line, file-size, or complexity limit before parsing. The parser trims,
  splits, joins and then feeds the joined string through a character-at-a-time streaming parser
  (`apply-patch/parser.ts:64-76`, `streaming-parser.ts:57-71`). The HTTP body limit is not a
  substitute for a patch/file-work budget.
* `runParsedPatch()` first resolves and verifies every hunk (`tools-core.ts:1193-1215`) and then
  executes the original patch (`:1217-1222`). Verification and execution therefore both call
  `deriveNewContentsFromChunks()`, which reads the entire file (`file-update.ts:27-37`), splits it
  into a line array (`:39-50`) and joins a new complete string. The backend primitive permits a
  512 MiB file (`filesystem.ts:29-32`, `:165-186`), and `SourceFile.parse()`/`intoContents()`
  retain line objects and rebuild another string (`apply-patch/text-file.ts:39-72`, `:75-116`).
  `filesystem.writeFile()` has no Codex apply-patch output-size check (`filesystem.ts:225-228`).
* The temporary algorithm-equivalent probe above used a 64 MiB one-line file and retained an
  additional ~134 MiB RSS while decoding, splitting and joining. A tiny context update to a
  near-512 MiB one-line file is consequently a multi-copy main-process allocation and is done
  once during verification and again during execution.

**Evidence (commit semantics):** `applyHunksToFiles()` loops hunks and writes/deletes each one
  immediately (`apply-patch/index.ts:212-308`). The only failure handling marks the accumulated
  delta `exact = false` (`:201-209`); it does not restore earlier writes. A move writes the
  destination before removing the source (`:260-289`). `executeApplyPatch()` catches the error and
  returns exit code 1 with the already-mutated delta (`:392-429`). Verification cannot prevent
  commit-time ENOSPC, ACL, file replacement, or a later hunk's failure.

**Trigger / repro:** submit a small update hunk against an approved one-line file near the
  512 MiB backend limit; the source trace is two full reads/line reconstructions before the one
  write. For atomicity, submit two valid hunks and arrange for the second target to become
  unwritable or for the volume to exhaust space after the first write. The first hunk remains on
  disk while the tool returns an error; for a move, a destination can remain while source removal
  fails. This is a deterministic failure ordering from the current loop, although no destructive
  live filesystem repro was run under the read-only audit boundary.

**Impact:** a model can turn a bounded-size request into high transient memory/CPU, crash the
  main process, or make the MCP call hang in GC/IO. A commit-time error can leave a partially
  applied multi-file change while the result says failure, making recorder evidence and the
  user's filesystem disagree; a move can leave both names or neither depending on the failure
  point.

**Fix direction:** set independent limits on patch bytes, hunks, lines, per-file input bytes and
  derived output bytes before verification; read/match each file once where possible and keep
  bounded line representations. Stage all outputs in a private temp transaction, revalidate
  source identities, then atomically replace/rename with a rollback plan. If true multi-file
  atomicity is impossible on the target filesystem, expose a deliberate partial-commit result
  and durable per-hunk evidence rather than presenting a normal failed patch.

### C5 — HIGH — unified-exec pruning can orphan live children and its “64-session” bound is bypassable

**Status:** NEW, current source. This is distinct from the prior Ctrl+C/ESRCH race (which is
handled at `unified-exec.ts:462-467`). **Confidence: high.**

**Evidence:**

* `MAX_UNIFIED_EXEC_PROCESSES` is 64 (`unified-exec-constants.ts:13-17`), but
  `execCommand()` calls `pruneProcessesIfNeeded()` and unconditionally inserts the new entry
  afterward (`unified-exec.ts:650-664`). The pruning function can choose a live LRU session
  (`:905-914`), acquire/release its interaction lock, and call `releaseProcessId()`
  (`:873-896`). `releaseProcessId()` only deletes the map/set entry (`:624-626`); it does not
  terminate the `UnifiedExecProcess`. A live child selected for pruning therefore loses its only
  manager handle and is not included in `terminateAllProcesses()` (`:848-853`) at shutdown.
* The cap can also be exceeded without pruning: `writeStdin()` holds the per-process mutex from
  `:724-725` through the output wait at `:760-772`. Empty polls use the manager's default
  `DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS = 300000` (`unified-exec-constants.ts:13`,
  `manager.ts:14`), so an attacker can keep all sessions locked for up to five minutes. When
  every candidate is locked, `pruneProcessesIfNeeded()` reaches `:884` and returns; the caller
  still inserts another process at `:656`.
* `write_stdin.chars` is an unbounded `z.string()` (`tools-core.ts:603-613`) and is handed in one
  call to `pty.write()` (`tools-core.ts:636-642`, `unified-exec.ts:432-436`). There is no input
  byte limit, bounded queue, or PTY backpressure. Concurrent calls to one session accumulate on
  the mutex's promise tail (`unified-exec.ts:155-166`) while each call may wait for the long poll.
* A naturally exiting process that was returned with a session id has no exit callback that removes
  its ownership entry. `tools-core.ts:568-581` records it, while the manager only calls
  `forgetExecOwner()` when a later poll reports `processId === null` (`:630-644`). Pruning a live
  or exited entry does not call `forgetExecOwner()`. This leaves stale owner metadata and makes
  cleanup depend on a later model poll.

**Deterministic source trace / trigger:** open 64 long-running PTY sessions, issue empty
`write_stdin` polls concurrently, then issue a 65th `exec_command`. All interaction locks are
held, so the pruning loop has no candidate, `processes.size` becomes 65, and the new child is
  accepted. With unlocked sessions, the 65th call instead prunes a live LRU entry by deleting its
  map record without calling `terminate()`, after which that OS process continues without a
  session id. Repeated unbounded `chars` writes or concurrent polls add native PTY/pending-promise
  pressure. No live process swarm was spawned during this audit.

**Impact:** the advertised session ceiling is not a resource ceiling: live shells can become
unreachable or accumulate beyond 64, remain alive after app shutdown, and retain OS CPU, handles,
working directories and descendants. Unbounded PTY writes and mutex waiters can amplify memory
and latency. Stale ownership state can outlive the manager entry and complicate later session-ID
reuse. Shutdown is additionally sequential (`:848-853`), so up to 64 one-second Windows tree-kill
helper waits can serialize before the final flush.

**Fix direction:** make admission hard: refuse or terminate a selected live session before
removing its handle, and keep an authoritative child registry that shutdown also drains. Give
each session an independent idle/lifetime deadline rather than tying retention to polling; bound
`chars` and chunk writes through an explicit queue with backpressure/rejection, and cap queued
`write_stdin` calls. Centralize process-exit/prune/terminate cleanup so the manager and ownership
registry are deleted together. Use bounded parallel shutdown with a total deadline and preserve
per-process failures.

## Known or intentionally excluded items

* The junction/reparse canonicalize-then-open TOCTOU remains the known F1 issue from the
  consolidated report, but it is not repeated here without a new reproduction or insight.
* The prior Ctrl+C-versus-natural-exit ESRCH race has a current guard in
  `unified-exec.ts:462-467` and was not counted as a new finding.
* Current image decoding has Sharp pixel/input bounds, and the earlier structured exec-output cap
  bypass appears fixed. `view_image` still retains the known structured `image_url` plus image
  content/base64 duplication (`tools-core.ts:323-330`); that is the consolidated F8 representation
  issue, not a new finding in this report.

