# Worker audit: MCP / Electron / renderer

Date: 2026-08-20
Scope: CURRENT connector app, excluding narrow filesystem/extension audits. Primary focus: MCP routing/handlers/HTTP transport, request body limits/parsing, Electron main↔renderer/preload/IPC, async stale state, process/session cleanup, error propagation, return serialization, resource exhaustion/security boundaries/hangs, and false-confidence tests.

## Tool-call error log (chronological)

- None so far.

## Findings

- 11:55 local — `npx vitest run bughunt-2026-08-20/probe-session-tail.test.ts --reporter=verbose` exited 1 with “No test files found” because the repository Vitest config only includes `test/**/*.test.ts`. **Classification: my misuse / harness mismatch**, not a connector bug. No production code was exercised.

### HIGH — Session timeline IPC can freeze the Electron main process on large journals; `limit` does not bound I/O/parsing and chronology has an O(n²) path

**Exact refs**
- `src/main/ipc.ts:295-309`: `sessions:events` accepts `limit <= 1000` but calls `readEvents(id, {})` when no `from` is supplied, materializes `all`, and only then takes the tail with `all.slice(all.length - cap)`.
- `src/main/session/store.ts:705-780`: `readEvents()` explicitly `fs.readFile(...events.jsonl, 'utf8')`, `raw.split('\n')`, JSON-parses every line, merges messages, calls `chronological(out)`, and only *after all of that* applies `.slice(0, limit)`.
- `src/shared/chronology.ts:84-93,110-123`: for each event lacking a usable `turnId`, `openTurnAt()` loops from the beginning of the complete `bySeq` array until that event's position. The grouping loop calls it once per such event, so a long untagged window is O(n²).
- `src/renderer/chat.ts:245-265`: ordinary session selection calls `api.getSession(wanted)` with no cursor/limit, therefore takes the pathological main-process path every refresh/selection.

**Safe reproduction**
Created an isolated probe under `bughunt-2026-08-20/probe-session-tail.test.ts` (no production edits). It writes 250,000 small valid `progress` events (~40 MB) into a temporary initialized session store and runs `readEvents(id, { limit: 1 })` while measuring elapsed time and heap delta.

Observed console result:
`{"bytes":40027790,"returned":1,"elapsedMs":68305,"heapDeltaMiB":83.6}`

Vitest's normal 5 s timeout fired, but the synchronous/async work still completed after 68.3 s. Because the production IPC handler runs this work in Electron's main Node process, selecting/refreshing a sufficiently large recorded session can make the entire app unresponsive, not merely delay one renderer request.

**Observed vs expected**
- Observed: asking for one event loaded ~40 MB, parsed 250k JSON objects, consumed ~84 MiB additional JS heap, and took ~68 s.
- Expected: a bounded timeline/tail request should have work approximately bounded by the requested tail/window (or at minimum O(file size), not O(event-count²)); `limit: 1` / default 300 must not require materializing the complete historical journal.

**Likely root cause**
The tail cap exists only after `readEvents()` has already done all expensive work. Separately, `chronological()` determines the open turn for untagged events by rescanning the entire prefix from the start for each event. The comments in `store.ts:710` (“Reading the file in one go is fine at the sizes the caps allow”) are a false assumption: there is no total journal-size/event-count cap; only per-line/per-value caps exist.

**Missing tests / false confidence**
- Existing `test/session.test.ts` verifies `readEvents(...,{limit:2})` returns two rows, but does not assert bounded I/O, bounded work, tail semantics, or performance as history grows.
- There is no IPC test proving `sessions:events` forwards/bounds the requested limit before loading history.
- Chronology tests validate ordering correctness on tiny fixtures; none detect quadratic behavior on many untagged entries.

**Probe command outcome**
The probe test intentionally exceeded Vitest's default timeout and exited 1 after printing the measurement. **Classification: connector bug reproduced**, not harness misuse: the timeout is the symptom being measured.

