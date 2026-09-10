import { app, dialog, shell, type BrowserWindow } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import type { PluginConfigPatch, PluginInstallRequest, PluginSnapshot } from '../shared/plugins.js';
import { callCoreUi } from './connection.js';

const values = z.record(z.string().min(1).max(128), z.string().max(16_384))
  .refine((value) => Object.keys(value).length <= 64, 'At most 64 configuration fields');
const source = z.object({
  kind: z.enum(['npm', 'python', 'command', 'remote', 'mcpb', 'github']),
  package: z.string().max(256).optional(),
  version: z.string().max(128).optional(),
  dependencies: z.array(z.object({ package: z.string().min(1).max(256), version: z.string().min(1).max(128) }).strict()).max(16).optional(),
  command: z.string().max(4096).optional(),
  args: z.array(z.string().max(4096)).max(128).optional(),
  url: z.string().max(4096).optional(),
  path: z.string().max(4096).optional(),
  auth: z.literal('oauth').optional()
}).strict();
const patch = z.object({
  source: source.optional(),
  name: z.string().min(1).max(100).optional(),
  config: values.optional(),
  credentials: values.optional()
}).strict();
const install = patch.extend({ catalogId: z.string().max(80).optional() }).strict();
const identity = z.object({ id: z.string().uuid() }).strict();
type Register = <T>(channel: string, fn: (payload: unknown) => Promise<T>) => void;

/** Electron owns only OS dialogs; every plugin mutation is proxied to persistent Core. */
export function registerPluginIpc(handle: Register, getWindow: () => BrowserWindow | null): void {
  handle('plugins:legalNotices', async () => {
    const notices = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'THIRD-PARTY-NOTICES.txt');
    const error = await shell.openPath(notices);
    if (error) throw new Error('Could not open the bundled Third-party Notices file.');
  });
  handle('plugins:snapshot', async () => callCoreUi<PluginSnapshot>('plugins-list'));
  handle('plugins:install', async (payload) => callCoreUi<PluginSnapshot>('plugins-install', install.parse(payload) as PluginInstallRequest));
  handle('plugins:configure', async (payload) => {
    const input = identity.extend({ patch }).strict().parse(payload);
    return callCoreUi<PluginSnapshot>('plugins-configure', { id: input.id, patch: input.patch as PluginConfigPatch });
  });
  handle('plugins:restart', async (payload) => callCoreUi<PluginSnapshot>('plugins-restart', identity.parse(payload)));
  handle('plugins:update', async (payload) => callCoreUi<PluginSnapshot>('plugins-update', identity.parse(payload)));
  handle('plugins:uninstall', async (payload) => callCoreUi<PluginSnapshot>('plugins-remove', identity.parse(payload)));
  handle('plugins:authenticate', async (payload) => callCoreUi<PluginSnapshot>('plugins-auth-start', identity.parse(payload)));
  handle('plugins:cancelAuthentication', async (payload) => callCoreUi<PluginSnapshot>('plugins-auth-cancel', identity.parse(payload)));
  handle('plugins:enabled', async (payload) => {
    const input = identity.extend({ enabled: z.boolean() }).strict().parse(payload);
    return callCoreUi<PluginSnapshot>('plugins-set-enabled', input);
  });
  handle('plugins:tool', async (payload) => {
    const input = identity.extend({ name: z.string().min(1).max(256), enabled: z.boolean() }).strict().parse(payload);
    return callCoreUi<PluginSnapshot>('plugins-set-tool-enabled', input);
  });
  handle('plugins:importBundle', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Import MCP bundle',
      properties: ['openFile'],
      filters: [{ name: 'MCP bundles', extensions: ['mcpb'] }]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
}
