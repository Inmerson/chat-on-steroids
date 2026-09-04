# Remote Autonomous Execution, Recovery, and Browser Lifecycle Design

Date: 2026-09-04

## 1. Purpose

Chat On Steroids should support a complete planning-to-execution workflow in which the user can plan from a phone or any authenticated ChatGPT surface, then hand the approved plan to the desktop runtime for autonomous execution.

The desktop execution must remain reliable when ChatGPT stalls, when the browser has to be reopened, when worker tabs are created, and when the controlling phone conversation disappears. The browser must stay organized, worker tabs must not accumulate, recovery must never resume the wrong conversation, and first-party product behavior must be English-only.

This design combines the requested remote-control workflow with the current Auto-Loop, Agent System 3.0, browser bridge, worker lifecycle, recovery, Core authority, and All Computer work already in progress.

## 2. Design goals

1. Treat the phone or remote ChatGPT conversation as a planning and control surface, not as the execution runtime.
2. Allow an authenticated remote ChatGPT conversation to start a new autonomous desktop execution from an approved plan.
3. Persist execution state in Core so the desktop run continues after the phone disconnects or the planning chat closes.
4. Open the desktop execution in a new ChatGPT conversation controlled by Chat On Steroids.
5. Route managed main execution chats and managed worker chats into separate Chrome windows while using the same Chrome profile, login, cookies, and extension.
6. Reopen a stalled conversation by opening its exact existing conversation URL in a fresh tab, restoring Loop state, and closing the old tab only after the replacement proves readiness.
7. Bound same-conversation recovery to three consecutive failed recoveries before falling back to clean-chat rollover.
8. Keep recovery and browser routing fail-closed on conversation, tab, document, and navigation identity mismatches.
9. Close managed worker tabs when the worker has durably reached a safe terminal/sleep boundary so worker tabs do not accumulate.
10. Stabilize existing Auto-Loop, compaction, Goal, bootstrap, revival, recorder takeover, and navigation invariants.
11. Restore Core terminal authority semantics to the documented authenticated-endpoint boundary unless an explicit transfer design is later introduced.
12. Make first-party product code, prompts, UI strings, comments, documentation, and tests English-only.
13. Fix the All Computer state-machine mismatch and bridge protocol compatibility regression found during review.
14. End with a clean, verified contribution that can be submitted back to the original project without including unrelated working-tree changes.

## 3. Non-goals

1. Do not create a separate Chrome profile for agents.
2. Do not require a second ChatGPT login.
3. Do not encode full plans, credentials, or durable execution state into browser URLs.
4. Do not use desktop coordinate automation as the primary way to type plans or route tabs.
5. Do not make browser presence an authorization requirement for ordinary Core file or terminal operations.
6. Do not reinterpret a closed browser tab as proof that a server-side worker turn ended.
7. Do not silently report a remote run as started when the desktop Core is unavailable.
8. Do not refactor unrelated subsystems merely because the working tree is already dirty.

## 4. Authority and identity model

The existing identity planes remain authoritative:

- Core authority: authenticated MCP endpoint.
- Tool attribution: request/conversation evidence when available.
- Browser observation: conversation id + navigation epoch + document identity + turn/message identity.
- Agent routing: conversation id -> prime/worker binding.
- Terminal continuation: authenticated MCP endpoint -> exec session id; conversation remains attribution.

This feature adds two explicit identities:

### 4.1 Execution run identity

`executionRunId` is a Core-generated durable id representing one autonomous desktop execution. It is not a credential and must not grant authority by itself.

It identifies:

- the approved plan,
- current run status,
- loop mode,
- current execution conversation,
- current browser transaction,
- recovery state,
- timestamps and terminal outcome.

### 4.2 Browser recovery transaction identity

`recoveryId` is a short-lived extension-generated correlation id for one exact replacement-tab attempt.

It is bound to:

- source tab id,
- target tab id,
- expected exact conversation URL,
- expected conversation id,
- execution run id when applicable,
- loop state snapshot,
- recovery attempt number,
- creation time,
- target document id after the target document registers.

A recovery transaction is not consumable by any other tab or conversation.

## 5. Remote planning and execution control plane

### 5.1 User workflow

The intended user flow is:

