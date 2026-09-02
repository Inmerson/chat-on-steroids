import type { AgentInfo } from '../../shared/session.js';
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
