/**
 * Owns the lifecycle: local MCP server up, then tunnel(s) up, then connected.
 * Everything the UI shows about connection state comes from here.
 *
 * There is one local server and one or two published connectors. The Core connector is
 * what the app is for and is always published; Desktop is optional, is published only
 * when the user has both granted desktop permissions and configured a way to reach it,
 * and its absence is never allowed to fail the connection — a user who never wants
 * desktop control should not see a broken app because of a connector they did not create.
 */

import type { ConnectionStatus, SurfaceStatus, TunnelSettings } from '../shared/types.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { logError, logInfo, logWarn } from './logger.js';
import { lastRequestAt, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from './mcp/server.js';
import { lastToolCallAt } from './mcp/tools.js';
import { SURFACE_LIST, surfaceIsUseful, type SurfaceId } from './mcp/surfaces.js';
import { getSecret } from './secrets.js';
import { startTunnel, TunnelError, type TunnelHandle } from './tunnel/index.js';

let endpoint: McpEndpoint | null = null;
/** The Core tunnel. Also the only tunnel on the cloudflared and manual paths. */
let tunnel: TunnelHandle | null = null;
/** The Desktop tunnel, on the OpenAI path only, and only when one is configured. */
let desktopTunnel: TunnelHandle | null = null;
/** The tunnel id `desktopTunnel` was started for, so a changed id is detectable. */
let desktopTunnelId: string | null = null;
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
// Connect/disconnect can be triggered by the renderer, tray, auto-connect and app
// shutdown. Serialize those lifecycle transitions so a fast double click or a
// connect racing shutdown cannot stop resources another connect just created.
let lifecycleQueue: Promise<void> = Promise.resolve();
/** Invalidates late async reports from a tunnel that has already been replaced/stopped. */
let connectionGeneration = 0;

function enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
  const run = lifecycleQueue.then(operation, operation);
  lifecycleQueue = run.catch(() => {});
  return run;
}

export function getStatus(): ConnectionStatus {
  // Read live rather than trusting the last stored copy: both clocks are set by
  // incoming requests, which do not go past setStatus, so a stored value would lag
  // behind reality by up to one tunnel report. The surface cards are rebuilt for the
  // same reason — what each connector would advertise follows the permission
  // checkboxes, which change without any connection event to recompute them.
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

/**
 * The setup-facing description of every connector, whether or not it is running.
 *
 * Built even while disconnected, because this is what the setup screen reads: the user
 * needs the exact name and description to paste into ChatGPT *before* anything is live,
 * and asking them to invent either is how a connector ends up named "my pc" — a name the
 * model cannot address and a description it cannot route on.
 */
function describeSurfaces(): SurfaceStatus[] {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
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
      publicUrl: previous?.publicUrl ?? null,
      tools: toolsFor(surface.id),
      state: available ? (previous?.state ?? 'off') : 'off',
      detail: available ? (previous?.detail ?? '') : desktopUnavailableDetail(surface.id),
      // Per connector, because a Core call proves nothing about whether the user ever
      // created the Desktop connector in ChatGPT. Publication is our side of the wire;
      // these two are the only evidence of the other side.
      lastRequestAt: lastRequestAt(surface.id),
      lastToolCallAt: lastToolCallAt(surface.id)
    };
  });
}

function desktopUnavailableDetail(id: SurfaceId): string {
  return id === 'desktop'
    ? 'Turn on "See the screen", "Control mouse and keyboard" or a clipboard permission to use this connector.'
    : '';
}

/** The tools this surface would advertise right now, for the "what you get" list. */
function toolsFor(id: SurfaceId): string[] {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  if (id === 'desktop') {
    const computer = caps.control || caps.clipboardRead || caps.clipboardWrite;
    return [...(caps.screen ? ['observe'] : []), ...(computer ? ['computer'] : [])];
  }
  const tools: string[] = [];
  if (caps.read || caps.browse || caps.metadata) tools.push('read');
  if (caps.read) tools.push('view_image');
  if (!caps.command && caps.search) tools.push('find');
  if (caps.create || caps.edit || caps.move || caps.deleteFile) tools.push('apply_patch');
  if (caps.command) tools.push('exec_command', 'write_stdin');
  if (config.sessions.record) tools.push('session');
  if (config.multiAgent.enabled) tools.push('agents');
  return tools;
}

