import path from 'node:path';
import { app } from 'electron';
import { CORE_CAPABILITIES, CORE_PROTOCOL_VERSION, type CoreStatusEnvelope } from '../../shared/core-protocol.js';
import { initLogFile, logError, logInfo } from '../logger.js';
import { APP_VERSION } from '../version.js';
import { ensureCoreIpcToken, startCoreIpcServer } from './ipc.js';
import { startCoreRuntime, type CoreRuntime } from './runtime.js';

export interface CoreHostEntryOptions {
  userDataDir: string;
}

const STARTING_STATUS: CoreStatusEnvelope = {
  generation: 0,
  status: { state: 'starting-server', detail: 'Core Host is starting.' }
};

/**
 * The persistent model-facing process. IPC binds before durable/runtime initialization so a
 * duplicate Core loses ownership before it can create competing session/config writers.
 */
export async function runCoreHost(options: CoreHostEntryOptions): Promise<void> {
  initLogFile(path.join(options.userDataDir, 'core.log'));
  const token = await ensureCoreIpcToken(options.userDataDir);
  const abort = new AbortController();
  let runtime: CoreRuntime | null = null;
  let stopping = false;

  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    abort.abort();
  };

  const ipc = await startCoreIpcServer({
    userDataDir: options.userDataDir,
    token,
    hello: () => ({
      protocolVersion: CORE_PROTOCOL_VERSION,
      coreVersion: APP_VERSION,
      corePid: process.pid,
      generation: runtime?.health.snapshot().connectionGeneration ?? 0,
      capabilities: CORE_CAPABILITIES
    }),
    status: () => runtime?.statusEnvelope() ?? STARTING_STATUS,
    connect: async () => {
      if (!runtime) throw new Error('Core Host is still starting');
      await runtime.connect();
    },
    disconnect: async () => {
      if (!runtime) throw new Error('Core Host is still starting');
      await runtime.disconnect();
    },
    applySettings: async () => {
      if (!runtime) throw new Error('Core Host is still starting');
      await runtime.reloadSettings();
    },
    shutdownCore: async () => {
      // Return the IPC acknowledgement before closing the listener/socket underneath it.
      setImmediate(requestStop);
    }
  });

  const stopSignal = (): void => requestStop();
  process.once('SIGTERM', stopSignal);
  process.once('SIGINT', stopSignal);
  app.once('before-quit', stopSignal);

  try {
    logInfo(`core host started pid=${process.pid} protocol=${CORE_PROTOCOL_VERSION}`);
    runtime = await startCoreRuntime(options.userDataDir);
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) resolve();
      else abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } catch (error) {
    logError(`core host failed: ${(error as Error).message}`);
  } finally {
    if (runtime) await runtime.shutdown().catch((error) => logError(`core runtime shutdown failed: ${(error as Error).message}`));
    await ipc.close().catch(() => undefined);
    process.removeListener('SIGTERM', stopSignal);
    process.removeListener('SIGINT', stopSignal);
    app.removeListener('before-quit', stopSignal);
    logInfo(`core host exited pid=${process.pid}`);
    app.exit(0);
  }
}
