import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentState } from '../src/shared/session.js';
import type { ManagedProcessRuntimeInfo, ConditionalTerminationResult } from '../src/main/codex/unified-exec.js';
import {
  AGENT_RUNTIME_RETENTION_MS,
  AGENT_RUNTIME_SWEEP_MS,
  captureAgentRuntimeTargets,
  releaseCapturedAgentRuntimeTargets,
  startAgentRuntimeGc,
  sweepAgentRuntimeGc,
  type RuntimeGcDependencies
} from '../src/main/runtime-gc.js';

const NOW = 2_000_000_000;
const OLD = NOW - AGENT_RUNTIME_RETENTION_MS - 1;

function workerInfo(
  state: AgentState = 'sleeping',
  options: { revivable?: boolean; sleptAt?: number | null; role?: 'worker' | 'prime' } = {}
): AgentInfo {
  return {
    id: options.role === 'prime' ? 'prime' : 'worker-1',
    role: options.role ?? 'worker',
    label: 'GC worker',
    task: 'test runtime gc',
    state,
    createdAt: OLD - 1_000,
    activatedAt: OLD - 500,
    finishedAt: null,
    result: null,
    pending: 0,
    awaitingAck: 0,
    delivered: 0,
    conversationId: 'chat-worker',
    detachedAt: null,
    lastSeenAt: OLD,
    revivable: options.revivable ?? true,
    sleptAt: options.sleptAt === undefined ? OLD : options.sleptAt,
    contextTokens: 100
  };
}

function runtime(processId = 101, lastUsed = OLD): ManagedProcessRuntimeInfo {
  return {
    processId,
    command: 'npm run dev',
    cwd: '/repo',
    pid: 1_001,
    tty: true,
    lastUsed,
    initialExecCommandActive: false
  };
}

