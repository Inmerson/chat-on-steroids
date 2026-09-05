import { describe, expect, it, vi } from 'vitest';
import { runCoreSupervisorDaemon } from '../src/main/core/supervisor-daemon.js';

describe('Core supervisor daemon', () => {
  it('keeps supervising after a failed restart attempt and releases ownership on exit', async () => {
    const close = vi.fn(async () => undefined);
    const ensureHost = vi
      .fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValue({ state: 'attached', pid: 1234 });
    const warn = vi.fn();

    const result = await runCoreSupervisorDaemon({
      execPath: 'cos.exe',
      userDataDir: 'profile',
      maxIterations: 2,
      intervalMs: 0,
      sleep: async () => undefined,
      lockFactory: async () => ({ endpoint: 'lock', close }),
      tokenFactory: async () => 'a'.repeat(64),
      supervisorFactory: () => ({ ensureHost }),
      warn
    });

    expect(result).toBe('stopped');
    expect(ensureHost).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits without starting another watchdog when the supervisor endpoint is already owned', async () => {
    const supervisorFactory = vi.fn();
    const result = await runCoreSupervisorDaemon({
      execPath: 'cos.exe',
      userDataDir: 'profile',
      lockFactory: async () => { throw new Error('Core supervisor is already running for this profile'); },
      tokenFactory: async () => 'a'.repeat(64),
      supervisorFactory
    });

    expect(result).toBe('already-running');
    expect(supervisorFactory).not.toHaveBeenCalled();
  });
});
