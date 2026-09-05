import { describe, expect, it, vi } from 'vitest';
import { prepareInstalledCoreUpdateHandoff } from '../src/main/core/update-quiesce.js';

describe('installed Core update quiesce', () => {
  it('captures Core and supervisor PIDs before requesting graceful shutdown', async () => {
    const shutdownCore = vi.fn(async () => true);
    const result = await prepareInstalledCoreUpdateHandoff('profile', {
      token: async () => 'a'.repeat(64),
      client: () => ({
        hello: async () => ({
          protocolVersion: 3,
          coreVersion: '2.1.2',
          corePid: 2222,
          generation: 4,
          capabilities: []
        }),
        shutdownCore
      }),
      stopSupervisor: async () => 3333
    });

    expect(result.waitPids).toEqual([2222, 3333]);
    expect(shutdownCore).toHaveBeenCalledTimes(1);
  });

  it('still stops a standalone Core when no supervisor exists', async () => {
    const shutdownCore = vi.fn(async () => true);
    const result = await prepareInstalledCoreUpdateHandoff('profile', {
      token: async () => 'a'.repeat(64),
      client: () => ({
        hello: async () => ({
          protocolVersion: 3,
          coreVersion: '2.1.2',
          corePid: 2222,
          generation: 4,
          capabilities: []
        }),
        shutdownCore
      }),
      stopSupervisor: async () => null
    });

    expect(result.waitPids).toEqual([2222]);
    expect(shutdownCore).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when neither helper process is running', async () => {
    const result = await prepareInstalledCoreUpdateHandoff('profile', {
      token: async () => 'a'.repeat(64),
      client: () => ({
        hello: async () => { throw new Error('not connected'); },
        shutdownCore: async () => true
      }),
      stopSupervisor: async () => null
    });

    expect(result.waitPids).toEqual([]);
  });
});
