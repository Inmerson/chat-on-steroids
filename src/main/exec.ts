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
export const MAX_ENV_VARS = 64;
export const MAX_ENV_KEY_CHARS = 128;
export const MAX_ENV_VALUE_CHARS = 8_192;

export class ExecError extends Error {}
export type CommandEnvironment = Record<string, string>;

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

function validateEnvironment(overrides: CommandEnvironment | undefined): void {
  if (!overrides) return;
  const entries = Object.entries(overrides);
  if (entries.length > MAX_ENV_VARS) throw new ExecError(`Too many environment variables (limit ${MAX_ENV_VARS})`);
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_ENV_KEY_CHARS || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ExecError(`Invalid environment variable name: ${key.slice(0, MAX_ENV_KEY_CHARS) || '(empty)'}`);
    }
    if (key.toUpperCase().startsWith('CLF_')) {
      throw new ExecError('Environment variable names beginning with CLF_ are reserved by ChatGPT Local Files');
    }
    if (typeof value !== 'string') throw new ExecError(`Environment variable ${key} must be a string`);
    if (value.includes('\0')) throw new ExecError(`Environment variable ${key} contains a null byte`);
    if (value.length > MAX_ENV_VALUE_CHARS) {
      throw new ExecError(`Environment variable ${key} is too long (limit ${MAX_ENV_VALUE_CHARS} characters)`);
    }
  }
}

function childEnv(overrides?: CommandEnvironment): NodeJS.ProcessEnv {
  validateEnvironment(overrides);
  const env = { ...process.env };
  // Windows environment keys are case-insensitive. Remove every inherited spelling of
  // connector/control-plane secrets before applying values explicitly supplied by the caller.
  for (const key of Object.keys(env)) {
    if (SECRET_ENV_KEYS.some((secret) => secret.toLowerCase() === key.toLowerCase())) delete env[key];
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) env[key] = value;
  }
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

export async function terminateProcessTree(
  pid: number,
  force = true,
  helperTimeoutMs = force ? 1_000 : 500
): Promise<void> {
  // child.kill() leaves grandchildren running on Windows; taskkill /T handles the tree.
  // taskkill itself can block while waiting on an uncooperative console process, so
  // bound the helper too. The caller owns the larger graceful/forced deadline.
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      try {
        const args = ['/pid', String(pid), '/T'];
        if (force) args.push('/F');
        const killer = spawn('taskkill', args, {
          windowsHide: true,
          stdio: 'ignore'
        });
        killer.once('error', finish);
        killer.once('close', finish);
        timer = setTimeout(() => {
          try {
            killer.kill();
          } catch {
            /* already gone */
          }
          finish();
        }, Math.max(50, helperTimeoutMs));
      } catch {
        finish();
      }
    });
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
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

function decodePowerShellXmlText(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Turns Windows PowerShell's serialized error stream into compact plain text. */
function cleanPowerShellStderr(stderr: string): string {
  const marker = stderr.indexOf('#< CLIXML');
  if (marker === -1) return stderr.trim();
  const plainPrefix = stderr.slice(0, marker).trim();
  const xml = stderr.slice(marker);
  const records = [...xml.matchAll(/<S S="(?:Error|Warning)">([\s\S]*?)<\/S>/g)]
    .map((match) => decodePowerShellXmlText(match[1] ?? '').trim())
    .filter(Boolean);
  return [plainPrefix, ...records].filter(Boolean).join('\n').trim();
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
  const result = await run({
    file: shell,
    args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
    cwd,
    timeoutMs
  });
  const stderr = cleanPowerShellStderr(result.stderr);
  return {
    ...result,
    stderr:
      stderr && result.exitCode === 0
        ? `PowerShell error stream (process exited 0):\n${stderr}`
        : stderr
  };
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
export function prepareCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  envOverrides?: CommandEnvironment
): PreparedCommand {
  validateCommand(command, args);
  const env = childEnv(envOverrides);
  const shim = findWindowsCommandShim(command, cwd);
  if (!shim) return { file: command, args: [...args], env };

  const shell = findPowerShell();
  if (!shell) return { file: command, args: [...args], env };
  const launcher = [
    `$ErrorActionPreference='Stop'`,
    `$ProgressPreference='SilentlyContinue'`,
    `$cmd=$env:CLF_COMMAND`,
    `$argv=@()`,
    `if($env:CLF_ARGUMENTS){$argv=@(ConvertFrom-Json $env:CLF_ARGUMENTS)}`,
    `& $cmd @argv`,
    `if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}`
  ].join('; ');
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
  timeoutMs: number,
  env?: CommandEnvironment
): Promise<ExecResult> {
  const prepared = prepareCommand(command, args, cwd, env);
  return run({
    file: prepared.file,
    args: prepared.args,
    cwd,
    timeoutMs,
    env: prepared.env
  });
}
