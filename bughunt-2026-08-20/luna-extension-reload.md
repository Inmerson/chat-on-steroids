# Extension reload/navigation/restart recovery audit

Date: 2026-08-20. Scope: read-only source audit of one tab through page reload, SPA A -> B -> A, extension reload/update, service-worker sleep/restart, app restart, tab close, and navigation away from ChatGPT. I read `AGENTS.md` and `bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md`, then inspected the current dirty tree (all pre-existing dirty changes were preserved). No production code, tests, or AppData were changed.

## Lifecycle trace and current protections

* A page reload destroys isolated-world `content.js` state (`conversationId`, `epoch`, `since`, local queues, seen sets) but leaves the tab id and `chrome.storage.session` state. `resumeOpenTurn()` first binds the URL conversation and asks `/activity`; the app reconstructs an active durable turn and returns `activeTurnId`. `seedResumeBaseline()` avoids replaying historical assistant sections. `background.js:122-150,684-733,832-874`; `content.js:596-627,1049-1100`.
* SPA A -> B is treated as a move only when a concrete new id appears. A transient null route is held and flushed, not closed. On concrete B, content sends `closed(A)`, retires visible nodes, increments `epoch`, resets, then records B. Async activity and Fiber replies check id + epoch + current DOM route. `content.js:1049-1100,1801-1810,3415-3428`.
* A -> B -> A is protected against stale async replies by the epoch counter; the existing tests cover id/epoch filtering. It is not protected against the browser-worker terminal release race described below.
* Extension reload/update leaves the ChatGPT document alive but invalidates the old isolated world. `runtime.onInstalled` and module startup query open tabs, ping content, and re-inject `chatgpt-dom.js`, `fiber.js`, `content.js`, and CSS when no current recorder answers. A healthy content ping still re-executes Fiber. `background.js:961-1023`; `content.js:27-34`; `fiber.js:39-47`.
* Service-worker cold wake serializes `load()`, journal writes, and live-tab snapshot writes. The journal survives worker sleep in `storage.session`; tab mappings and settled command ids do too. `background.js:41-53,122-169,180-219`.
* Closing a tab is owned by `tabs.onRemoved`; navigating to a non-ChatGPT URL is owned by `tabs.onUpdated`. Both mark a terminal tombstone, remove provisional entries, remove the tab mapping, drain queued observations, and call `/closed` only for the last live tab. `background.js:669-734,936-956`.
* App restart is partly recovered by `/activity`: if the in-memory conversation map is empty, `restoreRecordedConversation()` finds an existing durable session and rebuilds its active turn/history before returning the feed. `src/main/bridge.ts:700-724`; `src/main/session/recorder.ts:203-299`.

## Ranked findings

### R1 — HIGH integrity/lifecycle race: terminal release is not generation-safe when the tab returns before the async release completes

**Current refs:** `extension/background.js:948-955` starts `void releaseTab(id)` after setting `terminalTabs`; the ChatGPT branch at `951-953` immediately deletes the tombstone. `releaseTab()` awaits `load()` at `708`, then deletes the mapping and eventually posts `/closed` at `718-733`; it never rechecks that the same tab is still on the non-ChatGPT URL or that the terminal event is still the current navigation.

**Adversarial ordering:** tab 12 is in A; `onUpdated(12, https://example.com)` marks terminal and starts `releaseTab(12)`. Before its `load()`/`drain()` finishes, the user navigates back to A (or B), `onUpdated` clears `terminalTabs`, and the new content script binds. The old release resumes, sees the old mapping (or an expected A), deletes it and sends `/closed(A)`. If the new content has not bound yet, the app can close/release a live worker or prime run; if it has bound B, the expected-id mismatch avoids deletion but still sends a spurious `/closed(A)`. A rapid A -> external -> A can therefore produce close/reopen, worker-slot release, or an activity gap despite the tab being live again.

