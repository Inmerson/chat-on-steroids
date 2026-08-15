/**
 * IPC surface.
 *
 * A fixed list of named handlers, each validating its own input with zod. There is no
 * generic "call this method" or "read this file" channel, so a compromised renderer
 * gains only the operations listed below — it can never reach the filesystem or spawn
 * a process directly. Secrets travel one way: the renderer can set or clear the API
 * key but can never read it back.
 */

import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
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
import {
  bridgeStatus,
  cancelPairing,
  onBridgeChange,
  queueResume,
  startBridge,
  startPairing,
  stopBridge,
  unpair
} from './bridge.js';
import { extensionDir } from './extension-path.js';
import {
  deleteSession,
  getSession,
  listSessions,
  readEvents,
  readHandoff,
  latestHandoff
} from './session/store.js';
import { activeSessionId, forgetSession, onSessionChange } from './session/recorder.js';
import {
  cancelCompaction,
  clearCompaction,
  compactSession,
  compactionState,
  onCompactionChange
} from './session/compact.js';
import { listModels } from './openrouter.js';
import { onSwarmChange, resetSwarm, swarmState } from './agents.js';
import { tokenPressure } from '../shared/session.js';

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
  }),
  sessions: z.object({
    record: z.boolean(),
    retainDays: z.number().int().min(0).max(3650),
    advisoryTokens: z.number().int().min(10_000).max(2_000_000),
    limitTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  compaction: z.object({
    model: z.string().max(200),
    reasoning: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    showReasoning: z.boolean()
  }),
  multiAgent: z.object({
    enabled: z.boolean(),
    maxWorkers: z.number().int().min(1).max(8)
  })
});

