# ChatGPT Local Files 1.8.7 — consolidated verified bug hunt

Date: 2026-08-21  
Audited revision: `f7388750fb975f366b7c99994557a444ceba84ac` (`main`)  
Scope: code and architecture only; performance, crash/breakpoint behavior, Chrome extension, bridge, Electron lifecycle, sessions, renderer, MCP/Codex-derived tools, and packaging/runtime ownership.  
Method: eight independent `gpt-5.6-luna` agents at `max` reasoning, followed by primary-agent source review and deduplication.  
Repository policy: the pre-existing dirty tree was preserved. No product source was edited. No routine test, build, package, install, or live ChatGPT run was performed, per the user's instruction that the tests already pass and this hunt should look beyond them.

## Evidence vocabulary

- **Reproduced** — a focused runtime-shaped or algorithm-equivalent probe demonstrated the failure or resource curve. This is not a claim that a live ChatGPT tab was crashed.
- **Source-confirmed** — the current production control/data flow necessarily permits the behavior. Exact real-world frequency may still depend on workload or Electron/Chrome timing.
- **Risk only** — plausible but still needs a targeted live or fault-injection reproduction. Risk-only items are not in the main verified list.

Passing tests do not contradict these findings. Most are missing whole-call budgets, lifetime/epoch ownership gaps, large-but-valid input cliffs, failure-between-phases problems, or production scheduling interactions that unit tests do not model.

## Executive result

The most credible explanation for “ChatGPT sometimes crashes with the extension” is not one isolated selector bug. It is a workload-amplification chain in the page:

1. streaming DOM mutations can schedule a near-full transcript observation every 50 ms;
2. each pass performs several global scans and some quadratic de-duplication/nesting work;
3. it can request a Fiber snapshot whose fields are capped individually but whose total response is not capped;
4. the response is structured-cloned into the isolated world before the content script truncates what it reports;
5. if the MV3 worker/bridge is unavailable, large observations can also accumulate in a count-bounded but byte-unbounded page queue;
6. periodic activity polling and Fiber recovery add independent work even when no user-visible action requires it.

This chain can simultaneously create high renderer CPU, large short-lived allocations, GC pressure, UI stalls, and a tab crash. A live Chrome trace is still needed to assign the final crash to renderer OOM versus watchdog/hang, but the production amplification paths themselves are verified.

Outside the extension, the most serious whole-app breakpoints are an unbounded giant-line `read` path, live process orphaning when the terminal-session registry is pressured, synchronous full-timeline rendering, repeated whole-file message rewrites, and shutdown ordering that can cancel accepted work and skip durable flushes.

## Priority 0 — fix before broader optimization

### V-01 — Extension transcript/Fiber amplification can exhaust a ChatGPT renderer

**Status:** source-confirmed; quadratic component reproduced with a synthetic DOM workload.  
**Impact:** ChatGPT tab stalls or crashes; extension overhead grows sharply with long/streaming chats.  
**Root boundary:** large-output budgeting plus document scheduling.

Current production paths combine:

- `extension/content.js::watchTranscript()` observes the document body subtree including `characterData` and schedules `observe()` after 50 ms.
- `observe()` repeatedly asks `CLF_DOM.turns()`, scans authored messages and tool/error state, updates turn state, and can call `refreshFiber()`.
- Separate tool-row observation, the one-second observation/render loop, the two-second activity pull, and the five-second Fiber repair path add work with separate schedules.
- `extension/chatgpt-dom.js` contains whole-result duplicate/candidate/nesting scans, including row membership checks that become quadratic as the transcript grows.
- `extension/fiber.js` allows as many as 200 messages across the newest six turns. Per-message limits exist (`rawText` 256,000 characters and `renderedHtml` 120,000), but the complete response has no byte/character budget. The theoretical permitted aggregate is about 451.2 million characters before structured-clone and object overhead.
- `content.js` slices fields only after the MAIN-world object has been built and passed through `window.postMessage`, so that truncation cannot protect the page from the largest allocation/copy.

