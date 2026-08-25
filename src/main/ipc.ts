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
import { applySettings, connect, disconnect, getStatus, onStatusChange } from './connection.js';
import { getConfig, updateConfig } from './config.js';
import { retireGoalDrafts } from './goal.js';
import { forgetExposedSurface } from './mcp/server.js';
import { runDiagnostics } from './diagnostics.js';
import { formatLogAsJson, formatLogForClipboard, getLog, logInfo, onLog } from './logger.js';
import { RESERVED_ROOT_NAMES, uniqueRootName, validateNewRoot, SandboxError } from './sandbox.js';
import { hasSecret, isEncryptionAvailable, setSecret } from './secrets.js';
import { bundledVersion, locateBinary } from './tunnel/locate.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';
import {
  bridgeStatus,
  cancelWorkerCommands,
  onBridgeChange,
  startBridge,
  stopBridge,
  unpair
} from './bridge.js';
import { extensionDir } from './extension-path.js';
import {
  deleteSession,
  getSession,
  listSessions,
  readEvents,
  readRecentEvents,
  readHandoff
} from './session/store.js';
import { activeSessionId, forgetSession, onSessionChange } from './session/recorder.js';
import {
  clearAgent,
  onSwarmChange,
  persistAgentAuthorityNow,
  resetSwarm,
  swarmState
} from './agents.js';
import { tokenPressure } from '../shared/session.js';
import { forgetWorkspaceRoot, renameWorkspaceRoot } from './workspace.js';

/** The only URLs the renderer may ask the OS to open. */
const ALLOWED_LINKS = new Set([
  // ChatGPT renamed this page from Connectors to Apps and the button followed it; the
  // allowlist did not, so "Open Apps" had been refused here ever since.
  'https://chatgpt.com/#settings/Apps',
  'https://platform.openai.com/settings/organization/tunnels',
  'https://platform.openai.com/settings/organization/api-keys',
  'https://github.com/openai/tunnel-client/releases',
  'https://github.com/totec448-spec/chat-on-steroids/releases/latest/download/Chat-On-Steroids-Extension.zip',
  'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',
  'https://developers.openai.com/api/docs/guides/developer-mode',
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
    // The Desktop connector's own tunnel. Empty is normal and means "not published":
    // Desktop is optional, and most users will never create a second Secure Tunnel.
    desktopTunnelId: z
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
    advisoryTokens: z.number().int().min(10_000).max(4_000_000),
    limitTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  compaction: z.object({
    auto: z.boolean(),
    // Floored well above what a fresh chat holds, so a threshold cannot be set somewhere
    // every conversation is already past the moment it opens.
    autoTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  multiAgent: z.object({
    enabled: z.boolean(),
    maxWorkers: z.number().int().min(1).max(8)
  }),
  goal: z.object({
    enabled: z.boolean()
  })
});

const settingsSave = z.object({ base: settingsPatch, patch: settingsPatch }).strict();
type SettingsSnapshot = z.infer<typeof settingsPatch>;

/**
 * Three-way merge for the renderer's settings form.
 *
 * The Chrome extension is a second writer for Goal/Auto Compact. The renderer previously sent
 * a blind full snapshot for every checkbox/theme edit, so a snapshot captured just before an
 * extension write could land just after it and silently undo that newer value. A field which is
 * unchanged between `base` and `wanted` was not edited by this renderer save and therefore keeps
 * the current main-process value. A field that differs was deliberately edited here and wins.
 */
function mergeSettings(current: Config, base: SettingsSnapshot, wanted: SettingsSnapshot): SettingsSnapshot {
  const pick = <T>(live: T, before: T, next: T): T => (Object.is(before, next) ? live : next);
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      pick(current.capabilities[capability], base.capabilities[capability], wanted.capabilities[capability])
    ])
  ) as Config['capabilities'];
  return {
    capabilities,
    readOnly: pick(current.readOnly, base.readOnly, wanted.readOnly),
    tunnel: {
      kind: pick(current.tunnel.kind, base.tunnel.kind, wanted.tunnel.kind),
      tunnelId: pick(current.tunnel.tunnelId, base.tunnel.tunnelId, wanted.tunnel.tunnelId),
      desktopTunnelId: pick(
        current.tunnel.desktopTunnelId,
        base.tunnel.desktopTunnelId,
        wanted.tunnel.desktopTunnelId
      ),
      binaryPath: pick(current.tunnel.binaryPath, base.tunnel.binaryPath, wanted.tunnel.binaryPath)
    },
    ui: {
      minimizeToTray: pick(current.ui.minimizeToTray, base.ui.minimizeToTray, wanted.ui.minimizeToTray),
      autoConnect: pick(current.ui.autoConnect, base.ui.autoConnect, wanted.ui.autoConnect),
      privacyScreenshots: pick(
        current.ui.privacyScreenshots,
        base.ui.privacyScreenshots,
        wanted.ui.privacyScreenshots
      ),
      theme: pick(current.ui.theme, base.ui.theme, wanted.ui.theme)
    },
    sessions: {
      record: pick(current.sessions.record, base.sessions.record, wanted.sessions.record),
      retainDays: pick(current.sessions.retainDays, base.sessions.retainDays, wanted.sessions.retainDays),
      advisoryTokens: pick(
        current.sessions.advisoryTokens,
        base.sessions.advisoryTokens,
        wanted.sessions.advisoryTokens
      ),
      limitTokens: pick(current.sessions.limitTokens, base.sessions.limitTokens, wanted.sessions.limitTokens)
    },
    compaction: {
      auto: pick(current.compaction.auto, base.compaction.auto, wanted.compaction.auto),
      autoTokens: pick(current.compaction.autoTokens, base.compaction.autoTokens, wanted.compaction.autoTokens)
    },
    multiAgent: {
      enabled: pick(current.multiAgent.enabled, base.multiAgent.enabled, wanted.multiAgent.enabled),
      maxWorkers: pick(current.multiAgent.maxWorkers, base.multiAgent.maxWorkers, wanted.multiAgent.maxWorkers)
    },
    goal: {
      enabled: pick(current.goal.enabled, base.goal.enabled, wanted.goal.enabled)
    }
  };
}

