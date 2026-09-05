import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import path from 'node:path';

export interface CoreSupervisorLock {
  endpoint: string;
  close: () => Promise<void>;
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

async function endpointIsLive(endpoint: string): Promise<boolean> {
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
 * Owns supervisor uniqueness with an OS endpoint rather than a PID file. A stale Unix socket can
 * be recovered after a crash, while a live listener always wins and keeps duplicate supervisors
 * from racing to restart the same Core.
 */
export async function acquireCoreSupervisorLock(userDataDir: string): Promise<CoreSupervisorLock> {
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

  const server: Server = createServer((socket) => socket.end('ok\n'));
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
