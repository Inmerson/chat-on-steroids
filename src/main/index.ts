/**
 * Electron UI process: window/tray and renderer security only.
 *
 * The model-facing runtime is owned by the independent Core Host. This process deliberately does
 * not initialize session/durable/swarm/bridge/execution singletons, and ordinary UI quit never
 * tears those resources down. That process boundary is the reliability contract.
 */

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, screen, session } from 'electron';
import { getConfig, initConfigPath, loadConfig } from './config.js';
import { connect, disconnect, getStatus, onStatusChange, shutdownConnection } from './connection.js';
import { registerUiIpc } from './ipc-ui.js';
import { initLogFile, logError, logInfo, logWarn } from './logger.js';
import { initSecretsPath } from './secrets.js';
import { runShutdownSequence } from './shutdown.js';
import { windowLayoutForWorkArea } from './window-layout.js';
import {
  createWindowActivationGate,
  ownsAppRuntime,
  registerNativeWindowActivation,
  shouldBeginAppBootstrap,
  shouldQuitOnWindowAllClosed
} from './window-lifecycle.js';
import { trayGuidArgsForPlatform, trayImageSpec } from './tray-image.js';
import { browserWindowIconPath } from './window-icon.js';
import { isBackgroundStartup, syncLoginStartup } from './background-startup.js';
import { ensureDesktopShortcut } from './desktop-shortcut.js';
import { applyStagedUpdate, startUpdateChecks } from './update.js';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
const backgroundStartup = isBackgroundStartup();

if (!app.isPackaged && process.env.COS_DEV_USER_DATA?.trim()) {
  const isolatedUserData = path.resolve(process.env.COS_DEV_USER_DATA.trim());
  mkdirSync(isolatedUserData, { recursive: true });
  app.setPath('userData', isolatedUserData);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  quitting = true;
  void import('node:http').then(({ request }) => {
    const req = request({ hostname: '127.0.0.1', port: 8765, path: '/show', method: 'POST', timeout: 1000 });
    req.on('error', () => app.quit());
    req.on('response', () => app.quit());
    req.end();
    setTimeout(() => app.quit(), 1000);
  }).catch(() => app.quit());
}

function createWindow(): void {
  const layout = windowLayoutForWorkArea(screen.getPrimaryDisplay().workArea);
  const icon = browserWindowIconPath(process.platform, app.isPackaged, process.resourcesPath);
  window = new BrowserWindow({
    ...layout,
    ...(icon ? { icon } : {}),
    fullscreenable: false,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: getConfig().ui.theme === 'dark' ? '#0e0e11' : '#ffffff',
    title: 'Chat On Steroids',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true
    }
  });

  window.center();
  window.show();
  app.focus({ steal: true });
  window.focus();

  window.once('ready-to-show', () => {
    if (!quitting && window && !window.isDestroyed()) {
      window.restore();
      window.center();
      window.show();
      app.focus({ steal: true });
      window.focus();
      window.setAlwaysOnTop(true);
      setTimeout(() => {
        if (window && !window.isDestroyed()) {
          window.setAlwaysOnTop(false);
          window.focus();
        }
      }, 250);
    }
  });

  setTimeout(() => {
    if (!quitting && window && !window.isDestroyed() && !window.isVisible()) {
      window.show();
      window.focus();
      window.setAlwaysOnTop(true);
      setTimeout(() => {
        if (window && !window.isDestroyed()) {
          window.setAlwaysOnTop(false);
          window.focus();
        }
      }, 300);
    }
  }, 600);

  window.webContents.on('did-finish-load', () => logInfo('window loaded'));
  window.webContents.on('did-fail-load', (_event, code, description) =>
    logError(`window failed to load (${code}): ${description}`)
  );
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') logError(`renderer: ${details.message}`);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  window.on('close', (event) => {
    if (!quitting && getConfig().ui.minimizeToTray) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on('closed', () => { window = null; });

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function showWindow(): void {
  if (quitting) return;
  if (!window || window.isDestroyed()) {
    createWindow();
    return;
  }
  try {
    if (window.isMinimized()) window.restore();
    window.show();
    window.center();
    window.setAlwaysOnTop(true);
    window.moveTop();
    window.focus();
    app.focus({ steal: true });
    setTimeout(() => {
      if (window && !window.isDestroyed()) {
        window.setAlwaysOnTop(false);
        window.moveTop();
        window.focus();
      }
    }, 250);
  } catch (error) {
    logError(`showWindow error: ${(error as Error).message}`);
  }
}

const windowActivation = createWindowActivationGate(showWindow);

function trayIcon(running: boolean): Electron.NativeImage {
  const spec = trayImageSpec(process.platform, running);
  const [base, ...highDpi] = spec.representations;
  const image = nativeImage.createFromBuffer(base.png, { scaleFactor: base.scaleFactor });
  for (const representation of highDpi) {
    image.addRepresentation({ scaleFactor: representation.scaleFactor, dataURL: `data:image/png;base64,${representation.png.toString('base64')}` });
  }
  if (spec.template) image.setTemplateImage(true);
  return image;
}

function refreshTray(): void {
  if (!tray) return;
  const state = getStatus().state;
  const connected = state === 'connected';
  const offline = state === 'offline';
  const running = connected || offline || state === 'connecting-tunnel' || state === 'starting-server';
  const label = connected ? 'Connected' : offline ? 'No internet' : running ? 'Reconnecting' : 'Not connected';
  tray.setImage(trayIcon(running));
  tray.setToolTip(`Chat On Steroids — ${label.toLowerCase()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Open', click: () => showWindow() },
    { label: running ? 'Disconnect' : 'Connect', click: () => void (running ? disconnect() : connect()) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
}

app.on('second-instance', () => showWindow());

void app.whenReady().then(async () => {
  if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;
  const userData = app.getPath('userData');
  initConfigPath(userData);
  initSecretsPath(userData);
  initLogFile(path.join(userData, 'app.log'));
  await loadConfig();
  if (windowActivation.isDisabled()) return;

  syncLoginStartup(app, getConfig().ui.autoConnect);
  ensureDesktopShortcut(app.isPackaged, process.execPath);
  nativeTheme.themeSource = getConfig().ui.theme;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"]
    } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  registerUiIpc(() => window, () => { quitting = true; app.quit(); });
  windowActivation.enable();
  if (!backgroundStartup) windowActivation.request();
  registerNativeWindowActivation(app, windowActivation.request);

  tray = new Tray(trayIcon(false), ...trayGuidArgsForPlatform());
  tray.on('click', () => showWindow());
  refreshTray();
  onStatusChange(refreshTray);

  logInfo('UI started; Core runtime is independently supervised');
  if (getConfig().ui.autoConnect) void connect();
  startUpdateChecks();
});

app.on('before-quit', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  quitting = true;
  windowActivation.disable();
});

app.on('window-all-closed', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  if (shouldQuitOnWindowAllClosed(process.platform, getConfig().ui.minimizeToTray)) app.quit();
});

app.on('will-quit', (event) => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  tray?.destroy();
  tray = null;

  void runShutdownSequence(
    [
      { name: 'UI Core detach', budgetMs: 3_000, run: () => [shutdownConnection()] },
      { name: 'update handoff', budgetMs: 5_000, run: () => [applyStagedUpdate()] }
    ],
    {
      info: logInfo,
      warn: logWarn,
      error: logError,
      exit: () => { shutdownComplete = true; app.exit(0); }
    }
  );
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
});