An algorithm-equivalent DOM probe measured roughly 33.8 ms for one scan at 400 rows/200 messages. At the 50 ms scheduler ceiling, that component alone extrapolates to about 676 ms of JavaScript work per wall-clock second, before Fiber traversal, serialization, IPC, painting, and ChatGPT's own streaming work. The number is not a browser benchmark; it establishes the adverse growth curve.

**Fix direction:** create one document-scoped scheduler with explicit dirty reasons and minimum cadence; make scanning incremental by stable turn/message identity; replace repeated array membership/nesting checks with indexed sets/maps; establish one aggregate byte/character/node budget inside `fiber.js` before object construction/postMessage; avoid Fiber refresh unless evidence consumers actually need it; add production counters for scan duration, visited nodes, serialized bytes, skipped/coalesced runs, and queue bytes.

**Primary evidence:** `extension/content.js` (`watchTranscript`, `observe`, `refreshFiber`, `pullActivity`, Fiber repair); `extension/chatgpt-dom.js` (`turns`, tool-row/activity grouping); `extension/fiber.js` response construction. Worker report: `01-extension-content-fiber-crash-performance.md`, findings E1-E3; `02-extension-background-lifecycle-performance.md`, finding F5.

### V-02 — Extension outage buffering is count-bounded but can retain roughly 156 MiB plus overhead

**Status:** source-confirmed.  
**Impact:** memory spike in the ChatGPT renderer precisely when the service worker or app is unhealthy; can compound V-01.  
**Root boundary:** queue representation budget.

The content script keeps up to 400 pending observations while the service worker cannot accept them. Individual browser observations may carry about 400 KiB. The count limit therefore permits approximately 156.25 MiB of payload data, before JavaScript object/string overhead and duplicate transient copies. The queue drops by count rather than enforcing a total byte budget or preferentially preserving small identity/lifecycle evidence.

**Fix direction:** enforce an aggregate serialized-byte budget; coalesce mutable message snapshots by stable identity; preserve compact lifecycle/identity events ahead of replaceable large text/HTML snapshots; stop requesting or retaining rendered HTML during an outage; expose queue bytes and drop/coalesce counters.

**Primary evidence:** `extension/content.js` pre-service-worker observation queue and observation-size policy. Worker report: `01-extension-content-fiber-crash-performance.md`, finding E4.

### V-03 — SPA navigation has no end-to-end epoch, allowing stale work to affect the wrong chat

**Status:** source-confirmed; stale auto-compaction path reproduced with a focused harness.  
**Impact:** wrong conversation can be stopped, compacted, closed, or receive a redeemed command after A -> B -> A or delayed async completion.  
**Root boundary:** conversation id without navigation epoch.

Verified variants share the same architectural defect:

- `content.js::pullActivity()` validates a local id/epoch before accepting activity, but the auto-compaction side effect occurs outside a complete current-route proof. A focused harness changed the route from A to B while A's async activity was outstanding and observed A's compact claim/compact flow plus a stop-button action in B.
- The background registry distinguishes documents with `documentId`, but same-document SPA visits do not receive an equivalent navigation generation. A delayed `closed(A)` from an earlier visit can arrive after A -> B -> A and be indistinguishable from the current visit.
- Command redemption/processing contains awaited phases without an end-to-end route+epoch recheck immediately before page mutation/typing/acknowledgement.

Conversation id equality is insufficient because A -> B -> A restores the same id while invalidating the old work.

**Fix direction:** issue a monotonically increasing navigation epoch for every route transition; carry `{tabId, documentId, conversationId, navigationEpoch}` through content, background journal, bridge commands, activity, close, compact claim and ACK; revalidate immediately before every irreversible page/app side effect; make the app reject stale epochs, not merely let the content script ignore the response.

