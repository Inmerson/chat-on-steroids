import type { OrchestrationEvent, OrchestrationEventType } from './store.js';
import type {
  AutonomousDispatchQueueEntry,
  AutonomousSwarmRun,
  AutonomousSwarmState,
  DispatchLease
} from './types.js';

const MAX_ID_CHARS = 200;
const MAX_OBJECTIVE_CHARS = 20_000;
const MAX_REASON_CHARS = 2_000;
const MAX_EVIDENCE_REF_CHARS = 1_000;

export const AUTONOMOUS_SWARM_EVENT_TYPES = new Set<OrchestrationEventType>([
  'SWARM_RUN_STARTED',
  'DISPATCH_QUEUED',
  'DISPATCH_LEASED',
  'DISPATCH_BROWSER_COMMITTED',
  'DISPATCH_SETTLED',
  'DISPATCH_BACKOFF',
  'DISPATCH_BLOCKED',
  'SWARM_RUN_COMPLETED',
  'SWARM_RUN_PAUSED',
  'SWARM_RUN_STOPPED'
]);

export const EMPTY_AUTONOMOUS_SWARM_STATE: AutonomousSwarmState = {
  runs: {},
  queue: [],
  activeLeases: {},
  lastGrantedPrimeId: null
};

export function isAutonomousSwarmEvent(type: OrchestrationEventType): boolean {
  return AUTONOMOUS_SWARM_EVENT_TYPES.has(type);
}

function boundedString(value: unknown, where: string, max = MAX_ID_CHARS): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`${where} requires a non-empty string no longer than ${max} characters`);
  }
  return value;
}

function nullableString(value: unknown, where: string): string | null {
  return value === null ? null : boundedString(value, where);
}

function finiteNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${where} requires a non-negative number`);
  return value;
}

function payloadRecord(event: OrchestrationEvent, key?: string): Record<string, unknown> {
  const value = key ? event.payload[key] : event.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${event.type} requires ${key ? `payload.${key}` : 'payload'}`);
  }
  return value as Record<string, unknown>;
}

function runFor(state: AutonomousSwarmState, goalRunId: string, eventType: string): AutonomousSwarmRun {
  const run = state.runs[goalRunId];
  if (!run) throw new Error(`${eventType} requires autonomous swarm run ${goalRunId}`);
  return run;
}

function leaseFrom(event: OrchestrationEvent): DispatchLease {
  const record = payloadRecord(event, 'lease');
  const browserEpoch = record['browserEpoch'];
  if (browserEpoch !== null && (typeof browserEpoch !== 'number' || !Number.isInteger(browserEpoch) || browserEpoch < 0)) {
    throw new Error(`${event.type}.lease.browserEpoch must be null or a non-negative integer`);
  }
  return {
    leaseId: boundedString(record['leaseId'], `${event.type}.lease.leaseId`),
    goalRunId: boundedString(record['goalRunId'], `${event.type}.lease.goalRunId`),
    taskId: boundedString(record['taskId'], `${event.type}.lease.taskId`),
    primeConversationId: boundedString(record['primeConversationId'], `${event.type}.lease.primeConversationId`),
    workerId: boundedString(record['workerId'], `${event.type}.lease.workerId`),
    workerRunId: boundedString(record['workerRunId'], `${event.type}.lease.workerRunId`),
    conversationId: boundedString(record['conversationId'], `${event.type}.lease.conversationId`),
    commandId: nullableString(record['commandId'], `${event.type}.lease.commandId`),
    browserEpoch: browserEpoch as number | null,
    turnId: nullableString(record['turnId'], `${event.type}.lease.turnId`),
    createdAt: finiteNumber(record['createdAt'], `${event.type}.lease.createdAt`)
  };
}

function assertRunOwnership(run: AutonomousSwarmRun, primeConversationId: string, eventType: string): void {
  if (run.primeConversationId !== primeConversationId) {
    throw new Error(`${eventType} ownership mismatch: ${primeConversationId} does not own ${run.goalRunId}`);
  }
}

function assertLeaseIdentity(lease: DispatchLease, record: Record<string, unknown>, eventType: string): void {
  const exact: Array<[keyof DispatchLease, unknown]> = [
    ['goalRunId', record['goalRunId']],
    ['taskId', record['taskId']],
    ['primeConversationId', record['primeConversationId']],
    ['workerId', record['workerId']],
    ['workerRunId', record['workerRunId']],
    ['conversationId', record['conversationId']]
  ];
  for (const [key, value] of exact) {
    if (value !== lease[key]) throw new Error(`${eventType} lease identity mismatch for ${String(key)}`);
  }
}

