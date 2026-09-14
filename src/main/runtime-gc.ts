import type { AgentInfo } from '../shared/session.js';
import { agentInfoForOwnedConversation, snapshotSwarm, type SwarmSnapshot } from './agents.js';
import { unifiedExecManager } from './codex/manager.js';
import {
  backgroundExecObligations,
  execOwner,
  forgetExecOwner
} from './codex/ownership.js';
import { runningToolCalls } from './mcp/call-context.js';
import { findSessionByConversation } from './session/store.js';

/**
 * Runtime retention is a resource policy, not a worker-liveness deadline.
 * Sleeping workers keep their durable broker/session identity after this age.
 */
export const AGENT_RUNTIME_RETENTION_MS = 30 * 60_000;

export interface AgentRuntimeGcCandidate {
  runId: string;
  primeConversationId: string;
  agentId: string;
  conversationId: string;
  sleptAt: number;
}

export type AgentRuntimeGcSkipReason =
  | 'worker_changed'
  | 'tool_work_running'
  | 'session_identity_unproven'
  | 'process_completed'
  | 'process_disappeared'
  | 'process_owner_changed'
  | 'termination_failed';

export interface AgentRuntimeGcSkip {
  candidate: AgentRuntimeGcCandidate;
  processId: number | null;
  reason: AgentRuntimeGcSkipReason;
}

export interface AgentRuntimeGcSweepResult {
  candidates: number;
  terminated: number[];
  skipped: AgentRuntimeGcSkip[];
}

interface BackgroundState {
  running: number[];
  exitedUnread: Array<{ processId: number; exitCode: number | null }>;
}

interface SessionIdentity {
  id: string;
  conversationId: string | null;
}

export interface AgentRuntimeGcDeps {
  snapshot: () => SwarmSnapshot | null;
  agentInfo: (conversationId: string) => AgentInfo | null;
  findSession: (conversationId: string) => Promise<SessionIdentity | null>;
  runningToolCalls: (conversationId: string) => number;
  backgroundState: (sessionId: string) => BackgroundState;
  execOwner: (processId: number) => string | null;
  terminateProcess: (processId: number) => Promise<boolean>;
  forgetExecOwner: (processId: number) => void;
}

const defaultDeps: AgentRuntimeGcDeps = {
  snapshot: snapshotSwarm,
  agentInfo: agentInfoForOwnedConversation,
  findSession: async (conversationId) =>
    findSessionByConversation(conversationId, { requireUnique: true }),
  runningToolCalls,
  backgroundState: backgroundExecObligations,
  execOwner,
  terminateProcess: (processId) => unifiedExecManager.terminateProcess(processId),
  forgetExecOwner
};

function sameCandidate(info: AgentInfo | null, candidate: AgentRuntimeGcCandidate): boolean {
  return Boolean(
    info &&
    info.role === 'worker' &&
    info.state === 'sleeping' &&
    info.revivable &&
    info.runId === candidate.runId &&
    info.primeConversationId === candidate.primeConversationId &&
    info.id === candidate.agentId &&
    info.conversationId === candidate.conversationId &&
    info.sleptAt === candidate.sleptAt
  );
}

function candidateFrom(
  info: AgentInfo,
  owner: { runId: string | null; primeConversationId: string },
  observedAt: number,
  retentionMs: number
): AgentRuntimeGcCandidate | null {
  if (
    info.role !== 'worker' ||
    info.state !== 'sleeping' ||
    !info.revivable ||
    !info.conversationId ||
    !Number.isFinite(info.sleptAt) ||
    info.sleptAt === null ||
    info.sleptAt > observedAt ||
    observedAt - info.sleptAt < retentionMs
  ) {
    return null;
  }

  const runId = info.runId ?? owner.runId;
  const primeConversationId = info.primeConversationId ?? owner.primeConversationId;
  if (!runId || !primeConversationId) return null;
  if (owner.runId && runId !== owner.runId) return null;
  if (primeConversationId !== owner.primeConversationId) return null;

  return {
    runId,
    primeConversationId,
    agentId: info.id,
    conversationId: info.conversationId,
    sleptAt: info.sleptAt
  };
}

/**
 * Selects only old, revivable sleeping workers from committed broker state.
 * The top-level v6 compatibility projection is ignored to avoid double-counting active runs.
 */
