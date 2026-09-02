# Agent System 3.0 — Manager Surface Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one broker-designated Manager conversation able to submit the V3 initial task graph through the existing `agents` MCP tool, with no model-supplied identity or run authority.

**Architecture:** Keep the V2 multi-agent broker as the authority for ChatGPT conversation identity and durable worker ownership. Add one durable `managerAgentId` designation to the broker, add a small orchestration bridge that derives `runId` and `managerAgentId` from the proven caller, and extend `agents` with `action=plan` instead of registering another Core tool. Initialize the orchestration store during normal app bootstrap before any connector can accept a Manager plan.

**Tech Stack:** TypeScript, Electron main process, Zod, existing MCP server/registrar, durable swarm broker, append-only orchestration journal, Vitest, GitHub Actions matrix.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-system-3-0-design.md`

## Global Constraints

- Prime remains the only user-facing orchestration participant.
- Exactly one Manager agent is designated for a V3 run; ordinary workers cannot acquire Manager authority by calling first.
- Caller identity comes from the existing proven ChatGPT conversation path. No `run_id`, `manager_agent_id`, key, token, or equivalent authority field is accepted from the model.
- Core remains a maximum-seven-live-schema surface. V3 planning extends `agents`; it does not register a new MCP tool.
- Existing V2 `spawn`, `message`, `status`, and `finish` behavior stays backward compatible.
- Graph validation, retry defaults, and durable journal ordering remain kernel-owned.
- This slice introduces no push, merge, deploy, or destructive external side effect.

---

### Task 1: Durable broker-owned Manager designation

**Files:**
- Modify: `src/main/agents.ts`
- Modify: `test/agents.test.ts`

**Interfaces:**
- Consumes: existing `SpawnInput`, `stageSpawn`, `Caller`, swarm snapshot/restore code.
- Produces:

```ts
export interface SpawnInput {
  workers: ReadonlyArray<{ label?: string; task: string; manager?: boolean }>;
  // existing fields unchanged
}

export function managerForCaller(caller: Caller): { runId: string; agentId: string };
```

Active and dormant broker state persist `managerAgentId: string | null`.

- [ ] **Step 1: Write failing broker tests**

Add focused tests that use real broker state:

```ts
it('durably designates exactly one spawned worker as Manager', () => {
  // Spawn from a proven prime with one { manager: true } worker, commit,
  // bind that worker conversation, then managerForCaller returns run/id.
});

it('refuses ordinary workers and the prime as Manager callers', () => {
  // managerForCaller(prime/ordinaryWorker) rejects.
});

it('restores Manager designation from a current-format swarm snapshot', () => {
  // Snapshot, restore, then the same bound Manager conversation retains authority.
});

it('rejects a spawn request that designates two Managers without publishing topology', () => {
  // Snapshot/state remains unchanged.
});
```

- [ ] **Step 2: Verify RED**

Run `test/agents.test.ts`. Expected: tests fail because Manager designation and `managerForCaller` do not exist.

- [ ] **Step 3: Implement minimal broker changes**

Rules:

- At most one `manager: true` worker may exist in a caller-owned run/history.
- The designation is the created worker id, never its label, array position, or first caller.
- `managerForCaller` requires an exact conversation id, resolves only that conversation's owned active/dormant run, and succeeds only when the resolved agent id equals `managerAgentId`.
- Persist `managerAgentId` in active and dormant snapshots.
- Bump the swarm snapshot version once. Restore the immediately previous version with `managerAgentId = null`; never invent Manager authority for legacy rows.

- [ ] **Step 4: Verify GREEN**

Run `test/agents.test.ts` and the existing agent recovery/snapshot tests. Existing spawn retry, wake, sleep, and identity behavior must remain green.

- [ ] **Step 5: Commit**

Commit the broker designation slice only.

---

### Task 2: Production orchestration-store bootstrap

**Files:**
- Modify: `src/main/index.ts`
- Modify: `test/runtime-enable-and-extension.test.ts`

**Interfaces:**
- Consumes: `initOrchestrationStore(userDataDir: string): void` from `src/main/orchestration/store.ts`.
- Produces: guarded primary-instance startup initializes the orchestration store before MCP tools can mutate V3 state.

- [ ] **Step 1: Write the failing startup wiring test**

Extend the existing source-order regression:

```ts
expect(source).toContain("from './orchestration/store.js'");
const orchestrationInit = source.indexOf('initOrchestrationStore(userData)');
const loadConfig = source.indexOf('await loadConfig()');
expect(orchestrationInit).toBeGreaterThanOrEqual(0);
expect(orchestrationInit).toBeLessThan(loadConfig);
```

- [ ] **Step 2: Verify RED**

Run `test/runtime-enable-and-extension.test.ts`. Expected: failure because production startup does not initialize the orchestration store.

- [ ] **Step 3: Implement minimal startup wiring**

```ts
import { initOrchestrationStore } from './orchestration/store.js';

initSessionStore(userData);
initDurableStore(userData);
initOrchestrationStore(userData);
await loadConfig();
```

The store remains lazy-writing; startup only supplies its root.

- [ ] **Step 4: Verify GREEN**

Run `test/runtime-enable-and-extension.test.ts` and typecheck.

- [ ] **Step 5: Commit**

Commit startup initialization and its regression test only.

---

### Task 3: Manager authority bridge into the orchestration kernel

**Files:**
- Create: `src/main/orchestration/manager-surface.ts`
- Create: `test/orchestration-manager-surface.test.ts`

**Interfaces:**
- Consumes: `managerForCaller(caller)`, `acceptInitialManagerPlan`, `ManagerTaskPlan`.
- Produces:

```ts
export interface ManagerPlanRequest {
  planId: string;
  tasks: ManagerTaskPlan[];
}

