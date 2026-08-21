# Multi-agent Prime bootstrap audit

**Date:** 2026-08-20 (Europe/Berlin)  
**Scope:** Prime `agents spawn` through browser open/focus, prompt insertion, command redemption and ACK, worker binding, first exact request correlation, inbox/liveness, finish, restart, and late ACK.  
**Requested mode:** read-only audit. The only file written by this audit is this report.

## Executive conclusion

The app-owned spawn path is materially stronger than the older pull/poll design. Prime creation is atomic; worker commands are delivered one at a time; redemption has a per-document owner; normal ACK binding derives the worker slot from the app-owned command id rather than a page-supplied `agent`; and MCP ownership still requires the exact HTTP request-id-to-page evidence chain.

The remaining bootstrap failure is not one bug. It is two handoff races followed by a silent terminal-state gap:

1. **The browser opener steals foreground focus, and the composer guard is only a point-in-time check.** `src/main/index.ts` wires the bridge to `shell.openExternal()`, which opens/focuses the new ChatGPT tab. `extension/content.js` checks for an existing draft before waiting for the composer, but does not recheck that the composer is unchanged immediately before `send()`. A user can therefore type into the new tab after the guard, or after the bootstrap is inserted. A failed insertion immediately retires the worker and delivers the next queued worker, so one focus mistake cascades into several tabs. This is the direct mechanism behind the retained A14 incident and the reported 50–66% launch success.

2. **Binding a worker does not prove the first MCP request's page evidence.** The ACK correctly binds the broker slot to a conversation before the model sees the task, but exact MCP attribution still depends on MAIN-world Fiber reporting that request's `metadata.request_id`. The dirty tree now attempts runtime Fiber repair and clears stale Fiber health, which addresses the old startup/reload blind spot and sticky-health finding. It does not guarantee that a repair actually produces the next exact request evidence, and `repair_fiber` is guarded by tab id/terminal state rather than a document epoch. During an evidence outage, ordinary absolute calls can execute as Unattributed, `agents` waits and then returns `WORKER_IDENTITY_LOST`, inbox offers cannot be acknowledged, and the worker can look idle to browser liveness while still running tools.

3. **A deadline-expired worker has no safe late-ACK state.** After 90 seconds, `expire()` calls `drop()`, which fails the invited worker and clears its recovery-key hash. A page that typed successfully but reports its conversation id after that deadline sends an ACK for a command that no longer exists. The bridge returns a successful-looking no-op response; it does not bind the tab. The real worker is then a stranger with no normal recovery path, and the content script does not inspect the ACK response. The fail-closed ownership decision is safe, but the operational result is silent loss.

The smallest secure repair is therefore: make bootstrap input immutable from insertion through send, stop automatic tab cascades after user-input/focus failures, add an explicit short-lived same-document late-ACK tombstone, and treat missing exact request evidence as a visible run-level identity outage that blocks stale cleanup without ever assigning calls by timing, active tab, worker label, or command marker.

## The actual end-to-end path

| Stage | Current implementation and invariant | Failure consequence |
|---|---|---|
| Prime spawn | `tools-core.ts` calls `callerNow(..., { exact: true })`; `agents.ts` atomically claims the proven prime and creates invited workers. | No exact prime evidence means no run; this is the correct fail-closed boundary. |
| Worker offer | `agents.ts` invokes the bridge spawn callback. `bridge.ts::queueWorkerBootstrap()` queues one command and `deliver()` claims it, arms a 90-second deadline, then invokes the browser opener. | The opener is `shell.openExternal()` and can foreground a tab. Only one command is in flight, so a failed first worker blocks or serializes the rest. |
| Page redemption | `content.js::deliverCommand()` refuses a URL that already has a conversation id, then redeems with its per-document `RUN_ID`. `bridge.ts` records the first owner and rejects a different leased client. | This prevents stale/duplicated tabs from typing into an existing chat. It does not prevent a legitimate user from typing into the newly focused tab. |
| Prompt insertion | Content checks the current composer once, waits up to 12 seconds, calls `insertPrompt()`, sleeps 100 ms, and checks that a squeezed prefix of the bootstrap remains. | A draft typed after the first check causes insertion failure; user edits after insertion are not detected if the bootstrap prefix remains. |
| Send and ACK | Content calls `send()`, polls up to 40 seconds for `/c/<conversation>`, and sends `status: sent` with the conversation and document client. `bridge.ts` checks the owner, binds the worker, records origin, and retires the command. | If the URL appears after expiry, ACK is a no-op. Content ignores the bridge result. |
| First MCP call | `kernel.ts` resolves exact request id non-blockingly for ordinary calls; workspace-sensitive calls wait up to 15 seconds. `tools-core.ts::callerNow()` waits exactly for the `agents` call's request id and adopts the proven agent. | Fiber outage splits broker binding from MCP identity. `agents` fails closed, while self-contained absolute work may still be recorded Unattributed. |
| Inbox and finish | `acknowledgeOffers()` retires prior offers only on a later authenticated call. Explicit `agents finish` requires exact caller identity; a final assistant message plus matching `turn_end` can app-finish a bound worker via `/events`. | No exact call means messages remain pending and explicit finish fails. If bound-session lifecycle is also missing, stale cleanup can evict an active worker. |
| Restart | Swarm bindings and invited workers are restored; invited spawn requests replay after bridge registration. `/events` can reconstruct a worker origin from the durable broker binding, `/activity` reattaches a durable live chat, and correlation restore now reconciles durable history. | Restart cannot invent a request-id mapping that was never learned. A still-open active worker with Fiber unavailable remains bound but uncorrelated. |

