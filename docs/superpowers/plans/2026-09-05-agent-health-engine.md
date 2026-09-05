# Agent Health Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure, system-derived Activity + Health projection for exact Chat On Steroids agents and expose it through Control Center V2 without changing broker lifecycle behavior or enabling automatic recovery.

**Architecture:** Shared health types live in `src/shared/agent-health.ts`; deterministic projection lives in `src/main/agent-health.ts`; narrowly-scoped read-only helpers in `agents.ts` and `bridge.ts` expose existing transfer/turn/command evidence without mutating lifecycle state. Control Center joins only exact run-owned broker rows, feeds immutable evidence into the evaluator, and serializes the result with `recoveryPolicy: 'off'`.

**Tech Stack:** TypeScript, Electron main process, Vitest, existing multi-agent broker/session recorder/bridge/orchestration modules.

**Spec:** `docs/superpowers/specs/2026-09-05-agent-health-engine-design.md`

## Global Constraints

- Do not add a persisted `AgentState`; existing stored `AgentInfo` must remain migration-free.
- No synthetic model heartbeat or new periodic heartbeat timer.
- Health evaluation must never call wake/sleep/fail/finish/process-termination or broker mutation APIs.
- Exact `conversationId` attribution is the only per-agent runtime ownership key; missing/conflicting identity fails closed.
- Reuse existing lifecycle clocks and exemptions: browser presence 60s, detached silence 5m, stale swarm 2m, transfer TTL 10m, claimed command deadline 90s, stale command TTL 30m.
- A running MCP call or open/generating ChatGPT turn must never be labeled stalled only because `lastSeenAt` is old.
- Sleeping page presence is not work evidence.
- Auto-recovery is represented only as `recoveryPolicy: 'off'` in this tranche; recommendations are advisory.
- Preserve the five pre-existing uncommitted WIP files (`extension/background.js`, `extension/chatgpt-dom.js`, `extension/content.js`, `test/content-script.test.ts`, `test/extension.test.ts`) and never include them in feature commits.

---

## File Structure

- Create `src/shared/agent-health.ts`: stable enums/interfaces used by Control Center and the future scheduler.
- Create `src/main/agent-health.ts`: pure evaluator plus small composition helpers; no lifecycle mutation imports.
- Create `test/agent-health.test.ts`: pure projection tests, including mutation guards and deadline semantics.
- Modify `src/main/agents.ts`: add one read-only Prime transfer evidence accessor.
- Modify `src/main/bridge.ts`: add one read-only exact-agent turn/command evidence accessor; reuse the existing command helpers/constants.
- Modify `src/shared/control-center.ts`: Control Center schema V2, health fields, and required recovery policy.
- Modify `src/main/orchestration/control-center.ts`: collect exact evidence, evaluate health, and serialize it.
- Modify `test/control-center.test.ts`: V2 serialization, exact attribution, blocked projection, default recovery policy.
- Modify `test/agents.test.ts` and `test/bridge.test.ts`: prove read-only evidence helpers preserve existing lifecycle semantics.

---

### Task 1: Shared Contract and Pure Health Evaluator

**Files:**
- Create: `src/shared/agent-health.ts`
- Create: `src/main/agent-health.ts`
- Create: `test/agent-health.test.ts`

**Interfaces:**
- Produces `AgentActivity`, `AgentHealth`, `AgentHealthRecommendedAction`, `AgentFiniteWaitEvidence`, `AgentHealthEvidence`, `AgentHealthSnapshot`.
- Produces `evaluateAgentHealth(input: AgentHealthInput, observedAt: number): AgentHealthSnapshot`.
- Later tasks supply evidence; this task must have no imports from `bridge.ts`, `agents.ts`, orchestration mutators, runtime GC, or process managers.

- [ ] **Step 1: Write the shared contract and failing evaluator tests**

Create `src/shared/agent-health.ts` with these exact public shapes:

```ts
import type { AgentInfo } from './session.js';

export type AgentActivity = 'starting' | 'working' | 'tool_call' | 'waiting' | 'sleeping' | 'done';
export type AgentHealth = 'healthy' | 'degraded' | 'stalled' | 'blocked' | 'unknown';
export type AgentHealthRecommendedAction = 'none' | 'observe' | 'wake' | 'retry_delivery' | 'user_attention';

export interface AgentFiniteWaitEvidence {
  kind: 'transfer' | 'delivery' | 'stale_command';
  startedAt: number;
  deadlineMs: number;
  exempt: boolean;
  recommendedAction: 'observe' | 'retry_delivery' | 'user_attention';
}

export interface AgentHealthEvidence {
  identity: 'exact' | 'missing' | 'conflict';
  browserPresent: boolean | null;
  runningToolCalls: number;
  generating: boolean;
  activeTurnId: boolean;
  workflowBlocked: boolean;
  finiteWait: AgentFiniteWaitEvidence | null;
}

export interface AgentHealthInput {
  id: string;
  broker: AgentInfo | null;
  evidence: AgentHealthEvidence;
}

export interface AgentHealthSnapshot {
  agentId: string;
  conversationId: string | null;
  activity: AgentActivity;
  health: AgentHealth;
  observedAt: number;
  lastSeenAt: number | null;
  recommendedAction: AgentHealthRecommendedAction;
  reason: string;
  evidence: {
    identity: AgentHealthEvidence['identity'];
    browserPresent: boolean | null;
    runningToolCalls: number;
    generating: boolean;
    activeTurnId: boolean;
    workflowBlocked: boolean;
    finiteWaitKind: AgentFiniteWaitEvidence['kind'] | null;
  };
}
```

In `test/agent-health.test.ts`, add fixtures for a complete `AgentInfo` and tests that assert:

```ts
expect(evaluateAgentHealth(input({ runningToolCalls: 1, generating: true }), NOW)).toMatchObject({
  activity: 'tool_call', health: 'healthy', recommendedAction: 'none'
});

expect(evaluateAgentHealth(input({ generating: true, browserPresent: false }, { lastSeenAt: NOW - 60 * 60_000 }), NOW)).toMatchObject({
  activity: 'working', health: 'healthy'
});

expect(evaluateAgentHealth(input({}, { state: 'detached', detachedAt: NOW - 60_000 }), NOW)).toMatchObject({
  health: 'degraded', recommendedAction: 'observe'
});

expect(evaluateAgentHealth(input({}, { state: 'sleeping' }), NOW)).toMatchObject({ activity: 'sleeping', health: 'healthy' });
expect(evaluateAgentHealth(input({}, { state: 'finished' }), NOW)).toMatchObject({ activity: 'done' });
expect(evaluateAgentHealth(input({ identity: 'missing' }), NOW)).toMatchObject({ health: 'unknown' });
expect(evaluateAgentHealth(input({ workflowBlocked: true, identity: 'missing' }), NOW)).toMatchObject({
  health: 'blocked', recommendedAction: 'user_attention'
});
```

Add finite-wait tests for a non-exempt wait before and after `startedAt + deadlineMs`, plus an exempt wait after the nominal deadline. Deep-freeze or JSON-clone the broker fixture before the call and assert it is unchanged afterward.

