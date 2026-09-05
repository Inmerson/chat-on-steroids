import { describe, expect, it, vi } from 'vitest';
import type { CoreHello, CoreStatusEnvelope } from '../src/shared/core-protocol.js';
import { CORE_CAPABILITIES, CORE_PROTOCOL_VERSION } from '../src/shared/core-protocol.js';
import { createUiConnectionFacade } from '../src/main/core/ui-connection.js';

const hello: CoreHello = {
  protocolVersion: CORE_PROTOCOL_VERSION,
  coreVersion: '2.1.2',
  corePid: 4444,
  generation: 3,
  capabilities: CORE_CAPABILITIES
};

function envelope(
  generation = 3,
  state: CoreStatusEnvelope['status']['state'] = 'connected',
  revisions = { bridgeRevision: 0, sessionRevision: 0, swarmRevision: 0 }
): CoreStatusEnvelope {
  return {
    generation,
    ...revisions,
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

function client(overrides: Record<string, unknown> = {}) {
  return {
    hello: vi.fn(async () => hello),
    status: vi.fn(async () => envelope()),
    connect: vi.fn(async () => envelope()),
    disconnect: vi.fn(async () => envelope(4, 'disconnected')),
    applySettings: vi.fn(async () => envelope()),
    secretStatus: vi.fn(async () => ({ hasApiKey: true, hasGoalKey: false })),
    setSecret: vi.fn(async () => undefined),
    uiCall: vi.fn(async () => null),
    shutdownCore: vi.fn(async () => true),
    ...overrides
  };
}

describe('UI persistent-Core connection facade', () => {
  it('attaches to an existing healthy Core without spawning another supervisor', async () => {
    const startSupervisor = vi.fn();
    const peer = client();
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => peer,
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
    const peer = client({
      hello: vi.fn(async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('not connected');
        return hello;
      })
    });
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => peer,
      startSupervisor,
      sleep: async () => undefined,
      attachAttempts: 3
    });

    await facade.refresh();
    expect(startSupervisor).toHaveBeenCalledTimes(1);
    expect(facade.getStatus().state).toBe('connected');
  });

  it('does not kill or disconnect Core when the UI enters final shutdown', async () => {
    const peer = client();
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => peer,
      startSupervisor: vi.fn(),
      sleep: async () => undefined
    });

    await facade.refresh();
    await facade.shutdownConnection();

    expect(peer.disconnect).not.toHaveBeenCalled();
    expect(peer.shutdownCore).not.toHaveBeenCalled();
  });

  it('ignores a stale generation status so an old Core response cannot repaint a new one', async () => {
    const peer = client({
      status: vi.fn()
        .mockResolvedValueOnce(envelope(8, 'connected'))
        .mockResolvedValueOnce(envelope(7, 'disconnected'))
    });
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => peer,
      startSupervisor: vi.fn(),
      sleep: async () => undefined
    });

    await facade.refresh();
    await facade.refresh();
    expect(facade.getStatus().state).toBe('connected');
    expect(facade.getCoreHealth()?.connectionGeneration).toBe(8);
  });

  it('writes user API keys through the attached Core and never reads plaintext back', async () => {
    const peer = client();
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => peer,
      startSupervisor: vi.fn(),
      sleep: async () => undefined
    });

    await expect(facade.secretStatus()).resolves.toEqual({ hasApiKey: true, hasGoalKey: false });
    await facade.setSecret('openaiApiKey', 'sk-new');
    expect(peer.setSecret).toHaveBeenCalledWith('openaiApiKey', 'sk-new');
    expect(JSON.stringify(await facade.secretStatus())).not.toContain('sk-new');
  });

  it('emits bridge/session/swarm runtime changes from monotonic Core revisions', async () => {
    const peer = client({
      status: vi.fn()
        .mockResolvedValueOnce(envelope(3, 'connected', { bridgeRevision: 1, sessionRevision: 5, swarmRevision: 2 }))
        .mockResolvedValueOnce(envelope(3, 'connected', { bridgeRevision: 2, sessionRevision: 5, swarmRevision: 3 }))
    });
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => peer,
      startSupervisor: vi.fn(),
      sleep: async () => undefined
    });
    const changed: string[] = [];
    facade.onRuntimeChange((kind) => changed.push(kind));

    await facade.refresh();
    changed.length = 0;
    await facade.refresh();

    expect(changed).toEqual(['bridge', 'swarm']);
  });

  it('routes fixed UI runtime calls through the attached Core client', async () => {
    const peer = client({ uiCall: vi.fn(async () => ({ running: true })) });
    const facade = createUiConnectionFacade({
      userDataDir: () => 'profile',
      token: async () => 'a'.repeat(64),
      client: () => peer,
      startSupervisor: vi.fn(),
      sleep: async () => undefined
    });

    await expect(facade.uiCall('bridge-status', null)).resolves.toEqual({ running: true });
    expect(peer.uiCall).toHaveBeenCalledWith('bridge-status', null);
  });
});
