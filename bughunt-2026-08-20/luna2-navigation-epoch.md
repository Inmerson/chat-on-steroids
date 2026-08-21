# Navigation/document ownership review — durable epoch proposal

**Review date:** 2026-08-20 (Europe/Berlin)  
**Repository:** `C:\Users\totec\chatgpt-local-files`  
**Scope:** extension tab/document ownership across reload, SPA navigation, external navigation, tab reuse, service-worker restart, delayed old-document IPC, `terminalTabs`/`releaseTab`, and `chrome.storage.session`.  
**Mode:** read-only adversarial review. I read the repository instructions, the consolidated bughunt, the extension sources/tests, and the Chrome API references. I did not edit production code, tests, AppData, config, or git state, and did not spawn agents. The only file written by this review is this report.

## Executive finding

The current tree has two useful but different protections:

1. `extension/content.js:97-115` has a page-local `epoch`, and asynchronous page work checks both epoch and conversation id (`content.js:1790-1809`, `3415-3421`). This protects a single content-script instance from applying an old `/activity` or Fiber reply after an SPA move, including A -> B -> A.
2. `extension/background.js:669-695,831-874,936-956` has an in-memory `terminalTabs` tombstone. This protects a message already racing a terminal browser event while the same worker remains alive. The current sequential/cold-load regression at `test/extension.test.ts:952-982` exercises that narrow case.

Neither is a durable tab/document ownership protocol. The background map is still `tab id -> conversation id` (`background.js:98-109,142-149`), and runtime messages carry no document id, page nonce, or navigation epoch (`content.js:419-435,506-523,547-551`; `background.js:832-844,854-874`). A tab id survives reload and can outlive a document; it does not identify the document. The service worker can therefore accept a delayed message from document D1 after D1 has been replaced by D2, especially after `terminalTabs` is cleared for a returning ChatGPT URL or after the worker restarts.

The minimal durable fix is a per-tab lease keyed by Chrome's browser-supplied `MessageSender.documentId`, augmented by a content-script page nonce and SPA epoch. The sender document id must be authoritative; a document id supplied only in the message body is not authority. The current manifest requires Chrome 116 (`extension/manifest.json:5`), while Chrome documents `MessageSender.documentId`, `documentLifecycle`, and `frameId` as available from Chrome 106 onward ([runtime `MessageSender` reference](https://developer.chrome.com/docs/extensions/reference/api/runtime)). `chrome.storage.session` is an appropriate lifetime for this browser-tab state, but it is in-memory and is cleared when the extension/browser is restarted or reloaded ([storage reference](https://developer.chrome.com/docs/extensions/reference/api/storage/)); the protocol must fail closed when that durable session state is unavailable rather than infer ownership from a reused numeric tab id.

## Current ownership model and exact gaps

### Background state is tab-scoped, not document-scoped

`tabConversations` is loaded from `chrome.storage.session` and persisted as a whole object (`extension/background.js:98-109,135-170`). Its key is `String(sender.tab.id)` (`background.js:660-667,690-694`). The comments correctly say that a tab survives reload, but the same fact creates the trust gap: D1 and D2 have the same tab id, and the map cannot tell them apart.

`terminalTabs` is only a worker-memory `Set<number>` (`background.js:669-677`). The comment at `background.js:669-672` says a restart has no old document left to race. That is not sufficient for queued `runtime.sendMessage` delivery or an interrupted `releaseTab()`/storage write: a new worker can load the old tab map without the old worker's tombstone, and a delayed D1 message can then recreate it.

`onUpdated` adds a terminal tombstone for a non-ChatGPT URL, but deletes it for *any* ChatGPT URL (`background.js:943-956`). Returning to ChatGPT therefore clears the only guard before the new document has registered. A delayed D1 message is indistinguishable from D2 at the handler boundary.

### `releaseTab()` is conversation-conditional, not lease-conditional

