# Extension / transcript adversarial bug hunt — 2026-08-20

Scope: CURRENT connector app in `C:\Users\totec\chatgpt-local-files`; audit-only unless a production change is strictly necessary to prove a bug.

## Tool-call error log

- 11:49 local — `exec_command` PowerShell parse failure while creating this report. Classification: **my misuse**. Cause: invalid here-string syntax in the command; no repository/report command body executed.
- 11:51 local — `api_tool.list_resources(paths=[ChatGPT_Local_Files_Core], query=writeDurableSoon)` returned no matching tool resource. Classification: **my misuse / expected discovery behavior**. I used tool-schema discovery to search a repository symbol; switched to repo `rg` immediately.
- 11:51 local — report append rendered Markdown backticks as PowerShell escape sequences, corrupting three audit-log lines. Classification: **my misuse**. No repo/source file was affected; this report was immediately rewritten cleanly.

## Findings

### HIGH/MEDIUM — stale nonempty correlation index suppresses durable-history reconciliation

- **Refs:** `src/main/session/correlation.ts:83-85, 143-164, 168-183`; `src/main/durable.ts:20, 73-84`; tests `test/correlation.test.ts:104-180`.
- **Observed/code path:** restore accepts any valid saved correlation entry, sets `loaded=true`, then returns at line 164. It rebuilds from durable tool-call history only when the saved index contributes zero valid entries.
- **Why stale is possible:** correlation persistence uses `writeDurableSoon`, a 300 ms debounced whole-snapshot write. A crash/power loss/write failure after session JSONL has durably recorded a newer request-id-attributed tool call but before the correlation snapshot lands leaves an older, valid, nonempty index.
- **Expected:** restart should recover every exact owner still proven by durable request-id-attributed history, or otherwise version/sequence-check the snapshot against history.
- **Impact:** a missing request id remains unknown after restart and later calls for that workflow can be filed to Unattributed despite exact durable proof.
- **Missing test:** stale **partial** saved index + newer attributed session event. Existing coverage tests only a fully flushed saved index or no index at all.

## Chronological audit log

- Started audit; captured initial dirty tree/status. Did not modify production code.
- Baseline `npx vitest run test/extension.test.ts test/content-script.test.ts --reporter=dot`: **210 passed, 34 skipped**. jsdom printed two expected `HTMLFormElement.requestSubmit()` not-implemented warnings; no test failures.
- Messaged prime early with stale-partial correlation restore finding and exact refs.

### Reproduction confirmation — stale partial correlation index

- **Repro artifact:** `bughunt-2026-08-20/repro-correlation-stale.test.ts` (audit-only file outside the production/test tree).
- First invocation against that path exited 1 with `No test files found` because Vitest includes only `test/**/*.test.ts`. Classification: **my misuse**; no connector inference drawn.
- I copied the same repro temporarily to `test/bughunt-correlation-stale.test.ts`, ran only that test, then deleted the temporary copy in the same command.
- **Observed:** test failed at the desired invariant: `requestCorrelation('wfr_new')?.conversationId` was `undefined` after restart even though the newer `request_id`-attributed `tool_call` was already durable in session history. `wfr_old` from the stale saved index restored successfully.
- The test command exited 1 because the asserted correct behavior failed. Classification: **connector bug reproduction**, not tool misuse.

## Chronological audit log (continued)

- 11:52 local — targeted correlation repro outside `test/` was rejected by Vitest include rules. **My misuse**.
- 11:52 local — temporary in-tree repro failed exactly on missing `wfr_new` ownership after stale nonempty snapshot restore. **Connector bug reproduced**. Temporary tracked-tree test copy removed immediately; audit repro retained under `bughunt-2026-08-20/`.
- Prime supplied a live page symptom: desktop session/tool counts advance while ChatGPT Overwrite is enabled/connected but current tool activity is absent/stale. Prioritized `/activity` delivery versus page replacement completeness as separate failure domains.

### HIGH — Overwrite grace hides newly started live tool calls behind a stale replacement