export function agentRuntimeGcCandidates(
  snapshot: SwarmSnapshot | null,
  observedAt: number,
  retentionMs = AGENT_RUNTIME_RETENTION_MS
): AgentRuntimeGcCandidate[] {
  if (!snapshot || !Number.isFinite(observedAt) || !Number.isFinite(retentionMs) || retentionMs < 0) return [];

  const candidates: AgentRuntimeGcCandidate[] = [];
  const seen = new Set<string>();
  const activeRuns = snapshot.activeRuns ?? (
    snapshot.runId && snapshot.primeConversationId
      ? [{ runId: snapshot.runId, primeConversationId: snapshot.primeConversationId, startedAt: snapshot.startedAt ?? 0, agents: snapshot.agents }]
      : []
  );

  for (const run of activeRuns) {
    for (const row of run.agents) {
      const candidate = candidateFrom(row.info, {
        runId: run.runId,
        primeConversationId: run.primeConversationId
      }, observedAt, retentionMs);
      if (!candidate) continue;
      const key = `${candidate.runId}\n${candidate.agentId}\n${candidate.conversationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  for (const dormant of snapshot.dormantRuns ?? []) {
    for (const row of dormant.agents) {
      const candidate = candidateFrom(row.info, {
        runId: null,
        primeConversationId: dormant.primeConversationId
      }, observedAt, retentionMs);
      if (!candidate) continue;
      const key = `${candidate.runId}\n${candidate.agentId}\n${candidate.conversationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function completed(state: BackgroundState, processId: number): boolean {
  return state.exitedUnread.some((row) => row.processId === processId);
}

/**
 * Releases only live exec processes that still belong to an old sleeping worker.
 *
 * Candidate discovery is deliberately weak authority. Before each destructive call this sweep
 * synchronously re-reads the exact worker, current tool ownership, process state and process
 * owner. With no await between those final checks and `terminateProcess()`, a wake that has
 * already begun wins by changing the worker to `waking`; a later wake simply recreates runtime
 * resources on demand while durable worker/session state remains untouched.
 *
 * No scheduler lives here. Callers may place this sweep on an existing coarse maintenance lane.
 */
export async function sweepAgentRuntimeGc(
  observedAt = Date.now(),
  retentionMs = AGENT_RUNTIME_RETENTION_MS,
  deps: AgentRuntimeGcDeps = defaultDeps
): Promise<AgentRuntimeGcSweepResult> {
  const candidates = agentRuntimeGcCandidates(deps.snapshot(), observedAt, retentionMs);
  const result: AgentRuntimeGcSweepResult = { candidates: candidates.length, terminated: [], skipped: [] };

  for (const candidate of candidates) {
    if (!sameCandidate(deps.agentInfo(candidate.conversationId), candidate)) {
      result.skipped.push({ candidate, processId: null, reason: 'worker_changed' });
      continue;
    }
    if (deps.runningToolCalls(candidate.conversationId) > 0) {
      result.skipped.push({ candidate, processId: null, reason: 'tool_work_running' });
      continue;
    }

    const session = await deps.findSession(candidate.conversationId);
    if (!session || session.conversationId !== candidate.conversationId) {
      result.skipped.push({ candidate, processId: null, reason: 'session_identity_unproven' });
      continue;
    }

    const processIds = [...deps.backgroundState(session.id).running];
    for (const processId of processIds) {
      // Final destructive boundary. Everything below this point is synchronous until
      // terminateProcess() has started terminating the exact process entry.
      if (!sameCandidate(deps.agentInfo(candidate.conversationId), candidate)) {
        result.skipped.push({ candidate, processId, reason: 'worker_changed' });
        continue;
      }
      if (deps.runningToolCalls(candidate.conversationId) > 0) {
        result.skipped.push({ candidate, processId, reason: 'tool_work_running' });
        continue;
      }
      const current = deps.backgroundState(session.id);
      if (!current.running.includes(processId)) {
        result.skipped.push({
          candidate,
          processId,
          reason: completed(current, processId) ? 'process_completed' : 'process_disappeared'
        });
        continue;
      }
      if (deps.execOwner(processId) !== session.id) {
        result.skipped.push({ candidate, processId, reason: 'process_owner_changed' });
        continue;
      }

      try {
        if (!(await deps.terminateProcess(processId))) {
          result.skipped.push({ candidate, processId, reason: 'process_disappeared' });
          continue;
        }
      } catch {
        result.skipped.push({ candidate, processId, reason: 'termination_failed' });
        continue;
      }

      // `terminateProcess()` may release the numeric id. Forget the old ownership row only if
      // no process with that id has appeared again before this continuation resumes.
      const after = deps.backgroundState(session.id);
      if (
        deps.execOwner(processId) === session.id &&
        !after.running.includes(processId) &&
        !completed(after, processId)
      ) {
        deps.forgetExecOwner(processId);
      }
      result.terminated.push(processId);
    }
  }

  return result;
}
