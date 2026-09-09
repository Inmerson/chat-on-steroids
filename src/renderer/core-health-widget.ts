import type { CoreHealthStatus } from '../shared/core-protocol.js';

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
