# Agent Runtime Garbage Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely retire UnifiedExec process trees owned by long-sleeping or explicitly-cleared agents while preserving reusable worker chats and history.

**Architecture:** Keep broker/history ownership in `agents.ts` and OS-process ownership in the existing `codex/ownership.ts` registry. Add atomic runtime-process inspection/conditional termination to `UnifiedExecProcessManager`, then build a small `runtime-gc.ts` coordinator that joins exact conversation ownership with read-only agent lifecycle state. Wire its periodic timer into the Electron process lifetime and its explicit-release path into durable IPC clear operations.

**Tech Stack:** TypeScript, Electron main process, Vitest, existing UnifiedExec/process-tree termination primitives.

**Spec:** `docs/superpowers/specs/2026-09-05-agent-runtime-gc.md`

## Global Constraints

- Sleeping retention is exactly `30 * 60_000` ms.
- Maintenance cadence is exactly `30_000` ms.
- Periodic GC may terminate only `UnifiedExecProcessManager` sessions with a non-empty exact `conversationId` owner whose current agent row is `role === 'worker'`, `state === 'sleeping'`, `revivable === true`, and `sleptAt <= now - retention`.
- Process activity must also satisfy `lastUsed <= now - retention` under the process interaction lock.
- Unknown/null ownership is never terminated.
- No process-name inference is permitted.
- Explicit cleanup runs only after the corresponding broker reset/clear durability barrier succeeds.
- Periodic GC must not mutate worker chat/history/worktree/revivability state.
- Existing browser tab lifecycle and app-wide shutdown cleanup remain unchanged authorities.

---

### Task 1: Runtime ownership and atomic process-retirement primitives

**Files:**
- Modify: `src/main/codex/ownership.ts`
- Modify: `src/main/codex/unified-exec.ts`
- Test: `test/workspace.test.ts`
- Test: `test/codex-runtime-parity.test.ts`

**Interfaces:**
- Produces: `execProcessIdsOwnedBy(conversationId: string): number[]`
- Produces: `ManagedProcessRuntimeInfo`
- Produces: `ConditionalTerminationResult`
- Produces: `UnifiedExecProcessManager.listRuntimeProcesses(): ManagedProcessRuntimeInfo[]`
- Produces: `UnifiedExecProcessManager.terminateProcessIfUnusedSince(processId: number, cutoff: number): Promise<ConditionalTerminationResult>`

- [ ] **Step 1: Write failing ownership test**

Add a `workspace.test.ts` test that records owners for multiple process ids (including `null` and a different conversation), calls `execProcessIdsOwnedBy('chat-a')`, and expects only the sorted ids whose owner equals `chat-a`.

- [ ] **Step 2: Run the ownership test and verify RED**

Run: `npx vitest run test/workspace.test.ts -t "lists only process ids with the exact proven conversation owner"`

Expected: FAIL because `execProcessIdsOwnedBy` does not exist.

- [ ] **Step 3: Implement the ownership query**

In `src/main/codex/ownership.ts`, add:

```ts
export function execProcessIdsOwnedBy(conversationId: string): number[] {
  if (!conversationId) return [];
  return [...owners.entries()]
    .filter(([, owner]) => owner === conversationId)
    .map(([processId]) => processId)
    .sort((left, right) => left - right);
}
```

- [ ] **Step 4: Write failing process-manager tests**

Add focused tests proving:

1. `listRuntimeProcesses()` exposes live session `processId`, `pid`, `command`, `cwd`, `tty`, `lastUsed`, and `initialExecCommandActive` without exposing exited sessions.
2. `terminateProcessIfUnusedSince(id, cutoff)` returns `recent` and does not terminate when `lastUsed > cutoff`.
3. It returns `busy` and does not terminate when the interaction lock cannot be acquired or the initial exec command is still active.
4. It terminates and releases an eligible process tree when `lastUsed <= cutoff` and the entry is idle.

Use the same private-manager test seam already used by shutdown/runtime parity tests rather than adding a production-only injector.

- [ ] **Step 5: Run the manager tests and verify RED**

Run: `npx vitest run test/codex-runtime-parity.test.ts -t "runtime process|conditionally terminates"`

Expected: FAIL because the new interfaces/methods do not exist.

- [ ] **Step 6: Implement atomic runtime inspection and conditional termination**

In `src/main/codex/unified-exec.ts`, add:

```ts
export interface ManagedProcessRuntimeInfo extends BackgroundTerminalInfo {
  lastUsed: number;
  initialExecCommandActive: boolean;
}

export type ConditionalTerminationResult = 'terminated' | 'missing' | 'busy' | 'recent' | 'exited';
```

`listRuntimeProcesses()` must read only the manager map, filter exited processes, sort by `processId`, and include `lastUsed` plus `initialExecCommandActive`.

