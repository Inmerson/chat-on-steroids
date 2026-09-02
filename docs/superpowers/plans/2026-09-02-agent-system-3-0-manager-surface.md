# Agent System 3.0 — Manager Surface Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let exactly one Prime-authorized Manager conversation submit the V3 task graph through the existing `agents` MCP tool, without model-supplied identity or run authority.

**Architecture:** Keep `agents.ts` as the authority for exact ChatGPT conversation membership and worker ownership. Add a small durable Manager-authority layer keyed to a Prime-designated worker id; the first proven call from that worker durably locks the Manager conversation id, after which Compact & Resume of the Prime cannot transfer Manager authority. Generate a stable orchestration run id in this authority layer rather than reusing the broker's ephemeral run-incarnation UUID. Extend the existing `agents` registration through a registrar decorator, preserving the Core tool count and the existing V2 handler unchanged.

**Tech Stack:** TypeScript, Zod, existing MCP registrar, durable JSON state, append-only orchestration journal, Vitest, GitHub Actions matrix.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-system-3-0-design.md`

## Global Constraints

- Prime remains the only user-facing orchestration participant.
- Manager authority can only be granted by a proven Prime to a worker already owned by that Prime history.
- A Manager cannot self-designate by calling first.
- The stable V3 orchestration run id is system-generated; it is never the broker's browser-incarnation fence and never model input.
- No `run_id`, `manager_agent_id`, key, token, or equivalent authority field is accepted from the model.
- Core remains a maximum-seven-live-schema surface: V3 extends `agents`; no new MCP tool name is registered.
- Existing V2 `spawn`, `message`, `status`, and `finish` behavior stays unchanged.
- This slice adds no push, merge, deploy, or destructive external side effect.

---

### Task 1: Durable broker-anchored Manager authority

**Files:**
- Create: `src/main/orchestration/manager-authority.ts`
- Create: `test/agent-manager-authority.test.ts`

**Interfaces:**

```ts
export interface ManagerAuthority {
  runId: string;
  agentId: string;
}

