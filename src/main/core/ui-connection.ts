import { app } from 'electron';
import type { ConnectionStatus } from '../../shared/types.js';
import {
  CORE_CAPABILITIES,
  CORE_PROTOCOL_VERSION,
  isCoreCompatible,
  type CoreHealthStatus,
  type CoreHello,
  type CoreSecretKey,
  type CoreSecretStatus,
  type CoreStatusEnvelope
} from '../../shared/core-protocol.js';
import { CoreIpcClient, coreEndpointForUserData, ensureCoreIpcToken, shouldAcceptCoreEnvelope } from './ipc.js';
import { startCoreSupervisorDetached } from './process.js';

interface CoreClient {
  hello(): Promise<CoreHello>;
  status(): Promise<CoreStatusEnvelope>;
  connect(): Promise<CoreStatusEnvelope>;
  disconnect(): Promise<CoreStatusEnvelope>;
  applySettings(): Promise<CoreStatusEnvelope>;
  secretStatus(): Promise<CoreSecretStatus>;
  setSecret(key: CoreSecretKey, value: string): Promise<void>;
  shutdownCore(): Promise<boolean>;
}

export interface UiConnectionFacadeOptions {
  userDataDir: () => string;
  token: (userDataDir: string) => Promise<string>;
  client: (endpoint: string, token: string) => CoreClient;
  startSupervisor: (userDataDir: string) => void;
  sleep?: (ms: number) => Promise<void>;
  attachAttempts?: number;
  attachDelayMs?: number;
}

const EMPTY_STATUS: ConnectionStatus = {
  state: 'disconnected',
  detail: 'Core Host is not connected yet.',
  publicUrl: null,
  localUrl: null,
  handshakeAt: null,
  lastRequestAt: null,
  lastToolCallAt: null,
  health: null,
  surfaces: []
};

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