`releaseTab(tab, expected)` loads asynchronously, filters provisional entries by the tab-only key, reads the current mapping, deletes it, checks `conversationStillOpen()`, drains, and posts `/closed` (`background.js:707-733`). `expected` is only a conversation id. It cannot distinguish:

- D1 closing conversation A after D2 reloaded the same tab into A;
- an old A close arriving after the tab moved to B;
- an old close and a new same-conversation lease interleaving across two tabs.

The delayed handler and `releaseTab()` also mutate the shared map in separate async operations. `persistLive()` serializes storage writes (`background.js:156-170`) but does not serialize the compare-and-mutate decision itself. A write queue is not a per-tab compare-and-swap.

### The page epoch is not crossing the trust boundary

The page correctly increments `epoch` when it sees a concrete replacement id (`content.js:1049-1074`) and checks it around asynchronous Fiber/activity work (`content.js:1798-1809,3415-3421`). But `ask()` forwards the caller's object unchanged (`content.js:419-435`), and `flush()` sends the current outer `conversationId` plus entries that contain no page/document owner (`content.js:506-523`). `bindConversation()` likewise sends only the conversation (`content.js:540-551`). The background consequently cannot reject an old A epoch after the page has reached B, or an old B epoch after it has returned to A.

`RUN_ID` is already a random per-document namespace (`content.js:248-278`) and is used for command ownership (`content.js:4650-4655`), but it is not attached to ordinary events, activity polls, bind, close, compact, or auto-compact messages.

### Provisional entries are still keyed only by tab id

The worker stores no-id observations under `tab-<id>` (`background.js:350-360,832-841`). `bindProvisional()` binds every recent matching tab key (`background.js:365-391`); the TTL is ten minutes (`background.js:377`). Current `releaseTab()` now removes that key (`background.js:711-717`), which fixes a clean terminal event, but a delayed D1 message after the tombstone is cleared can create the same provisional key again. D2 then binds D1's text together with its own opening observation.

### Not every mutating handler checks the terminal state

`events`, `bind`, and `activity` check `terminalSender()` (`background.js:832-874`). `compact` and `auto_compact_claim` only call `noteTabConversation()` and ignore its boolean result (`background.js:880-906`); they then call the app. A delayed old-document compaction request can therefore still mutate app state after terminal navigation. `closed` delegates directly to `releaseTab()` (`background.js:875-878`) and has no document/epoch check. `repair_fiber` checks the current tab tombstone but still trusts the numeric tab id (`background.js:876-887`), so a stale request after a return can target the new document.

`redeem`/`ack` are also invoked without the `sender` argument (`background.js:908-920`). Their command id/client protocol gives useful idempotency, but a rolling ownership protocol should either carry the same source envelope or explicitly document why command delivery is exempt. In particular, a stale page must not acknowledge a command after a new page has claimed the same marker merely because the model-facing command id remains valid.

## Concrete race schedules

The schedules use `T12` for a browser tab, D1/D2 for distinct Chrome documents, and A/B for conversation ids. A message shown as “sent” has already left the content script; its arrival at the service worker is delayed.

### R1 — external navigation, return to ChatGPT, delayed old IPC

| Step | State/action |
|---|---|
| 1 | D1 in T12 is `/c/A`; `tabConversations[12] = A`. D1 sends `activity(A)` or an `events` batch, but delivery is delayed. |
| 2 | T12 navigates to `https://example.com`. `onUpdated` adds `12` to `terminalTabs` and starts `releaseTab(12)`; the mapping/provisional entries may be removed. |
| 3 | T12 returns to `https://chatgpt.com/` or `/c/B`. `onUpdated` deletes `terminalTabs[12]` before D2's first extension handshake. |
| 4 | Delayed D1 message arrives. It has the same `sender.tab.id=12`; current handlers have no sender document identity. `noteTabConversation()` can re-add A, or a no-id batch can recreate `tab-12`. |
| 5 | D2 later binds B. Depending on ordering, A can be reopened/closed late, A's provisional text can bind to B, or B can be overwritten by a late A poll. |