function updateSurface(id: SurfaceId, next: Partial<SurfaceStatus>): void {
  setStatus({
    surfaces: status.surfaces.map((entry) => (entry.id === id ? { ...entry, ...next } : entry))
  });
}

/**
 * Derives a second surface's public URL from the first one's.
 *
 * Only correct for a transport that publishes a whole origin — cloudflared and a manual
 * reverse proxy — where both surfaces are already reachable at their own paths on the URL
 * the user was given. It is deliberately not used for the OpenAI tunnel, where a tunnel id
 * maps to one local URL and the second surface genuinely needs its own tunnel.
 */
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
  // Offline counts as running: the tunnel is alive and retrying on its own.
  if (
    status.state === 'connected' ||
    status.state === 'offline' ||
    status.state === 'starting-server' ||
    status.state === 'connecting-tunnel'
  ) {
    return;
  }
  await disconnectImpl();
  const generation = ++connectionGeneration;

  const config = getConfig();
  const caps = effectiveCapabilities(config);
  // Connecting with nothing switched on would publish a connector that can do
  // nothing. A folder is the usual answer; desktop access is the other one — and that
  // includes the clipboard, which `surfaceIsUseful` already counts as enough to make the
  // Desktop connector worth publishing. The two gates disagreeing meant a user who
  // granted only the clipboard was told to add a folder for tools that never touch one.
  if (config.roots.length === 0 && !surfaceIsUseful('desktop', caps)) {
    setStatus({ state: 'disconnected', detail: 'Add a folder before connecting.' });
    return;
  }

  try {
    setStatus({ state: 'starting-server', detail: 'Starting the local server…', publicUrl: null });
    endpoint = await startMcpServer(() => {
      const live = getConfig();
      return {
        roots: live.roots,
        caps: effectiveCapabilities(live),
        readOnly: live.readOnly,
        privacyScreenshots: live.ui.privacyScreenshots
      };
    });
    setStatus({ localUrl: endpoint.url, surfaces: describeSurfaces() });
    updateSurface('core', { state: 'starting', detail: 'Connecting…' });

    const apiKey = await getSecret('openaiApiKey');
    tunnel = await startTunnel({
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
          state: report.state === 'connected' ? 'live' : report.state === 'offline' ? 'error' : 'starting',
          detail: report.detail,
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl })
        });
        // On a whole-origin transport the Desktop surface is already published by this
        // same tunnel; it just needs its own path on the URL the user was handed.
        if (config.tunnel.kind !== 'openai' && report.publicUrl !== undefined) {
          const desktop = status.surfaces.find((entry) => entry.id === 'desktop');
          if (desktop?.available) {
            updateSurface('desktop', {
              publicUrl: siblingPublicUrl(report.publicUrl, desktop.localUrl),
              state: report.state === 'connected' ? 'live' : 'starting',
              detail: report.detail
            });
          }
        }
      }
    });

    await startDesktopTunnel(generation, config.tunnel, apiKey);
  } catch (err) {
    const message = err instanceof TunnelError ? err.message : (err as Error).message;
    logError(`connect failed: ${message}`);
    await disconnectImpl();
    setStatus({
      state: err instanceof TunnelError ? 'tunnel-unavailable' : 'disconnected',
      detail: message
    });
  }
}

