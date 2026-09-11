import { createConnection, createServer, type Socket } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NodeAgentConfig } from './config.js';
import { assertPrivateListenHost } from './config.js';
import { executeNodeOperation } from './executor.js';
import { MultiDeviceError } from '../shared/multidevice/errors.js';

type AgentMessage =
  | { type: 'pair'; code: string }
  | { type: 'authenticate'; token: string }
  | { type: 'request'; token: string; request_id: string; operation: string; payload: unknown };

interface AgentIdentity {
  version: 1;
  deviceId: string;
  /** Stored locally in the agent state directory, never in the coordinator registry or config. */
  localAccessToken: string;
  /** Issued once by the coordinator after pairing; the coordinator stores only its digest. */
  coordinatorResumeToken?: string;
}

export interface NodeAgentServer {
  close(): Promise<void>;
  address(): { host: string; port: number };
  /** Intended for a local launcher/installer integration, never sent to a coordinator. */
  localAccessToken(): string;
  deviceId(): string;
}

function identityPath(config: NodeAgentConfig): string { return path.join(config.state_dir, 'identity.json'); }

async function getOrCreateIdentity(config: NodeAgentConfig): Promise<AgentIdentity> {
  const file = identityPath(config);
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<AgentIdentity>;
    if (
      saved.version === 1 &&
      typeof saved.deviceId === 'string' &&
      typeof saved.localAccessToken === 'string' &&
      (saved.coordinatorResumeToken === undefined || typeof saved.coordinatorResumeToken === 'string')
    ) {
      return saved as AgentIdentity;
    }
  } catch { /* first run creates the local-only identity below */ }
  const identity: AgentIdentity = {
    version: 1,
    deviceId: `node_${randomUUID().replaceAll('-', '')}`,
    localAccessToken: randomBytes(32).toString('base64url')
  };
  await fs.writeFile(file, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 });
  return identity;
}

async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}

async function persistIdentity(config: NodeAgentConfig, identity: AgentIdentity): Promise<void> {
  await writeJsonAtomically(identityPath(config), identity);
}

async function consumePairingCode(config: NodeAgentConfig, supplied: string): Promise<boolean> {
  if (!config.pairing_code || supplied !== config.pairing_code) return false;
  const raw = JSON.parse(await fs.readFile((config as any).__configPath, 'utf8')) as Record<string, unknown>;
  delete raw.pairing_code;
  await writeJsonAtomically((config as any).__configPath, raw);
  return true;
}

function send(socket: Socket, value: unknown): void { socket.write(`${JSON.stringify(value)}\n`); }

export async function startNodeAgentServer(config: NodeAgentConfig, configPath: string, listenHost = config.listen_host): Promise<NodeAgentServer> {
  assertPrivateListenHost(config.listen_host);
  (config as any).__configPath = path.resolve(configPath);
  await fs.mkdir(config.state_dir, { recursive: true });
  const identity = await getOrCreateIdentity(config);
  const server = createServer((socket) => {
    let buffer = '';
    let token: string | null = null;
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); index = buffer.indexOf('\n');
        try {
          const message = JSON.parse(line) as AgentMessage;
          if (message.type === 'pair') {
            if (token || !(await consumePairingCode(config, message.code))) throw new MultiDeviceError('PAIRING_INVALID', 'pairing code is invalid or already consumed');
            token = randomUUID();
            send(socket, { type: 'paired', token, device_id: identity.deviceId, friendly_name: config.friendly_name, capabilities: config.capabilities });
          } else if (message.type === 'authenticate') {
            if (token || message.token !== identity.localAccessToken) throw new MultiDeviceError('AUTHENTICATION_FAILED', 'agent session is not authenticated');
            token = randomUUID();
            send(socket, { type: 'authenticated', token, device_id: identity.deviceId, friendly_name: config.friendly_name, capabilities: config.capabilities });
          } else {
            if (!token || message.token !== token) throw new MultiDeviceError('AUTHENTICATION_FAILED', 'agent session is not authenticated');
            const result = await executeNodeOperation(config, message.operation, message.payload);
            send(socket, { request_id: message.request_id, ok: true, result, error: null });
          }
        } catch (error) {
          const code = error instanceof MultiDeviceError ? error.code : 'INVALID_REQUEST';
          send(socket, { ok: false, result: null, error: { code, message: error instanceof Error ? error.message : 'request failed' } });
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.listen_port, listenHost, resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Node Agent did not expose a TCP address');
  let coordinatorSocket: Socket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const scheduleReconnect = (): void => {
    if (closed || !config.coordinator_url || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectCoordinator();
    }, 3_000);
    reconnectTimer.unref?.();
  };

  const connectCoordinator = (): void => {
    if (closed || !config.coordinator_url || coordinatorSocket) return;
    const coordinator = new URL(config.coordinator_url);
    const socket = createConnection(Number(coordinator.port || 80), coordinator.hostname);
    coordinatorSocket = socket;
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      if (config.pairing_code) {
        send(socket, { type: 'pair', code: config.pairing_code, friendly_name: config.friendly_name, capabilities: config.capabilities, listen_host: listenHost, listen_port: address.port });
      } else if (identity.coordinatorResumeToken && identity.deviceId.startsWith('dev_')) {
        send(socket, { type: 'resume', device_id: identity.deviceId, resume_token: identity.coordinatorResumeToken });
      } else {
        socket.destroy();
      }
    });
    let coordinatorBuffer = '';
    socket.on('data', async (chunk) => {
      coordinatorBuffer += chunk;
      let newline = coordinatorBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = coordinatorBuffer.slice(0, newline);
        coordinatorBuffer = coordinatorBuffer.slice(newline + 1);
        newline = coordinatorBuffer.indexOf('\n');
        try {
          const message = JSON.parse(line) as {
            type?: string;
            device_id?: string;
            resume_token?: string;
            request_id?: string;
            operation?: string;
            payload?: unknown;
          };
          if (message.type === 'paired' && message.device_id && message.resume_token) {
            identity.deviceId = message.device_id;
            identity.coordinatorResumeToken = message.resume_token;
            await persistIdentity(config, identity);
            const raw = JSON.parse(await fs.readFile((config as any).__configPath, 'utf8')) as Record<string, unknown>;
            delete raw.pairing_code;
            await writeJsonAtomically((config as any).__configPath, raw);
            continue;
          }
          if (message.type === 'request' && message.request_id && message.operation) {
            try { send(socket, { request_id: message.request_id, ok: true, result: await executeNodeOperation(config, message.operation, message.payload) }); }
            catch (error) { send(socket, { request_id: message.request_id, ok: false, error: { code: error instanceof MultiDeviceError ? error.code : 'REMOTE_EXECUTION_FAILED', message: error instanceof Error ? error.message : 'request failed' } }); }
          }
        } catch { /* malformed coordinator data is ignored and never changes local identity */ }
      }
    });
    const disconnected = (): void => {
      if (coordinatorSocket === socket) coordinatorSocket = null;
      scheduleReconnect();
    };
    socket.once('error', () => undefined);
    socket.once('close', disconnected);
  };

  if (config.coordinator_url && (config.pairing_code || identity.coordinatorResumeToken)) connectCoordinator();
  return {
    address: () => ({ host: listenHost, port: address.port }),
    localAccessToken: () => identity.localAccessToken,
    deviceId: () => identity.deviceId,
    close: async () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const activeCoordinator = coordinatorSocket;
      coordinatorSocket = null;
      if (activeCoordinator && !activeCoordinator.destroyed) {
        await new Promise<void>((resolve) => {
          activeCoordinator.once('close', () => resolve());
          activeCoordinator.destroy();
        });
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
