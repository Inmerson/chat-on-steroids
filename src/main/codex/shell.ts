/**
 * Codex shell detection and command derivation.
 *
 * Ported from `codex-rs/shell-command/src/shell_detect.rs`, `derive_exec_args` in
 * `codex-rs/core/src/shell.rs`, and the UTF-8 prefix in
 * `codex-rs/shell-command/src/powershell.rs`.
 *
 * The one substitution: Codex reads the user's login shell from `getpwuid_r`, which has no
 * Node equivalent, so `$SHELL` stands in. That path is never taken on Windows, where
 * `default_user_shell_from_path` goes straight to PowerShell regardless.
 */

import { existsSync, statSync } from 'node:fs';
import nodePath from 'node:path';

export type ShellType = 'zsh' | 'bash' | 'powershell' | 'sh' | 'cmd';

export interface DetectedShell {
  shellType: ShellType;
  shellPath: string;
}

/** Rust `Path::file_stem`. */
function fileStem(candidate: string): string | null {
  const base = nodePath.basename(candidate);
  if (base === '' || base === '.' || base === '..') return null;
  const ext = nodePath.extname(base);
  if (ext === '' || ext === base) return base;
  return base.slice(0, base.length - ext.length);
}

export function detectShellType(shellPath: string): ShellType | null {
  switch (shellPath) {
    case 'zsh':
      return 'zsh';
    case 'sh':
      return 'sh';
    case 'cmd':
      return 'cmd';
    case 'bash':
      return 'bash';
    case 'pwsh':
    case 'powershell':
      return 'powershell';
    default: {
      const stem = fileStem(shellPath);
      if (stem !== null && stem !== shellPath) return detectShellType(stem);
      return null;
    }
  }
}

