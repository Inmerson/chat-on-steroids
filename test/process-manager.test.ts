import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getManagedProcess,
  listManagedProcesses,
  startManagedProcess,
  stopAllManagedProcesses,
  stopManagedProcess,
  writeManagedProcess
} from '../src/main/process-manager.js';
import { IS_WINDOWS, makeTempDir, removeTempDir } from './helpers.js';

let cwd: string;
const node = process.execPath;

async function waitForOutput(
  id: string,
  needle: string,
  stream: 'stdout' | 'stderr' = 'stdout',
  timeoutMs = 3000
): Promise<ReturnType<typeof getManagedProcess>> {
  const deadline = Date.now() + timeoutMs;
  let status = getManagedProcess(id, 80);
  while (!status[stream].includes(needle) && status.running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = getManagedProcess(id, 80);
  }
  return status;
}

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

    const ready = await waitForOutput(started.id, 'ready');
    expect(ready.stdout).toContain('ready');
    const status = await waitForOutput(started.id, 'warn', 'stderr');
    expect(status.stdout).toContain('ready');
    expect(status.stderr).toContain('warn');
    expect(status.running).toBe(true);

    const stopped = await stopManagedProcess(started.id, 20);
    expect(stopped.running).toBe(false);
  });

  it('writes stdin and applies explicit environment overrides', async () => {
    const started = await startManagedProcess(
      node,
      [
        '-e',
        'process.stdin.setEncoding("utf8"); console.log("env="+(process.env.TEST_PROCESS_ENV ?? "missing")); process.stdin.once("data", d => { console.log("input="+d.trim()); process.exit(0); });'
      ],
      cwd,
      { TEST_PROCESS_ENV: 'process-ok' }
    );
    const before = await waitForOutput(started.id, 'env=process-ok');
    expect(before.stdout).toContain('env=process-ok');
    await writeManagedProcess(started.id, 'hello-process');
    const deadline = Date.now() + 3000;
    while (getManagedProcess(started.id).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const after = getManagedProcess(started.id, 20);
    expect(after.running).toBe(false);
    expect(after.stdout).toContain('input=hello-process');
  });

  it.runIf(IS_WINDOWS)(
    'keeps stop bounded when graceful taskkill waits on a stubborn cmd loop',
    async () => {
      const started = await startManagedProcess(
        'cmd.exe',
        ['/d', '/s', '/c', 'for /L %i in (1,1,60) do @echo tick%i & @ping 127.0.0.1 -n 2 >nul'],
        cwd
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const before = Date.now();
      const stopped = await stopManagedProcess(started.id, 10);
      const elapsed = Date.now() - before;
      expect(stopped.running).toBe(false);
      expect(elapsed).toBeLessThan(5_500);
    },
    8_000
  );

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

  it('stops a real descendant process as part of the managed process tree', async () => {
    const started = await startManagedProcess(
      node,
      [
        '-e',
        'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log("child="+child.pid); setInterval(()=>{},1000)'
      ],
      cwd
    );
    const status = await waitForOutput(started.id, 'child=');
    const childPid = Number(status.stdout.match(/child=(\d+)/)?.[1]);
    expect(childPid).toBeGreaterThan(0);

    await stopManagedProcess(started.id, 20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('returns only output produced after an opaque cursor', async () => {
    const started = await startManagedProcess(
      node,
      [
        '-e',
        'console.log("first"); setTimeout(() => console.log("second"), 250); setInterval(() => {}, 1000)'
      ],
      cwd
    );
    const first = await waitForOutput(started.id, 'first');
    expect(first.stdout).toContain('first');
    expect(first.cursor).toMatch(new RegExp(`^${first.id}\\.`));

    await new Promise((resolve) => setTimeout(resolve, 300));
    const delta = getManagedProcess(started.id, 20, first.cursor);
    expect(delta.outputMode).toBe('delta');
    expect(delta.stdout).toContain('second');
    expect(delta.stdout).not.toContain('first');

    const emptyDelta = getManagedProcess(started.id, 20, delta.cursor);
    expect(emptyDelta.stdout).toBe('');
    await stopManagedProcess(started.id, 1, emptyDelta.cursor);
  });

  it('reports when a cursor falls behind the bounded noisy-output buffer', async () => {
    const started = await startManagedProcess(
      node,
      ['-e', 'setTimeout(() => process.stdout.write("x".repeat(250000)), 100)'],
      cwd
    );
    const cursor = started.cursor;
    const deadline = Date.now() + 3000;
    while (getManagedProcess(started.id).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const delta = getManagedProcess(started.id, 20, cursor);
    expect(delta.stdoutCursorLost).toBe(true);
    expect(Buffer.byteLength(delta.stdout, 'utf8')).toBeLessThanOrEqual(100_000);
  });

  it('rejects a cursor from another process without stopping either process', async () => {
    const one = await startManagedProcess(node, ['-e', 'setInterval(() => {}, 1000)'], cwd);
    const two = await startManagedProcess(node, ['-e', 'setInterval(() => {}, 1000)'], cwd);
    await expect(stopManagedProcess(two.id, 10, one.cursor)).rejects.toThrow(/belongs to/);
    expect(getManagedProcess(one.id).running).toBe(true);
    expect(getManagedProcess(two.id).running).toBe(true);
    await stopManagedProcess(one.id, 1);
    await stopManagedProcess(two.id, 1);
  });

  it('rejects unknown process ids', () => {
    expect(() => getManagedProcess('p-does-not-exist')).toThrow(/Unknown managed process id/);
  });
});
