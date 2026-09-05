export type OverallConnectionState = 'CONNECTED' | 'DEGRADED' | 'RECONNECTING' | 'OFFLINE' | 'AUTH_REQUIRED';

export interface CoreHealthSnapshot {
  overall: OverallConnectionState;
  authHealthy: boolean;
  remoteTransportHealthy: boolean;
  remoteSubscriptionHealthy: boolean;
  coreProcessHealthy: boolean;
  localMcpHealthy: boolean;
  toolProbeHealthy: boolean;
  lastToolSuccessAt: number | null;
  lastRemoteHeartbeatAt: number | null;
  lastProbeAt: number | null;
  reconnectAttempt: number;
  connectionGeneration: number;
  corePid: number | null;
  recovering: boolean;
  authRequired: boolean;
}

export type CoreHealthEvent =
  | { type: 'CORE_STARTED'; pid: number }
  | { type: 'CORE_STOPPED' }
  | { type: 'AUTH_VALID' }
  | { type: 'AUTH_REQUIRED' }
  | { type: 'REMOTE_CONNECTED' }
  | { type: 'REMOTE_DISCONNECTED' }
  | { type: 'REMOTE_SUBSCRIBED' }
  | { type: 'REMOTE_UNSUBSCRIBED' }
  | { type: 'REMOTE_RECREATED' }
  | { type: 'REMOTE_HEARTBEAT_OK'; at: number }
  | { type: 'LOCAL_MCP_CONNECTED' }
  | { type: 'LOCAL_MCP_DISCONNECTED' }
  | { type: 'TOOL_PROBE_SUCCEEDED'; at: number }
  | { type: 'TOOL_PROBE_FAILED'; at: number }
  | { type: 'TOOL_SUCCEEDED'; at: number }
  | { type: 'RECOVERY_STARTED'; attempt: number }
  | { type: 'RECOVERY_FINISHED' };

export function initialCoreHealth(): CoreHealthSnapshot {
  return {
    overall: 'OFFLINE',
    authHealthy: false,
    remoteTransportHealthy: false,
    remoteSubscriptionHealthy: false,
    coreProcessHealthy: false,
    localMcpHealthy: false,
    toolProbeHealthy: false,
    lastToolSuccessAt: null,
    lastRemoteHeartbeatAt: null,
    lastProbeAt: null,
    reconnectAttempt: 0,
    connectionGeneration: 0,
    corePid: null,
    recovering: false,
    authRequired: false
  };
}

export function overallConnectionState(state: Omit<CoreHealthSnapshot, 'overall'> | CoreHealthSnapshot): OverallConnectionState {
  if (state.authRequired) return 'AUTH_REQUIRED';
  if (state.recovering) return 'RECONNECTING';

  if (
    state.authHealthy &&
    state.remoteTransportHealthy &&
    state.remoteSubscriptionHealthy &&
    state.coreProcessHealthy &&
    state.localMcpHealthy &&
    state.toolProbeHealthy
  ) {
    return 'CONNECTED';
  }

  // A live Core/transport with a broken execution plane is the false-green state this arbiter
  // exists to prevent. Keep it distinguishable from a fully unreachable connection.
  if (
    state.coreProcessHealthy &&
    (state.remoteTransportHealthy || state.remoteSubscriptionHealthy) &&
    (!state.localMcpHealthy || !state.toolProbeHealthy || !state.remoteSubscriptionHealthy || !state.authHealthy)
  ) {
    return 'DEGRADED';
  }

  return 'OFFLINE';
}

function finalize(next: CoreHealthSnapshot): CoreHealthSnapshot {
  return { ...next, overall: overallConnectionState(next) };
}

export function reduceCoreHealth(current: CoreHealthSnapshot, event: CoreHealthEvent): CoreHealthSnapshot {
  let next: CoreHealthSnapshot = { ...current };

  switch (event.type) {
    case 'CORE_STARTED':
      next.coreProcessHealthy = true;
      next.corePid = event.pid;
      break;
    case 'CORE_STOPPED':
      next.coreProcessHealthy = false;
      next.corePid = null;
      next.localMcpHealthy = false;
      next.toolProbeHealthy = false;
      break;
    case 'AUTH_VALID':
      next.authHealthy = true;
      next.authRequired = false;
      break;
    case 'AUTH_REQUIRED':
      next.authHealthy = false;
      next.authRequired = true;
      next.recovering = false;
      break;
    case 'REMOTE_CONNECTED':
      next.remoteTransportHealthy = true;
      break;
    case 'REMOTE_DISCONNECTED':
      next.remoteTransportHealthy = false;
      next.remoteSubscriptionHealthy = false;
      break;
    case 'REMOTE_SUBSCRIBED':
      next.remoteSubscriptionHealthy = true;
      break;
    case 'REMOTE_UNSUBSCRIBED':
      next.remoteSubscriptionHealthy = false;
      break;
    case 'REMOTE_RECREATED':
      next.connectionGeneration += 1;
      next.remoteTransportHealthy = false;
      next.remoteSubscriptionHealthy = false;
      next.recovering = true;
      break;
    case 'REMOTE_HEARTBEAT_OK':
      next.lastRemoteHeartbeatAt = event.at;
      break;
    case 'LOCAL_MCP_CONNECTED':
      next.localMcpHealthy = true;
      break;
    case 'LOCAL_MCP_DISCONNECTED':
      next.localMcpHealthy = false;
      next.toolProbeHealthy = false;
      break;
    case 'TOOL_PROBE_SUCCEEDED':
      next.toolProbeHealthy = true;
      next.lastProbeAt = event.at;
      break;
    case 'TOOL_PROBE_FAILED':
      next.toolProbeHealthy = false;
      next.lastProbeAt = event.at;
      break;
    case 'TOOL_SUCCEEDED':
      next.lastToolSuccessAt = event.at;
      break;
    case 'RECOVERY_STARTED':
      next.recovering = true;
      next.reconnectAttempt = event.attempt;
      break;
    case 'RECOVERY_FINISHED':
      next.recovering = false;
      if (next.authHealthy && next.remoteTransportHealthy && next.remoteSubscriptionHealthy && next.localMcpHealthy && next.toolProbeHealthy) {
        next.reconnectAttempt = 0;
      }
      break;
  }

  return finalize(next);
}
