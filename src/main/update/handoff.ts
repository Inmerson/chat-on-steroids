import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareInstalledCoreUpdateHandoff } from '../core/update-quiesce.js';

export interface InstallerHandoffRequest {
  parentPid: number;
  /** Additional installed-app processes that may still hold the executable open. */
  waitPids?: number[];
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

function waitSet(request: InstallerHandoffRequest): number[] {
  const values = [request.parentPid, ...(request.waitPids ?? [])];
  if (values.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error('Invalid PID for installer handoff');
  }
  return [...new Set(values)];
}

/** Nothing may launch NSIS while any process from the installation still owns its executable. */
export async function runInstallerHandoff(
  request: InstallerHandoffRequest,
  dependencies: InstallerHandoffDependencies = {}
): Promise<void> {
  const waitPids = waitSet(request);
  if (!request.installerPath) throw new Error('Missing installer path for handoff');

  const processExists = dependencies.processExists ?? processExistsDefault;
  const sleep = dependencies.sleep ?? sleepDefault;
  const launch = dependencies.launch ?? launchDefault;
  const now = dependencies.now ?? Date.now;
  const pollIntervalMs = request.pollIntervalMs ?? 250;
  const maxWaitMs = request.maxWaitMs ?? 5 * 60_000;
  const startedAt = now();

  for (;;) {
    const alive = (await Promise.all(waitPids.map(async (pid) => ({ pid, alive: await processExists(pid) })))).filter(
      (entry) => entry.alive
    );
    if (alive.length === 0) break;
    if (now() - startedAt >= maxWaitMs) {
      throw new Error(`Processes ${alive.map((entry) => entry.pid).join(', ')} did not exit before installer handoff deadline`);
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
  $waitIds = New-Object System.Collections.Generic.List[int]
  $waitIds.Add([int]$request.parentPid)
  if ($null -ne $request.waitPids) {
    foreach ($processId in @($request.waitPids)) {
      $value = [int]$processId
      if (-not $waitIds.Contains($value)) { $waitIds.Add($value) }
    }
  }
  $pollMs = if ($null -ne $request.pollIntervalMs) { [int]$request.pollIntervalMs } else { 250 }
  $maxWaitMs = if ($null -ne $request.maxWaitMs) { [int]$request.maxWaitMs } else { 300000 }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($maxWaitMs)
  while ($true) {
    $alive = $false
    foreach ($processId in $waitIds) {
      if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        $alive = $true
        break
      }
    }
    if (-not $alive) { break }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Old Chat On Steroids processes did not exit before installer handoff deadline.' }
    Start-Sleep -Milliseconds $pollMs
  }

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
 * Starts a helper outside the installation directory. `--updated` is emitted only by the owned
 * NSIS-install policy, so that case first quiesces the installed Core/supervisor and adds their
 * PIDs to the helper wait set. A win-unpacked fresh-install wizard has no `--updated` and leaves
 * its compatible Core running because the installer targets a different installation directory.
 */
export async function startWindowsInstallerHandoff(input: StartWindowsInstallerHandoffInput): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows installer handoff requested on a non-Windows host');
  if (!input.installerPath) throw new Error('Missing installer path for handoff');

  let waitPids = input.waitPids ? [...input.waitPids] : [];
  if (input.args.includes('--updated')) {
    const prepared = await prepareInstalledCoreUpdateHandoff(input.userDataDir);
    waitPids = [...new Set([...waitPids, ...prepared.waitPids])];
  }
  const effective: InstallerHandoffRequest = { ...input, waitPids };
  waitSet(effective);

  const directory = path.join(input.userDataDir, 'updates', 'handoff');
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const requestPath = path.join(directory, `${id}.json`);
  const scriptPath = path.join(directory, `${id}.ps1`);
  const request: InstallerHandoffRequest = {
    parentPid: input.parentPid,
    waitPids,
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