**Observed/expected:** source-only; expected is that terminal cleanup applies only to the URL/document generation that caused it, and a return before cleanup completes cancels the old release. Existing `test/extension.test.ts:921-982` covers ordinary away and delayed stale IPC while still terminal, but not away -> return before release completion.

**Minimal fix:** persist/increment a per-tab navigation generation (or capture the terminal URL/document token) and have `releaseTab(tab, expected, generation)` revalidate it after every await before deleting the mapping or posting `/closed`. A newer `onUpdated` must invalidate the older release. Add an adversarial regression with delayed storage/fetch and a return navigation.

### R2 — HIGH cross-chat integrity: `terminalTabs` is memory-only, so service-worker restart can lose the terminal barrier

**Current refs:** `terminalTabs = new Set()` at `background.js:669-677`; comment explicitly says it is not persisted. `onUpdated` adds it at `948-955`; `events`, `bind`, and `activity` reject only via `terminalSender()` at `832-874`. `tabConversations` is persisted at `142-149,158-169`.

**Adversarial ordering:** tab A navigates away; `onUpdated` marks terminal and starts cleanup, but the worker is stopped/restarted before the old document's final `sendMessage`/`flush` arrives. New worker loads the persisted `tabConversations` mapping but has an empty `terminalTabs`. A delayed content `events`, `bind`, or `activity` from the dying document is accepted, `noteTabConversation()` reasserts the old conversation, and stale activity can be polled or provisional data rebound after the tab is no longer ChatGPT. The same can happen if the old release's `storage.session` write has not completed before worker termination.

**Observed/expected:** source-only; expected is fail-closed after a terminal navigation even across worker restart. Existing `test/extension.test.ts:952-982` proves the same-worker barrier, and `749-785` proves journal survival, but no test recreates the worker after `navigateTab()` and then sends stale IPC.

**Minimal fix:** persist a terminal tombstone with the tab's navigation/document generation in `storage.session`, atomically with `tabConversations`; restore it in `loadOnce()`, and clear it only on a later eligible ChatGPT document generation. Do not rely on tab id alone for eventual reuse.

### R3 — MEDIUM/HIGH restart recovery gap: extension recovery pings content but has no durable per-document identity or handshake

**Current refs:** `restoreOpenChatgptTabs()` uses only tab id and recorder version (`background.js:978-1017`); content's one-instance marker is global to the current isolated world (`content.js:27-34`), while Fiber's marker is a page-global version (`fiber.js:41-47`). The recovery call can race a navigation between `tabs.query`, ping, and three injections (`background.js:985-1017`).

**Adversarial ordering:** service worker wakes during an SPA route transition or extension update. Ping reaches old content just before its document is replaced; recovery injects Fiber/content into the old document, then static injection runs in the new document. Or ping fails after the new document has started but before its static scripts answer, and recovery injects into a transient document. The current catches prevent crashes, but there is no documentId/epoch acknowledgement tying the injection result to the queried page. This can leave a live Fiber helper with no matching content recorder, or a content recorder with `since=0` while a stale recorder's pending `/events` is still in flight.

**Observed/expected:** source-only; expected is a post-injection handshake carrying a document generation and recorder/Fiber versions, with old-document replies ignored. Existing tests at `test/extension.test.ts:620-659` assert injection calls and Fiber revalidation, but not query/injection navigation races or a two-document handshake.

**Minimal fix:** use `tabs`/scripting document identity where available, or have content report a per-document nonce/version to the worker and require an ACK after all injections. On navigation, invalidate the prior nonce before accepting health/flush replies. Keep the current one-instance guards as a duplicate-injection fallback, not the ownership proof.

### R4 — MEDIUM activity recovery cursor can permanently skip a replacement event after app restart plus an in-flight poll

**Current refs:** `content.js:3415-3428` captures id/epoch before `/activity` and only applies replies that remain current; `since` advances from each returned event seq. `bridge.ts:721-724,727-800` reads durable events from the requested cursor and maps superseding `progress/page_tool` events back to an older `origin` seq while `nextSince` advances by raw event seq.