**Required result:** D1 is rejected after the terminal transition. D2 is admitted only through an explicit new-document registration; no D1 provisional entry can be rebound to B.

### R2 — service-worker restart removes the only tombstone

| Step | State/action |
|---|---|
| 1 | D1/T12 owns A. `onUpdated` or `onRemoved` runs, but `releaseTab()` has not completed its `storage.session.set`/`/closed` sequence. |
| 2 | The service worker is stopped and restarted. `terminalTabs` is empty; `loadOnce()` restores only `tabConversations`, `journal`, and `settled` (`background.js:135-149`). |
| 3 | A delayed D1 message wakes the new worker. No document id or epoch is available to distinguish it from a current page. |
| 4 | The stale message is accepted, possibly before or after a D2 message. |

**Required result:** the lease/tombstone survives a worker restart through `storage.session`. If the state was not durably committed, the safe fallback is to refuse source-less/uncertain mutations until a fresh document registers, not to accept the numeric tab id.

### R3 — same-document SPA A -> B -> A with delayed epochs

| Step | State/action |
|---|---|
| 1 | One document D1 observes A at page epoch 0. An A activity poll and an A flush are in flight. |
| 2 | ChatGPT moves to B. `content.js` increments its local epoch and resets state, but neither epoch nor page nonce crosses `ask()`; background still sees only T12 and conversation strings. |
| 3 | B is observed and then the user returns to A. The page epoch increments again. |
| 4 | Delayed epoch-0 A activity/flush, then delayed B activity/close, arrive after the current page is A again. Every message still has `sender.tab.id=12`; the old conversation field looks plausible. |

**Required result:** only `(D1, currentEpoch)` is allowed to mutate the current lease. Lower epochs are stale even when the conversation id equals A again. The page's existing async guards are necessary but do not replace this background check.

### R4 — reload D1 -> D2 in the same conversation, stale close

| Step | State/action |
|---|---|
| 1 | D1/T12 owns A. A reload starts; D1 has a delayed `closed(A)` or an old poll response. |
| 2 | D2 starts in `/c/A`, sees the existing durable conversation, and binds A. Current tab state still contains only `12 -> A`; there is no way to know D2 replaced D1. |
| 3 | Delayed D1 `closed(A)` reaches `releaseTab(12,A)`. It matches the same conversation and can delete D2's mapping and post `/closed` while D2 is alive. |

**Required result:** a close is conditional on the exact D1 lease. A close from D1 cannot release D2, even though both documents name A. A reload registration may transfer the A lease to D2 without closing the session.

### R5 — fresh A provisional text is rebound to unrelated B

| Step | State/action |
|---|---|
| 1 | D1/T12 is a fresh composer. It emits a user message before ChatGPT assigns an id; the worker stores `provisional: tab-12`. |
| 2 | T12 leaves ChatGPT before the id appears. `releaseTab()` may remove the current provisional rows, but an already-sent D1 message can arrive after terminal handling. |
| 3 | T12 returns as fresh D2 within ten minutes. The tombstone is cleared by `onUpdated`; D1's delayed no-id event recreates `tab-12`. |
| 4 | D2 binds B. `bindProvisional('tab-12', B)` binds D1's text to B. |

**Required result:** provisional ownership is `(tab,document,epoch)`, not tab only. Terminal navigation retires D1's bucket permanently; D2 starts a new bucket. If preserving a reload-before-id opening message is required, that transfer needs an explicit same-tab reload handoff, not a TTL guess.

### R6 — asynchronous release and a new lease interleave

| Step | State/action |
|---|---|
| 1 | `releaseTab(12,A)` passes `await load()` and is about to delete the map. |
| 2 | D2 registers or sends `activity(B)` and calls `noteTabConversation()`. |
| 3 | The old release resumes, deletes or checks `conversationStillOpen()` based on a state that is no longer its own. It may issue `/closed(A)` after D2 is current, or a stale old handler may overwrite D2. |

