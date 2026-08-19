import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UnifiedExecError,
  UnifiedExecProcessManager,
  applyUnifiedExecEnv
} from '../src/main/codex/unified-exec.js';
import {
  DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
  MAX_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS,
  clampYieldTime
} from '../src/main/codex/unified-exec-constants.js';
import { deriveExecArgs, getShell } from '../src/main/codex/shell.js';
import { terminateProcessTree } from '../src/main/exec.js';

const truncationPolicy = { kind: 'tokens' as const, tokens: 10_000 };

function manager(): UnifiedExecProcessManager {
  return new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
}

async function waitForProcess(instance: UnifiedExecProcessManager, processId: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (instance.listProcesses().some((item) => item.processId === processId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${processId} was not stored as live`);
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`file was not created: ${file}`);
}

describe('Codex unified exec runtime parity', () => {
  const managers: UnifiedExecProcessManager[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((item) => item.terminateAllProcesses()));
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('uses Codex login-shell argv semantics for PowerShell', () => {
    const shell = { shellType: 'powershell' as const, shellPath: 'powershell.exe' };
    expect(deriveExecArgs(shell, "Write-Output 'x'", true)).toEqual([
      'powershell.exe',
      '-Command',
      "Write-Output 'x'"
    ]);
    expect(deriveExecArgs(shell, "Write-Output 'x'", false)).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-Command',
      "Write-Output 'x'"
    ]);
  });

  it('classifies a launch failure as CreateProcess, matching Codex', async () => {
    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();

    await expect(
      instance.execCommand({
        command: ['__codex_missing_executable_for_parity_test__'],
        shellType: process.platform === 'win32' ? 'powershell' : 'bash',
        hookCommand: '__codex_missing_executable_for_parity_test__',
        processId,
        yieldTimeMs: 250,
        maxOutputTokens: undefined,
        truncationPolicy,
        cwd: process.cwd(),
        displayCwd: process.cwd(),
        env: applyUnifiedExecEnv(process.env),
        tty: false
      })
    ).rejects.toMatchObject({ kind: 'create_process' } satisfies Partial<UnifiedExecError>);
  });

  it('forces Codex pager/color environment defaults over inherited values', () => {
    const env = applyUnifiedExecEnv({
      PATH: 'sentinel-path',
      NO_COLOR: '0',
      TERM: 'xterm-256color',
      PAGER: 'less'
    });

    expect(env.PATH).toBe('sentinel-path');
    expect(env.NO_COLOR).toBe('1');
    expect(env.TERM).toBe('dumb');
    expect(env.PAGER).toBe('cat');
    expect(env.CODEX_CI).toBe('1');
  });

  it('matches Codex initial yield clamping, including the Windows 10s floor', () => {
    expect(clampYieldTime(0)).toBe(
      process.platform === 'win32' ? WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS : MIN_YIELD_TIME_MS
    );
    expect(clampYieldTime(Number.MAX_SAFE_INTEGER)).toBe(MAX_YIELD_TIME_MS);
  });

  it('preserves a completed pipe command exit code and drains both output streams', async () => {
    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const output = await instance.execCommand({
      command: [
        process.execPath,
        '-e',
        "process.stdout.write('stdout-marker\\n'); process.stderr.write('stderr-marker\\n'); process.exit(17)"
      ],
      shellType: process.platform === 'win32' ? 'powershell' : 'bash',
      hookCommand: 'pipe exit-code parity child',
      processId,
      yieldTimeMs: 250,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });

    expect(output.processId).toBeNull();
    expect(output.exitCode).toBe(17);
    expect(output.rawOutput.toString('utf8')).toContain('stdout-marker');
    expect(output.rawOutput.toString('utf8')).toContain('stderr-marker');
  });

  it.runIf(process.platform === 'win32')('forces UTF-8 for PowerShell pipe output like Codex', async () => {
    const shell = getShell('powershell');
    expect(shell).not.toBeNull();
    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const marker = 'héllo 中文 😀';
    const output = await instance.execCommand({
      command: deriveExecArgs(shell!, `Write-Output '${marker}'`, false),
      shellType: 'powershell',
      hookCommand: `Write-Output '${marker}'`,
      processId,
      yieldTimeMs: 250,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });

    expect(output.exitCode).toBe(0);
    expect(output.rawOutput.toString('utf8')).toContain(marker);
  });

  it('lets the initial exec response observe concurrent termination, matching Codex', async () => {
    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const initial = instance.execCommand({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'],
      shellType: process.platform === 'win32' ? 'powershell' : 'bash',
      hookCommand: 'long-running parity child',
      processId,
      yieldTimeMs: 30_000,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });

    await waitForProcess(instance, processId);
    expect(await instance.terminateProcess(processId)).toBe(true);

    await expect(initial).resolves.toMatchObject({ processId: null });
    expect(instance.listProcesses()).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('Ctrl-C on a Windows pipe session terminates the whole process tree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clf-pipe-interrupt-parity-'));
    tempRoots.push(root);
    const ready = path.join(root, 'grandchild.pid');
    const survived = path.join(root, 'grandchild-survived.txt');
    const grandchildScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survived)}, 'survived'), 900); setInterval(() => {}, 1000);`;
    const parentScript = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchildScript)}], {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(ready)}, String(child.pid)); setInterval(() => {}, 1000);`;

    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const initial = instance.execCommand({
      command: [process.execPath, '-e', parentScript],
      shellType: 'powershell',
      hookCommand: 'pipe process-tree parity child',
      processId,
      yieldTimeMs: 30_000,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: root,
      displayCwd: root,
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });

    await waitForProcess(instance, processId);
    await waitForFile(ready);
    const grandchildPid = Number.parseInt(await readFile(ready, 'utf8'), 10);
    try {
      const interrupted = await instance.writeStdin({
        processId,
        input: String.fromCharCode(3),
        yieldTimeMs: 250,
        maxOutputTokens: undefined,
        truncationPolicy
      });
      expect(interrupted.processId).toBeNull();
      await expect(initial).resolves.toMatchObject({ processId: null });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await expect(access(survived)).rejects.toBeDefined();
    } finally {
      if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
        await terminateProcessTree(grandchildPid, true).catch(() => undefined);
      }
    }
  });
});
