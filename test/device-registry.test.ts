import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  consumePairingTicket,
  createPairingTicket,
  deviceOverview,
  enrollRemoteWithResume,
  revokeRemote,
  resumeRemote
} from '../src/main/multidevice/registry.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let root = '';

beforeEach(async () => {
  root = await makeTempDir('cos-device-registry-');
  initDurableStore(root);
});

afterEach(async () => {
  resetDurableForTests();
  await removeTempDir(root);
});

describe('coordinator device registry', () => {
  it('creates one stable local device identity and no invented remote devices', async () => {
    const first = await deviceOverview();
    const second = await deviceOverview();
    expect(first.local.provider).toBe('local');
    expect(first.local.status).toBe('ONLINE');
    expect(first.remotes).toEqual([]);
    expect(second.local.deviceId).toBe(first.local.deviceId);
  });

  it('consumes an enrollment code once and rejects reuse', async () => {
    const ticket = await createPairingTicket(1_000);
    expect(await consumePairingTicket(ticket.code, 1_001)).toBe(ticket.pairingId);
    expect(await consumePairingTicket(ticket.code, 1_002)).toBeNull();
  });

  it('rejects an expired enrollment code', async () => {
    const ticket = await createPairingTicket(1_000);
    expect(await consumePairingTicket(ticket.code, ticket.expiresAt + 1)).toBeNull();
  });

  it('accepts only the enrolled device resume secret after pairing', async () => {
    const enrollment = await enrollRemoteWithResume('Studio node', ['filesystem.read']);

    await expect(resumeRemote(enrollment.device.deviceId, enrollment.resumeToken)).resolves.toMatchObject({
      deviceId: enrollment.device.deviceId,
      friendlyName: 'Studio node',
      status: 'ONLINE'
    });
    await expect(resumeRemote(enrollment.device.deviceId, 'wrong-resume-secret')).resolves.toBeNull();
    await expect(resumeRemote('dev_unknown', enrollment.resumeToken)).resolves.toBeNull();
  });

  it('revokes a device and permanently rejects its previous resume secret', async () => {
    const enrollment = await enrollRemoteWithResume('Revoked node', ['filesystem.read']);

    await expect(revokeRemote(enrollment.device.deviceId)).resolves.toBe(true);
    await expect(resumeRemote(enrollment.device.deviceId, enrollment.resumeToken)).resolves.toBeNull();
    await expect(deviceOverview()).resolves.toMatchObject({
      remotes: [{ deviceId: enrollment.device.deviceId, status: 'REVOKED' }]
    });
  });
});