**Primary evidence:** `extension/content.js` activity/compaction and command flows; `extension/background.js` tab/conversation registry and close handling. Worker reports: `01-extension-content-fiber-crash-performance.md`, finding E5; `02-extension-background-lifecycle-performance.md`, finding F2.

### V-04 — A valid giant no-newline file can make `read` allocate far beyond its output cap

**Status:** source-confirmed; algorithm-equivalent 64 MiB probe reproduced about +157 MiB RSS while returning no useful bounded output.  
**Impact:** Electron main-process memory exhaustion or long stall from a permitted read.  
**Root boundary:** decoded carry is not covered by the model-output budget.

The streaming read path bounds emitted output, but accumulates decoded `carry` until it encounters a newline or EOF. A single enormous line therefore bypasses the intended bounded-representation policy. The underlying stream primitive does not apply the normal 512 MiB whole-file ceiling, so the worst case is governed by the input and V8 memory rather than the model response limit.

**Fix direction:** cap raw bytes and decoded carry independently of emitted text; when a line exceeds the cap, return a deterministic truncation/error without retaining the rest; decode incrementally with bounded state; cover CR/LF split boundaries and multibyte encodings.

**Primary evidence:** `src/main/codex/read-backend.ts` streaming line selection and `src/main/codex/filesystem.ts` stream primitive. Worker report: `07-codex-tools-runtime-performance.md`, finding C1.

### V-05 — Terminal-session pressure can orphan a live OS process

**Status:** source-confirmed.  
**Impact:** untracked process continues consuming CPU/memory or mutating the machine; it is absent from normal polling and shutdown cleanup.  
**Root boundary:** registry capacity is enforced by forgetting ownership, not terminating the resource.

When the unified-exec session manager prunes for its nominal 64-session limit, it can remove a live least-recently-used entry without first terminating and awaiting its child. If all candidate locks are held, pruning returns and a 65th entry is inserted, so the limit is not hard. A forgotten child becomes unreachable through `write_stdin` and can also escape the app's later `terminateAllProcesses()` bookkeeping.

**Fix direction:** never evict a live child by deleting only registry state; reject new sessions at a hard cap or perform an explicit terminate-and-await transition; distinguish running, exited-with-undrained-output, and collectible states; make registry removal conditional on proven process exit and buffer disposition.

**Primary evidence:** `src/main/codex/unified-exec.ts` capacity pruning/session insertion and shutdown enumeration. Worker report: `07-codex-tools-runtime-performance.md`, finding C5.

## Priority 1 — high-value reliability and scale fixes

### V-06 — Shutdown races accepted work and can skip all durable flushing after one rejection

**Status:** source-confirmed.  
**Impact:** killed commands, abruptly cut bridge requests, missing final activity/session state, or lingering tunnel/helper descendants.

App shutdown starts MCP disconnect/drain, process termination, and bridge shutdown concurrently with `Promise.all`. This allows child termination while an accepted MCP request is still completing/recording, while the bridge closes active connections rather than draining them. If any member rejects, subsequent recorder/session/durable flush calls are skipped and control reaches final quit. Tunnel teardown also initiates process-tree termination without awaiting a proven exit before removing its working directory; one cloudflared startup timeout remains alive beyond the launch attempt. The desktop PowerShell helper is timeout-killed per call but is not registered under an app-wide shutdown owner and its tree/exit is not fully awaited.

**Fix direction:** make shutdown phased and exception-aggregating: stop admission/listeners -> drain accepted MCP and bridge work with deadlines -> terminate/await owned child trees -> flush every durable writer independently -> report aggregated failures -> quit. Every timer and helper needs an explicit owner, cancellation, and awaited completion.

**Primary evidence:** `src/main/index.ts` shutdown composition; `src/main/connection.ts`; `src/main/mcp/server.ts`; `src/main/bridge.ts`; `src/main/tunnel/index.ts`; `src/main/computer/powershell-helper.ts`. Worker reports: `04-electron-mcp-connection-lifecycle.md`, findings E2-E3; `08-whole-app-packaging-breakpoints.md`, finding 2.