function fileExists(candidate: string): string | null {
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/** Stand-in for the `which` crate: PATH plus PATHEXT on Windows. */
function which(binaryName: string): string | null {
  const rawPath = process.env['PATH'] ?? process.env['Path'] ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  for (const dir of rawPath.split(separator)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = nodePath.join(dir.replace(/^"|"$/g, ''), `${binaryName}${extension}`);
      if (existsSync(candidate) && fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/** Codex reads the login shell from the passwd database; `$SHELL` is the Node equivalent. */
function userShellPath(): string | null {
  if (process.platform === 'win32') return null;
  const shell = process.env['SHELL'];
  return shell ? shell : null;
}

function getShellPath(
  shellType: ShellType,
  providedPath: string | undefined,
  binaryName: string,
  fallbackPaths: readonly string[]
): string | null {
  if (providedPath) {
    const provided = fileExists(providedPath);
    if (provided) return provided;
  }

  const defaultShellPath = userShellPath();
  if (defaultShellPath && detectShellType(defaultShellPath) === shellType && fileExists(defaultShellPath)) {
    return defaultShellPath;
  }

  const found = which(binaryName);
  if (found) return found;

  for (const candidate of fallbackPaths) {
    const existing = fileExists(candidate);
    if (existing) return existing;
  }
  return null;
}

const ZSH_FALLBACK_PATHS = ['/bin/zsh'];
const BASH_FALLBACK_PATHS = ['/bin/bash', '/usr/bin/bash'];
const SH_FALLBACK_PATHS = ['/bin/sh'];
const PWSH_FALLBACK_PATHS =
  process.platform === 'win32' ? ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'] : ['/usr/local/bin/pwsh'];
const POWERSHELL_FALLBACK_PATHS =
  process.platform === 'win32' ? ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] : [];

export function getShell(shellType: ShellType, path?: string): DetectedShell | null {
  const resolve = (binary: string, fallbacks: readonly string[]): string | null =>
    getShellPath(shellType, path, binary, fallbacks);
  let shellPath: string | null;
  switch (shellType) {
    case 'zsh':
      shellPath = resolve('zsh', ZSH_FALLBACK_PATHS);
      break;
    case 'bash':
      shellPath = resolve('bash', BASH_FALLBACK_PATHS);
      break;
    case 'sh':
      shellPath = resolve('sh', SH_FALLBACK_PATHS);
      break;
    case 'cmd':
      shellPath = resolve('cmd', []);
      break;
    case 'powershell':
      shellPath = resolve('pwsh', PWSH_FALLBACK_PATHS) ?? resolve('powershell', POWERSHELL_FALLBACK_PATHS);
      break;
  }
  return shellPath ? { shellType, shellPath } : null;
}

export function ultimateFallbackShell(): DetectedShell {
  return process.platform === 'win32'
    ? { shellType: 'cmd', shellPath: 'cmd.exe' }
    : { shellType: 'sh', shellPath: '/bin/sh' };
}

export function getShellByModelProvidedPath(shellPath: string): DetectedShell {
  const shellType = detectShellType(shellPath);
  const detected = shellType ? getShell(shellType, shellPath) : null;
  return detected ?? ultimateFallbackShell();
}

export function defaultUserShell(): DetectedShell {
  if (process.platform === 'win32') {
    return getShell('powershell') ?? ultimateFallbackShell();
  }
  const configured = userShellPath();
  const detected = configured ? detectShellType(configured) : null;
  const userDefault = detected ? getShell(detected) : null;
  const withFallback =
    process.platform === 'darwin'
      ? (userDefault ?? getShell('zsh') ?? getShell('bash'))
      : (userDefault ?? getShell('bash') ?? getShell('zsh'));
  return withFallback ?? ultimateFallbackShell();
}

/** `Shell::derive_exec_args`: the argv Codex hands the operating system. */
export function deriveExecArgs(shell: DetectedShell, command: string, useLoginShell: boolean): string[] {
  switch (shell.shellType) {
    case 'zsh':
    case 'bash':
    case 'sh':
      return [shell.shellPath, useLoginShell ? '-lc' : '-c', command];
    case 'powershell': {
      const args = [shell.shellPath];
      if (!useLoginShell) args.push('-NoProfile');
      args.push('-Command', command);
      return args;
    }
    case 'cmd':
      return [shell.shellPath, '/c', command];
  }
}

const POWERSHELL_FLAGS = ['-nologo', '-noprofile', '-command', '-c'];

/** Prefixed command for PowerShell calls to request UTF-8 console output. */
export const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';

/**
 * Splits a PowerShell invocation into (shell, script), or null when it is not one.
 *
 * Deliberately narrow: the first argument must look like a PowerShell binary, and every
 * flag before `-Command`/`-c` must be one Codex recognises.
 */
export function extractPowershellCommand(command: readonly string[]): { shell: string; script: string } | null {
  if (command.length < 3) return null;
  const shell = command[0];
  if (shell === undefined || detectShellType(shell) !== 'powershell') return null;

  let index = 1;
  while (index + 1 < command.length) {
    const flag = command[index];
    if (flag === undefined) return null;
    if (!POWERSHELL_FLAGS.includes(flag.toLowerCase())) return null;
    if (flag.toLowerCase() === '-command' || flag.toLowerCase() === '-c') {
      const script = command[index + 1];
      return script === undefined ? null : { shell, script };
    }
    index += 1;
  }
  return null;
}

/**
 * Makes a PowerShell child write UTF-8, which it otherwise only does at a real console.
 *
 * This is Codex's own fix for the same failure this app hit independently: with no console
 * attached, `[Console]::OutputEncoding` is the machine's OEM code page, so every non-ASCII
 * character a script printed came back as mojibake.
 */
export function prefixPowershellScriptWithUtf8(command: readonly string[]): string[] {
  const extracted = extractPowershellCommand(command);
  if (!extracted) return [...command];
  const script = extracted.script.trimStart().startsWith(UTF8_OUTPUT_PREFIX)
    ? extracted.script
    : `${UTF8_OUTPUT_PREFIX}${extracted.script}`;
  return [...command.slice(0, command.length - 1), script];
}

// --------------------------------------------------------------------------- shlex

/** The shlex crate's "safe without quoting" set. */
const SHLEX_SAFE = /^[A-Za-z0-9,._+:@%/-]+$/;

function shlexQuote(token: string): string {
  if (token === '') return "''";
  if (SHLEX_SAFE.test(token)) return token;
  return `'${token.replace(/'/g, "'\''")}'`;
}

/**
 * `shlex_join` (`codex-rs/shell-command/src/parse_command.rs`): the command as it is quoted back
 * to the model in `exec_command failed for ...`, including the fallback shlex uses when a token
 * contains a NUL byte.
 */
export function shlexJoin(tokens: readonly string[]): string {
  if (tokens.some((token) => token.includes('\0'))) return '<command included NUL byte>';
  return tokens.map(shlexQuote).join(' ');
}
