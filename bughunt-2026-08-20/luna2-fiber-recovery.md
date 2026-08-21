# Fiber helper loss and recovery review

Date: 2026-08-20  
Scope: the current dirty tree, with emphasis on `extension/content.js`, `extension/fiber.js`,
`extension/background.js`, the bridge, correlation/recorder, and agents. This review is
read-only: no production code, test, AppData, configuration, or git state was changed. The
only file created by this review is this report.

## Executive result

The original audit's two most direct Fiber-health findings are no longer current: extension
reload recovery now re-executes `fiber.js` even when the isolated recorder answers healthy, and
`content.js` now downgrades `fiberPresent` after a failed repair. The new dirty tree also adds a
persisted Chrome `MessageSender.documentId` lease. Those are useful repairs, but the lease is
not yet an atomic ownership boundary. A stale document can pass authorization and perform its
handler after a new document claims the tab, and direct ChatGPT-to-ChatGPT full navigation does
not create a terminal tombstone at all. Provisional observations are still keyed by numeric tab
id, so they can be rebound across documents.

The smallest secure repair is therefore two-part: make the existing document lease an
unforgeable, rechecked handler lease (and key provisional journal entries by document), then
make Fiber repair prove a live helper rather than trusting a version marker or an empty scan.
No downstream bridge/correlation heuristic can safely repair a stale document after it has
posted `/events`: the bridge will accept the outer conversation id and the recorder will make
the exact request-id join durable.

## End-to-end path verified

1. `fiber.js` runs in the MAIN world. It reads ChatGPT's page model and posts bounded rows and
   turn descriptors containing `metadata.request_id`, tool name, and page conversation id.
   `content.js` validates shape in `askFiber()`, caches the answer in `refreshFiber()`, and
   emits `tool_evidence` plus page transcript/activity observations.
2. `content.js` sends those observations through `ask()`. The current dirty tree first sends
   `register_document`; the background uses the browser-supplied `sender.documentId` and a
   persisted per-tab document state. `/events`, `/activity`, `bind`, compaction, close, and
   repair are then routed by the service worker.
3. `background.js` journals `/events`, drains it to the loopback bridge, and the bridge's
   `/events` route parses the page-controlled body. `recordChatObservations()` stores the
   transcript. `noteCallEvidence()` sends each exact page `requestId` to
   `observeRequestCorrelation()`; a URL/Fiber conversation disagreement is rejected.
4. MCP ingress in `kernel.ts` already has the normalized HTTP request id. If correlation is
   absent, ordinary calls can be recorded in Unattributed after the exact-id grace period;
   identity-sensitive swarm calls wait for that exact id and fail closed. `recordToolCall()`
   and `repairDeterministicAttribution()` use the exact request id, and `agentForCaller()` only
   returns a worker for a proven conversation. Thus a stale `/events` item is not cosmetic: it
   can bind a live MCP call to the wrong session/worker before any later evidence arrives.

## Ranked current findings

### F1 — HIGH: document authorization is not a side-effect lease

Status: source-confirmed in the current dirty tree; the external-navigation happy path has a
regression test, but the handoff ordering below does not.

Relevant code: `extension/background.js:707-745` (`authorizeDocument()` and
`registerDocument()`), `:900-1018` (handlers and message wrapper), `:784-817`
(`releaseTab()`), and `:1048-1069` (tab lifecycle).

The message wrapper awaits `authorizeDocument(sender)` and then calls the handler with only
`message` and `sender`. The successful result is not a lease/token passed to the handler, and
the handlers do not re-check that the sender is still the current document. In particular,
`events`, `bind`, and `activity` call `noteTabConversation()` (which only checks the terminal
map), `repair_fiber` targets `{ tabId }`, and `closed` calls `releaseTab()` without
`expectedDocument`.

Adversarial ordering:

```text
D1 owns tab 12 and conversation A.
D1 starts events/repair/closed; authorizeDocument(D1) returns ok.
D2 registers the same tab and changes tabDocuments[12] to D2, retiring D1.
D1's handler resumes.
```

