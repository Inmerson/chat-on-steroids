import type { AppApi } from '../preload/index.js';
import type { CoreHealthStatus } from '../shared/core-protocol.js';

declare global {
  interface Window {
    api: AppApi;
  }
}

export interface CoreHealthFact {
  label: string;
  value: string;
  bad: boolean;
}

function age(at: number | null, now = Date.now()): string {
  if (at === null) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/** Pure UI projection so false-green rendering is regression-testable without a DOM. */
export function coreHealthFacts(health: CoreHealthStatus, now = Date.now()): CoreHealthFact[] {
  return [
    { label: 'Overall execution', value: health.overall, bad: health.overall !== 'CONNECTED' },
    {
      label: 'Core Host',
      value: health.coreProcessHealthy ? `Healthy · PID ${health.corePid ?? '—'}` : 'Unavailable',
      bad: !health.coreProcessHealthy
    },
    {
      label: 'Remote Transport',
      value: health.remoteTransportHealthy && health.remoteSubscriptionHealthy ? 'Connected' : 'Unavailable',
      bad: !health.remoteTransportHealthy || !health.remoteSubscriptionHealthy
    },
    {
      label: 'Authentication',
      value: health.authHealthy ? 'Valid' : health.authRequired ? 'Required' : 'Unavailable',
      bad: !health.authHealthy
    },
    { label: 'Local MCP', value: health.localMcpHealthy ? 'Connected' : 'Disconnected', bad: !health.localMcpHealthy },
    { label: 'Tool Execution', value: health.toolProbeHealthy ? 'Healthy' : 'Unavailable', bad: !health.toolProbeHealthy },
    { label: 'Last successful call', value: age(health.lastToolSuccessAt, now), bad: health.lastToolSuccessAt === null },
    { label: 'Connection generation', value: String(health.connectionGeneration), bad: false },
    ...(health.recovering
      ? [{ label: 'Recovery attempt', value: String(health.reconnectAttempt), bad: false }]
      : [])
  ];
}

function factNode(fact: CoreHealthFact): HTMLElement {
  const row = document.createElement('div');
  row.className = 'fact core-health-fact';
  const name = document.createElement('span');
  name.textContent = fact.label;
  const code = document.createElement('code');
  if (fact.bad) code.className = 'is-bad';
  code.textContent = fact.value;
  code.title = fact.value;
  row.append(name, code);
  return row;
}

async function paint(): Promise<void> {
  const api = window.api;
  if (!api || typeof api.getCoreHealth !== 'function') return;
  const container = document.getElementById('facts');
  if (!container) return;
  const reply = await api.getCoreHealth();
  for (const node of container.querySelectorAll('.core-health-fact')) node.remove();
  if (!reply.ok || !reply.data) return;
  container.prepend(...coreHealthFacts(reply.data).map(factNode));
}

if (window.api && typeof window.api.getCoreHealth === 'function') {
  window.api.onStateChanged(() => void paint());
  void paint();
  setTimeout(() => void paint(), 400);
}
