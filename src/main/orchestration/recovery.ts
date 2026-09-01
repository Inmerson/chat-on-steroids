import { applyOrchestrationEvent, EMPTY_ORCHESTRATION_STATE } from './reducer.js';
import type { OrchestrationState } from './reducer.js';
import { readOrchestrationEvents, readOrchestrationSnapshot } from './store.js';

export interface RecoveredOrchestrationState {
  lastSeq: number;
  state: OrchestrationState;
}

/**
 * Foundation snapshots written before Manager planning existed have only runId + tasks. Treat
 * their missing Manager fields as explicitly unassigned rather than manufacturing V3 authority.
 */
function normalizeState(snapshotState: Partial<OrchestrationState> | null | undefined): OrchestrationState {
  return {
    runId: typeof snapshotState?.runId === 'string' ? snapshotState.runId : null,
    managerAgentId: typeof snapshotState?.managerAgentId === 'string' ? snapshotState.managerAgentId : null,
    managerPlanId: typeof snapshotState?.managerPlanId === 'string' ? snapshotState.managerPlanId : null,
    managerPlanFingerprint:
      typeof snapshotState?.managerPlanFingerprint === 'string' ? snapshotState.managerPlanFingerprint : null,
    tasks:
      snapshotState?.tasks && typeof snapshotState.tasks === 'object'
        ? { ...snapshotState.tasks }
        : { ...EMPTY_ORCHESTRATION_STATE.tasks }
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