## Tool-call error log (continued)
- 11:52 local — `write_stdin` sending Ctrl+C to the long-running probe returned `write_stdin failed: Unified exec process failed: kill ESRCH`. The process then remained queryable long enough to return its completed Vitest output. **Classification: probable connector process-lifecycle race / error propagation bug, adjacent to this worker's process-cleanup scope; needs independent reproduction before promoting to a standalone finding.**
- 11:53 local — the probe's Vitest process exited 1 because the `limit:1` call took 68.3 s and violated the 5 s test timeout. **Classification: connector bug reproduced** (session-history performance/freeze path described above).

### HIGH — Concurrent bridge starts orphan a live HTTP server that `stopBridge()` can never close

**Exact refs**
- `src/main/ipc.ts:151-179`: every `settings:save` handler independently performs config persistence and then `await startBridge()` whenever recording or multi-agent is enabled. IPC invokes may overlap; only config mutation itself is queued.
- `src/main/bridge.ts:1251-1317`: `startBridge()` only checks `if (server) return port` before the first async bind. There is no startup promise/lock. `server` is assigned only after a candidate successfully binds (`1272`).
- `src/main/bridge.ts:1319-1338`: `stopBridge()` closes only the one instance currently held in the global `server` variable.
- Fixed candidate pool is only five ports, `src/main/bridge.ts:79-80` (`8765..8769`).

**Safe reproduction**
Created isolated `bughunt-2026-08-20/probe-bridge-race.test.ts`, initialized temp config/secrets/session/durable stores, then:
`const [a,b] = await Promise.all([startBridge(), startBridge()])`.
Both calls succeeded on distinct ports. Probe output on this machine:
`{"a":8766,"b":8767}`
Both were reachable. After one `await stopBridge()`:
`{"afterStop":{"8766":true,"8767":false}}`
So port 8766 remained a live HTTP listener after the module reported the bridge stopped and cleared its only server reference.

**Observed vs expected**
- Observed: one logical bridge acquired two listeners; the second assignment overwrote the first global reference; stop closed only the second. The orphan stays active until process exit.
- Expected: concurrent/idempotent startup requests must converge on one startup promise/server, and a successful stop must close every listener created by the bridge lifecycle.

**Impact**
- The UI/config can say the bridge is stopped while a local HTTP bridge is still accepting requests.
- Repeating the race can consume the fixed five-port discovery pool and make later legitimate bridge starts fail until app restart.
- The stale listener continues executing the same global `handle()` route against current bridge state, so this crosses the intended lifecycle/security boundary rather than being only a bookkeeping leak.

**Likely root cause**
`server !== null` is used as both “already running” and “startup in progress”, but it is not set until after an async `listen()`. There is no serialized lifecycle queue equivalent to `connection.ts`.

**Missing tests / false confidence**
Existing bridge tests start/stop sequentially. Search found no concurrent `startBridge()` or settings-save race test. `test/ipc.test.ts` verifies shutdown ordering but not overlapping invokes.

**Probe command outcome**
The reproduction passed in 34 ms because its assertions describe the buggy current behavior (two distinct ports and exactly one still reachable after stop). No production files changed.

### MEDIUM — Unsolicited main→renderer state pushes overwrite focused, unsaved settings fields; overlapping pushes can also arrive stale

**Exact refs**
- `src/main/ipc.ts:119-128`: `buildState()` snapshots `config` and `status` before awaiting `hasSecret()` and `bridgeStatus()`. Multiple builds may therefore hold older snapshots while async work completes.
- `src/main/ipc.ts:407-415`: every status/bridge change calls `pushState()`, which fire-and-forgets an independent `buildState().then(...send('state:changed'...))`. There is no revision, sequence, serialization or stale-result check.
- `src/main/connection.ts:73-75,207-234`: one tunnel report can synchronously emit several status changes (`setStatus`, then `updateSurface`, sometimes another surface update), creating overlapping `buildState()` calls.
- `src/preload/index.ts:89-92`: `onStateChanged` passes every pushed state straight through.
- `src/renderer/main.ts:390-393,466-473`: `apply(next)` accepts every state unconditionally and writes persisted values directly into editable `tunnelKind`, `tunnelId`, `desktopTunnelId`, `binaryPath`, and checkbox controls.
- `src/renderer/main.ts:1013-1022`: the text/select values are only saved on `change`, so a user can have a focused dirty edit that is not yet persisted.
- `src/renderer/main.ts:1029`: every `state:changed` push calls `apply` directly.

