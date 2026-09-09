import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { consumePairingTicket, createPairingTicket, deviceOverview } from '../src/main/multidevice/registry.js';
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

  it('preserves 2.1.3 resume credentials and revocation semantics', async () => {
    const registry = await import('../src/main/multidevice/registry.js') as any;
    expect(typeof registry.enrollRemoteWithResume).toBe('function');
    expect(typeof registry.resumeRemote).toBe('function');
    expect(typeof registry.revokeRemote).toBe('function');

    const enrollment = await registry.enrollRemoteWithResume('Laptop', ['filesystem.read', 'terminal.exec']);
    expect(enrollment.device).toMatchObject({ friendlyName: 'Laptop', provider: 'remote', status: 'ONLINE' });
    expect(enrollment.resumeToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    await expect(registry.resumeRemote(enrollment.device.deviceId, enrollment.resumeToken)).resolves.toMatchObject({
      deviceId: enrollment.device.deviceId,
      status: 'ONLINE'
    });

    await expect(registry.revokeRemote(enrollment.device.deviceId)).resolves.toBe(true);
    await expect(registry.resumeRemote(enrollment.device.deviceId, enrollment.resumeToken)).resolves.toBeNull();
    expect((await deviceOverview()).remotes.find((device) => device.deviceId === enrollment.device.deviceId)?.status).toBe('REVOKED');
  });
});