- **Refs:** `extension/content.js:50-52, 3019-3052, 3216-3330` (especially `3284-3295`); `src/main/mcp/kernel.ts:382-430`; current test `test/content-script.test.ts:2588-2636`.
- **Live symptom from prime/user:** desktop session/tool count advances while ChatGPT page is connected with Overwrite enabled, yet current tool activity is missing/stale.
- **Root cause:** a new connector request appears in Fiber before the MCP handler has returned. `completeReplacementForTurn()` correctly sees its request id is absent from the local stream and marks reconstruction incomplete. But the new 8-second `REPLACEMENT_GRACE_MS` branch keeps the previous `.clf-stream` mounted anyway, so wholesale native hiding remains active and the newly visible native tool row is suppressed. `kernel.ts` guarantees this lag for honest in-flight calls because `trackInFlight(...run...)` is awaited before `recordToolCall()` is created/appended.
- **Reproduction:** established a complete replacement with call 1; then added Fiber/native call 2 while leaving the app stream at call 1. Desired invariant was to relinquish whole-turn hiding when incompleteness is a proven new live request. Current code kept `data-clf-turn-replaced="1"`; targeted test failed `expected '1' to be null`.
- **Observed vs expected:** observed stale local call 1 remains visible while current call 2 is hidden. Expected either update local stream once call 2 exists or immediately fall back to native for a *new exact request*, preserving grace only for genuinely transient feed/Fiber disagreement.
- **Missing/false-confidence test:** current sticky test `2588-2636` covers an incomplete second assistant message and explicitly expects stale replacement to remain; no test distinguishes a newly exposed exact connector request from a transient missing scan. That test can therefore green-light the live failure.

### HIGH/MEDIUM — terminal navigation can lose to a delayed old-document message and resurrect tab ownership

- **Refs:** `extension/background.js:671-680, 693-712, 811-855, 923-926`; sequential test `test/extension.test.ts:919-947`.
- **Reproduction:** preloaded `tabConversations[12]=A`, delayed cold-worker `storage.session.get`, fired external `tabs.onUpdated` cleanup first, then delivered an old document `activity(A)` before shared `load()` resolved.
- **Observed:** `closed=[]` and final persisted `tabConversations={"12":A}`. The delayed content handler reasserted A; `releaseTab()` then saw `conversationStillOpen(A)` and refused `/closed`.
- **Expected:** concrete navigation away from ChatGPT is terminal for that tab. An already-sent message from the dying old document must not recreate ownership after the browser-level terminal event.
- **Likely root cause:** no per-tab document/navigation generation or tombstone. `noteTabConversation()` accepts any sender carrying the tab id and a valid conversation id, while release and note are independent async operations around one shared global map.
- **Impact:** zombie browser ownership and app-side conversation/run lifetime after the tab no longer hosts ChatGPT; open turn/run cleanup can remain stuck until another lifecycle event happens.
- **Missing test:** existing external-navigation test performs `/events` completely, then navigation sequentially. It never races navigation against a cold-worker content request.

## Chronological audit log (continued)

- 11:55 local — targeted Overwrite repro failed on stale `data-clf-turn-replaced="1"` after Fiber exposed a new in-flight connector request. **Connector bug reproduced**. Temporary copied test removed; audit repro retained under `bughunt-2026-08-20/`.
- 11:56 local — first navigation-race repro failed because `/closed` never occurred. **Connector bug reproduced**.
- 11:57 local — repeated navigation race with state logging: `closed=[]`, `tabConversations={12:A}`. **Connector bug reproduced**; temporary copied test removed.
- Messaged prime with both the live Overwrite root cause and the terminal-navigation resurrection race.

### HIGH — `/activity` forgets a still-open browser chat after app restart while durable MCP calls keep advancing

