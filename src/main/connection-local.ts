/**
 * Owns the Core-local lifecycle: local MCP server up, then tunnel(s) up, then connected.
 * UI code imports connection.ts, whose facade delegates here only inside the Core Host.
 */

import type { ConnectionStatus, SurfaceStatus, TunnelSettings } from '../shared/types.js';
import { requiresApprovedFilesystemRoot } from '../shared/capabilities.js';
import { prewarmComputerHelper } from './computer/index.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { logError, logInfo, logWarn } from './logger.js';
import { lastRequestAt, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from './mcp/server.js';
import { lastToolCallAt } from './mcp/tools.js';
import { SURFACE_LIST, surfaceIsUseful, type SurfaceId } from './mcp/surfaces.js';
import { getSecret } from './secrets.js';
import { startTunnel, TunnelError, type TunnelHandle } from './tunnel/index.js';
import { desktopAutomationSupported } from './platform.js';
import { executeRemote } from './multidevice/transport.js';
import { pluginManager } from './plugins/manager.js';

let endpoint: McpEndpoint | null = null;
let tunnel: TunnelHandle | null = null;
let desktopTunnel: TunnelHandle | null = null;
let desktopTunnelId: string | null = null;
let steromiTunnel: TunnelHandle | null = null;
let steromiTunnelId: string | null = null;
let pluginsTunnel: TunnelHandle | null = null;
let pluginsTunnelId: string | null = null;
let activeCoreTransport: Pick<TunnelSettings, 'kind' | 'tunnelId' | 'binaryPath'> | null = null;
let status: ConnectionStatus = {
  state: 'disconnected',
  detail: '',
  publicUrl: null,
  localUrl: null,
  handshakeAt: null,
  lastRequestAt: null,
  lastToolCallAt: null,
  health: null,
  surfaces: []
};

const listeners = new Set<(status: ConnectionStatus) => void>();
let lifecycleQueue: Promise<void> = Promise.resolve();
let connectionGeneration = 0;
let shutdownRequested = false;

function enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
  const run = lifecycleQueue.then(operation, operation);
  lifecycleQueue = run.catch(() => {});
  return run;
}

export function getStatus(): ConnectionStatus {
  return {
    ...status,
    lastRequestAt: lastRequestAt(),
    lastToolCallAt: lastToolCallAt(),
    surfaces: describeSurfaces()
  };
}

export function onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(next: Partial<ConnectionStatus>): void {
  status = { ...status, ...next };
  for (const listener of listeners) listener(status);
}

function describeSurfaces(): SurfaceStatus[] {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  const running = endpoint !== null;
  return SURFACE_LIST.map((surface) => {
    const available = surfaceIsUseful(surface.id, caps);
    const previous = status.surfaces.find((entry) => entry.id === surface.id);
    return {
      id: surface.id,
      connectorName: surface.connectorName,
      description: surface.description,
      cardSummary: surface.cardSummary,
      optional: !surface.required,
      available,
      localUrl: endpoint?.urls[surface.id] ?? null,
      publicUrl: running ? (previous?.publicUrl ?? null) : null,
      tools: toolsFor(surface.id),
      state: available && running ? (previous?.state ?? 'off') : 'off',
      detail: available ? (running ? (previous?.detail ?? '') : '') : desktopUnavailableDetail(surface.id),
      lastRequestAt: lastRequestAt(surface.id),
      lastToolCallAt: lastToolCallAt(surface.id)
    };
  });
}

function desktopUnavailableDetail(id: SurfaceId): string {
  if (id === 'desktop' && !desktopAutomationSupported()) {
    return 'Desktop automation is Windows-only. Core files, terminal, sessions and sub-agents remain available.';
  }
  return id === 'desktop'
    ? 'Turn on "See the screen", "Control mouse and keyboard" or a clipboard permission to use this connector.'
    : '';
}

