# Agent Health Engine Design Specification

## Goal

Add a system-derived health projection for Chat On Steroids agents that makes real execution state observable to Control Center and future scheduling logic without changing the existing broker lifecycle semantics.

The health layer must distinguish what an agent is doing from whether its current condition is healthy. It must use only evidence already owned by the app and must not ask models to emit synthetic heartbeat messages.

## Approved product policy

- The first version is observer-first.
- Automatic recovery is supported as a future policy surface but is **off by default**.
- Health evaluation itself never performs recovery, revival, sleeping, failure, process termination, or broker mutation.
- Health is projected from existing broker, MCP, bridge/session, browser, and orchestration evidence.
- A long-running ChatGPT generation is not considered stalled merely because no tool call happened recently.
- Missing or ambiguous ownership fails closed to `unknown` rather than guessing.

## Why this is not a ping heartbeat protocol

The current system already records first-hand liveness through the exact conversation that issued a proven MCP call and through the conversation's own browser page reporting to the bridge. Both stamp `AgentInfo.lastSeenAt`. The bridge also has durable session evidence for `generating`, `activeTurnId`, completed outcomes, and durable quiescence.

Adding a model-generated periodic ping would create a weaker parallel authority:

- a model can be alive while unable to emit a ping,
- a tab can remain open while the model is sleeping,
- background throttling can delay timers,
- a synthetic ping says less than a proven MCP request or a durable open turn,
- a second heartbeat timer would conflict with existing stale-swarm and detached-worker clocks.

Therefore the health engine consumes existing evidence instead of creating a new liveness protocol.

## Two-axis model

Agent state is projected on two independent axes.

### Activity

`AgentActivity` is one of:

- `starting` — the agent is invited or otherwise in finite startup before a bound usable worker exists.
- `working` — the exact conversation has durable/live evidence that a ChatGPT turn is generating or open.
- `tool_call` — at least one exact-conversation MCP tool call is currently inside dispatch.
- `waiting` — the agent is in a finite delivery/revival/assignment state with no stronger active-work evidence.
- `sleeping` — the broker says the reusable worker is sleeping.
- `done` — the broker state is terminal (`finished` or `failed`).

The activity priority is deterministic:

1. terminal broker state -> `done`;
2. sleeping broker state -> `sleeping`;
3. exact-conversation running MCP call -> `tool_call`;
4. durable/live open ChatGPT turn -> `working`;
5. invited, waking, queued-delivery, or finite startup state -> `waiting` / `starting` as applicable;
6. otherwise use the broker lifecycle state conservatively rather than inventing work.

### Health

`AgentHealth` is one of:

- `healthy` — current evidence is internally consistent and no finite operation has exceeded its existing deadline.
- `degraded` — evidence is incomplete or one non-terminal liveness surface disappeared, but the system has not proven the agent is stuck.
- `stalled` — a finite operation with an already-defined system deadline has exceeded that deadline or entered an equivalent explicitly stale state.
- `blocked` — orchestration/workflow evidence proves progress requires an external decision or a failed/blocked gate.
- `unknown` — the system cannot safely join the relevant identity/evidence.

`Activity` and `Health` must not be collapsed. A worker can be `tool_call + healthy`, `waiting + stalled`, or `sleeping + healthy`.

## Projection output

Add `src/shared/agent-health.ts` for the stable read-model contract and `src/main/agent-health.ts` for evaluation. `AgentHealthSnapshot` must contain:

- agent id,
- exact conversation id when proven,
- projected activity,
- projected health,
- observed timestamp,
- last first-hand liveness timestamp,
- relevant evidence flags/counters needed to explain the projection,
- a human-readable reason suitable for diagnostics,
- `recommendedAction`.

`recommendedAction` is one of:

- `none`,
- `observe`,
- `wake`,
- `retry_delivery`,
- `user_attention`.

This is advice only. The evaluator must not execute the action.

## Architecture

### New projection module

Add `src/main/agent-health.ts` as a pure/side-effect-free health projection layer. Shared enums/types live in `src/shared/agent-health.ts` so Control Center and the future scheduler consume one contract without importing each other's implementation modules.

The main module exposes two boundaries:

- a pure `evaluateAgentHealth(agent, evidence, observedAt)` function used for deterministic state projection;
- a read-only evidence collector used by Control Center to gather exact-conversation runtime/session facts before evaluation.

