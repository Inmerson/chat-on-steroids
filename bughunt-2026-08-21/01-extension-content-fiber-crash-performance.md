# Extension document/Fiber crash and performance audit

Date: 2026-08-21  
Scope: current dirty tree, `extension/content.js`, `extension/fiber.js`, `extension/chatgpt-dom.js`, the injected stylesheet, and the corresponding extension tests. `AGENTS.md` and `bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md` were read in full before this audit.

This is a source/architecture audit, not a product or test change. The working tree was already dirty; all line references below are to the current files, not to `HEAD`. No product or test file was edited. There is no `extension/content.css` in the current tree; the injected stylesheet is `extension/overlay.css`. Its stage body has a bounded scroll area (`overlay.css:254-258`) and the stream has a width cap (`overlay.css:545-555`); no separate CSS-specific crash vector was found.

## Executive conclusion

Five current-tree breakpoints can destabilize a ChatGPT tab under long-chat, streaming, worker-outage, or SPA-navigation conditions:

1. Fiber has per-field caps but no aggregate response or structured-clone budget. A conservative allowed shape is hundreds of MiB of text/HTML before clone and DOM overhead.
2. A document-wide `MutationObserver` schedules a full transcript/Fiber pass every 50 ms during streaming. The page request is coalesced, but the expensive post-processing is not.
3. The hot Fiber and DOM matching paths contain several quadratic scans, including candidate-to-Markdown matching, nested-row detection, and duplicate detection.
4. The page-local observation queue is bounded by 400 entries, not bytes. With its current per-entry cap it can retain about 156.25 MiB while the worker/app is unavailable.
5. An in-flight `/activity` result can run automatic compaction after an SPA move because the continuation checks only local id/epoch, not the current route; the result can claim/compact chat A and click the stop control in chat B.

The first four are source-confirmed resource hazards; the Fiber scale probe makes their pressure measurable but is intentionally not presented as a Chrome benchmark. The fifth is reproduced by a current-tree runtime-shaped probe. Exact crash thresholds remain browser/page-shape dependent.

## Newly confirmed current-tree findings

### E1 — HIGH — Fiber response has no aggregate payload budget

Confidence: high for the source failure; medium for the exact crash threshold.

Trigger: a long or unusually rich chat in which the newest six turn groups contain many authored model messages and large Markdown/HTML blocks. `fiber.js` caps each `rawText` at 256,000 characters and each `renderedHtml` at 120,000 characters (`fiber.js:73-80`), but `renderedMessagesOf()` emits one object per candidate without a total message/byte budget (`fiber.js:564-707`). `turnsOf()` reads the message model for each of the newest six groups and puts the resulting arrays into the reply (`fiber.js:1057-1101`); `scan()` posts the complete `{ rows, turns }` object without measuring it (`fiber.js:1146-1181`). The page-side input arrays are not bounded before this work, either.

The isolated world only slices after the `postMessage` round trip: it accepts at most 200 messages per returned turn and repeats the 256,000/120,000-character slices in `readTurnCalls()` (`content.js:1706-1727`, `1810-1826`). That protects downstream state shape, but not the page-world traversal, string construction, or structured clone already performed.

A deliberately conservative size calculation using the existing limits is:

```text
6 turns × 200 messages × (256,000 text + 120,000 HTML)
= 451,200,000 characters
```

The static calculation command reported `451,200,000` characters, approximately `430.30 MiB` if represented as one-byte strings (roughly twice that for two-byte UTF-16 storage), before object overhead, the page DOM, and the `postMessage` clone. This is a scale bound, not a claim that every real ChatGPT turn reaches it. There is no aggregate guard that rejects or degrades the reply before that memory is allocated.

Impact: a large Fiber scan can cause long GC pauses, freeze the ChatGPT main thread, and potentially exhaust the renderer process. The same payload can exist in the page-world result, the structured-clone delivery, and the content-side normalized objects at overlapping times. A busy page can therefore fail before the app's 400 KiB per-observation transport cap (`content.js:465-500`) has any opportunity to help.