### V-07 — Canonical message persistence is an O(total history) rewrite with a hard 32 MiB failure cliff

**Status:** source-confirmed.  
**Impact:** streaming-message write amplification, main-process pauses, and eventual permanent failure to persist any further canonical message revision.

Each canonical message update clones/serializes and atomically rewrites the complete `messages.json` map. Streaming assistant revisions turn that into repeated O(M) work in total stored history. Once the serialized map exceeds 32 MiB, the write hard-fails; because every later update still serializes the same oversized map, persistence does not recover on its own. Individual-message caps do not prevent the aggregate cliff.

**Fix direction:** move canonical messages to an append/revision log or sharded/record-addressable store with compaction; impose an aggregate policy before mutation; isolate one oversized message instead of poisoning future writes; preserve atomic recovery semantics and stable message identity.

**Primary evidence:** `src/main/session/store.ts` canonical-message mutation/serialization limits and `src/main/session/recorder.ts` streaming snapshot updates. Worker report: `05-session-recorder-chronology-scale.md`, finding SR3.

### V-08 — The renderer synchronously reparses and replaces a byte-unbounded timeline

**Status:** source-confirmed; synthetic renderer-shaped probe reproduced about 966 ms and +434 MiB heap for 125 messages containing roughly 15 MiB of HTML input.  
**Impact:** multi-second UI freezes or renderer OOM when opening/refreshing a large recorded session.

IPC event counts are capped, but the timeline has no corresponding aggregate text/HTML/DOM-node budget. A refresh parses/sanitizes large assistant HTML synchronously and replaces the full timeline DOM. The durable canonical file's 32 MiB cap narrows the normal maximum below some theoretical per-message combinations, but 32 MiB remains enough to create a very large transient parse/DOM allocation. Explicit-cursor event reads also traverse the complete event log, and session refresh work can scan thousands of session directories.

**Fix direction:** virtualize the timeline; render a byte- and node-budgeted window; defer/sandbox heavy HTML parsing; retain and patch stable message nodes; paginate both canonical messages and events by durable indexes; move filesystem parsing/sorting off latency-sensitive main/renderer turns where practical.

**Primary evidence:** `src/renderer/chat.ts` refresh/render/sanitization; `src/main/ipc.ts` session payload endpoints; `src/main/session/store.ts` message/event reads. Worker report: `06-renderer-preload-ipc-performance.md`, findings R1-R2.

### V-09 — Background delivery can stall indefinitely and acknowledged lifecycle data can still be lost

**Status:** source-confirmed.  
**Impact:** recording gaps, stale attribution, permanently pinned per-tab work queue, and lost conversation-close state after transient bridge failure.

Authenticated extension-to-bridge fetches other than `/hello` have no timeout. A hung event/activity request can leave content-side `flushing`/`pulling` guards set and pin the background's serialized per-tab promise chain. Journal draining is event-driven rather than independently retried after connectivity returns, so an idle journal can remain undelivered. Tab close removes the binding and makes one close/drain attempt, but a failed `/closed` delivery is not stored in a durable close outbox. One invalid head item can also block later items because draining stops at the failure.

**Fix direction:** add abort deadlines to every fetch; make queues failure-isolated per item; run bounded retry with persisted next-attempt state; retain close as a durable idempotent event until app ACK; ensure reconnect/status transitions schedule a drain; expose oldest-item age and stuck-request state.

**Primary evidence:** `extension/background.js` bridge fetch, journal drain, tab release/close, and per-tab serialization; `extension/content.js` pull/flush guards. Worker report: `02-extension-background-lifecycle-performance.md`, findings F1 and F3.

### V-10 — Resume command settlement occurs before authoritative app ACK

**Status:** source-confirmed.  
**Impact:** a valid replacement/superseding Compact & Resume command can become permanently unredeemable on that browser session.

