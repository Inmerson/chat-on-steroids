import { randomUUID } from 'node:crypto';

import { AUTONOMOUS_SWARM_LIMITS } from '../../shared/types.js';
import { recoverOrchestrationState } from './recovery.js';
import { appendOrchestrationEvent } from './store.js';
import type {
  AutonomousDispatchQueueEntry,
  DispatchLease,
  TaskRecord
} from './types.js';

export interface AutonomousSchedulerWorker {
  primeConversationId: string;
  workerId: string;
  /** Exact broker incarnation that currently owns this worker. */
  workerRunId: string;
  /** Null while the broker owns a worker row whose ChatGPT conversation is not yet exact. */
  conversationId: string | null;
  /** True while this worker still has an app-originated turn that has not settled. */
  unsettled: boolean;
}

export interface AutonomousSchedulerOwnership {
  primeConversationId: string;
  workerId: string;
  runId: string;
}

export interface AutonomousSchedulerBrowserConversation {
  conversationId: string;
}

/**
 * Browser/broker seams are observations only. This scheduler remains the capability authority:
 * callers may describe exact ownership and browser identity, but they cannot add scope, workers,
 * dispatches, or permissions through these records.
 */
export interface AutonomousSchedulerDependencies {
  now(): number;
  listWorkers(): readonly AutonomousSchedulerWorker[];
  ownershipForConversation(conversationId: string): AutonomousSchedulerOwnership | null;
  browserConversation(conversationId: string): AutonomousSchedulerBrowserConversation | null;
  /** Called only after the exact DISPATCH_LEASED event has crossed the orchestration journal. */
  publish(lease: DispatchLease): void | Promise<void>;
  nextLeaseId?(): string;
  nextCommandId?(): string;
}

export interface AutonomousSchedulerBlocked {
  goalRunId: string;
  taskId: string;
  reason: string;
}

export interface AutonomousSchedulerCycleResult {
  leased: DispatchLease[];
  queued: AutonomousDispatchQueueEntry[];
  cooldownUntil: number | null;
  blocked: AutonomousSchedulerBlocked[];
}

interface Candidate {
  entry: AutonomousDispatchQueueEntry;
  worker: AutonomousSchedulerWorker;
}

function dependenciesVerified(task: TaskRecord, tasks: Record<string, TaskRecord>): boolean {
  return task.state === 'READY' && task.dependencies.every((dependencyId) => tasks[dependencyId]?.state === 'VERIFIED');
}

function stablePrimeOrder(
  queue: readonly AutonomousDispatchQueueEntry[],
  runs: Awaited<ReturnType<typeof recoverOrchestrationState>>['state']['autonomousSwarm']['runs']
): string[] {
  const seen = new Set<string>();
  const fromRuns = Object.values(runs)
    .map((run) => run.primeConversationId)
    .filter((primeConversationId) => {
      if (seen.has(primeConversationId)) return false;
      seen.add(primeConversationId);
      return true;
    });
  const fromQueue = queue
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.queuedAt - b.entry.queuedAt || a.index - b.index)
    .map(({ entry }) => entry.primeConversationId)
    .filter((primeConversationId) => {
      if (seen.has(primeConversationId)) return false;
      seen.add(primeConversationId);
      return true;
    });
  return [...fromRuns, ...fromQueue];
}

export function selectNextPrimeRoundRobin(
  stableOrder: readonly string[],
  eligiblePrimeIds: ReadonlySet<string>,
  lastGrantedPrimeId: string | null
): string | null {
  if (stableOrder.length === 0 || eligiblePrimeIds.size === 0) return null;
  const start = lastGrantedPrimeId ? stableOrder.indexOf(lastGrantedPrimeId) : -1;
  for (let offset = 1; offset <= stableOrder.length; offset += 1) {
    const index = (start + offset + stableOrder.length) % stableOrder.length;
    const candidate = stableOrder[index];
    if (candidate && eligiblePrimeIds.has(candidate)) return candidate;
  }
  return null;
}

