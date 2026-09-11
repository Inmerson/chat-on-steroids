import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadNodeAgentConfig, assertPrivateListenHost } from '../src/node-agent/config.js';
import { executeNodeOperation } from '../src/node-agent/executor.js';
import { startNodeAgentServer } from '../src/node-agent/server.js';

function request(socket: net.Socket, value: unknown): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    socket.once('data', (chunk) => { data += chunk.toString(); resolve(JSON.parse(data.trim())); });
    socket.write(`${JSON.stringify(value)}\n`);
  });
}

describe('Node Agent', () => {
  it('rejects wildcard and loopback listen hosts', () => {
    expect(() => assertPrivateListenHost('0.0.0.0')).toThrow();
    expect(() => assertPrivateListenHost('127.0.0.1')).toThrow();
    expect(() => assertPrivateListenHost('100.64.0.12')).not.toThrow();
  });

  it('pairs once, removes the pairing code, and serves an approved-root read', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cos-agent-'));
    const state = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const configPath = path.join(root, 'node-agent.json');
    await mkdir(workspace); await writeFile(path.join(workspace, 'marker.txt'), 'COS_REMOTE_FILE_OK');
    await writeFile(configPath, JSON.stringify({ coordinator_url: 'ws://100.64.0.1:8788', friendly_name: 'Test Node', state_dir: state, capabilities: ['filesystem.read'], approved_roots: [workspace], pairing_code: 'COS-PAIR-1234', listen_host: '100.64.0.2', listen_port: 8789 }));
    const config = await loadNodeAgentConfig(configPath); const server = await startNodeAgentServer(config, configPath, '127.0.0.1');
    const socket = net.connect(server.address().port, server.address().host);
    const paired = await request(socket, { type: 'pair', code: 'COS-PAIR-1234' });
    expect(paired.type).toBe('paired');
    const read = await request(socket, { type: 'request', token: paired.token, request_id: 'r1', operation: 'filesystem.read', payload: { path: path.join(workspace, 'marker.txt') } });
    expect(read.result.content).toBe('COS_REMOTE_FILE_OK');
    expect(JSON.parse(await readFile(configPath, 'utf8')).pairing_code).toBeUndefined();
    socket.destroy(); await server.close(); await rm(root, { recursive: true, force: true });
  }, 30_000);

  it('continues as an independent local agent without a coordinator', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cos-agent-offline-'));
    const state = path.join(root, 'state'); const workspace = path.join(root, 'workspace'); const configPath = path.join(root, 'node-agent.json');
    await mkdir(workspace); await writeFile(path.join(workspace, 'marker.txt'), 'COS_OFFLINE_FILE_OK');
    await writeFile(configPath, JSON.stringify({ friendly_name: 'Offline Node', state_dir: state, capabilities: ['filesystem.read'], approved_roots: [workspace], listen_host: '100.64.0.2', listen_port: 8790 }));
    const config = await loadNodeAgentConfig(configPath); const server = await startNodeAgentServer(config, configPath, '127.0.0.1');
    const socket = net.connect(server.address().port, server.address().host);
    const authenticated = await request(socket, { type: 'authenticate', token: server.localAccessToken() });
    expect(authenticated.type).toBe('authenticated');
    expect(authenticated.device_id).toBe(server.deviceId());
    const read = await request(socket, { type: 'request', token: authenticated.token, request_id: 'offline-1', operation: 'filesystem.read', payload: { path: path.join(workspace, 'marker.txt') } });
    expect(read.result.content).toBe('COS_OFFLINE_FILE_OK');
    socket.destroy(); await server.close(); await rm(root, { recursive: true, force: true });
  }, 30_000);

  it('bounds remote command output so one noisy command cannot exhaust the agent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cos-agent-output-'));
    const configPath = path.join(root, 'node-agent.json');
    await writeFile(configPath, JSON.stringify({ friendly_name: 'Output Node', state_dir: path.join(root, 'state'), capabilities: ['terminal.exec'], approved_roots: [root], listen_host: '100.64.0.2', listen_port: 8791 }));
    const config = await loadNodeAgentConfig(configPath);

    const result = await executeNodeOperation(config, 'terminal.exec', {
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(1100000))"`,
      cwd: root,
      tty: false
    }) as { stdout: string; stdoutTruncated: boolean };

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1_000_000);
    expect(result.stdoutTruncated).toBe(true);
    await rm(root, { recursive: true, force: true });
  }, 30_000);
});
