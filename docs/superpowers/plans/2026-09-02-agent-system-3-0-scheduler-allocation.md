# Agent System 3.0 — Scheduler, Worker Allocation, and Assignment Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely dispatch every dependency-ready V3 task to an isolated execution worker, reusing eligible sleeping workers before creating new conversations, while making assignment and worktree side effects crash-recoverable and idempotent.

**Architecture:** Extend the orchestration journal with explicit worktree and assignment intents. A task receives a dedicated Git worktree before any worker sees its Task Contract. Worker allocation then prefers an eligible sleeping worker from the same Prime history, otherwise stages a fresh worker; the existing broker state crosses its durable barrier before `TASK_ASSIGNED` is journaled, and browser bootstrap/revival is requested only after that orchestration result is durable. Stable operation ids embedded in Task Contracts let restart reconciliation prove whether a broker assignment already happened instead of blindly repeating it.

**Tech Stack:** TypeScript, Node.js 22, Vitest 4, Node `child_process.execFile`, existing `agents.ts` staged broker transactions, existing workspace/root sandbox model, append-only orchestration journal, Git worktrees, GitHub Actions matrix.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-system-3-0-design.md`

## Global Constraints

- Prime remains the only user-facing orchestration participant.
- Manager authority and orchestration run identity remain app-derived; this plan adds no model-supplied authority field.
- Every task is schedulable only after all required dependencies are `VERIFIED`.
- Every ready independent task may receive an execution worker, subject to execution capacity and resource safety.
- Reuse an eligible sleeping worker before creating an unnecessary new worker conversation.
- The designated Manager is a control-plane agent, not an execution task worker; only system-only V3 broker calls may exempt that exact Manager worker from execution-worker capacity accounting.
- Existing V2 `spawn`, `message`, `status`, and `finish` calls keep their current capacity and authority semantics.
- A coding task receives a dedicated assignment worktree before the Task Contract is delivered. No two active task assignments share one mutable worktree.
- A sleeping worker is reusable only when it has no previously assigned task still awaiting `VERIFIED`, `CANCELLED`, or `SUPERSEDED` terminal disposition.
- Automatic worktree creation starts from a clean committed Git revision. A dirty source workspace blocks the task rather than copying or discarding uncommitted user work.
- Worktree creation never commits, merges, pushes, rebases, deploys, deletes user branches, or edits tracked project files.
- Worktrees created by this slice are retained for the later reviewer/integration slices; this plan does not delete them.
- Meaningful side effects follow `DURABLE INTENT -> SIDE EFFECT -> DURABLE RESULT`.
- Browser bootstrap/revival is a publication side effect and occurs only after both broker acceptance and orchestration `TASK_ASSIGNED` are durable.
- Worker identity never depends on an open browser tab.
- The existing close-after-durable-ACK tab lifecycle stays unchanged. The hard `MAX_AGENT_TABS = 5` queue is a separate Tab Lease Manager slice and is not implemented here.
- Capability/expertise scoring is not invented in this slice. Without durable capability metadata, reusable candidates are treated as generic same-project workers and selected deterministically by recency.
- Reviewer routing, Completion Packages, integration merging, final verification gates, and System Reviewer remain later slices.
- Provider rate limits are not bypassed and existing rate-limit acknowledgement behavior is unchanged.
- No merge, PR-ready transition, deployment, or modification of `main` is part of this plan.

---

### Task 1: Durable worktree and assignment intent state

**Files:**
- Modify: `src/main/orchestration/types.ts`
- Modify: `src/main/orchestration/store.ts`
- Modify: `src/main/orchestration/reducer.ts`
- Modify: `src/main/orchestration/recovery.ts`
- Modify: `test/orchestration-recovery.test.ts`
- Create: `test/orchestration-assignment-state.test.ts`

**Interfaces:**
- Produces `AssignmentStrategy`, `AssignmentIntentRecord`, `TaskWorktreeRecord`, `WorktreeIntentRecord`.
- Extends `OrchestrationState` with `assignmentIntents` and `worktreeIntents` maps.
- Adds journal events `TASK_WORKTREE_INTENT`, `TASK_WORKTREE_READY`, `TASK_WORKTREE_FAILED`, `TASK_ASSIGNMENT_INTENT`, and `TASK_ASSIGNMENT_ABORTED`.
- Tightens `TASK_ASSIGNED` so a new V3 assignment result consumes the matching durable assignment intent.

- [ ] **Step 1: Write failing intent/reducer tests**

Create `test/orchestration-assignment-state.test.ts` with exact fixtures equivalent to:

```ts
import { describe, expect, it } from 'vitest';
import { applyOrchestrationEvent, EMPTY_ORCHESTRATION_STATE } from '../src/main/orchestration/reducer.js';
import type { OrchestrationEvent } from '../src/main/orchestration/store.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';

const task: TaskRecord = {
  taskId: 'T1',
  parentTaskId: null,
  title: 'Parser',
  goal: 'Implement parser support.',
  allowedScope: ['src/parser/**'],
  dependencies: [],
  acceptanceCriteria: ['Parser tests pass'],
  expectedVerification: ['npm test -- test/parser.test.ts'],
  forbiddenActions: ['push', 'deploy'],
  state: 'READY',
  assignedWorkerId: null,
  reviewerId: null,
  worktreeId: null,
  reviewRound: 0,
  retryBudget: 2,
  riskClass: 'normal',
  completionPackage: null
};

