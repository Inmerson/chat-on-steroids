import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

const CONTROL_TIMEOUT_MS = 1_000;

export interface CoreSupervisorLock {
  endpoint: string;
  close: () => Promise<void>;
}

export interface CoreSupervisorLockOptions {
  onShutdown?: () => void;
}

export function supervisorEndpointForUserData(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const digest = createHash('sha256').update(path.resolve(userDataDir)).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\chat-on-steroids-core-supervisor-${digest}`;
  }
  return path.join(userDataDir, 'core', 'supervisor.sock');
}

async function controlRequest(endpoint: string, command: 'ping' | 'shutdown'): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const socket = createConnection(endpoint);
    let settled = false;
    let buffer = '';
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => finish(null));
    socket.once('error', () => finish(null));
    socket.once('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline !== -1) finish(buffer.slice(0, newline).trim());
    });
  });
}

function pidFromReply(reply: string | null, prefix: string): number | null {
  if (!reply?.startsWith(`${prefix}:`)) return null;
  const pid = Number(reply.slice(prefix.length + 1));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function endpointIsLive(endpoint: string): Promise<boolean> {
  return pidFromReply(await controlRequest(endpoint, 'ping'), 'ok') !== null;
}

/** Returns the live supervisor PID, or null when this profile has no supervisor. */
export async function coreSupervisorPid(userDataDir: string): Promise<number | null> {
  return pidFromReply(await controlRequest(supervisorEndpointForUserData(userDataDir), 'ping'), 'ok');
}

/**
 * Explicit updater/system-shutdown control. The returned PID is diagnostic/wait metadata only;
 * the named-pipe/socket response is the authority that this is the supervisor owning the profile.
 */
export async function requestCoreSupervisorStop(userDataDir: string): Promise<number | null> {
  return pidFromReply(await controlRequest(supervisorEndpointForUserData(userDataDir), 'shutdown'), 'stopping');
}

function serveControl(socket: Socket, options: CoreSupervisorLockOptions): void {
  let buffer = '';
  socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy());
  socket.on('error', () => undefined);
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 64) {
      socket.end('invalid\n');
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    const command = buffer.slice(0, newline).trim();
    if (command === 'ping') {
      socket.end(`ok:${process.pid}\n`);
      return;
    }
    if (command === 'shutdown') {
      socket.end(`stopping:${process.pid}\n`);
      setImmediate(() => options.onShutdown?.());
      return;
    }
    socket.end('invalid\n');
  });
}

/**
 * Owns supervisor uniqueness with an OS endpoint rather than a PID file. A stale Unix socket can
 * be recovered after a crash, while a live listener always wins and keeps duplicate supervisors
 * from racing to restart the same Core. The same endpoint exposes only ping/shutdown so NSIS can
 * quiesce the watchdog before replacing its executable.
 */
export async function acquireCoreSupervisorLock(
  userDataDir: string,
  options: CoreSupervisorLockOptions = {}
): Promise<CoreSupervisorLock> {
  const endpoint = supervisorEndpointForUserData(userDataDir);
  if (process.platform !== 'win32') {
    await fs.mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    try {
      await fs.stat(endpoint);
      if (await endpointIsLive(endpoint)) throw new Error('Core supervisor is already running for this profile');
      await fs.rm(endpoint, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const server: Server = createServer((socket) => serveControl(socket, options));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') reject(new Error('Core supervisor endpoint is already owned'));
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
