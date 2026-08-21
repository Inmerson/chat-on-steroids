# Connector Bug Hunt — 2026-08-20

> **Consolidated forensic report:** `00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md` — start here. It merges all worker findings, the live worker-5 Unattributed failure, durable-log forensics, a fresh verification pass, and additional root-cause findings discovered during consolidation.

Prime + 3 worker agents. Findings are appended here after independent verification.

## Scope split
- worker-filesystem-codex.md — filesystem/path + Codex-style tools
- worker-extension-transcript.md — extension/transcript/session/turn races
- worker-mcp-electron.md — MCP/Electron/renderer/security

## Prime tool-call error log
- 11:48 local — `exec_command`: invalid PowerShell here-string syntax while creating this file. Classification: **prime invocation misuse**, not connector bug.

## Prime findings

_Pending._

## Consolidated severity ranking

_Pending worker completion._

## Run status update
- Original worker-1 failed because its ChatGPT conversation closed before finishing. Replaced by worker-4 with the same filesystem/Codex scope.
- Active audit workers now: worker-2 extension/transcript, worker-3 MCP/Electron/security, worker-4 filesystem/Codex.

## Prime regression-suite observation
- Full `npm test -- --reporter=verbose`: 1009 passed, 83 skipped, 2 failed in `test/computer.test.ts` with `WINDOW_NOT_FOUND`.
- Immediate isolated rerun of exactly those 2 tests passed (2/2). Current classification: likely environment/order-sensitive flake, not yet proven production bug. Needs repeated/ordered reproduction before promotion to finding.

## LIVE-001 — Worker bootstrap can steal focus, capture user keystrokes, then fail unbound
**Severity:** High usability/reliability; potentially High attribution impact.
**Observed live on 2026-08-20 around 11:50 Europe/Berlin:** user reported the worker chat did open, but its activity landed in Unattributed; while the user was typing in the original chat, the app opened another worker tab and focus moved there, so the earlier bootstrap did not launch successfully. `agents status` then reported worker-4 failed with `the browser could not start the chat — ChatGPT refused the inserted text`.
**Code evidence:** `src/main/bridge.ts:1620+` actively opens worker URLs and, after a worker bootstrap fails, `ack` -> `drop()` -> `deliver()` immediately opens the next queued worker (`bridge.ts:1882-1894`). `extension/content.js:4594-4608` protects a pre-existing draft only before `waitForComposer()`, then `CLF_DOM.insertPrompt()` refuses a non-empty composer. `extension/chatgpt-dom.js:1233-1246` confirms `insertPrompt()` returns false whenever the composer contains text. Therefore keystrokes redirected into the newly focused ChatGPT tab between the first draft check and insertion make the bootstrap fail exactly as observed.
**Likely root cause:** the bridge treats failure of one worker bootstrap as permission to immediately launch the next browser tab, but browser opening is focus-stealing and not isolated from ongoing human typing. The bootstrap path does not own input focus and cannot distinguish accidental user keystrokes that landed in its fresh tab.
**Impact:** failed worker slot; next tab may steal focus again; user text can land in the wrong ChatGPT composer; tool activity from the unbound chat is expected to remain unattributed because the worker never reaches the conversation binding/activation boundary.
**Test gap:** existing `test/bridge.test.ts:1102-1122` proves only serial URL opening after a successful binding; `1413-1442` explicitly expects immediate next-worker opening after failure, but does not model foreground focus or user keystrokes. Content-script tests exercise composer occupancy but not the race where occupancy changes after the initial check / during `waitForComposer()`.


## LIVE-002 — Extension shows no active session while tools are actively running
**Severity:** High usability/observability.
**Observed live from user screenshots on 2026-08-20:** ChatGPT is actively issuing Local Files tool calls, but the extension popup/overlay shows `No active sessions yet` / no current activity, so the extension fails to surface work that is demonstrably happening.
**Evidence:** user-provided screenshots in this chat show active tool execution in ChatGPT while the Local Files extension UI remains empty. This is independent of the worker bootstrap failure and indicates a session/activity feed visibility or association bug.
**Next audit target:** trace extension popup/session list source, bridge `/activity` and session list plumbing, active/in-progress session filtering, and whether unattributed/current-turn activity is excluded from the UI.