function event(seq: number, type: OrchestrationEvent['type'], payload: Record<string, unknown>): OrchestrationEvent {
  return { seq, eventId: `e-${seq}`, runId: 'run-1', time: seq, type, actor: 'kernel', entityId: 'T1', payload };
}

it('records worktree intent/result without changing READY task state', () => {
  let state = applyOrchestrationEvent(EMPTY_ORCHESTRATION_STATE, {
    ...event(1, 'RUN_CREATED', {}),
    entityId: 'run-1'
  });
  state = applyOrchestrationEvent(state, event(2, 'TASK_CREATED', { task }));
  state = applyOrchestrationEvent(state, event(3, 'TASK_WORKTREE_INTENT', {
    intent: {
      operationId: 'wt-op-1',
      taskId: 'T1',
      worktreeId: 'wt-1',
      branch: 'as3/run-1/t1-wt-op-1',
      baseRevision: 'abc123',
      realPath: '/safe/worktrees/t1',
      virtualPath: '/project/.chat-on-steroids-worktrees/t1'
    }
  }));
  expect(state.tasks.T1?.state).toBe('READY');
  expect(state.worktreeIntents.T1?.operationId).toBe('wt-op-1');

  state = applyOrchestrationEvent(state, event(4, 'TASK_WORKTREE_READY', {
    operationId: 'wt-op-1',
    worktree: {
      worktreeId: 'wt-1',
      taskId: 'T1',
      branch: 'as3/run-1/t1-wt-op-1',
      baseRevision: 'abc123',
      realPath: '/safe/worktrees/t1',
      virtualPath: '/project/.chat-on-steroids-worktrees/t1'
    }
  }));
  expect(state.tasks.T1?.worktreeId).toBe('wt-1');
  expect(state.worktreeIntents.T1).toBeUndefined();
});

it('requires TASK_ASSIGNED to consume the exact pending operation', () => {
  // Build RUN_CREATED + TASK_CREATED + TASK_READY + TASK_ASSIGNMENT_INTENT.
  // Then assert a mismatched operation id throws and the matching one produces ASSIGNED,
  // assignedWorkerId='worker-2', and removes assignmentIntents.T1.
});

it('clears an aborted assignment without consuming READY state', () => {
  // After TASK_ASSIGNMENT_INTENT, TASK_ASSIGNMENT_ABORTED with the same operation id
  // leaves T1 READY and removes assignmentIntents.T1.
});
```

Also update the existing recovery fixture so `TASK_ASSIGNED` is preceded by `TASK_ASSIGNMENT_INTENT`; the recovered task must still reach `ACTIVE` after the later `TASK_ACTIVATED` event.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- --run test/orchestration-assignment-state.test.ts test/orchestration-recovery.test.ts
```

Expected: FAIL because the new intent types/events/state maps do not exist.

- [ ] **Step 3: Add the typed intent records and event names**

Add to `src/main/orchestration/types.ts`:

```ts
export type AssignmentStrategy = 'reuse' | 'spawn';

export interface TaskWorktreeRecord {
  worktreeId: string;
  taskId: string;
  branch: string;
  baseRevision: string;
  realPath: string;
  virtualPath: string;
}

export interface WorktreeIntentRecord extends TaskWorktreeRecord {
  operationId: string;
}

export interface AssignmentIntentRecord {
  operationId: string;
  taskId: string;
  strategy: AssignmentStrategy;
  requestedWorkerId: string | null;
  contractDigest: string;
}
```

Extend `OrchestrationEventType` in `src/main/orchestration/store.ts` with:

```ts
| 'TASK_WORKTREE_INTENT'
| 'TASK_WORKTREE_READY'
| 'TASK_WORKTREE_FAILED'
| 'TASK_ASSIGNMENT_INTENT'
| 'TASK_ASSIGNMENT_ABORTED'
```

Extend `OrchestrationState` in `reducer.ts`:

```ts
assignmentIntents: Record<string, AssignmentIntentRecord>;
worktreeIntents: Record<string, WorktreeIntentRecord>;
worktrees: Record<string, TaskWorktreeRecord>;
```

and initialize all three to `{}` in `EMPTY_ORCHESTRATION_STATE` and `recovery.normalizeState()`.

- [ ] **Step 4: Implement exact reducer invariants**

Implement these rules before any test is loosened:

```ts
TASK_WORKTREE_INTENT:
  - task must exist and be READY
  - task.worktreeId must be null
  - no worktreeIntents[taskId] may already exist
  - payload.intent.taskId must equal entityId

TASK_WORKTREE_READY:
  - matching worktree intent must exist
  - payload.operationId must equal intent.operationId
  - payload.worktree must match the intent's worktreeId/taskId/branch/baseRevision/paths
  - persist worktrees[worktreeId]
  - set task.worktreeId
  - delete worktreeIntents[taskId]
  - do not change TaskState

TASK_WORKTREE_FAILED:
  - matching intent required
  - delete worktreeIntents[taskId]
  - do not silently invent another worktree

TASK_ASSIGNMENT_INTENT:
  - task must be READY and already have worktreeId
  - no assignmentIntents[taskId] may exist
  - requestedWorkerId is required for strategy=reuse and must be null for strategy=spawn

TASK_ASSIGNMENT_ABORTED:
  - exact operation id must match
  - delete assignmentIntents[taskId]
  - task remains READY

TASK_ASSIGNED:
  - exact assignment intent must exist
  - payload.operationId must match it
  - payload.workerId must be non-empty
  - for strategy=reuse, payload.workerId must equal requestedWorkerId
  - transition READY -> ASSIGNED through transitionTask()
  - set assignedWorkerId
  - delete assignmentIntents[taskId]
```

`TASK_BLOCKED`, `TASK_FAILED`, `TASK_CANCELLED`, and `TASK_SUPERSEDED` must reject or clear no hidden in-flight intent implicitly. The scheduler must explicitly settle its intent first, so replay cannot hide an interrupted external operation.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- --run test/orchestration-assignment-state.test.ts test/orchestration-recovery.test.ts test/orchestration-task-state.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/orchestration/types.ts src/main/orchestration/store.ts src/main/orchestration/reducer.ts src/main/orchestration/recovery.ts test/orchestration-assignment-state.test.ts test/orchestration-recovery.test.ts
git commit -m "feat: add V3 assignment intents"
```

---

### Task 2: Crash-safe assignment worktree provisioning

**Files:**
- Create: `src/main/orchestration/worktree.ts`
- Create: `test/orchestration-worktree.test.ts`
- Modify: `src/main/orchestration/store.ts`
- Modify: `src/main/orchestration/reducer.ts`

**Interfaces:**
- Consumes `Root[]`, the Prime's learned `Workspace`, `runId`, `TaskRecord`, and the Task 1 worktree intent events.
- Produces `planTaskWorktree(...)`, `ensureTaskWorktree(...)`, and `reconcileTaskWorktree(...)`.
- Uses only `execFile`-style Git invocation; model text is never interpolated into shell source.

Use these signatures:

```ts
export interface WorktreePlan {
  operationId: string;
  record: WorktreeIntentRecord;
}

export interface WorktreeContext {
  roots: readonly Root[];
  primeWorkspace: Workspace;
  runId: string;
  task: TaskRecord;
}

export async function planTaskWorktree(context: WorktreeContext): Promise<WorktreePlan>;
export async function ensureTaskWorktree(context: WorktreeContext): Promise<TaskWorktreeRecord>;
export async function reconcileTaskWorktree(intent: WorktreeIntentRecord, roots: readonly Root[]): Promise<'ready' | 'missing' | 'ambiguous'>;
```

- [ ] **Step 1: Write failing Git-worktree tests**

Create a temporary real Git repository in `test/orchestration-worktree.test.ts` using `execFile('git', ['init', ...])`, commit one file with test-local identity (`-c user.name=... -c user.email=...`), and define one approved `Root` containing it.

Prove all of the following:

```ts
it('creates a task worktree from the exact committed base and records a different branch', async () => {
  const record = await ensureTaskWorktree(contextFor('T1'));
  expect(record.taskId).toBe('T1');
  expect(record.baseRevision).toMatch(/^[0-9a-f]{40}$/);
  expect(record.branch).toMatch(/^as3\//);
  expect(await git(record.realPath, ['rev-parse', 'HEAD'])).toBe(record.baseRevision);
  expect(await git(record.realPath, ['branch', '--show-current'])).toBe(record.branch);
});

it('refuses a dirty source workspace before writing a worktree intent or creating a directory', async () => {
  await fs.writeFile(path.join(repo, 'user-wip.txt'), 'uncommitted');
  await expect(ensureTaskWorktree(contextFor('T1'))).rejects.toThrow(/dirty|uncommitted/i);
  expect(await readOrchestrationEvents()).toEqual([]);
});

it('reconciles an already-created exact path/branch/revision after a simulated crash', async () => {
  // Persist TASK_WORKTREE_INTENT, execute git worktree add, skip TASK_WORKTREE_READY,
  // reset/re-init orchestration state, and assert the same intent reconciles as ready.
});

it('calls a mismatched existing path ambiguous and never deletes or overwrites it', async () => {
  // Put an unrelated repository/directory at the planned path and expect 'ambiguous'.
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- --run test/orchestration-worktree.test.ts
```

Expected: FAIL because `orchestration/worktree.ts` does not exist.

- [ ] **Step 3: Implement safe repository/root discovery**

In `worktree.ts`, use a promisified `execFile` helper with explicit args and `childEnv()`:

```ts
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    env: childEnv(),
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  });
  return stdout.trim();
}
```

Resolve:

```text
repoRoot      = git primeWorkspace.real rev-parse --show-toplevel
baseRevision  = git repoRoot rev-parse HEAD
status        = git repoRoot status --porcelain=v1 --untracked-files=normal
commonGitDir  = git repoRoot rev-parse --git-common-dir
```

Refuse worktree planning when `status` is non-empty. Do not stash, reset, clean, commit, or copy dirty user state.

Choose the approved root that contains `repoRoot` using path containment, not string prefix matching. The worktree parent is:

```text
<approved-root>/.chat-on-steroids-worktrees/<repo-hash>/<run-short>/
```

where `repo-hash` is the first 12 hex characters of SHA-256 over the canonical `repoRoot`. Compute a safe virtual path from that same root name.

Before creating a worktree under an approved root that is also inside the repository, add exactly one local ignore line to the Git common-dir `info/exclude`:

```text
/.chat-on-steroids-worktrees/
```

Never edit project `.gitignore` for this bookkeeping directory.

- [ ] **Step 4: Make worktree identity stable before the side effect**

`planTaskWorktree()` generates one `randomUUID()` operation id and derives deterministic values from it:

```ts
worktreeId = `wt-${operationId}`;
branch = `as3/${runId.slice(0, 8)}/${safeTaskId}-${operationId.slice(0, 8)}`;
realPath = path.join(parent, `${safeTaskId}-${operationId.slice(0, 8)}`);
```

`safeTaskId` must contain only `[A-Za-z0-9._-]`, replacing any other character with `-`, and must be capped so the final branch stays below 180 characters.

`ensureTaskWorktree()` performs:

```text
1. recover state; return existing task.worktreeId record if already ready
2. if TASK_WORKTREE_INTENT exists, reconcile it first
3. otherwise plan exact path/branch/base revision
4. append TASK_WORKTREE_INTENT
5. execute: git worktree add -b <branch> <realPath> <baseRevision>
6. prove <realPath> is that branch at that exact revision
7. append TASK_WORKTREE_READY
8. return the recovered record
```

If Git fails before the worktree exists, append `TASK_WORKTREE_FAILED` with the matching operation id. If the result is ambiguous, do not delete, reset, force-add, or reuse the path; throw `WORKTREE_RECONCILIATION_AMBIGUOUS` and leave the durable intent for Manager recovery.

- [ ] **Step 5: Run worktree/recovery tests and typecheck**

Run:

```bash
npm test -- --run test/orchestration-worktree.test.ts test/orchestration-assignment-state.test.ts test/orchestration-recovery.test.ts
npm run typecheck
```

Expected: PASS on Windows, macOS, and Linux-compatible path semantics in unit tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/orchestration/worktree.ts src/main/orchestration/store.ts src/main/orchestration/reducer.ts test/orchestration-worktree.test.ts
git commit -m "feat: provision isolated V3 task worktrees"
```