The extension records a resume command id as settled before `/commands/ack` is known to have been accepted. Failure/rejection does not roll the settlement back. The app can legitimately reuse the logical command id for a superseding resume state, so a stale page-side attempt can blacklist the later valid command. Persisted settlement is truncated, but the in-memory settled set is not.

**Fix direction:** use an explicit command generation/lease token; settle only after authoritative app ACK; keep rejected/transient states distinct; bound both persisted and in-memory tombstones; make supersession a first-class state transition rather than id reuse ambiguity.

**Primary evidence:** `extension/background.js` command redeem/ACK/settled handling and `src/main/bridge.ts` resume command lifecycle. Worker report: `03-bridge-agents-browser-orchestration.md`, finding F1.

### V-11 — Ending a swarm does not retire already-open worker tabs

**Status:** source-confirmed.  
**Impact:** a worker that the app considers retired can continue generating or making connector calls in an open ChatGPT tab; local bookkeeping and visible browser behavior diverge.

The agent broker returns retired worker identities when a run ends, but the bridge only cancels queued commands. It does not issue a stop/retire command to workers whose tabs are already open or generating. The stale worker may persist until a later connector call exposes the mismatch, and ordinary calls that do not demand worker-only routing can continue through an orphaned browser context.

**Fix direction:** introduce an explicit worker lease/run generation checked on every worker command and connector attribution; broadcast retirement to open tabs; stop generation where safely identifiable; fail closed for calls presenting an expired worker lease; make retirement idempotent and visible in UI/history.

**Primary evidence:** `src/main/agents.ts` end-run return state and `src/main/bridge.ts` run termination/command cancellation. Worker report: `03-bridge-agents-browser-orchestration.md`, finding F2.

### V-12 — Swarm stale detection can overlap expensive full-history scans on the Electron main process

**Status:** source-confirmed.  
**Impact:** periodic main-process stalls grow with worker count and session history; overlapping sweeps amplify load.

The stale-swarm interval can start a new async sweep without a singleflight guard. A sweep reads full event histories for prime/workers to infer activity. Slow disk/history parsing can therefore overlap the next 30-second tick. Related session paths scan up to thousands of directories or large canonical/event files during refresh/repair. This is work on the app's latency-sensitive process, not an offline maintenance job.

**Fix direction:** keep indexed last-activity/last-tool facts in durable metadata updated transactionally; singleflight the sweep; bound one tick by time/items; move deep repair scans to explicit maintenance; skip unchanged sessions using durable generations.

**Primary evidence:** `src/main/bridge.ts` stale sweep; `src/main/session/store.ts` event/session enumeration. Worker reports: `03-bridge-agents-browser-orchestration.md`, finding F3; `05-session-recorder-chronology-scale.md`, finding SR5.

### V-13 — Session projections and continuation state are not crash-recoverable across all commit points

**Status:** source-confirmed.  
**Impact:** sessions can disappear/duplicate, canonical messages can appear empty, or Compact & Resume can be stranded/split after a process crash.

`meta.json` is a debounced projection, yet startup does not consistently rebuild it from authoritative events when it is missing, corrupt, or behind. Corrupt `messages.json` falls back to an empty map without a canonical revision recovery source. Compact & Resume keeps important continuation authority in memory, and resume commands are intentionally not restored. A crash after handoff capture loses the continuation; a crash after durable conversation rebind but before all in-memory publication can leave disk and runtime views split on restart.

**Fix direction:** define one restart state machine for every continuation phase; persist intent/generation and recovery action around the durable commit; rebuild projections from authoritative logs or a validated checkpoint+log; never silently interpret parse failure as an empty valid session; add explicit quarantine/repair state.

**Primary evidence:** `src/main/session/store.ts`, `src/main/session/continuation.ts`, `src/main/bridge.ts`, startup restore in `src/main/index.ts`. Worker report: `05-session-recorder-chronology-scale.md`, findings SR1-SR2.

### V-14 — Search and broad-directory operations have per-piece limits but no whole-operation cost bound