Add one timestamp-integrity test with `broker.lastSeenAt = NOW + 60_000` and no stronger open-work evidence; expect `health: 'degraded'`, `recommendedAction: 'observe'`, and a reason that says the first-hand liveness timestamp is invalid/future rather than treating it as elapsed-time proof.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run test/agent-health.test.ts --reporter verbose
```

Expected: FAIL because `src/main/agent-health.ts` / `evaluateAgentHealth` does not exist yet.

- [ ] **Step 3: Implement the minimal pure evaluator**

Create `src/main/agent-health.ts`. Implement activity priority exactly as:

```ts
function activityFor(input: AgentHealthInput): AgentActivity {
  const broker = input.broker;
  if (broker?.state === 'finished' || broker?.state === 'failed') return 'done';
  if (broker?.state === 'sleeping') return 'sleeping';
  if (input.evidence.runningToolCalls > 0) return 'tool_call';
  if (input.evidence.generating || input.evidence.activeTurnId) return 'working';
  if (broker?.state === 'invited') return 'starting';
  if (broker?.state === 'waking' || (broker?.pending ?? 0) > 0 || (broker?.awaitingAck ?? 0) > 0) return 'waiting';
  if (!broker) return 'waiting';
  return broker.state === 'active' || broker.state === 'detached' ? 'working' : 'waiting';
}
```

Implement health precedence exactly as:

1. `workflowBlocked` -> `blocked + user_attention`.
2. identity not `exact` -> `unknown + observe`.
3. open work (`runningToolCalls > 0 || generating || activeTurnId`) -> `healthy + none`, regardless of old `lastSeenAt` or missing browser.
4. terminal/sleeping states -> `healthy + none`.
5. non-exempt finite wait whose validated `startedAt` is not in the future and whose deadline is exceeded -> `stalled + finiteWait.recommendedAction`.
6. detached -> `degraded + observe`.
7. invalid broker `lastSeenAt` (`!Number.isFinite(lastSeenAt)` or `lastSeenAt > observedAt`) with no stronger open-work evidence -> `degraded + observe`; ignore the timestamp for elapsed reasoning and explain the invalid evidence.
8. active/invited/waking with `browserPresent !== true` and no stronger evidence -> `degraded + observe`; this covers both known browser absence and missing session/browser evidence without calling either case stalled.
9. otherwise -> `healthy + none`.

Reject invalid timing evidence conservatively: future/non-finite `startedAt` or non-positive/non-finite `deadlineMs` must not create stall; return `degraded + observe` with a reason describing invalid timing evidence.

All reason strings must describe evidence, not speculate about model intent. Example: `"Exact conversation has 1 MCP call still inside dispatch."`.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npx vitest run test/agent-health.test.ts --reporter verbose
npm run typecheck
git diff --check -- src/shared/agent-health.ts src/main/agent-health.ts test/agent-health.test.ts
```

Expected: all exit `0`.

- [ ] **Step 5: Commit Task 1 only**

```powershell
git add -- src/shared/agent-health.ts src/main/agent-health.ts test/agent-health.test.ts
git diff --cached --name-only
git commit -m "feat(health): add pure agent health projection"
```

Confirm the cached name list contains only those three files before committing.

---

### Task 2: Read-Only Runtime, Turn, Transfer, and Delivery Evidence

**Files:**
- Modify: `src/main/agents.ts` near `swarmTransferActive()` and `PrimeTransfer`
- Modify: `src/main/bridge.ts` near `chatIsWorking()`, command definitions, and command timeout helpers
- Modify: `src/main/agent-health.ts`
- Modify: `test/agents.test.ts`
- Modify: `test/bridge.test.ts`
- Modify: `test/agent-health.test.ts`

**Interfaces:**
- Produces `primeTransferHealthEvidence(conversationId: string): { startedAt: number; deadlineMs: number; frozen: boolean } | null` from `agents.ts`; this accessor must be read-only and must not clear expired transfer state.
- Produces `bridgeHealthEvidenceForAgent(agentId: string, conversationId: string | null, observedAt?: number): AgentBridgeHealthEvidence` from `bridge.ts`; the returned object carries the same exact ids so composition can reject mismatches.
- Produces `collectAgentHealthEvidence(...)` in `agent-health.ts` as a read-only composition helper around injected/read-only evidence functions.

- [ ] **Step 1: Add failing read-only evidence tests**

In `test/agents.test.ts`, create an active Prime transfer with `beginPrimeTransfer()` and assert the new accessor returns the exact `startedAt/frozen` values without changing `swarmState()` or clearing an expired transfer when called with a later wall clock.

In `test/bridge.test.ts`, add tests that prove:

```ts
expect(bridgeHealthEvidenceForAgent('worker-1', workerConversation)).toMatchObject({
  generating: true,
  activeTurnId: true
});
```