## Findings

### B1 — P0: foreground bootstrap races with user input and cascades to the next worker

**Verification:** retained live incident (A14) plus current source.

Evidence:

- `src/main/index.ts:189-197` sets `setBrowserOpener()` to `shell.openExternal(url)`. There is no inactive/background-tab contract.
- `extension/content.js:4676-4742` checks `CLF_DOM.composer()` once before `waitForComposer()`. The wait itself can last 12 seconds, and the later insertion/send sequence is asynchronous.
- After insertion, the only integrity check is `squeeze(composer.textContent).includes(expectedHead)`. Appended or interleaved user text can leave the expected prefix present. The next operation is `CLF_DOM.send()` with no exact-content or user-edit check.
- On a failed ACK, `bridge.ts::ackCommand()` calls `drop()`, and then `deliver()` immediately opens the next queued worker (`bridge.ts:1880-1918`). The existing bridge test deliberately asserts this behavior for a failed first worker.
- The consolidated report records a worker failure, “ChatGPT refused the inserted text,” after the newly opened worker tab took focus while the user was typing. `insertPrompt()` correctly refuses a non-empty composer; the surrounding queue policy turns that local protection into a swarm-wide cascade.

There are two distinct races:

1. The user starts typing after the initial empty-composer check but before the composer is ready or while React replaces the editor. `insertPrompt()` fails and the worker is terminalised.
2. The bootstrap is inserted successfully, but the user types during the 100 ms hydration guard or before `send()`. The prefix check passes and the mixed message may be submitted as the worker task. This is worse than a visible failure because user text can be sent to ChatGPT and the worker may be bound to a conversation containing it.

**Smallest secure logic fix:** immediately before `send()`, take a canonical snapshot of the composer text and compare it with the canonical text proven after insertion. If it differs, do not send; preserve the user's current draft and report a failed bootstrap. The canonicalizer must account for the rich-text editor's paragraph/newline normalization, but it must not use a prefix or “contains” test. Reinsert only into an empty editor after a React replacement; never clear or overwrite a non-empty editor.

This fixes mixed-message submission but not foreground focus. The preferred browser fix is to have the extension create the marked tab inactive, with the app-owned command id still in the URL and the same redeem/owner protocol. If the product cannot create inactive tabs in the current architecture, the safe fallback is a user-visible “worker bootstrap paused because the composer changed” state and no automatic next-worker open. The user can explicitly retry after returning focus to the intended tab. Do not solve this by clearing the draft or by opening all workers in parallel.

**UX failure reporting:** show the worker id and exact reason (“bootstrap stopped; the composer changed, your draft was preserved”), keep later workers unopened, and offer an explicit retry. The current renderer displays failed worker `result`, but does not show command-level browser errors or distinguish a user-input abort from a missing browser.

**Tests to add:**

- Content harness: composer empty at the first check, then user text appears while `waitForComposer()` is pending; assert failed ACK, no send, and draft preserved.
- Content harness: mutate the composer after successful insertion and before send; assert no send and a single failed ACK.
- Content harness: mutate only whitespace/paragraph structure that ChatGPT normalizes; assert the canonical equality check does not reject a valid bootstrap.
- Bridge/extension integration: a focus/input failure must not automatically open the next worker; an explicit retry must create one new command/tab.
- Browser-opener integration: assert the opener contract carries an inactive-tab requirement or, if unavailable, produces a visible paused state rather than silently foregrounding a tab.

