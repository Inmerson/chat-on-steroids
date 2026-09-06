import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORE_PROTOCOL_VERSION,
  isCoreCompatible,
  type CoreHello,
  type CoreStatusEnvelope
} from '../src/shared/core-protocol.js';
import { CoreIpcClient, coreEndpointForUserData, shouldAcceptCoreEnvelope } from '../src/main/core/ipc.js';

function hello(overrides: Partial<CoreHello> = {}): CoreHello {
  return {
    protocolVersion: CORE_PROTOCOL_VERSION,
    coreVersion: '2.1.2',
    corePid: 1234,
    generation: 7,
    capabilities: ['connection-status', 'connection-control', 'settings-apply'],
    ...overrides
  };
}

describe('Core protocol compatibility', () => {
  it('accepts product-version drift when the protocol and required capabilities match', () => {
    expect(isCoreCompatible({ protocolVersion: CORE_PROTOCOL_VERSION, requiredCapabilities: ['connection-status'] }, hello({ coreVersion: '2.2.0' }))).toBe(true);
  });

  it('rejects a protocol mismatch', () => {
    expect(isCoreCompatible({ protocolVersion: CORE_PROTOCOL_VERSION, requiredCapabilities: [] }, hello({ protocolVersion: CORE_PROTOCOL_VERSION + 1 }))).toBe(false);
  });

  it('rejects a Core missing a required capability', () => {
    expect(isCoreCompatible({ protocolVersion: CORE_PROTOCOL_VERSION, requiredCapabilities: ['execution-probe'] }, hello())).toBe(false);
  });
});

describe('Core IPC endpoint', () => {
  it('is deterministic for one userData directory and does not embed that path in the Windows pipe name', () => {
    const userData = 'C:\\Users\\example\\AppData\\Roaming\\Chat On Steroids';
    const first = coreEndpointForUserData(userData, 'win32');
    const second = coreEndpointForUserData(userData, 'win32');

    expect(first).toBe(second);
    expect(first.startsWith('\\\\.\\pipe\\')).toBe(true);
    expect(first).not.toContain('Users');
    expect(first).not.toContain('Chat On Steroids');
  });

  it('uses a socket path beneath userData on non-Windows platforms', () => {
    expect(coreEndpointForUserData('/tmp/cos-user', 'linux')).toBe('/tmp/cos-user/core/core.sock');
  });

  it('rejects promptly when a connected Core closes before returning a response', async () => {
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\cos-core-ipc-close-${randomUUID()}`
      : path.join(tmpdir(), `cos-core-ipc-close-${randomUUID()}.sock`);
    const server = createServer((socket) => {
      socket.once('data', () => socket.end());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });

    try {
      const client = new CoreIpcClient(endpoint, 'a'.repeat(64), 10_000);
      const outcome = await Promise.race([
        client.hello().then(
          () => 'resolved',
          (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 500))
      ]);
      expect(outcome).toMatch(/^rejected:Core IPC connection closed before a complete response$/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => undefined);
    }
  });
});

describe('generation-scoped Core status', () => {
  it('accepts same/new generations and rejects stale status envelopes', () => {
    const current: CoreStatusEnvelope = { generation: 9, status: { state: 'connected' } };
    const stale: CoreStatusEnvelope = { generation: 8, status: { state: 'disconnected' } };
    const newer: CoreStatusEnvelope = { generation: 10, status: { state: 'connected' } };

    expect(shouldAcceptCoreEnvelope(9, current)).toBe(true);
    expect(shouldAcceptCoreEnvelope(9, stale)).toBe(false);
    expect(shouldAcceptCoreEnvelope(9, newer)).toBe(true);
  });
});
