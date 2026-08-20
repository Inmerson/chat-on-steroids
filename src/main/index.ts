/**
 * Main process entry: window, tray, and the security posture for the renderer.
 */

import path from 'node:path';
import { app, BrowserWindow, Menu, Tray, nativeImage, session, shell } from 'electron';
import { getConfig, initConfigPath, loadConfig } from './config.js';
import { connect, disconnect, getStatus, onStatusChange } from './connection.js';
import { registerIpc } from './ipc.js';
import { logError, logInfo } from './logger.js';
import { unifiedExecManager } from './codex/manager.js';
import { initSecretsPath } from './secrets.js';
import { setBrowserOpener, startBridge, stopBridge } from './bridge.js';
import { flushSessions, initSessionStore, pruneSessions } from './session/store.js';
import {
  flushRecorder,
  repairDeterministicAttribution,
  setAgentBinder,
  setAgentConversationLookup
} from './session/recorder.js';
import {
  agentConversation,
  bindConversation,
  onSwarmPersist,
  restoreSwarm,
  snapshotSwarm,
  type SwarmSnapshot
} from './agents.js';
import { flushDurable, initDurableStore, readDurable, writeDurableSoon } from './durable.js';
import { restoreRequestCorrelations } from './session/correlation.js';

/** Durable state file holding the multi-agent run. Hashes only, never credentials. */
const SWARM_STATE = 'swarm';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
// One-shot startup flag used by the self-update path. It reconnects this launch
// without changing the user's persistent auto-connect preference.
const connectOnStart = process.argv.includes('--connect-on-start');

