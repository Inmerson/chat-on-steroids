/**
 * Owns the lifecycle: local MCP server up, then tunnel up, then connected.
 * Everything the UI shows about connection state comes from here.
 */

import type { ConnectionStatus } from '../shared/types.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { logError, logInfo } from './logger.js';
import { lastRequestAt, startMcpServer, tunnelProbeHeaders, type McpEndpoint } from './mcp/server.js';
import { lastToolCallAt } from './mcp/tools.js';
import { getSecret } from './secrets.js';
import { startTunnel, TunnelError, type TunnelHandle } from './tunnel/index.js';

let endpoint: McpEndpoint | null = null;
let tunnel: TunnelHandle | null = null;
let status: ConnectionStatus = {
  state: 'disconnected',
  detail: '',
  publicUrl: null,
  localUrl: null,
  handshakeAt: null,
  lastRequestAt: null,
  lastToolCallAt: null,
  health: null
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
  // behind reality by up to one tunnel report.
  return { ...status, lastRequestAt: lastRequestAt(), lastToolCallAt: lastToolCallAt() };
}

export function onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(next: Partial<ConnectionStatus>): void {
  status = { ...status, ...next };
  for (const listener of listeners) listener(status);
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
  // nothing. A folder is the usual answer; desktop access is the other one.
  if (config.roots.length === 0 && !caps.screen && !caps.control) {
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
    setStatus({ localUrl: endpoint.url });

    const apiKey = await getSecret('openaiApiKey');
    tunnel = await startTunnel({
      localUrl: endpoint.url,
      settings: config.tunnel,
      apiKey,
      discoveryHeaders: tunnelProbeHeaders(),
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
      }
    });
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

async function disconnectImpl(): Promise<void> {
  // Invalidate callbacks first; stopping a child can itself cause exit/health events.
  connectionGeneration += 1;
  if (tunnel) {
    await tunnel.stop().catch(() => {});
    tunnel = null;
  }
  if (endpoint) {
    await endpoint.stop().catch(() => {});
    endpoint = null;
  }
  if (status.state !== 'disconnected') logInfo('disconnected');
  setStatus({
    state: 'disconnected',
    detail: '',
    publicUrl: null,
    localUrl: null,
    handshakeAt: null,
    health: null
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
