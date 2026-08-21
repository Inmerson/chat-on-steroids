# 10 — Extension subagent findings (content.js, background.js, fiber.js, chatgpt-dom.js, popup.js)

Date: 2026-08-21 · Read-only pass · Line numbers verified against working tree.

---

## HIGH

### H1. Reload of a fresh chat permanently deletes its provisional (pre-conversation-id) journal entries
- **Where:** `extension/background.js:944-957` (`markTerminal`) called from `chrome.tabs.onUpdated` at `background.js:1440-1441`; contrast the stated intent at `background.js:415-426` (`bindProvisional` comment: "a reload in that window does not take them with it") and `background.js:1053-1059`.
- **What breaks:** `markTerminal` filters `journal` to drop every entry whose `provisional === tab-<id>:<documentId>`. The `onUpdated` handler calls `markTerminal(id)` on **every** `status === 'loading'` transition — which includes a plain F5 reload — *before* the `fullNavigation && !leftChatGpt` early-return that deliberately preserves the conversation. So the exact window the provisional mechanism exists to protect (first message sent, ChatGPT has not yet assigned `/c/<id>`) is destroyed by the most ordinary user action: reloading the tab. The opening user message of a brand-new chat is silently lost from the durable journal; nothing reports a gap.
- **Scenario:** fresh chat → send first prompt → ChatGPT is slow to assign the id → user reloads (or the recovery path reinjects after a navigation) → `markTerminal` stamps the old documentId terminal and deletes the journalled opening message → the app's session for that chat starts without its first user message.
- **Fix:** only drop provisional entries on a *real* terminal event (tab removed, or navigation that concretely leaves ChatGPT) — i.e. move the provisional purge out of `markTerminal` into `releaseTab`'s non-reload paths, or gate it on the same `leftChatGpt`/`onRemoved` condition that authorises `releaseTab`.

---

## MEDIUM

### M1. Stale `data-clf-fiber` stamps can join a tool block to the wrong descriptor
- **Where:** `extension/fiber.js:1170-1188` (`scan`) stamps rows `0..limit-1`; `extension/chatgpt-dom.js:975-985` (`fiberIndex`) reads the stamp; `extension/content.js:2305-2309` (`fiberFor`) maps it into the *previous* scan's `fiberRows`.
- **What breaks:** only rows present in the current `CONNECTOR` query are re-stamped. A row that carried `data-clf-fiber="7"` in scan N but is no longer a connector match in scan N+1 (aria-label changed, React rewrap, row count shrank below 8) keeps stamp `7`, while scan N+1 stamps a *different* row `7`. `fiberIndex()` resolves via `closest('[data-clf-fiber]')`/`querySelector` and can hit the stale element, so `fiberFor` returns the wrong row's descriptor. That wrong `tool` then feeds `planLabels`' `contradicts()` veto (content.js:2440-2441, 2458, 2488, 2517) and `applyPageLabel` — a row can be stripped of a correct label or named with another call's tool.
- **Fix:** in `scan()`, first clear `data-clf-fiber` from all elements currently carrying it (`querySelectorAll('[data-clf-fiber]')`) before stamping the current set — the same desired-vs-current pattern `turnsOf()` already uses for `data-clf-fiber-turn` (fiber.js:1129-1143).

### M2. `flush()` un-tracks overflow gap markers before delivery is confirmed → duplicate/undocumented gap entries
- **Where:** `extension/content.js:692-695` deletes each batch gap from `queueGaps` before the `ask()`; the entry is only removed from `queue` on success (`content.js:708-717`).
- **What breaks:** if the worker refuses/fails the batch, the gap entry stays in `queue` but is no longer registered in `queueGaps`. The next `emit()` overflow for the same conversation/agent bucket creates a **second** gap entry for the same key and re-points `queueGapKeys` at it. Result: multiple "N observations were lost" markers for one bucket, with counts that each understate the loss, and untracked gap entries that `emit`'s eviction loop (content.js:633) will silently drop as if they were data.
- **Fix:** delete from `queueGaps` only after the batch is confirmed delivered/removed (move the loop next to the `sent`-set removal), or re-insert on failure.

### M3. `send()` reports success without any verification
- **Where:** `extension/chatgpt-dom.js:1274-1288`.
- **What breaks:** when the send button is missing/disabled, the fallback dispatches synthetic Enter keydown/keyup and `return true` unconditionally — it never checks that the composer cleared or a turn started. `deliverCommand` (content.js:5073, 5080-5090) treats `true` as sent, waits 40 s for a conversation id, and then acks `status:'sent'` with no conversationId. A ChatGPT build that ignores synthetic Enter (or a composer that silently failed to submit) therefore reports a worker bootstrap as delivered; the app starts a worker slot bound to nothing instead of retrying.
- **Fix:** after the Enter fallback, verify the composer emptied (or `CLF_DOM.generating()` flipped) within a short window and return that; `deliverCommand` already has a failure path that would report honestly.

### M4. `renderStreams()` rebuilds a full index + per-turn signature every second, even when nothing changed
- **Where:** `extension/content.js:3589-3710`; `streamRenderIndex` at 3221-3254; called from the 1 s `every(OBSERVE_MS)` tick (5289), every `pullActivity` (3876), `checkStatus` (4898) and the storage listener.
- **What breaks:** on every call it (a) runs `streamTurnGroups` + `streamRenderIndex` over up to 4 000 retained stream entries, and (b) for each assistant turn that passes `completeReplacementForTurn`, builds a `signature` string by joining every rendered entry's 10 fields (3684-3699). On a long reloaded chat with dozens of turns this is repeated megabyte-scale string building and Map churn on the main thread every second while the user is only reading — the exact pattern the file's own comments blame for frozen tabs elsewhere (content.js:3213-3219).
- **Fix:** cache the index keyed by `streamEntries` version (bump a counter in `trimStream`/`pullActivity`), and skip signature work for turns whose `dataset.clfTurn`/entry-seq set is unchanged since the last pass.