### LIVE-002 evidence update
- The durable prime session `2026-08-20-bb3efcfc` contains the missing current calls (seq 60+ through the live screenshot period) under current local turn `g-1pu0obv1bw09g1-0-4`, all exact `request_id` attribution. So recording/attribution is working for these calls; the failure is downstream presentation.
- Browser inspection at the same time shows the ChatGPT Local Files popup connected with `Overwrite ChatGPT` enabled, while the current assistant area only shows native `Analyzing images` and none of the local calls that already exist durably.
- `extension/content.js:3216-3296` is a direct mechanism for this symptom: the renderer only mounts `.clf-stream` after it can bind/reconstruct the visible assistant turn and `completeReplacementForTurn()` passes; otherwise it removes any local stream and deliberately leaves the native turn. For an active newest turn, `3244-3266` depends on `generationTurn()`/local generation binding; incomplete binding means the durable local calls are not surfaced at all.
- `generationTurn()` (`content.js:719-758`) can return null while a generation has already started and tools are running, because it refuses to claim a section until a new section appears or the page-authored section signature changes. The test suite itself contains skipped regression cases exactly around this mount/commentary phase (`test/content-script.test.ts:3533-3592` and `3605-3631`).
- Strong current hypothesis: current live tool calls are being hidden by the renderer fail-closed gate while ChatGPT is in the native image-analysis/commentary phase and the newest assistant section has not been bound strongly enough for full replacement. Worker-2 is independently checking this before final severity/root-cause wording.

## Prime independent confirmations
- **F1 native traversal parity bug confirmed live:** `read("C:\\Users\\totec\\chatgpt-local-files\\src\\..\\package.json")` succeeds and normalizes to `/totec/chatgpt-local-files/package.json`, while `/totec/chatgpt-local-files/src/../package.json` is refused with `Path traversal ("..") is not allowed`. This verifies worker-5 finding against the installed connector.
- **Stale correlation restore bug independently reproduced:** audit repro fails exactly because newer durable `wfr_new` ownership restores as `undefined` when an older valid snapshot exists.
- **Concurrent bridge-start orphan independently reproduced:** two simultaneous starts bind 8766 and 8767; one stop leaves 8766 reachable while 8767 closes.

### LIVE-002 reproduction strengthened
- Prime temporarily copied `test/content-script.test.ts`, unskipped only the two generation-binding regressions, ran them, and deleted the temporary copy immediately. **Both failed on current code.**
- `waits for the new section instead of reusing the previous turn when STOP appears first` expected `new turn progress` under the freshly minted generation but emitted **no progress at all**.
- `binds a generation to a section it has only written commentary into` expected `Looking through the log` but emitted **no progress at all**.
- These are not hypothetical stale tests: their failure mode matches the live screenshot exactly. A turn can be started and its connector tool calls durably recorded before the extension binds the page section; during that gap the page renderer has no safe localId/group and `renderStreams()` shows no local activity. The user sees only ChatGPT native busy/commentary such as `Analyzing images` while Local Files is actively doing work.
- Existing full suite hides this because both regressions are `it.skip` (`test/content-script.test.ts:3533` and `3605`).


## LIVE-003 — worker-5 became a zombie binding while all real work went to Unattributed
**Severity: HIGH reliability / attribution.**
- User observed worker-5 effectively disappear while the broker still reported it active.
- Broker state still binds worker-5 to conversation `6a86ce29-3f14-83eb-9d1c-1ff4a7b84608` and state `active`.
- Its bound session `2026-08-20-5a2e6c1e` stopped at launch: 5 events, 1 user message, **0 tool calls**, updated at 11:51:49.
- The Unattributed session `2026-08-20-831d7354` contains the worker-5 audit calls from 11:52 onward under request `ebb257d5-e0f6-4bf0-9bcd-a6280f1c9d5b`: reads, execs, apply_patch repros, and both `agents` calls that were refused with WORKER_IDENTITY_LOST.
- Therefore this is not a dead worker process. It is a split brain: browser/broker binding says worker-5, while MCP request correlation supplies no conversation or agent, so the worker works normally but every result is filed as Unattributed and broker control is unavailable.
- This also explains why messages queued by prime to worker-5 remain undelivered: broker queue has 2 pending messages, while worker-5 tool results have no agent identity and therefore cannot receive its inbox.
- Keep this distinct from the stale-on-restart correlation-index bug until the live request-id evidence failure is isolated.


### LIVE-003 likely root cause — health check validates content.js but not fiber.js
- `extension/background.js:948-973` recovery pings each ChatGPT tab with `clf-recorder-ping`; any `{ok:true, recorderVersion:8}` makes it `continue` and skip reinjecting `chatgpt-dom.js`, MAIN-world `fiber.js`, and `content.js`.
- `extension/content.js:4731-4736` answers that ping with `{ok:true, recorderVersion:FIBER_VERSION}`. This is only a constant compiled into content.js. It does **not** ping or validate that MAIN-world fiber.js exists, is answering, or is the same version.
- Existing test `test/extension.test.ts:645-657` explicitly green-lights this: a healthy recorder ping means *no* reinjection at all. There is no test for live content.js + absent/stale/dead fiber.js.
- Request ownership depends on fiber.js exposing ChatGPT `metadata.request_id`; `content.js:1156-1163,1677-1817` repeatedly asks Fiber and only emits `tool_evidence` when it gets a valid reply. Without Fiber, MCP calls have no exact page correlation and fall into Unattributed.
- This is an exact mechanism for worker-5: its bound session recorded initial lifecycle but no tool evidence/tool calls; all later calls with request id `ebb257d5-e0f6-4bf0-9bcd-a6280f1c9d5b` went to Unattributed and agents identity failed twice.
- Root cause is strongly supported but the live tab has not yet been instrumented to prove fiber.js is the component missing; preserve that distinction in final wording.


