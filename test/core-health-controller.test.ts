import { describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../src/shared/types.js';
import { CoreHealthController } from '../src/main/core/health-controller.js';

function status(overrides: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return {
    state: 'connected',
    detail: 'Connected',
    publicUrl: null,
    localUrl: 'http://127.0.0.1:1234/mcp/core/test',
    handshakeAt: 100_000,
    lastRequestAt: null,
    lastToolCallAt: null,
    health: null,
    surfaces: [],
    ...overrides
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CoreHealthController', () => {
  it('does not call transport-only connected healthy when the real MCP probe fails', async () => {
    const recovery = deferred();
    const recover = vi.fn(() => recovery.promise);
    const controller = new CoreHealthController({
      getStatus: () => status(),
      isServerRunning: () => true,
      probe: async () => ({ healthy: false, toolCount: null, latencyMs: 2, detail: 'tools/list failed' }),
      recover,
      now: () => 100_500,
      requiresRemoteHeartbeat: () => true
    });

    await controller.tick();
    expect(controller.snapshot()).toMatchObject({ localMcpHealthy: true, toolProbeHealthy: false, overall: 'RECONNECTING' });
    expect(recover).toHaveBeenCalledTimes(1);
    recovery.resolve();
    await controller.recoveryPromise();
  });

  it('becomes CONNECTED only after transport, subscription, local MCP and tool probe all pass', async () => {
    const controller = new CoreHealthController({
      getStatus: () => status(),
      isServerRunning: () => true,
      probe: async () => ({ healthy: true, toolCount: 5, latencyMs: 1, detail: 'ok' }),
      recover: async () => undefined,
      now: () => 100_500,
      requiresRemoteHeartbeat: () => true
    });

    await controller.tick();
    expect(controller.snapshot()).toMatchObject({
      overall: 'CONNECTED',
      authHealthy: true,
      remoteTransportHealthy: true,
      remoteSubscriptionHealthy: true,
      localMcpHealthy: true,
      toolProbeHealthy: true,
      lastRemoteHeartbeatAt: 100_000
    });
  });

  it('treats OPEN-looking transport with a stale heartbeat as half-open and recreates once', async () => {
    const recovery = deferred();
    const recover = vi.fn(() => recovery.promise);
    const controller = new CoreHealthController({
      getStatus: () => status({ handshakeAt: 1_000 }),
      isServerRunning: () => true,
      probe: async () => ({ healthy: true, toolCount: 5, latencyMs: 1, detail: 'ok' }),
      recover,
      now: () => 100_000,
      heartbeatStaleMs: 60_000,
      requiresRemoteHeartbeat: () => true
    });

    await Promise.all([controller.tick(), controller.tick(), controller.tick()]);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().overall).toBe('RECONNECTING');
    recovery.resolve();
    await controller.recoveryPromise();
  });

  it('recreates a connection stuck in connecting-tunnel beyond the joining threshold', async () => {
    let now = 10_000;
    const recover = vi.fn(async () => undefined);
    const controller = new CoreHealthController({
      getStatus: () => status({ state: 'connecting-tunnel', handshakeAt: null }),
      isServerRunning: () => true,
      probe: async () => ({ healthy: true, toolCount: 5, latencyMs: 1, detail: 'ok' }),
      recover,
      now: () => now,
      joiningStaleMs: 25_000,
      requiresRemoteHeartbeat: () => true
    });

    await controller.tick();
    now = 36_000;
    await controller.tick();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().connectionGeneration).toBe(1);
  });

  it('maps terminal tunnel auth rejection to AUTH_REQUIRED without a restart loop', async () => {
    const recover = vi.fn(async () => undefined);
    const controller = new CoreHealthController({
      getStatus: () => status({ state: 'auth-failed', detail: 'bad key', handshakeAt: null }),
      isServerRunning: () => true,
      probe: async () => ({ healthy: true, toolCount: 5, latencyMs: 1, detail: 'ok' }),
      recover,
      now: () => 50_000,
      requiresRemoteHeartbeat: () => true
    });

    await controller.tick();
    await controller.tick();
    expect(controller.snapshot().overall).toBe('AUTH_REQUIRED');
    expect(recover).not.toHaveBeenCalled();
  });

  it('increments generation for each real recovery and ignores overlapping triggers', async () => {
    const recovery = deferred();
    const recover = vi.fn(() => recovery.promise);
    const controller = new CoreHealthController({
      getStatus: () => status(),
      isServerRunning: () => true,
      probe: async () => ({ healthy: false, toolCount: null, latencyMs: 1, detail: 'failed' }),
      recover,
      now: () => 100_500,
      requiresRemoteHeartbeat: () => false
    });

    await Promise.all([controller.tick(), controller.tick()]);
    expect(controller.snapshot().connectionGeneration).toBe(1);
    expect(recover).toHaveBeenCalledTimes(1);
    recovery.resolve();
    await controller.recoveryPromise();
  });
});