export function applyAutonomousSwarmEvent(
  state: AutonomousSwarmState,
  event: OrchestrationEvent
): AutonomousSwarmState {
  if (!isAutonomousSwarmEvent(event.type)) throw new Error(`Unsupported autonomous swarm event: ${event.type}`);

  if (event.type === 'SWARM_RUN_STARTED') {
    if (event.entityId !== event.runId) throw new Error('SWARM_RUN_STARTED entity must equal goal run id');
    if (state.runs[event.runId]) throw new Error(`SWARM_RUN_STARTED duplicate run ${event.runId}`);
    const record = payloadRecord(event);
    const graphVersion = record['graphVersion'];
    if (!Number.isInteger(graphVersion) || (graphVersion as number) <= 0) {
      throw new Error('SWARM_RUN_STARTED requires a positive graphVersion');
    }
    const run: AutonomousSwarmRun = {
      goalRunId: boundedString(event.runId, 'SWARM_RUN_STARTED.runId'),
      primeConversationId: boundedString(record['primeConversationId'], 'SWARM_RUN_STARTED.primeConversationId'),
      bindingEpoch: boundedString(record['bindingEpoch'], 'SWARM_RUN_STARTED.bindingEpoch'),
      objective: boundedString(record['objective'], 'SWARM_RUN_STARTED.objective', MAX_OBJECTIVE_CHARS),
      graphVersion: graphVersion as number,
      status: 'RUNNING',
      lastReason: null,
      cooldownUntil: null
    };
    return { ...state, runs: { ...state.runs, [run.goalRunId]: run } };
  }

  if (event.type === 'DISPATCH_QUEUED') {
    const record = payloadRecord(event);
    const goalRunId = boundedString(record['goalRunId'], 'DISPATCH_QUEUED.goalRunId');
    const taskId = boundedString(record['taskId'], 'DISPATCH_QUEUED.taskId');
    const primeConversationId = boundedString(record['primeConversationId'], 'DISPATCH_QUEUED.primeConversationId');
    if (event.runId !== goalRunId || event.entityId !== taskId) throw new Error('DISPATCH_QUEUED identity mismatch');
    const run = runFor(state, goalRunId, event.type);
    assertRunOwnership(run, primeConversationId, event.type);
    if (run.status !== 'RUNNING') throw new Error(`DISPATCH_QUEUED requires RUNNING swarm ${goalRunId}`);
    if (
      state.queue.some((entry) => entry.goalRunId === goalRunId && entry.taskId === taskId) ||
      Object.values(state.activeLeases).some((lease) => lease.goalRunId === goalRunId && lease.taskId === taskId)
    ) {
      throw new Error(`DISPATCH_QUEUED duplicate task ${taskId}`);
    }
    const entry: AutonomousDispatchQueueEntry = {
      goalRunId,
      taskId,
      primeConversationId,
      queuedAt: event.time,
      attempt: 0
    };
    return { ...state, queue: [...state.queue, entry] };
  }

  if (event.type === 'DISPATCH_LEASED') {
    const lease = leaseFrom(event);
    if (event.runId !== lease.goalRunId || event.entityId !== lease.leaseId) throw new Error('DISPATCH_LEASED lease identity mismatch');
    const run = runFor(state, lease.goalRunId, event.type);
    assertRunOwnership(run, lease.primeConversationId, event.type);
    if (run.status !== 'RUNNING') throw new Error(`DISPATCH_LEASED requires RUNNING swarm ${lease.goalRunId}`);
    const queueIndex = state.queue.findIndex(
      (entry) =>
        entry.goalRunId === lease.goalRunId &&
        entry.taskId === lease.taskId &&
        entry.primeConversationId === lease.primeConversationId
    );
    if (queueIndex < 0) throw new Error(`DISPATCH_LEASED requires queued task ${lease.taskId} with exact ownership`);
    if (state.activeLeases[lease.leaseId]) throw new Error(`DISPATCH_LEASED duplicate lease ${lease.leaseId}`);
    if (Object.values(state.activeLeases).some((active) => active.conversationId === lease.conversationId)) {
      throw new Error(`DISPATCH_LEASED worker conversation ${lease.conversationId} already has an unsettled lease`);
    }
    return {
      ...state,
      queue: state.queue.filter((_, index) => index !== queueIndex),
      activeLeases: { ...state.activeLeases, [lease.leaseId]: lease },
      lastGrantedPrimeId: lease.primeConversationId
    };
  }

  if (event.type === 'SWARM_RUN_PAUSED') {
    const record = payloadRecord(event);
    const goalRunId = boundedString(record['goalRunId'], 'SWARM_RUN_PAUSED.goalRunId');
    const primeConversationId = boundedString(record['primeConversationId'], 'SWARM_RUN_PAUSED.primeConversationId');
    if (event.runId !== goalRunId || event.entityId !== goalRunId) throw new Error('SWARM_RUN_PAUSED run identity mismatch');
    const run = runFor(state, goalRunId, event.type);
    assertRunOwnership(run, primeConversationId, event.type);
    if (run.status !== 'RUNNING') throw new Error(`SWARM_RUN_PAUSED requires RUNNING swarm ${goalRunId}`);
    const reason = boundedString(record['reason'], 'SWARM_RUN_PAUSED.reason', MAX_REASON_CHARS);
    return {
      ...state,
      runs: {
        ...state.runs,
        [goalRunId]: { ...run, status: 'PAUSED', lastReason: reason }
      }
    };
  }

  if (event.type === 'SWARM_RUN_STOPPED') {
    const record = payloadRecord(event);
    const goalRunId = boundedString(record['goalRunId'], 'SWARM_RUN_STOPPED.goalRunId');
    const primeConversationId = boundedString(record['primeConversationId'], 'SWARM_RUN_STOPPED.primeConversationId');
    if (event.runId !== goalRunId || event.entityId !== goalRunId) throw new Error('SWARM_RUN_STOPPED run identity mismatch');
    const run = runFor(state, goalRunId, event.type);
    assertRunOwnership(run, primeConversationId, event.type);
    if (run.status === 'STOPPED' || run.status === 'COMPLETED') {
      throw new Error(`SWARM_RUN_STOPPED requires non-terminal swarm ${goalRunId}`);
    }
    const reason = boundedString(record['reason'], 'SWARM_RUN_STOPPED.reason', MAX_REASON_CHARS);
    return {
      ...state,
      runs: {
        ...state.runs,
        [goalRunId]: { ...run, status: 'STOPPED', lastReason: reason }
      },
      queue: state.queue.filter((entry) => entry.goalRunId !== goalRunId)
    };
  }

  if (event.type === 'SWARM_RUN_COMPLETED') {
    const record = payloadRecord(event);
    const goalRunId = boundedString(record['goalRunId'], 'SWARM_RUN_COMPLETED.goalRunId');
    const primeConversationId = boundedString(record['primeConversationId'], 'SWARM_RUN_COMPLETED.primeConversationId');
    if (event.runId !== goalRunId || event.entityId !== goalRunId) throw new Error('SWARM_RUN_COMPLETED run identity mismatch');
    const run = runFor(state, goalRunId, event.type);
    assertRunOwnership(run, primeConversationId, event.type);
    if (run.status !== 'RUNNING') throw new Error(`SWARM_RUN_COMPLETED requires RUNNING swarm ${goalRunId}`);
    const queued = state.queue.some((entry) => entry.goalRunId === goalRunId);
    const leased = Object.values(state.activeLeases).some((lease) => lease.goalRunId === goalRunId);
    if (queued || leased) {
      throw new Error(`SWARM_RUN_COMPLETED requires no queued or leased dispatches for ${goalRunId}`);
    }
    return {
      ...state,
      runs: {
        ...state.runs,
        [goalRunId]: { ...run, status: 'COMPLETED', lastReason: null, cooldownUntil: null }
      }
    };
  }

  const record = payloadRecord(event);
  const leaseId = boundedString(record['leaseId'], `${event.type}.leaseId`);
  const lease = state.activeLeases[leaseId];
  if (!lease) throw new Error(`${event.type} requires active lease ${leaseId}`);
  if (event.runId !== lease.goalRunId || event.entityId !== leaseId) throw new Error(`${event.type} lease identity mismatch`);
  assertLeaseIdentity(lease, record, event.type);

  if (event.type === 'DISPATCH_BROWSER_COMMITTED') {
    if (lease.browserEpoch !== null) throw new Error(`DISPATCH_BROWSER_COMMITTED lease ${leaseId} is already committed`);
    const commandId = boundedString(record['commandId'], 'DISPATCH_BROWSER_COMMITTED.commandId');
    if (lease.commandId !== null && commandId !== lease.commandId) {
      throw new Error('DISPATCH_BROWSER_COMMITTED command lease identity mismatch');
    }
    const browserEpoch = record['browserEpoch'];
    if (!Number.isInteger(browserEpoch) || (browserEpoch as number) < 0) {
      throw new Error('DISPATCH_BROWSER_COMMITTED requires a non-negative browserEpoch');
    }
    return {
      ...state,
      activeLeases: {
        ...state.activeLeases,
        [leaseId]: { ...lease, commandId: lease.commandId ?? commandId, browserEpoch: browserEpoch as number }
      }
    };
  }

  if (event.type === 'DISPATCH_SETTLED') {
    if (lease.commandId === null || lease.browserEpoch === null) {
      throw new Error(`DISPATCH_SETTLED requires browser-committed lease ${leaseId}`);
    }
    if (record['commandId'] !== lease.commandId || record['browserEpoch'] !== lease.browserEpoch) {
      throw new Error('DISPATCH_SETTLED command/browser lease identity mismatch');
    }
    boundedString(record['turnId'], 'DISPATCH_SETTLED.turnId');
    boundedString(record['evidenceRef'], 'DISPATCH_SETTLED.evidenceRef', MAX_EVIDENCE_REF_CHARS);
    const { [leaseId]: _settled, ...activeLeases } = state.activeLeases;
    return { ...state, activeLeases };
  }

  if (event.type === 'DISPATCH_BACKOFF') {
    const retryAt = finiteNumber(record['retryAt'], 'DISPATCH_BACKOFF.retryAt');
    const reason = boundedString(record['reason'], 'DISPATCH_BACKOFF.reason', MAX_REASON_CHARS);
    const { [leaseId]: _backedOff, ...activeLeases } = state.activeLeases;
    const priorAttempt = state.queue.find((entry) => entry.goalRunId === lease.goalRunId && entry.taskId === lease.taskId)?.attempt ?? 0;
    const queue = [
      ...state.queue.filter((entry) => !(entry.goalRunId === lease.goalRunId && entry.taskId === lease.taskId)),
      {
        goalRunId: lease.goalRunId,
        taskId: lease.taskId,
        primeConversationId: lease.primeConversationId,
        queuedAt: retryAt,
        attempt: priorAttempt + 1
      }
    ];
    const run = runFor(state, lease.goalRunId, event.type);
    return {
      ...state,
      activeLeases,
      queue,
      runs: { ...state.runs, [run.goalRunId]: { ...run, lastReason: reason, cooldownUntil: retryAt } }
    };
  }

  if (event.type === 'DISPATCH_BLOCKED') {
    const reason = boundedString(record['reason'], 'DISPATCH_BLOCKED.reason', MAX_REASON_CHARS);
    const { [leaseId]: _blocked, ...activeLeases } = state.activeLeases;
    const run = runFor(state, lease.goalRunId, event.type);
    return {
      ...state,
      activeLeases,
      queue: state.queue.filter((entry) => !(entry.goalRunId === lease.goalRunId && entry.taskId === lease.taskId)),
      runs: { ...state.runs, [run.goalRunId]: { ...run, lastReason: reason } }
    };
  }

  throw new Error(`Unsupported lease transition: ${event.type}`);
}