## Worker-5 findings independently confirmed by prime
### HIGH security — reparse/junction TOCTOU escapes the approved root after validation
- Repro `bughunt-2026-08-20/repro-reparse-toctou.ts` was rerun by prime and again returned `read:"outside"` after resolving an inside-root pathname and then replacing its ancestor with a junction before backend I/O.
- The repro stays entirely inside the repository on disk; `outside` means outside the custom approved sandbox root. This proves the containment check does not bind subsequent I/O to the object it validated.
- Relevant production pattern: `src/main/sandbox.ts:277-300` returns a canonical pathname string; later `read`, `view_image`, `find`, exec cwd spawn, and apply_patch perform separate pathname-based operations. Static reparse tests cannot catch this namespace-swap race.

### HIGH reliability / Codex parity — view_image accepts invalid compressed image payloads
- Worker-5 direct repro `bughunt-2026-08-20/repro-view-image-gap.test.ts` returns success for a 30-byte RIFF/WebP with only a plausible VP8 header.
- Prime independently decoded the exact same bytes with Pillow 12.3.0/libwebp; decoder rejected them with `OSError: could not create decoder object`.
- `src/main/codex/view-image.ts` uses structural/payload heuristics for JPEG/GIF/WebP instead of Codex `image::load_from_memory` semantics, so successful MCP image content can still contain undecodable bytes and potentially break the ChatGPT message stream.

### MEDIUM — native Windows path normalization erases traversal before validation
- Prime independently confirmed live: native `C:\\Users\\totec\\chatgpt-local-files\\src\\..\\package.json` succeeds, while virtual `/totec/chatgpt-local-files/src/../package.json` is rejected for `..`.
- This does not itself escape containment, but violates the explicit invariant that native spellings normalize into the same sandbox checks as virtual paths.

### HIGH correctness — intercepted `cd missing && apply_patch` can execute despite shell gate
- Worker-5 safely reproduced that an intercepted `cd missing && apply_patch` creates the missing workdir and applies the patch instead of failing at `cd`.
- Upstream Codex inspection suggests this behavior may be inherited from its apply_patch interception verifier rather than a local port divergence, so classify it as connector/user-command semantic risk unless upstream execution semantics prove otherwise.


## Worker-2 additional reproduced loss/duplication bugs

### HIGH — /events retry is at-least-once but lifecycle events are not idempotent
- Background retains journal entries until HTTP 200 (`extension/background.js:391-435`). A committed server response that is lost/network-fails is retried (`background.js:510-550`).
- `/events` has no batch/event identity (`src/main/bridge.ts:610-670`), while recorder appends named `turn_start` / `turn_end` without replay dedupe (`src/main/session/recorder.ts:1360-1403`).
- Worker-2 replayed the identical lifecycle batch and got four durable events: start, start, end, end.
- Impact: duplicate turn boundaries/groups after response loss, service-worker death, or retry. Canonical message dedupe does not protect lifecycle.

### HIGH — content pre-journal queue silently drops observation 401
- `extension/content.js:444-451` caps the pre-journal queue by splicing oldest entries with no gap marker or loss signal.
- Worker-2 emitted 401 unique observations before flush. Service worker received exactly 400; `queued-0` vanished and first surviving item was `queued-1`.
- Existing transient receiver coverage exercises one queued observation only, so it cannot catch sustained receiver/update outages.
- Impact: page evidence, messages, request-id evidence or lifecycle can be silently lost before the durable service-worker journal ever sees it.


## Worker-3 reproduced MCP / Electron / process bugs

### HIGH — bounded timeline requests can still freeze Electron main
- Refs: `src/main/ipc.ts:295-309`, `src/main/session/store.ts:705-780`, `src/shared/chronology.ts:84-93,110-123`, `src/renderer/chat.ts:245-265`.
- Probe `bughunt-2026-08-20/probe-session-tail.test.ts`: 250,000 valid progress events (~40.0 MB); asking for one event took 68,305 ms and ~83.6 MiB heap growth.
- The requested limit is applied only after whole-file read/parse/chronology. Untagged chronology also has a repeated-prefix scan that becomes quadratic. Normal renderer session selection reaches this path.