1. The user discusses and approves a plan from the phone or another ChatGPT surface.
2. The user says a control instruction such as `Start loop`.
3. The assistant invokes Chat On Steroids Core with the approved plan and requested loop mode.
4. Core durably creates an execution run before any browser side effect.
5. Core queues a one-time browser bootstrap command.
6. Core launches Chrome/Chromium if needed.
7. The extension redeems the bootstrap command.
8. A new ChatGPT conversation receives the approved plan as its first user message.
9. After ChatGPT accepts the send and the real conversation id is known, the extension binds that conversation to the execution run.
10. Auto-Loop starts automatically in the configured mode.
11. The run continues independently of the phone connection.

### 5.2 Core execution control surface

Add a first-class Core execution control tool rather than overloading worker-agent semantics.

Conceptual actions:

- `start`: create and start a durable autonomous execution from a supplied plan.
- `status`: read the caller-authorized execution state.
- `pause`: stop further autonomous sends without destroying the run.
- `resume`: resume a paused run and reopen its exact execution conversation if necessary.
- `stop`: terminate the autonomous execution and retire pending browser work.

The exact MCP schema will be finalized in the implementation plan, but it must preserve these properties:

- `start` accepts bounded plan text, optional title, and loop mode.
- Core generates the execution id.
- Browser command ids are generated by Core, not supplied by model text.
- A remote caller does not supply browser tab ids, document ids, conversation ids, or authority tokens.
- Status changes are durable before browser side effects are acknowledged.

### 5.3 Desktop unavailable behavior

Initial implementation is fail-closed.

If the remote ChatGPT surface cannot reach Core, it must report that the desktop Core is unavailable. It must not claim that execution has started.

Once Core has durably accepted the run, temporary loss of the phone or controlling ChatGPT surface does not stop execution.

A later enhancement may add `queued_until_desktop_online`, but it is outside this design.

## 6. Initial execution bootstrap

Initial remote execution is not a same-chat recovery, so it may use the existing one-time command-marker architecture.

Core stores the full plan and browser command durably. The URL contains only the command marker, for example conceptually:

`https://chatgpt.com/?clf=<command-id>`

The marker is not a credential and cannot reconstruct the plan without an authenticated local bridge redemption.

The extension must:

1. prove ownership of the marked document,
2. redeem the exact command,
3. verify the composer is empty and stable,
4. insert the approved execution prompt,
5. re-check composer integrity immediately before send,
6. send once,
7. obtain the resulting conversation id,
8. durably ACK the exact send,
9. bind the execution run to that conversation,
10. arm Auto-Loop only for that exact conversation/document generation.

If navigation, recorder takeover, composer mutation, command cancellation, or document supersession happens before send, the bootstrap fails closed and no message is submitted.

## 7. Execution prompt contract

The execution bootstrap prompt is app-owned framing plus the user-approved plan.

Its behavior contract is:

- execute only the approved plan,
- preserve unrelated working-tree changes,
- use Chat On Steroids Core tools when appropriate,
- make routine technical decisions autonomously when safe,
- verify before declaring completion,
- do not invent unrelated feature work in standard mode,
- in infinite mode, only transition to a new improvement after the current milestone is verified complete,
- do not ask the user to make routine implementation choices when the system can safely decide,
- stop or surface a blocker when a decision would cross a real authorization, destructive, privacy, or ambiguity boundary.

The prompt must be English-only.

## 8. Managed browser windows

Use the same Chrome profile and extension, but introduce two extension-managed logical windows.

### 8.1 Execution Window

Contains Core-created autonomous main execution chats.

Examples:

- a remote phone-plan execution,
- a resumed execution run,
- a clean-chat rollover created by the execution system.

### 8.2 Agent Window

Contains managed worker chats only.

Examples:

- worker bootstrap tabs,
- worker revival tabs when an existing exact tab is not available.

### 8.3 Window identity

Chrome window ids are browser-session identities and must not be treated as durable across full browser restart.

The extension keeps session-scoped managed-window metadata such as:

- execution window id,
- agent window id.

On browser restart, the first new managed command recreates the required window and publishes the new id.

Only Chat On Steroids-owned tabs may be automatically moved into managed windows. Ordinary user tabs must never be reorganized based on URL heuristics alone.

