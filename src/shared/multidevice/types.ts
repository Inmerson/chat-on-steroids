export type DeviceId = string;

export type DeviceCapability =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'terminal.exec';

export type DeviceStatus =
  | 'UNENROLLED'
  | 'CONNECTING'
  | 'ONLINE'
  | 'DEGRADED'
  | 'OFFLINE'
  | 'REVOKED';

export type ProtocolOperation =
  | 'filesystem.read'
  | 'filesystem.apply_patch'
  | 'terminal.exec';

export interface DeviceRecordPublic {
  deviceId: string;
  friendlyName: string;
  provider: 'local' | 'remote';
  os: 'windows';
  agentVersion: string | null;
  protocolVersions: number[];
  capabilities: DeviceCapability[];
  authorizedRoots: string[];
  status: DeviceStatus;
  publicKeyFingerprint: string | null;
  lastSeenAt: string | null;
  enrolledAt: string;
  revokedAt: string | null;
}