---

### Task 3: Bounded Task Contracts and deterministic reuse selection

**Files:**
- Create: `src/main/orchestration/task-contract.ts`
- Create: `src/main/orchestration/worker-allocation.ts`
- Create: `test/orchestration-worker-allocation.test.ts`
- Modify: `src/main/agents.ts`
- Modify: `src/main/orchestration/manager-plan.ts`
- Modify: `test/orchestration-manager-plan.test.ts`

**Interfaces:**
- Exports the existing broker task limit as `MAX_TASK_CHARS` without changing its value (`4000`).
- Produces `assignmentMarker(operationId)`, `formatTaskContract(task, operationId)`, and `selectWorkerAllocation(...)`.
- Manager plan acceptance verifies each normalized task can produce a broker-deliverable contract before the first journal mutation.

Use:

```ts
export interface WorkerAllocationDecision {
  strategy: AssignmentStrategy;
  workerId: string | null;
  conversationId: string | null;
}

export function selectWorkerAllocation(input: {
  task: TaskRecord;
  state: OrchestrationState;
  brokerWorkers: readonly AgentInfo[];
  managerAgentId: string;
}): WorkerAllocationDecision;
```

- [ ] **Step 1: Write failing Task Contract and allocation tests**

Prove:

```ts
it('formats one bounded contract carrying the stable assignment id and every task boundary', () => {
  const text = formatTaskContract(task, '11111111-1111-4111-8111-111111111111');
  expect(text).toContain('AS3-Assignment: 11111111-1111-4111-8111-111111111111');
  expect(text).toContain('Task: T1');
  expect(text).toContain('Allowed scope:');
  expect(text).toContain('Acceptance criteria:');
  expect(text).toContain('Expected verification:');
  expect(text).toContain('Forbidden actions:');
  expect(text.length).toBeLessThanOrEqual(MAX_TASK_CHARS);
});

it('rejects an accepted Manager task whose complete worker contract cannot fit the broker limit', async () => {
  // Inflate acceptanceCriteria before acceptInitialManagerPlan().
  // Expect rejection and an empty orchestration journal.
});

it('reuses the most recently sleeping eligible worker before spawning', () => {
  // worker-2 and worker-3 are sleeping/revivable; worker-3 has the newest sleptAt.
  // Neither owns an unfinished task. Expect reuse worker-3.
});

it('does not reuse the Manager or a sleeper that still owns a nonterminal task', () => {
  // Manager worker-1 is sleeping; worker-2 is sleeping but assigned to an APPROVED task;
  // worker-3 is sleeping and its previous task is VERIFIED. Expect worker-3.
});

it('returns spawn when no eligible sleeper exists', () => {
  expect(selectWorkerAllocation(...).strategy).toBe('spawn');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- --run test/orchestration-worker-allocation.test.ts test/orchestration-manager-plan.test.ts
```