### 8.4 Routing

For a Core-opened command:

1. Core opens the marker URL in a compatible Chromium browser.
2. The extension identifies the command type after redemption/registration.
3. The service worker ensures the tab belongs to the correct managed window.
4. If the correct managed window does not exist, it creates or adopts a dedicated managed window only from the explicitly owned command tab.

For extension-triggered same-chat recovery, the service worker creates the replacement tab directly in the source run's managed Execution Window when one exists.

Manual user chats that enable Loop outside a managed run remain in their current user window unless explicitly adopted into an execution run.

## 9. Exact-URL same-conversation stall recovery

### 9.1 Trigger

The existing activity-aware watchdog remains the base behavior:

- no response initiation for 3 minutes after an Auto-Loop send -> recovery candidate,
- generating but no meaningful progress for the configured freeze window -> recovery candidate.

The watchdog must not treat ordinary quiet time as progress, and it must not recover while a user draft or protected local-tool state makes autonomous sending unsafe.

### 9.2 Exact URL requirement

When recovering an existing conversation, capture the current tab URL exactly as Chrome reports it.

The replacement tab must open that exact URL without adding `cos_*`, `clf`, recovery, loop, or other Chat On Steroids parameters.

Recovery state must travel out-of-band through the service worker transaction, not through the page URL.

### 9.3 Recovery transaction flow

1. The content document requests recovery and supplies its observed current conversation id plus Loop state snapshot.
2. The service worker verifies that the sender owns the current document/tab and that the tab still represents that conversation.
3. The service worker reads the current tab URL from `chrome.tabs.get` and treats that browser value as the exact URL authority.
4. The service worker increments the durable consecutive recovery count for that conversation/run.
5. If the count exceeds the configured limit, it refuses another same-chat replacement and requests clean-chat rollover.
6. Otherwise it creates a new blank or inactive target tab in the appropriate window.
7. Before navigation, it persists a recovery transaction bound to the new target tab id.
8. It navigates the target tab to the exact captured URL.
9. The new content document registers its tab/document/conversation identity.
10. The service worker binds the recovery transaction to the target document only if every identity matches.
11. The content document restores the captured Loop mode and turn count.
12. It observes the hydrated conversation before deciding whether to send anything.
13. If ChatGPT is already generating, it waits and observes rather than injecting a duplicate continuation.
14. If the prior turn is clearly complete, normal Loop logic advances from the actual final state.
15. If the prior turn is stalled/interrupted and the composer is safe, the Loop schedules one continuation.
16. The new document reports `recovery_ready` only after identity, hydration, and Loop restoration succeed.
17. Only after that ACK does the service worker close the old stalled tab.

If the replacement fails before `recovery_ready`, the old tab remains open unless it has independently disappeared.

### 9.4 Recovery counter semantics

The limit is three consecutive failed same-conversation recoveries, not three lifetime recoveries.

The counter is service-worker/Core durable state, not `sessionStorage` in the page.

Increment when a recovery transaction is committed.

Reset to zero when the recovered run proves genuine forward progress, for example:

- a new assistant turn begins and produces progress after recovery,
- a new turn completes,
- the execution run advances to the next verified Loop step.

Do not reset merely because a replacement page loaded.

After three consecutive recoveries that each lead back to another stall, use clean-chat rollover.

## 10. Clean-chat rollover fallback

Clean-chat rollover is a last-resort continuation path, not the primary recovery path.

It is used when:

- no concrete conversation id exists,
- same-chat recovery reached the consecutive recovery ceiling,
- the exact conversation cannot be reopened safely,
- the run explicitly requires a new conversation because of a product-level context limit.

The rollover command is Core-owned and must preserve:

- execution run id,
- approved plan,
- loop mode,
- verified progress summary,
- repository/workspace continuity where applicable.

For managed execution runs, the new chat belongs to the Execution Window.

No global `localStorage` pending payload may be used as cross-tab authority.

## 11. Auto-Loop state model

Auto-Loop state must be separable from page-local rendering state.

At minimum the transferable Loop snapshot contains:

- mode: `standard` or `infinite`,
- completed/sent Loop turn count,
- last reason/status,
- recent repetition fingerprints if still required,
- execution run id when managed,
- recovery generation.