**Required result:** every tab transition is a serialized compare-and-swap over a lease id. Storage-write serialization alone is insufficient.

### R7 — old compact request mutates after terminal navigation

| Step | State/action |
|---|---|
| 1 | D1 starts `compact(A)`; its message is delayed. |
| 2 | T12 navigates external; terminal handling retires A. |
| 3 | D1 compact arrives. `noteTabConversation()` returns false because of `terminalTabs`, but `compact` ignores the result and still calls `/compact` (`background.js:880-898`). |

**Required result:** all identity-sensitive handlers reject the source before any app call. A stale read may be dropped; a stale mutation must never proceed.

## Minimal durable protocol proposal

This is intentionally a small extension of the current bridge shape. It does not need `webNavigation` permission, a new server, or a model-visible field.

### 1. Persist a lease, not a bare conversation map

Add a versioned `tabLeasesV2` object to `chrome.storage.session`. One active record per tab is enough for the first implementation; keep a bounded retired-document list so a late old registration cannot become current again:

```text
tabLeasesV2[tabId] = {
  leaseId: random opaque id,
  documentId: sender.documentId,       # browser-supplied authority
  pageNonce: content-generated nonce,   # consistency check, not authority
  navEpoch: non-negative integer,       # same-document SPA generation
  conversationId: string|null,
  phase: "active" | "terminal" | "awaiting-document",
  retiredDocumentIds: [ ...bounded... ]
}
```

`documentId` is a UUID for the document that opened the message; `frameId` identifies the frame, with 0 meaning the top-level frame. Require a top-level sender for recorder ownership (`sender.frameId === 0` when present). `documentLifecycle` can reject clearly non-active registration attempts, but it is a point-in-time hint and must not replace the durable document/lease check.

The browser's `sender.documentId` is read from `MessageSender`; never accept a message-body `documentId` as authority. Compare the body `pageNonce` with the nonce registered for that sender document to detect stale/duplicate content instances. A nonce is an identity label, not a secret.

### 2. Register a document before normal observation

At content-script startup, before the first `observe()`/`pullActivity()`, send one:

```text
register({ pageNonce, navEpoch: 0, conversationId: CLF_DOM.conversationId(), url: location.href })
```

Use the existing `RUN_ID` as `pageNonce` or generate a separate random value. Wrap `ask()` so every message carries `{ owner: { pageNonce, navEpoch } }`; do not rely on every caller remembering it. `emit()` must copy the owner into each queue entry at creation time, because a batch can span an SPA transition. `flush()` must not label an old batch with the current outer `conversationId`.

Registration rules:

- Same `(tabId, documentId, pageNonce)`: accept only the same epoch or a strictly newer epoch. A lower epoch is stale; an equal epoch is idempotent.
- A new `documentId` may become current **only through `register`**, never through a normal `events`, `bind`, `activity`, `compact`, or `closed` message.
- If the prior lease is `terminal`, a new document starts with a new lease and no provisional carry-over.
- If the prior lease is active and the URL's concrete conversation id equals the old id, treat the new document as a reload transfer: move the lease to D2, retire D1, and preserve known-A observations. A delayed D1 message is then rejected because D1 is retired.
- If the new document has a different concrete conversation id, close/release the old lease by exact lease id and start a fresh lease. Do not infer continuity from the tab id or the ten-minute TTL.
- An ambiguous fresh composer with no id does not inherit old no-id provisional rows by default. If preserving the opening message across a reload is a product requirement, add an explicit reload handoff token (same-origin `sessionStorage` plus a fresh `register`), and never use it after a terminal URL transition.

### 3. Advance the epoch for SPA navigation

When the existing `content.js` branch at `1049-1074` sees a concrete A -> B replacement, send an explicit `navigate`/`advance` message before normal B observations:

```text
advance({ owner: { pageNonce, navEpoch: next }, from: A, to: B })
```

