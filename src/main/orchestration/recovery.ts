import { applyOrchestrationEvent, EMPTY_ORCHESTRATION_STATE } from './reducer.js';
import type { OrchestrationState } from './reducer.js';
import { readOrchestrationEvents, readOrchestrationSnapshot } from './store.js';

export interface RecoveredOrchestrationState {
  lastSeq: number;
  state: OrchestrationState;
}

export async function recoverOrchestrationState(): Promise<RecoveredOrchestrationState> {
  const snapshot = await readOrchestrationSnapshot<OrchestrationState>();
  let lastSeq = snapshot?.lastSeq ?? 0;
  let state: OrchestrationState = snapshot?.state ?? {
    runId: EMPTY_ORCHESTRATION_STATE.runId,
    tasks: { ...EMPTY_ORCHESTRATION_STATE.tasks }
  };

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