- **Refs:** `src/main/bridge.ts:699-710, 711-865`; `src/main/session/recorder.ts:927-940, 1103-1123`; startup search found request-correlation restore but no live recorder-conversation restore. Existing activity tests: `test/bridge.test.ts:436-608`.
- **Reproduction:** over the real loopback bridge, POSTed a `turn_start` for conversation A, then reset recorder memory to simulate an app-process restart while the browser document stayed open. Next, recorded an exact request-id MCP call for A. `targetSession()` found A's existing durable session and the durable JSONL contained the new tool call. A subsequent `GET /activity?conversationId=A&since=0` returned `sessionId:null` and `stream:[]`.
- **Observed vs expected:** the desktop/durable session continues accumulating exact tool calls, while the still-open ChatGPT page receives an empty activity feed forever until some other observation recreates recorder live state. A page polling `/activity` is itself current liveness evidence and should recover its durable session/feed.
- **Likely root cause:** `/activity` is gated entirely on the in-memory `liveConversations()` map. The route's own comment calls those polls the app's “primary first-hand evidence” that chats exist, but a miss immediately returns an empty answer instead of looking up/reopening the durable conversation session.
- **Impact:** direct explanation for a live state where the desktop transcript/tool count advances while Overwrite remains stale/empty after an app restart. It also loses `activeTurnId`, generation state, job/compaction presentation until the recorder is recreated.
- **Missing test:** all current `/activity` tests query while recorder memory is intact. None restarts recorder/app memory while leaving the browser chat open and then appending an exact MCP call.

### HIGH — provisional pre-`/c/<id>` observations can be permanently filed into an unrelated later chat on the same tab

- **Refs:** `extension/background.js:347-388, 648-680, 811-840, 923-926`; the provisional TTL is 10 minutes at `374`.
- **Reproduction:** fresh chat A emitted an opening user observation before ChatGPT assigned any conversation id, so the worker journalled it provisionally under `tab-12`. The tab then navigated to a non-ChatGPT URL before A got an id. Later, the same tab opened unrelated fresh chat B within the 10-minute TTL and sent `bind(B)`.
- **Observed:** background POSTed A's old text to `/events` with `conversationId=B`.
- **Expected:** a terminal navigation must invalidate the provisional generation belonging to the abandoned document/chat. Reload continuity should survive, but unrelated later navigation on the same tab must not inherit old provisional observations.
- **Likely root cause:** provisional identity is only the tab id. `releaseTab()` clears known `tabConversations` ownership but does not purge or generation-stamp provisional journal entries, and `bindProvisional()` later binds every recent matching tab key.
- **Impact:** permanent cross-chat transcript misattribution of the opening message/evidence. This is worse than loss because the resulting history looks valid under the wrong conversation.
- **False-confidence test:** identified A→B navigation is covered, but the no-conversation-id provisional window is not.

### HIGH — tab removal and external navigation can be defeated by a delayed message from the dying document, resurrecting zombie ownership

- **Refs:** `extension/background.js:671-680, 693-712, 811-855, 914-916, 923-926`; `extension/content.js:4663-4674`; sequential lifecycle tests around `test/extension.test.ts:919-947`.
- **Reproduction, onUpdated:** with persisted `tabConversations[12]=A`, delayed the cold worker's `storage.session.get`, started external navigation cleanup, then delivered an already-sent old-document `activity(A)` before the shared load resolved. Final state was `closed=[]`, `tabConversations={12:A}`.
- **Reproduction, onRemoved:** same setup, but started `chrome.tabs.onRemoved`/`closeTab(12)` first. The dying content message raced the same cold load. Final state again was `closed=[]`, `tabConversations={12:A}`.
- **Observed vs expected:** a concrete browser-level terminal event lost to stale IPC and `/closed` was never sent. Expected tab removal/external navigation to dominate all messages from the prior document generation.
- **Likely root cause:** `noteTabConversation()` accepts any message carrying a valid tab id + conversation id. There is no per-tab navigation/document epoch or terminal tombstone. `releaseTab()` deletes the mapping, persists, then asks `conversationStillOpen()`, allowing a stale handler to re-add the exact mapping before that check.
- **Why pagehide cannot save it:** `content.js:4663-4674` intentionally only flushes on `pagehide`; it never closes because reload and bfcache make document unload ambiguous. That makes background tab lifecycle the sole close authority, so this race can leave no later event guaranteed to clean up the zombie.
- **Impact:** zombie conversation, open-turn state and potentially agent/run lifetime after the tab is actually gone.
- **Missing test:** existing close/navigation tests are sequential; none overlaps a cold-worker terminal browser event with an already-sent content request.

