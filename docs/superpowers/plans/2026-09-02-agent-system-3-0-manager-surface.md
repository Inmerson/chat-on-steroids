# Agent System 3.0 — Manager Surface Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one broker-designated Manager conversation able to submit the already-defined V3 initial task graph through the existing `agents` MCP tool, with no model-supplied identity or run authority.

**Architecture:** Keep the V2 multi-agent broker as the authority for ChatGPT conversation identity and durable worker ownership. Add one durable `managerAgentId` designation to the broker, expose a small orchestration bridge that derives `runId` and `managerAgentId` from the proven caller, and extend the existing `agents` schema with `action=plan` rather than adding another Core tool. Initialize the orchestration store during normal app bootstrap before any connector can accept a Manager plan.

**Tech Stack:** TypeScript, Electron main process, Zod, existing MCP server/registrar, existing durable swarm broker, append-only orchestration journal, Vitest, GitHub Actions matrix.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-system-3-0-design.md`

## Global Constraints

- Prime remains the only user-facing orchestration participant.
- Exactly one Manager agent is designated for the V3 run; ordinary workers cannot acquire Manager authority by calling first.
- Caller identity is derived from the existing proven ChatGPT conversation path; no `run_id`, `manager_agent_id`, key, token, or equivalent authority field is accepted from the model.
- Core remains a maximum-seven-live-schema surface. V3 planning extends `agents`; it does not register a new MCP tool.
- Existing V2 `spawn`, `message`, `status`, and `finish` behavior remains backward compatible.
- Orchestration graph validation and journal write-before-publish semantics remain owned by the kernel.
- No push, merge, deployment, destructive user action, or production side effect is introduced by this slice.

---

### Task 1: Durable broker-owned Manager designation

**Files:**
- Modify: `src/main/agents.ts`
- Modify: `test/agents.test.ts`

**Interfaces:**
- Consumes: existing `SpawnInput`, `stageSpawn`, `Caller`, swarm snapshot/restore code.
- Produces: `SpawnInput.workers[].manager?: boolean`; durable active/dormant `managerAgentId: string | null`; `managerForCaller(caller: Caller): { runId: string; agentId: string }` or equivalent exact-caller authority helper.

- [ ] **Step 1: Write failing broker tests**

Add focused tests proving:

```ts
it('durably designates exactly one spawned worker as Manager', () => {
  // spawn from a proven prime with one { manager: true } worker,
  // commit the staged spawn, bind that worker conversation,
  // and assert managerForCaller(managerConversation) returns the broker run/id.
});

it('refuses ordinary workers and the prime as Manager callers', () => {
  // same run, but managerForCaller(prime/ordinaryWorker) must reject.
});

it('restores Manager designation from the current swarm snapshot format', () => {
  // snapshot, restore, then the same bound Manager conversation retains authority.
});

it('rejects a spawn request that tries to designate two Managers', () => {
  // no topology mutation is published.
});
```

- [ ] **Step 2: Verify RED**

Run the focused agent suite through CI or the repository test command. Expected: failures because `manager` designation and `managerForCaller` do not exist.

- [ ] **Step 3: Implement minimal broker changes**

Required behavior:

```ts
export interface SpawnInput {
  workers: ReadonlyArray<{ label?: string; task: string; manager?: boolean }>;
  // existing fields unchanged
}

export function managerForCaller(caller: Caller): { runId: string; agentId: string } {
  // require exact conversation identity;
  // resolve only the caller-owned active/dormant run;
  // require managerAgentId to name that exact agent;
  // never infer from label, worker order, recent activity, or first caller.
}
```

Persist `managerAgentId` in active and dormant swarm snapshots. Bump the snapshot version once; restore the immediately previous format with `managerAgentId = null` so existing users do not gain invented authority.

- [ ] **Step 4: Verify GREEN**

Run `test/agents.test.ts` and snapshot/recovery-related agent tests. Existing spawn retry, wake, sleep, and identity tests must remain green.

- [ ] **Step 5: Commit**

Commit only the broker designation slice.

---

### Task 2: Production orchestration-store bootstrap

**Files:**
- Modify: `src/main/index.ts`
- Modify: `test/runtime-enable-and-extension.test.ts`

**Interfaces:**
- Consumes: `initOrchestrationStore(userDataDir: string): void` from `src/main/orchestration/store.ts`.
- Produces: normal Electron bootstrap always initializes `state/orchestration` before MCP tools can accept V3 state mutations.

- [ ] **Step 1: Write failing startup wiring test**

Extend the existing source-order regression test with assertions equivalent to:

```ts
const orchestrationInit = source.indexOf('initOrchestrationStore(userData)');
const loadConfig = source.indexOf('await loadConfig()');
expect(orchestrationInit).toBeGreaterThanOrEqual(0);
expect(orchestrationInit).toBeLessThan(loadConfig);
```

Also require the import to come from `./orchestration/store.js`.

- [ ] **Step 2: Verify RED**

Run `test/runtime-enable-and-extension.test.ts`. Expected: failure because production startup does not initialize the orchestration store.

- [ ] **Step 3: Implement minimal startup wiring**

In `src/main/index.ts`:

```ts
import { initOrchestrationStore } from './orchestration/store.js';