### B2 — P0: broker-bound worker can remain Unattributed after Fiber loss

**Verification:** live worker-5 evidence in the consolidated report, plus current source tracing.

The retained incident is unusually conclusive: worker-5 was broker-bound to conversation `6a86ce29-3f14-83eb-9d1c-1ff4a7b84608`, yet 67 calls sharing request id `ebb257d5-e0f6-4bf0-9bcd-a6280f1c9d5b` landed in the global Unattributed session. Three `agents` calls returned `WORKER_IDENTITY_LOST`; prime-to-worker messages remained pending; the bound worker session contained lifecycle evidence but zero MCP calls and zero Fiber-derived `page_tool` events.

The current dirty tree partially addresses the original mechanism:

- `content.js::refreshFiber()` now asks the service worker for `repair_fiber` after a failed round-trip and clears `fiberPresent`, `fiberRows`, and `fiberTurns` after a definitive failed repair.
- `background.js::repair_fiber()` reinjects `fiber.js`, and startup/reload recovery also reinjects Fiber even when the isolated content script answers its health ping.
- `kernel.ts` and `tools-core.ts` use exact request ids and a 15-second evidence wait for identity-sensitive operations.
- `recorder.ts` can later move a call only when the exact request id is subsequently correlated.

These are good mitigations, not an end-to-end proof. `executeScript()` succeeding is not the same as a Fiber reply containing the request id for the next MCP call. `repair_fiber` checks the tab id and an in-memory terminal set, but not a document/navigation epoch. A delayed request from an old content document can therefore ask for repair against the current tab; it does not itself grant attribution, but it makes lifecycle behavior harder to reason about. Most importantly, no page evidence means the command-bound conversation still cannot be used as proof for a particular MCP HTTP request.

The current split is deliberate but operationally incomplete:

- A self-contained absolute read or command can execute with no worker identity and be durably Unattributed.
- A relative/default workspace operation is refused after the exact wait, which protects against wrong-project mutation.
- `agents` waits in `callerNow()` and then throws identity loss; it cannot deliver or acknowledge the worker inbox.
- Late recorder repair can fix historical tool rows after Fiber returns, but it cannot retroactively make a failed `agents` result reach the model or acknowledge a message that the worker never saw.
- Explicit `agents finish` likewise cannot run without exact caller evidence. `/events` auto-finish remains valid only when the bound page produces a final assistant message and matching turn end.

**Smallest secure logic fix:** preserve exact request-id correlation as the only ownership proof, and add an explicit worker identity-pending state. After a worker is bound, the first control-plane call should either wait for its exact page evidence and succeed, or return a recoverable `IDENTITY_EVIDENCE_PENDING`/`WORKER_IDENTITY_LOST` result that also marks the run as evidence-degraded. Consider failing closed for all worker calls while this state is active if the product cannot safely explain Unattributed absolute work; at minimum, never use the broker binding, command id, active tab, timing, worker label, or body `agent` as a substitute for the HTTP request-id mate.

Make Fiber repair document-scoped: include a content-document epoch/nonce in the repair request, invalidate it on navigation, and require a fresh Fiber round-trip after injection before clearing the degraded state. A stale document must not repair a newer document merely because the tab id is unchanged.

