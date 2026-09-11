import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

const configSchema = z.object({
  /** Optional by design: a device must keep working while its coordinator is unavailable. */
  coordinator_url: z.string().url().startsWith('ws://').or(z.string().url().startsWith('wss://')).optional(),
  friendly_name: z.string().trim().min(1).max(80),
  state_dir: z.string().trim().min(1),
  capabilities: z.array(z.enum(['filesystem.read', 'filesystem.write', 'terminal.exec'])).min(1),
  approved_roots: z.array(z.string().trim().min(1)).min(1),
  pairing_code: z.string().trim().min(8).max(128).optional(),
  listen_host: z.string().trim().min(1),
  listen_port: z.number().int().min(1024).max(65535)
});

export type NodeAgentConfig = z.infer<typeof configSchema>;

export async function loadNodeAgentConfig(configPath: string): Promise<NodeAgentConfig> {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as unknown;
  const config = configSchema.parse(raw);
  if (config.pairing_code && !config.coordinator_url) {
    throw new Error('pairing_code requires coordinator_url; remove both fields for an independent device');
  }
  return {
    ...config,
    state_dir: path.resolve(config.state_dir),
    approved_roots: config.approved_roots.map((root) => path.resolve(root))
  };
}

export function nodeAgentUsage(): string {
  return 'node-agent --config <path-to-node-agent.json>';
}

export function assertPrivateListenHost(host: string): void {
  const value = host.trim().toLowerCase();
  if (!value || value === '0.0.0.0' || value === '::' || value === '::0' || value === 'localhost' || value === '127.0.0.1') {
    throw new Error('listen_host must be an explicit private-network address (for example a Tailscale IPv4), not a wildcard or loopback address');
  }
}

export function defaultFriendlyName(): string {
  return os.hostname() || 'Chat On Steroids Node';
}
