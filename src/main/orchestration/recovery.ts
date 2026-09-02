import { applyOrchestrationEvent } from './reducer.js';
import type { OrchestrationState } from './reducer.js';
import { readOrchestrationEvents, readOrchestrationSnapshot } from './store.js';

export interface RecoveredOrchestrationState {
  lastSeq: number;
  state: OrchestrationState;
}

function recordCopy<T>(value: Record<string, T> | null | undefined): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

/**
 * Foundation snapshots written before Manager planning/assignment existed have only a subset of
 * the current state. Missing fields are explicitly empty/unassigned; recovery never manufactures
 * Manager authority, worktrees or external-operation evidence that was not durably recorded.
 */
function normalizeState(snapshotState: Partial<OrchestrationState> | null | undefined): OrchestrationState {
  return {
    runId: typeof snapshotState?.runId === 'string' ? snapshotState.runId : null,
    managerAgentId: typeof snapshotState?.managerAgentId === 'string' ? snapshotState.managerAgentId : null,
    managerPlanId: typeof snapshotState?.managerPlanId === 'string' ? snapshotState.managerPlanId : null,
    managerPlanFingerprint:
      typeof snapshotState?.managerPlanFingerprint === 'string' ? snapshotState.managerPlanFingerprint : null,
    tasks: recordCopy(snapshotState?.tasks),
    assignmentIntents: recordCopy(snapshotState?.assignmentIntents),
    worktreeIntents: recordCopy(snapshotState?.worktreeIntents),
    worktrees: recordCopy(snapshotState?.worktrees)
  };
}

export async function recoverOrchestrationState(): Promise<RecoveredOrchestrationState> {
  const snapshot = await readOrchestrationSnapshot<Partial<OrchestrationState>>();
  let lastSeq = snapshot?.lastSeq ?? 0;
  let state = normalizeState(snapshot?.state);

  const events = await readOrchestrationEvents(lastSeq);
  for (const event of events) {
    const expected = lastSeq + 1;
    if (event.seq !== expected) {
      throw new Error(`Orchestration sequence mismatch: expected ${expected}, got ${event.seq}`);
    }
    state = applyOrchestrationEvent(state, event);
    lastSeq = event.seq;
  }

  return { lastSeq, state };
}