**Status:** source-confirmed; catastrophic-regex fallback reproduced at roughly 7.1 seconds for a 30-character adversarial string with `(a+)+$`.  
**Impact:** MCP request can exceed its transport deadline or freeze the main process; broad directory enumeration can allocate heavily before result caps apply.

Multi-root `find` applies a per-scope timeout but can visit up to 32 roots sequentially. The theoretical total exceeds the 300-second HTTP deadline. When ripgrep is unavailable and JavaScript regex fallback is used, catastrophic backtracking is synchronous. Directory reads collect/sort complete `readdir` results before applying visible output limits. Similar “cap after materialization” patterns occur in file enumeration.

**Fix direction:** enforce a monotonic whole-call deadline and cancellation token; limit roots/entries/bytes before materialization; avoid synchronous backtracking regex on the main thread (safe engine, worker, or strict pattern policy); stream bounded top-k results.

**Primary evidence:** `src/main/search.ts`, `src/main/codex/read-backend.ts`, filesystem enumeration helpers. Worker report: `07-codex-tools-runtime-performance.md`, findings C2-C3.

### V-15 — Large-file `apply_patch` duplicates full-file work and memory

**Status:** source-confirmed; 64 MiB one-line algorithm-equivalent probe reproduced about +134 MiB RSS.  
**Impact:** a legal patch against a large file can stall or exhaust the main process even when the patch itself is small.

The wrapper verifies and then executes through phases that read/parse/rebuild the target again. For large or single-line files this produces multiple full-size strings/buffers and repeated matching work, up to the broad file ceiling. The accepted finding is resource amplification; multi-file atomicity is not promoted here because it requires a separate product-contract decision.

**Fix direction:** share one validated snapshot between planning and commit; establish a lower patchable-file/line budget or stream-safe algorithm; reject files whose reconstruction cost exceeds the request budget; measure peak bytes, not only input size.

**Primary evidence:** `src/main/codex/apply-patch/*` wrapper/planner/runtime. Worker report: `07-codex-tools-runtime-performance.md`, finding C4.

## Priority 2 — verified but narrower

### V-16 — Extension-wide bridge rate limit scales poorly with open ChatGPT tabs

**Status:** source-confirmed by primary review.  
**Impact:** routine activity polling can cause 429s and delayed recording/commands in large tab sets.

The bridge uses a global 900-request/minute limiter, applied before origin/auth validation. Each active content script polls activity every two seconds, about 30 requests/minute. Thirty tabs consume the full nominal budget before event, command, close, pair, or other traffic; 31 tabs necessarily exceed it. Any local source able to reach the loopback port can also consume the shared pre-auth bucket.

**Fix direction:** authenticate before charging the extension bucket; replace periodic per-tab polling with push/long-poll or adaptive idle backoff; use per-token/per-route fairness and reserve capacity for lifecycle/ACK traffic.

**Primary evidence:** `src/main/bridge.ts` request limiter and `extension/content.js::pullActivity()` interval.

### V-17 — Session asset quotas are not durable accounting

**Status:** source-confirmed.  
**Impact:** app data can grow beyond intended limits across restarts, especially through spilled text/structured values.

In-memory asset quota accounting resets on restart and not every overflow/spill representation participates in the same accounting. Limits therefore constrain a process lifetime more reliably than a durable session. Pruning based on a partial projection cannot guarantee disk bounds.

**Fix direction:** maintain transactional per-session and global durable byte counts; reconcile on startup/maintenance; count every asset/spill format; reserve before write and release after proven deletion.

**Primary evidence:** `src/main/session/store.ts` asset writing/quota/pruning. Worker report: `05-session-recorder-chronology-scale.md`, finding SR4.

### V-18 — Protocol mismatch is warning-only, leaving a stale manually loaded extension apparently connected

**Status:** source-confirmed.  
**Impact:** partial route/schema incompatibility is presented as intermittent recording/command failure instead of a hard compatibility error.