function toolsFor(id: SurfaceId): string[] {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  const computer = caps.control || caps.clipboardRead || caps.clipboardWrite;
  const desktopTools = [...(caps.screen ? ['observe'] : []), ...(computer ? ['computer'] : [])];
  const coreTools: string[] = [];
  if (caps.read || caps.browse || caps.metadata) coreTools.push('read');
  if (caps.read) coreTools.push('view_image');
  if (!caps.command && caps.search) coreTools.push('find');
  if (caps.create || caps.edit || caps.move || caps.deleteFile) coreTools.push('apply_patch');
  if (caps.command) coreTools.push('exec_command', 'write_stdin');
  if (config.sessions.record) coreTools.push('session');
  if (config.multiAgent.enabled) coreTools.push('agents');
  if (id === 'desktop') return desktopTools;
  if (id === 'steromi') return ['steromi_dashboard', ...coreTools, ...desktopTools];
  if (id === 'plugins') return pluginManager.tools().map((tool) => tool.name);
  return coreTools;
}

function updateSurface(id: SurfaceId, next: Partial<SurfaceStatus>): void {
  setStatus({ surfaces: status.surfaces.map((entry) => (entry.id === id ? { ...entry, ...next } : entry)) });
}

function surfaceStateForConnection(state: ConnectionStatus['state']): SurfaceStatus['state'] {
  if (state === 'connected') return 'live';
  if (state === 'starting-server' || state === 'connecting-tunnel') return 'starting';
  return 'error';
}

function coreTransport(settings: TunnelSettings): Pick<TunnelSettings, 'kind' | 'tunnelId' | 'binaryPath'> {
  return {
    kind: settings.kind,
    tunnelId: settings.kind === 'openai' ? settings.tunnelId : '',
    binaryPath: settings.kind === 'manual' ? '' : settings.binaryPath
  };
}

function sameCoreTransport(
  left: Pick<TunnelSettings, 'kind' | 'tunnelId' | 'binaryPath'>,
  right: Pick<TunnelSettings, 'kind' | 'tunnelId' | 'binaryPath'>
): boolean {
  return left.kind === right.kind && left.tunnelId === right.tunnelId && left.binaryPath === right.binaryPath;
}

function siblingPublicUrl(publicUrl: string | null, localUrl: string | null): string | null {
  if (!publicUrl || !localUrl) return null;
  try {
    const target = new URL(publicUrl);
    target.pathname = new URL(localUrl).pathname;
    return target.toString();
  } catch {
    return null;
  }
}

async function connectImpl(): Promise<void> {
  if (shutdownRequested) return;
  if (
    status.state === 'connected' ||
    status.state === 'offline' ||
    status.state === 'starting-server' ||
    status.state === 'connecting-tunnel'
  ) {
    return;
  }
  await disconnectImpl();
  if (shutdownRequested) return;
  const generation = ++connectionGeneration;

  const config = getConfig();
  const caps = effectiveCapabilities(config);
  if (config.roots.length === 0 && requiresApprovedFilesystemRoot(config)) {
    setStatus({ state: 'disconnected', detail: 'Add a folder before connecting.' });
    return;
  }

  try {
    setStatus({ state: 'starting-server', detail: 'Starting the local server…', publicUrl: null });
    const startedEndpoint = await startMcpServer(() => {
      const live = getConfig();
      return {
        roots: live.roots,
        caps: effectiveCapabilities(live),
        readOnly: live.readOnly,
        privacyScreenshots: live.ui.privacyScreenshots,
        multiDevice: { execute: executeRemote }
      };
    });
    if (shutdownRequested || generation !== connectionGeneration) {
      await startedEndpoint.stop({ forceAfterMs: 30_000 }).catch(() => {});
      return;
    }
    endpoint = startedEndpoint;
    setStatus({ localUrl: endpoint.url, surfaces: describeSurfaces() });
    if (desktopAutomationSupported() && (caps.screen || caps.control)) void prewarmComputerHelper();
    updateSurface('core', { state: 'starting', detail: 'Connecting…' });

    const apiKey = await getSecret('openaiApiKey');
    if (shutdownRequested || generation !== connectionGeneration) {
      await disconnectImpl(30_000);
      return;
    }
    activeCoreTransport = coreTransport(config.tunnel);
    const startedTunnel = await startTunnel({
      localUrl: endpoint.url,
      settings: config.tunnel,
      apiKey,
      discoveryHeaders: tunnelProbeHeaders(),
      label: 'core',
      report: (report) => {
        if (generation !== connectionGeneration) return;
        setStatus({
          state: report.state,
          detail: report.detail,
          lastRequestAt: lastRequestAt(),
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl }),
          ...(report.handshakeAt === undefined ? {} : { handshakeAt: report.handshakeAt }),
          ...(report.health === undefined ? {} : { health: report.health })
        });
        updateSurface('core', {
          state: surfaceStateForConnection(report.state),
          detail: report.detail,
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl })
        });
        if (config.tunnel.kind !== 'openai' && report.publicUrl !== undefined) {
          for (const id of ['desktop', 'steromi', 'plugins'] as const) {
            const sibling = status.surfaces.find((entry) => entry.id === id);
            if (!sibling?.available) continue;
            updateSurface(id, {
              publicUrl: siblingPublicUrl(report.publicUrl, sibling.localUrl),
              state: surfaceStateForConnection(report.state),
              detail: report.detail
            });
          }
        }
      }
    });
    if (shutdownRequested || generation !== connectionGeneration) {
      await startedTunnel.stop().catch(() => {});
      await disconnectImpl(30_000);
      return;
    }
    tunnel = startedTunnel;
    await startDesktopTunnel(generation, config.tunnel, apiKey);
    await startSteromiTunnel(generation, config.tunnel, apiKey);
    await startPluginsTunnel(generation, config.tunnel, apiKey);
  } catch (err) {
    if (shutdownRequested || generation !== connectionGeneration) {
      await disconnectImpl(30_000);
      return;
    }
    const message = err instanceof TunnelError ? err.message : (err as Error).message;
    logError(`connect failed: ${message}`);
    await disconnectImpl();
    setStatus({ state: err instanceof TunnelError ? 'tunnel-unavailable' : 'disconnected', detail: message });
  }
}

