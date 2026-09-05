import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import type {
  CoreHello,
  CoreRequest,
  CoreResponse,
  CoreStatusEnvelope
} from '../../shared/core-protocol.js';

const MAX_IPC_MESSAGE_BYTES = 128 * 1024;
const IPC_TIMEOUT_MS = 2_000;

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
  // Do not let the host running a cross-platform test choose the separator for the target OS.
  // On a real POSIX host this is identical to path.join; on Windows it still models the Unix
  // socket path the requested platform would actually use.
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
  shutdownCore: () => Promise<void>;
}

export interface CoreIpcServer {
  endpoint: string;
  close: () => Promise<void>;
}

function responseLine(response: CoreResponse): string {
  const line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line) > MAX_IPC_MESSAGE_BYTES) {
    return `${JSON.stringify({ id: response.id, ok: false, error: 'Core IPC response too large' } satisfies CoreResponse)}\n`;
  }
  return line;
}

function serveSocket(socket: Socket, handlers: CoreIpcHandlers): void {
  let buffer = Buffer.alloc(0);
  let handled = false;
  const finish = (response: CoreResponse): void => {
    if (handled) return;
    handled = true;
    socket.end(responseLine(response));
  };

  socket.setTimeout(IPC_TIMEOUT_MS, () => finish({ id: '', ok: false, error: 'Core IPC request timed out' }));
  socket.on('error', () => undefined);
  socket.on('data', (chunk: Buffer) => {
    if (handled) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_IPC_MESSAGE_BYTES) {
      finish({ id: '', ok: false, error: 'Core IPC request too large' });
      return;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) return;
    const raw = buffer.subarray(0, newline).toString('utf8');
    void (async () => {
      let request: CoreRequest;
      try {
        request = JSON.parse(raw) as CoreRequest;
      } catch {
        finish({ id: '', ok: false, error: 'Invalid Core IPC JSON' });
        return;
      }
      if (!request || typeof request.id !== 'string' || typeof request.token !== 'string' || typeof request.command !== 'string') {
        finish({ id: typeof request?.id === 'string' ? request.id : '', ok: false, error: 'Invalid Core IPC request' });
        return;
      }
      if (!safeTokenEqual(request.token, handlers.token)) {
        finish({ id: request.id, ok: false, error: 'Core IPC authentication failed' });
        return;
      }
      try {
        switch (request.command) {
          case 'hello':
            finish({ id: request.id, ok: true, data: await handlers.hello() });
            return;
          case 'status':
            finish({ id: request.id, ok: true, data: await handlers.status() });
            return;
          case 'connect':
            await handlers.connect();
            finish({ id: request.id, ok: true });
            return;
          case 'disconnect':
            await handlers.disconnect();
            finish({ id: request.id, ok: true });
            return;
          case 'apply-settings':
            await handlers.applySettings();
            finish({ id: request.id, ok: true });
            return;
          case 'shutdown-core':
            await handlers.shutdownCore();
            finish({ id: request.id, ok: true });
            return;
          default:
            finish({ id: request.id, ok: false, error: 'Unknown Core IPC command' });
        }
      } catch (error) {
        finish({ id: request.id, ok: false, error: (error as Error).message });
      }
    })();
  });
}

export async function startCoreIpcServer(handlers: CoreIpcHandlers): Promise<CoreIpcServer> {
  const endpoint = coreEndpointForUserData(handlers.userDataDir);
  if (process.platform !== 'win32') {
    await fs.mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    await fs.rm(endpoint, { force: true }).catch(() => undefined);
  }

  const server: Server = createServer((socket) => serveSocket(socket, handlers));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
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

export interface CoreIpcClientOptions {
  userDataDir: string;
  token: string;
  timeoutMs?: number;
}

export async function callCoreIpc<T = unknown>(
  options: CoreIpcClientOptions,
  command: CoreRequest['command']
): Promise<T> {
  const endpoint = coreEndpointForUserData(options.userDataDir);
  const request: CoreRequest = { id: randomUUID(), token: options.token, command };
  const timeoutMs = options.timeoutMs ?? IPC_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('Core IPC request timed out')));
    socket.once('error', fail);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_IPC_MESSAGE_BYTES) {
        fail(new Error('Core IPC response too large'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      settled = true;
      socket.destroy();
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as CoreResponse<T>;
        if (response.id !== request.id) throw new Error('Core IPC response id mismatch');
        if (!response.ok) throw new Error(response.error || 'Core IPC request failed');
        resolve(response.data as T);
      } catch (error) {
        reject(error);
      }
    });
  });
}
