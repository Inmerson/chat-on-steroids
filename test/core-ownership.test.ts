import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireCoreSupervisorLock,
  coreSupervisorPid,
  requestCoreSupervisorStop,
  supervisorEndpointForUserData,
  type CoreSupervisorLock
} from '../src/main/core/ownership.js';

const roots: string[] = [];
const locks: CoreSupervisorLock[] = [];

afterEach(async () => {
  await Promise.all(locks.splice(0).map((lock) => lock.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cos-core-lock-'));
  roots.push(dir);
  return dir;
}

describe('Core supervisor ownership', () => {
  it('uses a deterministic user-scoped endpoint distinct from Core IPC', async () => {
    const dir = await root();
    expect(supervisorEndpointForUserData(dir, 'win32')).toMatch(/^\\\\\.\\pipe\\chat-on-steroids-core-supervisor-/);
    expect(supervisorEndpointForUserData(dir, 'linux')).toBe(path.join(dir, 'core', 'supervisor.sock'));
  });

  it('allows exactly one live supervisor for a profile', async () => {
    const dir = await root();
    const first = await acquireCoreSupervisorLock(dir);
    locks.push(first);

    await expect(acquireCoreSupervisorLock(dir)).rejects.toThrow(/supervisor.*running|already.*owned/i);
  });

  it('accepts one explicit local shutdown command and returns the owning PID for installer wait', async () => {
    const dir = await root();
    const onShutdown = vi.fn();
    const lock = await acquireCoreSupervisorLock(dir, { onShutdown });
    locks.push(lock);

    await expect(coreSupervisorPid(dir)).resolves.toBe(process.pid);
    await expect(requestCoreSupervisorStop(dir)).resolves.toBe(process.pid);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('returns null when no supervisor owns the profile instead of making update shutdown fail', async () => {
    const dir = await root();
    await expect(coreSupervisorPid(dir)).resolves.toBeNull();
    await expect(requestCoreSupervisorStop(dir)).resolves.toBeNull();
  });
});