The bridge warns on extension protocol mismatch but continues serving. A stale unpacked extension can therefore pair and look alive even though its expected routes or payload transitions differ from app protocol 5.

**Fix direction:** allow only a documented compatibility range; return a distinct incompatible status and disable state-mutating routes outside it; surface exact app/extension versions in both popup and diagnostics.

**Primary evidence:** `src/main/bridge.ts` hello/status protocol handling; `extension/background.js`; extension popup. Worker report: `08-whole-app-packaging-breakpoints.md`, finding 5.

### V-19 — Diagnostics can report success for checks that were never actually exercised

**Status:** source-confirmed.  
**Impact:** false confidence during incident diagnosis; clipboard-only configurations can also receive a misleading permission failure.

Several diagnostic results are nullable/unverified, yet the aggregate can render “Every check passed.” Capability logic also conflates desktop-control/screen expectations with clipboard-only configurations.

**Fix direction:** use explicit `pass | fail | skipped | not-run` for each hop; aggregate success only from required executed checks; derive requirements from the same effective capability projection used by MCP surfaces.

**Primary evidence:** `src/main/diagnostics.ts` and renderer diagnostics presentation. Worker report: `08-whole-app-packaging-breakpoints.md`, finding 1.

## Findings intentionally not promoted

- **No claim of a live ChatGPT crash reproduction.** The page CPU/memory paths are verified and synthetic probes demonstrate adverse growth, but a live Chrome performance/heap trace is still required to identify the final browser termination mechanism and threshold.
- **No “extension sends unsolicited prompts” claim.** Current source can open/type only through explicit queued bridge/agent orchestration. An already-open retired worker remaining active is verified; whether ChatGPT itself continues a generation is external page behavior and must be observed separately.
- **Single-instance-lock loss after `app.quit()`** remains risk-only. Source shape is suspicious, but it was not proven that `whenReady()` work executes in the affected Electron state.
- **Missing packaged native/runtime artifacts** was not found in the inspected unpacked build. Packaging coverage gaps remain test strategy, not a current defect.
- **Renderer `openTools` retention** is real state retention but was not shown to be material beside the much larger timeline costs.
- **Multi-file patch atomicity** was not classified as a bug without an explicit product guarantee. Only the verified large-file resource duplication is retained.
- **Previously documented junction/reparse TOCTOU** remains a serious known issue from the 2026-08-20 report, but this hunt did not re-prove it and it is not counted as a new finding.

## Recommended fix order

1. Put hard aggregate budgets and one coalescing scheduler around extension transcript/Fiber work (V-01, V-02).
2. Introduce an end-to-end navigation epoch before touching compaction/commands further (V-03).
3. Bound giant-line reads and make terminal-session capacity preserve process ownership (V-04, V-05).
4. Rebuild shutdown as phased admission/drain/terminate/flush (V-06).
5. Replace whole-map canonical rewrites and virtualize/budget the timeline (V-07, V-08).
6. Make extension journal/close/command delivery timeout-bound and ACK-authoritative (V-09, V-10).
7. Add worker run leases and indexed/singleflight stale detection (V-11, V-12).
8. Define restart recovery for session projections and continuation commits (V-13).
9. Apply whole-call resource budgets to search, enumeration, and patching (V-14, V-15).
10. Then close operational edges: polling/rate fairness, durable asset accounting, protocol compatibility, and truthful diagnostics (V-16-V-19).

## Worker reports retained as evidence

- `01-extension-content-fiber-crash-performance.md`
- `02-extension-background-lifecycle-performance.md`
- `03-bridge-agents-browser-orchestration.md`
- `04-electron-mcp-connection-lifecycle.md`
- `05-session-recorder-chronology-scale.md`
- `06-renderer-preload-ipc-performance.md`
- `07-codex-tools-runtime-performance.md`
- `08-whole-app-packaging-breakpoints.md`

These reports preserve each independent audit trail. This consolidated file is the fixing backlog: it removes duplicates, narrows overclaims, and ranks the findings by verified architectural impact.
