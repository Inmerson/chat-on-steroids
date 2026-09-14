import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../src/shared/session.js';
import type { SwarmSnapshot } from '../src/main/agents.js';
import {
  AGENT_RUNTIME_RETENTION_MS,
  agentRuntimeGcCandidates,
  sweepAgentRuntimeGc,
  type AgentRuntimeGcDeps
} from '../src/main/runtime-gc.js';

const NOW = 10_000_000;
const OLD_SLEEP = NOW - AGENT_RUNTIME_RETENTION_MS - 1;

function worker(overrides: Partial<AgentInfo> = {}): AgentInfo {
  const conversationId = overrides.conversationId ?? 'c-worker-1';
  return {
    runId: 'run-a',
    primeConversationId: 'c-prime-a',
    id: 'worker-1',
    role: 'worker',
    label: 'Worker 1',
    task: 'task',
    reasoningEffort: null,
    model: null,
    state: 'sleeping',
    createdAt: 1,
    activatedAt: 2,
    finishedAt: null,
    result: null,
    pending: 0,
    awaitingAck: 0,
    delivered: 0,
    conversationId,
    detachedAt: null,
    lastSeenAt: 3,
    revivable: true,
    sleptAt: OLD_SLEEP,
    contextTokens: 100,
    ...overrides
  };
}

function snapshotFor(infos: AgentInfo[]): SwarmSnapshot {
  const grouped = new Map<string, { runId: string; primeConversationId: string; agents: Array<{ info: AgentInfo; queue: [] }> }>();
  for (const info of infos) {
    if (!info.runId || !info.primeConversationId) continue;
    const group = grouped.get(info.runId) ?? {
      runId: info.runId,
      primeConversationId: info.primeConversationId,
      agents: []
    };
    group.agents.push({ info: { ...info }, queue: [] });
    grouped.set(info.runId, group);
  }
  const activeRuns = [...grouped.values()].map((run) => ({ ...run, startedAt: 1 }));
  const sole = activeRuns.length === 1 ? activeRuns[0] : null;
  return {
    version: 6,
    savedAt: NOW,
    runId: sole?.runId ?? null,
    primeConversationId: sole?.primeConversationId ?? null,
    startedAt: sole?.startedAt ?? null,
    agents: sole?.agents ?? [],
    activeRuns,
    dormantRuns: []
  } as SwarmSnapshot;
}

interface Harness {
  deps: AgentRuntimeGcDeps;
  infos: Map<string, AgentInfo>;
  sessions: Map<string, { id: string; conversationId: string | null }>;
  running: Map<string, Set<number>>;
  exited: Map<string, Array<{ processId: number; exitCode: number | null }>>;
  owners: Map<number, string>;
  terminated: number[];
  forgotten: number[];
  toolCalls: Map<string, number>;
}

function harness(initial: AgentInfo[], processes: Array<{ conversationId: string; processId: number }> = []): Harness {
  const infos = new Map(initial.map((info) => [info.conversationId as string, { ...info }]));
  const sessions = new Map<string, { id: string; conversationId: string | null }>();
  const running = new Map<string, Set<number>>();
  const exited = new Map<string, Array<{ processId: number; exitCode: number | null }>>();
  const owners = new Map<number, string>();
  const terminated: number[] = [];
  const forgotten: number[] = [];
  const toolCalls = new Map<string, number>();

  for (const info of initial) {
    if (!info.conversationId) continue;
    const id = `session:${info.conversationId}`;
    sessions.set(info.conversationId, { id, conversationId: info.conversationId });
    running.set(id, new Set());
    exited.set(id, []);
  }
  for (const row of processes) {
    const session = sessions.get(row.conversationId);
    if (!session) continue;
    running.get(session.id)?.add(row.processId);
    owners.set(row.processId, session.id);
  }

  const deps: AgentRuntimeGcDeps = {
    snapshot: () => snapshotFor([...infos.values()]),
    agentInfo: (conversationId) => infos.get(conversationId) ?? null,
    findSession: async (conversationId) => sessions.get(conversationId) ?? null,
    runningToolCalls: (conversationId) => toolCalls.get(conversationId) ?? 0,
    backgroundState: (sessionId) => ({
      running: [...(running.get(sessionId) ?? new Set())],
      exitedUnread: [...(exited.get(sessionId) ?? [])]
    }),
    execOwner: (processId) => owners.get(processId) ?? null,
    terminateProcess: async (processId) => {
      const sessionId = owners.get(processId);
      if (!sessionId || !running.get(sessionId)?.has(processId)) return false;
      running.get(sessionId)?.delete(processId);
      terminated.push(processId);
      return true;
    },
    forgetExecOwner: (processId) => {
      forgotten.push(processId);
      owners.delete(processId);
    }
  };

  return { deps, infos, sessions, running, exited, owners, terminated, forgotten, toolCalls };
}

