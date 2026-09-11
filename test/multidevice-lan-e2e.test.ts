import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createPairingTicket, deviceOverview } from '../src/main/multidevice/registry.js';
import { executeRemote, startCoordinatorTransport } from '../src/main/multidevice/transport.js';
import { loadNodeAgentConfig } from '../src/node-agent/config.js';
import { startNodeAgentServer } from '../src/node-agent/server.js';

function privateLanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)) return entry.address;
    }
  }
  return null;
}

const lan = privateLanAddress();

describe.skipIf(lan === null)('multi-device LAN transport', () => {
  it('pairs an agent once and routes read, patch, and command over a real private-network socket', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cos-lan-e2e-'));
    const workspace = path.join(root, 'workspace'); const state = path.join(root, 'state'); const configPath = path.join(root, 'node-agent.json');
    const previousHost = process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_HOST;
    const previousPort = process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_PORT;
    const port = 18988;
    try {
      await mkdir(workspace); await writeFile(path.join(workspace, 'marker.txt'), 'COS_REMOTE_FILE_OK');
      initDurableStore(state);
      const ticket = await createPairingTicket();
      process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_HOST = lan!;
      process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_PORT = String(port);
      const coordinator = await startCoordinatorTransport();
      expect(coordinator).not.toBeNull();
      await writeFile(configPath, JSON.stringify({ coordinator_url: `ws://${lan}:${port}`, friendly_name: 'LAN Node', state_dir: path.join(root, 'agent-state'), capabilities: ['filesystem.read', 'filesystem.write', 'terminal.exec'], approved_roots: [workspace], pairing_code: ticket.code, listen_host: lan, listen_port: 18989 }));
      const agent = await startNodeAgentServer(await loadNodeAgentConfig(configPath), configPath);
      let remote: { deviceId: string; status: string } | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) { remote = (await deviceOverview()).remotes[0]; if (remote) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
      expect(remote?.status).toBe('ONLINE');
      const read = await executeRemote(remote!.deviceId, 'filesystem.read', { path: path.join(workspace, 'marker.txt') });
      expect(read.result.content).toBe('COS_REMOTE_FILE_OK');
      const patch = `*** Begin Patch\n*** Update File: marker.txt\n@@\n-COS_REMOTE_FILE_OK\n+COS_REMOTE_PATCH_OK\n*** End Patch\n`;
      const patched = await executeRemote(remote!.deviceId, 'filesystem.apply_patch', { patch, cwd: workspace });
      expect(patched.ok).toBe(true); expect((await readFile(path.join(workspace, 'marker.txt'), 'utf8')).trim()).toBe('COS_REMOTE_PATCH_OK');
      const command = await executeRemote(remote!.deviceId, 'terminal.exec', { command: 'cmd /d /c echo COS_REMOTE_COMMAND_OK', cwd: workspace, tty: false });
      expect(command.result.stdout).toContain('COS_REMOTE_COMMAND_OK');
      await agent.close(); await coordinator!.close();
      expect(JSON.parse(await readFile(configPath, 'utf8')).pairing_code).toBeUndefined();
    } finally {
      if (previousHost === undefined) delete process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_HOST; else process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_HOST = previousHost;
      if (previousPort === undefined) delete process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_PORT; else process.env.CHAT_ON_STEROS_COORDINATOR_LISTEN_PORT = previousPort;
      resetDurableForTests(); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('restores the same enrolled device after its agent restarts without another pairing code', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cos-lan-resume-'));
    const workspace = path.join(root, 'workspace'); const state = path.join(root, 'state'); const configPath = path.join(root, 'node-agent.json');
    const port = 18990;
    let coordinator: Awaited<ReturnType<typeof startCoordinatorTransport>> = null;
    let first: Awaited<ReturnType<typeof startNodeAgentServer>> | null = null;
    let restarted: Awaited<ReturnType<typeof startNodeAgentServer>> | null = null;
    try {
      await mkdir(workspace); await writeFile(path.join(workspace, 'marker.txt'), 'COS_RESUME_OK');
      initDurableStore(state);
      const ticket = await createPairingTicket();
      coordinator = await startCoordinatorTransport({ host: lan!, port });
      await writeFile(configPath, JSON.stringify({ coordinator_url: `ws://${lan}:${port}`, friendly_name: 'Resume Node', state_dir: path.join(root, 'agent-state'), capabilities: ['filesystem.read'], approved_roots: [workspace], pairing_code: ticket.code, listen_host: lan, listen_port: 18991 }));
      const config = await loadNodeAgentConfig(configPath);
      first = await startNodeAgentServer(config, configPath);
      let device: { deviceId: string } | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        device = (await deviceOverview()).remotes[0];
        const persistedConfig = JSON.parse(await readFile(configPath, 'utf8')) as { pairing_code?: string };
        if (device && persistedConfig.pairing_code === undefined && first.deviceId() === device.deviceId) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(device).toBeDefined();
      expect(JSON.parse(await readFile(configPath, 'utf8')).pairing_code).toBeUndefined();
      expect(first.deviceId()).toBe(device!.deviceId);
      await first.close(); first = null;

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((await deviceOverview()).remotes[0]?.status === 'OFFLINE') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await deviceOverview()).remotes[0]?.status).toBe('OFFLINE');

      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await executeRemote(device!.deviceId, 'filesystem.read', { path: path.join(workspace, 'marker.txt') });
        } catch (error) {
          expect(error).toMatchObject({ code: 'DEVICE_OFFLINE' });
          break;
        }
        if (attempt === 39) throw new Error('closed agent remained routable by the coordinator');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      restarted = await startNodeAgentServer(await loadNodeAgentConfig(configPath), configPath);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const read = await executeRemote(device!.deviceId, 'filesystem.read', { path: path.join(workspace, 'marker.txt') });
          if (read.result.content === 'COS_RESUME_OK') break;
        } catch { /* the reconnect loop has not attached yet */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await deviceOverview()).remotes).toHaveLength(1);
      expect((await deviceOverview()).remotes[0]?.status).toBe('ONLINE');
      await expect(executeRemote(device!.deviceId, 'filesystem.read', { path: path.join(workspace, 'marker.txt') })).resolves.toMatchObject({ result: { content: 'COS_RESUME_OK' } });
    } finally {
      await first?.close().catch(() => undefined); await restarted?.close().catch(() => undefined); await coordinator?.close().catch(() => undefined);
      resetDurableForTests(); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
