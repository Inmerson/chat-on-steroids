# Agent System 3.0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the deterministic V3 orchestration foundation: typed task/run state, validated task transitions, dependency readiness, and a durable append-only orchestration journal that can replay state after restart.

**Architecture:** Keep V3 orchestration separate from the existing `agents.ts` broker at first so the current v2 worker lifecycle remains unchanged while the new kernel earns test coverage. Pure state-machine and DAG logic live in focused modules; persistence wraps the existing durable-store root and uses an append-only JSONL journal plus atomic snapshots. Later V3 plans will wire Manager commands, TabLease, reviewers, integration, and Control Center onto these stable interfaces.

**Tech Stack:** TypeScript 7, Node.js 22, Vitest 4, Node `fs/promises`, existing `src/main/durable.ts` initialization conventions.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-system-3-0-design.md`

## Global Constraints

- Worker identity must never depend on an open browser tab.
- Recovery must be deterministic replay/reconciliation and must not invent architectural decisions.
- No acknowledged task may disappear after restart.
- No completed task may be silently rerun after restart.
- Task transitions are explicit and invalid transitions are rejected by the kernel.
- Journal sequence numbers are strictly increasing within one orchestration store.
- Existing v2 broker behavior must remain unchanged in this foundation slice.
- Do not bypass provider rate limits or alter the existing rate-limit acknowledgement behavior in this slice.

---

### Task 1: Typed task state machine

**Files:**
- Create: `src/main/orchestration/types.ts`
- Create: `src/main/orchestration/task-state.ts`
- Test: `test/orchestration-task-state.test.ts`

**Interfaces:**
- Produces: `TaskState`, `TaskRecord`, `TaskRiskClass`, `ReviewOutcome`, `TASK_TRANSITIONS`, `canTransitionTask(from, to)`, `transitionTask(task, to)`.
- `transitionTask` returns a new `TaskRecord` and never mutates the input object.

- [ ] **Step 1: Write the failing transition tests**

```ts
import { describe, expect, it } from 'vitest';
import { transitionTask } from '../src/main/orchestration/task-state.js';
import type { TaskRecord } from '../src/main/orchestration/types.js';

function task(state: TaskRecord['state']): TaskRecord {
  return {
    taskId: 'T1',
    parentTaskId: null,
    title: 'Database schema',
    goal: 'Create schema',
    dependencies: [],
    state,
    assignedWorkerId: null,
    reviewerId: null,
    worktreeId: null,
    reviewRound: 0,
    retryBudget: 2,
    riskClass: 'normal',
    completionPackage: null
  };
}