// inside the guarded primary-instance app.whenReady bootstrap:
initSessionStore(userData);
initDurableStore(userData);
initOrchestrationStore(userData);
await loadConfig();
```

No filesystem mutation beyond the store's existing lazy-write behavior is needed at startup.

- [ ] **Step 4: Verify GREEN**

Run the focused runtime wiring test and typecheck.

- [ ] **Step 5: Commit**

Commit only startup initialization and its regression test.

---

### Task 3: Manager authority bridge into the orchestration kernel

**Files:**
- Create: `src/main/orchestration/manager-surface.ts`
- Create or modify: `test/orchestration-manager-surface.test.ts`

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

Use real broker/orchestration state, not mocked authorization. Cover:

```ts
it('derives run and Manager identity from the proven broker caller', async () => {
  // request contains only planId + tasks;
  // persisted MANAGER_ASSIGNED uses the broker run and designated Manager id.
});

it('refuses a prime or ordinary worker before writing orchestration events', async () => {
  // readOrchestrationEvents() stays empty.
});
```

- [ ] **Step 2: Verify RED**

Expected: missing `manager-surface` bridge / missing broker manager authority.

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

Do not add fallback authority resolution.

- [ ] **Step 4: Verify GREEN**

Run manager-surface, manager-plan, DAG, recovery, and store tests together.

- [ ] **Step 5: Commit**

Commit the authority bridge separately.

---

### Task 4: Extend the existing `agents` MCP action with V3 `plan`

**Files:**
- Modify: `src/main/mcp/tools-core.ts`
- Modify: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `acceptManagerPlanForCaller`, existing `callerNow(startedAt)` exact-conversation proof.
- Produces: `agents action=plan` with model fields `plan_id` and `tasks` only; response includes accepted `run_id`, `manager_agent_id`, `ready_task_ids`, and `repeated` as output facts.

- [ ] **Step 1: Write failing MCP schema/endpoint tests**

Add real endpoint assertions proving:

```ts
// tool count/name stays unchanged: still one `agents` tool.
expect(toolNames(await core('tools/list'))).toContain('agents');

// schema/action accepts plan_id + task contracts.
// schema does NOT expose run_id or manager_agent_id as input properties.

// strict parser rejects attempted authority injection:
arguments: { action: 'plan', plan_id: 'p1', tasks: [...], run_id: 'forged' }
// => tool call rejected before orchestration mutation.
```

Add a focused handler-level positive test if the existing MCP identity fixture can bind a designated Manager deterministically; otherwise keep positive authority behavior in Task 3 and endpoint-test the public schema plus strict rejection here.

- [ ] **Step 2: Verify RED**

Expected: `plan` is not an accepted action and schema does not contain plan fields.

- [ ] **Step 3: Implement minimal `agents` extension**

Extend the existing schema rather than registering another tool:

```ts
action: z.enum(['spawn', 'message', 'status', 'finish', 'plan'])
```

Add `plan_id` and the structured task-contract array. In `superRefine`, make both plan fields valid only for `action=plan`; reject all existing action-specific fields on plan calls. The plan branch must:

```ts
const caller = await callerNow(startedAt);
const accepted = await acceptManagerPlanForCaller(caller, {
  planId: input.plan_id!,
  tasks: input.tasks!
});
```

No caller-supplied authority fields exist in the schema.

- [ ] **Step 4: Verify GREEN**

Run `test/mcp.test.ts`, orchestration manager tests, `test/agents.test.ts`, and typecheck.

- [ ] **Step 5: Commit**

Commit the MCP exposure slice.

---

### Task 5: Full verification and checkpoint hygiene

**Files:**
- Modify: PR #2 description only after code is green.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a reviewable draft PR whose description matches the actual checkpoint.

- [ ] **Step 1: Run full verification**

Run the repository `verify:ci` workflow on Linux x64, macOS arm64, and Windows x64. Require all jobs to finish successfully; do not infer Windows success from other platforms.

- [ ] **Step 2: Review the changed-file diff**

Check specifically for:

- no new Core tool name;
- no model input authority fields;
- no Manager inference by label/order/recency;
- snapshot backward compatibility;
- no unrelated active WIP changes;
- no push/merge/deploy behavior.

- [ ] **Step 3: Update the draft PR body**

Replace the stale initial-RED description with the real implemented checkpoint: foundation + safe agent-tab lifecycle + Manager plan kernel + broker-owned Manager surface bridge, plus current verification evidence.

- [ ] **Step 4: Stop at the draft PR**

Do not merge, mark ready, deploy, or modify `main` unless the user explicitly asks.
