import { describe, expect, it, vi } from 'vitest';
import type { CoreHello, CoreStatusEnvelope } from '../src/shared/core-protocol.js';
import { CORE_PROTOCOL_VERSION } from '../src/shared/core-protocol.js';
import { createUiConnectionFacade } from '../src/main/core/ui-connection.js';

const hello: CoreHello = {
  protocolVersion: CORE_PROTOCOL_VERSION,
  coreVersion: '2.1.2',
  corePid: 4444,
  generation: 3,
  capabilities: ['connection-status', 'connection-control', 'settings-apply', 'execution-probe', 'structured-health']
};

function envelope(generation = 3, state: CoreStatusEnvelope['status']['state'] = 'connected'): CoreStatusEnvelope {
  return {
    generation,
    status: {
      state,
      detail: state === 'connected' ? 'Connected' : 'Reconnecting',
      publicUrl: null,
      localUrl: 'http://127.0.0.1:1234/mcp/core/test',
      handshakeAt: 10,
      lastRequestAt: null,
      lastToolCallAt: null,
      health: null,
      surfaces: []
    },
    health: {
      overall: state === 'connected' ? 'CONNECTED' : 'RECONNECTING',
      authHealthy: true,
      remoteTransportHealthy: state === 'connected',
      remoteSubscriptionHealthy: state === 'connected',
      coreProcessHealthy: true,
      localMcpHealthy: true,
      toolProbeHealthy: state === 'connected',
      lastToolSuccessAt: null,
      lastRemoteHeartbeatAt: 10,
      lastProbeAt: 10,
      reconnectAttempt: 0,
      connectionGeneration: generation,
      corePid: 4444,
      recovering: state !== 'connected',
      authRequired: false
    }
  };
}

describe('UI persistent-Core connection facade', () => {
  it('attaches to an existing healthy Core without spawning another supervisor', async () => {
    const startSupervisor = vi.fn();
    const client = {
      hello: vi.fn(async () => hello),
      status: vi.fn(async () => envelope()),
      connect: vi.fn(async () => envelope()),
      disconnect: vi.fn(async () => envelope(4, 'disconnected')),
      applySettings: vi.fn(async () => envelope()),
      shutdownCore: vi.fn(async () => true)
    };
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => client,
      startSupervisor,
      sleep: async () => undefined
    });

    await facade.refresh();
    expect(facade.getStatus().state).toBe('connected');
    expect(startSupervisor).not.toHaveBeenCalled();
  });

  it('starts the detached supervisor once when Core IPC is unavailable, then attaches', async () => {
    let attempts = 0;
    const startSupervisor = vi.fn();
    const client = {
      hello: vi.fn(async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('not connected');
        return hello;
      }),
      status: vi.fn(async () => envelope()),
      connect: vi.fn(async () => envelope()),
      disconnect: vi.fn(async () => envelope(4, 'disconnected')),
      applySettings: vi.fn(async () => envelope()),
      shutdownCore: vi.fn(async () => true)
    };
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => client,
      startSupervisor,
      sleep: async () => undefined,
      attachAttempts: 3
    });

    await facade.refresh();
    expect(startSupervisor).toHaveBeenCalledTimes(1);
    expect(facade.getStatus().state).toBe('connected');
  });

  it('does not kill or disconnect Core when the UI enters final shutdown', async () => {
    const client = {
      hello: vi.fn(async () => hello),
      status: vi.fn(async () => envelope()),
      connect: vi.fn(async () => envelope()),
      disconnect: vi.fn(async () => envelope()),
      applySettings: vi.fn(async () => envelope()),
      shutdownCore: vi.fn(async () => true)
    };
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => client,
      startSupervisor: vi.fn(),
      sleep: async () => undefined
    });

    await facade.refresh();
    await facade.shutdownConnection();

    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.shutdownCore).not.toHaveBeenCalled();
  });

  it('ignores a stale generation status so an old Core response cannot repaint a new one', async () => {
    const client = {
      hello: vi.fn(async () => hello),
      status: vi.fn()
        .mockResolvedValueOnce(envelope(8, 'connected'))
        .mockResolvedValueOnce(envelope(7, 'disconnected')),
      connect: vi.fn(async () => envelope()),
      disconnect: vi.fn(async () => envelope()),
      applySettings: vi.fn(async () => envelope()),
      shutdownCore: vi.fn(async () => true)
    };
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => client,
      startSupervisor: vi.fn(),
      sleep: async () => undefined
    });

    await facade.refresh();
    await facade.refresh();
    expect(facade.getStatus().state).toBe('connected');
    expect(facade.getCoreHealth()?.connectionGeneration).toBe(8);
  });
});