**Safe reproduction**
Created isolated `bughunt-2026-08-20/probe-renderer-state-clobber.test.ts`. It loads the real `src/renderer/index.html` in jsdom, installs a mock preload API, imports the real `src/renderer/main.ts`, lets initial state apply, focuses `#tunnelId`, changes only its DOM value to `tunnel_USER_IS_STILL_TYPING` (no `change` event), then invokes the actual registered `onStateChanged` listener with the current stored state.

Observed:
`{"focused":true,"before":"tunnel_USER_IS_STILL_TYPING","after":"tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`
The field was still the active/focused element when its text was overwritten.

**Observed vs expected**
- Observed: any live state push can erase an in-progress tunnel id/edit before the field's `change` event saves it. Because main-process pushes are unordered async snapshots, an older build can additionally repaint newer displayed status/config after a newer build has arrived.
- Expected: background health/bridge/status updates must not mutate dirty/focused user-editable fields; pushed snapshots should be monotonic or stale-discarded.

**Likely root cause**
The renderer treats full app-state pushes as authoritative form reset events rather than separating live status from editable form state. The `applying` flag only prevents save handlers while `apply()` itself runs; it does not protect a user's dirty fields. Main `pushState()` has no generation/order guard either.

**Missing tests / false confidence**
- Renderer layout/HTML tests validate structure and sanitizer behavior, not interactive dirty-field preservation under push updates.
- IPC tests do not force two `buildState()` calls to resolve out of order or assert monotonic push ordering.
- The file header in `src/renderer/main.ts:1-6` says controls the user may be typing into are not rebuilt, but assigning `.value` is sufficient to destroy the edit even without rebuilding the node.

**Probe command outcome**
Probe passed in 331 ms because its assertions encode the current buggy behavior. No production edits.

### MEDIUM — `write_stdin` Ctrl+C races a just-exited pipe process into a false `kill ESRCH` tool error, while the successful final result remains pending

**Exact refs**
- `src/main/codex/unified-exec.ts:446-463`: pipe-mode `interrupt()` reads `this.child?.pid` and calls `process.kill(pid, 'SIGINT')`; if the child exited a moment earlier, Windows/Node throws `ESRCH`, which is converted to `UnifiedExecError.processFailed(...)` instead of being treated as an already-terminal process.
- `src/main/codex/unified-exec.ts:714-752`: `writeStdin()` handles input. For pipe sessions and Ctrl+C (`728-734`), it calls `await process.interrupt()` outside the later PTY write catch/reconcile block (`736-751`). Therefore it never refreshes terminal state after an interrupt-side ESRCH.
- `src/main/codex/unified-exec.ts:781-795`: the normal post-write status reconciliation that would correctly return an exited session is skipped because the interrupt threw first.

**Safe live reproduction through the CURRENT connector tool**
1. `exec_command`: `Write-Output READY; Start-Sleep -Seconds 12; Write-Output DONE`, `yield_time_ms:1000`. It returned a live session id `11877` after the connector's outer 10 s yield, with `READY`.
2. Waited ~3 s using a separate command, ensuring the child had naturally completed but the managed session had not yet been polled/reaped.
3. `write_stdin(session_id=11877, chars="\\u0003")` returned an error: `write_stdin failed: Unified exec process failed: kill ESRCH`.
4. Immediately `write_stdin(session_id=11877, chars="")` returned `DONE`, exit code 0.