describe('V3 task state machine', () => {
  it('accepts the normal PLANNED -> READY transition without mutating the input', () => {
    const original = task('PLANNED');
    const next = transitionTask(original, 'READY');
    expect(next.state).toBe('READY');
    expect(original.state).toBe('PLANNED');
    expect(next).not.toBe(original);
  });

  it('rejects skipping directly from PLANNED to VERIFIED', () => {
    expect(() => transitionTask(task('PLANNED'), 'VERIFIED')).toThrow(/PLANNED.*VERIFIED/);
  });

  it('allows CHANGES_REQUESTED to return to ACTIVE', () => {
    expect(transitionTask(task('CHANGES_REQUESTED'), 'ACTIVE').state).toBe('ACTIVE');
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test -- --run test/orchestration-task-state.test.ts`
Expected: FAIL because `src/main/orchestration/task-state.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal typed state machine**

Define `TaskState` exactly as:

```ts
export type TaskState =
  | 'PLANNED'
  | 'READY'
  | 'ASSIGNED'
  | 'ACTIVE'
  | 'READY_FOR_REVIEW'
  | 'REVIEWING'
  | 'CHANGES_REQUESTED'
  | 'BLOCKED'
  | 'APPROVED'
  | 'INTEGRATING'
  | 'INTEGRATED'
  | 'VERIFIED'
  | 'FAILED'
  | 'CANCELLED'
  | 'SUPERSEDED';
```

Define the initial allowed graph:

```ts
PLANNED -> READY | BLOCKED | CANCELLED | SUPERSEDED
READY -> ASSIGNED | BLOCKED | CANCELLED | SUPERSEDED
ASSIGNED -> ACTIVE | READY | FAILED | CANCELLED
ACTIVE -> READY_FOR_REVIEW | BLOCKED | FAILED | CANCELLED
READY_FOR_REVIEW -> REVIEWING | ACTIVE | FAILED | CANCELLED
REVIEWING -> APPROVED | CHANGES_REQUESTED | BLOCKED | FAILED
CHANGES_REQUESTED -> ACTIVE | FAILED | CANCELLED
BLOCKED -> READY | CANCELLED | SUPERSEDED
APPROVED -> INTEGRATING | CANCELLED
INTEGRATING -> INTEGRATED | FAILED
INTEGRATED -> VERIFIED | FAILED
VERIFIED -> no transitions
FAILED -> READY | CANCELLED | SUPERSEDED
CANCELLED -> no transitions
SUPERSEDED -> no transitions
```

`transitionTask` throws `Error('Invalid task transition: <from> -> <to>')` when the edge is not allowed.

- [ ] **Step 4: Run test and typecheck**

Run: `npm test -- --run test/orchestration-task-state.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/orchestration/types.ts src/main/orchestration/task-state.ts test/orchestration-task-state.test.ts
git commit -m "feat: add V3 task state machine"
```

---

### Task 2: Dependency-aware task readiness

**Files:**
- Create: `src/main/orchestration/dag.ts`
- Test: `test/orchestration-dag.test.ts`

**Interfaces:**
- Consumes: `TaskRecord` from Task 1.
- Produces: `validateTaskGraph(tasks)`, `readyTaskIds(tasks)`.

- [ ] **Step 1: Write failing DAG tests**

Create tests proving:

```ts
readyTaskIds([T1 READY, T2 PLANNED depends T1]) === ['T1']
readyTaskIds([T1 VERIFIED, T2 PLANNED depends T1]) === ['T2']
```

and proving `validateTaskGraph` rejects an unknown dependency and a cycle `T1 -> T2 -> T1`.

- [ ] **Step 2: Run to verify RED**

Run: `npm test -- --run test/orchestration-dag.test.ts`
Expected: FAIL because `dag.ts` does not exist.

- [ ] **Step 3: Implement minimal graph validation/readiness**

`validateTaskGraph` must reject duplicate task ids, missing dependency ids, self-dependencies, and cycles. `readyTaskIds` first validates the graph, then returns task ids in input order where the task is `READY`, or where the task is `PLANNED` and every dependency is `VERIFIED`. It does not mutate task state.

- [ ] **Step 4: Run targeted tests and typecheck**

Run: `npm test -- --run test/orchestration-task-state.test.ts test/orchestration-dag.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/orchestration/dag.ts test/orchestration-dag.test.ts
git commit -m "feat: add V3 dependency scheduler primitives"
```

---

### Task 3: Append-only orchestration journal

**Files:**
- Create: `src/main/orchestration/store.ts`
- Test: `test/orchestration-store.test.ts`

**Interfaces:**
- Consumes: user-data directory path supplied through `initOrchestrationStore(userDataDir)`.
- Produces: `appendOrchestrationEvent(input)`, `readOrchestrationEvents(afterSeq?)`, `writeOrchestrationSnapshot(snapshot)`, `readOrchestrationSnapshot()`, `resetOrchestrationStoreForTests()`.
- Event input excludes `seq`; append assigns `seq = previousSeq + 1` and persists one JSON object plus `\n` before resolving.

- [ ] **Step 1: Write failing persistence tests**

Use `fs.mkdtemp` and `os.tmpdir()` like `test/durable.test.ts`. Prove that two appends receive sequence 1 and 2, survive `resetOrchestrationStoreForTests()` plus re-init, and `readOrchestrationEvents(1)` returns only event 2.

Also prove a snapshot is written atomically to `state/orchestration-snapshot.json` and can be read after re-init.

- [ ] **Step 2: Run to verify RED**

Run: `npm test -- --run test/orchestration-store.test.ts`
Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement append and snapshot storage**

Store under `<userDataDir>/state/orchestration/`:

```text
journal.jsonl
snapshot.json
```

Serialize all writes through one promise chain. For journal append, open with append semantics and write exactly one newline-terminated JSON object per event. On startup/read, parse complete non-empty lines in order and reject sequence regression or duplicate sequence values. Snapshot writes use `<target>.tmp` then rename, matching the atomic durability style already used by `durable.ts`.

- [ ] **Step 4: Run targeted tests and typecheck**

Run: `npm test -- --run test/orchestration-store.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/orchestration/store.ts test/orchestration-store.test.ts
git commit -m "feat: add V3 orchestration journal"
```

---

### Task 4: Replay a run snapshot plus later events

**Files:**
- Create: `src/main/orchestration/reducer.ts`
- Create: `src/main/orchestration/recovery.ts`
- Test: `test/orchestration-recovery.test.ts`

**Interfaces:**
- Consumes: Task 1 state types and Task 3 event/snapshot interfaces.
- Produces: `applyOrchestrationEvent(state, event)` and `recoverOrchestrationState()`.

- [ ] **Step 1: Write failing replay tests**

Create a snapshot ending at sequence 2 with task `T1` in `READY`, append sequence 3 `TASK_ASSIGNED` and sequence 4 `TASK_ACTIVATED`, reset/re-init the store, then assert `recoverOrchestrationState()` returns `lastSeq === 4` and task `T1.state === 'ACTIVE'`.

Add a corruption-safety test proving replay rejects an event whose `seq` is not exactly the next expected sequence after the snapshot.

- [ ] **Step 2: Run to verify RED**

Run: `npm test -- --run test/orchestration-recovery.test.ts`
Expected: FAIL because reducer/recovery modules do not exist.

- [ ] **Step 3: Implement minimal reducer and recovery**

Support the event types needed by this foundation slice:

```ts
RUN_CREATED
TASK_CREATED
TASK_READY
TASK_ASSIGNED
TASK_ACTIVATED
TASK_BLOCKED
TASK_REVIEW_READY
TASK_REVIEWING
TASK_CHANGES_REQUESTED
TASK_APPROVED
TASK_INTEGRATING
TASK_INTEGRATED
TASK_VERIFIED
TASK_FAILED
TASK_CANCELLED
TASK_SUPERSEDED
```

Every task-state event must call the Task 1 transition validator rather than assigning arbitrary states directly. `recoverOrchestrationState()` loads the snapshot, reads events strictly after `snapshot.lastSeq`, requires contiguous sequence numbers, applies each event, and returns reconstructed state.

- [ ] **Step 4: Run the foundation suite and typecheck**

Run: `npm test -- --run test/orchestration-task-state.test.ts test/orchestration-dag.test.ts test/orchestration-store.test.ts test/orchestration-recovery.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run existing broker/durable regression tests**

Run: `npm test -- --run test/agents.test.ts test/swarm.test.ts test/durable.test.ts`
Expected: PASS with no behavior changes required in existing `agents.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/main/orchestration/reducer.ts src/main/orchestration/recovery.ts test/orchestration-recovery.test.ts
git commit -m "feat: recover V3 orchestration state"
```

---

## Follow-on plans after this foundation

The approved design is intentionally larger than one reviewable implementation unit. After this foundation is green, create separate plans in dependency order for: Manager command/DAG orchestration; worker task contracts and reusable allocation; Tab Lease Manager and hard browser-tab budget; reviewer routing/completion packages; integration/worktree controller and verification freshness; crash reconciliation/Manager replacement; and Control Center UI. Each follow-on plan must keep the same TDD and evidence rules.