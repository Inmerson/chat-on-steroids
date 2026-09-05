import { describe, expect, it } from 'vitest';
import type { CoreHealthStatus } from '../src/shared/core-protocol.js';
import { coreHealthFacts } from '../src/renderer/core-health-widget.js';

function health(overrides: Partial<CoreHealthStatus> = {}): CoreHealthStatus {
  return {
    overall: 'CONNECTED',
    authHealthy: true,
    remoteTransportHealthy: true,
    remoteSubscriptionHealthy: true,
    coreProcessHealthy: true,
    localMcpHealthy: true,
    toolProbeHealthy: true,
    lastToolSuccessAt: 99_000,
    lastRemoteHeartbeatAt: 99_000,
    lastProbeAt: 99_000,
    reconnectAttempt: 0,
    connectionGeneration: 27,
    corePid: 4242,
    recovering: false,
    authRequired: false,
    ...overrides
  };
}

describe('layered Core health UI projection', () => {
  it('shows every execution layer healthy only for a truly CONNECTED snapshot', () => {
    const facts = coreHealthFacts(health(), 100_000);
    expect(facts).toEqual(expect.arrayContaining([
      { label: 'Overall execution', value: 'CONNECTED', bad: false },
      { label: 'Remote Transport', value: 'Connected', bad: false },
      { label: 'Local MCP', value: 'Connected', bad: false },
      { label: 'Tool Execution', value: 'Healthy', bad: false },
      { label: 'Connection generation', value: '27', bad: false }
    ]));
  });

  it('renders remote-live/local-dead as visibly unhealthy instead of Connected', () => {
    const facts = coreHealthFacts(health({ overall: 'DEGRADED', localMcpHealthy: false, toolProbeHealthy: false }));
    expect(facts.find((fact) => fact.label === 'Overall execution')).toEqual({ label: 'Overall execution', value: 'DEGRADED', bad: true });
    expect(facts.find((fact) => fact.label === 'Remote Transport')?.bad).toBe(false);
    expect(facts.find((fact) => fact.label === 'Local MCP')).toEqual({ label: 'Local MCP', value: 'Disconnected', bad: true });
    expect(facts.find((fact) => fact.label === 'Tool Execution')).toEqual({ label: 'Tool Execution', value: 'Unavailable', bad: true });
  });

  it('renders reconnect attempt and auth-required distinctly', () => {
    const reconnecting = coreHealthFacts(health({ overall: 'RECONNECTING', recovering: true, reconnectAttempt: 4 }));
    expect(reconnecting).toContainEqual({ label: 'Recovery attempt', value: '4', bad: false });

    const auth = coreHealthFacts(health({ overall: 'AUTH_REQUIRED', authHealthy: false, authRequired: true }));
    expect(auth).toContainEqual({ label: 'Authentication', value: 'Required', bad: true });
  });
});