async function startDesktopTunnel(
  generation: number,
  settings: TunnelSettings,
  apiKey: string | null
): Promise<void> {
  if (settings.kind !== 'openai') return;
  const desktop = status.surfaces.find((entry) => entry.id === 'desktop');
  if (!desktop?.available || !endpoint) return;
  if (!settings.desktopTunnelId) {
    updateSurface('desktop', {
      state: 'off',
      detail: 'Not published yet. Create a second Secure Tunnel for it and paste its tunnel id in Settings.'
    });
    return;
  }

  updateSurface('desktop', { state: 'starting', detail: 'Connecting…' });
  try {
    desktopTunnelId = settings.desktopTunnelId;
    const startedDesktopTunnel = await startTunnel({
      localUrl: endpoint.urls.desktop,
      settings: { ...settings, tunnelId: settings.desktopTunnelId },
      apiKey,
      discoveryHeaders: tunnelProbeHeaders(),
      label: 'desktop',
      report: (report) => {
        if (generation !== connectionGeneration) return;
        updateSurface('desktop', {
          state: surfaceStateForConnection(report.state),
          detail: report.detail,
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl })
        });
      }
    });
    if (shutdownRequested || generation !== connectionGeneration) {
      await startedDesktopTunnel.stop().catch(() => {});
      desktopTunnelId = null;
      return;
    }
    desktopTunnel = startedDesktopTunnel;
  } catch (err) {
    if (shutdownRequested || generation !== connectionGeneration) {
      desktopTunnelId = null;
      return;
    }
    const message = err instanceof TunnelError ? err.message : (err as Error).message;
    logWarn(`desktop connector not published: ${message}`);
    desktopTunnelId = null;
    updateSurface('desktop', { state: 'error', detail: message });
  }
}

async function stopDesktopTunnel(detail: string): Promise<void> {
  if (!desktopTunnel) return;
  await desktopTunnel.stop().catch(() => {});
  desktopTunnel = null;
  desktopTunnelId = null;
  logInfo('desktop connector unpublished');
  updateSurface('desktop', { state: 'off', detail, publicUrl: null });
}

