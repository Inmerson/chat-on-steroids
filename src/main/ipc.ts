/**
 * IPC surface.
 *
 * A fixed list of named handlers, each validating its own input with zod. There is no
 * generic "call this method" or "read this file" channel, so a compromised renderer
 * gains only the operations listed below — it can never reach the filesystem or spawn
 * a process directly. Secrets travel one way: the renderer can set or clear the API
 * key but can never read it back.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { CAPABILITIES, type AppState, type Config } from '../shared/types.js';
import { connect, disconnect, getStatus, onStatusChange } from './connection.js';
import { getConfig, updateConfig } from './config.js';
import { runDiagnostics } from './diagnostics.js';
import { formatLogAsJson, formatLogForClipboard, getLog, logInfo, onLog } from './logger.js';
import { uniqueRootName, validateNewRoot, SandboxError } from './sandbox.js';
import { hasSecret, isEncryptionAvailable, setSecret } from './secrets.js';
import { bundledVersion, locateBinary } from './tunnel/locate.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';

/** The only URLs the renderer may ask the OS to open. */
const ALLOWED_LINKS = new Set([
  'https://chatgpt.com/#settings/Connectors',
  'https://platform.openai.com/settings/organization/tunnels',
  'https://platform.openai.com/settings/organization/api-keys',
  'https://github.com/openai/tunnel-client/releases',
  'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',
  'https://developers.openai.com/api/docs/guides/developer-mode'
]);

const capabilityPatch = z.object(
  Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean()])) as Record<
    (typeof CAPABILITIES)[number],
    z.ZodBoolean
  >
);

const settingsPatch = z.object({
  capabilities: capabilityPatch,
  readOnly: z.boolean(),
  tunnel: z.object({
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z
      .string()
      .max(128)
      .refine((v) => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters'),
    binaryPath: z.string().max(4096)
  }),
  ui: z.object({
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    privacyScreenshots: z.boolean(),
    theme: z.enum(['light', 'dark'])
  })
});

const renameRoot = z.object({
  name: z.string().min(1).max(32),
  newName: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Lowercase letters, digits, dot, dash and underscore only')
});

function resolvedBinary(config: Config): string | null {
  if (config.tunnel.kind === 'cloudflared') return locateBinary('cloudflared', config.tunnel.binaryPath);
  if (config.tunnel.kind === 'openai') return locateBinary('tunnel-client', config.tunnel.binaryPath);
  return null;
}

async function buildState(): Promise<AppState> {
  const config = getConfig();
  return {
    config,
    status: getStatus(),
    hasApiKey: await hasSecret('openaiApiKey'),
    resolvedBinary: resolvedBinary(config),
    bundledTunnelVersion: bundledVersion()
  };
}

/** Wraps a handler so a thrown error becomes a message the UI can show. */
function handle<T>(channel: string, fn: (payload: unknown) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return { ok: true as const, data: await fn(payload) };
    } catch (err) {
      const message =
        err instanceof SandboxError || err instanceof z.ZodError
          ? err instanceof z.ZodError
            ? (err.issues[0]?.message ?? 'Invalid input')
            : err.message
          : (err as Error).message;
      return { ok: false as const, error: message };
    }
  });
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  handle('state:get', async () => buildState());

  handle('settings:save', async (payload) => {
    const patch = settingsPatch.parse(payload);
    await updateConfig((config) => ({ ...config, ...patch }));
    logInfo('settings updated');
    return buildState();
  });

  handle('roots:add', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Approve a folder for ChatGPT',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return buildState();

    let addedName = '';
    await updateConfig(async (config) => {
      const real = await validateNewRoot(result.filePaths[0]!, config.roots);
      const name = uniqueRootName(real, config.roots);
      addedName = name;
      return { ...config, roots: [...config.roots, { name, path: real }] };
    });
    logInfo(`approved folder /${addedName}`);
    return buildState();
  });

  handle('roots:remove', async (payload) => {
    const { name } = z.object({ name: z.string().min(1).max(32) }).parse(payload);
    await updateConfig((config) => ({
      ...config,
      roots: config.roots.filter((r) => r.name !== name)
    }));
    logInfo(`removed folder /${name}`);
    return buildState();
  });

  handle('roots:rename', async (payload) => {
    const { name, newName } = renameRoot.parse(payload);
    await updateConfig((config) => {
      if (config.roots.some((r) => r.name !== name && r.name === newName)) {
        throw new Error(`/${newName} is already used`);
      }
      return {
        ...config,
        roots: config.roots.map((r) => (r.name === name ? { ...r, name: newName } : r))
      };
    });
    return buildState();
  });

  handle('secret:set', async (payload) => {
    const { value } = z.object({ value: z.string().max(500) }).parse(payload);
    if (!isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable, so the key cannot be stored safely.');
    }
    await setSecret('openaiApiKey', value);
    logInfo(value.trim() === '' ? 'api key cleared' : 'api key stored');
    return buildState();
  });

  handle('binary:pick', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Select the tunnel executable',
      properties: ['openFile'],
      filters: [{ name: 'Programs', extensions: ['exe'] }]
    });
    if (result.canceled || !result.filePaths[0]) return buildState();
    await updateConfig((config) => ({
      ...config,
      tunnel: { ...config.tunnel, binaryPath: result.filePaths[0]! }
    }));
    return buildState();
  });

  handle('connection:connect', async () => {
    await connect();
    return buildState();
  });

  handle('connection:disconnect', async () => {
    await disconnect();
    return buildState();
  });

  handle('diagnostics:run', async () => runDiagnostics());

  handle('log:get', async () => getLog());
  handle('log:text', async () => formatLogForClipboard());
  handle('log:json', async () => formatLogAsJson());

  handle('link:open', async (payload) => {
    const { url } = z.object({ url: z.string().max(500) }).parse(payload);
    if (!ALLOWED_LINKS.has(url)) throw new Error('That link is not allowed');
    await shell.openExternal(url);
    return true;
  });

  // Push updates so the UI reflects tunnel progress without polling.
  onStatusChange(() => {
    void buildState().then((state) => getWindow()?.webContents.send('state:changed', state));
  });
  onLog((entry) => getWindow()?.webContents.send('log:entry', entry));
}