Expected: FAIL because the formatter/allocator do not exist and `MAX_TASK_CHARS` is not exported.

- [ ] **Step 3: Implement the exact contract format**

Use a deterministic line format; do not serialize the Prime transcript:

```text
AS3-Assignment: <operationId>
Task: <taskId> — <title>
Goal: <goal>
Risk: <normal|high>

Allowed scope:
- <scope>

Dependencies already satisfied:
- <taskId> | (none)

Acceptance criteria:
- <criterion>

Expected verification:
- <command> | (none supplied)

Forbidden actions:
- <action> | (none supplied)

Work only inside the assigned workspace. Do not expand scope silently. If required work is outside this contract, report the blocker to the Manager. When the task is actually complete, report a factual result through the existing agents finish protocol; reviewer approval is a separate later gate.
```

`assignmentMarker(operationId)` returns exactly `AS3-Assignment: ${operationId}`. `formatTaskContract` throws `TASK_CONTRACT_TOO_LARGE` when the UTF-16 string length exceeds the broker's exported `MAX_TASK_CHARS`.

Call the formatter during `normalizePlan()` with a fixed validation UUID (`00000000-0000-4000-8000-000000000000`) so an oversized contract is rejected before any Manager-plan journal event is written.

- [ ] **Step 4: Implement deterministic generic reuse selection**

A reusable candidate must satisfy all of these:

```text
role === worker
id !== managerAgentId
state === sleeping
revivable === true
conversationId !== null
no orchestration task with assignedWorkerId === candidate.id is in a state other than VERIFIED/CANCELLED/SUPERSEDED
```

Sort eligible candidates by:

```text
1. sleptAt descending (null last)
2. lastSeenAt descending (null last)
3. createdAt descending
4. worker id lexical ascending
```

Return the first candidate. Do not infer React/backend/security expertise from labels, ids, task prose, or file names. Capability metadata gets its own future durable design.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm test -- --run test/orchestration-worker-allocation.test.ts test/orchestration-manager-plan.test.ts test/agents.test.ts
npm run typecheck
```

Expected: PASS with unchanged V2 broker behavior.

- [ ] **Step 6: Commit**

```bash
git add src/main/orchestration/task-contract.ts src/main/orchestration/worker-allocation.ts src/main/agents.ts src/main/orchestration/manager-plan.ts test/orchestration-worker-allocation.test.ts test/orchestration-manager-plan.test.ts
git commit -m "feat: add V3 task contracts and reuse policy"
```

---

### Task 4: System-only broker assignment adapter and crash evidence

**Files:**
- Modify: `src/main/agents.ts`
- Modify: `src/main/workspace.ts`
- Create: `test/agent-system-assignment.test.ts`
- Modify: `test/agents.test.ts`

**Interfaces:**
- Adds system-only execution-capacity options to staged broker operations; model-facing V2 calls never receive them.
- Produces `freeExecutionWorkerSlots(managerAgentId)`, `assignmentEvidenceForPrime(primeConversationId, marker)`, and `bindWorkerToTaskWorkspace(...)`.

Use these types:

```ts
export interface SystemCapacityOptions {
  capacityExemptWorkerIds?: readonly string[];
}

export interface AssignmentEvidence {
  workerId: string;
  source: 'bootstrap_task' | 'message_queue';
  state: AgentState;
  conversationId: string | null;
}

export function freeExecutionWorkerSlots(managerAgentId: string): number;
export function assignmentEvidenceForPrime(primeConversationId: string, marker: string): AssignmentEvidence | null;
```

`stageSpawn` and `stageMessages` gain optional final system-only options but keep all existing calls source-compatible:

```ts
stageSpawn(input, options?: SystemCapacityOptions)
stageMessages(caller, items, options?: SystemCapacityOptions)
```

- [ ] **Step 1: Write failing broker adapter tests**

Create `test/agent-system-assignment.test.ts` proving:

```ts
it('lets V3 execution capacity exclude exactly the designated Manager while ordinary V2 capacity does not', () => {
  // maxWorkers=2; manager worker-1 active, execution worker-2 active.
  // ordinary freeWorkerSlots() === 0.
  // freeExecutionWorkerSlots('worker-1') === 1.
  // system stageSpawn(..., {capacityExemptWorkerIds:['worker-1']}) accepts one new worker.
  // ordinary stageSpawn without the exemption still rejects the same extra worker.
});

it('finds a fresh-spawn assignment marker in the durable worker task', () => {
  // Spawn a worker whose task begins with AS3-Assignment:<uuid> and expect bootstrap_task evidence.
});

it('finds a reuse assignment marker after the revival message has been acknowledged', () => {
  // Sleep worker-1, stage a marked wake message, commit, mark revival delivered/acknowledged,
  // then expect message_queue evidence to remain available for crash reconciliation.
});