The D1 event can now journal and drain under A because the terminal lease was cleared by D2.
D1 `repair_fiber` can inject into the current D2 page. A D1 `closed`, compact, or auto-compact
request can reach the app after the handoff. The same race is possible while `releaseTab()` is
waiting in `drain()`: D2 claims the tab, `stillOwned()` fails, and the old conversation close
is skipped, leaving A open/zombie while D2 owns B.

There is a second ordering before D2 registers. `tabs.onUpdated` deliberately returns for all
ChatGPT URLs (`:1059-1063`), not just same-document SPA changes. For a full navigation A -> B,
D1 remains current until D2's first message. A delayed D1 `/events` can therefore be accepted
after the browser has already committed B. This is not covered by the current external round
trip test (`test/extension.test.ts:1059-1088`), which registers the new document before sending
the stale message.

Downstream effect: `/events` at `src/main/bridge.ts:611-675` has no browser document proof. A
stale event carrying A and its Fiber request id is accepted; `recorder.ts:582-607` then makes
the exact correlation durable, and the kernel/agents path can treat a real B call as A.

### F2 — HIGH: provisional journal entries still have tab-only identity

Status: source-confirmed; this is a cross-document form of the old A7 failure.

`background.js:824-839` still derives `tabKey(sender)` as `tab-<numeric id>`. `events` stamps
missing-conversation entries with that key and `bind` renames all entries for that key.
`releaseTab()` purges `tab-<id>` only during the terminal path.

Ordering:

```text
D1 opens fresh chat A; before ChatGPT assigns an id it emits a user message.
The journal stores it as provisional=tab-12.
D1 is fully navigated directly to ChatGPT chat B (no external site in between).
D2 registers and binds B.
bindProvisional(tab-12, B) renames A's opening message into B.
```

The same loss occurs if external `releaseTab(D1)` is still draining when D2 registers: its
`expectedDocument` check returns early, while the old `tab-12` provisional entry remains for
D2 to bind. Document authorization cannot repair this because the document id is not stored on
journal entries. The existing test at `test/extension.test.ts:1128-1150` only covers an external
abandonment whose purge completes before the later bind.

### F3 — HIGH/MEDIUM: Fiber version marker and empty replies can report false health

Status: source-confirmed; no existing regression covers it.

`extension/fiber.js:45-47` returns immediately when
`window.__clfFiberHelperVersion === 8`. If the listener was removed, the marker was left by a
partially failed injection, or the page set the marker, both extension-reload recovery and the
on-demand `repair_fiber` call execute successfully but install no listener.

Separately, `fiber.js:1148-1182` catches `turnsOf()`/DOM failures and posts ordinary-looking
`{rows: [], turns: []}`. `content.js:1745-1790` accepts any reply with the right source, nonce,
and version; `refreshFiber()` then sets `fiberPresent=true` at `:1847`. A helper that is alive
but unable to read the page is consequently considered healthy and no repair is attempted.
The current `fiberPresent=false` downgrade at `content.js:1835` fixes the no-reply-after-failed-
repair case, but not this false-positive case.

Impact: request-id evidence disappears while the page still looks healthy. The worker path
then falls into Unattributed/`WORKER_IDENTITY_LOST`, and `fiberPresent=true` also suppresses
the intended degraded DOM completion fallback.

### F4 — MEDIUM/HIGH: route/epoch checks do not reject a concrete Fiber conversation mismatch

Status: source-confirmed acceptance path; adversarial ordering is not represented in tests.

`content.js:1800-1847` checks the captured local `epoch`, local `conversationId`, and the final
DOM route. That protects ordinary A -> B transitions observed by `observe()`, but an async
round trip can span A -> B -> A before the observer increments its epoch. The returned Fiber
turns already contain a concrete `conversationId`, yet `refreshFiber()` stores all turns/rows
without rejecting a turn whose page conversation differs from `askedConversation`.

`tool_evidence` later carries `fiberConversationId` and the recorder rejects a mismatch, but
assistant/user/page-tool transcript observations from the same stale answer do not carry that
check. A B snapshot can therefore be emitted under A in the A -> B -> A window. The smallest
guard is to discard the complete answer when any concrete turn/descriptor conversation id
disagrees with the captured bound conversation; an answer with no page id may remain a
presentation-only degraded result, but must not prove request ownership.

### F5 — MEDIUM (trust-model limitation): Fiber replies remain page-controlled ownership input

