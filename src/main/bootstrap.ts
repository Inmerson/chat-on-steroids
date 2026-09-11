import { app } from 'electron';
import { parseRuntimeMode } from './core/mode.js';

async function bootstrap(): Promise<void> {
  const mode = parseRuntimeMode(process.argv);

  if (mode.kind === 'ui') {
    // connection.ts uses this boundary to become a Core IPC client in the UI process while the
    // helper-mode Core imports the exact same module as its local transport owner.
    process.env.COS_CORE_UI_CLIENT = '1';
    await import('./index.js');
    return;
  }

  // Detached children inherit the UI environment. Clear the facade selector before importing
  // any Core module or the helper would recursively behave as another UI IPC client.
  delete process.env.COS_CORE_UI_CLIENT;
  // Helper processes must share the exact installed profile with the UI. Set it before any
  // config/secrets/session module is initialized.
  app.setPath('userData', mode.userDataDir);

  if (mode.kind === 'core-host') {
    // The Core Host takes its IPC endpoint before Electron readiness. On a busy Windows
    // desktop `app.whenReady()` can take longer than the watchdog's first probe window;
    // waiting here used to make the supervisor start several Core Hosts for one profile.
    // `runCoreHost` publishes a starting IPC status and waits for Electron only before it
    // initializes the runtime that needs Electron services.
    const { runCoreHost } = await import('./core/host-entry.js');
    await runCoreHost({ userDataDir: mode.userDataDir });
    return;
  }

  await app.whenReady();
  const { runCoreSupervisorEntry } = await import('./core/supervisor-entry.js');
  await runCoreSupervisorEntry({ userDataDir: mode.userDataDir });
}

void bootstrap();