### HIGH — concurrent bridge startup leaks an untracked live HTTP listener
- Refs: `src/main/ipc.ts:151-179`, `src/main/bridge.ts:1251-1338`.
- Probe `bughunt-2026-08-20/probe-bridge-race.test.ts`: concurrent starts bound ports 8766 and 8767; after one stop, 8766 remained reachable while 8767 closed. Prime independently reproduced.
- Impact: UI can claim stopped while a local listener still accepts requests; repeated races can exhaust the fixed five-port pool.

### MEDIUM — background state pushes erase focused unsaved settings
- Refs: `src/main/ipc.ts:119-128,407-415`, `src/main/connection.ts:73-75,207-234`, `src/preload/index.ts:89-92`, `src/renderer/main.ts:390-393,466-473,1013-1029`.
- Probe `bughunt-2026-08-20/probe-renderer-state-clobber.test.ts`: focused tunnel-id text containing an unsaved edit was reset to persisted state by a live state-changed push while focus remained.
- Independent asynchronous state builds also have no revision/order guard, so stale snapshots can resolve after newer ones.


### LIVE-003 Fiber health gap now has an executable failing regression
- Audit repro: `bughunt-2026-08-20/repro-fiber-health-gap.test.ts` copies the real extension harness and changes only the desired health invariant.
- Scenario: background sees an open ChatGPT tab; isolated content script answers `clf-recorder-ping` with recorder version 8. Desired behavior is to verify/recover MAIN-world `fiber.js` too.
- Current result: zero `scripting.executeScript` calls. The assertion that `fiber.js` is revalidated/reinjected fails exactly.
- This proves the recovery protocol cannot distinguish fully healthy page instrumentation from content.js-only half-health. Combined with worker-5 live evidence (lifecycle survives but request-id evidence never appears), this is now a concrete candidate root cause rather than code-only suspicion.


### HIGH — disconnect drops accepted MCP response while handler keeps mutating
- Refs: `src/main/mcp/server.ts:432-439`, `src/main/connection.ts:352-367`, `src/main/mcp/call-context.ts:121-153`, `src/main/mcp/kernel.ts:332-435`.
- Probe `bughunt-2026-08-20/probe-mcp-stop-inflight.test.ts` uses a real local MCP endpoint. After the command wrote a start marker, endpoint stop returned in 1 ms and the client got fetch failure, yet the command continued and wrote its delayed post-stop marker two seconds later.
- Prime independently reran the probe with the same result.
- This is an ambiguous commit: callers may retry a transport-failed mutation while the first accepted mutation is still executing.

### HIGH — view_image PNG validation permits compressed-memory amplification
- Refs: `src/main/fsops.ts:18-19,273-303,363-379`, `src/main/codex/view-image.ts:253-324,334-383`, `src/main/mcp/tools-core.ts:303-335`.
- Probe input is a valid 65,303-byte 8192x8192 grayscale PNG whose decoded scanline stream is 67,117,056 bytes.
- Prime rerun: one validation succeeded in 48 ms while increasing RSS by ~134.1 MiB and external memory by ~128.1 MiB.
- The 8 MiB on-disk input cap does not bound decoded pixels/output; synchronous inflate runs without a maximum-output guard in the Electron/MCP main process.


## Additional worker-2 cross-session integrity findings

### HIGH — activity feed forgets a still-open chat after app restart
- Refs: `src/main/bridge.ts:699-865`, `src/main/session/recorder.ts:927-940,1103-1123`.
- Worker-2 reproduced: after recorder memory reset, a later exact request-id tool call still appended to chat A on disk, but the browser activity request for A returned no session and an empty stream.
- The activity route trusts only the in-memory live-conversation map and does not reopen the durable chat even though the browser poll itself proves the chat is still open.


## Worker-5 additional filesystem/runtime findings

### MEDIUM — uncommon filesystem canonicalization errors expose native Windows paths
- Refs: `src/main/sandbox.ts:147-164`, `src/main/mcp/kernel.ts:119-129`.
- Prime reran `bughunt-2026-08-20/repro-error-path-leak.ts`: a self-referential junction triggers ELOOP and `friendlyError()` returns the raw `realpath` message including the full native approved-root pathname.
- Common error codes are sanitized, but unrecognized filesystem errors fall through to `err.message`, contradicting the model-facing no-real-path error contract.

### HIGH — unresolved caller identity fails open for shared exec sessions
- Refs: `src/main/codex/ownership.ts:1-58`, `src/main/mcp/tools-core.ts:561-564,600-608,705-724`, `test/mcp.test.ts:2066-2157`.
- The guard denies only when both caller and owner conversations are known and different. Unknown caller identity is explicitly allowed.
- The existing test at `test/mcp.test.ts:2130-2138` asserts that an unproven caller can write to a session owned by another known chat. Session-status filtering uses the same predicate.
- This is material because worker-5 is a live example of prolonged unresolved identity. Shared process-manager isolation therefore weakens exactly when attribution fails.