The collector may add narrowly-scoped read-only bridge/session helpers where existing module-private state is the authority. It must not duplicate lifecycle clocks or mutate the source state while collecting evidence.

It receives already-resolved evidence rather than reaching into unrelated mutable subsystems where possible. Its dependencies are limited to immutable snapshots or read-only functions for:

- broker `AgentInfo`,
- per-conversation `runningToolCalls`,
- bridge/session turn evidence (`generating`, `activeTurnId`, durable terminal/quiescent information),
- browser-presence evidence when relevant,
- orchestration task/workflow blockers,
- existing finite-operation timestamps/deadlines.

The evaluator never calls:

- `wake`,
- `sleepWorker`,
- `finishAgent`,
- `fail*`,
- process termination APIs,
- broker mutation APIs.

### Control Center integration

Extend `ControlCenterAgentStatus` with the new activity/health projection and explanation fields. Control Center remains a read model; it joins the orchestration run to its exact broker ownership before projecting health, preserving the existing fail-closed identity boundary.

Increment `CONTROL_CENTER_VERSION` from 1 to 2 because the serialized status shape changes. Add a required top-level `recoveryPolicy: 'off'` field in V2 so the UI never implies that a recommendation has been executed.

### Scheduler integration boundary

The future Dynamic Worker Scheduler may consume `AgentHealthSnapshot` but does not become part of this feature. The contract is that scheduler policy can read the snapshot without reimplementing liveness inference.

### Timers

The health engine adds no periodic heartbeat timer.

Projection is refreshed by existing observation/control-center refresh paths and may be recomputed during the existing bridge maintenance cadence. The existing stale-swarm, browser-presence, detached-silence, and GC timers remain authoritative for their own lifecycle work.

## Evidence and threshold semantics

Health must reuse existing system deadlines instead of introducing independent magic timeouts.

### Browser presence

Use the existing `BROWSER_PRESENT_MS` semantics (60 seconds) for browser evidence freshness.

- Browser evidence disappearing may make an otherwise idle/ambiguous agent `degraded`.
- It must not produce `stalled` if a proven tool call or durable open turn still proves active work.
- Browser presence alone never proves a sleeping worker is working.

### Detached worker silence

Use `DETACHED_SILENCE_MS` (5 minutes).

- Before the broker threshold expires, a detached worker may be `degraded` with `recommendedAction=observe`.
- At the existing threshold, the broker's established logic may move it to `sleeping`.
- The health engine does not independently fail, sleep, or revive it.

### Durable quiescence

Use the existing `STALE_SWARM_MS` (2 minutes) durable inactivity rule.

- Durable quiescence is lifecycle proof owned by the bridge stale-swarm logic.
- Health may describe the resulting sleeping/done state, but does not create a duplicate timeout decision.
- A live `generating` or durable `activeTurnId` defeats quiescence and therefore defeats any health inference that the agent is stalled solely from elapsed time.

### Transfer timeout

Use the existing `TRANSFER_TTL_MS` (10 minutes) for finite, non-frozen transfer operations.

- A finite transfer that genuinely exceeds its existing deadline may project `stalled`.
- A frozen transfer is mid-commit and remains exempt according to existing lifecycle semantics.

### Command deadlines

Reuse both existing bridge command clocks according to their current meanings:

- `COMMAND_DEADLINE_MS` (90 seconds) is the finite deadline for a page that has claimed a command to redeem/type/report that delivery.
- `COMMAND_TTL_MS` (30 minutes) is the stale-command age for ordinary queued/restored command records.

Health must not collapse these into one timeout. A claimed delivery that exceeds its 90-second deadline may project `waiting + stalled` and recommend `retry_delivery` or `user_attention`; an ordinary queued/restored command that exceeds the 30-minute TTL may also project stalled/stale according to the same lifecycle decision the bridge already makes. Exact revival states that are intentionally exempt from wall-clock expiry remain exempt in health too.

### Workflow blockers

If durable orchestration/workflow state is `BLOCKED`, or integration/verification/system-review evidence produces an existing blocker, project `health=blocked` and `recommendedAction=user_attention`.

Blocked workflow evidence outranks generic degraded liveness descriptions because it is a proven reason that progress cannot continue.

## Auto-recovery policy

The product option selected is hybrid:

- default behavior: observer-only;
- future optional behavior: automatic recovery can be enabled explicitly;
- health evaluation remains pure regardless of policy.