it('never searches another Prime history for assignment evidence', () => {
  // Two parked histories may both have worker-1. Search owner A and prove B cannot satisfy it.
});

it('returns null rather than guessing when no exact marker exists', () => {
  expect(assignmentEvidenceForPrime(owner, marker)).toBeNull();
});
```

Add one regression in `test/agents.test.ts` proving V2 schema/handler calls still use the original non-exempt capacity limit.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- --run test/agent-system-assignment.test.ts test/agents.test.ts
```

Expected: FAIL because the system-only broker helpers/options do not exist.

- [ ] **Step 3: Implement capacity accounting without changing V2 defaults**

Add one internal helper:

```ts
function freeWorkerSlotsWithExemptions(exemptIds: ReadonlySet<string>): number {
  const used = workingWorkers().filter((agent) => !exemptIds.has(agent.info.id)).length;
  return Math.max(0, getConfig().multiAgent.maxWorkers - used);
}
```

`freeWorkerSlots()` continues to call it with an empty set. `freeExecutionWorkerSlots(managerAgentId)` requires the active run to contain that exact worker id and calls it with `{managerAgentId}`.

In `spawn`, only the V3-supplied `capacityExemptWorkerIds` affect the live-count limit. In `stageMessagesActive`, only that same option affects the sleeping-worker slot check. The default options object is empty, preserving every V2 caller.

Do not add a model-visible field for exemptions.

- [ ] **Step 4: Implement exact assignment evidence lookup**

For the exact owner Prime history only, inspect every worker's durable `info.task` and durable message queue. Match the marker as a complete line:

```ts
const hasMarkerLine = (text: string, marker: string): boolean => text.split(/\r?\n/).includes(marker);
```

Collect matches from:

```text
worker.info.task             -> source bootstrap_task
worker.queue[*].text         -> source message_queue, including acked/offeredViaRevival rows
```

If no worker matches, return null. If more than one distinct worker matches the same operation marker, throw `ASSIGNMENT_EVIDENCE_AMBIGUOUS` rather than choosing one.

Search active history when `run.primeConversationId` matches; otherwise search only `dormantRuns.get(primeConversationId)`. Never fall through to whichever run happens to be active.

- [ ] **Step 5: Add task-worktree workspace binding helper**

In `workspace.ts`, add:

```ts
export function bindTaskWorkspace(
  agentId: string,
  conversationId: string | null,
  workspace: Omit<Workspace, 'at'>
): void {
  setWorkspaceFor(`agent:${agentId}`, workspace);
  if (conversationId) setWorkspaceFor(`chat:${conversationId}`, workspace);
}
```

This writes only the in-memory workspace map. The durable source of truth remains `TaskWorktreeRecord`; scheduler recovery must call this helper again before any bootstrap/revival request.

- [ ] **Step 6: Run broker/bridge regressions and typecheck**

Run:

```bash
npm test -- --run test/agent-system-assignment.test.ts test/agents.test.ts test/swarm.test.ts test/bridge.test.ts test/agent-tab-lifecycle.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/agents.ts src/main/workspace.ts test/agent-system-assignment.test.ts test/agents.test.ts
git commit -m "feat: add crash-safe V3 broker assignment hooks"
```

---

### Task 5: Scheduler cycle, reconciliation, and autonomous initial dispatch

**Files:**
- Create: `src/main/orchestration/scheduler.ts`
- Modify: `src/main/orchestration/manager-authority.ts`
- Modify: `src/main/orchestration/manager-surface.ts`
- Modify: `src/main/mcp/agents-v3.ts`
- Create: `test/orchestration-scheduler.test.ts`
- Modify: `test/orchestration-manager-surface.test.ts`
- Modify: `test/mcp-agent-v3.test.ts`

**Interfaces:**
- Produces `managerRuntimeForCaller(caller)` with the private owner Prime conversation needed by the kernel.
- Produces `scheduleReadyTasksForManager(caller, roots)`.
- `agents action=plan` remains the only model-facing action added in the prior slice; it now accepts the plan and then runs one deterministic scheduling cycle.

Use:

```ts
export interface ManagerRuntimeAuthority extends ManagerAuthority {
  ownerPrimeConversationId: string;
}

export interface ScheduledTask {
  taskId: string;
  workerId: string;
  strategy: AssignmentStrategy;
  worktreeId: string;
}

export interface ScheduleResult {
  scheduled: ScheduledTask[];
  stillReady: string[];
}

export async function scheduleReadyTasksForManager(
  caller: Caller,
  roots: readonly Root[]
): Promise<ScheduleResult>;
```

- [ ] **Step 1: Write failing scheduler tests**

Create `test/orchestration-scheduler.test.ts` with real orchestration store + real broker fixtures and temporary Git repositories. Prove:

```ts
it('schedules every independent READY root up to execution capacity and leaves dependencies PLANNED', async () => {
  // Plan T1 + T2 independent, T3 depends on T1. maxWorkers=2 plus one designated Manager.
  // Expect T1/T2 ASSIGNED to two execution workers, T3 PLANNED.
});

it('prefers one eligible sleeping worker before spawning a new conversation', async () => {
  // Park a verified prior task owned by sleeping worker-2, then schedule T2.
  // Expect strategy reuse and the same exact conversation id.
});

it('does not reuse a sleeping worker whose previous task is not terminally disposed', async () => {
  // Prior task state APPROVED or INTEGRATED but not VERIFIED => fresh worker instead.
});

it('creates and binds the worktree before requesting browser bootstrap or revival', async () => {
  // Capture spawn/revive request listeners; when invoked, recover orchestration state and
  // assert task.worktreeId exists, task is ASSIGNED, and workspace points at that worktree.
});

it('recovers a crash after broker durability but before TASK_ASSIGNED without duplicating the worker or message', async () => {
  // Persist TASK_ASSIGNMENT_INTENT, perform broker stage+durable+commit, skip result/browser request,
  // reset orchestration runtime, then call scheduler. Expect one existing evidence match,
  // one TASK_ASSIGNED result, and no duplicate worker/message.
});

it('stops cleanly at zero execution capacity and leaves remaining tasks READY', async () => {
  // No failed/phantom assignment intent should be created for tasks that were never attempted.
});

it('blocks rather than dispatches when the source repository has uncommitted user work', async () => {
  // Worktree preparation fails closed. Expect no broker assignment and task BLOCKED with no browser request.
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- --run test/orchestration-scheduler.test.ts test/orchestration-manager-surface.test.ts test/mcp-agent-v3.test.ts
```

Expected: FAIL because `scheduler.ts` and runtime authority are absent.

- [ ] **Step 3: Expose private runtime authority without widening model output**

In `manager-authority.ts`, factor the existing Manager resolution so:

```ts
export async function managerRuntimeForCaller(caller: Caller): Promise<ManagerRuntimeAuthority> {
  const entry = await resolveAndLockExactManagerEntry(caller);
  return {
    runId: entry.orchestrationRunId,
    agentId: entry.managerAgentId,
    ownerPrimeConversationId: entry.ownerPrimeConversationId
  };
}

export async function managerForCaller(caller: Caller): Promise<ManagerAuthority> {
  const runtime = await managerRuntimeForCaller(caller);
  return { runId: runtime.runId, agentId: runtime.agentId };
}
```

`ownerPrimeConversationId` is never added to MCP input or structured model output.

- [ ] **Step 4: Implement scheduler reconciliation before new work**

At the start of every cycle:

```text
1. resolve Manager runtime authority
2. recover orchestration state
3. require recovered runId/managerAgentId to equal authority
4. reconcile every pending worktree intent for this run
5. reconcile every pending assignment intent for this run
6. only then inspect newly ready tasks
```

Assignment-intent reconciliation uses the exact marker regenerated from `operationId`:

```ts
const marker = assignmentMarker(intent.operationId);
const evidence = assignmentEvidenceForPrime(ownerPrimeConversationId, marker);
```

When evidence exists:

```text
- require worker id to match requestedWorkerId for reuse intents
- append TASK_ASSIGNED with operationId + workerId
- re-bind the durable worktree into workspace.ts
- requestWorkerBootstraps([workerId]) for bootstrap_task evidence
- requestWorkerRevivals([workerId]) for message_queue evidence
```

Both browser request helpers are already state-filtered/idempotent; invoking them after a recovered result must not manufacture another broker mutation.

When no evidence exists, retry the same durable intent using the same operation id and regenerated Task Contract. Never create a new operation id until the old intent is settled.

When evidence is ambiguous or contradicts the requested reuse worker, append `TASK_ASSIGNMENT_ABORTED`, then `TASK_BLOCKED` with a bounded reason and stop that task. Never guess which worker owns it.

- [ ] **Step 5: Implement one assignment transaction**

For each ready task in graph order while `freeExecutionWorkerSlots(managerAgentId) > 0`:

```text
A. ensureTaskWorktree() reaches durable TASK_WORKTREE_READY
B. selectWorkerAllocation()
C. generate randomUUID() operationId
D. format exact Task Contract and SHA-256 digest
E. append TASK_ASSIGNMENT_INTENT
F. bind worktree before a reuse wake is staged
G. stage broker mutation using owner Prime Caller and capacityExemptWorkerIds=[managerAgentId]
H. persistCriticalSwarmNow()
I. commit broker stage
J. append durable TASK_ASSIGNED(operationId, workerId)
K. bind/re-bind worktree from durable TaskWorktreeRecord
L. request browser bootstrap/revival
```

Concrete broker branches:

```ts
if (decision.strategy === 'reuse') {
  bindTaskWorkspace(decision.workerId!, decision.conversationId, workspace);
  const staged = stageMessages(
    { conversationId: authority.ownerPrimeConversationId },
    [{ to: decision.workerId!, text: contract }],
    { capacityExemptWorkerIds: [authority.agentId] }
  );
  // durable barrier -> commit -> TASK_ASSIGNED -> requestWorkerRevivals(staged.waking)
} else {
  const staged = stageSpawn(
    {
      caller: { conversationId: authority.ownerPrimeConversationId },
      workers: [{ label: compactTaskLabel(task), task: contract }]
    },
    { capacityExemptWorkerIds: [authority.agentId] }
  );
  // durable barrier -> commit -> TASK_ASSIGNED -> bind agent workspace -> requestWorkerBootstraps([workerId])
}
```

