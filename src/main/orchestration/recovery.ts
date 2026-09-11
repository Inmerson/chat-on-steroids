import { applyOrchestrationEvent } from './reducer.js';
import type { OrchestrationState } from './reducer.js';
import { normalizeAutonomousSwarmState } from './autonomous-swarm.js';
import type { AutonomousSwarmState, DispatchLease } from './types.js';
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
    runStatus: snapshotState?.runStatus === 'RUN_VERIFIED' ? 'RUN_VERIFIED' : 'RUNNING',
    managerAgentId: typeof snapshotState?.managerAgentId === 'string' ? snapshotState.managerAgentId : null,
    managerPlanId: typeof snapshotState?.managerPlanId === 'string' ? snapshotState.managerPlanId : null,
    managerPlanFingerprint:
      typeof snapshotState?.managerPlanFingerprint === 'string' ? snapshotState.managerPlanFingerprint : null,
    tasks: recordCopy(snapshotState?.tasks),
    assignmentIntents: recordCopy(snapshotState?.assignmentIntents),
    worktreeIntents: recordCopy(snapshotState?.worktreeIntents),
    worktrees: recordCopy(snapshotState?.worktrees),
    autonomousSwarm: normalizeAutonomousSwarmState(snapshotState?.autonomousSwarm)
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

export interface AutonomousRecoveryObservation {
  ownership: {
    primeConversationId: string;
    workerId: string;
    runId: string;
  } | null;
  browserCommand: {
    commandId: string;
    conversationId: string;
    browserEpoch: number;
    turnId: string | null;
  } | null;
}

export type AutonomousRecoveryAction =
  | { type: 'republish'; leaseId: string; commandId: string }
  | { type: 'record_browser_commit'; leaseId: string; commandId: string; browserEpoch: number }
  | { type: 'record_settlement'; leaseId: string; commandId: string; browserEpoch: number; turnId: string }
  | { type: 'block'; leaseId: string; reason: string };

export interface RecoveredAutonomousSwarmState extends AutonomousSwarmState {
  actions: AutonomousRecoveryAction[];
}

export type AutonomousRecoveryObserver = (lease: DispatchLease) => AutonomousRecoveryObservation;

function block(lease: DispatchLease, reason: string): AutonomousRecoveryAction {
  return { type: 'block', leaseId: lease.leaseId, reason };
}

function recoveryActionForLease(
  lease: DispatchLease,
  observe: AutonomousRecoveryObserver
): AutonomousRecoveryAction | null {
  const observation = observe(lease);
  const ownership = observation.ownership;
  if (
    !ownership ||
    ownership.primeConversationId !== lease.primeConversationId ||
    ownership.workerId !== lease.workerId ||
    ownership.runId !== lease.workerRunId
  ) {
    return block(lease, 'worker ownership no longer exactly matches the durable dispatch lease');
  }

  if (!lease.commandId) {
    return block(lease, 'durable dispatch lease has no exact command id to recover');
  }

  const browser = observation.browserCommand;
  if (!browser) {
    if (lease.browserEpoch !== null) {
      return block(lease, 'browser no longer proves the command recorded by the durable dispatch lease');
    }
    return { type: 'republish', leaseId: lease.leaseId, commandId: lease.commandId };
  }

  if (
    browser.commandId !== lease.commandId ||
    browser.conversationId !== lease.conversationId ||
    !Number.isInteger(browser.browserEpoch) ||
    browser.browserEpoch < 0
  ) {
    return block(lease, 'browser command identity does not exactly match the durable dispatch lease');
  }

  if (lease.browserEpoch !== null) {
    if (browser.browserEpoch !== lease.browserEpoch) {
      return block(lease, 'browser epoch does not exactly match the committed dispatch lease');
    }
    return browser.turnId
      ? {
          type: 'record_settlement',
          leaseId: lease.leaseId,
          commandId: lease.commandId,
          browserEpoch: lease.browserEpoch,
          turnId: browser.turnId
        }
      : null;
  }

  return {
    type: 'record_browser_commit',
    leaseId: lease.leaseId,
    commandId: lease.commandId,
    browserEpoch: browser.browserEpoch
  };
}

export async function recoverAutonomousSwarmState(
  observe?: AutonomousRecoveryObserver
): Promise<RecoveredAutonomousSwarmState> {
  const state = (await recoverOrchestrationState()).state.autonomousSwarm;
  const actions = observe
    ? Object.values(state.activeLeases)
        .sort((a, b) => a.createdAt - b.createdAt || a.leaseId.localeCompare(b.leaseId))
        .map((lease) => recoveryActionForLease(lease, observe))
        .filter((action): action is AutonomousRecoveryAction => action !== null)
    : [];
  return { ...state, actions };
}
