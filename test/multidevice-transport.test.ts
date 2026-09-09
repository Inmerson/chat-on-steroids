import net from 'node:net';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createPairingTicket, deviceOverview } from '../src/main/multidevice/registry.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let root = '';

beforeEach(async () => {
  root = await makeTempDir('cos-multidevice-transport-');
  initDurableStore(root);
});

afterEach(async () => {
  resetDurableForTests();
  await removeTempDir(root);
});

async function readLine(socket: net.Socket): Promise<any> {
  return await new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.off('data', onData);
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

describe('2.1.3 coordinator transport compatibility', () => {
  it('pairs, routes one remote request, and resumes with the durable credential', async () => {
    const transportModule = await import('../src/main/multidevice/transport.js').catch(() => ({} as any)) as any;
    expect(typeof transportModule.startCoordinatorTransport).toBe('function');
    expect(typeof transportModule.executeRemote).toBe('function');

    const host = Object.values(os.networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
    if (!host) return;

    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, host, resolve);
    });
    const probeAddress = probe.address();
    if (!probeAddress || typeof probeAddress === 'string') throw new Error('probe address unavailable');
    const port = probeAddress.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const transport = await transportModule.startCoordinatorTransport({ host, port });
    expect(transport?.address()).toEqual({ host, port });
    const ticket = await createPairingTicket();
    const first = net.createConnection({ host, port });
    await new Promise<void>((resolve, reject) => {
      first.once('connect', resolve);
      first.once('error', reject);
    });
    first.write(`${JSON.stringify({ type: 'pair', code: ticket.code, friendly_name: 'Laptop', capabilities: ['filesystem.read'] })}\n`);
    const paired = await readLine(first);
    expect(paired).toMatchObject({ type: 'paired', pairing_id: ticket.pairingId });
    expect(paired.device_id).toMatch(/^dev_[0-9a-f]{32}$/i);
    expect(paired.resume_token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);

    const remoteRequest = new Promise<any>((resolve, reject) => {
      let buffer = '';
      first.on('data', (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          resolve(JSON.parse(buffer.slice(0, newline)));
        } catch (error) {
          reject(error);
        }
      });
    });
    const pending = transportModule.executeRemote(paired.device_id, 'filesystem.read', { path: '/project/file.txt' });
    const request = await remoteRequest;
    expect(request).toMatchObject({ type: 'request', operation: 'filesystem.read', payload: { path: '/project/file.txt' } });
    first.write(`${JSON.stringify({ type: 'response', request_id: request.request_id, ok: true, result: 'hello' })}\n`);
    await expect(pending).resolves.toMatchObject({ request_id: request.request_id, ok: true, result: 'hello' });

    first.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = net.createConnection({ host, port });
    await new Promise<void>((resolve, reject) => {
      second.once('connect', resolve);
      second.once('error', reject);
    });
    second.write(`${JSON.stringify({ type: 'resume', device_id: paired.device_id, resume_token: paired.resume_token })}\n`);
    await expect(readLine(second)).resolves.toEqual({ type: 'resumed', device_id: paired.device_id });

    await transport?.close();
    const overview = await deviceOverview();
    expect(overview.remotes.find((device) => device.deviceId === paired.device_id)?.status).toBe('OFFLINE');
  });
});