The first implementation must expose the policy as disabled and must not wire automatic side effects. The purpose is to establish the safe health contract first. A later recovery-policy task can consume recommendations through explicit user configuration and separate durability/idempotency rules.

## Safety invariants

1. **No synthetic model heartbeat.** Models are not asked to prove liveness on a timer.
2. **No health-driven lifecycle mutation.** Projection cannot wake, sleep, fail, finish, or terminate an agent.
3. **No elapsed-time stall on open work.** An open/generating turn or exact running tool call cannot be labeled stalled merely because `lastSeenAt` is old.
4. **Exact ownership only.** Per-conversation MCP evidence is used only after exact identity attribution; unknown ownership yields `unknown` or conservative global diagnostics, never a guessed agent state.
5. **Existing deadlines are authoritative.** Health reuses current lifecycle deadlines and exemptions instead of inventing parallel timeout clocks.
6. **Sleeping page evidence stays non-work evidence.** An open sleeping worker tab does not change activity to working.
7. **Projection is reproducible.** Given the same evidence snapshot and `observedAt`, the result is deterministic.
8. **Control Center remains read-only.** Rendering health cannot mutate broker/orchestration state.
9. **Recovery defaults off.** Recommendations are not actions.

## Error handling

- Missing broker identity for a projected orchestration agent -> `health=unknown` unless durable workflow state independently proves `blocked`.
- Missing session evidence while a broker worker is otherwise active -> conservative `degraded`, not `stalled`.
- Failed evidence lookup -> health projection records an explanation and fails closed without lifecycle mutation.
- Conflicting exact identities -> `unknown`; do not merge evidence from two conversations.
- Evidence timestamp in the future or otherwise invalid -> ignore that timestamp for elapsed calculations and mark the projection degraded/unknown as appropriate.

## Test matrix

Implementation must add focused tests that prove at least:

1. exact running MCP call projects `tool_call + healthy`;
2. running tool-call evidence outranks ordinary generating activity for the activity label;
3. durable/live generating or `activeTurnId` projects `working` and is not stalled solely by an old `lastSeenAt`;
4. loss of browser presence cannot create a false stall while tool/open-turn evidence remains;
5. detached worker before 5 minutes projects conservative degraded/observe behavior and remains broker-detached;
6. detached worker lifecycle after the existing 5-minute threshold remains owned by current broker logic rather than health mutation;
7. sleeping worker projects `sleeping` and an open page does not turn it into `working`;
8. finished/failed workers project `done`;
9. finite expired transfer can project stalled while frozen transfer cannot;
10. finite expired command/delivery can project stalled while exempt revival readiness retains existing semantics;
11. durable workflow/integration/verification/system-review blocker projects `blocked + user_attention`;
12. exact conversation attribution prevents one worker's tool call from marking another worker active;
13. unknown/conflicting ownership fails closed to `unknown`;
14. health evaluation does not mutate `AgentInfo`, orchestration state, queues, or process state;
15. Control Center serializes the new health/activity/reason/recommendation fields correctly;
16. recovery policy is reported as off by default;
17. health evaluator has no direct recovery or termination dependency/call path.

## Compatibility and migration

- Do not add a new persisted lifecycle state to `AgentState`.
- Existing stored `AgentInfo` remains valid without migration.
- Increment Control Center shared schema/version to V2. V2 adds agent health/activity fields plus required `recoveryPolicy: 'off'`; tests must assert the exact serialized contract.
- Existing stale-swarm, detached-worker, revival, browser-presence, and Agent Runtime GC semantics must remain unchanged.

## Out of scope for this tranche

- CPU/RAM/resource measurement per worker (#2 roadmap item).
- Dynamic capacity decisions or worker scheduling (#1 roadmap item).
- Automatic process restart or browser-tab replacement.
- User-configurable health thresholds independent of existing lifecycle constants.
- New model-visible heartbeat tool calls.
- Arbitrary OS-process liveness inference.
- Manager/worker hierarchy changes (#7 roadmap item).

## Completion criteria

The feature is complete when:

- the pure health projection exists and is covered by focused tests;
- Control Center exposes the projection for exact run-owned agents;
- no existing lifecycle behavior changes unexpectedly;
- auto-recovery is demonstrably disabled by default;
- focused tests, full test suite, typecheck, build, and diff check pass on the integrated tree.
