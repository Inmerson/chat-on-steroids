import { describe, expect, it, vi } from 'vitest';
import { CoreSupervisor, type CoreProcessAdapter } from '../src/main/core/supervisor.js';

function harness(options: { initiallyHealthy?: boolean } = {}) {
  let healthy = options.initiallyHealthy ?? false;
  let nextPid = 1000;
  const sleeps: number[] = [];
  const adapter: CoreProcessAdapter = {
    probe: vi.fn(async () => healthy ? { healthy: true as const, pid: nextPid - 1 } : { healthy: false as const }),
    spawn: vi.fn(async () => {
      const pid = nextPid++;
      healthy = true;
      return { pid };
    }),
    stop: vi.fn(async () => {
      healthy = false;
    })
  };
  const supervisor = new CoreSupervisor({
    adapter,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    healthyResetMs: 300_000
  });
  return { adapter, supervisor, sleeps, setHealthy: (value: boolean) => { healthy = value; } };
}

describe('CoreSupervisor', () => {
  it('attaches to an already healthy Core instead of spawning a duplicate', async () => {
    const { supervisor, adapter } = harness({ initiallyHealthy: true });

    const result = await supervisor.ensureHost('ui-open');

    expect(result.state).toBe('attached');
    expect(adapter.spawn).not.toHaveBeenCalled();
  });

  it('does not stop Core when the UI detaches', async () => {
    const { supervisor, adapter } = harness();
    await supervisor.ensureHost('ui-open');

    await supervisor.uiDetached();

    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it('serializes concurrent restart triggers into one spawn', async () => {
    const { supervisor, adapter, setHealthy } = harness();
    setHealthy(false);

    await Promise.all([
      supervisor.ensureHost('probe-failed'),
      supervisor.ensureHost('process-exit'),
      supervisor.ensureHost('ui-open')
    ]);

    expect(adapter.spawn).toHaveBeenCalledTimes(1);
  });

  it('uses the required bounded exponential backoff across a crash loop', async () => {
    const { supervisor, adapter, sleeps, setHealthy } = harness();
    const spawn = vi.mocked(adapter.spawn);
    spawn.mockImplementation(async () => {
      setHealthy(false);
      throw new Error('host crashed during startup');
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(supervisor.ensureHost('process-exit')).rejects.toThrow('host crashed during startup');
    }

    expect(sleeps).toEqual([2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 180_000, 180_000]);
  });

  it('resets restart backoff after a healthy run', async () => {
    let now = 0;
    let healthy = false;
    const sleeps: number[] = [];
    const adapter: CoreProcessAdapter = {
      probe: vi.fn(async () => healthy ? { healthy: true as const, pid: 42, startedAt: 0 } : { healthy: false as const }),
      spawn: vi.fn(async () => {
        healthy = true;
        return { pid: 42, startedAt: now };
      }),
      stop: vi.fn(async () => { healthy = false; })
    };
    const supervisor = new CoreSupervisor({
      adapter,
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => now,
      healthyResetMs: 300_000
    });

    await supervisor.ensureHost('ui-open');
    healthy = false;
    await supervisor.ensureHost('process-exit');
    expect(sleeps.at(-1)).toBe(2_000);

    healthy = true;
    now = 301_000;
    await supervisor.ensureHost('health-check');
    healthy = false;
    await supervisor.ensureHost('process-exit');

    expect(sleeps.at(-1)).toBe(2_000);
  });

  it('does not let stale PID metadata block a spawn when the IPC probe is unhealthy', async () => {
    const { supervisor, adapter } = harness();

    await supervisor.noteStalePid(7777);
    const result = await supervisor.ensureHost('ui-open');

    expect(result.state).toBe('spawned');
    expect(adapter.spawn).toHaveBeenCalledTimes(1);
  });
});