Status: architectural limitation confirmed in source, not a hostile live incident.

The comments correctly say `postMessage` is page-controlled. `content.js` validates fields and
`bridge.ts:420-480` rebuilds/caps them, but `recorder.ts:582-607` still accepts a page-supplied
request id as the input to `observeRequestCorrelation()`. `repairDeterministicAttribution()`
(`recorder.ts:660+`) can then move an already-recorded call solely because that exact id was
reported from the page. This is bounded (Fiber never carries args, secrets, or agent keys), but
it is not cryptographic authentication: a page can fabricate a well-shaped reply.

Self-repair must not claim to make MAIN-world evidence authoritative. At minimum, correlation
should only be created for an exact MCP request that is pending or already recorded, with the
reported tool matching that request; unknown page ids must not create a durable ownership fact.
Identity-sensitive tools should keep their current fail-closed behavior when this corroboration
is absent. A stronger cryptographic proof is impossible while the reader shares a page context.

## Current claims from the consolidated audit: fixed or stale

- **A2 (healthy content ping skipped Fiber): fixed in the dirty tree.**
  `background.js:1097-1112` re-executes MAIN-world `fiber.js` after a healthy recorder ping;
  `test/extension.test.ts:702-716` asserts one Fiber injection. The old
  `repro-fiber-health-gap.test.ts` expectation of zero injections is stale.
- **A3 (sticky `fiberPresent` after timeout): fixed for a definitive failed repair.**
  `content.js:1800-1842` retries once, clears health/maps on a failed current-worker repair,
  and `test/content-script.test.ts:5372-5410` exercises that path. F3 remains a separate
  marker/empty-scan false-positive.
- **A5 correlation snapshot, A6 `/activity` restart, A9 lifecycle replay, A10 page queue loss,
  and A11 exact-call ordering:** current code contains the durable-history reconciliation,
  durable conversation restore, idempotent lifecycle sets, explicit queue-gap markers, and
  `recordChain` path respectively. The older audit repros are not evidence against this tree.
- **A8 external navigation:** the persisted terminal/document lease and tests at
  `test/extension.test.ts:1027-1126` cover the narrow “external URL then stale old document”
  ordering. F1/F2 show why it is not yet a complete per-document guarantee.
- **A1/A4 worker-5 Unattributed/stall:** the consolidated report's live incident remains
  valid historical evidence, but this review did not re-observe worker-5 after the current
  changes; it must not be described as a current reproduction.
- **A12 generation binding:** skipped legacy generation tests remain a separate content/UI
  risk. They were not treated as proof that Fiber repair itself is broken here.

## Smallest secure implementation proposal

1. **Turn the document id into a real lease.** Have the message wrapper obtain
   `{documentId, tabId}` and pass that immutable lease to every tab-scoped handler. Add
   `owns(lease)` checks immediately before every mutation and after every awaited operation.
   `closed` must call `releaseTab(tab, expectedConversation, expectedDocument)`, and
   `noteTabConversation`, compaction, activity, and journal/drain paths must reject a changed
   lease. Serialize per-tab state transitions so a D1 handler cannot resume after D2 has
   committed without being rechecked.
2. **Retire full documents, not only external URLs.** Use a top-level document lifecycle
   signal (`tabs.onUpdated` loading transition or `webNavigation.onCommitted`) to tombstone the
   old document. Preserve a same-conversation reload/SPA lease only when the browser proves it
   is the same conversation; direct full navigation must wait for the new document's
   `register_document`. If D2 claims while D1 close is draining, enqueue/complete D1's close by
   its retired lease without touching D2.
3. **Make provisional identity document-scoped.** Derive the journal key from the browser tab
   and document id (for example `tab-12:<documentId>`), store it on each provisional entry, and
   purge/rename only the retired document's key. Never use a numeric tab id as a cross-document
   binding key.
4. **Target repair at the exact document and prove health.** Change `repair_fiber` to execute
   against the authorized document (`documentIds: [lease.documentId]`, plus the top frame) and
   reject if the lease changes. In `fiber.js`, replace the primitive early-return marker with a
   small singleton state containing the current listener; on re-execution remove/reinstall that
   listener even when the old marker says version 8. Add `scanOk: true/false` (or a distinct
   health reply) to every response. `askFiber()` accepts a snapshot only when health is true;
   empty rows/turns are valid only with `scanOk:true`. A successful repair is not reported until
   the follow-up nonce receives that health proof.