`terminateProcessIfUnusedSince()` must:

```ts
const entry = this.processes.get(processId);
if (!entry) return 'missing';
const release = entry.process.interactionLock.tryLock();
if (!release) return 'busy';
try {
  const current = this.processes.get(processId);
  if (!current || current.process !== entry.process) return 'missing';
  if (current.initialExecCommandActive) return 'busy';
  if (current.lastUsed > cutoff) return 'recent';
  if (current.process.hasExited()) {
    this.releaseProcessId(processId);
    return 'exited';
  }
  await current.process.terminate();
  const after = this.processes.get(processId);
  if (after?.process === current.process) this.releaseProcessId(processId);
  return 'terminated';
} finally {
  release();
}
```

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```powershell
npx vitest run test/workspace.test.ts test/codex-runtime-parity.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/main/codex/ownership.ts src/main/codex/unified-exec.ts test/workspace.test.ts test/codex-runtime-parity.test.ts
git commit -m "feat(runtime): add safe agent process retirement primitives"
```

---

### Task 2: Agent runtime GC coordinator and process-lifetime timer

**Files:**
- Create: `src/main/runtime-gc.ts`
- Create: `test/runtime-gc.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `execOwner`, `forgetExecOwner`, `agentInfoForOwnedConversation`, `unifiedExecManager.listRuntimeProcesses()`, `terminateProcessIfUnusedSince()`
- Produces: `AGENT_RUNTIME_RETENTION_MS = 30 * 60_000`
- Produces: `AGENT_RUNTIME_SWEEP_MS = 30_000`
- Produces: `sweepAgentRuntimeGc(now?: number, deps?: RuntimeGcDependencies): Promise<RuntimeGcSummary>`
- Produces: `startAgentRuntimeGc(options?: { onError?: (error: Error) => void }): () => void`

- [ ] **Step 1: Write failing GC selection/safety tests**

Create dependency-injected unit tests that cover all of these cases:

- exact sleeping/revivable worker + old `sleptAt` + old `lastUsed` -> calls conditional termination once;
- unknown/null owner -> never calls termination;
- owner maps to no agent or a Prime -> never calls termination;
- worker is active, detached, waking, invited, failed, or finished -> never calls termination;
- worker slept less than 30 minutes ago -> skipped;
- process `lastUsed` is less than 30 minutes old -> manager returns `recent`, process remains owned;
- manager returns `busy` -> process remains owned;
- manager returns `terminated`, `exited`, or `missing` -> stale ownership row is forgotten;
- re-reading ownership/lifecycle immediately before termination observes a changed owner or waking worker -> skip.

- [ ] **Step 2: Run the GC tests and verify RED**

Run: `npx vitest run test/runtime-gc.test.ts`

Expected: FAIL because `runtime-gc.ts` does not exist.

- [ ] **Step 3: Implement `runtime-gc.ts`**

Default dependencies use the real ownership registry, `agentInfoForOwnedConversation`, and `unifiedExecManager`. The sweep must compute `cutoff = now - AGENT_RUNTIME_RETENTION_MS`, then evaluate each live runtime process. Before calling conditional termination, re-read both `execOwner(processId)` and `agentInfoForOwnedConversation(owner)` and require the same exact sleeping/revivable worker with `sleptAt <= cutoff`.

Only forget ownership when the manager result proves the tracked session is gone (`terminated`, `exited`, or `missing`). Never forget on `busy` or `recent`.

The timer must guard against overlapping sweeps, call `unref()` when available, and return an idempotent stop function.

- [ ] **Step 4: Run GC tests and verify GREEN**

Run: `npx vitest run test/runtime-gc.test.ts`

Expected: PASS.

- [ ] **Step 5: Wire the timer into Electron lifecycle**

In `src/main/index.ts`:

- add one module-level stop handle;
- start runtime GC only after `restoreSwarm(savedSwarm)` and disabled-mode canonicalization have completed;
- log sweep errors through `logWarn` without crashing the app;
- stop the GC synchronously at the beginning of the owned `will-quit` path before the shutdown phases start;
- leave the existing `unifiedExecManager.terminateAllProcesses()` shutdown phase unchanged.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```powershell
npx vitest run test/runtime-gc.test.ts test/shutdown.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/main/runtime-gc.ts src/main/index.ts test/runtime-gc.test.ts
git commit -m "feat(runtime): collect long-sleeping agent processes"
```

---

### Task 3: Durable explicit-clear runtime release

**Files:**
- Modify: `src/main/runtime-gc.ts`
- Modify: `src/main/ipc.ts`
- Test: `test/runtime-gc.test.ts`
- Test: `test/ipc.test.ts`

**Interfaces:**
- Produces: `AgentRuntimeReleaseTarget { processId: number; conversationId: string }`
- Produces: `captureAgentRuntimeTargets(conversationIds?: ReadonlySet<string>): AgentRuntimeReleaseTarget[]`
- Produces: `releaseCapturedAgentRuntimeTargets(targets: readonly AgentRuntimeReleaseTarget[], deps?: RuntimeGcDependencies): Promise<RuntimeReleaseSummary>`

- [ ] **Step 1: Write failing explicit-release tests**

In `runtime-gc.test.ts`, prove capture/release behavior:

- capture includes only live UnifiedExec processes with non-empty exact ownership that currently maps to an agent;
- a conversation filter limits capture to that exact set;
- release rechecks that each process is still owned by the captured conversation before calling `terminateProcess`; changed/unknown owners are skipped;
- release forgets the owner after a successful termination or when the process is already missing;
- no process-name inspection exists in the API or tests.

- [ ] **Step 2: Run explicit-release tests and verify RED**

Run: `npx vitest run test/runtime-gc.test.ts -t "captur|explicit release"`

Expected: FAIL because capture/release functions do not exist.

- [ ] **Step 3: Implement capture/release helpers**

Add the helpers to `runtime-gc.ts`. `captureAgentRuntimeTargets()` may use `agentInfoForOwnedConversation` only as read-only evidence; it must not mutate broker state. `releaseCapturedAgentRuntimeTargets()` must use the ordinary manager `terminateProcess(processId)` because an explicit user clear is intentionally stronger than the idle-retention policy, but it must revalidate `execOwner(processId) === target.conversationId` immediately before terminating.

- [ ] **Step 4: Write failing IPC durability-order tests**

Add IPC tests proving:

1. `swarm:clearAgent` captures the worker's conversation before mutation, persists the broker clear first, then requests runtime release.
2. Clearing the Prime row captures only conversations visible in the current run before ending it.
3. `swarm:reset` captures all exact active/dormant agent-owned runtime targets before reset, persists reset first, then releases them.
4. When `persistAgentAuthorityNow()` fails, no runtime release is attempted.

Use module mocks/spies for `runtime-gc.ts`; do not create real child processes in IPC tests.

- [ ] **Step 5: Run IPC tests and verify RED**

Run: `npx vitest run test/ipc.test.ts -t "runtime|clearAgent|Clear swarm"`

Expected: FAIL until IPC wiring is added.

- [ ] **Step 6: Wire durable clear ordering in `ipc.ts`**

For `swarm:reset`:

```ts
const runtimeTargets = captureAgentRuntimeTargets();
resetSwarm();
if (!(await persistAgentAuthorityNow())) throw ...;
await releaseCapturedAgentRuntimeTargets(runtimeTargets);
```

For `swarm:clearAgent`, capture before `clearAgent(id)`:

- worker row: filter to `agentConversation(id)` when non-null;
- Prime row: build a set from `swarmState().agents` conversation ids for the currently visible run;
- after a successful durable clear, release only the captured targets;
- keep existing command cancellation ordering/behavior intact.

- [ ] **Step 7: Run focused regression tests and typecheck**

Run:

```powershell
npx vitest run test/runtime-gc.test.ts test/ipc.test.ts test/agents.test.ts test/codex-runtime-parity.test.ts test/workspace.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/main/runtime-gc.ts src/main/ipc.ts test/runtime-gc.test.ts test/ipc.test.ts
git commit -m "feat(runtime): release processes on durable agent clear"
```

---

### Task 4: Whole-feature verification

**Files:**
- No planned production edits; fixes discovered by verification belong in the owning task's files.

**Interfaces:**
- Consumes all prior task interfaces.
- Produces verified feature branch ready for final review.

- [ ] **Step 1: Run focused feature suite**

```powershell
npx vitest run test/runtime-gc.test.ts test/workspace.test.ts test/codex-runtime-parity.test.ts test/ipc.test.ts test/agents.test.ts test/shutdown.test.ts
```

- [ ] **Step 2: Run static verification**

```powershell
npm run typecheck
npm run build
```

- [ ] **Step 3: Run full suite**

Run: `npm test`

Baseline note: before this feature, the full suite had one intermittent failure in `test/bridge.test.ts` (`keeps a dropped worker transport durable until the failed broker state is durable`), and the exact test passed immediately when rerun alone. Any final occurrence of that same isolated failure must be reported as a baseline flaky result rather than silently attributed to this feature; any new failure is a regression and must be fixed.

- [ ] **Step 4: Verify invariant by source search**

Run searches confirming `runtime-gc.ts` contains no process-name matching and no direct `process.kill`, `taskkill`, or arbitrary OS process enumeration. The only termination path must go through `UnifiedExecProcessManager` methods.

- [ ] **Step 5: Commit any verification-only fix, otherwise leave history unchanged**

If no fix was required, do not create an empty commit.