### HIGH/MEDIUM — at-least-once browser journal replay duplicates append-only turn lifecycle

- **Refs:** `extension/background.js:391-435, 510-550`; `src/main/bridge.ts:610-670`; `src/main/session/recorder.ts:1360-1403`; renderer grouping `extension/content.js:2709-2755`.
- **Protocol shape:** the worker deliberately retains a journal batch until `/events` returns HTTP 200. If the app commits the batch but the response is lost, fetch fails, or the service worker dies before observing the response, the unchanged batch is retried. The request carries no delivery/batch/event identity.
- **Reproduction:** passed the identical named `turn_start` + matching `turn_end` observation batch to `recordChatObservations()` twice, modeling a committed replay. Durable read contained two starts and two ends for the same local turn id.
- **Observed:** canonical user/assistant messages dedupe, but lifecycle does not. `streamTurnGroups()` creates a fresh group for every repeated `turn_start` even when the durable id is the same, so the duplicate is presentation-visible rather than harmless log noise.
- **Expected:** the at-least-once transport must be idempotent at the app boundary, either by journal event ids/batch acknowledgement identity or deterministic lifecycle dedupe.
- **Missing/false-confidence tests:** message replay tests exercise canonical message identities and pass; none simulates an `/events` response-loss replay containing lifecycle boundaries.

### HIGH/MEDIUM — content-script queue silently discards observations before they ever reach the durable worker journal

- **Refs:** `extension/content.js:420-430, 444-451, 466-487`; background journal's contrasting explicit loss marker at `extension/background.js:330-345`; existing transient receiver test `test/content-script.test.ts:5461-5476`.
- **Reproduction:** emitted 401 unique observations into the content-script queue and then flushed. Worker-bound batches contained exactly 400 observations, from `queued-1` through `queued-400`; `queued-0` was silently gone.
- **Observed vs expected:** `emit()` caps the volatile queue with `splice()` and emits no explicit gap. Expected either no discard before worker acknowledgement, or at minimum the same explicit durable “history incomplete” marker the background journal writes when it must evict.
- **Impact:** during an extension service-worker startup/update outage, a chatty live Fiber transcript can silently lose the oldest message/evidence/lifecycle observations before durable journaling. Later transcript may look complete while missing a section.
- **False confidence:** the receiver-loss regression sends one observation, so it proves retryability but not bounded-queue loss behavior.

### MEDIUM/HIGH — exact-conversation tool recording bypasses call-order serialization and quit flushing

- **Refs:** `src/main/session/recorder.ts:901-925, 927-940, 945-977, 979-1049`; per-session append serialization `src/main/session/store.ts:553-582`.
- **Reproduction:** launched exact call 1 first with a 6 MiB image result, then exact call 2 with a tiny text result in the same conversation. The first call did more asynchronous result/asset work before reaching `appendEvent()`. Durable request-id order became `[wfr-exact-second, wfr-exact-first]`.
- **Observed vs expected:** recorder comments explicitly promise writes are serialized “in call order,” but only the unidentified/deferred branch uses `recordChain`. Exact `input.conversationId` returns `fileToolCall()` directly. The store serializes whichever call reaches `appendEvent()` first, not invocation order.
- **Impact:** concurrent exact tool results can transiently or durably reorder. Turn-local chronology can repair some completed groups by timestamp, but calls with a lost/no turn id cannot be repaired and incremental `/activity` can expose the later call first. `flushRecorder()` only awaits `recordChain`, so exact-path writes are also outside the stated quit flush barrier.
- **Missing test:** no concurrent exact-conversation call with asymmetric pre-append work; existing concurrency tests focus attribution correctness, not durable call order/flush coverage.

## Additional test-suite false-confidence / coverage notes