// One instance only: two copies would fight over the tunnel and the config file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow(): void {
  window = new BrowserWindow({
    // The layout is a fixed frame: three cards over a log over a nav bar, sized to
    // fit exactly. Resizing could only break it, so the window does not resize.
    width: 1080,
    height: 700,
    // 700 must be the space the layout actually gets, not 700 minus the title bar.
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    // Painted before the renderer loads, so a dark window never flashes white.
    backgroundColor: getConfig().ui.theme === 'dark' ? '#0e0e11' : '#ffffff',
    title: 'ChatGPT Local Files',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // The renderer only ever loads our own local files.
      webSecurity: true
    }
  });

  window.once('ready-to-show', () => window?.show());

  // A renderer that fails to load leaves a blank window with no other clue, so
  // record it where the diagnostics panel can show it.
  window.webContents.on('did-finish-load', () => logInfo('window loaded'));
  window.webContents.on('did-fail-load', (_event, code, description) =>
    logError(`window failed to load (${code}): ${description}`)
  );
  // Renderer errors are otherwise invisible from here. Only errors, and only the
  // message text — never anything the page was working with.
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') logError(`renderer: ${details.message}`);
  });

  // Nothing in this app should ever open a second window or navigate away.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  window.on('close', (event) => {
    if (!quitting && getConfig().ui.minimizeToTray) {
      event.preventDefault();
      window?.hide();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function showWindow(): void {
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** A tiny generated icon keeps the tray working without shipping image assets. */
function trayIcon(connected: boolean): Electron.NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const [r, g, b] = connected ? [34, 160, 90] : [130, 130, 138];
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      const inside = distance <= 6.2;
      const offset = (y * size + x) * 4;
      // Electron expects BGRA on Windows.
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
      buffer[offset + 3] = inside ? 255 : 0;
    }
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

function refreshTray(): void {
  if (!tray) return;
  const state = getStatus().state;
  const connected = state === 'connected';
  const offline = state === 'offline';
  // Offline keeps the running icon: the bridge is up, the internet is not.
  const running = connected || offline;
  const label = connected ? 'Connected' : offline ? 'No internet' : 'Not connected';
  tray.setImage(trayIcon(running));
  tray.setToolTip(`ChatGPT Local Files — ${label.toLowerCase()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Open', click: showWindow },
      {
        label: running ? 'Disconnect' : 'Connect',
        click: () => void (running ? disconnect() : connect())
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

app.on('second-instance', showWindow);

void app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  initConfigPath(userData);
  initSecretsPath(userData);
  initSessionStore(userData);
  initDurableStore(userData);
  await loadConfig();
  // Request ownership must exist before either side of the bridge can race in. A request id
  // that was proved yesterday remains the same workflow today even if its ChatGPT tab closed.
  await restoreRequestCorrelations();
  await repairDeterministicAttribution();
  setAgentConversationLookup(agentConversation);
  // The prime's chat is the user's own, so no extension report can name it. It is bound
  // when the recorder manages to place the prime's first call. See recordToolCall.
  setAgentBinder(bindConversation);
  // Before anything can call an agent tool, and before a run is restored: the broker
  // decides whether a previous run has been abandoned partly from which ChatGPT tabs are
  // open, and without this it can only answer "I cannot see" — which it treats, on
  // purpose, as a reason to leave the existing run alone.
  // How a fresh chat actually opens. The app asks the OS to open the ChatGPT URL, which
  // launches the browser if it is closed and creates the tab if there is none — the two
  // cases the old "wait for a ChatGPT tab to poll us" delivery could never handle. Wired
  // before any restored command is delivered, so a resume queued yesterday opens as soon
  // as the bridge starts rather than waiting for the user to visit ChatGPT.
  setBrowserOpener(async (url) => {
    await shell.openExternal(url);
  });

  // A multi-agent run outlives this process. Restoring it before the bridge starts
  // means a worker that never joined gets its chat re-requested through the same queue
  // as a fresh one, rather than being stranded with a key nobody has.
  if (getConfig().multiAgent.enabled) {
    onSwarmPersist(() => writeDurableSoon(SWARM_STATE, snapshotSwarm()));
    restoreSwarm(await readDurable<SwarmSnapshot>(SWARM_STATE));
  }

  // Strict CSP for our own page. There is no remote content and no inline script.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
        ]
      }
    });
  });

  // Deny every permission request; the UI needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  createWindow();
  registerIpc(() => window);

  tray = new Tray(trayIcon(false));
  tray.on('click', showWindow);
  refreshTray();
  onStatusChange(refreshTray);

  logInfo('app started');

  // The bridge serves recording and multi-agent mode both: recording needs the
  // extension to observe the chat, and multi-agent mode needs it to open worker tabs.
  // Either switch being on starts it. ipc.ts applies the same rule on a settings save.
  if (getConfig().sessions.record || getConfig().multiAgent.enabled) {
    void startBridge();
  }
  if (getConfig().sessions.record) {
    void pruneSessions(getConfig().sessions.retainDays)
      .then((removed) => {
        if (removed > 0) logInfo(`removed ${removed} session(s) past the retention window`);
      })
      .catch((err: Error) => logError(`session pruning failed: ${err.message}`));
  }

  if (getConfig().ui.autoConnect || connectOnStart) void connect();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  // The tray keeps the app alive; quitting is explicit.
  if (!getConfig().ui.minimizeToTray) app.quit();
});

app.on('will-quit', (event) => {
  if (!tray) return;
  event.preventDefault();
  tray.destroy();
  tray = null;
  // flushSessions and flushDurable last, so a summary or a swarm change written during
  // shutdown still lands on disk instead of dying with the debounce timer. flushRecorder
  // comes before them: tool calls are filed off the connector's path, so the last one or
  // two of a session can still be queued at this point.
  void Promise.all([disconnect(), unifiedExecManager.terminateAllProcesses(), stopBridge()])
    .then(() => flushRecorder())
    .then(() => Promise.all([flushSessions(), flushDurable()]))
    .finally(() => app.quit());
});

// Belt and braces: no web contents anywhere in this app may open a window or
// navigate. External links go through the vetted allowlist in ipc.ts instead.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
});
