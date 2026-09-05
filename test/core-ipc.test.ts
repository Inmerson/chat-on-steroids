import { describe, expect, it } from 'vitest';
import {
  CORE_PROTOCOL_VERSION,
  isCoreCompatible,
  type CoreHello,
  type CoreStatusEnvelope
} from '../src/shared/core-protocol.js';
import { coreEndpointForUserData, shouldAcceptCoreEnvelope } from '../src/main/core/ipc.js';

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