The background performs one serialized transition: verify the old source exactly, retire `(D1,oldEpoch,A)`, create `(D1,newEpoch,B)`, and decide the A `/closed` refcount while holding the tab lock. The current page already calls `closed` before incrementing its epoch; that can remain as a compatibility path for one release, but the explicit transition is needed when the close is delayed or reordered.

Normal handlers then require exact current ownership:

```text
source(documentId, pageNonce, navEpoch) == current lease
```

The lower-epoch A poll in R3, the old D1 message in R1/R4, and the B close after returning to A all fail this check before any app call. A message rejected for a stale source should return a stable `stale_document`/`stale_epoch` error; content treats it as a dropped old page and does not retry it under the new owner.

### 4. Make terminal events durable and monotonic

`onRemoved` and a concrete non-ChatGPT `onUpdated` URL transition should synchronously enqueue an atomic state transition to `phase: "terminal"` and retain the retired document id. They must not merely add an in-memory `Set` and then clear it on the next ChatGPT URL (`background.js:936-956`). A ChatGPT URL does not clear a terminal lease; the first new-document `register` replaces it.

`releaseTab()` should accept an exact lease/source object, not `(tab, expectedConversation)`. Under a per-tab mutation chain:

1. verify the lease is still current;
2. remove only that lease's mapping/provisional bucket;
3. persist the immutable new snapshot;
4. recheck the conversation reference count against all active leases;
5. post `/closed` only for a zero-reference transition.

Keep `persistLive()`'s write serialization, but pass immutable snapshots (`{ ...tabLeasesV2 }`) and serialize the state decision itself. If adding an app-side optional close generation is feasible, include `leaseId`/`closeGeneration` in `/closed` and have the bridge ignore a close superseded by a later lease. Without that server-side token, a new same-conversation tab can still race a network-in-flight `/closed` after the extension's final refcount check; the extension can reduce but cannot eliminate that last boundary race alone.

### 5. Apply the gate to every identity-sensitive handler

The exact source check belongs before `noteTabConversation()` and before any `call()` for:

- `events`, `bind`, `activity`;
- `compact`, `auto_compact_claim` (currently ignore `noteTabConversation()`'s false result at `background.js:880-906`);
- `closed`/`releaseTab`;
- `repair_fiber`;
- `redeem`/`ack`, unless their explicit command ownership is retained as a documented exception and tested against stale documents.

`status` and popup-wide `overwriteNow` are global/read-only operations. `overwriteNow` should still target the currently discovered tab; it must not be used as evidence that a sender document owns a conversation.

### 6. Provisional journal ownership follows the lease

Replace `provisional: "tab-12"` with an owner key containing tab, document, page nonce, and epoch. `bindProvisional()` may bind only the exact owner bucket named by the current registration. On terminal transition, retire/drop that bucket; a later document gets a different bucket. For observations already accepted into the worker journal, preserve their concrete conversation id and drain them before the old conversation close when safe. For observations that arrive from a terminal/retired source, fail closed and emit an explicit loss marker rather than silently rebind or append them to the new chat.

### 7. Use `storage.session` only for browser-session ownership

`storage.session` is the right scope for tab/document leases: it survives service-worker sleep but not browser/extension restart. The extension's content documents also do not survive a full browser restart, so startup must require fresh registration. Do not move this state to `storage.local`; that would leave stale tab ids across browser lifetimes.

`storage.session` is asynchronous and whole-snapshot writes can fail quota or be interrupted. The existing journal/live write queues are useful, but a protocol must tolerate a worker dying between the in-memory terminal transition and the storage commit. On an uncertain restart, reject normal source-less messages and require a fresh `register`; never use “same numeric tab id” as recovery proof.

## Migration and fallback concerns

### Existing `tabConversations` and journal data

On first V2 load, migrate each old `tabConversations[tab] = conversation` into a `legacy-active` lease with no trusted document id. Existing journal entries with a concrete `conversationId` can still drain; no-id entries must remain marked legacy and must not be rebound after a terminal transition. Once a V2 document registers, replace the legacy record with a real lease. Do not write V2 state back in the old shape, or a later worker can silently lose the tombstone.

The background and content scripts are shipped together, but already-open tabs can retain old isolated worlds during an extension update/reload. Bump the recorder/ownership protocol marker and make the content guard versioned rather than accepting an old boolean marker forever. A V2 worker should respond to source-less identity-sensitive messages with `ownership_upgrade_required` and reinject/replace the recorder; accepting old tab-only messages during a rolling update would preserve the bug. The current recovery path and version constants are at `background.js:975-1029` and `content.js:27-35,4807-4837`.

### Chrome versions and absent `documentId`

The manifest's minimum Chrome version is 116, so production can require `sender.documentId` for ownership messages. If a test harness or an unexpected older runtime omits it, the safe fallback is a content-generated page nonce plus a durable terminal tombstone. Do not silently fall back to tab id. After a worker restart or terminal event, refuse mutation until a fresh nonce registers; this may lose a reload-time opening observation, but it cannot file D1 into D2. Keep this fallback explicitly observable so an unsupported runtime is diagnosed rather than treated as healthy.

`documentLifecycle` should be used carefully. A cached BFCache document may legitimately return on `pageshow`; `content.js` already avoids treating `pagehide.persisted` as a close (`content.js:4739-4750`). A cached sender can be accepted only if its exact current lease still matches; terminal/new-document transitions must retire it. Lifecycle is a helpful negative signal, not the ownership key.

### Reload continuity versus fail-closed navigation

The current design deliberately keeps tab-key provisional entries across reload (`background.js:652-658,848-863`). A document epoch fixes cross-chat ownership only if the product chooses the correct transfer rule. Known conversation reloads are safe to transfer when D2 registers the same concrete `/c/A`; fresh no-id composers are ambiguous. Preserve them only with an explicit reload marker that is proven to be the same tab/session and is invalidated by external navigation. A ten-minute age window is not proof.

### Server close boundary

The extension currently posts only `{conversationId}` to `/closed` (`background.js:728-733`; bridge validation is `src/main/bridge.ts:677-697`). Exact lease CAS prevents stale local closes in nearly all schedules, but cannot prevent a same-conversation new tab from registering after the last local refcount check and before the HTTP close reaches the app. If this boundary matters for active workers/turns, add an optional generation/lease token to `/closed` and make the bridge accept it only when it is still the latest close candidate. That is a small cross-module protocol change; omitting it should be recorded as a residual race, not claimed as fully solved by `terminalTabs`.

## Deterministic regression matrix

These tests can be added to the existing fake-worker harness without a live Chrome process. They should extend `WorkerHarness.send()` to supply `sender.documentId`, `sender.documentLifecycle`, `sender.frameId`, and `sender.url`; the current harness passes only `{tab:{id}}` (`test/extension.test.ts:511-516`), so it cannot exercise document ownership.

| Test | Schedule | Required assertion |
|---|---|---|
| External return rejects D1 | Register D1/A; fire `onUpdated(T12, external)`; fire `onUpdated(T12, ChatGPT)`; deliver delayed D1 `events`, `activity`, `bind`, `compact`, `closed`; register D2/B. | Every D1 mutation returns `stale_document`/`tab_closed`; exactly one A close; no D1 journal/provisional row is bound to B; D2 owns B. |
| Restart preserves terminal | Persist V2 terminal lease; construct a new worker; deliver D1 message before D2 register. | D1 rejected after worker restart; D2 registration is the only path that clears terminal. |
| SPA A -> B -> A | Same D1, register epoch 0/A; advance epoch 1/B; advance epoch 2/A; deliver delayed epoch 0/1 polls, events, and close. | Only epoch 2 can mutate; old epochs never call the app or change the map. |
| Reload same A | Register D1/A; register D2/A; deliver delayed D1 `closed(A)` and `activity(A)`. | Lease transfers to D2 without `/closed`; D1 cannot release D2 even though conversation id is equal. |
| Provisional external return | D1 no-id event; terminal navigation; delayed D1 no-id event; D2 binds B. | D1 bucket is dropped/rejected; B receives only D2's observations. |
| Provisional same-tab reload | D1 no-id event; explicit same-tab reload handoff; D2 registers no-id and binds A. | Only the explicit reload path carries the opening event; a plain external return does not. |
| Tab-id reuse | Remove T12/D1; create T12/D2; deliver delayed D1 message and then D2 register/event. | D1 rejected; D2 gets a new lease; old tombstone cannot be cleared by a normal message. |
| Same conversation on two tabs | T10/D1/A and T11/D2/A; replace T10 D1 with D3/A; deliver D1 close. | D1 close cannot remove D3; A remains open through T11/D3. |
| Release/new-lease interleave | Hold `storage.session.get`/`set` and `/closed`; overlap `releaseTab(D1)` with D2 registration. | Per-tab CAS leaves D2 current; no stale `/closed` is sent after a replacement lease. |
| BFCache lifecycle | Register D1/A; send `pagehide.persisted`; deliver cached D1 flush; `pageshow`/register active. | No close on persisted pagehide; cached events are accepted only while D1 lease remains current; terminal navigation rejects them. |
| Missing sender document id | Omit `sender.documentId` for events/bind/compact/closed after V2 upgrade. | No tab-id fallback; deterministic `ownership_upgrade_required`/safe refusal. |
| Frame spoof/iframe | Send from `frameId:1` with a valid tab/document payload. | Recorder ownership is refused; top-level `frameId:0` remains accepted. |

Also add source-level assertions that `content.js` attaches the owner envelope in `ask()`, captures owner metadata in `emit()`, and sends startup registration before the first observation. A test that only inspects the service-worker map cannot prove the page actually stamps the epoch.

## Recommended implementation order

1. Add the ownership envelope and startup registration; require `sender.documentId`/top-frame validation.
2. Introduce `tabLeasesV2`, a per-tab mutation chain, immutable storage snapshots, and retired-document tombstones.
3. Make terminal lifecycle monotonic: external/removed events set terminal; only a fresh registration replaces it.
4. Send and validate SPA epoch transitions; stamp queued observations individually.
5. Move provisional binding to lease ownership and gate compact/auto-compact/closed/command paths.
6. Add the deterministic matrix above, then migrate old tab-only state with a fail-closed rolling-update path.

## Review log and evidence boundary

- Read `AGENTS.md` and `bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md` before source review.
- Inspected current `extension/background.js`, `extension/content.js`, `extension/manifest.json`, `extension/fiber.js`, and relevant `test/extension.test.ts`/`test/content-script.test.ts` sections.
- Compared the retained navigation reproductions with the current in-memory `terminalTabs` guard. The current sequential/cold-load test covers only the interval before a returning ChatGPT URL clears the guard; it does not cover D1/D2 document identity, restart persistence, SPA epoch crossing, or compact/close handler coverage.
- Consulted the official Chrome runtime/storage references linked above for `MessageSender.documentId`/`documentLifecycle`/`frameId` availability and `storage.session` lifetime.
- No production/test/AppData/config/git files were changed by this review. This report is the sole output file.

## Bottom line

The page-local epoch is a good renderer guard, and the current in-memory terminal set is a useful narrow race shield. They do not establish ownership at the service-worker boundary. The durable unit must be `(tabId, sender.documentId, pageNonce, navEpoch, leaseId)`, with terminal state monotonic until a new document explicitly registers. Bare tab ids, conversation ids, TTLs, and storage-write ordering are not substitutes. The secure fallback for ambiguity is a visible drop/retry or an explicit gap, never reopening A or binding its provisional observations into B.