If the broker durable barrier fails, rollback the staged broker mutation and append `TASK_ASSIGNMENT_ABORTED`. The task remains READY. If the abort append itself fails, leave the durable assignment intent unresolved; restart reconciliation must retry that exact operation instead of inventing a new one.

Do not request a browser tab inside the failure path.

- [ ] **Step 6: Block unsafe worktree preparation without spawning**

If `ensureTaskWorktree()` fails because the source repository is dirty, root containment fails, Git identity is ambiguous, or worktree reconciliation is ambiguous:

```text
- settle any exact worktree intent only when its external outcome is known failed
- append TASK_BLOCKED with a bounded reason
- do not create TASK_ASSIGNMENT_INTENT
- do not call stageSpawn/stageMessages
- do not request a browser tab
```

A later Manager re-plan or explicit unblock operation can return `BLOCKED -> READY`; recovery itself does not decide how to resolve user WIP.

- [ ] **Step 7: Hook initial scheduling after Manager plan acceptance**

In `manager-surface.ts`, keep plan acceptance separate from scheduling:

```ts
export async function acceptAndScheduleManagerPlan(
  caller: Caller,
  roots: readonly Root[],
  request: ManagerPlanRequest
): Promise<ManagerPlanAcceptance & { runId: string; managerAgentId: string; schedule: ScheduleResult }> {
  const accepted = await acceptManagerPlanForCaller(caller, request);
  const schedule = await scheduleReadyTasksForManager(caller, roots);
  return { ...accepted, schedule };
}
```

The `agents-v3.ts` `plan` branch passes `reg.ctx.roots` and uses this combined surface. It still accepts only:

```ts
{ action: 'plan', plan_id, tasks }
```

No new MCP action or authority field is added.

Extend structured result with bounded facts:

```ts
scheduled: accepted.schedule.scheduled.map(({ taskId, workerId, strategy, worktreeId }) => ({
  task_id: taskId,
  worker_id: workerId,
  strategy,
  worktree_id: worktreeId
})),
still_ready_task_ids: accepted.schedule.stillReady
```

Do not expose native worktree paths in model output.

- [ ] **Step 8: Run focused suites and typecheck**

Run:

```bash
npm test -- --run \
  test/orchestration-scheduler.test.ts \
  test/orchestration-worktree.test.ts \
  test/orchestration-worker-allocation.test.ts \
  test/orchestration-assignment-state.test.ts \
  test/orchestration-manager-plan.test.ts \
  test/orchestration-manager-surface.test.ts \
  test/mcp-agent-v3.test.ts \
  test/agent-system-assignment.test.ts \
  test/agents.test.ts \
  test/swarm.test.ts \
  test/agent-tab-lifecycle.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/orchestration/scheduler.ts src/main/orchestration/manager-authority.ts src/main/orchestration/manager-surface.ts src/main/mcp/agents-v3.ts test/orchestration-scheduler.test.ts test/orchestration-manager-surface.test.ts test/mcp-agent-v3.test.ts
git commit -m "feat: schedule V3 tasks to isolated workers"
```

---

### Task 6: Full verification and draft-PR checkpoint

**Files:**
- Modify only if needed for accurate checkpoint documentation: `docs/superpowers/plans/2026-09-02-agent-system-3-0-scheduler-allocation.md`
- Update draft PR #2 body after verification; do not change PR readiness.

- [ ] **Step 1: Run the complete local CI command**

Run:

```bash
npm run verify:ci
```

Expected: PASS. Do not describe the slice as complete from targeted tests alone.

- [ ] **Step 2: Require one fresh same-head GitHub Actions matrix**

Require the exact same commit SHA to complete successfully on:

```text
Linux x64
macOS arm64
Windows x64
```

A platform failure must be investigated before changing code. If it is a known nondeterministic baseline test, prove that by a same-head rerun with no production change; otherwise fix the root cause through TDD.

- [ ] **Step 3: Review the full diff against the approved design**

Explicitly verify:

```text
- no new Core MCP tool name
- no run_id / owner-prime / capacity-exemption model input
- V2 agents calls still have their old capacity semantics
- Manager exemption is system-only and exact-manager scoped
- every dispatched task has durable worktreeId before browser publication
- no two active assignments share a worktreeId/path
- dirty source workspace blocks rather than stashes/resets/copies WIP
- reusable worker selection excludes Manager and unfinished prior work
- assignment recovery uses exact operation marker evidence and never label/order/recency identity inference
- browser request occurs only after broker durable acceptance + TASK_ASSIGNED durable result
- no merge/push/deploy/main mutation
- no hard tab-budget implementation accidentally mixed into this slice
```

- [ ] **Step 4: Update draft PR #2 body with the new checkpoint and exact CI evidence**

Add the scheduler/worktree/reuse slice, the exact head SHA, and matrix result. Keep the PR draft.

- [ ] **Step 5: Stop at the draft checkpoint**

Do not merge, mark ready for review, enable auto-merge, deploy, or modify `main` unless the user explicitly asks.
