import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { MultiDeviceError } from '../../shared/multidevice/errors.js';
import { consumePairingTicket, enrollRemoteWithResume, resumeRemote, setRemotePresence } from './registry.js';

export interface CoordinatorTransport { close(): Promise<void>; address(): { host: string; port: number }; }
const connections = new Map<string, Socket>();
const pending = new Map<string, (value: unknown) => void>();
function send(socket: Socket, value: unknown): void { socket.write(`${JSON.stringify(value)}\n`); }

export async function startCoordinatorTransport(options?: { host: string; port: number }): Promise<CoordinatorTransport | null> {
  const host = options?.host.trim() || process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_HOST?.trim();
  const portText = options ? String(options.port) : process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_PORT?.trim();
  if (!host && !portText) return null;
  if (!host || !portText) throw new Error('Coordinator transport requires both listen host and port');
  if (host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === 'localhost') throw new Error('Coordinator transport refuses wildcard or loopback hosts');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Coordinator transport port must be 1024-65535');
  const server = createServer((socket) => {
    let buffer = ''; let paired = false; socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk; let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf('\n');
        try {
          const message = JSON.parse(line) as {
            type?: string;
            code?: string;
            device_id?: string;
            resume_token?: string;
            friendly_name?: string;
            capabilities?: string[];
          };
          if (paired && typeof (message as any).request_id === 'string') { pending.get((message as any).request_id)?.(message); pending.delete((message as any).request_id); continue; }
          if (paired) throw new MultiDeviceError('INVALID_REQUEST', 'connection is already authenticated');
          if (message.type === 'pair' && typeof message.code === 'string') {
            const pairingId = await consumePairingTicket(message.code);
            if (!pairingId) throw new MultiDeviceError('PAIRING_INVALID', 'pairing code is invalid or expired');
            const enrollment = await enrollRemoteWithResume(
              typeof message.friendly_name === 'string' ? message.friendly_name : 'Remote computer',
              Array.isArray(message.capabilities) ? message.capabilities : []
            );
            paired = true;
            connections.set(enrollment.device.deviceId, socket);
            await setRemotePresence(enrollment.device.deviceId, 'ONLINE');
            send(socket, {
              type: 'paired',
              pairing_id: pairingId,
              device_id: enrollment.device.deviceId,
              resume_token: enrollment.resumeToken
            });
            continue;
          }
          if (message.type === 'resume' && typeof message.device_id === 'string' && typeof message.resume_token === 'string') {
            const device = await resumeRemote(message.device_id, message.resume_token);
            if (!device) throw new MultiDeviceError('AUTHENTICATION_FAILED', 'device resume credentials are invalid');
            paired = true;
            connections.set(device.deviceId, socket);
            await setRemotePresence(device.deviceId, 'ONLINE');
            send(socket, { type: 'resumed', device_id: device.deviceId });
            continue;
          }
          throw new MultiDeviceError('INVALID_REQUEST', 'expected pairing or authenticated resume message');
        } catch (error) { send(socket, { type: 'error', error: { code: error instanceof MultiDeviceError ? error.code : 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'request failed' } }); }
      }
    });
    socket.once('close', () => {
      for (const [deviceId, active] of connections) {
        if (active !== socket) continue;
        connections.delete(deviceId);
        void setRemotePresence(deviceId, 'OFFLINE');
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Coordinator transport did not expose an address');
  return { address: () => ({ host, port: address.port }), close: () => new Promise((resolve) => { for (const socket of connections.values()) socket.destroy(); connections.clear(); server.close(() => resolve()); }) };
}

export async function executeRemote(deviceId: string, operation: string, payload: unknown): Promise<any> {
  const socket = connections.get(deviceId);
  if (!socket || socket.destroyed) throw new MultiDeviceError('DEVICE_OFFLINE', 'remote device is not connected');
  const requestId = randomUUID();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new MultiDeviceError('REQUEST_TIMEOUT', 'remote request timed out')); }, 30_000);
    pending.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
    socket.write(`${JSON.stringify({ type: 'request', request_id: requestId, operation, payload })}\n`);
  });
}

/** Stops the active socket after its registry credential has been revoked. */
export function disconnectRemote(deviceId: string): void {
  connections.get(deviceId)?.destroy();
}