This also independently reproduces the same `kill ESRCH` observed during the earlier long-history probe.

**Observed vs expected**
- Observed: Ctrl+C against a session whose child has already naturally exited is reported as a process failure, even though the process actually succeeded and its final output/exit 0 remains available on the next poll.
- Expected: this race should reconcile process state and return the terminal output/status (or at least an already-exited/unknown-session response), not fabricate a failed process outcome.

**Likely root cause**
The PTY write branch was designed to catch a failed write and refresh process state, but the non-TTY interrupt branch lacks the same reconciliation. `child.pid` remains populated after exit, so checking only for `undefined` does not prove the OS process still exists.

**Impact**
A model/user attempting to stop a long-running command exactly as it finishes can see a red tool failure for a successful command and may retry/re-run work unnecessarily. The session is not lost: the next empty poll recovers the real result, which keeps this below the freeze/data-loss findings.

**Missing tests**
Current exec/write_stdin tests cover normal interrupt and terminal polling but do not race Ctrl+C against a process that has exited while still retained in the manager.

## Tool-call error log (continued)
- 12:01 local — `write_stdin(session_id=11877, chars=Ctrl+C)` returned `write_stdin failed: Unified exec process failed: kill ESRCH`. **Classification: connector bug reproduced**. The preceding process had already completed successfully; immediate empty poll returned `DONE`, exit 0.

### HIGH — MCP endpoint stop/disconnect forcibly drops in-flight tool responses but does not cancel the handlers, so side effects continue after the client sees transport failure

**Exact refs**
- `src/main/mcp/server.ts:432-439`: endpoint `stop()` calls `server.closeAllConnections()` first, then `server.close()`. `closeAllConnections()` destroys active HTTP sockets rather than draining them.
- `src/main/connection.ts:352-367`: user/app disconnect stops the tunnel and then immediately `await endpoint.stop()`, with no wait for or cancellation of in-flight MCP requests.
- `src/main/mcp/call-context.ts:121-153`: the code already tracks both `inFlight` tool handlers and wider `inFlightRequests`, but endpoint shutdown does not consult either counter and exposes no AbortSignal to handlers.
- `src/main/mcp/kernel.ts:332-435`: dispatch/recording continues independently once entered; nothing in this path observes endpoint closure.

**Safe reproduction**
Created isolated `bughunt-2026-08-20/probe-mcp-stop-inflight.test.ts`. It starts a real `startMcpServer()` against a temporary approved root with only command execution enabled, then POSTs a real JSON-RPC `tools/call` for `exec_command` whose PowerShell body:
1. writes `started.txt`,
2. sleeps two seconds,
3. writes `after-stop.txt`.
The probe waits until `started.txt` exists (proving the handler is already executing), calls `endpoint.stop()`, observes the HTTP result, waits for the command's delayed side effect, and inspects the temp folder.

Observed:
`{"stopMs":1,"client":{"ok":false,"error":"TypeError: fetch failed"},"afterStopFile":"after"}`

So the server declared itself stopped in ~1 ms and the MCP caller lost its response, while the already-running command continued and mutated state two seconds later.

**Observed vs expected**
- Observed: endpoint shutdown creates an ambiguous-commit failure: remote caller receives a transport failure (and may legitimately retry), but the original tool still executes to completion after disconnect.
- Expected: shutdown must choose one coherent policy: gracefully drain accepted requests so their results can be delivered, or cancel them and guarantee no further side effects. It must not deliberately destroy the response channel while leaving the action alive.

**Impact**
This can duplicate writes/commands when ChatGPT retries a transport-failed call, and it makes the UI's Disconnect action unable to mean either “finish what is already accepted” or “stop connector work now.” `exec_command` is an easy proof, but the same dispatch architecture applies to filesystem edits, desktop control, and other asynchronous handlers. App quit partly mitigates running execs by separately terminating managed processes, but ordinary Disconnect does not, and non-process handlers have no cancellation path at all.

