import { describe, expect, it, vi } from 'vitest';
import { CORE_CAPABILITIES, CORE_PROTOCOL_VERSION } from '../src/shared/core-protocol.js';
import {
  createCoreProcessAdapter,
  startCoreSupervisorDetached,
  type SpawnLike
} from '../src/main/core/process.js';

function child(pid: number) {
  return {
    pid,
    once: vi.fn(),
    unref: vi.fn()
  };
}

describe('Core process adapter', () => {
  it('probes the real Core IPC hello instead of trusting a PID', async () => {
    const hello = vi.fn(async () => ({
      protocolVersion: CORE_PROTOCOL_VERSION,
      coreVersion: '2.1.2',
      corePid: 4321,
      generation: 9,
      capabilities: CORE_CAPABILITIES
    }));
    const adapter = createCoreProcessAdapter({
      execPath: 'C:\\Program Files\\Chat On Steroids\\Chat On Steroids.exe',
      userDataDir: 'C:\\Users\\example\\AppData\\Roaming\\Chat On Steroids',
      token: 'a'.repeat(64),
      clientFactory: () => ({ hello, shutdownCore: async () => true })
    });

    await expect(adapter.probe()).resolves.toMatchObject({ healthy: true, pid: 4321 });
    expect(hello).toHaveBeenCalledTimes(1);
  });

  it('treats incompatible or unreachable IPC as unhealthy', async () => {
    const incompatible = createCoreProcessAdapter({
      execPath: 'cos.exe',
      userDataDir: 'profile',
      token: 'a'.repeat(64),
      clientFactory: () => ({
        hello: async () => ({
          protocolVersion: CORE_PROTOCOL_VERSION + 1,
          coreVersion: '3.0.0',
          corePid: 99,
          generation: 1,
          capabilities: []
        }),
        shutdownCore: async () => true
      })
    });
    await expect(incompatible.probe()).resolves.toEqual({ healthy: false });

    const unreachable = createCoreProcessAdapter({
      execPath: 'cos.exe',
      userDataDir: 'profile',
      token: 'a'.repeat(64),
      clientFactory: () => ({ hello: async () => { throw new Error('not connected'); }, shutdownCore: async () => true })
    });
    await expect(unreachable.probe()).resolves.toEqual({ healthy: false });
  });

  it('spawns Core detached and hidden so UI exit does not own its lifetime', async () => {
    const spawned = child(7777);
    const spawn = vi.fn(() => spawned) as unknown as SpawnLike;
    const adapter = createCoreProcessAdapter({ execPath: 'cos.exe', userDataDir: 'profile', token: 'a'.repeat(64), spawn });

    await expect(adapter.spawn()).resolves.toMatchObject({ pid: 7777 });
    expect(spawn).toHaveBeenCalledWith(
      'cos.exe',
      ['--core-host', '--core-user-data', 'profile'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    );
    expect(spawned.unref).toHaveBeenCalledTimes(1);
  });

  it('starts the independent supervisor detached with no UI-owned stdio handles', () => {
    const spawned = child(8888);
    const spawn = vi.fn(() => spawned) as unknown as SpawnLike;

    const pid = startCoreSupervisorDetached({ execPath: 'cos.exe', userDataDir: 'profile', spawn });

    expect(pid).toBe(8888);
    expect(spawn).toHaveBeenCalledWith(
      'cos.exe',
      ['--core-supervisor', '--core-user-data', 'profile'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    );
    expect(spawned.unref).toHaveBeenCalledTimes(1);
  });
});
