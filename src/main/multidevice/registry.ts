/** Durable coordinator inventory and single-use enrollment tickets. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import type { DeviceOverview, ManagedDeviceSummary } from '../../shared/types.js';
import { readDurable, writeDurableNow } from '../durable.js';

const REGISTRY_STATE = 'device-registry';
const PAIRING_STATE = 'device-pairing';
const REMOTE_RESUME_STATE = 'device-resume-credentials';
const PAIRING_TTL_MS = 10 * 60 * 1000;

interface RegistryState { version: 1; local: ManagedDeviceSummary; remotes: ManagedDeviceSummary[]; }
interface PairingState { version: 1; pairingId: string; codeDigest: string; expiresAt: number; }
interface ResumeCredential { deviceId: string; tokenDigest: string; }
interface ResumeState { version: 1; credentials: ResumeCredential[]; }
export interface PairingTicket { pairingId: string; code: string; expiresAt: number; }
export interface RemoteEnrollment { device: ManagedDeviceSummary; resumeToken: string; }

function digest(code: string): string { return createHash('sha256').update(code, 'utf8').digest('hex'); }
function localSummary(): ManagedDeviceSummary {
  return { deviceId: `dev_${randomUUID().replaceAll('-', '')}`, friendlyName: hostname() || 'This computer', provider: 'local', status: 'ONLINE', capabilities: ['filesystem.read', 'filesystem.write', 'terminal.exec'], lastSeenAt: new Date().toISOString() };
}
function validRegistry(value: unknown): value is RegistryState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<RegistryState>;
  return state.version === 1 && Boolean(state.local) && Array.isArray(state.remotes);
}

/** Returns only enrolled device summaries; no pairing secret is included. */
export async function deviceOverview(): Promise<DeviceOverview> {
  const saved = await readDurable<unknown>(REGISTRY_STATE);
  const state: RegistryState = validRegistry(saved) ? saved : { version: 1, local: localSummary(), remotes: [] };
  if (!validRegistry(saved)) await writeDurableNow(REGISTRY_STATE, state);
  return { local: state.local, remotes: state.remotes };
}

export async function enrollRemote(friendlyName: string, capabilities: string[]): Promise<ManagedDeviceSummary> {
  const saved = await readDurable<unknown>(REGISTRY_STATE);
  const state: RegistryState = validRegistry(saved) ? saved : { version: 1, local: localSummary(), remotes: [] };
  const remote: ManagedDeviceSummary = { deviceId: `dev_${randomUUID().replaceAll('-', '')}`, friendlyName: friendlyName.trim().slice(0, 80) || 'Remote computer', provider: 'remote', status: 'ONLINE', capabilities: [...new Set(capabilities)].slice(0, 16), lastSeenAt: new Date().toISOString() };
  state.remotes = [...state.remotes.filter((entry) => entry.status !== 'REVOKED'), remote];
  await writeDurableNow(REGISTRY_STATE, state);
  return remote;
}

/**
 * Enroll a remote device and issue its one durable reconnect secret. Only a SHA-256 digest is
 * kept by the coordinator, so a durable-state read cannot later impersonate the remote device.
 */
export async function enrollRemoteWithResume(friendlyName: string, capabilities: string[]): Promise<RemoteEnrollment> {
  const device = await enrollRemote(friendlyName, capabilities);
  const resumeToken = randomBytes(32).toString('base64url');
  const saved = await readDurable<ResumeState>(REMOTE_RESUME_STATE);
  const credentials = saved?.version === 1 && Array.isArray(saved.credentials) ? saved.credentials : [];
  await writeDurableNow(REMOTE_RESUME_STATE, {
    version: 1,
    credentials: [...credentials.filter((entry) => entry.deviceId !== device.deviceId), {
      deviceId: device.deviceId,
      tokenDigest: digest(resumeToken)
    }]
  } satisfies ResumeState);
  return { device, resumeToken };
}