**Likely root cause**
`server.closeAllConnections()` was used as a fast socket cleanup primitive without tying connection lifetime to tool-call lifetime. Existing in-flight counters were built for compaction/orphan cleanup, not server lifecycle.

**Missing tests / false confidence**
- `test/mcp.test.ts` has endpoint hardening and request-body failure cases but no test that stops the endpoint during a real tools/call.
- `test/ipc.test.ts` checks one shutdown ordering case (worker command cancellation before bridge shutdown), not in-flight MCP drain/cancel semantics.
- The focused suite (`mcp`, `ipc`, `bridge`, renderer tests) is 193/193 green while this bug reproduces through the real HTTP+tool stack.

**Probe command outcome**
Probe passed in 2.68 s because assertions encode the current buggy behavior: client transport failure plus delayed post-stop side effect. No production files changed.
- 12:04 local — a source-search command included a guessed nonexistent path `test\codex-tools.test.ts`; PowerShell `Select-String` exited 1 with “Cannot find path ... because it does not exist.” **Classification: my misuse / bad guessed filename**, not a connector bug. The preceding read of `src/main/codex/view-image.ts` in the same command completed successfully.

### HIGH — `view_image` PNG validation is a synchronous decompression-bomb path; the 8 MiB file cap does not bound decoded memory

**Exact refs**
- `src/main/fsops.ts:18-19,363-379`: image input is capped only by compressed/on-disk bytes (`MAX_IMAGE_BYTES = 8 MiB`). PNG structural validation checks only that width/height are non-zero (`273-303`); there is no pixel-count/dimension/decompressed-byte ceiling.
- `src/main/codex/view-image.ts:253-324`: `decodesAsPng()` collects all IDAT chunks and calls synchronous `inflateSync(Buffer.concat(parts))` at `296-300` with no `maxOutputLength`. Only *after* full inflation does it walk the expected scanline geometry.
- `src/main/codex/view-image.ts:334-383`: every successful `view_image` call runs that decode gate before returning the image.
- `src/main/mcp/tools-core.ts:303-335`: `view_image` is a normal model-facing Core tool whenever read access is exposed, so this synchronous work runs on the Electron/main MCP Node process.

**Safe reproduction**
Generated a standards-valid 8192×8192, 8-bit grayscale PNG under `bughunt-2026-08-20/png-inflate-probe.png`. Each scanline is filter byte 0 followed by zeros, so its legitimate decoded stream is 67,117,056 bytes but zlib compresses it to a 65,303-byte PNG (1027.8× expansion). CRCs/IHDR/IDAT/IEND are all valid.

Isolated `probe-view-image-inflate.test.ts` calls the real `viewImage()` once and measures process memory around it. Observed:
`{"inputBytes":65303,"elapsedMs":53,"rssDeltaMiB":134.2,"externalDeltaMiB":128.1,"base64Chars":87072}`
The call succeeded as `image/png`.

**Observed vs expected**
- Observed: 65 KB of allowed input caused ~128 MiB additional external memory / ~134 MiB RSS during synchronous validation. The nominal 8 MiB file ceiling permits far larger compression bombs; DEFLATE expansion can be orders of magnitude above compressed size, so an allowed file can drive the process toward OOM.
- Expected: image validation must bound decoded pixels/output before or during decompression (dimension/pixel cap plus inflater max output), and expensive decoding should not be an unbounded synchronous main-process operation.

**Impact**
A malicious or merely pathological PNG in any approved repository can freeze or crash the connector when the model inspects it. No filesystem-write capability is required: read permission is enough. Since this is synchronous CPU/memory work in the same process serving MCP/Electron main responsibilities, it can stall the entire app, not just one response.

**Likely root cause**
The transport adaptation replaced upstream's image decoder with a hand-rolled PNG decode proof, but retained only the compressed 8 MiB response-size cap. `inflateSync` receives no maximum-output guard, while PNG's 32-bit width/height fields are accepted without a realistic pixel ceiling.