**Adversarial ordering:** content poll P1 starts with `since=N`; app restarts and `/activity` reattaches the durable conversation. Before P1 returns, a navigation/reload starts P2 at `since=0` in a new document. P1 is correctly discarded by epoch, but if an older content instance or a same-epoch retry applies P1 after a durable rewrite has been appended, it can advance `since` past the raw superseding event while rendering only the older `origin`; the next pull no longer contains the replacement. The cursor contract is especially fragile for events whose visible seq is `origin` but whose durable event seq is newer.

**Observed/expected:** source review; no direct failing fixture found. The existing activity tests cover ordinary cursor paging and upsert (`test/bridge.test.ts:434+`) but not app restart + concurrent old/new polls with progress/page-tool supersession.

**Minimal fix:** return an explicit durable `nextSince` and have the page assign it only from a current response; make each superseding event carry both `origin` and a separately monotonic transport cursor, and retain/replay the latest state for every origin until the client has acknowledged the cursor. Add a concurrent restart/reload fixture.

### R5 — MEDIUM tab close/navigation drains can race a new event and leave a stale `/closed` decision

**Current refs:** `releaseTab()` deletes the mapping and then awaits `drain()` before `/closed` (`background.js:718-733`). `events()` can be concurrently in `noteTabConversation()`/`persistJournal()` (`832-844`). The current expected-conversation guard protects some A -> B ordering, but there is no serialized per-tab lifecycle queue.

**Adversarial ordering:** final tab close begins `releaseTab`, sees no other owner, then a delayed content `events` arrives before `/closed` is sent. If the worker was restarted or the terminal barrier was lost (R2), that event recreates ownership; the old release still posts `/closed` and can terminate the just-recreated conversation. Even without restart, close and event handlers are independently scheduled and only partially ordered by storage writes.

**Observed/expected:** source-only; expected is one monotonic tab lifecycle state machine where late events are rejected and a new document must explicitly supersede the close. Existing tests cover final-tab close and same-worker stale message, but not close/event interleaving after release has passed its initial mapping check.

**Minimal fix:** serialize `events`, `bind`, `activity`, `closed`, and `onUpdated/onRemoved` by tab generation, or use compare-and-swap mapping removal plus a final generation check immediately before `/closed`.

## Negative findings / existing fixes

* The page-side epoch checks are correctly present for activity and Fiber replies (`content.js:1801-1810,3415-3428`), including the non-obvious A -> B -> A case.
* Provisional observations are keyed by tab and TTL-limited (`background.js:350-391`), and away/close removes them (`707-717`); the existing abandoned-fresh-chat test covers tab-id reuse inside one worker.
* Journal and live-tab storage snapshots are serialized (`background.js:152-219`), with tests for cold-worker concurrent load and older slow writes (`test/extension.test.ts:787-852`).
* Duplicate recorder injection is guarded in isolated content and MAIN-world Fiber (`content.js:27-34`, `fiber.js:39-47`). This prevents ordinary duplicate listeners, but does not solve the lifecycle-generation gaps above.
* `/activity` does attempt durable app-restart reattachment (`bridge.ts:708-724`), and page reload adopts durable active turns before normal observation (`content.js:596-610`).
* The targeted extension test command was attempted but could not start in this managed workspace: esbuild reported `Cannot read directory "..": Access is denied` while resolving `vitest.config.ts`. No test result is claimed from that invocation.

## Recommended priority

1. R1 and R2: make terminal cleanup generation-aware and durable; these can misclose or rebind a live chat across navigation/restart.
2. R5: serialize tab lifecycle transitions around `/closed`.
3. R3: add document-level recovery handshake for extension reload/update.
4. R4: strengthen `/activity` cursor/supersession contract and add restart concurrency coverage.

