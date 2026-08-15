/**
 * Optional command execution. Disabled by default; enabled only by an explicit
 * checkbox in the app.
 *
 * Three deliberate choices here:
 *  - PowerShell scripts are passed with -EncodedCommand, so no quoting or escaping
 *    of model-supplied text ever reaches a command line parser.
 *  - run_command spawns without a shell, so there is no metacharacter injection.
 *  - Execution policy is not bypassed and no elevation is ever requested. Commands
 *    run as the ordinary user, under whatever policy that user already has.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_BYTES = 100_000;
export const MAX_SCRIPT_CHARS = 8_000;

export class ExecError extends Error {}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** Environment variables we never hand to a child process. */
const SECRET_ENV_KEYS = [
  'CONTROL_PLANE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'CLOUDFLARED_TOKEN',
  'CLOUDFLARED_TUNNEL_TOKEN'
];

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SECRET_ENV_KEYS) delete env[key];
  return env;
}

export interface PreparedCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

let cachedPowerShell: string | null | undefined;

/** Prefers PowerShell 7 when installed, falling back to Windows PowerShell 5.1. */
export function findPowerShell(): string | null {
  if (cachedPowerShell !== undefined) return cachedPowerShell;
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
  ];
  cachedPowerShell = candidates.find((c) => existsSync(c)) ?? null;
  return cachedPowerShell;
}

function findWindowsCommandShim(command: string, cwd: string): string | null {
  if (process.platform !== 'win32') return null;
  const ext = path.extname(command).toLowerCase();
  const scriptExts = ext === '.cmd' || ext === '.bat' ? [''] : ['.cmd', '.bat'];
  const hasSeparator = command.includes('\\') || command.includes('/');
  const bases = hasSeparator
    ? [path.isAbsolute(command) ? command : path.resolve(cwd, command)]
    : (process.env.PATH ?? '')
        .split(';')
        .map((entry) => entry.trim().replace(/^"|"$/g, ''))
        .filter(Boolean)
        .map((dir) => path.join(dir, command));
  for (const base of bases) {
    for (const suffix of scriptExts) {
      const candidate = `${base}${suffix}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function terminateProcessTree(pid: number): Promise<void> {
  // child.kill() leaves grandchildren running on Windows; taskkill /T handles the tree.
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        });
        killer.once('error', finish);
        killer.once('close', finish);
      } catch {
        finish();
      }
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

function killTree(pid: number): void {
  void terminateProcessTree(pid);
}

interface RunOptions {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

function run(opts: RunOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(opts.file, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const room = MAX_OUTPUT_BYTES - current;
      if (room <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        truncated = true;
        return MAX_OUTPUT_BYTES;
      }
      chunks.push(chunk);
      return current + chunk.length;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes = collect(out, chunk, outBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes = collect(err, chunk, errBytes);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, opts.timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut,
        durationMs: Date.now() - started
      });
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout: '',
        stderr: `Failed to start: ${error.message}`,
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started
      });
    });
    child.on('close', (code) => finish(code));
  });
}

export function normaliseTimeout(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(input)));
}

/** Runs a PowerShell script in an approved working directory. */
export async function runPowerShell(
  script: string,
  cwd: string,
  timeoutMs: number
): Promise<ExecResult> {
  if (typeof script !== 'string' || script.trim() === '') {
    throw new ExecError('script must be a non-empty string');
  }
  if (script.length > MAX_SCRIPT_CHARS) {
    throw new ExecError(`script is too long (limit ${MAX_SCRIPT_CHARS} characters)`);
  }
  const shell = findPowerShell();
  if (!shell) throw new ExecError('PowerShell was not found on this system');

  // UTF-16LE base64 is exactly what -EncodedCommand expects, and it removes the
  // command line as a place where model-supplied text could be misparsed.
  const cleanScript = `$ProgressPreference='SilentlyContinue'; ${script}`;
  const encoded = Buffer.from(cleanScript, 'utf16le').toString('base64');
  return run({
    file: shell,
    args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
    cwd,
    timeoutMs
  });
}

function validateCommand(command: string, args: readonly string[]): void {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ExecError('command must be a non-empty string');
  }
  if (command.includes('\0')) throw new ExecError('command contains a null byte');
  if (args.length > 128) throw new ExecError('Too many arguments');
  for (const arg of args) {
    if (typeof arg !== 'string') throw new ExecError('Every argument must be a string');
    if (arg.includes('\0')) throw new ExecError('An argument contains a null byte');
  }
}

/**
 * Resolves a command into a shell-free spawn target. Windows .cmd/.bat shims such as
 * npm cannot be passed to CreateProcess directly, so they use a fixed PowerShell
 * launcher whose command and argv arrive only through environment variables.
 */
export function prepareCommand(command: string, args: readonly string[], cwd: string): PreparedCommand {
  validateCommand(command, args);
  const shim = findWindowsCommandShim(command, cwd);
  if (!shim) return { file: command, args: [...args], env: childEnv() };

  const shell = findPowerShell();
  if (!shell) return { file: command, args: [...args], env: childEnv() };
  const launcher = [
    `$ErrorActionPreference='Stop'`,
    `$ProgressPreference='SilentlyContinue'`,
    `$cmd=$env:CLF_COMMAND`,
    `$argv=@()`,
    `if($env:CLF_ARGUMENTS){$argv=@(ConvertFrom-Json $env:CLF_ARGUMENTS)}`,
    `& $cmd @argv`,
    `if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}`
  ].join('; ');
  const env = childEnv();
  env['CLF_COMMAND'] = shim;
  env['CLF_ARGUMENTS'] = JSON.stringify(args);
  return {
    file: shell,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-NoLogo',
      '-OutputFormat',
      'Text',
      '-EncodedCommand',
      Buffer.from(launcher, 'utf16le').toString('base64')
    ],
    env
  };
}

/** Starts an executable and returns as soon as Windows accepts the spawn. */
export async function launchCommand(
  command: string,
  args: readonly string[],
  cwd: string
): Promise<{ pid: number }> {
  const prepared = prepareCommand(command, args, cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.file, prepared.args, {
      cwd,
      env: prepared.env,
      windowsHide: false,
      shell: false,
      // On Windows, detached:true can report a successful spawn yet cause
      // powershell.exe to exit 0 without executing its -File payload. Electron itself
      // is long-lived, so unref() is sufficient here and preserves literal argv.
      detached: false,
      stdio: 'ignore'
    });
    child.once('error', (error) => reject(new ExecError(`Failed to start: ${error.message}`)));
    child.once('spawn', () => {
      const pid = child.pid;
      child.unref();
      if (pid === undefined) reject(new ExecError('Program started without a process id'));
      else resolve({ pid });
    });
  });
}

/** Runs an executable directly. No model-supplied text is parsed as shell syntax. */
export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number
): Promise<ExecResult> {
  const prepared = prepareCommand(command, args, cwd);
  return run({
    file: prepared.file,
    args: prepared.args,
    cwd,
    timeoutMs,
    env: prepared.env
  });
}