- `test/content-script.test.ts` currently has multiple intentionally skipped lifecycle/renderer tests. Most are explicitly legacy, but some non-legacy current-behavior cases are skipped, including superseded-caption reorder (`3352`), generation binding/order cases (`3533`, `3605`), extension-owned stream feedback (`3669`), several live prose rewrite cases (`3720-3887`), unexplained Stop dropout (`4035`), resumed work after Stop returns (`4100`), and final-answer settle identity (`4882`). A green suite therefore does not mean all current turn-lifecycle behavior is exercised.
- `test/session.test.ts:894` skips the old heuristic suite as a block. That is intentional architectural cleanup, but it means useful behavior names in that block are not evidence for current code unless covered again under the canonical suite.

## Chronological audit log (continued)

- 11:58 local — a repo search command used positional wildcard paths (`test/bridge*.test.ts`, `test/*.test.ts`) that Windows passed as invalid filenames; ripgrep emitted OS error 123 for those two paths while still returning the explicit session-file matches. Classification: **my misuse**. Switched to directory-wide searches without positional globs.
- 11:58 local — lifecycle replay targeted test intentionally failed the desired idempotency invariant. Observed duplicate `turn_start, turn_start, turn_end, turn_end`. Classification: **connector bug reproduction**.
- 11:59 local — content volatile-queue targeted test intentionally failed: 401 emitted, 400 delivered, oldest silently absent. Classification: **connector bug reproduction**. The tool clipped the verbose Vitest output after reporting the decisive failure; output clipping itself is **expected tool behavior**, not a connector finding.
- 12:00 local — provisional fresh-chat identity repro intentionally failed: abandoned chat A's text was delivered under later chat B. Classification: **connector bug reproduction**.
- 12:01 local — real-HTTP bridge restart repro intentionally failed: durable exact tool call existed, but `/activity` returned `sessionId:null, stream:[]`. Classification: **connector bug reproduction**.
- 12:03 local — exact-conversation concurrent call-order repro intentionally failed: second invocation was durably sequenced before first. Classification: **connector bug reproduction**.
- 12:05 local — explicit `onRemoved` race repro intentionally failed: removed tab was re-added by stale content IPC and `/closed` was skipped. Classification: **connector bug reproduction**.

## Tool-call error log — continuation

- 11:52 local — direct Vitest run of `bughunt-2026-08-20/repro-correlation-stale.test.ts` returned “No test files found” because Vitest only includes `test/**/*.test.ts`. Classification: **my misuse**. The same audit-only test was copied temporarily into `test/`, run, and removed.
- 11:52 local — the temporary correlation repro test exited 1 because the asserted correct behavior failed (`wfr_new` ownership missing after stale partial index restore). Classification: **connector bug reproduction**.
- 11:55 local — Overwrite live-call repro exited 1 because stale replacement remained mounted. Classification: **connector bug reproduction**.
- 11:56 and 11:57 local — onUpdated/navigation-race repros exited 1 because `/closed` was skipped and stale tab ownership survived. Classification: **connector bug reproduction**.
- 11:58 local — ripgrep was invoked with Windows-incompatible positional wildcard paths and emitted OS error 123 for those path arguments. Classification: **my misuse**.
- 11:58 local — lifecycle replay repro exited 1 because duplicate start/end records were appended. Classification: **connector bug reproduction**.
- 11:59 local — content volatile-queue repro exited 1 because one of 401 observations vanished silently. Classification: **connector bug reproduction**. The connector tool clipped the verbose test output after the decisive failure; clipping was **expected tool behavior**, not a repo bug.
- 12:00 local — provisional identity repro exited 1 because chat A's provisional text was delivered under chat B. Classification: **connector bug reproduction**.
- 12:01 local — app-restart `/activity` repro exited 1 because durable chat activity existed but route returned `sessionId:null, stream:[]`. Classification: **connector bug reproduction**.
- 12:03 local — exact-call ordering repro exited 1 because durable order was second then first. Classification: **connector bug reproduction**.
- 12:05 local — onRemoved race repro exited 1 because stale content IPC resurrected the removed tab's ownership and `/closed` never fired. Classification: **connector bug reproduction**.
- 12:07 local — final relevant-suite run succeeded; the same two jsdom `HTMLFormElement.requestSubmit()` warnings appeared. Classification: **expected test-environment behavior**.

