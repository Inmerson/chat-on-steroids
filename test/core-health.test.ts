import { describe, expect, it } from 'vitest';
import {
  initialCoreHealth,
  reduceCoreHealth,
  type CoreHealthSnapshot
} from '../src/main/core/health.js';
import { toolRetryPolicy } from '../src/main/core/retry.js';

function healthy(): CoreHealthSnapshot {
  let state = initialCoreHealth();
  for (const event of [
    { type: 'CORE_STARTED', pid: 4242 } as const,
    { type: 'AUTH_VALID' } as const,
    { type: 'REMOTE_CONNECTED' } as const,
    { type: 'REMOTE_SUBSCRIBED' } as const,
    { type: 'LOCAL_MCP_CONNECTED' } as const,
    { type: 'TOOL_PROBE_SUCCEEDED', at: 100 } as const
  ]) {
    state = reduceCoreHealth(state, event);
  }
  return state;
}

describe('Core connection health arbiter', () => {
  it('does not report CONNECTED when the remote transport is healthy but local MCP is dead', () => {
    const state = reduceCoreHealth(healthy(), { type: 'LOCAL_MCP_DISCONNECTED' });

    expect(state.remoteTransportHealthy).toBe(true);
    expect(state.remoteSubscriptionHealthy).toBe(true);
    expect(state.localMcpHealthy).toBe(false);
    expect(state.overall).not.toBe('CONNECTED');
    expect(state.overall).toBe('DEGRADED');
  });

  it('treats a failed real tool-plane probe as DEGRADED even when transport remains healthy', () => {
    const state = reduceCoreHealth(healthy(), { type: 'TOOL_PROBE_FAILED', at: 150 });

    expect(state.remoteTransportHealthy).toBe(true);
    expect(state.toolProbeHealthy).toBe(false);
    expect(state.overall).toBe('DEGRADED');
  });

  it('enters RECONNECTING while recovery is in flight and returns to CONNECTED only after every plane is healthy', () => {
    let state = reduceCoreHealth(healthy(), { type: 'LOCAL_MCP_DISCONNECTED' });
    state = reduceCoreHealth(state, { type: 'RECOVERY_STARTED', attempt: 2 });
    expect(state.overall).toBe('RECONNECTING');
    expect(state.reconnectAttempt).toBe(2);

    state = reduceCoreHealth(state, { type: 'LOCAL_MCP_CONNECTED' });
    state = reduceCoreHealth(state, { type: 'TOOL_PROBE_SUCCEEDED', at: 200 });
    state = reduceCoreHealth(state, { type: 'RECOVERY_FINISHED' });
    expect(state.overall).toBe('CONNECTED');
  });

  it('gives AUTH_REQUIRED precedence over reconnect churn', () => {
    let state = reduceCoreHealth(healthy(), { type: 'RECOVERY_STARTED', attempt: 7 });
    state = reduceCoreHealth(state, { type: 'AUTH_REQUIRED' });

    expect(state.authHealthy).toBe(false);
    expect(state.overall).toBe('AUTH_REQUIRED');
  });

  it('increments generation on a real remote recreation and invalidates transport readiness', () => {
    const before = healthy();
    const after = reduceCoreHealth(before, { type: 'REMOTE_RECREATED' });

    expect(after.connectionGeneration).toBe(before.connectionGeneration + 1);
    expect(after.remoteTransportHealthy).toBe(false);
    expect(after.remoteSubscriptionHealthy).toBe(false);
    expect(after.overall).toBe('RECONNECTING');
  });

  it('tracks successful calls and remote heartbeat proof independently', () => {
    let state = healthy();
    state = reduceCoreHealth(state, { type: 'REMOTE_HEARTBEAT_OK', at: 900 });
    state = reduceCoreHealth(state, { type: 'TOOL_SUCCEEDED', at: 950 });

    expect(state.lastRemoteHeartbeatAt).toBe(900);
    expect(state.lastToolSuccessAt).toBe(950);
    expect(state.overall).toBe('CONNECTED');
  });
});

describe('tool retry policy', () => {
  it('allows at most one retry for explicitly read-only operations', () => {
    expect(toolRetryPolicy({ toolName: 'read' })).toBe('one-safe-retry');
    expect(toolRetryPolicy({ toolName: 'view_image' })).toBe('one-safe-retry');
    expect(toolRetryPolicy({ toolName: 'find' })).toBe('one-safe-retry');
    expect(toolRetryPolicy({ toolName: 'session', operation: 'read' })).toBe('one-safe-retry');
    expect(toolRetryPolicy({ toolName: 'session', operation: 'search' })).toBe('one-safe-retry');
    expect(toolRetryPolicy({ toolName: 'observe' })).toBe('one-safe-retry');
  });

  it('never blindly retries mutation-capable or execution operations', () => {
    expect(toolRetryPolicy({ toolName: 'apply_patch' })).toBe('never');
    expect(toolRetryPolicy({ toolName: 'exec_command' })).toBe('never');
    expect(toolRetryPolicy({ toolName: 'write_stdin' })).toBe('never');
    expect(toolRetryPolicy({ toolName: 'computer' })).toBe('never');
    expect(toolRetryPolicy({ toolName: 'agents' })).toBe('never');
    expect(toolRetryPolicy({ toolName: 'session', operation: 'execution_start' })).toBe('never');
  });
});