const sessionIdArg = z.object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i) });
const agentIdArg = z.string().min(1).max(64).regex(/^[0-9a-z-]+$/i);

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
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false as const, error: message };
    }
  });
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  handle('state:get', async () => buildState());

  handle('settings:save', async (payload) => {
    const request = settingsSave.parse(payload);
    const before = getConfig();
    const wasMultiAgent = before.multiAgent.enabled;
    const next = await updateConfig((config) => ({ ...config, ...mergeSettings(config, request.base, request.patch) }));
    if (before.goal.enabled !== next.goal.enabled) retireGoalDrafts();
    // Switching multi-agent mode off has to be able to remove the `agents` tool from the
    // schemas, and the exposed surface only ever widens by default. So the latch is
    // released here — the one place that knows the user made the decision
    // deliberately — and the settings screen tells them to reconnect the connector, which
    // is what makes ChatGPT read the clean schemas.
    if (wasMultiAgent && !next.multiAgent.enabled) forgetExposedSurface();
    // Order matters, and it used to be wrong. Ending the run is what tells the still-open
    // worker chats to stop, and it does that by queueing commands the bridge delivers — so
    // stopping the bridge first meant those notices were queued into a server that was
    // already gone, the tabs kept generating, and the commands sat in the queue until some
    // later restart opened them. The run ends while the bridge can still act on it.
    let authorityPersistError: Error | null = null;
    if (!next.multiAgent.enabled) {
      resetSwarm();
      try {
        if (!(await persistAgentAuthorityNow())) {
          throw new Error('Multi-agent teardown has no immediate durable persistence sink.');
        }
      } catch (error) {
        authorityPersistError = error instanceof Error ? error : new Error(String(error));
      }
    }
    // The extension bridge serves both features: recording needs it to observe the
    // chat, and multi-agent mode needs it to open worker tabs. Either one being on is
    // enough, and this must match the startup rule in index.ts exactly — a bridge that
    // runs at startup but not after a settings save is the worst of both.
    if (next.sessions.record || next.multiAgent.enabled) await startBridge();
    else await stopBridge();
    // Permissions and the second tunnel id both decide whether the optional Desktop
    // connector should be published. Without this, enabling desktop access or pasting its
    // tunnel id left the connector unpublished until the user happened to reconnect, with
    // the card still saying "not published" and nothing explaining why.
    await applySettings();
    logInfo('settings updated');
    // The config and runtime side effects above still complete so the app does not stay half-on,
    // but the UI must not be told the teardown was safely accepted when its authority snapshot
    // failed to cross disk. Startup with the feature off also clears stale swarm state as a
    // recovery net for this exact failure class.
    if (authorityPersistError) throw authorityPersistError;
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
    await updateConfig((config) => {
      if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
      return {
        ...config,
        roots: config.roots.filter((r) => r.name !== name)
      };
    });
    forgetWorkspaceRoot(name);
    logInfo(`removed folder /${name}`);
    return buildState();
  });

  handle('roots:rename', async (payload) => {
    const { name, newName } = renameRoot.parse(payload);
    if (RESERVED_ROOT_NAMES.has(newName)) {
      throw new SandboxError(`/${newName} is reserved by Chat On Steroids and cannot be used as a folder name`);
    }
    await updateConfig((config) => {
      if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
      if (config.roots.some((r) => r.name !== name && r.name === newName)) {
        throw new Error(`/${newName} is already used`);
      }
      return {
        ...config,
        roots: config.roots.map((r) => (r.name === name ? { ...r, name: newName } : r))
      };
    });
    renameWorkspaceRoot(name, newName);
    return buildState();
  });

  /** Stores the OpenAI tunnel credential; Goal uses local Antigravity auth and has no key slot. */
  handle('secret:set', async (payload) => {
    const { value } = z.object({ value: z.string().max(500) }).parse(payload);
    const key = 'openaiApiKey' as const;
    if (!isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable, so the key cannot be stored safely.');
    }
    await setSecret(key, value);
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
    // This is a Core transport setting just like changing the method/tunnel id in the form.
    // Apply it immediately when connected rather than saving a path the running child never
    // uses until some unrelated future reconnect.
    await applySettings();
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
    const sessions = (await listSessions()).slice(0, 60);
    return {
      sessions,
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
    if (!summary) throw new Error('Session not found');
    // The renderer draws a timeline, not the whole log: the tail is what matters and
    // the rest stays one click away rather than being pushed over IPC every refresh.
    const cap = limit ?? 300;
    if (from === undefined) {
      const events = await readRecentEvents(id, cap);
      return { summary, events, total: summary.events };
    }
    const events = await readEvents(id, { from, limit: cap });
    return { summary, events, total: summary.events };
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

  // ---------------------------------------------------------------- bridge

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
    const error = await shell.openPath(dir);
    if (error) throw new Error(`Could not open the extension folder: ${error}`);
    return dir;
  });

  handle('bridge:extensionPath', async () => extensionDir());

  // ----------------------------------------------------------------- swarm

  handle('swarm:get', async () => swarmState());
  handle('swarm:reset', async () => {
    resetSwarm();
    if (!(await persistAgentAuthorityNow())) {
      throw new Error('The cleared run could not be made durable. Retry clearing the swarm.');
    }
    return swarmState();
  });
  /**
   * Clearing one row in the app: the prime ends the run, a worker frees its own slot.
   *
   * The queued bootstrap is withdrawn here rather than from inside the broker. The broker
   * deliberately knows nothing about HTTP or tabs, and `drop()` reaches `failAgent` from
   * inside a delivery — cancelling from there would re-enter it. An IPC call never is.
   * `tidyCommands()` would retire the command on its own at the next poll; doing it now is
   * what stops a tab opening for a slot the user has just cleared.
   */
  handle('swarm:clearAgent', async (payload) => {
    const id = agentIdArg.parse(payload);
    const outcome = clearAgent(id);
    if (outcome.cleared !== 'none') {
      if (!(await persistAgentAuthorityNow())) {
        throw new Error('The agent clear could not be made durable. Retry the clear action.');
      }
      if (outcome.cleared === 'worker') cancelWorkerCommands(outcome.reason, id);
    }
    // The prime's report stays in the main process: the renderer needs the outcome, not
    // the message queued for the prime agent.
    return { cleared: outcome.cleared, reason: outcome.reason, swarm: swarmState() };
  });


  // Push updates so the UI reflects tunnel progress without polling. buildState() crosses
  // async secret/bridge reads, so an older snapshot can otherwise resolve after a newer one and
  // repaint stale config/status. Latest-request-wins makes the push stream monotonic.
  let statePushGeneration = 0;
  const pushState = (): void => {
    const generation = ++statePushGeneration;
    void buildState().then((state) => {
      if (generation !== statePushGeneration) return;
      getWindow()?.webContents.send('state:changed', state);
    });
  };
  onStatusChange(pushState);
  onBridgeChange(pushState);
  onLog((entry) => getWindow()?.webContents.send('log:entry', entry));
  onSessionChange(() => getWindow()?.webContents.send('session:changed'));
  onSwarmChange(() => getWindow()?.webContents.send('swarm:changed', swarmState()));
}
