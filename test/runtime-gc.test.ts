import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentState } from '../src/shared/session.js';
import {
  AGENT_RUNTIME_RETENTION_MS,
  sweepAgentRuntimeGc,
  type AgentRuntimeGcDependencies
} from '../src/main/runtime-gc.js';

const NOW = 2_000_000_000;
const OLD = NOW - AGENT_RUNTIME_RETENTION_MS - 1;
const PROCESS_ID = 101;
const SESSION_ID = 'session-worker';
const CONVERSATION_ID = 'chat-worker';

function workerInfo(
  state: AgentState = 'sleeping',
  overrides: Partial<AgentInfo> = {}
): AgentInfo {
  return {
    runId: 'run-a',
    primeConversationId: 'chat-prime',
    id: 'worker-1',
    role: 'worker',
    label: 'GC worker',
    task: 'test runtime gc',
    reasoningEffort: null,
    model: null,
    state,
    createdAt: OLD - 1_000,
    activatedAt: OLD - 500,
    finishedAt: null,
    result: null,
    pending: 0,
    awaitingAck: 0,
    delivered: 0,
    conversationId: CONVERSATION_ID,
    detachedAt: null,
    lastSeenAt: OLD,
    revivable: true,
    sleptAt: OLD,
    contextTokens: 100,
    ...overrides
  };
}

function runtime(processId = PROCESS_ID) {
  return {
    processId,
    command: 'npm run dev',
    cwd: '/repo',
    pid: 1_001,
    tty: true
  };
}

function fixture(): {
  deps: AgentRuntimeGcDependencies;
  setOwner: (owner: string | null) => void;
  setAgent: (agent: AgentInfo | null) => void;
  setSessionConversation: (conversationId: string | null) => void;
  setToolCalls: (count: number) => void;
  setAlive: (alive: boolean) => void;
  setCompleted: (completed: boolean) => void;
  terminateProcess: ReturnType<typeof vi.fn>;
  forgetExecOwner: ReturnType<typeof vi.fn>;
} {
  let owner: string | null = SESSION_ID;
  let agent: AgentInfo | null = workerInfo();
  let sessionConversation: string | null = CONVERSATION_ID;
  let toolCalls = 0;
  let alive = true;
  let completed = false;

  const terminateProcess = vi.fn(async () => {
    alive = false;
    return true;
  });
  const forgetExecOwner = vi.fn(() => {
    owner = null;
  });

  return {
    deps: {
      listProcesses: () => [runtime()],
      execOwner: () => owner,
      getSession: async (sessionId) => sessionId === SESSION_ID
        ? { id: SESSION_ID, conversationId: sessionConversation }
        : null,
      agentInfo: () => agent,
      runningToolCalls: () => toolCalls,
      backgroundState: () => ({
        running: alive && !completed ? [PROCESS_ID] : [],
        exitedUnread: completed ? [{ processId: PROCESS_ID, exitCode: 0 }] : []
      }),
      terminateProcess,
      forgetExecOwner
    },
    setOwner: (value) => { owner = value; },
    setAgent: (value) => { agent = value; },
    setSessionConversation: (value) => { sessionConversation = value; },
    setToolCalls: (value) => { toolCalls = value; },
    setAlive: (value) => { alive = value; },
    setCompleted: (value) => { completed = value; },
    terminateProcess,
    forgetExecOwner
  };
}

