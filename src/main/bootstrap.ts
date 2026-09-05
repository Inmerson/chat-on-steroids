import { app } from 'electron';
import { parseRuntimeMode } from './core/mode.js';

const mode = parseRuntimeMode(process.argv);

if (mode.kind === 'ui') {
  // connection.ts uses this boundary to become a Core IPC client in the UI process while the
  // helper-mode Core imports the exact same module as its local transport owner.
  process.env.COS_CORE_UI_CLIENT = '1';
  await import('./index.js');
} else {
  // Detached children inherit the UI environment. Clear the facade selector before importing
  // any Core module or the helper would recursively behave as another UI IPC client.
  delete process.env.COS_CORE_UI_CLIENT;
  // Helper processes must share the exact installed profile with the UI. Set it before any
  // config/secrets/session module is initialized.
  app.setPath('userData', mode.userDataDir);
  await app.whenReady();

  if (mode.kind === 'core-host') {
    const { runCoreHost } = await import('./core/host-entry.js');
    await runCoreHost({ userDataDir: mode.userDataDir });
  } else {
    const { runCoreSupervisorEntry } = await import('./core/supervisor-entry.js');
    await runCoreSupervisorEntry({ userDataDir: mode.userDataDir });
  }
}