function workerCounts(workers: readonly AutonomousSchedulerWorker[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const worker of workers) {
    counts.set(worker.primeConversationId, (counts.get(worker.primeConversationId) ?? 0) + 1);
  }
  return counts;
}

function exactWorkerCandidate(
  entry: AutonomousDispatchQueueEntry,
  task: TaskRecord,
  workers: readonly AutonomousSchedulerWorker[],
  activeLeases: readonly DispatchLease[],
  deps: AutonomousSchedulerDependencies
): { worker: AutonomousSchedulerWorker | null; identityMismatch: boolean } {
  let identityMismatch = false;
  for (const worker of workers) {
    if (worker.primeConversationId !== entry.primeConversationId) continue;
    if (task.assignedWorkerId && worker.workerId !== task.assignedWorkerId) continue;
    if (!worker.conversationId || worker.unsettled) continue;
    if (
      activeLeases.some(
        (lease) =>
          lease.conversationId === worker.conversationId ||
          (lease.primeConversationId === worker.primeConversationId &&
            lease.workerId === worker.workerId &&
            lease.workerRunId === worker.workerRunId)
      )
    ) {
      continue;
    }

    const ownership = deps.ownershipForConversation(worker.conversationId);
    if (
      !ownership ||
      ownership.primeConversationId !== worker.primeConversationId ||
      ownership.workerId !== worker.workerId ||
      ownership.runId !== worker.workerRunId
    ) {
      identityMismatch = true;
      continue;
    }

    const browser = deps.browserConversation(worker.conversationId);
    if (!browser) continue;
    if (browser.conversationId !== worker.conversationId) {
      identityMismatch = true;
      continue;
    }
    return { worker, identityMismatch };
  }
  return { worker: null, identityMismatch };
}

function futureCooldown(
  now: number,
  queue: readonly AutonomousDispatchQueueEntry[],
  runs: Awaited<ReturnType<typeof recoverOrchestrationState>>['state']['autonomousSwarm']['runs']
): number | null {
  let earliest: number | null = null;
  for (const entry of queue) {
    const cooldown = runs[entry.goalRunId]?.cooldownUntil ?? null;
    if (cooldown === null || cooldown <= now) continue;
    earliest = earliest === null ? cooldown : Math.min(earliest, cooldown);
  }
  return earliest;
}

