import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getManagedProcess,
  listManagedProcesses,
  startManagedProcess,
  stopAllManagedProcesses,
  stopManagedProcess
} from '../src/main/process-manager.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let cwd: string;
const node = process.execPath;

beforeAll(async () => {
  cwd = await makeTempDir('clf-process-');
});

afterAll(async () => {
  await stopAllManagedProcesses();
  await removeTempDir(cwd);
});

describe('managed processes', () => {
  it('starts, captures output, reports status and stops the process tree', async () => {
    const started = await startManagedProcess(
      node,
      ['-e', 'console.log("ready"); console.error("warn"); setInterval(() => {}, 1000)'],
      cwd
    );
    expect(started.id).toMatch(/^p\d+$/);
    expect(started.pid).toBeGreaterThan(0);
    expect(started.running).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = getManagedProcess(started.id, 20);
    expect(status.stdout).toContain('ready');
    expect(status.stderr).toContain('warn');
    expect(status.running).toBe(true);

    const stopped = await stopManagedProcess(started.id, 20);
    expect(stopped.running).toBe(false);
  });

  it('keeps exited processes inspectable with their exit code', async () => {
    const started = await startManagedProcess(
      node,
      ['-e', 'console.log("done"); process.exit(7)'],
      cwd
    );
    const deadline = Date.now() + 3000;
    while (getManagedProcess(started.id).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = getManagedProcess(started.id, 20);
    expect(status.running).toBe(false);
    expect(status.exitCode).toBe(7);
    expect(status.stdout).toContain('done');
    expect(listManagedProcesses().some((entry) => entry.id === started.id)).toBe(true);
  });

  it('bounds noisy output instead of growing with the child process', async () => {
    const started = await startManagedProcess(
      node,
      ['-e', 'process.stdout.write("x".repeat(250000))'],
      cwd
    );
    const deadline = Date.now() + 3000;
    while (getManagedProcess(started.id).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = getManagedProcess(started.id, 20);
    expect(status.running).toBe(false);
    expect(status.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(status.stdout, 'utf8')).toBeLessThanOrEqual(100_000);
  });

  it('rejects unknown process ids', () => {
    expect(() => getManagedProcess('p-does-not-exist')).toThrow(/Unknown managed process id/);
  });
});
