import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { NodeAgentConfig } from './config.js';
import { MultiDeviceError } from '../shared/multidevice/errors.js';
import { applyPatch } from '../main/codex/apply-patch/index.js';

const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const MAX_COMMAND_CHARS = 32_768;

function appendBounded(current: string, chunk: string): { value: string; truncated: boolean } {
  const remaining = MAX_COMMAND_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8');
  if (remaining <= 0) return { value: current, truncated: true };
  const bytes = Buffer.from(chunk, 'utf8');
  if (bytes.length <= remaining) return { value: current + chunk, truncated: false };
  return { value: current + bytes.subarray(0, remaining).toString('utf8'), truncated: true };
}

function capabilityFor(operation: string): string {
  return operation === 'filesystem.read' ? 'filesystem.read' : operation === 'filesystem.apply_patch' ? 'filesystem.write' : 'terminal.exec';
}

function rootFor(config: NodeAgentConfig, candidate: string): string {
  const absolute = path.resolve(candidate);
  const root = config.approved_roots.find((allowed) => absolute === allowed || absolute.startsWith(`${allowed}${path.sep}`));
  if (!root) throw new MultiDeviceError('ROOT_DENIED', 'path is outside the approved roots');
  return absolute;
}

function requireCapability(config: NodeAgentConfig, operation: string): void {
  if (!config.capabilities.includes(capabilityFor(operation) as never)) {
    throw new MultiDeviceError('CAPABILITY_DENIED', `capability ${capabilityFor(operation)} is not enabled`);
  }
}

export async function executeNodeOperation(config: NodeAgentConfig, operation: string, payload: any): Promise<unknown> {
  requireCapability(config, operation);
  if (operation === 'filesystem.read') {
    const target = rootFor(config, payload.path);
    return { path: target, content: await fs.readFile(target, 'utf8') };
  }
  if (operation === 'filesystem.apply_patch') {
    if (typeof payload.patch === 'string') {
      const cwd = rootFor(config, payload.cwd ?? config.approved_roots[0]);
      const output = { text: '' }; const errors = { text: '' };
      const delta = await applyPatch(payload.patch, cwd, output, errors, (spelled, base) => rootFor(config, path.resolve(base, spelled)));
      return { changes: delta.changes, output: output.text, errors: errors.text };
    }
    const target = rootFor(config, payload.path);
    const current = await fs.readFile(target, 'utf8');
    if (typeof payload.expected !== 'string' || typeof payload.content !== 'string' || current !== payload.expected) {
      throw new MultiDeviceError('INVALID_REQUEST', 'filesystem write requires an exact expected value');
    }
    await fs.writeFile(target, payload.content, 'utf8');
    return { path: target, bytes: Buffer.byteLength(payload.content, 'utf8') };
  }
  if (operation === 'terminal.exec') {
    if (typeof payload?.command !== 'string' || !payload.command.trim() || payload.command.length > MAX_COMMAND_CHARS) {
      throw new MultiDeviceError('INVALID_REQUEST', `terminal command must be between 1 and ${MAX_COMMAND_CHARS} characters`);
    }
    const cwd = rootFor(config, typeof payload.cwd === 'string' ? payload.cwd : config.approved_roots[0]!);
    if (payload.tty === true) throw new MultiDeviceError('INVALID_REQUEST', 'interactive terminal sessions are not supported by the Node Agent');
    return await new Promise((resolve, reject) => {
      const child = spawn(payload.command, { cwd, shell: true, windowsHide: true, timeout: 120_000 });
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        const next = appendBounded(stdout, chunk); stdout = next.value; stdoutTruncated ||= next.truncated;
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        const next = appendBounded(stderr, chunk); stderr = next.value; stderrTruncated ||= next.truncated;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr, stdoutTruncated, stderrTruncated }));
    });
  }
  throw new MultiDeviceError('INVALID_REQUEST', 'unsupported operation');
}