async function runCycle(deps: AutonomousSchedulerDependencies): Promise<AutonomousSchedulerCycleResult> {
  const leased: DispatchLease[] = [];
  const blocked: AutonomousSchedulerBlocked[] = [];
  const blockedKeys = new Set<string>();
  const now = deps.now();

  while (true) {
    const recovered = await recoverOrchestrationState();
    const swarm = recovered.state.autonomousSwarm;
    const activeLeases = Object.values(swarm.activeLeases);
    if (activeLeases.length >= AUTONOMOUS_SWARM_LIMITS.activeTurns) {
      return {
        leased,
        queued: swarm.queue.map((entry) => ({ ...entry })),
        cooldownUntil: futureCooldown(now, swarm.queue, swarm.runs),
        blocked
      };
    }

    // Broker ownership is live authority, not a cycle-start hint. Publishing the prior lease may
    // have consumed or released worker capacity, so re-read it before granting every permit.
    const workers = [...deps.listWorkers()];
    const counts = workerCounts(workers);
    const globalWorkerCapacityValid = workers.length <= AUTONOMOUS_SWARM_LIMITS.totalWorkerChats;

    const candidates: Candidate[] = [];
    const eligiblePrimes = new Set<string>();
    for (const entry of swarm.queue) {
      const run = swarm.runs[entry.goalRunId];
      const task = recovered.state.tasks[entry.taskId];
      if (!run || run.primeConversationId !== entry.primeConversationId) continue;
      if (run.status !== 'RUNNING') continue;
      if (run.cooldownUntil !== null && run.cooldownUntil > now) continue;
      if (entry.queuedAt > now) continue;
      if (!task || !dependenciesVerified(task, recovered.state.tasks)) continue;
      if (activeLeases.some((lease) => lease.goalRunId === entry.goalRunId && lease.taskId === entry.taskId)) continue;

      const perPrimeOwned = counts.get(entry.primeConversationId) ?? 0;
      if (!globalWorkerCapacityValid || perPrimeOwned > AUTONOMOUS_SWARM_LIMITS.workersPerPrime) {
        const key = `${entry.goalRunId}\u0000${entry.taskId}`;
        if (!blockedKeys.has(key)) {
          blockedKeys.add(key);
          blocked.push({
            goalRunId: entry.goalRunId,
            taskId: entry.taskId,
            reason: !globalWorkerCapacityValid
              ? 'autonomous worker ownership exceeds the fixed global worker-chat limit'
              : 'autonomous worker ownership exceeds the fixed per-prime worker-chat limit'
          });
        }
        continue;
      }

      const worker = exactWorkerCandidate(entry, task, workers, activeLeases, deps);
      if (!worker.worker) {
        if (worker.identityMismatch) {
          const key = `${entry.goalRunId}\u0000${entry.taskId}`;
          if (!blockedKeys.has(key)) {
            blockedKeys.add(key);
            blocked.push({
              goalRunId: entry.goalRunId,
              taskId: entry.taskId,
              reason: 'worker/browser identity does not exactly match broker ownership'
            });
          }
        }
        continue;
      }
      candidates.push({ entry, worker: worker.worker });
      eligiblePrimes.add(entry.primeConversationId);
    }

    if (candidates.length === 0) {
      return {
        leased,
        queued: swarm.queue.map((entry) => ({ ...entry })),
        cooldownUntil: futureCooldown(now, swarm.queue, swarm.runs),
        blocked
      };
    }

    const prime = selectNextPrimeRoundRobin(
      stablePrimeOrder(swarm.queue, swarm.runs),
      eligiblePrimes,
      swarm.lastGrantedPrimeId ?? null
    );
    if (!prime) {
      return {
        leased,
        queued: swarm.queue.map((entry) => ({ ...entry })),
        cooldownUntil: futureCooldown(now, swarm.queue, swarm.runs),
        blocked
      };
    }
    const selected = candidates
      .filter((candidate) => candidate.entry.primeConversationId === prime)
      .sort((a, b) => a.entry.queuedAt - b.entry.queuedAt)[0];
    if (!selected?.worker.conversationId) continue;

    const lease: DispatchLease = {
      leaseId: deps.nextLeaseId?.() ?? randomUUID(),
      goalRunId: selected.entry.goalRunId,
      taskId: selected.entry.taskId,
      primeConversationId: selected.entry.primeConversationId,
      workerId: selected.worker.workerId,
      workerRunId: selected.worker.workerRunId,
      conversationId: selected.worker.conversationId,
      commandId: deps.nextCommandId?.() ?? randomUUID(),
      browserEpoch: null,
      turnId: null,
      createdAt: now
    };

    // This append is the permit. No browser callback is reachable before it succeeds.
    await appendOrchestrationEvent({
      eventId: `dispatch-lease:${lease.leaseId}`,
      runId: lease.goalRunId,
      time: now,
      type: 'DISPATCH_LEASED',
      actor: 'kernel',
      entityId: lease.leaseId,
      payload: { lease }
    });
    leased.push(lease);
    await deps.publish(lease);
  }
}

let autonomousSchedulerTail: Promise<void> = Promise.resolve();

/** Every autonomous capacity decision enters this one deterministic critical section. */
export function runAutonomousSchedulerCycle(
  deps: AutonomousSchedulerDependencies
): Promise<AutonomousSchedulerCycleResult> {
  const queued = autonomousSchedulerTail.then(() => runCycle(deps));
  autonomousSchedulerTail = queued.then(() => undefined, () => undefined);
  return queued;
}

/** Test seam only; production never resets the serialization lane. */
export function resetAutonomousSchedulerForTests(): void {
  autonomousSchedulerTail = Promise.resolve();
}