Fix direction: enforce a total character/byte budget in `fiber.js` while collecting a scan, before copying `innerHTML` or appending message objects. Prefer the active/newest turn and request-id/tool evidence; truncate or omit older rendered prose with an explicit marker. Reject an over-budget reply on both sides, and make the content-side parser account for one whole response rather than only slicing individual fields.

### E2 — HIGH — 50 ms transcript observer creates a full-scan/main-thread budget failure

Confidence: high for the scheduling/fan-out architecture; medium for exact Chrome CPU percentage.

`watchTranscript()` observes `document.body` with `childList`, `subtree`, and `characterData` (`content.js:1437-1464`). Any relevant mutation inside a turn starts a 50 ms timer and then calls the full `observe()` function (`content.js:1452-1463`). This timer coalesces records while it is pending, but there is no scan-generation or in-flight processing gate.

One `observe()` does a whole-conversation DOM pass: `reportMessages()` calls `CLF_DOM.messages()` (`content.js:1029-1032`), and the observer also re-reads turns/errors/progress and may call `refreshFiber()` whenever a generation is live (`content.js:1102-1267`). The same page has a separate connector-row observer that calls `refreshFiber()` on inserted rows (`content.js:1402-1428`), a one-second `observe()` interval (`content.js:4993-5004`), and a two-second activity interval (`content.js:5005`). `askFiber()` coalesces only the page request promise (`content.js:1791-1836`); every caller waiting on that promise still runs its own `refreshFiber()` normalization, reporting loops, maps, and rendering-side follow-up (`content.js:1847-2100`). Thus the request may be one scan while the expensive consumers are several.

Trigger: token-by-token assistant streaming, a React rerender burst, or a virtualized history mount/scroll in a long chat. At a 50 ms cadence the observer can schedule up to 20 full passes per second while the one-second and two-second loops continue independently.

Impact: the extension competes with ChatGPT's own React work on the page's main thread. The likely symptom is typing/scrolling jank or a tab that appears frozen during a live answer, with Fiber/DOM work and Overwrite repainting extending the busy period.

Fix direction: use one generation-aware scheduler shared by mutation, polling, tool-row, and activity triggers. Allow at most one page scan and one normalization pass at a time; coalesce later requests into a single dirty flag and discard stale results. Limit mutation-triggered work to the active/changed section and reserve bounded whole-history scans for navigation/explicit recovery. Apply a per-frame or explicit CPU budget before allowing Overwrite repaint.

### E3 — HIGH — quadratic Fiber/DOM matching is on the hot path

Confidence: high for the asymptotic source behavior; medium for the exact browser timing.

The current Fiber scan contains multiple nested linear searches:

- Assistant duplicate detection and logical-id collision detection scan `seen` and `out` for every message (`fiber.js:419-434`); user duplicate detection has the same shape (`fiber.js:487-514`).
- When a message id is absent from rendered Markdown, exact-text attachment scans every free candidate against every free block, rescans candidates to prove uniqueness, then scans all output objects to find the target (`fiber.js:606-650`, `690-695`).
- Native activity removes nested rows pairwise and then linearly searches previously held activity (`fiber.js:740-753`, `776-789`). Each row's `thoughtItemOf()` also checks up to 80 Fiber ancestors against every thought id (`fiber.js:302-325`).
- `callsOf()` linearly checks duplicate request ids, result ids, and then every duplicate against every output call (`fiber.js:1011-1047`). `turnsOf()` queries and groups all mounted sections, processes only the newest six, then walks all sections again to update stamps (`fiber.js:1061-1135`).
- The selector-only layer repeats pairwise containment in `toolBlocks()` and `connectorRows()` (`chatgpt-dom.js:776-792`, `830-840`, `933-940`). Its `turns()`/`messages()` path also walks every mounted turn and message (`chatgpt-dom.js:279-297`, `341-426`) on each observation.

The scale probe executed 20 current `fiber.js` scans over synthetic six-turn DOM fixtures. Its current output was:

```text
{"rows":20,"messages":40,"activities":0,"scans":20,"totalMs":272.1,"avgMs":13.6,"outRows":20,"outTurns":6}
{"rows":100,"messages":100,"activities":0,"scans":20,"totalMs":239.7,"avgMs":12,"outRows":100,"outTurns":6}
{"rows":400,"messages":200,"activities":0,"scans":20,"totalMs":707,"avgMs":35.3,"outRows":400,"outTurns":6}
{"rows":100,"messages":100,"activities":1,"scans":20,"totalMs":260.5,"avgMs":13,"outRows":100,"outTurns":6}
{"rows":400,"messages":200,"activities":1,"scans":20,"totalMs":676.3,"avgMs":33.8,"outRows":400,"outTurns":6}
```

This uses jsdom and synthetic nodes, so it is not a production timing claim. It does show that the current shape already spends about 33.8 ms per scan in the 400-row fixture; at the observer's maximum 20 scans/second that is about 676 ms of JavaScript work per second before the separate DOM observer, full transcript extraction, and painting are counted.

Fix direction: replace duplicate/collision arrays with `Set`/`Map`; build id-to-candidate and text-to-candidate indexes once per scan; determine nested rows by a single ancestor walk or a marked parent set; key held activities by message id; stop scanning historical sections once the bounded evidence budget is exhausted. Keep an explicit total CPU/DOM-node budget so an unexpected page shape fails closed rather than consuming the tab.

### E4 — HIGH/MEDIUM — page queue is count-bounded but memory-unbounded

Confidence: high for the retention bound; medium for how often a real outage reaches the worst case.

`emit()` gives each observation a shared 400 KiB UTF-8 budget for `text` and `renderedHtml` (`content.js:465-500`). The queue then retains entries until its length exceeds 400 (`content.js:501-510`); the overflow marker improves the prior silent-loss behavior but does not bound retained bytes (`content.js:510-543`). `flush()` keeps a 200-entry batch while awaiting the worker response and retains the batch if the response is ambiguous or the worker is unavailable (`content.js:559-587`).

During a service-worker suspension, bridge outage, or a stalled `chrome.runtime` response, 400 worst-case observations can therefore retain about 160,000 KiB, or 156.25 MiB, of text/HTML before JavaScript object/string overhead. The static size command reported `queueBytes:163840000` and `queueMiB:156.25`. A streaming assistant can produce many distinct revisions because the content-side message signature includes the changing text/HTML (`content.js:2055-2076`), so this is not limited to one event per visible row.

Impact: a local receiver outage can turn normal transcript streaming into a large isolated-world allocation and GC storm, contributing to a ChatGPT tab freeze or renderer crash. The gap marker honestly records loss, but it is not a memory-pressure policy.

Fix direction: maintain a byte budget, not only an entry count, and build flush batches by bytes. Coalesce pending assistant revisions by stable message id while preserving the newest state; spill or hand off earlier to the worker; if eviction is unavoidable, retain only a compact gap record rather than the evicted payload. Account for the temporary batch/reference and serialized message sizes in the budget.

### E5 — HIGH — stale SPA activity continuation can compact the wrong chat

Confidence: high; reproduced against the current source with a runtime-shaped probe.

`pullActivity()` captures `forId` and `forEpoch`, but its `current()` predicate checks only `alive`, the local `conversationId`, and the local `epoch` (`content.js:3516-3523`). It does not re-check `CLF_DOM.conversationId()`/the route after the asynchronous activity reply. After painting, it calls `maybeAutoCompact()` outside that guard (`content.js:3644-3659`). `maybeAutoCompact()` claims using the mutable global `conversationId` and then calls `startCompact()` (`content.js:3911-3931`); `startCompact()` has no captured id/epoch and invokes `stopAndSettle()` against the currently visible ChatGPT DOM before sending `/compact` with the mutable id (`content.js:4226-4260`, `4303-4334`).

Reproduction trigger: begin an activity request for chat A, navigate the SPA to chat B before the next `observe()` updates the local id/epoch, then release the A activity reply with auto-compaction eligibility and a live generation. The probe command was:

```text
node C:\Users\totec\AppData\Local\Temp\clf-stale-autocompact-probe.mjs
```