async function startSteromiTunnel(
  generation: number,
  settings: TunnelSettings,
  apiKey: string | null
): Promise<void> {
  if (settings.kind !== 'openai') return;
  const steromi = status.surfaces.find((entry) => entry.id === 'steromi');
  if (!steromi?.available || !endpoint) return;
  if (!settings.steromiTunnelId) {
    updateSurface('steromi', {
      state: 'off',
      detail: 'Not published yet. Create a third Secure Tunnel for Steromi and paste its tunnel id in Settings.'
    });
    return;
  }

  updateSurface('steromi', { state: 'starting', detail: 'Connecting…' });
  try {
    steromiTunnelId = settings.steromiTunnelId;
    const startedSteromiTunnel = await startTunnel({
      localUrl: endpoint.urls.steromi,
      settings: { ...settings, tunnelId: settings.steromiTunnelId },
      apiKey,
      discoveryHeaders: tunnelProbeHeaders(),
      label: 'steromi',
      report: (report) => {
        if (generation !== connectionGeneration) return;
        updateSurface('steromi', {
          state: surfaceStateForConnection(report.state),
          detail: report.detail,
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl })
        });
      }
    });
    if (shutdownRequested || generation !== connectionGeneration) {
      await startedSteromiTunnel.stop().catch(() => {});
      steromiTunnelId = null;
      return;
    }
    steromiTunnel = startedSteromiTunnel;
  } catch (err) {
    if (shutdownRequested || generation !== connectionGeneration) {
      steromiTunnelId = null;
      return;
    }
    const message = err instanceof TunnelError ? err.message : (err as Error).message;
    logWarn(`steromi connector not published: ${message}`);
    steromiTunnelId = null;
    updateSurface('steromi', { state: 'error', detail: message });
  }
}

async function stopSteromiTunnel(detail: string): Promise<void> {
  if (!steromiTunnel) return;
  await steromiTunnel.stop().catch(() => {});
  steromiTunnel = null;
  steromiTunnelId = null;
  logInfo('steromi connector unpublished');
  updateSurface('steromi', { state: 'off', detail, publicUrl: null });
}

async function startPluginsTunnel(
  generation: number,
  settings: TunnelSettings,
  apiKey: string | null
): Promise<void> {
  if (settings.kind !== 'openai') return;
  const plugins = status.surfaces.find((entry) => entry.id === 'plugins');
  if (!plugins?.available || !endpoint) return;
  if (!settings.pluginsTunnelId) {
    updateSurface('plugins', {
      state: 'off',
      detail: 'Not published yet. Create a Secure Tunnel for Plugins and paste its tunnel id in Settings.'
    });
    return;
  }

  updateSurface('plugins', { state: 'starting', detail: 'Connecting…' });
  try {
    pluginsTunnelId = settings.pluginsTunnelId;
    const started = await startTunnel({
      localUrl: endpoint.urls.plugins,
      settings: { ...settings, tunnelId: settings.pluginsTunnelId },
      apiKey,
      discoveryHeaders: tunnelProbeHeaders(),
      label: 'plugins',
      report: (report) => {
        if (generation !== connectionGeneration) return;
        updateSurface('plugins', {
          state: surfaceStateForConnection(report.state),
          detail: report.detail,
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl })
        });
      }
    });
    if (shutdownRequested || generation !== connectionGeneration) {
      await started.stop().catch(() => {});
      pluginsTunnelId = null;
      return;
    }
    pluginsTunnel = started;
  } catch (err) {
    if (shutdownRequested || generation !== connectionGeneration) {
      pluginsTunnelId = null;
      return;
    }
    const message = err instanceof TunnelError ? err.message : (err as Error).message;
    logWarn(`plugins connector not published: ${message}`);
    pluginsTunnelId = null;
    updateSurface('plugins', { state: 'error', detail: message });
  }
}

async function stopPluginsTunnel(detail: string): Promise<void> {
  if (!pluginsTunnel) return;
  await pluginsTunnel.stop().catch(() => {});
  pluginsTunnel = null;
  pluginsTunnelId = null;
  logInfo('plugins connector unpublished');
  updateSurface('plugins', { state: 'off', detail, publicUrl: null });
}

