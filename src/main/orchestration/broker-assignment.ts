import {
  snapshotSwarm,
  statusForCaller,
  type Caller
} from '../agents.js';
import { setWorkspaceFor } from '../workspace.js';
import { assignmentMarker } from './task-contract.js';
import type { TaskWorktreeRecord } from './types.js';

export { assignmentMarker } from './task-contract.js';

export type AssignmentEvidenceSource = 'bootstrap_task' | 'message_queue';
export interface AssignmentEvidence {
  workerId: string;
  source: AssignmentEvidenceSource;
}

interface SnapshotMessage {
  text: string;
}

interface SnapshotAgent {
  info: { id: string; role: string; task: string };
  queue: SnapshotMessage[];
}

interface SnapshotDormantRun {
  primeConversationId: string;
  agents: SnapshotAgent[];
}

interface BrokerSnapshot {
  primeConversationId: string | null;
  agents: SnapshotAgent[];
  dormantRuns?: SnapshotDormantRun[];
}

function hasMarkerLine(text: string, marker: string): boolean {
  return text.split(/\r?\n/).some((line) => line === marker);
}

function ownerAgents(snapshot: BrokerSnapshot, ownerPrimeConversationId: string): SnapshotAgent[] | null {
  if (snapshot.primeConversationId === ownerPrimeConversationId) return snapshot.agents;
  const matches = (snapshot.dormantRuns ?? []).filter(
    (owner) => owner.primeConversationId === ownerPrimeConversationId
  );
  if (matches.length > 1) throw new Error('ASSIGNMENT_EVIDENCE_AMBIGUOUS: duplicate Prime owner history');
  return matches[0]?.agents ?? null;
}

export function assignmentEvidenceInSnapshot(
  snapshotInput: unknown,
  ownerPrimeConversationId: string,
  marker: string
): AssignmentEvidence | null {
  if (!snapshotInput || typeof snapshotInput !== 'object') return null;
  const snapshot = snapshotInput as BrokerSnapshot;
  const agents = ownerAgents(snapshot, ownerPrimeConversationId);
  if (!agents) return null;

  const matches = new Map<string, AssignmentEvidenceSource>();
  for (const agent of agents) {
    if (!agent?.info || agent.info.role !== 'worker' || typeof agent.info.id !== 'string') continue;
    if (typeof agent.info.task === 'string' && hasMarkerLine(agent.info.task, marker)) {
      matches.set(agent.info.id, 'bootstrap_task');
    }
    for (const message of Array.isArray(agent.queue) ? agent.queue : []) {
      if (!message || typeof message.text !== 'string' || !hasMarkerLine(message.text, marker)) continue;
      if (!matches.has(agent.info.id)) matches.set(agent.info.id, 'message_queue');
    }
  }
  if (matches.size === 0) return null;
  if (matches.size > 1) {
    throw new Error(`ASSIGNMENT_EVIDENCE_AMBIGUOUS: marker matched ${matches.size} workers`);
  }
  const [workerId, source] = [...matches.entries()][0] as [string, AssignmentEvidenceSource];
  return { workerId, source };
}

export function assignmentEvidenceForPrime(
  ownerPrimeConversationId: string,
  operationId: string
): AssignmentEvidence | null {
  return assignmentEvidenceInSnapshot(
    snapshotSwarm() as unknown,
    ownerPrimeConversationId,
    assignmentMarker(operationId)
  );
}

export function brokerWorkersForPrime(ownerPrimeConversationId: string) {
  const status = statusForCaller({ conversationId: ownerPrimeConversationId });
  return status.state.agents.filter((agent) => agent.role === 'worker');
}

export function brokerFreeSlotsForPrime(ownerPrimeConversationId: string): number {
  return statusForCaller({ conversationId: ownerPrimeConversationId }).freeWorkerSlots;
}

export function bindTaskWorktree(
  workerId: string,
  conversationId: string | null,
  worktree: TaskWorktreeRecord
): void {
  const workspace = { virtual: worktree.virtualPath, real: worktree.realPath };
  setWorkspaceFor(`agent:${workerId}`, workspace);
  if (conversationId) setWorkspaceFor(`chat:${conversationId}`, workspace);
}

/** Compile-time-only seam used by scheduler signatures without widening model input. */
export type BrokerCaller = Caller;