Current output:

```json
{"activityCalls":3,"before":1,"staleAutoClaim":[{"type":"auto_compact_claim","conversationId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","path":"/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}],"staleCompact":[{"type":"compact","conversationId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","resume":true,"path":"/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff"}],"staleStopClicks":1,"currentPath":"/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff"}
```

The important facts are that the compact/claim id is A, the current path is B, and B's stop control was clicked. This is a cross-chat correctness failure as well as a user-visible interruption: it can spend A's automatic-compaction claim, stop B's live answer, and start a continuation operation against the wrong frontend.

Fix direction: make the route check part of the continuation token, not just the initial `pullActivity()` guard. Capture `{ conversationId, epoch, pathname }` and require it before every state mutation, before `maybeAutoCompact()`/the claim, and before every `stopAndSettle()`, prompt insertion, and `/compact` request. Re-check after every await. If the route changes after a claim, the app needs an idempotent cancellation/lease or the claim must be delayed until the token is still current.

## Prior known findings deliberately not promoted as new

The consolidated report already identified the Fiber health blind spot, sticky `fiberPresent`, false worker stalls/Unattributed activity, stale Overwrite grace, and page-queue eviction. The current tree contains attempted changes in those areas: background has a `repair_fiber` path and reinjection (`background.js:1023-1035`, `1188-1210`), `refreshFiber()` can downgrade Fiber after a definitive failed repair (`content.js:1861-1886`), and queue overflow now emits a gap marker (`content.js:510-543`). Those are not called newly confirmed here. They still require live Chrome validation because a source repair path is not proof that a MAIN-world helper survives real extension reloads, React replacement, and service-worker suspension.

The new E4 finding is specifically the remaining byte-retention risk in the changed queue; it is not a re-report of the old A10 silent-eviction bug. The new E5 finding is specifically the activity-to-auto-compaction continuation; it is not the already-known A12/A13 Overwrite generation binding issue.

## Tests, probes, and limits

The relevant test files were inspected, not modified. `fiber.test.ts` exercises protocol, allowlisting, identity, long single-message text, and descriptor fixtures (`fiber.test.ts:349-930`, including the single long-answer case at `717-724`). `content-script.test.ts` exercises fake-DOM lifecycle, route transitions, Overwrite, and Fiber ingestion (`content-script.test.ts:1360-1490`, `1818-2195`, `2592-2693`). Those harnesses do not model a real Chrome main-thread budget, a 400-row/200-message mutation stream, aggregate structured-clone size, a worker outage with 400 full observations, or an activity reply completing after a route move without an intervening observe.

Commands used for the missing production dimensions:

```text
node C:\Users\totec\AppData\Local\Temp\clf-fiber-scale-probe.mjs
node C:\Users\totec\AppData\Local\Temp\clf-stale-autocompact-probe.mjs
node -e "const fiberChars=6*200*(256000+120000); const queueBytes=400*400*1024; console.log(JSON.stringify({fiberChars,fiberMiB:fiberChars/2**20,queueBytes,queueMiB:queueBytes/2**20}))"
```

The first two commands and their outputs are quoted under E3/E5. The size command output was:

```json
{"fiberChars":451200000,"fiberMiB":430.2978515625,"queueBytes":163840000,"queueMiB":156.25}
```

No routine Vitest suite was run because the handoff explicitly said the existing tests always pass and asked to focus on browser-runtime dimensions they do not cover. No live ChatGPT/Chrome crash recording was available in this audit; exact renderer OOM limits, ChatGPT's current Fiber shape, and real-world mutation frequency remain hypotheses to validate with a controlled browser profile after resource guards are designed.

## Recommended order

1. Put a hard aggregate Fiber scan budget and a single-flight/generation-aware scan scheduler in place; these directly bound the main-thread and clone risks.
2. Replace the quadratic matching/containment loops and add a scan CPU budget.
3. Add a byte-bounded/coalescing page queue and byte-bounded flush batches.
4. Route/epoch-scope all activity, auto-compaction, stop, prompt, and compact continuations; keep the current stale-navigation probe as a regression.