export async function assignManagerForPrime(caller: Caller, managerAgentId: string): Promise<ManagerAuthority>;
export async function managerForCaller(caller: Caller): Promise<ManagerAuthority>;
export async function resetManagerAuthorityForTests(): Promise<void>;
```

Durable record:

```ts
{
  version: 1,
  orchestrationRunId: string,
  ownerPrimeConversationId: string,
  managerAgentId: string,
  managerConversationId: string | null
}
```

- [x] **Step 1: Write failing authority tests**

The focused suite proves Prime-only designation, first-call conversation locking, refusal of Prime/ordinary/stranger callers, durable recovery, and idempotent same-manager retry.

- [x] **Step 2: Verify RED**

CI failed because `manager-authority.ts` does not yet exist. An earlier implementation assumption (`manager: true` embedded in `SpawnInput`) was deliberately replaced before production code because it would require churn in the mature broker and would couple V3 authority to the broker's ephemeral run-incarnation snapshot.

- [ ] **Step 3: Implement minimal authority layer**

Rules:

1. `assignManagerForPrime` calls existing `statusForCaller(caller)` and requires `status.self.id === PRIME_ID`.
2. The target must be a worker in that caller-scoped broker history; label/order/recency never grant authority.
3. First designation generates `randomUUID()` as the stable orchestration run id and writes it with `writeDurableNow('manager-authority', ...)` before returning.
4. Repeating the same Prime + worker designation is idempotent and preserves the orchestration run id; attempting to replace it with another worker fails closed.
5. `managerForCaller` requires an exact conversation id and resolves membership through existing `statusForCaller`.
6. Before `managerConversationId` is locked, the caller must resolve to `managerAgentId` and the currently active Prime conversation must equal the stored owner Prime. The successful first call durably records the Manager conversation before authority is returned.
7. After the conversation is locked, every future authority check requires that exact conversation plus the same worker id; Prime Compact & Resume cannot transfer it.
8. A stale record for another broker history cannot authorize a same-numbered worker in another Prime history.

- [ ] **Step 4: Verify GREEN**

Run the focused suite plus `test/agents.test.ts` / `test/swarm.test.ts` to prove the sidecar does not alter V2 broker behavior.

- [ ] **Step 5: Commit**

Commit only the authority layer and its focused tests.

---

### Task 2: Production orchestration-store bootstrap

**Files:**
- Modify: `src/main/durable.ts`
- Modify or create: focused orchestration bootstrap regression test.

**Interfaces:**
- Consumes: `initOrchestrationStore(userDataDir)`.
- Produces: the existing `initDurableStore(userDataDir)` startup call also initializes the append-only orchestration store under the same `userData/state` family before MCP is usable.

- [ ] **Step 1: Write failing bootstrap test**

Prove that calling `initDurableStore(tempUserData)` is sufficient for a subsequent orchestration journal write, without directly calling `initOrchestrationStore` in the test.

- [ ] **Step 2: Verify RED**

Expected: orchestration store reports it is not initialized.

- [ ] **Step 3: Implement minimal bootstrap coupling**

`durable.ts` imports `initOrchestrationStore` and invokes it from `initDurableStore(userDataDir)`. The orchestration store remains lazy-writing; this only supplies its root. No `index.ts` churn is needed because normal startup already initializes the durable store before loading/connecting the MCP runtime.

- [ ] **Step 4: Verify GREEN**

Run the focused bootstrap test, orchestration store tests, and typecheck.

- [ ] **Step 5: Commit**

Commit bootstrap wiring only.

---

### Task 3: Manager authority bridge into the orchestration kernel

**Files:**
- Create: `src/main/orchestration/manager-surface.ts`
- Create: `test/orchestration-manager-surface.test.ts`

**Interfaces:**

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

- [ ] **Step 1: Write failing authority/materialization tests**

Use real broker membership, Manager authority state, and orchestration journal. Request input contains only `planId + tasks`; persisted V3 state must receive the system-generated orchestration run id and the designated Manager id.

- [ ] **Step 2: Verify RED**

Expected: missing bridge.

- [ ] **Step 3: Implement minimal bridge**

```ts
const authority = await managerForCaller(caller);
const accepted = await acceptInitialManagerPlan({
  planId: request.planId,
  runId: authority.runId,
  managerAgentId: authority.agentId,
  tasks: request.tasks
});
return { ...accepted, runId: authority.runId, managerAgentId: authority.agentId };
```

No fallback authority path.

- [ ] **Step 4: Verify GREEN**

Run Manager authority/plan/DAG/recovery/store tests together.

- [ ] **Step 5: Commit**

Commit the bridge only.

---

### Task 4: Decorate the existing `agents` registration with `assign_manager` and `plan`

**Files:**
- Create: `src/main/mcp/agents-v3.ts`
- Modify: `src/main/mcp/tools.ts`
- Modify: `test/mcp.test.ts`

**Architecture:** `tools-core.ts` remains the source/handler for all V2 agent actions. `tools.ts` passes Core a registrar decorator. The decorator intercepts only registration of the existing `agents` tool, uses a union schema of the original V2 schema plus the two V3 action schemas, and delegates V2 calls back to the unchanged handler.

**Model-facing V3 actions:**

```ts
{ action: 'assign_manager', manager_agent_id: string }
{ action: 'plan', plan_id: string, tasks: ManagerTaskPlan[] }
```

`manager_agent_id` is permitted only on the Prime-only designation action; it does not let the Manager assert its own identity. `run_id` is never an input.

- [ ] **Step 1: Write failing endpoint/schema tests**

Prove:

- `tools/list` still contains exactly one `agents` tool and Core's tool count does not grow;
- action enum includes `assign_manager` and `plan` in addition to the four V2 actions;
- schema contains `manager_agent_id`, `plan_id`, `tasks`, but never `run_id`;
- `manager_agent_id` on a `plan` call is rejected by the strict schema;
- a forged `run_id` is rejected before any orchestration mutation;
- existing V2 action schemas/strict field rejection remain intact.

- [ ] **Step 2: Verify RED**

Expected: V3 actions absent.

- [ ] **Step 3: Implement registrar decorator**

`decorateCoreRegistrarWithAgentV3(reg)` wraps only `reg.register('agents', ...)`:

- V2 branch: call original handler unchanged;
- `assign_manager`: resolve caller using the same call context identity already proven by `agents`, then call `assignManagerForPrime`;
- `plan`: resolve the exact caller, then call `acceptManagerPlanForCaller`;
- all outputs expose run/manager ids as facts, never as caller authority inputs.

- [ ] **Step 4: Verify GREEN**

Run MCP, Manager orchestration, agents/swarm, and typecheck suites.

- [ ] **Step 5: Commit**

Commit the MCP exposure slice.

---

### Task 5: Full verification and checkpoint hygiene

- [ ] **Step 1: Require full CI GREEN on Linux x64, macOS arm64, and Windows x64.**

A prior Windows-only timing failure in `agents.test.ts` was investigated with systematic-debugging; a fresh docs-only run then passed all three platforms, so it is tracked as a non-deterministic baseline test-harness flake rather than attributed to V3 code. New V3 commits still require a fresh all-green matrix before completion is claimed.

- [ ] **Step 2: Review the full diff**

Check: no new Core tool name; no Manager self-asserted authority; no run-id input; no label/order/recency inference; V2 broker unchanged; no unrelated WIP; no push/merge/deploy behavior.

- [ ] **Step 3: Update draft PR #2 body**

Replace the stale initial-RED description with the actual implemented checkpoint and fresh verification evidence.

- [ ] **Step 4: Stop at draft PR**

Do not merge, mark ready, deploy, or modify `main` unless the user explicitly asks.
