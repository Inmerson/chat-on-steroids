import type { AgentInfo } from '../../shared/session.js';
import { AUTONOMOUS_SWARM_LIMITS } from '../../shared/types.js';
import type { OrchestrationState } from './reducer.js';
import type { TaskRecord } from './types.js';

export type WorkerAllocationDecision =
  | { strategy: 'reuse'; workerId: string; conversationId: string }
  | { strategy: 'spawn'; workerId: null; conversationId: null };

export interface WorkerAllocationInput {
  task: TaskRecord;
  state: OrchestrationState;
  brokerWorkers: readonly AgentInfo[];
  managerAgentId: string;
}

export interface AutonomousWorkerAllocationInput extends WorkerAllocationInput {
  /** Broker-owned worker chat count for this exact Prime, including sleepers. */
  ownedWorkerChatsForPrime: number;
  /** Broker-owned worker chat count across all autonomous Primes. */
  totalOwnedWorkerChats: number;
  /** True only when the serialized fairness planner granted this Prime the next new-chat slot. */
  fairNewWorkerGrant: boolean;
}

export type AutonomousWorkerAllocationDecision =
  | WorkerAllocationDecision
  | { strategy: 'wait'; reason: 'per_prime_worker_limit' | 'global_worker_limit' | 'fairness_wait' };

export interface AutonomousPrimeWorkerDemand {
  primeConversationId: string;
  /** Stable enqueue time used only as a deterministic tie-breaker. */
  queuedAt: number;
  /** Worker chats this Prime already owns, including sleeping or currently unbound rows. */
  ownedWorkerChats: number;
  /** Total worker chats this Prime currently needs for queued/runnable work. */
  requestedWorkerChats: number;
}

/**
 * Pure admission planner for autonomous worker-chat creation.
 *
 * It never creates a worker and never consults legacy `multiAgent.maxWorkers`. By always
 * choosing the eligible Prime with the fewest currently-owned/planned chats, a first allocation
 * round gives every competing Prime one chance before any second-chat allocation. Stable enqueue
 * time and then Prime id make the result deterministic across equivalent scheduler wakeups.
 */
export function planFairAutonomousWorkerAllocations(
  demands: readonly AutonomousPrimeWorkerDemand[]
): string[] {
  const byPrime = new Map<string, {
    primeConversationId: string;
    queuedAt: number;
    owned: number;
    requested: number;
  }>();

  for (const demand of demands) {
    if (!demand.primeConversationId) continue;
    const owned = Math.max(0, Math.floor(demand.ownedWorkerChats));
    const requested = Math.max(0, Math.floor(demand.requestedWorkerChats));
    const existing = byPrime.get(demand.primeConversationId);
    if (existing) {
      existing.queuedAt = Math.min(existing.queuedAt, demand.queuedAt);
      existing.owned = Math.max(existing.owned, owned);
      existing.requested = Math.max(existing.requested, requested);
      continue;
    }
    byPrime.set(demand.primeConversationId, {
      primeConversationId: demand.primeConversationId,
      queuedAt: Number.isFinite(demand.queuedAt) ? demand.queuedAt : Number.MAX_SAFE_INTEGER,
      owned,
      requested
    });
  }

  const rows = [...byPrime.values()];
  let total = rows.reduce((sum, row) => sum + row.owned, 0);
  const planned: string[] = [];
  while (total < AUTONOMOUS_SWARM_LIMITS.totalWorkerChats) {
    const eligible = rows
      .filter(
        (row) =>
          row.owned < AUTONOMOUS_SWARM_LIMITS.workersPerPrime &&
          row.owned < row.requested
      )
      .sort(
        (a, b) =>
          a.owned - b.owned ||
          a.queuedAt - b.queuedAt ||
          a.primeConversationId.localeCompare(b.primeConversationId)
      );
    const next = eligible[0];
    if (!next) break;
    next.owned += 1;
    total += 1;
    planned.push(next.primeConversationId);
  }
  return planned;
}

const REUSE_TERMINAL = new Set<TaskRecord['state']>(['VERIFIED', 'CANCELLED', 'SUPERSEDED']);

function ownsOutstandingTask(workerId: string, state: OrchestrationState): boolean {
  return Object.values(state.tasks).some(
    (task) => task.assignedWorkerId === workerId && !REUSE_TERMINAL.has(task.state)
  );
}

function recency(worker: AgentInfo): number {
  return worker.sleptAt ?? worker.lastSeenAt ?? worker.activatedAt ?? worker.createdAt;
}

export function selectWorkerAllocation(input: WorkerAllocationInput): WorkerAllocationDecision {
  const eligible = input.brokerWorkers
    .filter(
      (worker) =>
        worker.role === 'worker' &&
        worker.id !== input.managerAgentId &&
        worker.state === 'sleeping' &&
        worker.revivable &&
        Boolean(worker.conversationId) &&
        !ownsOutstandingTask(worker.id, input.state)
    )
    .sort((a, b) => recency(b) - recency(a) || a.id.localeCompare(b.id));

  const worker = eligible[0];
  if (!worker?.conversationId) return { strategy: 'spawn', workerId: null, conversationId: null };
  return { strategy: 'reuse', workerId: worker.id, conversationId: worker.conversationId };
}

/**
 * Autonomous wrapper around the legacy allocator. Reuse does not consume a new worker-chat slot;
 * fresh allocation is admitted only by the fixed product caps and the serialized fairness grant.
 */
export function selectWorkerAllocationForPrime(
  input: AutonomousWorkerAllocationInput
): AutonomousWorkerAllocationDecision {
  const legacy = selectWorkerAllocation(input);
  if (legacy.strategy === 'reuse') return legacy;
  if (input.ownedWorkerChatsForPrime >= AUTONOMOUS_SWARM_LIMITS.workersPerPrime) {
    return { strategy: 'wait', reason: 'per_prime_worker_limit' };
  }
  if (input.totalOwnedWorkerChats >= AUTONOMOUS_SWARM_LIMITS.totalWorkerChats) {
    return { strategy: 'wait', reason: 'global_worker_limit' };
  }
  if (!input.fairNewWorkerGrant) return { strategy: 'wait', reason: 'fairness_wait' };
  return legacy;
}