async function applySettingsImpl(): Promise<void> {
  if (shutdownRequested) return;
  if (!endpoint) return;
  const config = getConfig();
  const desiredCoreTransport = coreTransport(config.tunnel);
  if (activeCoreTransport && !sameCoreTransport(activeCoreTransport, desiredCoreTransport)) {
    logInfo('core connection settings changed; reconnecting');
    await disconnectImpl();
    await connectImpl();
    return;
  }
  const caps = effectiveCapabilities(config);
  const desktopAvailable = surfaceIsUseful('desktop', caps);
  const steromiAvailable = surfaceIsUseful('steromi', caps);
  const pluginsAvailable = surfaceIsUseful('plugins', caps);
  if (desktopAutomationSupported() && (caps.screen || caps.control)) void prewarmComputerHelper();
  setStatus({ surfaces: describeSurfaces() });

  if (config.tunnel.kind !== 'openai') {
    for (const id of ['desktop', 'steromi', 'plugins'] as const) {
      const available = id === 'desktop' ? desktopAvailable : id === 'steromi' ? steromiAvailable : pluginsAvailable;
      if (!available) continue;
      const sibling = status.surfaces.find((entry) => entry.id === id);
      updateSurface(id, {
        publicUrl: siblingPublicUrl(status.publicUrl, sibling?.localUrl ?? null),
        state: surfaceStateForConnection(status.state),
        detail: status.detail
      });
    }
    return;
  }

  if (!desktopAvailable) {
    await stopDesktopTunnel('Turn a desktop permission back on to publish this connector.');
  } else if (!desktopTunnel || desktopTunnelId !== config.tunnel.desktopTunnelId) {
    await stopDesktopTunnel('Reconnecting with the new tunnel…');
    await startDesktopTunnel(connectionGeneration, config.tunnel, await getSecret('openaiApiKey'));
  }

  if (!steromiAvailable) {
    await stopSteromiTunnel('Steromi is not available with the current permissions.');
  } else if (!steromiTunnel || steromiTunnelId !== config.tunnel.steromiTunnelId) {
    await stopSteromiTunnel('Reconnecting with the new tunnel…');
    await startSteromiTunnel(connectionGeneration, config.tunnel, await getSecret('openaiApiKey'));
  }

  if (!pluginsAvailable) {
    await stopPluginsTunnel('Plugins are not available with the current configuration.');
  } else if (!pluginsTunnel || pluginsTunnelId !== config.tunnel.pluginsTunnelId) {
    await stopPluginsTunnel('Reconnecting with the new tunnel…');
    await startPluginsTunnel(connectionGeneration, config.tunnel, await getSecret('openaiApiKey'));
  }
}

export function applySettings(): Promise<void> {
  return enqueueLifecycle(applySettingsImpl);
}

async function disconnectImpl(endpointForceAfterMs?: number): Promise<void> {
  connectionGeneration += 1;
  if (endpoint) {
    const stopping = endpoint;
    endpoint = null;
    if (endpointForceAfterMs === undefined) await stopping.stop().catch(() => {});
    else await stopping.stop({ forceAfterMs: endpointForceAfterMs }).catch(() => {});
  }
  if (desktopTunnel) {
    await desktopTunnel.stop().catch(() => {});
    desktopTunnel = null;
  }
  desktopTunnelId = null;
  if (steromiTunnel) {
    await steromiTunnel.stop().catch(() => {});
    steromiTunnel = null;
  }
  steromiTunnelId = null;
  if (pluginsTunnel) {
    await pluginsTunnel.stop().catch(() => {});
    pluginsTunnel = null;
  }
  pluginsTunnelId = null;
  if (tunnel) {
    await tunnel.stop().catch(() => {});
    tunnel = null;
  }
  activeCoreTransport = null;
  if (status.state !== 'disconnected') logInfo('disconnected');
  setStatus({
    state: 'disconnected',
    detail: '',
    publicUrl: null,
    localUrl: null,
    handshakeAt: null,
    health: null,
    surfaces: describeSurfaces()
  });
}

export function connect(): Promise<void> {
  if (shutdownRequested) return Promise.resolve();
  return enqueueLifecycle(connectImpl);
}

export function disconnect(): Promise<void> {
  return enqueueLifecycle(disconnectImpl);
}

export function shutdownConnection(): Promise<void> {
  shutdownRequested = true;
  connectionGeneration += 1;
  return enqueueLifecycle(() => disconnectImpl(30_000));
}

export function tunnelHealthBase(): string | null {
  return tunnel?.healthBase?.() ?? null;
}

export function isServerRunning(): boolean {
  return endpoint !== null;
}