**Missing tests / false confidence**
Existing image tests use tiny fixtures and corruption cases. None exercise extreme-but-valid dimensions, decompression ratio, decoded memory ceilings, or event-loop blocking. The focused MCP/Electron suite was 193/193 green despite this path.

**Probe command outcome**
Probe passed in 55 ms because it asserts acceptance of the current pathological file. Generator and probe are audit-only files under `bughunt-2026-08-20`; no production code changed.

## Focused regression-suite result

Ran the current focused suite with no source changes:
`npx vitest run test/mcp.test.ts test/ipc.test.ts test/bridge.test.ts test/renderer-layout.test.ts test/renderer-html.test.ts --reporter=verbose`

Result: **5/5 test files passed, 193/193 tests passed** in 28.52 s. This is important false-confidence evidence: all six findings above remained reproducible while the focused suite was completely green. The missing dimensions are concurrency/lifecycle overlap, large-session complexity, dirty focused form state, just-exited process races, shutdown during an accepted MCP mutation, and decoded-image resource amplification.

## Consolidated chronological tool-call error log

1. First audit probe invocation: `npx vitest run bughunt-2026-08-20/probe-session-tail.test.ts --reporter=verbose` exited 1 with “No test files found” because the repository Vitest config only includes `test/**/*.test.ts`. **Classification: my misuse / harness mismatch.** I corrected only the audit harness by adding `bughunt-2026-08-20/vitest.probe.config.ts`; no production file was touched.
2. During the large-session probe, sending Ctrl+C to its retained exec session returned `write_stdin failed: Unified exec process failed: kill ESRCH`. **Classification: connector bug.** It was later reproduced independently and promoted to the MEDIUM `write_stdin` race finding above.
3. The large-session Vitest invocation itself ultimately exited 1 because `readEvents(id,{limit:1})` took 68.3 s and exceeded Vitest's 5 s timeout. **Classification: connector bug reproduced.** The timeout was the measured session-history freeze symptom, not a harness/configuration error.
4. Independent live `write_stdin(session_id=11877, chars=Ctrl+C)` returned `write_stdin failed: Unified exec process failed: kill ESRCH`; immediate empty poll returned the command's real `DONE`, exit 0. **Classification: connector bug reproduced.**
5. A later source-search command included a guessed nonexistent path `test\codex-tools.test.ts`, causing PowerShell `Select-String` to exit 1 with “Cannot find path ... because it does not exist.” **Classification: my misuse / bad guessed filename.** Its preceding source read succeeded and no connector behavior was implicated.

No other tool-call errors occurred in this worker's audit.

## Severity-ranked summary