### M5. `errors()` transport-failure scan skips the visibility check applied to alerts
- **Where:** `extension/chatgpt-dom.js:1041-1051` (markdown branch) vs `displayed()` at 122-132 used only for `[role="alert"]` (1035).
- **What breaks:** a transport-failure markdown block that ChatGPT has hidden/collapsed (or that sits in a screen-reader-only region) is still counted by `errors()`. `endOutcome` (content.js:1081-1088) treats it as `outcome:'failed'` for the turn, so a turn that actually completed can be recorded failed — and `deliverBrief` (content.js:4794) then refuses to deliver the compaction brief because outcome is `failed`.
- **Fix:** add `if (!displayed(markdown)) continue;` to the markdown loop; `displayed` already fails open for DOM shims.

---

## LOW

### L1. `observed.calls` is overwritten by every turn's Fiber scan
- **Where:** `extension/content.js:1888` (`readTurnCalls` sets `observed.calls = kept.length` per turn, last turn wins).
- **What breaks:** the popup's "observed · N calls" (popup.js:284) shows only the newest scanned turn's count, not the page's. Cosmetic/diagnostic only.
- **Fix:** sum across turns in the scan loop, or drop the field.

### L2. `restoreOpenChatgptTabs()` pings every ChatGPT tab on every service-worker cold start
- **Where:** `extension/background.js:1537` (unconditional top-level call) with the ping loop at 1470-1511.
- **What breaks:** the MV3 worker suspends after seconds idle and is woken by any tab's message; each cold start sends one `clf-recorder-ping` per ChatGPT tab (and, for a stale tab, four `executeScript` injections). With several long-open tabs this is repeated wake-and-ping churn that also *keeps* the worker alive, working against its own idle suspension. Correctness is fine (ping-gated), it is wasted traffic/battery.
- **Fix:** rate-limit (e.g. run at most once per N minutes via a storage.session timestamp), or only on `runtime.onInstalled`/`onStartup`.

### L3. `stopAndSettle` latches `userStopped = true` with no rollback on barrier failure
- **Where:** `extension/content.js:4548-4556`; consumed by `endOutcome` (1074) and the quiet-window override (1493).
- **What breaks:** if the interrupt succeeds but the compact request then fails (app unreachable), `userStopped` stays true. If ChatGPT is restarted in this chat by other means before a new generation resets it (content.js:1337), the *next* quiet turn's outcome is recorded as `stopped` even though the user never pressed stop. Narrow window; mislabels one outcome.
- **Fix:** clear `userStopped` in `startCompact`'s failure paths alongside `pressedAt = 0`.

### L4. `drain()` labels a mixed batch with the first agent it finds
- **Where:** `extension/background.js:474` — `agent` is taken from the first journalled entry that has one, then applied to the whole `/events` batch.
- **What breaks:** entries for the same conversation from a prime tab and a worker bootstrap can share a batch; the app records the whole batch under one agent key. Bounded impact (attribution has stronger request-id evidence downstream) but it is a request-vs-conversation boundary smell.
- **Fix:** group `mine` by `agent` (or omit `agent` unless the batch is uniform).

### L5. `dropEcho`/`commentaryText` run O(200 × passes) prefix scans per line per box per tick
- **Where:** `extension/chatgpt-dom.js:629-672` (`dropEcho` peel loop) called from `commentaryText` (674-699) from `progressItems` on each observation of each `[data-interrupted]` box.
- **What breaks:** during streaming, a long caption line is re-scanned up to 200 widths × several peels every 250 ms–1 s tick per commentary box. Bounded (32 000-char page cap, 8 000-char output) but measurable main-thread work during exactly the phase where the page is busiest. Not a correctness bug.
- **Fix:** memoise per (stamp, length) so an unchanged box is not re-peeled.

### L6. `fiberIndex` accepts any ancestor/descendant stamp — a relabelled non-connector wrapper can inherit a row's stamp
- **Where:** `extension/chatgpt-dom.js:975-985` checks `closest('[data-clf-fiber]')` **or** `querySelector('[data-clf-fiber]')`.
- **What breaks:** `isToolBlock` (763-774) accepts a block that merely *contains* the connector control; after ChatGPT expands a row, the expanded card (with markdown) is inside the stamped row, and neighbouring heuristic blocks can resolve to the same descriptor index. Combined with M1 this widens the wrong-descriptor surface. Mitigated by `contradicts()` failing closed.
- **Fix:** prefer `closest()` only, and verify the stamped element is the row the descriptor was built from (e.g. also require `CONNECTOR` inside the stamped element).

---

## Verified non-issues (checked, deliberately not reported as bugs)

- `background.js` load/pair/journal singleflights (`loading`, `pairing`, `journalWriteQueue`, `liveWriteQueue`) are correct; the serialisation comments match the code.
- `drain()` 413-halving and 4xx-gap paths cannot loop forever (guard 20; single-entry 413 replaces and continues).
- `refreshFiber` epoch/conversation/route triple-check (content.js:2045-2100) correctly scopes MAIN-world answers to the asking chat, including the A→B→A case.
- `seenMessages`/`retiredMessages`/`pageTurnIds`/reported-maps are all bounded (2 000/500/4 000 caps) with documented eviction trade-offs.
- `emit()` UTF-8 binary-search truncation (content.js:580-600) is correct, including the shared text+HTML budget.
- popup.js `pipeline()` null-safety holds on every path that reaches `page.*` (guarded by `info.recorder`).