export interface UiConnectionFacade {
  getStatus(): ConnectionStatus;
  getCoreHealth(): CoreHealthStatus | null;
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
  onCoreHealthChange(listener: (health: CoreHealthStatus | null) => void): () => void;
  refresh(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  applySettings(): Promise<void>;
  secretStatus(): Promise<CoreSecretStatus>;
  setSecret(key: CoreSecretKey, value: string): Promise<void>;
  shutdownConnection(): Promise<void>;
  isServerRunning(): boolean;
  tunnelHealthBase(): null;
}

export function createUiConnectionFacade(options: UiConnectionFacadeOptions): UiConnectionFacade {
  let status: ConnectionStatus = { ...EMPTY_STATUS };
  let health: CoreHealthStatus | null = null;
  let generation = -1;
  let activeClient: CoreClient | null = null;
  let supervisorStarted = false;
  let finalShutdown = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let refreshInFlight: Promise<void> | null = null;
  const statusListeners = new Set<(value: ConnectionStatus) => void>();
  const healthListeners = new Set<(value: CoreHealthStatus | null) => void>();
  const sleep = options.sleep ?? sleepDefault;

  const publish = (envelope: CoreStatusEnvelope): void => {
    if (!shouldAcceptCoreEnvelope(generation, envelope)) return;
    generation = envelope.generation;
    status = { ...EMPTY_STATUS, ...envelope.status } as ConnectionStatus;
    health = envelope.health ?? health;
    for (const listener of statusListeners) listener({ ...status });
    for (const listener of healthListeners) listener(health ? { ...health } : null);
  };

  const publishUnavailable = (): void => {
    if (finalShutdown) return;
    status = {
      ...EMPTY_STATUS,
      state: 'connecting-tunnel',
      detail: 'Core Host is reconnecting…'
    };
    for (const listener of statusListeners) listener({ ...status });
  };

  const compatible = (peer: CoreHello): boolean =>
    isCoreCompatible(
      { protocolVersion: CORE_PROTOCOL_VERSION, requiredCapabilities: CORE_CAPABILITIES },
      peer
    );

  const clientForProfile = async (): Promise<CoreClient> => {
    const userDataDir = options.userDataDir();
    const token = await options.token(userDataDir);
    return options.client(coreEndpointForUserData(userDataDir), token);
  };

  const startSupervisorOnce = (): void => {
    if (supervisorStarted || finalShutdown) return;
    supervisorStarted = true;
    options.startSupervisor(options.userDataDir());
  };

  const attach = async (): Promise<CoreClient> => {
    if (activeClient) return activeClient;
    const attempts = Math.max(1, options.attachAttempts ?? 40);
    const delay = Math.max(0, options.attachDelayMs ?? 250);
    let candidate = await clientForProfile();

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const peer = await candidate.hello();
        if (!compatible(peer)) {
          // A protocol-incompatible old host cannot share the ownership endpoint with its
          // replacement. Ask it to quiesce, then let the independent supervisor start this build.
          await candidate.shutdownCore().catch(() => false);
          throw new Error('Core protocol is incompatible');
        }
        activeClient = candidate;
        return candidate;
      } catch (error) {
        if (attempt === 0) startSupervisorOnce();
        if (attempt + 1 >= attempts) throw error;
        await sleep(delay);
        candidate = await clientForProfile();
      }
    }
    throw new Error('Core Host did not become available');
  };

  const refreshOnce = async (): Promise<void> => {
    if (finalShutdown) return;
    try {
      const client = await attach();
      publish(await client.status());
    } catch {
      activeClient = null;
      publishUnavailable();
    }
  };

  const refresh = (): Promise<void> => {
    if (refreshInFlight) return refreshInFlight;
    const run = refreshOnce().finally(() => {
      if (refreshInFlight === run) refreshInFlight = null;
    });
    refreshInFlight = run;
    return run;
  };

  const ensurePolling = (): void => {
    if (pollTimer || finalShutdown) return;
    void refresh();
    pollTimer = setInterval(() => void refresh(), 1_000);
    pollTimer.unref?.();
  };

  const runCommand = async (command: (client: CoreClient) => Promise<CoreStatusEnvelope>): Promise<void> => {
    if (finalShutdown) return;
    try {
      const client = await attach();
      publish(await command(client));
    } catch (error) {
      activeClient = null;
      publishUnavailable();
      throw error;
    }
  };

  const runCoreCall = async <T>(call: (client: CoreClient) => Promise<T>): Promise<T> => {
    if (finalShutdown) throw new Error('UI Core client is shutting down');
    try {
      return await call(await attach());
    } catch (error) {
      activeClient = null;
      publishUnavailable();
      throw error;
    }
  };

  return {
    getStatus: () => ({ ...status }),
    getCoreHealth: () => (health ? { ...health } : null),
    onStatusChange: (listener) => {
      statusListeners.add(listener);
      ensurePolling();
      return () => statusListeners.delete(listener);
    },
    onCoreHealthChange: (listener) => {
      healthListeners.add(listener);
      ensurePolling();
      return () => healthListeners.delete(listener);
    },
    refresh,
    connect: () => runCommand((client) => client.connect()),
    disconnect: () => runCommand((client) => client.disconnect()),
    applySettings: () => runCommand((client) => client.applySettings()),
    secretStatus: () => runCoreCall((client) => client.secretStatus()),
    setSecret: (key, value) => runCoreCall((client) => client.setSecret(key, value)),
    shutdownConnection: async () => {
      // UI lifecycle is not Core lifecycle. Stop only this process's polling/admission to IPC.
      finalShutdown = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      activeClient = null;
    },
    isServerRunning: () => Boolean(status.localUrl && health?.localMcpHealthy),
    tunnelHealthBase: () => null
  };
}

let singleton: UiConnectionFacade | null = null;

export function uiConnectionFacade(): UiConnectionFacade {
  if (singleton) return singleton;
  singleton = createUiConnectionFacade({
    userDataDir: () => app.getPath('userData'),
    token: ensureCoreIpcToken,
    client: (endpoint, token) => new CoreIpcClient(endpoint, token),
    startSupervisor: (userDataDir) => {
      startCoreSupervisorDetached({ execPath: process.execPath, userDataDir });
    }
  });
  return singleton;
}
