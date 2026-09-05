import type { ConnectionStatus } from './types.js';

// v6 adds the fixed config-authority UI operations. A v5 Core must be replaced rather than
// silently accepted by a v6 UI, because otherwise the UI would fall back to a second config writer.
export const CORE_PROTOCOL_VERSION = 6;

export const CORE_CAPABILITIES = [
  'connection-status',
  'connection-control',
  'settings-apply',
  'execution-probe',
  'structured-health',
  'secret-storage',
  'ui-runtime',
  'config-authority'
] as const;

export type CoreCapability = (typeof CORE_CAPABILITIES)[number];
export type CoreOverallState = 'CONNECTED' | 'DEGRADED' | 'RECONNECTING' | 'OFFLINE' | 'AUTH_REQUIRED';
export type CoreSecretKey = 'openaiApiKey' | 'openRouterApiKey';

export interface CoreSecretStatus {
  hasApiKey: boolean;
  hasGoalKey: boolean;
}

export interface CoreHealthStatus {
  overall: CoreOverallState;
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

export interface CoreHello {
  protocolVersion: number;
  coreVersion: string;
  corePid: number;
  generation: number;
  capabilities: readonly CoreCapability[];
}

export interface CoreCompatibilityRequirement {
  protocolVersion: number;
  requiredCapabilities: readonly CoreCapability[];
}

export type CoreStatusProjection = Pick<ConnectionStatus, 'state'> & Partial<Omit<ConnectionStatus, 'state'>>;

export interface CoreStatusEnvelope {
  generation: number;
  status: CoreStatusProjection;
  health?: CoreHealthStatus;
  bridgeRevision?: number;
  sessionRevision?: number;
  swarmRevision?: number;
}

/** Fixed UI operations whose authoritative state lives in the persistent Core Host. */
export type CoreUiOperation =
  | 'config-get'
  | 'settings-save'
  | 'root-add-path'
  | 'roots-all-computer-toggle'
  | 'root-remove'
  | 'root-rename'
  | 'tunnel-binary-path'
  | 'bridge-status'
  | 'bridge-unpair'
  | 'session-list'
  | 'session-events'
  | 'session-delete'
  | 'handoff-get'
  | 'swarm-get'
  | 'swarm-reset'
  | 'swarm-clear-agent'
  | 'control-center-status'
  | 'goal-models'
  | 'diagnostics-run';

export type CoreCommandName =
  | 'hello'
  | 'status'
  | 'connect'
  | 'disconnect'
  | 'apply-settings'
  | 'secret-status'
  | 'set-secret'
  | 'ui-call'
  | 'shutdown-core';

interface CoreRequestBase {
  id: string;
  token: string;
}

export type CoreRequest =
  | (CoreRequestBase & { command: Exclude<CoreCommandName, 'set-secret' | 'ui-call'> })
  | (CoreRequestBase & { command: 'set-secret'; key: CoreSecretKey; value: string })
  | (CoreRequestBase & { command: 'ui-call'; operation: CoreUiOperation; payload: unknown });

export interface CoreResponse<T = unknown> {
  id: string;
  ok: boolean;
  data?: T;
  error?: string;
}

export function isCoreCompatible(requirement: CoreCompatibilityRequirement, peer: CoreHello): boolean {
  if (peer.protocolVersion !== requirement.protocolVersion) return false;
  const offered = new Set(peer.capabilities);
  return requirement.requiredCapabilities.every((capability) => offered.has(capability));
}