/** Validates a reconnect secret and returns only the enrolled device summary. */
export async function resumeRemote(deviceId: string, resumeToken: string): Promise<ManagedDeviceSummary | null> {
  if (!/^dev_[0-9a-f]{32}$/i.test(deviceId) || !/^[A-Za-z0-9_-]{32,128}$/.test(resumeToken)) return null;
  const saved = await readDurable<ResumeState>(REMOTE_RESUME_STATE);
  if (!saved || saved.version !== 1 || !Array.isArray(saved.credentials)) return null;
  const credential = saved.credentials.find((entry) => entry.deviceId === deviceId);
  if (!credential) return null;
  const expected = Buffer.from(credential.tokenDigest, 'hex');
  const actual = Buffer.from(digest(resumeToken), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const overview = await deviceOverview();
  return overview.remotes.find((entry) => entry.deviceId === deviceId && entry.status !== 'REVOKED') ?? null;
}

/** Records connection state without ever reviving a revoked device. */
export async function setRemotePresence(deviceId: string, status: 'ONLINE' | 'OFFLINE'): Promise<void> {
  const saved = await readDurable<unknown>(REGISTRY_STATE);
  if (!validRegistry(saved)) return;
  let changed = false;
  const remotes = saved.remotes.map((entry) => {
    if (entry.deviceId !== deviceId || entry.status === 'REVOKED') return entry;
    changed = true;
    return { ...entry, status, lastSeenAt: new Date().toISOString() };
  });
  if (changed) await writeDurableNow(REGISTRY_STATE, { ...saved, remotes });
}

/** Revokes a remote device, including the only credential that can resume its enrollment. */
export async function revokeRemote(deviceId: string): Promise<boolean> {
  if (!/^dev_[0-9a-f]{32}$/i.test(deviceId)) return false;
  const saved = await readDurable<unknown>(REGISTRY_STATE);
  if (!validRegistry(saved)) return false;
  const exists = saved.remotes.some((entry) => entry.deviceId === deviceId && entry.status !== 'REVOKED');
  if (!exists) return false;
  const remotes = saved.remotes.map((entry) => entry.deviceId === deviceId
    ? { ...entry, status: 'REVOKED' as const, lastSeenAt: new Date().toISOString() }
    : entry);
  await writeDurableNow(REGISTRY_STATE, { ...saved, remotes });

  const resume = await readDurable<ResumeState>(REMOTE_RESUME_STATE);
  const credentials = resume?.version === 1 && Array.isArray(resume.credentials) ? resume.credentials : [];
  await writeDurableNow(REMOTE_RESUME_STATE, {
    version: 1,
    credentials: credentials.filter((entry) => entry.deviceId !== deviceId)
  } satisfies ResumeState);
  return true;
}

/** Creates a single active enrollment ticket. Creating another invalidates the older ticket. */
export async function createPairingTicket(now = Date.now()): Promise<PairingTicket> {
  const code = `COS-${randomBytes(9).toString('base64url').toUpperCase()}`;
  const ticket = { pairingId: `pair_${randomUUID()}`, code, expiresAt: now + PAIRING_TTL_MS };
  await writeDurableNow(PAIRING_STATE, { version: 1, pairingId: ticket.pairingId, codeDigest: digest(code), expiresAt: ticket.expiresAt } satisfies PairingState);
  return ticket;
}

/** Future Node transport seam: consumes a correct ticket once and only before expiry. */
export async function consumePairingTicket(code: string, now = Date.now()): Promise<string | null> {
  const saved = await readDurable<PairingState>(PAIRING_STATE);
  if (!saved || saved.version !== 1 || now > saved.expiresAt) return null;
  const expected = Buffer.from(saved.codeDigest, 'hex');
  const actual = Buffer.from(digest(code), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  await writeDurableNow(PAIRING_STATE, null);
  return saved.pairingId;
}