## Severity-ranked summary

1. **HIGH — `/activity` restart split-brain:** a still-open page can get an empty feed after app restart while exact MCP calls continue accumulating durably in the desktop session. This is the strongest direct match for the reported “desktop advances, Overwrite page stale” symptom.
2. **HIGH — provisional cross-chat misattribution:** an abandoned fresh chat's pre-id observations can be rebound into an unrelated later chat that reuses the same tab within ten minutes.
3. **HIGH — terminal browser lifecycle resurrection:** both `tabs.onUpdated` external navigation and `tabs.onRemoved` can lose to already-sent stale content IPC on a cold service worker, leaving zombie tab/conversation ownership and skipping `/closed`.
4. **HIGH — stale Overwrite hides current live call:** the 8-second sticky replacement grace suppresses ChatGPT's new native tool row while the app stream is necessarily behind an in-flight MCP handler.
5. **HIGH/MEDIUM — at-least-once lifecycle replay is not idempotent:** a committed `/events` batch replay duplicates durable turn starts/ends and can create duplicate renderer groups.
6. **HIGH/MEDIUM — stale partial correlation snapshot:** any nonempty saved correlation index prevents durable-history reconciliation, so newer exact request ownership can disappear across restart despite durable proof.
7. **HIGH/MEDIUM — volatile content queue silently loses oldest observations:** item 401 evicts item 1 before the worker journal with no explicit gap marker.
8. **MEDIUM/HIGH — exact call recording can reorder and evade quit flush:** the exact-conversation fast path bypasses the recorder chain promised to preserve call order and used by `flushRecorder()`.

## Final verification

- No production-code fixes were made.
- Every temporary `test/bughunt-*.test.ts` copy was removed after its one targeted run.
- The oversized copied content-script repro was removed; the compact correlation repro remains under the audit output directory as evidence.
- Final relevant suites: `test/extension.test.ts`, `test/content-script.test.ts`, `test/session.test.ts`, `test/bridge.test.ts`, `test/correlation.test.ts` => **5 files passed, 355 tests passed, 82 skipped**. The two jsdom requestSubmit warnings are expected and pre-existing.

## Unresolved gaps / next attack surfaces

- I reproduced the browser lifecycle races in the service-worker harness with cold-storage timing, but did not drive an actual installed Chrome extension through process suspension plus a real `onRemoved`/stale-message interleave. The code ordering and deterministic harness result are sufficient to establish the race; a browser integration test would measure frequency.
- The `/events` duplicate-lifecycle reproduction models the unavoidable response-lost-after-commit ambiguity directly at the recorder boundary. A true loopback socket-abort-after-server-commit test would exercise the full transport path and should be added when designing the fix.
- The app-restart `/activity` repro uses `resetRecorderForTests()` to model process-memory loss while retaining disk state. A hard Electron restart with an already-open ChatGPT tab would validate the exact user-visible recovery sequence end-to-end.
- The provisional-key design also deserves a same-tab **fresh A → fresh B without leaving chatgpt.com** integration case. The external-navigation repro already proves the identity flaw, but ChatGPT SPA behavior may expose an even more common path before either fresh chat receives a concrete id.
- Multi-tab ownership deserves an adversarial matrix: same conversation open in two tabs, one terminally closes while stale IPC from that tab races a valid poll from the survivor. `conversationStillOpen()` is global and currently has no document generation, so race outcomes should be pinned explicitly.
- Current non-legacy skipped content-script tests should either be re-enabled or replaced by canonical equivalents before treating green CI as strong evidence for turn lifecycle/presentation correctness.

## Prime notifications

Prime was notified early and repeatedly as material findings landed, with exact code/test refs and reproduction outcomes for: stale correlation restore; stale Overwrite live-call hiding; onUpdated/onRemoved zombie resurrection; non-idempotent lifecycle replay; pre-journal queue loss; provisional cross-chat misbind; restart-empty `/activity`; and exact-call reorder/flush bypass.
