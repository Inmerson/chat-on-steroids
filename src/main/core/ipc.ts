import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import type {
  CoreHello,
  CoreRequest,
  CoreResponse,
  CoreSecretKey,
  CoreSecretStatus,
  CoreStatusEnvelope,
  CoreUiOperation
} from '../../shared/core-protocol.js';

const MAX_IPC_MESSAGE_BYTES = 128 * 1024;
const IPC_TIMEOUT_MS = 2_000;
const MAX_SECRET_VALUE_CHARS = 500;
const CORE_UI_OPERATIONS = new Set<CoreUiOperation>([
  'bridge-status',
  'bridge-unpair',
  'session-list',
  'session-events',
  'session-delete',
  'handoff-get',
  'swarm-get',
  'swarm-reset',
  'swarm-clear-agent',
  'control-center-status',
  'goal-models'
]);

/**
 * User-scoped rendezvous endpoint for the persistent Core Host.
 *
 * Windows named pipes do not need a filesystem cleanup path. Hashing userData keeps the pipe
 * deterministic for one installation profile without leaking the user's home path into process
 * listings. Unix sockets live beneath userData so normal directory permissions scope access.
 */
export function coreEndpointForUserData(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const digest = createHash('sha256').update(path.resolve(userDataDir)).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\chat-on-steroids-core-${digest}`;
  }
  // Choose separators for the target platform, not the machine executing a cross-platform test.
  return path.posix.join(userDataDir.replace(/\\/g, '/'), 'core', 'core.sock');
}

/** Async status/report traffic from a replaced Core generation must never repaint a newer one. */
export function shouldAcceptCoreEnvelope(currentGeneration: number, envelope: CoreStatusEnvelope): boolean {
  return envelope.generation >= currentGeneration;
}

function coreDirectory(userDataDir: string): string {
  return path.join(userDataDir, 'core');
}

function tokenPath(userDataDir: string): string {
  return path.join(coreDirectory(userDataDir), 'ipc.token');
}

/**
 * A guessed pipe/socket name is not authorization. Both Core and UI read this user-profile file,
 * which is created once and never sent over renderer IPC or written to logs.
 */
export async function ensureCoreIpcToken(userDataDir: string): Promise<string> {
  const directory = coreDirectory(userDataDir);
  const file = tokenPath(userDataDir);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const candidate = randomBytes(32).toString('hex');
  try {
    await fs.writeFile(file, candidate, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const existing = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/i.test(existing)) {
    throw new Error('Core IPC authentication token is corrupt');
  }
  return existing.toLowerCase();
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CoreIpcHandlers {
  userDataDir: string;
  token: string;
  hello: () => CoreHello | Promise<CoreHello>;
  status: () => CoreStatusEnvelope | Promise<CoreStatusEnvelope>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  applySettings: () => Promise<void>;
  secretStatus: () => CoreSecretStatus | Promise<CoreSecretStatus>;
  setSecret: (key: CoreSecretKey, value: string) => Promise<void>;
  uiCall: (operation: CoreUiOperation, payload: unknown) => Promise<unknown>;
  shutdownCore: () => Promise<void>;
}

export interface CoreIpcServer {
  endpoint: string;
  close: () => Promise<void>;
}

function response(socket: Socket, value: CoreResponse): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

function validSecretKey(value: unknown): value is CoreSecretKey {
  return value === 'openaiApiKey' || value === 'openRouterApiKey';
}

function validUiOperation(value: unknown): value is CoreUiOperation {
  return typeof value === 'string' && CORE_UI_OPERATIONS.has(value as CoreUiOperation);
}

async function dispatch(request: CoreRequest, handlers: CoreIpcHandlers): Promise<unknown> {
  switch (request.command) {
    case 'hello':
      return handlers.hello();
    case 'status':
      return handlers.status();
    case 'connect':
      await handlers.connect();
      return handlers.status();
    case 'disconnect':
      await handlers.disconnect();
      return handlers.status();
    case 'apply-settings':
      await handlers.applySettings();
      return handlers.status();
    case 'secret-status':
      return handlers.secretStatus();
    case 'set-secret':
      if (!validSecretKey(request.key) || typeof request.value !== 'string' || request.value.length > MAX_SECRET_VALUE_CHARS) {
        throw new Error('Invalid Core secret mutation');
      }
      await handlers.setSecret(request.key, request.value);
      return undefined;
    case 'ui-call':
      if (!validUiOperation(request.operation)) throw new Error('Invalid Core UI operation');
      return handlers.uiCall(request.operation, request.payload);
    case 'shutdown-core':
      await handlers.shutdownCore();
      return true;
  }
}

function handleSocket(socket: Socket, handlers: CoreIpcHandlers): void {
  let buffered = '';
  let finished = false;
  const fail = (id: string, error: string): void => {
    if (finished) return;
    finished = true;
    response(socket, { id, ok: false, error });
  };

  socket.setTimeout(IPC_TIMEOUT_MS, () => fail('', 'Core IPC request timed out'));
  socket.on('error', () => undefined);
  socket.on('data', (chunk: Buffer) => {
    if (finished) return;
    buffered += chunk.toString('utf8');
    if (Buffer.byteLength(buffered) > MAX_IPC_MESSAGE_BYTES) {
      fail('', 'Core IPC request is too large');
      return;
    }
    const newline = buffered.indexOf('\n');
    if (newline === -1) return;
    finished = true;
    const line = buffered.slice(0, newline);
    let request: CoreRequest;
    try {
      request = JSON.parse(line) as CoreRequest;
    } catch {
      response(socket, { id: '', ok: false, error: 'Invalid Core IPC request' });
      return;
    }
    if (!request || typeof request.id !== 'string' || typeof request.command !== 'string' || typeof request.token !== 'string') {
      response(socket, { id: '', ok: false, error: 'Invalid Core IPC request' });
      return;
    }
    if (!safeTokenEqual(request.token, handlers.token)) {
      response(socket, { id: request.id, ok: false, error: 'Unauthorized Core IPC client' });
      return;
    }
    void Promise.resolve(dispatch(request, handlers)).then(
      (data) => response(socket, { id: request.id, ok: true, data }),
      (error: unknown) => response(socket, {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  });
}

async function unixEndpointIsLive(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(endpoint);
    const finish = (live: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Binds the ownership endpoint. A live listener is the single-instance lock; a dead Unix socket
 * left by a crash is removed only after a connection attempt proves nobody owns it.
 */
export async function startCoreIpcServer(handlers: CoreIpcHandlers): Promise<CoreIpcServer> {
  const endpoint = coreEndpointForUserData(handlers.userDataDir);
  if (process.platform !== 'win32') {
    await fs.mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    try {
      await fs.stat(endpoint);
      if (await unixEndpointIsLive(endpoint)) throw new Error('Core is already running for this profile');
      await fs.rm(endpoint, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const server: Server = createServer((socket) => handleSocket(socket, handlers));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') reject(new Error('Core endpoint is already owned by another process'));
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });

  let closed = false;
  return {
    endpoint,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => undefined);
    }
  };
}

export class CoreIpcClient {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly timeoutMs = IPC_TIMEOUT_MS
  ) {}

  private async request<T>(command: CoreRequest['command'], extra: Record<string, unknown> = {}): Promise<T> {
    const id = randomUUID();
    const wire = { id, token: this.token, command, ...extra } as CoreRequest;
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.endpoint);
      let buffered = '';
      let settled = false;
      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      socket.setTimeout(this.timeoutMs, () => finish(new Error('Core IPC request timed out'));
      socket.once('error', (error) => finish(error));
      socket.once('connect', () => socket.write(`${JSON.stringify(wire)}\n`));
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        if (Buffer.byteLength(buffered) > MAX_IPC_MESSAGE_BYTES) {
          finish(new Error('Core IPC response is too large'));
          return;
        }
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        try {
          const parsed = JSON.parse(buffered.slice(0, newline)) as CoreResponse<T>;
          if (parsed.id !== id) {
            finish(new Error('Core IPC response id mismatch'));
            return;
          }
          if (!parsed.ok) {
            finish(new Error(parsed.error || 'Core IPC request failed'));
            return;
          }
          finish(undefined, parsed.data as T);
        } catch {
          finish(new Error('Invalid Core IPC response'));
        }
      });
    });
  }

  hello(): Promise<CoreHello> {
    return this.request('hello');
  }

  status(): Promise<CoreStatusEnvelope> {
    return this.request('status');
  }

  connect(): Promise<CoreStatusEnvelope> {
    return this.request('connect');
  }

  disconnect(): Promise<CoreStatusEnvelope> {
    return this.request('disconnect');
  }

  applySettings(): Promise<CoreStatusEnvelope> {
    return this.request('apply-settings');
  }

  secretStatus(): Promise<CoreSecretStatus> {
    return this.request('secret-status');
  }

  setSecret(key: CoreSecretKey, value: string): Promise<void> {
    return this.request('set-secret', { key, value });
  }

  uiCall<T>(operation: CoreUiOperation, payload: unknown): Promise<T> {
    return this.request('ui-call', { operation, payload });
  }

  shutdownCore(): Promise<boolean> {
    return this.request('shutdown-core');
  }
}
