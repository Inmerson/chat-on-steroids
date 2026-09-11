import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { childEnv, findPowerShell } from '../exec.js';
import { envValue, pathEntries } from '../env.js';
import { redact } from '../logger.js';

const execFileAsync = promisify(execFile);

export const AI_CODING_BACKENDS = ['codex', 'cursor', 'claude', 'copilot', 'gemini', 'opencode'] as const;
export type AiCodingBackend = (typeof AI_CODING_BACKENDS)[number];
export type CodeRabbitReviewScope = 'all' | 'committed' | 'uncommitted';

const MAX_EXTERNAL_PROMPT_CHARS = 20_000;
const MAX_EXTERNAL_OUTPUT_CHARS = 40_000;
const MAX_EXTERNAL_BUFFER_BYTES = 4 * 1024 * 1024;
const EXTERNAL_AGENT_TIMEOUT_MS = 30 * 60_000;

export interface ExternalCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  maxBuffer: number;
  timeout: number;
  shell: false;
}

export type ExternalCommandExecutor = (
  file: string,
  args: string[],
  options: ExternalCommandOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface ExternalAiResult {
  binary: string;
  output: string;
  truncated: boolean;
}

function boundedText(value: string, field: string, max: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters`);
  if (/\0/.test(text)) throw new Error(`${field} contains an invalid NUL character`);
  return text;
}

function boundedOutput(stdout: string, stderr: string): { output: string; truncated: boolean } {
  const raw = [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\n' : '');
  const rawExceededLimit = raw.length > MAX_EXTERNAL_OUTPUT_CHARS;
  const credentialMasked = raw
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))=([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
  const combined = redact(credentialMasked);
  if (combined.length <= MAX_EXTERNAL_OUTPUT_CHARS) {
    return {
      output: rawExceededLimit ? `${combined}\n…(external AI output truncated/redacted by Core)` : combined,
      truncated: rawExceededLimit
    };
  }
  return {
    output: `${combined.slice(0, MAX_EXTERNAL_OUTPUT_CHARS)}\n…(external AI output truncated by Core)`,
    truncated: true
  };
}

export function resolveWindowsExternalCommand(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  powershellPath: string | null = findPowerShell()
): { file: string; args: string[] } {
  const pathLike = path.isAbsolute(file) || file.includes('\\') || file.includes('/');
  const localAppData = envValue(env, 'LOCALAPPDATA');
  const vendorDirs = localAppData
    ? file === 'agent' || file === 'cursor-agent'
      ? [path.join(localAppData, 'cursor-agent')]
      : file === 'coderabbit' || file === 'cr'
        ? [path.join(localAppData, 'Programs', 'coderabbit')]
        : []
    : [];
  const searchDirs = [...new Set([...pathEntries(env), ...vendorDirs])];
  const candidates = pathLike
    ? [file]
    : searchDirs.flatMap((dir) => [
        path.join(dir, `${file}.exe`),
        path.join(dir, `${file}.com`),
        path.join(dir, `${file}.ps1`)
      ]);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) return { file, args };
  if (path.extname(found).toLowerCase() !== '.ps1') return { file: found, args };
  if (!powershellPath) {
    const error = Object.assign(new Error(`PowerShell is required to launch ${path.basename(found)}`), { code: 'ENOENT' });
    throw error;
  }
  return {
    file: powershellPath,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', found, ...args]
  };
}

const defaultExecutor: ExternalCommandExecutor = async (file, args, options) => {
  const invocation = process.platform === 'win32'
    ? resolveWindowsExternalCommand(file, args, options.env)
    : { file, args };
  const result = await execFileAsync(invocation.file, invocation.args, options);
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
};

function externalAiEnvironment(): NodeJS.ProcessEnv {
  const env = childEnv();
  for (const key of Object.keys(env)) {
    if (
      /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY)/i.test(key) ||
      /^(?:DATABASE|DB|REDIS|POSTGRES|MYSQL|MONGO).*URL$/i.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

function commandOptions(cwd: string): ExternalCommandOptions {
  return {
    cwd: boundedText(cwd, 'cwd', 4096),
    env: externalAiEnvironment(),
    windowsHide: true,
    maxBuffer: MAX_EXTERNAL_BUFFER_BYTES,
    timeout: EXTERNAL_AGENT_TIMEOUT_MS,
    shell: false
  };
}

export function codingBackendLabel(backend: AiCodingBackend): string {
  switch (backend) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    case 'copilot': return 'GitHub Copilot';
    case 'cursor': return 'Cursor';
    case 'gemini': return 'Gemini';
    case 'opencode': return 'OpenCode';
  }
}

export function buildCodingBackendInvocation(
  backend: AiCodingBackend,
  rawPrompt: string
): { file: string; args: string[] } {
  const prompt = boundedText(rawPrompt, 'prompt', MAX_EXTERNAL_PROMPT_CHARS);
  switch (backend) {
    case 'claude': return { file: 'claude', args: ['--output-format', 'text', '-p', prompt] };
    case 'codex': return { file: 'codex', args: ['exec', prompt] };
    case 'copilot': return { file: 'copilot', args: ['-p', prompt] };
    case 'cursor': return { file: 'agent', args: ['-p', prompt, '--output-format', 'text', '--trust'] };
    case 'gemini': return { file: 'gemini', args: ['-p', prompt] };
    case 'opencode': return { file: 'opencode', args: ['run', prompt] };
  }
}

function externalFailure(binary: string, error: unknown): Error {
  const candidate = error as Error & { stdout?: unknown; stderr?: unknown; code?: unknown };
  const detail = boundedOutput(
    typeof candidate.stdout === 'string' ? candidate.stdout : '',
    typeof candidate.stderr === 'string' ? candidate.stderr : candidate.message ?? String(error)
  ).output;
  const missing = candidate.code === 'ENOENT' ? ' is not installed or is not on PATH' : ' failed';
  return new Error(`${binary}${missing}${detail ? `: ${detail}` : ''}`);
}

export async function runCodingBackend(
  input: { backend: AiCodingBackend; cwd: string; prompt: string },
  executor: ExternalCommandExecutor = defaultExecutor
): Promise<ExternalAiResult> {
  const invocation = buildCodingBackendInvocation(input.backend, input.prompt);
  try {
    const result = await executor(invocation.file, invocation.args, commandOptions(input.cwd));
    return { binary: invocation.file, ...boundedOutput(result.stdout, result.stderr) };
  } catch (error) {
    throw externalFailure(invocation.file, error);
  }
}

function codeRabbitArgs(input: { cwd: string; scope: CodeRabbitReviewScope; base?: string }): string[] {
  const args = ['review', '--agent', '--dir', boundedText(input.cwd, 'cwd', 4096)];
  if (input.scope === 'committed') args.push('--committed');
  if (input.scope === 'uncommitted') args.push('--uncommitted');
  if (input.base !== undefined) args.push('--base', boundedText(input.base, 'base', 256));
  return args;
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

export async function runCodeRabbitReview(
  input: { cwd: string; scope?: CodeRabbitReviewScope; base?: string },
  executor: ExternalCommandExecutor = defaultExecutor
): Promise<ExternalAiResult> {
  const normalized = { ...input, scope: input.scope ?? 'all' };
  const args = codeRabbitArgs(normalized);
  let firstError: unknown = null;
  for (const binary of ['coderabbit', 'cr'] as const) {
    try {
      const result = await executor(binary, args, commandOptions(input.cwd));
      return { binary, ...boundedOutput(result.stdout, result.stderr) };
    } catch (error) {
      if (binary === 'coderabbit' && isMissingExecutable(error)) {
        firstError = error;
        continue;
      }
      throw externalFailure(binary, error);
    }
  }
  throw externalFailure('coderabbit', firstError ?? new Error('not installed'));
}