describe('sleeping worker runtime GC', () => {
  it('selects only old revivable sleeping workers with exact durable identity', () => {
    const eligible = worker();
    const recent = worker({ id: 'worker-2', conversationId: 'c-recent', sleptAt: NOW - 1 });
    const active = worker({ id: 'worker-3', conversationId: 'c-active', state: 'active' });
    const terminal = worker({ id: 'worker-4', conversationId: 'c-terminal', state: 'finished', revivable: false });
    const future = worker({ id: 'worker-5', conversationId: 'c-future', sleptAt: NOW + 1 });
    const missingRun = worker({ id: 'worker-6', conversationId: 'c-missing-run', runId: undefined });

    expect(agentRuntimeGcCandidates(snapshotFor([eligible, recent, active, terminal, future, missingRun]), NOW)).toEqual([
      {
        runId: 'run-a',
        primeConversationId: 'c-prime-a',
        agentId: 'worker-1',
        conversationId: 'c-worker-1',
        sleptAt: OLD_SLEEP
      }
    ]);
  });

  it('terminates an exact owned idle process without changing durable worker identity', async () => {
    const info = worker();
    const h = harness([info], [{ conversationId: info.conversationId as string, processId: 41 }]);

    const result = await sweepAgentRuntimeGc(NOW, AGENT_RUNTIME_RETENTION_MS, h.deps);

    expect(result.terminated).toEqual([41]);
    expect(h.terminated).toEqual([41]);
    expect(h.forgotten).toEqual([41]);
    expect(h.infos.get('c-worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-1',
      runId: 'run-a',
      id: 'worker-1'
    });
  });

  it('aborts when the candidate begins waking while session identity is being resolved', async () => {
    const info = worker();
    const h = harness([info], [{ conversationId: 'c-worker-1', processId: 42 }]);
    const originalFind = h.deps.findSession;
    h.deps.findSession = async (conversationId) => {
      const current = h.infos.get(conversationId);
      if (current) current.state = 'waking';
      return originalFind(conversationId);
    };

    const result = await sweepAgentRuntimeGc(NOW, AGENT_RUNTIME_RETENTION_MS, h.deps);

    expect(result.terminated).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ processId: 42, reason: 'worker_changed' })
    ]);
    expect(h.running.get('session:c-worker-1')?.has(42)).toBe(true);
  });

  it('does not reclaim a worker while an exact MCP tool call is still running', async () => {
    const info = worker();
    const h = harness([info], [{ conversationId: 'c-worker-1', processId: 43 }]);
    h.toolCalls.set('c-worker-1', 1);

    const result = await sweepAgentRuntimeGc(NOW, AGENT_RUNTIME_RETENTION_MS, h.deps);

    expect(result.terminated).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ processId: null, reason: 'tool_work_running' })
    ]);
  });

  it('preserves a process that completed after candidate scan so unread output is not discarded', async () => {
    const info = worker();
    const h = harness([info], [{ conversationId: 'c-worker-1', processId: 44 }]);
    const baseState = h.deps.backgroundState;
    let reads = 0;
    h.deps.backgroundState = (sessionId) => {
      reads += 1;
      if (reads === 1) return baseState(sessionId);
      h.running.get(sessionId)?.delete(44);
      h.exited.set(sessionId, [{ processId: 44, exitCode: 0 }]);
      return baseState(sessionId);
    };

    const result = await sweepAgentRuntimeGc(NOW, AGENT_RUNTIME_RETENTION_MS, h.deps);

    expect(result.terminated).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ processId: 44, reason: 'process_completed' })
    ]);
    expect(h.forgotten).toEqual([]);
  });

  it('fails closed when exact process ownership changes before termination', async () => {
    const info = worker();
    const h = harness([info], [{ conversationId: 'c-worker-1', processId: 45 }]);
    h.deps.execOwner = () => 'session:someone-else';

    const result = await sweepAgentRuntimeGc(NOW, AGENT_RUNTIME_RETENTION_MS, h.deps);

    expect(result.terminated).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ processId: 45, reason: 'process_owner_changed' })
    ]);
  });

  it('keeps identical local worker ids isolated by run, prime and conversation identity', async () => {
    const a = worker({ runId: 'run-a', primeConversationId: 'prime-a', conversationId: 'worker-a' });
    const b = worker({ runId: 'run-b', primeConversationId: 'prime-b', conversationId: 'worker-b' });
    const h = harness([
      a,
      b
    ], [
      { conversationId: 'worker-a', processId: 51 },
      { conversationId: 'worker-b', processId: 52 }
    ]);
    const owner = h.deps.execOwner;
    h.deps.execOwner = (processId) => processId === 52 ? 'session:wrong-owner' : owner(processId);

    const result = await sweepAgentRuntimeGc(NOW, AGENT_RUNTIME_RETENTION_MS, h.deps);

    expect(result.terminated).toEqual([51]);
    expect(result.skipped).toContainEqual(expect.objectContaining({ processId: 52, reason: 'process_owner_changed' }));
    expect(h.running.get('session:worker-b')?.has(52)).toBe(true);
  });

  it('rechecks before each process so a wake after the first reclaim preserves the rest', async () => {
    const info = worker();
    const h = harness([info], [
      { conversationId: 'c-worker-1', processId: 61 },
      { conversationId: 'c-worker-1', processId: 62 }
    ]);
    const terminate = h.deps.terminateProcess;
    h.deps.terminateProcess = async (processId) => {
      const result = await terminate(processId);
      if (processId === 61) {
        const current = h.infos.get('c-worker-1');
        if (current) current.state = 'waking';
      }
      return result;
    };

    const result = await sweepAgentRuntimeGc(NOW, AGENT_RUNTIME_RETENTION_MS, h.deps);

    expect(result.terminated).toEqual([61]);
    expect(result.skipped).toContainEqual(expect.objectContaining({ processId: 62, reason: 'worker_changed' }));
    expect(h.running.get('session:c-worker-1')?.has(62)).toBe(true);
  });

  it('requires the durable session to still be attached to the exact worker conversation', async () => {
    const info = worker();
    const h = harness([info], [{ conversationId: 'c-worker-1', processId: 71 }]);
    h.sessions.set('c-worker-1', { id: 'session:c-worker-1', conversationId: 'replacement-chat' });

    const result = await sweepAgentRuntimeGc(NOW, AGENT_RUNTIME_RETENTION_MS, h.deps);

    expect(result.terminated).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ processId: null, reason: 'session_identity_unproven' })
    ]);
  });

  it('does nothing after restart when sleeping history exists but no runtime ownership was reconstructed', async () => {
    const info = worker();
    const h = harness([info]);

    const result = await sweepAgentRuntimeGc(NOW, AGENT_RUNTIME_RETENTION_MS, h.deps);

    expect(result).toMatchObject({ candidates: 1, terminated: [], skipped: [] });
    expect(h.forgotten).toEqual([]);
  });
});
