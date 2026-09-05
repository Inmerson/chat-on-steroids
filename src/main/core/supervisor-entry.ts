import path from 'node:path';
import { app } from 'electron';
import { initLogFile, logError, logInfo } from '../logger.js';
import { runCoreSupervisorDaemon } from './supervisor-daemon.js';

export interface CoreSupervisorEntryOptions {
  userDataDir: string;
}

export async function runCoreSupervisorEntry(options: CoreSupervisorEntryOptions): Promise<void> {
  initLogFile(path.join(options.userDataDir, 'core-supervisor.log'));
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  app.once('before-quit', stop);

  try {
    logInfo(`core supervisor started pid=${process.pid}`);
    const result = await runCoreSupervisorDaemon({
      execPath: process.execPath,
      userDataDir: options.userDataDir,
      signal: abort.signal
    });
    logInfo(`core supervisor stopped (${result}) pid=${process.pid}`);
  } catch (error) {
    logError(`core supervisor failed: ${(error as Error).message}`);
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    app.removeListener('before-quit', stop);
    app.exit(0);
  }
}
