import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_RETENTION_SWEEP_MS,
  startSessionRetentionMaintenance
} from '../src/main/session/retention.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('session retention maintenance', () => {
  it('prunes immediately and keeps enforcing the current window during a long-running process', async () => {
    vi.useFakeTimers();
    let retainDays = 30;
    const prune = vi.fn(async () => 0);
    const stop = startSessionRetentionMaintenance({
      retainDays: () => retainDays,
      prune
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenLastCalledWith(30);

    await vi.advanceTimersByTimeAsync(SESSION_RETENTION_SWEEP_MS - 1);
    expect(prune).toHaveBeenCalledTimes(1);

    retainDays = 7;
    await vi.advanceTimersByTimeAsync(1);
    expect(prune).toHaveBeenCalledTimes(2);
    expect(prune).toHaveBeenLastCalledWith(7);

    stop();
    await vi.advanceTimersByTimeAsync(SESSION_RETENTION_SWEEP_MS * 2);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('does not overlap a slow prune when another maintenance boundary arrives', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prune = vi.fn(async () => {
      await blocked;
      return 0;
    });
    const stop = startSessionRetentionMaintenance({ retainDays: () => 30, prune });

    await vi.advanceTimersByTimeAsync(0);
    expect(prune).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SESSION_RETENTION_SWEEP_MS * 3);
    expect(prune).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SESSION_RETENTION_SWEEP_MS);
    expect(prune).toHaveBeenCalledTimes(2);
    stop();
  });

  it('is wired unconditionally in Core runtime instead of living behind the record toggle or UI lifecycle', async () => {
    const [core, ui] = await Promise.all([
      readFile(path.join(process.cwd(), 'src/main/core/runtime.ts'), 'utf8'),
      readFile(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
    ]);
    expect(core).toContain('startSessionRetentionMaintenance({');
    expect(core).toContain('retainDays: () => getConfig().sessions.retainDays');
    expect(core).not.toContain('if (getConfig().sessions.record) {\n    void pruneSessions');
    expect(ui).not.toContain('startSessionRetentionMaintenance({');
  });
});
