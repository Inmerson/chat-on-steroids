import { logWarn } from '../logger.js';
import { ensureCoreIpcToken } from './ipc.js';
import { acquireCoreSupervisorLock, type CoreSupervisorLock } from './ownership.js';
import { createCoreProcessAdapter } from './process.js';
import { CoreSupervisor } from './supervisor.js';

interface SupervisorLike {
  ensureHost(reason: string): Promise<{ state: 'attached' | 'spawned'; pid: number }>;
}

export interface RunCoreSupervisorDaemonOptions {
  execPath: string;
  userDataDir: string;
  signal?: AbortSignal;
  intervalMs?: number;
  /** Test-only finite loop. Production leaves this undefined. */
  maxIterations?: number;
  sleep?: (ms: number) => Promise<void>;
  lockFactory?: (userDataDir: string) => Promise<CoreSupervisorLock>;
  tokenFactory?: (userDataDir: string) => Promise<string>;
  supervisorFactory?: (token: string) => SupervisorLike;
  warn?: (message: string) => void;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/**
 * Long-lived watchdog above the Core Host. It intentionally owns no UI resources. The daemon
 * survives ordinary UI exit and keeps retrying a crashed Core through CoreSupervisor's bounded
 * backoff; one failed restart attempt never tears down the watchdog itself.
 */
export async function runCoreSupervisorDaemon(
  options: RunCoreSupervisorDaemonOptions
): Promise<'stopped' | 'already-running'> {
  const lockFactory = options.lockFactory ?? acquireCoreSupervisorLock;
  let lock: CoreSupervisorLock;
  try {
    lock = await lockFactory(options.userDataDir);
  } catch (error) {
    if (/already running|already owned/i.test((error as Error).message)) return 'already-running';
    throw error;
  }

  const warn = options.warn ?? logWarn;
  const sleep = options.sleep ?? sleepDefault;
  const intervalMs = options.intervalMs ?? 2_000;
  try {
    const token = await (options.tokenFactory ?? ensureCoreIpcToken)(options.userDataDir);
    const supervisor = options.supervisorFactory
      ? options.supervisorFactory(token)
      : new CoreSupervisor({
          adapter: createCoreProcessAdapter({
            execPath: options.execPath,
            userDataDir: options.userDataDir,
            token
          })
        });

    let iteration = 0;
    while (!options.signal?.aborted && (options.maxIterations === undefined || iteration < options.maxIterations)) {
      iteration += 1;
      try {
        await supervisor.ensureHost('watchdog');
      } catch (error) {
        warn(`core supervisor restart attempt failed: ${(error as Error).message}`);
      }
      if (options.signal?.aborted || (options.maxIterations !== undefined && iteration >= options.maxIterations)) break;
      await sleep(intervalMs);
    }
    return 'stopped';
  } finally {
    await lock.close().catch(() => undefined);
  }
}