for an exact worker live turn, and that a different conversation stays false.

For commands, construct/drive the existing worker/revive command paths and assert the helper reports:

- queued ordinary worker/revive command -> `finiteWait.kind === 'stale_command'`, `deadlineMs === COMMAND_TTL_MS` semantics;
- claimed ordinary delivery -> `finiteWait.kind === 'delivery'`, deadline uses the existing 90-second `COMMAND_DEADLINE_MS` semantics;
- `waitingForRevivalReadiness(command) === true` -> returned finite wait is `exempt: true` rather than expired/stalled.

Do not inspect private command arrays from the test by new test-only mutation APIs; drive the same public bridge test seams already used by nearby command lifecycle tests.

- [ ] **Step 2: Run tests and verify RED**

```powershell
npx vitest run test/agents.test.ts test/bridge.test.ts test/agent-health.test.ts -t "health evidence|transfer health|command health" --reporter verbose
```

Expected: FAIL because the read-only accessors do not exist.

- [ ] **Step 3: Implement the read-only Prime transfer accessor**

In `src/main/agents.ts`, add:

```ts
export interface PrimeTransferHealthEvidence {
  startedAt: number;
  deadlineMs: number;
  frozen: boolean;
}

export function primeTransferHealthEvidence(conversationId: string): PrimeTransferHealthEvidence | null {
  if (!conversationId || run?.primeConversationId !== conversationId) return null;
  const transfer = run.transfer;
  if (!transfer || transfer.from !== conversationId) return null;
  return { startedAt: transfer.at, deadlineMs: TRANSFER_TTL_MS, frozen: transfer.frozen };
}
```

This function must not call `swarmTransferActive()`, `transferExpired()`, `changed()`, or mutate `run.transfer`.

- [ ] **Step 4: Implement the read-only bridge evidence accessor**

In `src/main/bridge.ts`, export:

```ts
export interface AgentBridgeHealthEvidence {
  agentId: string;
  conversationId: string | null;
  browserPresent: boolean;
  generating: boolean;
  activeTurnId: boolean;
  finiteWait: AgentFiniteWaitEvidence | null;
}

export function bridgeHealthEvidenceForAgent(
  agentId: string,
  conversationId: string | null,
  observedAt = Date.now()
): AgentBridgeHealthEvidence
```

Implementation rules:

```ts
const live = conversationId
  ? liveConversations().find((entry) => entry.conversationId === conversationId)
  : null;

const matchingCommands = commands.filter((command) =>
  command.spec.type === 'worker'
    ? command.spec.agent === agentId
    : command.spec.type === 'revive'
      ? command.spec.agent === agentId && command.spec.conversationId === conversationId
      : false
);
```

Choose the newest relevant command by `createdAt`, then derive `finiteWait` without changing it:

- if `waitingForRevivalReadiness(command)` -> delivery/stale evidence with `exempt: true`;
- else if `command.claimedAt !== null` -> `{ kind: 'delivery', startedAt: command.claimedAt, deadlineMs: COMMAND_DEADLINE_MS, exempt: false, recommendedAction: 'retry_delivery' }`;
- else -> `{ kind: 'stale_command', startedAt: command.createdAt, deadlineMs: COMMAND_TTL_MS, exempt: false, recommendedAction: 'retry_delivery' }`.

Return the input `agentId` and `conversationId` unchanged together with `browserPresent: browserPresent()`, `generating: Boolean(live?.generating)`, and `activeTurnId: Boolean(live?.activeTurnId)`.

The helper must not call `drop`, `retire`, `persistCommands`, `claimWorkerRevival`, `sleepWorker`, or any command mutation function.

- [ ] **Step 5: Add a pure evidence-composition helper**

In `src/main/agent-health.ts`, add:

```ts
export interface CollectAgentHealthEvidenceInput {
  id: string;
  broker: AgentInfo | null;
  browser: AgentBridgeHealthEvidence | null;
  runningToolCalls: number;
  transfer: PrimeTransferHealthEvidence | null;
  workflowBlocked: boolean;
}

export function collectAgentHealthEvidence(input: CollectAgentHealthEvidenceInput): AgentHealthEvidence
```

Rules:

- no broker or no `conversationId` -> `identity: 'missing'`;
- browser evidence is only accepted when `browser.agentId === input.id` and `browser.conversationId === broker.conversationId`; any mismatch -> `identity: 'conflict'`;
- Prime transfer becomes `finiteWait: { kind: 'transfer', startedAt, deadlineMs: transfer.deadlineMs, exempt: frozen, recommendedAction: 'observe' }`;
- otherwise use bridge `finiteWait`;
- exact running tool count is passed through unchanged.

- [ ] **Step 6: Run focused evidence tests and regression tests**

```powershell
npx vitest run test/agent-health.test.ts test/agents.test.ts test/bridge.test.ts --reporter verbose
npm run typecheck
git diff --check -- src/main/agents.ts src/main/bridge.ts src/main/agent-health.ts test/agents.test.ts test/bridge.test.ts test/agent-health.test.ts
```

Expected: exit `0`; existing worker sleep/revival/command tests remain green.

- [ ] **Step 7: Commit Task 2 only**

```powershell
git add -- src/main/agents.ts src/main/bridge.ts src/main/agent-health.ts test/agents.test.ts test/bridge.test.ts test/agent-health.test.ts
git diff --cached --name-only
git commit -m "feat(health): expose read-only agent liveness evidence"
```

If a neutral constants file was required, include only that exact new file as well.

---

### Task 3: Control Center V2 Health Projection

**Files:**
- Modify: `src/shared/control-center.ts`
- Modify: `src/main/orchestration/control-center.ts`
- Modify: `test/control-center.test.ts`

**Interfaces:**
- Consumes `evaluateAgentHealth`, `collectAgentHealthEvidence`, `bridgeHealthEvidenceForAgent`, `primeTransferHealthEvidence`, and per-conversation `runningToolCalls`.
- Changes `CONTROL_CENTER_VERSION` from `1` to `2`.
- Extends every `ControlCenterAgentStatus` with `activity`, `health`, `recommendedAction`, and `healthReason`.
- Adds required top-level `recoveryPolicy: 'off'` to `ControlCenterStatus`.
- Keeps `projectControlCenterStatus()` pure by passing a precomputed immutable `ReadonlyMap<string, AgentHealthEvidence>` into it; only `controlCenterStatus()` reads live bridge/MCP/transfer evidence.

- [ ] **Step 1: Update Control Center tests first**

In `test/control-center.test.ts`, extend the hoisted loaders and module mocks so the live `controlCenterStatus()` wrapper can supply deterministic health evidence without real browser/session state:

```ts
const loaders = vi.hoisted(() => ({
  recover: vi.fn(),
  workflow: vi.fn(),
  runtime: vi.fn(),
  swarmForCaller: vi.fn(),
  browserPresent: vi.fn(),
  browserTelemetry: vi.fn(),
  bridgeHealth: vi.fn(),
  runningToolCalls: vi.fn(),
  transferHealth: vi.fn()
}));
```

Mock the new read-only functions only for `controlCenterStatus()` integration tests; do not mock `evaluateAgentHealth` itself for pure projection tests.

Update the idle status expectation to:

```ts
expect(status).toMatchObject({
  version: 2,
  recoveryPolicy: 'off',
  agents: []
});
```

Add exact tests for:

1. pure projector supplied an exact evidence map with `runningToolCalls=1` -> agent row contains `activity: 'tool_call', health: 'healthy'`;
2. pure projector supplied exact evidence with old `lastSeenAt` + `generating=true` + browser absent -> `working + healthy`;
3. broker-less orchestration worker/reviewer -> `health: 'unknown'`, never joined to an unrelated swarm row;
4. task/workflow blocker attached to assigned/reviewer agent -> `health: 'blocked', recommendedAction: 'user_attention'`;
5. `recoveryPolicy` is always `'off'` for idle and running status;
6. JSON serialization round-trip preserves the V2 fields;
7. the live `controlCenterStatus()` wrapper calls bridge/tool/transfer readers only for the exact broker rows returned by `swarmStateForCaller()` and passes the resulting evidence map to the projector.