**UX failure reporting:** the swarm row should say “worker-5 bound; exact request evidence unavailable” and show pending inbox count. The prime should receive a concise recoverable anomaly (“reconnect the extension in worker-5's tab; no unproven attribution was made”), not a silent working state. Keep the worker active until explicit tab closure, exact finish, or a user clear; do not present it as completed merely because the broker knows its tab.

**Tests to add:**

- Content integration: Fiber answers once, then stops; repair reinjects it, the next real page evidence carries an exact request id, and that MCP call lands in the worker session and adopts the worker.
- Extension VM: a repair reply delayed across navigation/document replacement is rejected; a repair for a terminal/closed tab is not injected.
- MCP/recorder integration: no Fiber evidence leaves the call Unattributed; late exact evidence repairs only the matching request id and never repairs the broker inbox/control result.
- Agents/swarm: a bound worker with missing exact evidence cannot acknowledge offers or finish; offers remain at-least-once until a later authenticated call.

### B3 — P0: attribution loss can become a false stall and stale-worker eviction

**Verification:** live worker-5 cascade plus current stale-sweep source.

`bridge.ts` runs `sweepStaleSwarm()` every 30 seconds. `STALE_SWARM_MS` is two minutes. The initial guard vetoes only while `inFlightMcpRequests() > 0` or browser observation writes are currently in flight. Per-conversation `durableQuiescence()` then inspects the bound session's durable timestamps, generating flag, and turn boundaries.

That proof is sound when the bound page is reporting. It is not enough during an identity outage: the worker's MCP calls are in the Unattributed session, so the bound session can have no fresh tool activity or open turn. A gap between two MCP calls lets the sweep pass even though the worker is continuing work. The retained incident showed exactly this sequence: active Unattributed calls, a ten-minute “no visible progress” error in the bound session, a stalled turn, and then a stale-worker report freeing worker-5.

**Smallest secure logic fix:** add a run-level identity-degraded/liveness veto that is diagnostic only. When an active run has a worker-bound conversation but an exact worker control call times out, record the outage and prevent automatic stale failure until exact evidence recovers or the user explicitly closes/clears the worker. A recent Unattributed MCP activity watermark can strengthen this veto, but it must never be used to assign those calls to the worker. If the app cannot identify which worker generated unknown traffic, global stale cleanup should prefer “identity evidence unavailable; manual recovery required” over terminalising a bound worker.

The veto should not block ordinary explicit lifecycle evidence: real `/closed`, an exact bound final turn, or an explicit user Clear can still end the slot. Do not extend the timeout alone; a longer false-stall window is still a false-stall window.

**Tests to add:** create a bound worker with a durable bootstrap session, issue repeated MCP calls whose exact page evidence is absent, and run the sweep during a gap between calls. Assert the worker remains active and the UI/anomaly state says identity degraded. Then provide exact evidence and assert normal attribution/inbox behavior resumes; separately provide explicit close/clear and assert cleanup occurs.

### B4 — P1: late ACK after deadline is safe against takeover but silently strands the real tab

**Verification:** source-confirmed; current tests cover expiry without redemption and superseded-owner ACK, but not a late ACK after actual worker expiry.

The current path is:

1. `deliver()` claims a worker command and arms `COMMAND_DEADLINE_MS = 90_000`.
2. Content can send `status: sent` after it has typed but failed to observe a conversation id (`content.js` sends a final ACK without `conversationId` after its 40-second poll).
3. If the deadline wins first, `expire()` calls `drop()`. `drop()` removes the command, calls `failAgent()`, clears `joinKeyHash`, and queues a failure report to prime.
4. A later `/commands/ack` has no `ownedCommand`; `ackCommand()` is a no-op, but the route still returns `{ ok: true, committed: true }`-shaped success. No binding occurs.
5. `content.js` awaits the background ACK call but does not inspect the result. `background.js::ackCommand()` returns the raw bridge response, so an expired/owner-changed result is invisible to the page.

This is correctly fail-closed against a stale page stealing a new worker slot, but it gives a genuine slow ChatGPT tab the same outcome as an attacker: a stranger chat, no ordinary join key, and no actionable UI. It is especially likely when browser focus/ChatGPT startup consumes most of the deadline.

**Smallest secure logic fix:** retain a short post-expiry tombstone (for example, a bounded minute-scale grace, not the 30-minute command TTL) containing command id, command generation, worker id, and the redeemed document client/epoch. During grace, accept exactly one late `sent` ACK only from that same owner, only if the worker has not been rebound or superseded. Bind once, retire the tombstone, and do not trust `agent` from the body. A different client gets 409; after grace, return a deterministic 410/`bootstrap_expired` rather than a successful no-op. If grace cannot be supported, retain an explicit recovery state/key long enough for the user to recover; do not clear the only recovery path before telling the user.

Return a structured ACK result (`accepted`, `code`, `boundConversationId`) and propagate it through `background.js` to `content.js`. A late page must be able to display “bootstrap expired; this chat was not bound—use recovery or retry,” while the app can show the failed worker and preserve the exact reason.

**Tests to add:** fake-timer expiry after redeem, then same-owner late ACK with a conversation id; assert it binds during grace. Test a different owner, a superseded command, a second conversation, and an ACK after grace; each must refuse without binding. Test that the content harness receives and surfaces 409/410 rather than silently returning.

### B5 — P1: browser-open rejection leaves an unleased command blocking the queue

**Verification:** source-confirmed; the existing test intentionally exposes the state.

`deliver()` catches `openInBrowser()` rejection, clears `claimedAt`, stores `lastError`, and calls `changed()`, but does not call `drop()` or `deliver()` again. The command remains in `commands` with its timer still armed. `nextDeliverable()` sees it as unleased and no later delivery happens unless another event invokes `deliver()`; otherwise it waits for the 90-second expiry. The targeted-open test expects one pending command with `lastError`, but the renderer does not expose pending command errors in the swarm row.

This is a secondary explanation for low launch rates and a direct explanation for “the next worker never opens” when the OS browser opener fails. It is distinct from the focus/input cascade and should not be hidden behind the same error string.

**Smallest secure logic fix:** transition the command to an explicit `open_failed` state, either fail/drop it and require an explicit retry, or perform one bounded retry with a visible backoff. Do not leave an unleased command that blocks siblings until a timer. If a retry is chosen, it must preserve the same command generation and never open two tabs concurrently.

**Tests:** opener rejection with two queued workers; assert the first becomes visibly failed or explicitly retrying and the queue does not wait silently for the deadline. Assert no unbounded retry loop. Render `lastError` in the worker/opening UI.

## Finish, restart, and late-repair consequences

- **Finish:** explicit `agents finish` is correctly self-only and idempotent, but it requires exact caller conversation evidence. In the worker-5 failure, all three control calls were rejected, so no finish or inbox acknowledgement could occur. Browser final-answer auto-finish remains a useful independent path, but only if the bound page reports final assistant text and matching `turn_end`.
- **Inbox:** `acknowledgeOffers()` is correctly at-least-once. Do not “fix” missing inbox delivery by acknowledging offers from the broker's known bound conversation; that would claim a model saw a result when its exact MCP response was never proven. Keep pending messages and report the evidence outage.
- **Restart:** current `restoreSwarm()` replays unbound invited workers after bridge registration, active worker bindings survive, `/events` reconstructs a worker origin after recorder restart, and `/activity` restores a durable live conversation. These fixes do not manufacture a missing request-id correlation. A post-restart Fiber outage remains the same identity-degraded state.
- **Late exact repair:** `recorder.ts::repairDeterministicAttribution()` moves only calls carrying a request id whose exact page mapping is now known. That is the correct historical repair boundary. It cannot retroactively deliver a failed `agents` result, acknowledge an inbox message, or prove that unrelated calls in the same Unattributed bucket belong to the same worker.
- **Late ACK:** command tombstones must be separate from request correlation. A command proves which app-opened document was offered a task; it does not prove which MCP request a model later issued. Keep both proofs and never substitute one for the other.

## False fixes to avoid

- Do not attribute calls to the worker solely because its broker slot is already bound, because it is the only active worker, or because the request arrived near a tab's activity.
- Do not use the page `agent` body field, command marker, active tab, most recent generating chat, tool name, turn position, or arrival order as an MCP owner.
- Do not repair a Fiber outage by assigning the whole Unattributed session to worker-5. Split only exact request ids after page evidence proves them.
- Do not make `join` automatic or accept a late ACK from any tab. Preserve command id + document owner + generation checks.
- Do not clear the user's draft, overwrite a non-empty editor, or submit a prefix-matching mixed message.
- Do not open every worker tab in parallel. One-at-a-time delivery is what prevents a report from naming the wrong fresh tab.
- Do not treat a successful `executeScript()` or content health ping as proof that the next exact request-id evidence will be emitted; require a fresh Fiber round-trip and test it.
- Do not make a stale-sweep timeout longer and call that liveness. Identity loss needs an explicit safety veto and user-visible recovery state.
- Do not return HTTP success for a missing/expired command ACK. Fail closed, but tell the page and app which terminal state was reached.
- Do not persist plaintext recovery keys or turn a command URL into a long-lived credential.

## Verification record

I read the repository `AGENTS.md` and `bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md`, then traced the current dirty source and existing bridge/content/extension/swarm tests. The retained live worker-5 evidence and A14 focus incident are the production evidence for B2/B3/B1 respectively. Current source inspection also confirmed the runtime Fiber-repair/sticky-health changes, so the older report's “no runtime repair” conclusion is not repeated as current fact.

Fresh automated execution was not available without modifying the workspace: `npm test -- --run ...` stopped because the dirty `package.json` has no `test` script, and direct Vitest startup failed before collection with `Cannot read directory "..": Access is denied` while resolving the config. No code, tests, AppData/config, or git state was changed by these checks.

