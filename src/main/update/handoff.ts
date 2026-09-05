import { spawn } from 'node:child_process';

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
 * The installer handoff runs outside the UI process. Its only ordering authority is the old PID:
 * no visible installer is created until that PID is actually gone. Values are passed as argv/data,
 * never interpolated into a shell command.
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
