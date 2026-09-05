/**
 * Renderer IPC for the Electron presentation process.
 *
 * Runtime/config/session/swarm/bridge authority lives in Core Host. This module owns only
 * UI/OS operations (dialogs, theme, clipboard, links, updater) and proxies the fixed backend
 * operations through the authenticated Core IPC facade.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { z } from 'zod';
import type { AppState, BridgeStatus, Config, Diagnosis } from '../shared/types.js';
import type { Handoff, SwarmState } from '../shared/session.js';
import type { ControlCenterStatus } from '../shared/control-center.js';
import {
  callCoreUi,
  connect,
  disconnect,
  getCoreHealth,
  getCoreSecretStatus,
  getStatus,
  onCoreHealthChange,
  onCoreRuntimeChange,
  onStatusChange,
  setCoreSecret
} from './connection.js';
import { formatLogAsJson, formatLogForClipboard, getLog, logInfo, onLog } from './logger.js';
import { isEncryptionAvailable, secureStorageStatus } from './secrets.js';
import { bundledVersion, locateBinary } from './tunnel/locate.js';
import { hostPlatformInfo } from './platform.js';
import { syncLoginStartup } from './background-startup.js';
import { extensionDir } from './extension-path.js';
import { extensionDownloadUrl } from './version.js';
import { markInstallOnQuit, onUpdateChange, updateStatus } from './update.js';
import { RELEASES_PAGE } from '../shared/types.js';

const ALLOWED_LINKS = new Set([
  'https://chatgpt.com/#settings/Apps',
  'https://platform.openai.com/settings/organization/tunnels',
  'https://platform.openai.com/settings/organization/api-keys',
  'https://github.com/openai/tunnel-client/releases',
  'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',
  'https://developers.openai.com/api/docs/guides/developer-mode',
  'https://openrouter.ai/settings/keys',
  RELEASES_PAGE
]);

function resolvedBinary(config: Config): string | null {
  if (config.tunnel.kind === 'cloudflared') return locateBinary('cloudflared', config.tunnel.binaryPath);
  if (config.tunnel.kind === 'openai') return locateBinary('tunnel-client', config.tunnel.binaryPath);
  return null;
}

async function buildState(): Promise<AppState> {
  const [config, bridge, secrets] = await Promise.all([
    callCoreUi<Config>('config-get'),
    callCoreUi<BridgeStatus>('bridge-status'),
    getCoreSecretStatus()
  ]);
  return {
    config,
    status: getStatus(),
    platform: hostPlatformInfo(),
    secureStorage: await secureStorageStatus(),
    hasApiKey: secrets.hasApiKey,
    hasGoalKey: secrets.hasGoalKey,
    resolvedBinary: resolvedBinary(config),
    bundledTunnelVersion: bundledVersion(),
    bridge,
    update: updateStatus()
  };
}

function handle<T>(channel: string, fn: (payload: unknown) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return { ok: true as const, data: await fn(payload) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

const id = z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i);
const agentId = z.string().min(1).max(64).regex(/^[0-9a-z-]+$/i);

export function registerUiIpc(getWindow: () => BrowserWindow | null, quitToInstall: () => void = () => {}): void {
  handle('state:get', async () => {
    const state = await buildState();
    logInfo('renderer state ready');
    return state;
  });

  handle('settings:save', async (payload) => {
    const request = z.object({ base: z.record(z.string(), z.unknown()), patch: z.record(z.string(), z.unknown()) }).parse(payload);
    const next = await callCoreUi<Config>('settings-save', request);
    syncLoginStartup(app, next.ui.autoConnect);
    nativeTheme.themeSource = next.ui.theme;
    getWindow()?.setBackgroundColor(next.ui.theme === 'dark' ? '#0e0e11' : '#ffffff');
    logInfo('settings updated through Core authority');
    return buildState();
  });

  handle('roots:add', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, { title: 'Approve a folder for ChatGPT', properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths[0]) {
      await callCoreUi<Config>('root-add-path', { path: result.filePaths[0] });
    }
    return buildState();
  });

  handle('roots:allComputer:toggle', async () => {
    await callCoreUi<Config>('roots-all-computer-toggle');
    return buildState();
  });

  handle('roots:remove', async (payload) => {
    const value = z.object({ name: z.string().min(1).max(32) }).parse(payload);
    await callCoreUi<Config>('root-remove', value);
    return buildState();
  });

  handle('roots:rename', async (payload) => {
    const value = z.object({
      name: z.string().min(1).max(32),
      newName: z.string().min(1).max(32).regex(/^[a-z0-9][a-z0-9._-]*$/)
    }).parse(payload);
    await callCoreUi<Config>('root-rename', value);
    return buildState();
  });

  handle('secret:set', async (payload) => {
    const { value, key } = z.object({
      value: z.string().max(500),
      key: z.enum(['openaiApiKey', 'openRouterApiKey']).default('openaiApiKey')
    }).parse(payload);
    if (!(await isEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable, so the key cannot be stored safely.');
    }
    await setCoreSecret(key, value);
    logInfo(`${key === 'openRouterApiKey' ? 'openrouter key' : 'api key'} ${value.trim() === '' ? 'cleared' : 'stored'}`);
    return buildState();
  });

  handle('goal:models', async (payload) => {
    const { offset } = z.object({ offset: z.number().int().min(0).max(2000).default(0) }).parse(payload ?? {});
    return callCoreUi('goal-models', { offset });
  });

  handle('binary:pick', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Select the tunnel executable',
      properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Programs', extensions: ['exe'] }] } : {})
    });
    if (!result.canceled && result.filePaths[0]) {
      await callCoreUi<Config>('tunnel-binary-path', { path: result.filePaths[0] });
    }
    return buildState();
  });

  handle('connection:connect', async () => { await connect(); return buildState(); });
  handle('connection:disconnect', async () => { await disconnect(); return buildState(); });
  handle('diagnostics:run', async () => callCoreUi<Diagnosis>('diagnostics-run'));

  handle('log:get', async () => getLog());
  handle('log:text', async () => formatLogForClipboard());
  handle('log:json', async () => formatLogAsJson());
  handle('clipboard:write', async (payload) => {
    const { text } = z.object({ text: z.string().max(1_000_000) }).parse(payload);
    clipboard.writeText(text);
    return true;
  });
  handle('link:open', async (payload) => {
    const { url } = z.object({ url: z.string().max(500) }).parse(payload);
    if (!ALLOWED_LINKS.has(url)) throw new Error('That link is not allowed');
    await shell.openExternal(url);
    return true;
  });

  handle('sessions:list', async (payload) => {
    const value = z.object({
      cursor: z.object({ updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id }).optional(),
      limit: z.number().int().min(1).max(60).optional()
    }).parse(payload ?? {});
    return callCoreUi('session-list', value);
  });
  handle('sessions:events', async (payload) => {
    const value = z.object({
      id,
      from: z.number().int().min(0).max(10_000_000).optional(),
      limit: z.number().int().min(1).max(1000).optional()
    }).parse(payload);
    return callCoreUi('session-events', value);
  });
  handle('sessions:delete', async (payload) => {
    const value = z.object({ id }).parse(payload);
    return callCoreUi<boolean>('session-delete', value);
  });
  handle('handoff:get', async (payload) => {
    const value = z.object({ id, handoffId: id.optional() }).parse(payload);
    return callCoreUi<Handoff | null>('handoff-get', value);
  });

  handle('bridge:unpair', async () => {
    await callCoreUi<boolean>('bridge-unpair');
    return buildState();
  });
  handle('bridge:downloadExtension', async () => {
    await shell.openExternal(extensionDownloadUrl(app.getVersion()));
    return true;
  });
  handle('bridge:openExtensionFolder', async () => {
    const dir = extensionDir();
    if (!dir) throw new Error('The extension folder is missing from this installation. Reinstall the app.');
    const error = await shell.openPath(dir);
    if (error) throw new Error(`Could not open the extension folder: ${error}`);
    return dir;
  });
  handle('bridge:extensionPath', async () => extensionDir());

  handle('update:install', async () => {
    if (!markInstallOnQuit()) throw new Error('There is no downloaded update to install yet');
    logInfo('update: install requested; quitting to hand the update over');
    quitToInstall();
    return true;
  });

  handle('control-center:get', async () => callCoreUi<ControlCenterStatus>('control-center-status'));
  handle('swarm:get', async () => callCoreUi<SwarmState>('swarm-get'));
  handle('swarm:reset', async () => callCoreUi<SwarmState>('swarm-reset'));
  handle('swarm:clearAgent', async (payload) => {
    const value = agentId.parse(payload);
    return callCoreUi('swarm-clear-agent', { id: value });
  });

  const push = (channel: string, ...args: unknown[]): void => {
    const target = getWindow();
    if (!target || target.isDestroyed()) return;
    target.webContents.send(channel, ...args);
  };
  let statePushGeneration = 0;
  const pushState = (): void => {
    const generation = ++statePushGeneration;
    void buildState().then((state) => {
      if (generation === statePushGeneration) push('state:changed', state);
    }).catch(() => undefined);
  };

  onStatusChange(pushState);
  onCoreHealthChange(pushState);
  onCoreRuntimeChange((kind) => {
    if (kind === 'bridge') pushState();
    if (kind === 'session') push('session:changed');
    if (kind === 'swarm') {
      void callCoreUi<SwarmState>('swarm-get').then((state) => push('swarm:changed', state)).catch(() => undefined);
    }
  });
  onUpdateChange(pushState);
  onLog((entry) => push('log:entry', entry));

  // State requests already expose health through the visible status projection. This channel is
  // intentionally read-only and useful to tests/debug tooling without putting Core internals into
  // every AppState snapshot.
  handle('core:health', async () => getCoreHealth());
}