1. **HIGH — Session-history main-process freeze / resource blow-up.** `sessions:events` and the MCP `session history` path read and parse the full journal before enforcing result limits; `chronological()` adds an O(n²) untagged-event path. A 40.0 MB / 250k-event journal took 68.3 s and ~83.6 MiB extra JS heap for `limit:1`. Refs: `src/main/ipc.ts:295-309`, `src/main/session/store.ts:705-780`, `src/shared/chronology.ts:84-93,110-123`, `src/main/mcp/tools-core.ts:744-803`.
2. **HIGH — MCP disconnect creates ambiguous commits.** Endpoint stop destroys active sockets immediately but accepted handlers continue, so ChatGPT can see transport failure and retry while the first mutation still commits. Real HTTP probe: stop returned in 1 ms, client got `fetch failed`, command wrote its delayed side effect two seconds later. Refs: `src/main/mcp/server.ts:432-439`, `src/main/connection.ts:352-367`, `src/main/mcp/call-context.ts:121-153`, `src/main/mcp/kernel.ts:332-435`.
3. **HIGH — Concurrent bridge startup leaks an untracked live HTTP server.** Two simultaneous starts bound two distinct ports; one stop closed only the globally referenced instance and left the other reachable. Repeated races can consume the fixed 8765–8769 pool. Refs: `src/main/ipc.ts:151-179`, `src/main/bridge.ts:79-80,1251-1338`.
4. **HIGH — `view_image` PNG decompression bomb.** The 8 MiB on-disk cap has no decoded-pixel/output bound; synchronous `inflateSync` runs before any post-inflate size validation. A valid 65,303-byte PNG expanded to 67,117,056 decoded bytes and one call measured +134.2 MiB RSS / +128.1 MiB external memory. Refs: `src/main/fsops.ts:18-19,273-303,363-379`, `src/main/codex/view-image.ts:253-324,334-383`, `src/main/mcp/tools-core.ts:303-335`.
5. **MEDIUM — Live state pushes erase unsaved focused settings edits.** The real renderer reverted a focused `#tunnelId` dirty value on an unrelated `state:changed`; main-side state builds are also unordered async snapshots. Refs: `src/main/ipc.ts:119-128,407-415`, `src/main/connection.ts:73-75,207-234`, `src/renderer/main.ts:390-393,466-473,1013-1029`.
6. **MEDIUM — `write_stdin` Ctrl+C / natural-exit race returns false process failure.** A just-completed successful pipe command produced `kill ESRCH`; the next empty poll returned its actual `DONE`, exit 0. Refs: `src/main/codex/unified-exec.ts:446-463,714-752,781-795`.

## Hardening checked that held in the current tree

- The formerly reported no-Content-Length/chunked MCP body-size hole is fixed: `src/main/mcp/server.ts:88-130,375-399` buffers missing-length POSTs under the same 8 MiB cap, and `test/mcp.test.ts:498-526` sends a genuinely chunked oversized request and verifies the server remains usable.
- MCP Core/Desktop routing is path-separated with independent random tokens; loopback Host and Origin validation are in front of handlers. Existing cross-surface/unknown-tool tests passed.
- Electron's main window has `contextIsolation`, renderer sandboxing, `nodeIntegration:false`, `webviewTag:false`, navigation denial and window-open denial; preload exposes a fixed named API rather than generic IPC.
- The previously reported renderer session-A/session-B async paint race is guarded by generation checks in the current `src/renderer/chat.ts`; I did not re-report it.
- Connection lifecycle itself uses a serialization queue and generation checks for tunnel callbacks. The bridge's separate lifecycle lacks that protection, which is why the concurrent-start bug above survives.
- Windows process-tree termination has a bounded `taskkill` helper plus direct-kill fallback; I found no separate unbounded shutdown wait there.

## Unresolved gaps / follow-up targets

- I reproduced the dirty-form overwrite, but did not artificially delay `hasSecret()`/`bridgeStatus()` to force an older `buildState()` promise to arrive after a newer one. The source has no ordering guard, so stale push ordering remains a closely related unverified race.
- `view_image` duplicates image bytes in both the MCP native image content block and Codex-compatible `structuredContent.image_url` (`src/main/mcp/tools-core.ts:326-329`). At the 8 MiB input ceiling that is roughly 21.3 MiB of base64 text before JSON/object overhead. I did not push a maximum-size image over the live tunnel, so this remains a transport/resource concern rather than a separate confirmed finding.
- I did not launch or automate the packaged Electron GUI; renderer behavior was exercised through the real renderer module in jsdom, and MCP/bridge findings through real local HTTP servers. Packaged-only Chromium/Electron timing remains an integration gap.
- I did not stress external tunnel-client/OpenAI-network failure modes or real ChatGPT retries. The ambiguous-commit finding was proven locally by the exact HTTP failure + post-failure side effect, but retry duplication itself was not induced against ChatGPT.
- Per the assignment, I did not duplicate the dedicated extension/transcript audit or the dedicated filesystem/path-containment audit.

## Audit integrity

No production-code fixes were made. This worker only created/updated files under `bughunt-2026-08-20/`. The repository already contained the other modified/untracked production/smoke files shown by `git status` when this worker began; they were left untouched.
