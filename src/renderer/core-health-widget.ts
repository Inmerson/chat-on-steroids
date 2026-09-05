import type { AppApi } from '../preload/index.js';
import type { CoreHealthStatus } from '../shared/core-protocol.js';

declare global {
  interface Window {
    api: AppApi;
  }
}

function age(at: number | null): string {
  if (at === null) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function fact(label: string, value: string, bad = false): HTMLElement {
  const row = document.createElement('div');
  row.className = 'fact core-health-fact';
  const name = document.createElement('span');
  name.textContent = label;
  const code = document.createElement('code');
  if (bad) code.className = 'is-bad';
  code.textContent = value;
  code.title = value;
  row.append(name, code);
  return row;
}

export function coreHealthRows(health: CoreHealthStatus): HTMLElement[] {
  return [
    fact('Overall execution', health.overall, health.overall !== 'CONNECTED'),
    fact('Core Host', health.coreProcessHealthy ? `Healthy · PID ${health.corePid ?? '—'}` : 'Unavailable', !health.coreProcessHealthy),
    fact('Remote Transport', health.remoteTransportHealthy && health.remoteSubscriptionHealthy ? 'Connected' : 'Unavailable', !health.remoteTransportHealthy || !health.remoteSubscriptionHealthy),
    fact('Authentication', health.authHealthy ? 'Valid' : health.authRequired ? 'Required' : 'Unavailable', !health.authHealthy),
    fact('Local MCP', health.localMcpHealthy ? 'Connected' : 'Disconnected', !health.localMcpHealthy),
    fact('Tool Execution', health.toolProbeHealthy ? 'Healthy' : 'Unavailable', !health.toolProbeHealthy),
    fact('Last successful call', age(health.lastToolSuccessAt), health.lastToolSuccessAt === null),
    fact('Connection generation', String(health.connectionGeneration)),
    ...(health.recovering ? [fact('Recovery attempt', String(health.reconnectAttempt), false)] : [])
  ];
}

async function paint(): Promise<void> {
  const container = document.getElementById('facts');
  if (!container) return;
  const reply = await window.api.getCoreHealth();
  for (const node of container.querySelectorAll('.core-health-fact')) node.remove();
  if (!reply.ok || !reply.data) return;
  container.prepend(...coreHealthRows(reply.data));
}

window.api.onStateChanged(() => void paint());
void paint();
setTimeout(() => void paint(), 400);
