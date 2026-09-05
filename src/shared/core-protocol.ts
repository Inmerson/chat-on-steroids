import type { ConnectionStatus } from './types.js';

export const CORE_PROTOCOL_VERSION = 3;

export const CORE_CAPABILITIES = [
  'connection-status',
  'connection-control',
  'settings-apply',
  'execution-probe',
  'structured-health'
] as const;

export type CoreCapability = (typeof CORE_CAPABILITIES)[number];

export interface CoreHello {
  protocolVersion: number;
  coreVersion: string;
  corePid: number;
  generation: number;
  capabilities: CoreCapability[];
}

export interface CoreCompatibilityRequirement {
  protocolVersion: number;
  requiredCapabilities: CoreCapability[];
}

export type CoreStatusProjection = Pick<ConnectionStatus, 'state'> & Partial<Omit<ConnectionStatus, 'state'>>;

export interface CoreStatusEnvelope {
  generation: number;
  status: CoreStatusProjection;
}

export type CoreCommandName = 'hello' | 'status' | 'connect' | 'disconnect' | 'apply-settings' | 'shutdown-core';

export interface CoreRequest {
  id: string;
  token: string;
  command: CoreCommandName;
}

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