const sessionIdArg = z.object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i) });

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
    hasOpenRouterKey: await hasSecret('openrouterApiKey'),
    resolvedBinary: resolvedBinary(config),
    bundledTunnelVersion: bundledVersion(),
    bridge: await bridgeStatus()
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
    const next = await updateConfig((config) => ({ ...config, ...patch }));
    // The extension bridge serves both features: recording needs it to observe the
    // chat, and multi-agent mode needs it to open worker tabs. Either one being on is
    // enough, and this must match the startup rule in index.ts exactly — a bridge that
    // runs at startup but not after a settings save is the worst of both.
    if (next.sessions.record || next.multiAgent.enabled) await startBridge();
    else await stopBridge();
    if (!next.multiAgent.enabled) resetSwarm();
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

  // ------------------------------------------------------------- sessions

  handle('sessions:list', async () => {
    const config = getConfig();
    const sessions = await listSessions();
    return {
      sessions: sessions.slice(0, 60),
      activeId: activeSessionId(),
      pressure: sessions.map((summary) => ({
        id: summary.id,
        ...tokenPressure(summary.estimatedTokens, config.sessions.advisoryTokens, config.sessions.limitTokens)
      }))
    };
  });

  handle('sessions:events', async (payload) => {
    const { id, from, limit } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        from: z.number().int().min(0).max(10_000_000).optional(),
        limit: z.number().int().min(1).max(1000).optional()
      })
      .parse(payload);
    const summary = await getSession(id);
    // The renderer draws a timeline, not the whole log: the tail is what matters and
    // the rest stays one click away rather than being pushed over IPC every refresh.
    const all = await readEvents(id, from === undefined ? {} : { from });
    const cap = limit ?? 300;
    const events = all.length > cap ? all.slice(all.length - cap) : all;
    return { summary, events, total: all.length };
  });

  handle('sessions:delete', async (payload) => {
    const { id } = sessionIdArg.parse(payload);
    // Detach first. The recorder maps live ChatGPT conversations to session ids, so
    // deleting the folder underneath a live one left it appending to a session that no
    // longer existed — the events went to a resurrected half-session with no summary.
    // Forgetting the mapping makes the next observation open a fresh session instead.
    const detached = forgetSession(id);
    await deleteSession(id);
    logInfo(
      detached.length > 0
        ? `session ${id} deleted; ${detached.length} live conversation(s) will start a new session`
        : `session ${id} deleted`
    );
    return true;
  });

  handle('handoff:get', async (payload) => {
    const { id, handoffId } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        handoffId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i).optional()
      })
      .parse(payload);
    if (handoffId) return readHandoff(id, handoffId);
    const summary = await getSession(id);
    return summary?.lastHandoffId ? readHandoff(id, summary.lastHandoffId) : null;
  });

  // ------------------------------------------------------------ compaction

  handle('compaction:state', async () => compactionState());
  handle('compaction:clear', async () => {
    clearCompaction();
    return compactionState();
  });
  handle('compaction:cancel', async () => {
    cancelCompaction();
    return true;
  });

  handle('compaction:start', async (payload) => {
    const { id, resume } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        resume: z.boolean().optional()
      })
      .parse(payload);
    const handoff = await compactSession({
      sessionId: id,
      reason: resume ? 'compact and resume' : 'manual compaction',
      resume: resume === true
    });
    // The fresh chat is only opened once the handoff exists on disk. If compaction
    // had failed, compactSession would have thrown and nothing would navigate.
    if (resume) {
      queueResume(handoff.id);
      logInfo(`compaction: queued a fresh chat for handoff ${handoff.id}`);
    }
    return handoff;
  });

  handle('openrouter:key', async (payload) => {
    const { value } = z.object({ value: z.string().max(500) }).parse(payload);
    if (!isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable, so the key cannot be stored safely.');
    }
    await setSecret('openrouterApiKey', value);
    logInfo(value.trim() === '' ? 'openrouter key cleared' : 'openrouter key stored');
    return buildState();
  });

  handle('openrouter:models', async (payload) => {
    const { refresh, offset, limit, query } = z
      .object({
        refresh: z.boolean().optional(),
        offset: z.number().int().min(0).max(10_000).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        query: z.string().max(100).optional()
      })
      .parse(payload ?? {});
    const all = await listModels(refresh === true);
    const needle = query?.trim().toLowerCase() ?? '';
    const filtered = needle
      ? all.filter((model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle))
      : all;
    const start = offset ?? 0;
    const size = limit ?? 25;
    return { total: filtered.length, offset: start, models: filtered.slice(start, start + size) };
  });

  // ---------------------------------------------------------------- bridge

  handle('bridge:pair', async () => {
    startPairing();
    return buildState();
  });
  handle('bridge:cancelPairing', async () => {
    cancelPairing();
    return buildState();
  });
  handle('bridge:unpair', async () => {
    await unpair();
    return buildState();
  });

  /**
   * Opens the folder Chrome should load the extension from.
   *
   * The renderer never learns the path unless it asks for it here, and all it can do
   * with the answer is show it; the open itself happens in the main process against a
   * path the renderer did not choose.
   */
  handle('bridge:openExtensionFolder', async () => {
    const dir = extensionDir();
    if (!dir) {
      throw new Error(
        'The extension folder is missing from this installation. Reinstall the app, or use the extension/ folder from the source checkout.'
      );
    }
    await shell.openPath(dir);
    return dir;
  });

  handle('bridge:extensionPath', async () => extensionDir());

  // ----------------------------------------------------------------- swarm

  handle('swarm:get', async () => swarmState());
  handle('swarm:reset', async () => {
    resetSwarm();
    return swarmState();
  });

  // Push updates so the UI reflects tunnel progress without polling.
  const pushState = (): void => {
    void buildState().then((state) => getWindow()?.webContents.send('state:changed', state));
  };
  onStatusChange(pushState);
  onBridgeChange(pushState);
  onLog((entry) => getWindow()?.webContents.send('log:entry', entry));
  onSessionChange(() => getWindow()?.webContents.send('session:changed'));
  onCompactionChange((state) => getWindow()?.webContents.send('compaction:changed', state));
  onSwarmChange(() => getWindow()?.webContents.send('swarm:changed', swarmState()));
}