Page-local timers and DOM references are never transferred.

The service worker/Core stores only the semantic state necessary to resume. A newly bound document reconstructs timers after proving current page state.

## 12. Worker browser lifecycle

### 12.1 Separation from main execution

Workers stay in the Agent Window and never use the Execution Window unless the user explicitly opens a worker conversation manually.

### 12.2 Safe cleanup boundary

The default cleanup policy is not `close immediately after text insertion`.

The worker tab closes after the system has durable evidence that the browser view is no longer needed for the current worker activation, such as:

- the worker called `finish` and entered sleeping/terminal state,
- the app durably reconciled a settled final assistant turn and placed the worker into sleeping state,
- a failed bootstrap/revival was durably acknowledged and the tab is still proven to belong to that failed command.

The close operation must re-prove tab ownership immediately before `chrome.tabs.remove`.

Closing a worker tab is presentation cleanup only. It must not be interpreted as proof that the model turn stopped.

### 12.3 Optional future fast-close mode

Closing a worker immediately after bootstrap send may be evaluated later if live tests prove that server-side execution, MCP calls, finish delivery, and recovery remain reliable without the tab.

It is not the default in this design because correctness is more important than saving a tab a few seconds earlier.

## 13. Extension state-machine hardening

The current `content.js` behavior contains overlapping state for Auto-Loop, Goal, compaction, bootstrap/revival, recorder takeover, and navigation.

The implementation should isolate these responsibilities into explicit state/transition helpers even if the physical file split is incremental.

Required invariants include:

1. A worker conversation cannot emit an automatic compaction claim.
2. Compaction cannot submit while local tools are running or tool state is unverifiable.
3. A composer change between validation and send aborts the autonomous send.
4. A redeemed bootstrap cannot send after SPA navigation retargets the tab.
5. A recorder takeover/superseding document invalidates old-document send authority.
6. A recovery/rollover cannot be consumed by a different conversation or tab.
7. A stale navigation epoch cannot apply async results to the current route.
8. Goal and Auto-Loop cannot independently submit conflicting user messages for the same turn.
9. Revival remains at-least-once until its irreversible send ACK is durable, but never double-types the same payload.
10. Hidden tabs remain supported where required without making hidden status itself an authority signal.

The existing `content-script.test.ts` failures must be classified into obsolete test contracts versus genuine invariant regressions. Genuine invariant regressions are release blockers.

## 14. Terminal ownership correction

The documented architecture says the authenticated MCP endpoint is the authority boundary for Core terminal sessions and conversation identity is attribution.

The current WIP changed `execOwnershipDenied` toward per-conversation authorization while comments and architecture still specify shared authenticated authority.

This design restores the documented behavior:

- an authenticated Core caller may continue a live Core terminal session,
- conversation ownership remains recorded for attribution and workspace transfer,
- browser presence is never required to authorize terminal continuation.

If a future security model requires per-conversation terminal authority, it must first define a durable explicit ownership-transfer protocol for Compact & Resume, browserless calls, phone control, and execution-run replacement.

## 15. Bridge protocol compatibility

The full-suite regression where an incompatible or impossible browser header receives HTTP 200 instead of the expected compatibility rejection must be fixed.

Rules:

- retain the last known-good telemetry snapshot only as presentation data,
- never let stale telemetry relax protocol admission,
- partial/invalid/incompatible hello or telemetry headers must not overwrite good telemetry,
- protocol incompatibility must retain the documented HTTP compatibility response.

## 16. All Computer state-machine correction

`config.allComputer` is the only authority for whether All Computer mode is active.

The renderer must not infer active All Computer mode merely because every current root happens to be a drive root.

Rules:

1. Enabling All Computer snapshots the previous roots once and replaces current roots with detected system drive roots.
2. Disabling restores the saved roots and clears the snapshot.
3. Manually removing or modifying a drive while All Computer is active exits the mode explicitly and must not leave the UI claiming it is still active.
4. The UI button label/action must always match the backend state.
5. Full-drive access should show clear confirmation/permission language before final release.

## 17. English-only first-party product policy

All first-party user-visible and developer-authored project text touched by this work must be English.

This includes:

- prompts,
- UI labels,
- tooltips,
- status reasons,
- error text authored by Chat On Steroids,
- source comments,
- first-party documentation,
- test descriptions and first-party fixtures.

Turkish-specific continuation/decision heuristics should be removed rather than translated into another hidden locale-specific policy.

If locale robustness must be tested, prefer language-neutral DOM/product signals. A non-English third-party fixture is allowed only when the test explicitly verifies parsing of third-party localized content and the fixture is isolated as external sample data; it must not leak into product prompts or messages.

## 18. Persistence and crash consistency

Execution and recovery must follow the same durability discipline already used by Agent System 3.0 and orchestration journaling.

General ordering rule:

`persist semantic ownership/state -> perform irreversible browser side effect -> persist/ACK result`

Examples:

- persist execution run before opening its browser bootstrap,
- persist recovery transaction before navigating the target tab,
- persist command sent evidence before allowing marker reuse to disappear,
- persist worker finish/sleep evidence before closing a managed worker tab,
- do not delete pending work based only on an offered tool result.

Recovery from a process or service-worker restart must not manufacture a duplicate irreversible send.

## 19. Security and fail-closed behavior

1. Browser marker ids are correlation ids, not credentials.
2. Pairing/authentication tokens never enter ChatGPT page content or model-visible prompts.
3. Full execution plans stay in Core until an authenticated browser command redeems them.
4. Wrong tab, wrong conversation, wrong document, stale epoch, or ambiguous ownership means no autonomous send.
5. A user draft always wins over autonomous insertion.
6. Unrelated browser tabs are never closed or moved based on weak URL matching.
7. Full-drive access remains explicit permission state, not a heuristic.

## 20. Testing strategy

Implementation is test-driven.

### 20.1 New execution-run tests

Cover:

- remote `start` durably creates a run before browser opening,
- start returns failure when Core/browser launch cannot be accepted,
- phone/control caller may disconnect after durable acceptance without stopping the run,
- bootstrap carries only a marker in the URL and retrieves the plan through Core,
- bootstrap sends once and binds the real conversation,
- pause/resume/stop are idempotent and execution-id scoped.

### 20.2 Recovery tests

Cover:

- exact source URL is reopened byte-for-byte,
- no `cos_*` recovery parameters are added,
- recovery state is target-tab scoped,
- unrelated ChatGPT tab cannot consume recovery state,
- wrong conversation/document/epoch fails closed,
- old tab closes only after replacement-ready ACK,
- replacement failure leaves old tab alone,
- recovery count survives new tabs/service-worker sleep,
- three consecutive failed recoveries trigger clean-chat rollover,
- genuine post-recovery progress resets the consecutive counter,
- already-generating recovered chat does not receive a duplicate continuation.

### 20.3 Managed-window tests

Cover:

- execution commands route to Execution Window,
- workers route to Agent Window,
- ordinary user tabs are not moved,
- managed windows are recreated after browser restart,
- recovery stays with the managed execution window when appropriate.

### 20.4 Worker lifecycle tests

Cover:

- worker tab remains open while its browser view is still required,
- durable worker finish/sleep closes only the proven owned tab,
- navigation away releases ownership instead of closing unrelated content,
- failed ACK does not incorrectly close a live worker,
- queue/budget drains after safe close.

### 20.5 Existing invariant suites

Restore all genuine failures in:

- `content-script.test.ts`,
- `extension.test.ts`,
- `bridge.test.ts`,
- `agent-tab-lifecycle.test.ts`,
- agent/swarm/continuation suites,
- workspace/terminal ownership tests,
- renderer/IPC/All Computer tests.

Desktop-native tests that genuinely require unavailable Windows capture/UIA handles may remain environment-classified only if their product logic is independently covered and the failure is explicitly documented.

### 20.6 Final verification gate

Before declaring the implementation complete:

1. `npm run typecheck`
2. targeted new/changed tests
3. `git diff --check`
4. full `npm test`
5. English-only source scan
6. review of remaining skips/environment failures
7. manual live smoke test of remote execution, same-chat recovery, and worker cleanup in Chrome

## 21. Migration and compatibility

Existing installations may contain legacy page-local Auto-Loop pending state.

Migration behavior:

- do not trust legacy global `cos_autoloop_pending` as authority,
- clear or ignore it safely after upgrade,
- do not resume a Loop solely because a stale origin-wide localStorage value exists,
- existing ordinary open chats remain untouched,
- existing agent durable state remains governed by the current broker/bridge recovery rules.

No user data migration should require rewriting existing ChatGPT conversation URLs.

## 22. Implementation boundaries

Expected primary areas of change:

- Core MCP execution control surface,
- durable execution-run store/types,
- browser command/bootstrap payloads,
- `src/main/browser.ts` and opener routing where needed,
- bridge command types and recovery state,
- `extension/background.js`,
- `extension/agent-tab-lifecycle.js`,
- `extension/content.js`,
- tests covering those surfaces,
- terminal ownership correction,
- All Computer renderer/IPC state correction,
- English-only cleanup.

Avoid unrelated orchestration redesign. Existing Agent System 3.0 durable review delivery and torn-tail journal repair should remain intact.

## 23. Delivery sequence

Implementation should be staged so each tranche has a coherent safety boundary.

### Tranche A: release blockers and state isolation

- classify current content-script failures,
- restore navigation/document/composer/local-tool invariants,
- remove global pending recovery authority,
- introduce target-tab recovery transaction state,
- implement durable recovery counter,
- exact-URL same-chat replacement,
- old-tab close-after-ready.

### Tranche B: remote execution control plane

- durable execution run model,
- Core start/status/pause/resume/stop surface,
- execution bootstrap command,
- automatic Loop activation and binding,
- phone/control disconnect independence.

### Tranche C: browser organization and worker cleanup

- managed Execution Window,
- managed Agent Window,
- safe worker close boundary,
- queue/budget lifecycle integration.

### Tranche D: architecture consistency and UX

- terminal authority correction,
- bridge protocol regression,
- All Computer state correction and permission UX,
- English-only cleanup.

### Tranche E: full verification and contribution preparation

- targeted verification,
- full-suite cleanup,
- live Chrome smoke tests,
- documentation/update handoff,
- isolate project changes from unrelated WIP,
- organize logical commits suitable for contribution to the original repository.

## 24. Acceptance criteria

The work is complete only when all of the following are true:

1. From an authenticated remote/phone ChatGPT surface, an approved plan can start a new autonomous desktop execution with one control request.
2. The plan is stored durably in Core before the browser is opened.
3. The phone may disconnect after acceptance and the desktop execution continues.
4. The desktop execution runs in a managed Execution Window.
5. Managed workers run in a separate Agent Window.
6. Worker tabs close safely after durable worker completion/sleep and do not accumulate indefinitely.
7. A stalled execution reopens the exact current conversation URL in a fresh tab.
8. Recovery restores Loop mode and turn state without global localStorage authority.
9. Another ChatGPT tab cannot consume or impersonate the recovery.
10. The old stalled tab closes only after the replacement proves readiness.
11. Three consecutive failed same-chat recoveries fall back to a clean chat; genuine progress resets the counter.
12. Auto-Loop, Goal, compaction, bootstrap, revival, and recorder takeover preserve their documented cross-chat safety invariants.
13. Authenticated Core terminal continuation remains compatible with browserless/phone/Compact & Resume workflows.
14. All Computer UI and backend always agree on active state.
15. Bridge protocol incompatibility is rejected correctly.
16. First-party project text in the changed scope is English-only.
17. Typecheck and all non-environment-specific tests pass.
18. Live browser smoke tests prove remote execution, stall recovery, managed-window routing, and worker cleanup.
19. Final commits contain no unrelated working-tree changes.
20. The resulting change set is ready to contribute to the original project repository.

## 25. Architectural decision summary

The system is organized into three explicit planes:

`Remote Planning / Control -> Durable Core Execution -> Browser Execution / Agents`

The phone is a control plane. Core is the durable authority and execution coordinator. Browser tabs are replaceable presentation/execution views whose identities must always be proven before autonomous writes or destructive cleanup.

Same-conversation recovery uses the exact conversation URL and out-of-band transaction state. Managed main executions and workers use separate Chrome windows within the same profile. Worker tabs close only after a durable safe lifecycle boundary. The system remains fail-closed when identity is ambiguous and continues to treat the authenticated MCP endpoint as the Core terminal authority boundary.