function deps(options: {
  processes?: ManagedProcessRuntimeInfo[];
  owners?: Array<string | null>;
  agents?: Array<AgentInfo | null>;
  termination?: ConditionalTerminationResult;
  explicitTermination?: boolean;
} = {}): RuntimeGcDependencies & {
  terminateProcessIfUnusedSince: ReturnType<typeof vi.fn>;
  terminateProcess: ReturnType<typeof vi.fn>;
  forgetExecOwner: ReturnType<typeof vi.fn>;
} {
  const owners = [...(options.owners ?? ['chat-worker'])];
  const agents = [...(options.agents ?? [workerInfo()])];
  let lastOwner = owners.at(-1) ?? null;
  let lastAgent = agents.at(-1) ?? null;
  const execOwner = vi.fn(() => {
    if (owners.length > 0) lastOwner = owners.shift() ?? null;
    return lastOwner;
  });
  const agentInfoForOwnedConversation = vi.fn(() => {
    if (agents.length > 0) lastAgent = agents.shift() ?? null;
    return lastAgent;
  });
  const terminateProcessIfUnusedSince = vi.fn(async () => options.termination ?? 'terminated');
  const terminateProcess = vi.fn(async () => options.explicitTermination ?? true);
  const forgetExecOwner = vi.fn();
  return {
    listRuntimeProcesses: () => options.processes ?? [runtime()],
    execOwner,
    forgetExecOwner,
    agentInfoForOwnedConversation,
    terminateProcessIfUnusedSince,
    terminateProcess
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('agent runtime garbage collection', () => {
  it('terminates an old runtime owned by an old sleeping revivable worker', async () => {
    const fake = deps();

    const summary = await sweepAgentRuntimeGc(NOW, fake);

    expect(fake.terminateProcessIfUnusedSince).toHaveBeenCalledOnce();
    expect(fake.terminateProcessIfUnusedSince).toHaveBeenCalledWith(101, NOW - AGENT_RUNTIME_RETENTION_MS);
    expect(fake.forgetExecOwner).toHaveBeenCalledWith(101);
    expect(summary.terminated).toBe(1);
  });

  it('never terminates a runtime with unknown ownership', async () => {
    const fake = deps({ owners: [null] });

    const summary = await sweepAgentRuntimeGc(NOW, fake);

    expect(fake.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
    expect(fake.forgetExecOwner).not.toHaveBeenCalled();
    expect(summary.unowned).toBe(1);
  });

  it('never terminates when the owner is not a worker conversation', async () => {
    for (const agent of [null, workerInfo('sleeping', { role: 'prime' })]) {
      const fake = deps({ agents: [agent] });
      await sweepAgentRuntimeGc(NOW, fake);
      expect(fake.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
    }
  });

  it.each<AgentState>(['active', 'detached', 'waking', 'invited', 'failed', 'finished'])(
    'never periodically terminates a %s worker runtime',
    async (state) => {
      const fake = deps({ agents: [workerInfo(state)] });
      await sweepAgentRuntimeGc(NOW, fake);
      expect(fake.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
    }
  );

  it('never terminates a sleeping worker that is not revivable or has no old sleep boundary', async () => {
    for (const agent of [
      workerInfo('sleeping', { revivable: false }),
      workerInfo('sleeping', { sleptAt: null }),
      workerInfo('sleeping', { sleptAt: NOW - AGENT_RUNTIME_RETENTION_MS + 1 })
    ]) {
      const fake = deps({ agents: [agent] });
      await sweepAgentRuntimeGc(NOW, fake);
      expect(fake.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
    }
  });

  it.each<ConditionalTerminationResult>(['recent', 'busy'])(
    'keeps ownership when conditional termination reports %s',
    async (termination) => {
      const fake = deps({ termination });
      const summary = await sweepAgentRuntimeGc(NOW, fake);
      expect(fake.forgetExecOwner).not.toHaveBeenCalled();
      expect(summary[termination]).toBe(1);
    }
  );

  it.each<ConditionalTerminationResult>(['terminated', 'exited', 'missing'])(
    'forgets stale ownership when conditional termination reports %s',
    async (termination) => {
      const fake = deps({ termination });
      await sweepAgentRuntimeGc(NOW, fake);
      expect(fake.forgetExecOwner).toHaveBeenCalledWith(101);
    }
  );

  it('rechecks exact owner immediately before termination and skips a changed owner', async () => {
    const fake = deps({ owners: ['chat-worker', 'chat-other'] });
    await sweepAgentRuntimeGc(NOW, fake);
    expect(fake.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
    expect(fake.forgetExecOwner).not.toHaveBeenCalled();
  });

  it('rechecks worker lifecycle immediately before termination and skips a worker that started waking', async () => {
    const fake = deps({ agents: [workerInfo(), workerInfo('waking')] });
    await sweepAgentRuntimeGc(NOW, fake);
    expect(fake.terminateProcessIfUnusedSince).not.toHaveBeenCalled();
  });

  it('does not erase a new owner that appeared after termination completed', async () => {
    const fake = deps({ owners: ['chat-worker', 'chat-worker', 'chat-reused'] });
    await sweepAgentRuntimeGc(NOW, fake);
    expect(fake.terminateProcessIfUnusedSince).toHaveBeenCalledOnce();
    expect(fake.forgetExecOwner).not.toHaveBeenCalled();
  });

  it('runs maintenance every 30 seconds without overlapping sweeps and can be stopped', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sweep = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    const stop = startAgentRuntimeGc({ sweep: sweep as () => Promise<unknown> });
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), AGENT_RUNTIME_SWEEP_MS);

    await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_SWEEP_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_SWEEP_MS * 2);
    expect(sweep).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_SWEEP_MS);
    expect(sweep).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(AGENT_RUNTIME_SWEEP_MS * 2);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('wires GC after swarm restore/canonicalization and stops it before shutdown phases', async () => {
    const indexSource = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const restore = indexSource.indexOf('restoreSwarm(savedSwarm);');
    const canonicalize = indexSource.indexOf("pauseSwarmForDisable('multi-agent mode is disabled');", restore);
    const start = indexSource.indexOf('stopAgentRuntimeGc = startAgentRuntimeGc(', canonicalize);
    const willQuit = indexSource.indexOf("app.on('will-quit'", start);
    const stop = indexSource.indexOf('stopAgentRuntimeGc?.();', willQuit);
    const shutdown = indexSource.indexOf('void runShutdownSequence(', willQuit);

    expect(restore).toBeGreaterThanOrEqual(0);
    expect(canonicalize).toBeGreaterThan(restore);
    expect(start).toBeGreaterThan(canonicalize);
    expect(willQuit).toBeGreaterThan(start);
    expect(stop).toBeGreaterThan(willQuit);
    expect(shutdown).toBeGreaterThan(stop);
  });

  it('captures only live runtimes with exact ownership that still maps to an agent', () => {
    const fake = deps({
      processes: [runtime(101), runtime(202), runtime(303)],
      owners: ['chat-worker', null, 'chat-orphan'],
      agents: [workerInfo(), null]
    });

    expect(captureAgentRuntimeTargets(undefined, fake)).toEqual([
      { processId: 101, conversationId: 'chat-worker' }
    ]);
  });

  it('limits captured runtimes to the exact requested conversations, including Prime ownership', () => {
    const prime = workerInfo('active', { role: 'prime' });
    prime.conversationId = 'chat-prime';
    const worker = workerInfo();
    worker.conversationId = 'chat-worker';
    const fake = deps({
      processes: [runtime(101), runtime(202)],
      owners: ['chat-prime', 'chat-worker'],
      agents: [prime, worker]
    });

    expect(captureAgentRuntimeTargets(new Set(['chat-prime']), fake)).toEqual([
      { processId: 101, conversationId: 'chat-prime' }
    ]);
  });

  it('explicit release rechecks ownership and never terminates a process that moved to another conversation', async () => {
    const fake = deps({ owners: ['chat-other'] });

    const summary = await releaseCapturedAgentRuntimeTargets(
      [{ processId: 101, conversationId: 'chat-worker' }],
      fake
    );

    expect(fake.terminateProcess).not.toHaveBeenCalled();
    expect(fake.forgetExecOwner).not.toHaveBeenCalled();
    expect(summary.changed).toBe(1);
  });

  it.each([
    [true, 'terminated'],
    [false, 'missing']
  ] as const)('explicit release forgets exact ownership when terminateProcess returns %s', async (result, key) => {
    const fake = deps({ owners: ['chat-worker', 'chat-worker'], explicitTermination: result });

    const summary = await releaseCapturedAgentRuntimeTargets(
      [{ processId: 101, conversationId: 'chat-worker' }],
      fake
    );

    expect(fake.terminateProcess).toHaveBeenCalledWith(101);
    expect(fake.forgetExecOwner).toHaveBeenCalledWith(101);
    expect(summary[key]).toBe(1);
  });

  it('explicit release does not erase a new owner that appears while termination is settling', async () => {
    const fake = deps({ owners: ['chat-worker', 'chat-reused'], explicitTermination: true });

    await releaseCapturedAgentRuntimeTargets(
      [{ processId: 101, conversationId: 'chat-worker' }],
      fake
    );

    expect(fake.terminateProcess).toHaveBeenCalledOnce();
    expect(fake.forgetExecOwner).not.toHaveBeenCalled();
  });
});