5. **Keep app-side attribution fail-closed.** Preserve exact request-id correlation, sticky
   conflicts, and durable late repair. Add a pending/recorded MCP request check before a page
   `requestId` can create correlation, and require the page tool to match that request. Never
   infer from active tab, timestamp, tool name alone, or worker label. No bridge change can
   compensate for a stale document event that was already accepted.

## Invariants to pin

- A message accepted from D1 can never mutate tab/journal/app state after D2 owns the tab.
- A full document navigation retires D1 before D1 can register or repair; only D2 can clear the
  tombstone.
- Provisional observations are renamed only by the same document that produced them.
- `repair_fiber` can inject only into its authorized document and must be followed by a live
  health reply.
- A concrete Fiber/turn conversation mismatch discards the answer; no stale transcript or
  request evidence crosses an A -> B -> A route epoch.
- A page-controlled request id can corroborate an exact pending/recorded MCP call but cannot
  create ownership for an unknown call or agent.
- Missing Fiber evidence remains visibly degraded/Unattributed and never guesses a worker,
  workspace, terminal, or conversation.

## Required regression tests

### Background/document lease

- Full ChatGPT D1(A) -> ChatGPT D2(B), with D1 `events`, `bind`, `activity`, `closed`, and
  `repair_fiber` delivered both before and after D2 registration. D1 must never reach `/events`,
  `/activity`, `/closed`, compaction, or `executeScript` against D2.
- Pause D1 after `authorizeDocument()` but before its handler, register D2, then resume D1.
  This specifically catches the current non-atomic lease race.
- External D1 -> D2 while `releaseTab()` is inside `drain()`. Verify provisional A is purged,
  `/closed(A)` occurs once, and B's mapping/stream remains untouched.
- Fresh A provisional message followed by direct full navigation to B; bind B and assert A's
  message remains unbound/dropped rather than renamed to B.
- Same-document SPA A -> B -> A with one document id remains usable, while a full-document
  A -> B retires the old id. Also cover service-worker restart and non-zero frame rejection.

### Fiber/content

- Marker says version 8 but listener is absent; executing `fiber.js` must install a listener and
  answer the next nonce.
- `turnsOf()` or `querySelectorAll()` throws; reply must carry unhealthy scan status and
  `refreshFiber()` must repair/downgrade instead of setting `fiberPresent=true`.
- A valid empty snapshot with `scanOk:true` remains healthy (empty is not itself an error).
- A response from a B turn while local route is A, including an A -> B -> A round trip, emits
  no transcript, page-tool, or request evidence under A.
- A transient `register_document`/service-worker failure retries on the next `ask()`; the
  current reset at `content.js:440-446` should stay covered.

### Bridge/correlation/agents

- A stale-document `/events` request never reaches `recordChatObservations()`.
- A forged/unknown page request id cannot create a correlation or move a call out of
  Unattributed; an exact late id can repair only the matching recorded request.
- With Fiber absent, an identity-sensitive worker call fails `CALLER_IDENTITY_REQUIRED` /
  `WORKER_IDENTITY_LOST`; it does not inherit prime/current-tab identity, and later exact
  evidence repairs only the exact call.

## Checks performed

- Read the root `AGENTS.md` instructions and the consolidated bughunt report before tracing
  code.
- Inspected the current dirty diff and the relevant source/tests listed above. Existing changes
  were treated as current implementation, not silently discarded.
- `node --check extension/background.js`, `node --check extension/content.js`, and
  `node --check extension/fiber.js` passed.
- `git diff --check` passed for the reviewed extension/test files (Git emitted only normal CRLF
  normalization warnings).
- The focused Vitest invocation
  `npx vitest run test/content-script.test.ts test/extension.test.ts test/bridge.test.ts test/correlation.test.ts --reporter=dot`
  could not start in the managed sandbox: esbuild reported `Cannot read directory "..": Access
  is denied` while resolving `vitest.config.ts`. No test result is claimed from that attempt.