describe('sleeping worker runtime GC', () => {
  it('terminates only the exact old sleeping worker runtime and leaves broker identity untouched', async () => {
    const fake = fixture();
    const before = workerInfo();
    fake.setAgent(before);

    const summary = await sweepAgentRuntimeGc(NOW, fake.deps);

    expect(fake.terminateProcess).toHaveBeenCalledWith(PROCESS_ID);
    expect(fake.forgetExecOwner).toHaveBeenCalledWith(PROCESS_ID);
    expect(summary).toMatchObject({ checked: 1, eligible: 1, terminated: 1 });
    expect(before).toMatchObject({
      runId: 'run-a',
      id: 'worker-1',
      state: 'sleeping',
      conversationId: CONVERSATION_ID,
      sleptAt: OLD
    });
  });

  it('fails closed when the process has no proven durable-session owner', async () => {
    const fake = fixture();
    fake.setOwner(null);

    const summary = await sweepAgentRuntimeGc(NOW, fake.deps);

    expect(fake.terminateProcess).not.toHaveBeenCalled();
    expect(summary.unowned).toBe(1);
  });

  it.each<AgentState>(['active', 'detached', 'waking', 'invited', 'failed', 'finished'])(
    'does not collect a %s worker',
    async (state) => {
      const fake = fixture();
      fake.setAgent(workerInfo(state));
      const summary = await sweepAgentRuntimeGc(NOW, fake.deps);
      expect(fake.terminateProcess).not.toHaveBeenCalled();
      expect(summary.ineligible).toBe(1);
    }
  );

  it('requires a revivable worker with an old sleep boundary and exact owner metadata', async () => {
    for (const agent of [
      workerInfo('sleeping', { revivable: false }),
      workerInfo('sleeping', { sleptAt: null }),
      workerInfo('sleeping', { sleptAt: NOW - AGENT_RUNTIME_RETENTION_MS + 1 }),
      workerInfo('sleeping', { runId: undefined }),
      workerInfo('sleeping', { primeConversationId: undefined }),
      workerInfo('sleeping', { conversationId: 'other-chat' }),
      workerInfo('sleeping', { role: 'prime', id: 'prime' })
    ]) {
      const fake = fixture();
      fake.setAgent(agent);
      const summary = await sweepAgentRuntimeGc(NOW, fake.deps);
      expect(fake.terminateProcess).not.toHaveBeenCalled();
      expect(summary.ineligible).toBe(1);
    }
  });

  it('preserves a sleeping worker runtime while exact MCP tool work is still running', async () => {
    const fake = fixture();
    fake.setToolCalls(1);

    const summary = await sweepAgentRuntimeGc(NOW, fake.deps);

    expect(fake.terminateProcess).not.toHaveBeenCalled();
    expect(summary.busy).toBe(1);
  });

  it('rechecks durable session attachment after the async lookup boundary', async () => {
    const fake = fixture();
    let reads = 0;
    fake.deps.getSession = async () => {
      reads += 1;
      return { id: SESSION_ID, conversationId: reads === 1 ? CONVERSATION_ID : 'replacement-chat' };
    };

    const summary = await sweepAgentRuntimeGc(NOW, fake.deps);

    expect(fake.terminateProcess).not.toHaveBeenCalled();
    expect(summary.changed).toBe(1);
  });

  it('rechecks worker lifecycle so a wake racing the sweep wins', async () => {
    const fake = fixture();
    let reads = 0;
    fake.deps.agentInfo = () => {
      reads += 1;
      return workerInfo(reads === 1 ? 'sleeping' : 'waking');
    };

    const summary = await sweepAgentRuntimeGc(NOW, fake.deps);

    expect(fake.terminateProcess).not.toHaveBeenCalled();
    expect(summary.changed).toBe(1);
  });

  it('preserves completed unread output rather than treating it as garbage', async () => {
    const fake = fixture();
    fake.setCompleted(true);

    const summary = await sweepAgentRuntimeGc(NOW, fake.deps);

    expect(fake.terminateProcess).not.toHaveBeenCalled();
    expect(fake.forgetExecOwner).not.toHaveBeenCalled();
    expect(summary.completed).toBe(1);
  });

  it('rechecks exact process ownership immediately before termination', async () => {
    const fake = fixture();
    let reads = 0;
    fake.deps.execOwner = () => {
      reads += 1;
      return reads === 1 ? SESSION_ID : 'session-other';
    };

    const summary = await sweepAgentRuntimeGc(NOW, fake.deps);

    expect(fake.terminateProcess).not.toHaveBeenCalled();
    expect(summary.changed).toBe(1);
  });

  it('does not erase attribution for a replacement numeric process id after termination settles', async () => {
    const fake = fixture();
    let owner = SESSION_ID;
    fake.deps.execOwner = () => owner;
    fake.deps.terminateProcess = vi.fn(async () => {
      fake.setAlive(false);
      owner = 'session-reused';
      return true;
    });

    const summary = await sweepAgentRuntimeGc(NOW, fake.deps);

    expect(summary.terminated).toBe(1);
    expect(fake.forgetExecOwner).not.toHaveBeenCalled();
  });

  it('rechecks each live process independently, so waking after one reclaim preserves the next', async () => {
    const first = runtime(201);
    const second = runtime(202);
    let state: AgentState = 'sleeping';
    const owners = new Map<number, string>([[201, SESSION_ID], [202, SESSION_ID]]);
    const alive = new Set([201, 202]);
    const terminated: number[] = [];
    const deps: AgentRuntimeGcDependencies = {
      listProcesses: () => [first, second],
      execOwner: (processId) => owners.get(processId) ?? null,
      getSession: async () => ({ id: SESSION_ID, conversationId: CONVERSATION_ID }),
      agentInfo: () => workerInfo(state),
      runningToolCalls: () => 0,
      backgroundState: () => ({ running: [...alive], exitedUnread: [] }),
      terminateProcess: async (processId) => {
        alive.delete(processId);
        terminated.push(processId);
        if (processId === 201) state = 'waking';
        return true;
      },
      forgetExecOwner: (processId) => { owners.delete(processId); }
    };

    const summary = await sweepAgentRuntimeGc(NOW, deps);

    expect(terminated).toEqual([201]);
    expect(alive.has(202)).toBe(true);
    expect(summary).toMatchObject({ terminated: 1, ineligible: 1 });
  });

  it('does nothing after restart when durable worker history exists but no runtime process was reconstructed', async () => {
    const fake = fixture();
    fake.deps.listProcesses = () => [];

    const summary = await sweepAgentRuntimeGc(NOW, fake.deps);

    expect(summary.checked).toBe(0);
    expect(fake.terminateProcess).not.toHaveBeenCalled();
  });
});
