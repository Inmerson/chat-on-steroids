import { logWarn } from '../logger.js';
import { ensureCoreIpcToken } from './ipc.js';
import {
  acquireCoreSupervisorLock,
  type CoreSupervisorLock,
  type CoreSupervisorLockOptions
} from './ownership.js';
import { createCoreProcessAdapter } from './process.js';
import { CoreSupervisor } from './supervisor.js';

interface SupervisorLike {
  ensureHost(reason: string): Promise<{ state: 'attached' | 'spawned'; pid: number }>;
  stopHost?: () => Promise<void>;
}

export interface RunCoreSupervisorDaemonOptions {
  execPath: string;
  userDataDir: string;
  signal?: AbortSignal;
  intervalMs?: number;
  maxIterations?: number;
  sleep?: (ms: number) => Promise<void>;
  lockFactory?: (userDataDir: string, options: CoreSupervisorLockOptions) => Promise<CoreSupervisorLock>;
  tokenFactory?: (userDataDir: string) => Promise<string>;
  supervisorFactory?: (token: string) => SupervisorLike;
  warn?: (message: string) => void;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/**
 * Long-lived watchdog above the Core Host. An explicit local shutdown request is different from
 * UI detach: it is reserved for system/Core-update/install replacement and quiesces the Core
 * after any in-flight single-flight restart settles, preventing a late spawn from reopening the
 * executable while NSIS is about to replace it.
 */
export async function runCoreSupervisorDaemon(
  options: RunCoreSupervisorDaemonOptions
): Promise<'stopped' | 'already-running'> {
  const lockFactory = options.lockFactory ?? acquireCoreSupervisorLock;
  let quiesceRequested = false;
  let lock: CoreSupervisorLock;
  try {
    lock = await lockFactory(options.userDataDir, { onShutdown: () => { quiesceRequested = true; } });
  } catch (error) {
    if (/already running|already owned/i.test((error as Error).message)) return 'already-running';
    throw error;
  }

  const warn = options.warn ?? logWarn;
  const sleep = options.sleep ?? sleepDefault;
  const intervalMs = options.intervalMs ?? 2_000;
  let supervisor: SupervisorLike | null = null;
  try {
    const token = await (options.tokenFactory ?? ensureCoreIpcToken)(options.userDataDir);
    supervisor = options.supervisorFactory
      ? options.supervisorFactory(token)
      : new CoreSupervisor({
          adapter: createCoreProcessAdapter({
            execPath: options.execPath,
            userDataDir: options.userDataDir,
            token
          })
        });

    let iteration = 0;
    while (
      !quiesceRequested &&
      !options.signal?.aborted &&
      (options.maxIterations === undefined || iteration < options.maxIterations)
    ) {
      iteration += 1;
      try {
        await supervisor.ensureHost('watchdog');
      } catch (error) {
        warn(`core supervisor restart attempt failed: ${(error as Error).message}`);
      }
      if (
        quiesceRequested ||
        options.signal?.aborted ||
        (options.maxIterations !== undefined && iteration >= options.maxIterations)
      ) break;
      await sleep(intervalMs);
    }

    if ((quiesceRequested || options.signal?.aborted) && supervisor.stopHost) {
      await supervisor.stopHost().catch((error) => warn(`core supervisor could not quiesce host: ${(error as Error).message}`));
    }
    return 'stopped';
  } finally {
    await lock.close().catch(() => undefined);
  }
}
