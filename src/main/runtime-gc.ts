import type { AgentInfo } from '../shared/session.js';
import { agentInfoForOwnedConversation } from './agents.js';
import { unifiedExecManager } from './codex/manager.js';
import {
  backgroundExecObligations,
  execOwner,
  forgetExecOwner
} from './codex/ownership.js';
import type { BackgroundExecState, BackgroundTerminalInfo } from './codex/unified-exec.js';
import { runningToolCalls } from './mcp/call-context.js';
import { getSession } from './session/store.js';

/** Resource retention policy; this is never a worker-liveness deadline. */
export const AGENT_RUNTIME_RETENTION_MS = 30 * 60_000;

interface SessionIdentity {
  id: string;
  conversationId: string | null;
}

interface WorkerProof {
  runId: string;
  primeConversationId: string;
  agentId: string;
  conversationId: string;
  sleptAt: number;
}

export interface AgentRuntimeGcDependencies {
  listProcesses(): BackgroundTerminalInfo[];
  execOwner(processId: number): string | null;
  getSession(sessionId: string): Promise<SessionIdentity | null>;
  agentInfo(conversationId: string): AgentInfo | null;
  runningToolCalls(conversationId: string): number;
  backgroundState(sessionId: string): BackgroundExecState;
  terminateProcess(processId: number): Promise<boolean>;
  forgetExecOwner(processId: number): void;
}

export interface AgentRuntimeGcSummary {
  checked: number;
  eligible: number;
  terminated: number;
  unowned: number;
  ineligible: number;
  busy: number;
  changed: number;
  completed: number;
  missing: number;
  failed: number;
}

const defaultDependencies: AgentRuntimeGcDependencies = {
  listProcesses: () => unifiedExecManager.listProcesses(),
  execOwner,
  getSession,
  agentInfo: agentInfoForOwnedConversation,
  runningToolCalls,
  backgroundState: backgroundExecObligations,
  terminateProcess: (processId) => unifiedExecManager.terminateProcess(processId),
  forgetExecOwner
};

function emptySummary(): AgentRuntimeGcSummary {
  return {
    checked: 0,
    eligible: 0,
    terminated: 0,
    unowned: 0,
    ineligible: 0,
    busy: 0,
    changed: 0,
    completed: 0,
    missing: 0,
    failed: 0
  };
}

function workerProof(info: AgentInfo | null, conversationId: string, cutoff: number): WorkerProof | null {
  if (
    !info ||
    info.role !== 'worker' ||
    info.state !== 'sleeping' ||
    !info.revivable ||
    info.conversationId !== conversationId ||
    !info.runId ||
    !info.primeConversationId ||
    info.sleptAt === null ||
    !Number.isFinite(info.sleptAt) ||
    info.sleptAt > cutoff
  ) {
    return null;
  }
  return {
    runId: info.runId,
    primeConversationId: info.primeConversationId,
    agentId: info.id,
    conversationId,
    sleptAt: info.sleptAt
  };
}

function sameProof(left: WorkerProof | null, right: WorkerProof): boolean {
  return Boolean(
    left &&
    left.runId === right.runId &&
    left.primeConversationId === right.primeConversationId &&
    left.agentId === right.agentId &&
    left.conversationId === right.conversationId &&
    left.sleptAt === right.sleptAt
  );
}

function containsProcess(state: BackgroundExecState, processId: number): boolean {
  return state.running.includes(processId) || state.exitedUnread.some((row) => row.processId === processId);
}

/**
 * Releases live exec processes only when their exact durable session still belongs to the
 * same long-sleeping, revivable worker.
 *
 * Discovery is not authority. After every await, the sweep re-reads durable session attachment,
 * broker identity, current tool work, process state and process ownership before starting a
 * destructive call. No worker/history/session state is mutated here, and no timer lives here;
 * a caller may place this sweep on an existing coarse maintenance lane.
 */
export async function sweepAgentRuntimeGc(
  now = Date.now(),
  dependencies: AgentRuntimeGcDependencies = defaultDependencies
): Promise<AgentRuntimeGcSummary> {
  const cutoff = now - AGENT_RUNTIME_RETENTION_MS;
  const summary = emptySummary();

  for (const runtime of dependencies.listProcesses()) {
    summary.checked += 1;
    const sessionId = dependencies.execOwner(runtime.processId);
    if (!sessionId) {
      summary.unowned += 1;
      continue;
    }

    const firstSession = await dependencies.getSession(sessionId);
    const conversationId = firstSession?.conversationId ?? null;
    if (!conversationId) {
      summary.ineligible += 1;
      continue;
    }
    const proof = workerProof(dependencies.agentInfo(conversationId), conversationId, cutoff);
    if (!proof) {
      summary.ineligible += 1;
      continue;
    }
    if (dependencies.runningToolCalls(conversationId) > 0) {
      summary.busy += 1;
      continue;
    }

    // Final async identity read. Everything after it is synchronous until terminateProcess()
    // has begun against this exact process id, so a wake/owner move already in progress wins.
    const currentSession = await dependencies.getSession(sessionId);
    if (!currentSession || currentSession.conversationId !== conversationId) {
      summary.changed += 1;
      continue;
    }
    if (!sameProof(workerProof(dependencies.agentInfo(conversationId), conversationId, cutoff), proof)) {
      summary.changed += 1;
      continue;
    }
    if (dependencies.runningToolCalls(conversationId) > 0) {
      summary.busy += 1;
      continue;
    }

    const currentState = dependencies.backgroundState(sessionId);
    if (currentState.exitedUnread.some((row) => row.processId === runtime.processId)) {
      // Completed output is an undelivered obligation, not garbage.
      summary.completed += 1;
      continue;
    }
    if (!currentState.running.includes(runtime.processId)) {
      summary.missing += 1;
      continue;
    }
    if (dependencies.execOwner(runtime.processId) !== sessionId) {
      summary.changed += 1;
      continue;
    }

    summary.eligible += 1;
    let terminated = false;
    try {
      terminated = await dependencies.terminateProcess(runtime.processId);
    } catch {
      summary.failed += 1;
      continue;
    }
    if (!terminated) {
      summary.missing += 1;
      continue;
    }

    // Numeric ids are reusable. Never erase attribution for a replacement process that appeared
    // while process-tree termination was settling.
    const after = dependencies.backgroundState(sessionId);
    if (dependencies.execOwner(runtime.processId) === sessionId && !containsProcess(after, runtime.processId)) {
      dependencies.forgetExecOwner(runtime.processId);
    }
    summary.terminated += 1;
  }

  return summary;
}