export function normalizeAutonomousSwarmState(value: Partial<AutonomousSwarmState> | null | undefined): AutonomousSwarmState {
  if (!value || typeof value !== 'object') return { runs: {}, queue: [], activeLeases: {}, lastGrantedPrimeId: null };
  const normalized: AutonomousSwarmState = {
    runs: value.runs && typeof value.runs === 'object' && !Array.isArray(value.runs) ? { ...value.runs } : {},
    queue: Array.isArray(value.queue) ? value.queue.map((entry) => ({ ...entry })) : [],
    activeLeases:
      value.activeLeases && typeof value.activeLeases === 'object' && !Array.isArray(value.activeLeases)
        ? { ...value.activeLeases }
        : {},
    lastGrantedPrimeId:
      typeof value.lastGrantedPrimeId === 'string' && value.lastGrantedPrimeId.length > 0
        ? value.lastGrantedPrimeId
        : null
  };

  const ownedConversations = new Set<string>();
  for (const lease of Object.values(normalized.activeLeases)) {
    const run = normalized.runs[lease.goalRunId];
    if (!run || run.primeConversationId !== lease.primeConversationId) {
      throw new Error(`Autonomous swarm snapshot has conflicting ownership for lease ${lease.leaseId}`);
    }
    if (ownedConversations.has(lease.conversationId)) {
      throw new Error(`Autonomous swarm snapshot duplicates worker conversation ${lease.conversationId}`);
    }
    ownedConversations.add(lease.conversationId);
  }
  for (const entry of normalized.queue) {
    const run = normalized.runs[entry.goalRunId];
    if (!run || run.primeConversationId !== entry.primeConversationId) {
      throw new Error(`Autonomous swarm snapshot has conflicting ownership for queued task ${entry.taskId}`);
    }
  }
  return normalized;
}
