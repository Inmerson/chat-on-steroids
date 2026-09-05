import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_CAPABILITIES, CORE_PROTOCOL_VERSION, type CoreHello } from '../src/shared/core-protocol.js';
import {
  CoreIpcClient,
  ensureCoreIpcToken,
  startCoreIpcServer,
  type CoreIpcHandlers,
  type CoreIpcServer
} from '../src/main/core/ipc.js';

const roots: string[] = [];
const servers: CoreIpcServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cos-core-ipc-'));
  roots.push(dir);
  return dir;
}

function hello(): CoreHello {
  return {
    protocolVersion: CORE_PROTOCOL_VERSION,
    coreVersion: '2.1.2',
    corePid: process.pid,
    generation: 4,
    capabilities: CORE_CAPABILITIES
  };
}

function handlers(dir: string, token: string, overrides: Partial<CoreIpcHandlers> = {}): CoreIpcHandlers {
  return {
    userDataDir: dir,
    token,
    hello,
    status: () => ({ generation: 4, status: { state: 'connected' } }),
    connect: async () => undefined,
    disconnect: async () => undefined,
    applySettings: async () => undefined,
    secretStatus: async () => ({ hasApiKey: false, hasGoalKey: false }),
    setSecret: async () => undefined,
    shutdownCore: async () => undefined,
    ...overrides
  };
}

describe('Core local IPC', () => {
  it('persists a stable per-profile authentication token', async () => {
    const dir = await root();
    const first = await ensureCoreIpcToken(dir);
    const second = await ensureCoreIpcToken(dir);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serves hello/status/control only to a client holding the local token', async () => {
    const dir = await root();
    const token = await ensureCoreIpcToken(dir);
    const connect = vi.fn(async () => undefined);
    const server = await startCoreIpcServer(handlers(dir, token, { connect }));
    servers.push(server);

    const client = new CoreIpcClient(server.endpoint, token);
    expect(await client.hello()).toMatchObject({ protocolVersion: CORE_PROTOCOL_VERSION, generation: 4 });
    expect(await client.status()).toMatchObject({ generation: 4, status: { state: 'connected' } });
    await client.connect();
    expect(connect).toHaveBeenCalledTimes(1);

    const intruder = new CoreIpcClient(server.endpoint, '0'.repeat(64));
    await expect(intruder.status()).rejects.toThrow(/unauthorized/i);
  });

  it('keeps secret values write-only while making Core the mutation authority', async () => {
    const dir = await root();
    const token = await ensureCoreIpcToken(dir);
    const setSecret = vi.fn(async () => undefined);
    const secretStatus = vi.fn(async () => ({ hasApiKey: false, hasGoalKey: true }));
    const server = await startCoreIpcServer(handlers(dir, token, { setSecret, secretStatus }));
    servers.push(server);

    const client = new CoreIpcClient(server.endpoint, token);
    await expect(client.secretStatus()).resolves.toEqual({ hasApiKey: false, hasGoalKey: true });
    await expect(client.setSecret('openaiApiKey', 'sk-test-value')).resolves.toBeUndefined();
    expect(setSecret).toHaveBeenCalledWith('openaiApiKey', 'sk-test-value');
    expect(JSON.stringify(await client.secretStatus())).not.toContain('sk-test-value');
  });

  it('uses exclusive endpoint ownership so a second Core cannot bind the same profile', async () => {
    const dir = await root();
    const token = await ensureCoreIpcToken(dir);
    const options = handlers(dir, token);
    const first = await startCoreIpcServer(options);
    servers.push(first);

    await expect(startCoreIpcServer(options)).rejects.toThrow(/already running|address.*use|endpoint.*owned/i);
  });
});