- [ ] **Step 2: Run Control Center tests and verify RED**

```powershell
npx vitest run test/control-center.test.ts --reporter verbose
```

Expected: FAIL on version/field/evidence projection assertions.

- [ ] **Step 3: Upgrade the shared Control Center schema to V2**

In `src/shared/control-center.ts`:

```ts
import type {
  AgentActivity,
  AgentHealth,
  AgentHealthRecommendedAction
} from './agent-health.js';

export const CONTROL_CENTER_VERSION = 2 as const;
```

Extend `ControlCenterAgentStatus`:

```ts
activity: AgentActivity;
health: AgentHealth;
recommendedAction: AgentHealthRecommendedAction;
healthReason: string;
```

Extend `ControlCenterStatus`:

```ts
recoveryPolicy: 'off';
```

- [ ] **Step 4: Wire health evaluation into Control Center**

In `src/main/orchestration/control-center.ts`:

- import `runningToolCalls` from `../mcp/call-context.js`;
- import `bridgeHealthEvidenceForAgent` from `../bridge.js`;
- import `primeTransferHealthEvidence` from `../agents.js`;
- import `collectAgentHealthEvidence` and `evaluateAgentHealth` from `../agent-health.js`.

Add an optional final parameter to the pure projector:

```ts
export function projectControlCenterStatus(
  state: OrchestrationState,
  workflowState: RunWorkflowState | null,
  swarm: SwarmState,
  observedAt: number,
  browserTelemetry: BrowserAgentTabTelemetry | null = null,
  agentEvidence: ReadonlyMap<string, AgentHealthEvidence> = new Map()
): ControlCenterStatus
```

Change `projectAgents(...)` so it receives `observedAt`, `agentEvidence`, and enough blocker context to compute `workflowBlocked` for each accumulator. The pure projector must not call bridge/MCP/transfer readers. For every accumulator, start from supplied evidence or a conservative default:

```ts
const baseEvidence = agentEvidence.get(id) ?? {
  identity: broker?.conversationId ? 'exact' : 'missing',
  browserPresent: null,
  runningToolCalls: 0,
  generating: false,
  activeTurnId: false,
  workflowBlocked: false,
  finiteWait: null
};
const projectedHealth = evaluateAgentHealth({
  id,
  broker,
  evidence: { ...baseEvidence, workflowBlocked: blockedAgentIds.has(id) || baseEvidence.workflowBlocked }
}, observedAt);
```

Add the four projection fields to the serialized agent row.

Derive `blockedAgentIds` structurally:

- for each projected task with one or more blockers, include its `assignedWorkerId` and `reviewerId` when non-null;
- if `workflow?.status === 'blocked'`, include `state.managerAgentId` when present;
- if the system-review blocker exists, include `workflow.systemReview.reviewerId` when present.

Do not infer blockers from text alone; use the same existing structural blocker/task/workflow records already used to build `ControlCenterBlocker[]`.

Then update only the live `controlCenterStatus()` wrapper to collect evidence for exact broker rows:

```ts
const evidenceByAgent = new Map<string, AgentHealthEvidence>();
for (const brokerAgent of broker.agents) {
  const bridge = bridgeHealthEvidenceForAgent(brokerAgent.id, brokerAgent.conversationId, observedAt);
  evidenceByAgent.set(brokerAgent.id, collectAgentHealthEvidence({
    id: brokerAgent.id,
    broker: brokerAgent,
    browser: bridge,
    runningToolCalls: brokerAgent.conversationId ? runningToolCalls(brokerAgent.conversationId) : 0,
    transfer: brokerAgent.role === 'prime' && brokerAgent.conversationId
      ? primeTransferHealthEvidence(brokerAgent.conversationId)
      : null,
    workflowBlocked: false
  }));
}
```