export async function acceptManagerPlanForCaller(
  caller: Caller,
  request: ManagerPlanRequest
): Promise<ManagerPlanAcceptance & { runId: string; managerAgentId: string }>;
```

- [ ] **Step 1: Write failing authority tests**

Use real broker and orchestration stores:

```ts
it('derives run and Manager identity from the proven broker caller', async () => {
  // Request contains only planId + tasks.
  // Recovered orchestration state records the broker run and designated Manager id.
});

it('refuses a prime or ordinary worker before writing orchestration events', async () => {
  // readOrchestrationEvents() remains empty.
});
```

- [ ] **Step 2: Verify RED**

Run the new test. Expected: missing `manager-surface` module / Manager authority helper.

- [ ] **Step 3: Implement minimal bridge**

```ts
export async function acceptManagerPlanForCaller(caller: Caller, request: ManagerPlanRequest) {
  const authority = managerForCaller(caller);
  const accepted = await acceptInitialManagerPlan({
    planId: request.planId,
    runId: authority.runId,
    managerAgentId: authority.agentId,
    tasks: request.tasks
  });
  return { ...accepted, runId: authority.runId, managerAgentId: authority.agentId };
}
```

No fallback authority path is allowed.

- [ ] **Step 4: Verify GREEN**

Run manager-surface, manager-plan, DAG, recovery, and store tests together.

- [ ] **Step 5: Commit**

Commit the authority bridge only.

---

### Task 4: Extend the existing `agents` MCP action with V3 `plan`

**Files:**
- Modify: `src/main/mcp/tools-core.ts`
- Modify: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `acceptManagerPlanForCaller`, existing `callerNow(startedAt)` exact-conversation proof.
- Produces: `agents action=plan` with model inputs `plan_id` and `tasks` only; output facts include `run_id`, `manager_agent_id`, `ready_task_ids`, and `repeated`.

- [ ] **Step 1: Write failing endpoint/schema tests**

Add real MCP endpoint assertions:

```ts
const agents = toolList(await core('tools/list')).find((tool) => tool.name === 'agents');
expect(agents).toBeDefined();
// action enum contains 'plan'; input properties contain plan_id and tasks.
// input properties do not contain run_id or manager_agent_id.

const forged = await core('tools/call', {
  name: 'agents',
  arguments: { action: 'plan', plan_id: 'p1', tasks: validTasks, run_id: 'forged' }
});
expect(failed(forged)).toBe(true);
```

The positive authority/materialization path is already proven with real broker state in Task 3; this task proves the public wire contract and strict authority-injection rejection.

- [ ] **Step 2: Verify RED**

Run the focused MCP tests. Expected: `plan` is absent from the action enum and plan fields do not exist.

- [ ] **Step 3: Implement minimal `agents` extension**

Extend, do not replace, the existing schema:

```ts
action: z.enum(['spawn', 'message', 'status', 'finish', 'plan'])
```

Add `plan_id` and structured task contracts. In `superRefine`, make plan fields valid only for `action=plan`, and reject existing action-only fields on plan calls. The plan handler branch is:

```ts
if (input.action === 'plan') {
  if (!input.plan_id || !input.tasks) return fail('agents action=plan requires plan_id and tasks.');
  const caller = await callerNow(startedAt);
  const accepted = await acceptManagerPlanForCaller(caller, {
    planId: input.plan_id,
    tasks: input.tasks
  });
  return {
    content: [{ type: 'text' as const, text: `Manager plan ${input.plan_id} accepted.` }],
    structuredContent: {
      action: 'plan',
      run_id: accepted.runId,
      manager_agent_id: accepted.managerAgentId,
      ready_task_ids: accepted.readyTaskIds,
      repeated: accepted.repeated
    }
  };
}
```

No input authority fields exist.

- [ ] **Step 4: Verify GREEN**

Run `test/mcp.test.ts`, Manager orchestration tests, `test/agents.test.ts`, and typecheck.

- [ ] **Step 5: Commit**

Commit the MCP exposure slice only.

---

### Task 5: Full verification and checkpoint hygiene

**Files:**
- Modify: PR #2 description after all code is green.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a reviewable draft PR whose description matches the implemented checkpoint.

- [ ] **Step 1: Run full verification**

Require the repository `verify:ci` matrix to finish successfully on Linux x64, macOS arm64, and Windows x64. Do not infer Windows success from another platform.

- [ ] **Step 2: Review the changed-file diff**

Verify:

- no new Core tool name;
- no model input authority fields;
- no Manager inference by label/order/recency;
- snapshot backward compatibility;
- no unrelated active WIP changes;
- no push/merge/deploy behavior.

- [ ] **Step 3: Update the draft PR body**

Replace the stale initial-RED description with the actual checkpoint: orchestration foundation, safe agent-tab lifecycle, Manager plan kernel, and broker-owned Manager surface bridge, plus fresh verification evidence.

- [ ] **Step 4: Stop at the draft PR**

Do not merge, mark ready, deploy, or modify `main` unless the user explicitly asks.