/**
 * Publishes the Desktop connector on the OpenAI path, when there is one to publish.
 *
 * Every failure here is contained. Desktop is optional, the user may not have created its
 * connector yet, and the coding connector must not go down because a second tunnel id was
 * mistyped — so this reports the problem on the Desktop card and leaves the connection up.
 */
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
    desktopTunnel = await startTunnel({
      localUrl: endpoint.urls.desktop,
      settings: { ...settings, tunnelId: settings.desktopTunnelId },
      apiKey,
      discoveryHeaders: tunnelProbeHeaders(),
      label: 'desktop',
      report: (report) => {
        if (generation !== connectionGeneration) return;
        updateSurface('desktop', {
          state: report.state === 'connected' ? 'live' : report.state === 'offline' ? 'error' : 'starting',
          detail: report.detail,
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl })
        });
      }
    });
  } catch (err) {
    const message = err instanceof TunnelError ? err.message : (err as Error).message;
    logWarn(`desktop connector not published: ${message}`);
    desktopTunnelId = null;
    updateSurface('desktop', { state: 'error', detail: message });
  }
}

/** Stops the Desktop tunnel, if one is running, and says so on its card. */
async function stopDesktopTunnel(detail: string): Promise<void> {
  if (!desktopTunnel) return;
  await desktopTunnel.stop().catch(() => {});
  desktopTunnel = null;
  desktopTunnelId = null;
  logInfo('desktop connector unpublished');
  updateSurface('desktop', { state: 'off', detail, publicUrl: null });
}

/**
 * Re-applies connector settings to a connection that is already up.
 *
 * Only the optional Desktop connector is handled here, and that is the point: enabling a
 * desktop permission or pasting the second tunnel id used to leave the new connector
 * unpublished until the user happened to disconnect and reconnect, with nothing on screen
 * saying so. Core is deliberately not restarted — its tunnel id and method are part of the
 * connection the user is currently relying on, and silently dropping it to pick up an
 * unrelated settings save would be a worse surprise than asking for a reconnect.
 */
async function applySettingsImpl(): Promise<void> {
  if (!endpoint) return;
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  const available = surfaceIsUseful('desktop', caps);
  // Rebuild the cards first: permissions may have changed which tools each surface would
  // advertise, and on a whole-origin transport that is all there is to do.
  setStatus({ surfaces: describeSurfaces() });

  if (config.tunnel.kind !== 'openai') {
    if (available) {
      const desktop = status.surfaces.find((entry) => entry.id === 'desktop');
      updateSurface('desktop', {
        publicUrl: siblingPublicUrl(status.publicUrl, desktop?.localUrl ?? null),
        state: status.state === 'connected' ? 'live' : 'starting',
        detail: status.detail
      });
    }
    return;
  }

  if (!available) {
    await stopDesktopTunnel('Turn a desktop permission back on to publish this connector.');
    return;
  }
  if (desktopTunnel && desktopTunnelId === config.tunnel.desktopTunnelId) return;
  await stopDesktopTunnel('Reconnecting with the new tunnel…');
  await startDesktopTunnel(connectionGeneration, config.tunnel, await getSecret('openaiApiKey'));
}

/** Applies a settings change to a live connection. Safe to call while disconnected. */
export function applySettings(): Promise<void> {
  return enqueueLifecycle(applySettingsImpl);
}

async function disconnectImpl(): Promise<void> {
  // Invalidate callbacks first; stopping a child can itself cause exit/health events.
  connectionGeneration += 1;
  // Stop local admission first and let accepted MCP calls finish recording before any
  // command process or durable writer is retired by the app-wide shutdown sequence.
  // The public tunnel may briefly see the now-closed loopback endpoint, which is preferable
  // to accepting a mutation after shutdown has already begun.
  if (endpoint) {
    const stopping = endpoint;
    endpoint = null;
    await stopping.stop().catch(() => {});
  }
  if (desktopTunnel) {
    await desktopTunnel.stop().catch(() => {});
    desktopTunnel = null;
  }
  desktopTunnelId = null;
  if (tunnel) {
    await tunnel.stop().catch(() => {});
    tunnel = null;
  }
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
  return enqueueLifecycle(connectImpl);
}

export function disconnect(): Promise<void> {
  return enqueueLifecycle(disconnectImpl);
}

/** The running tunnel's own local health address, for the self-test. Null if none. */
export function tunnelHealthBase(): string | null {
  return tunnel?.healthBase?.() ?? null;
}

/** True while the local server is listening, regardless of tunnel state. */
export function isServerRunning(): boolean {
  return endpoint !== null;
}