Pass `evidenceByAgent` into `projectControlCenterStatus(...)`. Add `recoveryPolicy: 'off'` to both idle and running `ControlCenterStatus` results.

- [ ] **Step 5: Run Control Center + health focused suite**

```powershell
npx vitest run test/control-center.test.ts test/agent-health.test.ts --reporter verbose
npm run typecheck
git diff --check -- src/shared/control-center.ts src/main/orchestration/control-center.ts test/control-center.test.ts
```

Expected: exit `0`.

- [ ] **Step 6: Commit Task 3 only**

```powershell
git add -- src/shared/control-center.ts src/main/orchestration/control-center.ts test/control-center.test.ts
git diff --cached --name-only
git commit -m "feat(control-center): expose agent health status"
```

---

### Task 4: Safety Invariants and Integrated Verification

**Files:**
- Modify: `test/agent-health.test.ts`
- Modify: `test/control-center.test.ts` only if the Control Center static invariant needs its own assertion; otherwise keep the invariant in `test/agent-health.test.ts`.
- No production file should change unless a failing invariant proves a real defect.

**Interfaces:**
- Verifies the public contract from Tasks 1-3.
- Produces no new runtime behavior.

- [ ] **Step 1: Add static/no-side-effect invariant tests**

Add a source-level test in `test/agent-health.test.ts` that reads `src/main/agent-health.ts` and asserts it does not contain direct imports/calls matching lifecycle mutation/process termination APIs:

```ts
for (const forbidden of [
  'wake(', 'sleepWorker(', 'finishAgent(', 'failAgent(', 'terminateProcess(',
  'terminateProcessIfUnusedSince(', 'process.kill', 'taskkill', 'setInterval('
]) {
  expect(source).not.toContain(forbidden);
}
```

Use precise tokens that match real call sites rather than broad words such as `fail`, so comments/type names do not create false failures.

Also assert `src/main/orchestration/control-center.ts` does not import worker lifecycle mutation functions for health projection.

- [ ] **Step 2: Run the complete focused feature regression suite**

```powershell
npx vitest run test/agent-health.test.ts test/control-center.test.ts test/agents.test.ts test/bridge.test.ts test/runtime-gc.test.ts test/call-context.test.ts --reporter verbose
```

Expected: all files pass; existing GC, detached-silence, revival, browser-presence and call-context semantics remain green.

- [ ] **Step 3: Run fresh full repository verification**

Run in this exact order:

```powershell
npm test
npm run typecheck
npm run build
git diff --check
```

Do not call the feature complete unless each command returns exit `0`. If full-suite failures occur outside the feature diff, reproduce them in isolation before classifying them as environmental/flaky; do not handwave them.

- [ ] **Step 4: Verify dirty-WIP preservation and feature diff**

```powershell
git status --short
git diff --name-only HEAD~3..HEAD
```

Expected uncommitted files remain exactly the pre-existing WIP set:

```text
extension/background.js
extension/chatgpt-dom.js
extension/content.js
test/content-script.test.ts
test/extension.test.ts
```

Feature commits must not contain those files.

- [ ] **Step 5: Commit only any final test-only invariant additions**

If Step 1 created uncommitted test changes after Task 3, commit only those test files:

```powershell
git add -- test/agent-health.test.ts test/control-center.test.ts
git diff --cached --name-only
git commit -m "test(health): lock agent health safety invariants"
```

If Step 1 required no new changes, skip this commit rather than creating an empty commit.

- [ ] **Step 6: Final completion evidence**

Record in the completion report:

- exact final branch + HEAD;
- focused suite file/test counts;
- full `npm test` file/test counts;
- typecheck/build/diff-check exit codes;
- confirmation that Control Center is V2 with `recoveryPolicy: 'off'`;
- confirmation that health evaluator contains no recovery/lifecycle/process side effects;
- confirmation that the five pre-existing WIP files remain untouched.
