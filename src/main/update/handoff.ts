import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface InstallerHandoffRequest {
  parentPid: number;
  installerPath: string;
  args: string[];
  windowsHide: boolean;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export interface InstallerHandoffDependencies {
  processExists?: (pid: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  launch?: (file: string, args: string[], options: { windowsHide: boolean }) => Promise<void>;
  now?: () => number;
}

export interface StartWindowsInstallerHandoffInput extends InstallerHandoffRequest {
  userDataDir: string;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function processExistsDefault(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this process cannot signal it. ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function launchDefault(file: string, args: string[], options: { windowsHide: boolean }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: options.windowsHide,
      shell: false
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * The behavior contract used by both tests and any future native handoff helper. Nothing may
 * launch the installer before the old application PID is actually gone.
 */
export async function runInstallerHandoff(
  request: InstallerHandoffRequest,
  dependencies: InstallerHandoffDependencies = {}
): Promise<void> {
  if (!Number.isSafeInteger(request.parentPid) || request.parentPid <= 0) {
    throw new Error('Invalid parent PID for installer handoff');
  }
  if (!request.installerPath) throw new Error('Missing installer path for handoff');

  const processExists = dependencies.processExists ?? processExistsDefault;
  const sleep = dependencies.sleep ?? sleepDefault;
  const launch = dependencies.launch ?? launchDefault;
  const now = dependencies.now ?? Date.now;
  const pollIntervalMs = request.pollIntervalMs ?? 250;
  const maxWaitMs = request.maxWaitMs ?? 5 * 60_000;
  const startedAt = now();

  while (await processExists(request.parentPid)) {
    if (now() - startedAt >= maxWaitMs) {
      throw new Error(`Old application PID ${request.parentPid} did not exit before installer handoff deadline`);
    }
    await sleep(pollIntervalMs);
  }

  await launch(request.installerPath, request.args, { windowsHide: request.windowsHide });
}

const POWERSHELL_HANDOFF = String.raw`param(
  [Parameter(Mandatory=$true)][string]$RequestPath
)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
try {
  Wait-Process -Id ([int]$request.parentPid) -ErrorAction SilentlyContinue
  $start = @{ FilePath = [string]$request.installerPath }
  if ($null -ne $request.args -and $request.args.Count -gt 0) {
    $start.ArgumentList = @($request.args | ForEach-Object { [string]$_ })
  }
  Start-Process @start | Out-Null
} finally {
  Remove-Item -LiteralPath $RequestPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;

/**
 * Starts a helper that is independent of the application executable being replaced.
 *
 * Using the app's own Electron binary as the waiter would keep that executable open and merely
 * move the NSIS file-lock race into the helper. Windows PowerShell is used as the first production
 * helper because it is outside the installation directory. The script is static; installer path,
 * args and PID live in a JSON request file and are never interpolated into shell source. A small
 * native helper can replace this later without changing the request protocol or tests.
 */
export async function startWindowsInstallerHandoff(input: StartWindowsInstallerHandoffInput): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows installer handoff requested on a non-Windows host');
  if (!Number.isSafeInteger(input.parentPid) || input.parentPid <= 0) throw new Error('Invalid parent PID for installer handoff');
  if (!input.installerPath) throw new Error('Missing installer path for handoff');

  const directory = path.join(input.userDataDir, 'updates', 'handoff');
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const requestPath = path.join(directory, `${id}.json`);
  const scriptPath = path.join(directory, `${id}.ps1`);
  const request: InstallerHandoffRequest = {
    parentPid: input.parentPid,
    installerPath: input.installerPath,
    args: [...input.args],
    windowsHide: input.windowsHide,
    pollIntervalMs: input.pollIntervalMs,
    maxWaitMs: input.maxWaitMs
  };
  await writeFile(requestPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 });
  await writeFile(scriptPath, POWERSHELL_HANDOFF, { encoding: 'utf8', mode: 0o600 });

  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  await new Promise<void>((resolve, reject) => {
    const helper = spawn(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-RequestPath', requestPath],
      { detached: true, stdio: 'ignore', windowsHide: true, shell: false }
    );
    helper.once('error', reject);
    helper.once('spawn', () => {
      helper.unref();
      resolve();
    });
  });
}
