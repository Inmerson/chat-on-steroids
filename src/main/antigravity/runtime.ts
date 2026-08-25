import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { childEnv, terminateProcessTree } from '../exec.js';

export const ANTIGRAVITY_MODEL = 'gemini-3.7-flash-low';

const ANTIGRAVITY_EFFORT = 'low';
const ANTIGRAVITY_OUTPUT_BYTES = 64 * 1024;
const ANTIGRAVITY_FINAL_BYTES = 16 * 1024;
const ANTIGRAVITY_PROCESS_GRACE_MS = 5_000;
const API_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY'
] as const;

export interface AntigravityRunRequest {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  hardToolCalls: number;
  allowPartial: boolean;
  projectId?: string | null;
  newProject?: boolean;
}

export interface AntigravityRunResult {
  finalText: string;
  observedFiles: string[];
  toolErrors: string[];
  toolCalls: number;
  conversationId: string | null;
  durationSeconds: number | null;
  totalTokens: number | null;
  partial: boolean;
  budgetExceeded: boolean;
}

interface BoundedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  budgetExceeded: boolean;
}

interface ParseOptions {
  allowPartial?: boolean;
  budgetExceeded?: boolean;
}

type RunOverride = (request: AntigravityRunRequest) => Promise<AntigravityRunResult>;

let runOverride: RunOverride | null = null;

function envKey(env: NodeJS.ProcessEnv, requested: string): string | null {
  const lowered = requested.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lowered) ?? null;
}

function deleteEnv(env: NodeJS.ProcessEnv, requested: string): void {
  const key = envKey(env, requested);
  if (key) delete env[key];
}

function prependGitGrep(env: NodeJS.ProcessEnv): void {
  if (process.platform !== 'win32') return;
  const programFiles = envKey(env, 'ProgramFiles');
  const root = (programFiles ? env[programFiles] : undefined) || process.env['ProgramFiles'] || 'C:\\Program Files';
  const gitBin = path.join(root, 'Git', 'usr', 'bin');
  if (!existsSync(path.join(gitBin, 'grep.exe'))) return;
  const key = envKey(env, 'Path') ?? 'Path';
  const current = env[key] ?? '';
  const parts = current.split(path.delimiter).filter(Boolean);
  if (!parts.some((entry) => entry.toLowerCase() === gitBin.toLowerCase())) {
    env[key] = [gitBin, ...parts].join(path.delimiter);
  }
}

function antigravityChildEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...(base ?? childEnv()) };
  for (const name of API_ENV_NAMES) deleteEnv(env, name);
  prependGitGrep(env);
  return env;
}

function buildAntigravityArgs(request: AntigravityRunRequest): string[] {
  const args = [
    '-p',
    request.prompt,
    '--model',
    ANTIGRAVITY_MODEL,
    '--effort',
    ANTIGRAVITY_EFFORT,
    '--mode',
    'plan',
    '--sandbox',
    '--output-format',
    'stream-json'
  ];
  if (request.projectId) args.push('--project', request.projectId);
  else if (request.newProject === true) args.push('--new-project');
  args.push('--print-timeout', `${Math.max(1, Math.ceil(request.timeoutMs / 1000))}s`);
  return args;
}

function boundedAppend(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, maxBytes: number): void {
  const room = maxBytes - state.bytes;
  if (room <= 0) {
    state.truncated = true;
    return;
  }
  if (chunk.byteLength <= room) {
    chunks.push(chunk);
    state.bytes += chunk.byteLength;
    return;
  }
  chunks.push(chunk.subarray(0, room));
  state.bytes += room;
  state.truncated = true;
}

function toolStepKey(update: Record<string, unknown>, anonymous: number): string {
  const stepIndex = update['step_index'];
  if (typeof stepIndex === 'number' || typeof stepIndex === 'string') return String(stepIndex);
  return `anonymous-${anonymous}`;
}

function isToolStepStart(event: Record<string, unknown>): { key: string | null; anonymous: boolean } {
  if (event['event'] !== 'step_update') return { key: null, anonymous: false };
  const raw = event['step_update'];
  if (!raw || typeof raw !== 'object') return { key: null, anonymous: false };
  const update = raw as Record<string, unknown>;
  if (update['step_type'] !== 'tool') return { key: null, anonymous: false };
  const state = typeof update['state'] === 'string' ? update['state'].toUpperCase() : '';
  if (state && !['ACTIVE', 'RUNNING', 'STARTED', 'PENDING', 'DONE', 'ERROR', 'FAILED', 'SUCCESS'].includes(state)) {
    return { key: null, anonymous: false };
  }
  const hasIndex = typeof update['step_index'] === 'number' || typeof update['step_index'] === 'string';
  return { key: toolStepKey(update, 0), anonymous: !hasIndex };
}

async function runBoundedProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxBytes = ANTIGRAVITY_OUTPUT_BYTES,
  maxToolCalls = Number.POSITIVE_INFINITY
): Promise<BoundedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: antigravityChildEnv(),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outState = { bytes: 0, truncated: false };
    const errState = { bytes: 0, truncated: false };
    const decoder = new StringDecoder('utf8');
    let lineBuffer = '';
    let anonymousTool = 0;
    const toolSteps = new Set<string>();
    let budgetExceeded = false;
    let timedOut = false;
    let settled = false;
    let stopping = false;

    const stopTree = (): void => {
      if (stopping) return;
      stopping = true;
      if (child.pid) {
        void terminateProcessTree(child.pid).catch(() => {
          try {
            child.kill();
          } catch {
            // Process already exited.
          }
        });
      } else {
        try {
          child.kill();
        } catch {
          // Process already exited.
        }
      }
    };

    const inspectLine = (rawLine: string): void => {
      if (budgetExceeded || !Number.isFinite(maxToolCalls)) return;
      const line = rawLine.trim();
      if (!line.startsWith('{')) return;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const info = isToolStepStart(parsed);
        if (!info.key) return;
        const key = info.anonymous ? `anonymous-${anonymousTool++}` : info.key;
        toolSteps.add(key);
        if (toolSteps.size > maxToolCalls) {
          budgetExceeded = true;
          stopTree();
        }
      } catch {
        // Partial stream lines and diagnostics are ordinary output.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, Math.max(1, timeoutMs));

    child.stdout?.on('data', (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      boundedAppend(stdout, chunk, outState, maxBytes);
      const text = decoder.write(chunk);
      lineBuffer += text;
      for (;;) {
        const newline = lineBuffer.indexOf('\n');
        if (newline < 0) break;
        inspectLine(lineBuffer.slice(0, newline));
        lineBuffer = lineBuffer.slice(newline + 1);
      }
    });
    child.stderr?.on('data', (raw: Buffer | string) => {
      boundedAppend(stderr, Buffer.isBuffer(raw) ? raw : Buffer.from(raw), errState, maxBytes);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = decoder.end();
      if (tail) lineBuffer += tail;
      if (lineBuffer.trim()) inspectLine(lineBuffer);
      if (timedOut) {
        reject(new Error(`Antigravity process timed out after ${Math.max(1, timeoutMs)} ms.`));
        return;
      }
      resolve({
        exitCode: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated: outState.truncated || errState.truncated,
        timedOut: false,
        budgetExceeded
      });
    });
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  const input = Buffer.from(value, 'utf8');
  if (input.byteLength <= maxBytes) return value;
  return input.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeHostPaths(value: string, cwd: string): string {
  let out = value;
  const native = path.resolve(cwd);
  const slash = native.replace(/\\/g, '/');
  for (const form of [native, slash]) {
    out = out.replace(new RegExp(escapeRegex(form), 'gi'), '.');
  }
  out = out.replace(/file:\/\/[A-Za-z]:[\\/][^\s)\]>'"`]+/gi, '<host-path>');
  out = out.replace(/[A-Za-z]:[\\/][^\s)\]>'"`]+/g, '<host-path>');
  return out;
}

function relativeObservedPath(candidate: string, cwd: string): string | null {
  const trimmed = candidate.trim().replace(/^file:\/\//i, '');
  if (!trimmed || trimmed.includes('\n')) return null;
  const normalizedCandidate = trimmed.replace(/\//g, path.sep);
  const resolved = path.isAbsolute(normalizedCandidate) ? path.resolve(normalizedCandidate) : path.resolve(cwd, normalizedCandidate);
  const relative = path.relative(path.resolve(cwd), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const extension = path.extname(relative);
  if (!extension) return null;
  return relative.split(path.sep).join('/');
}

function parameterStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) parameterStrings(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value as Record<string, unknown>)) parameterStrings(item, out);
}

function parseAntigravityStream(stdout: string, cwd: string, options: ParseOptions = {}): AntigravityRunResult {
  let conversationId: string | null = null;
  let finalResult: Record<string, unknown> | null = null;
  let lastAgentText = '';
  const toolSteps = new Set<string>();
  const observedFiles = new Set<string>();
  const toolErrors: string[] = [];
  let anonymousTool = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event['event'] === 'init' && typeof event['conversation_id'] === 'string') {
      conversationId = event['conversation_id'];
      continue;
    }
    if (event['event'] === 'result' && event['result'] && typeof event['result'] === 'object') {
      finalResult = event['result'] as Record<string, unknown>;
      if (typeof finalResult['conversation_id'] === 'string') conversationId = finalResult['conversation_id'];
      continue;
    }
    if (event['event'] !== 'step_update' || !event['step_update'] || typeof event['step_update'] !== 'object') continue;
    const update = event['step_update'] as Record<string, unknown>;
    if (update['step_type'] === 'agent_response') {
      const delta = update['text_delta'];
      if (typeof delta === 'string' && delta) lastAgentText += delta;
      continue;
    }
    if (update['step_type'] !== 'tool') continue;
    const hasIndex = typeof update['step_index'] === 'number' || typeof update['step_index'] === 'string';
    const key = hasIndex ? String(update['step_index']) : `anonymous-${anonymousTool++}`;
    toolSteps.add(key);
    const toolInfo = update['tool_info'];
    if (toolInfo && typeof toolInfo === 'object') {
      const info = toolInfo as Record<string, unknown>;
      const strings: string[] = [];
      parameterStrings(info['parameters'], strings);
      for (const candidate of strings) {
        const relative = relativeObservedPath(candidate, cwd);
        if (relative) observedFiles.add(relative);
      }
      const error = info['error'];
      let detail = '';
      if (typeof error === 'string') detail = error;
      else if (error && typeof error === 'object' && typeof (error as Record<string, unknown>)['message'] === 'string') {
        detail = String((error as Record<string, unknown>)['message']);
      }
      if (detail) {
        const toolName = typeof update['tool_name'] === 'string' ? update['tool_name'] : 'tool';
        toolErrors.push(truncateUtf8(sanitizeHostPaths(`${toolName}: ${detail}`, cwd), 1_200));
      }
    }
  }

  const budgetExceeded = options.budgetExceeded === true;
  if (!finalResult) {
    if (!options.allowPartial) throw new Error('Antigravity stream ended without a final result event.');
    return {
      finalText: truncateUtf8(
        sanitizeHostPaths(
          lastAgentText.trim() || 'Antigravity stopped before a final result; only the observed partial evidence is available.',
          cwd
        ),
        ANTIGRAVITY_FINAL_BYTES
      ),
      observedFiles: [...observedFiles].sort().slice(0, 30),
      toolErrors: toolErrors.slice(0, 20),
      toolCalls: toolSteps.size,
      conversationId,
      durationSeconds: null,
      totalTokens: null,
      partial: true,
      budgetExceeded
    };
  }

  if (finalResult['status'] !== 'SUCCESS') {
    const detail =
      typeof finalResult['error'] === 'string' && finalResult['error'].trim()
        ? sanitizeHostPaths(finalResult['error'].trim(), cwd)
        : 'Antigravity returned a failed result.';
    if (!(options.allowPartial && budgetExceeded)) throw new Error(truncateUtf8(detail, 1_200));
    return {
      finalText: truncateUtf8(sanitizeHostPaths(lastAgentText.trim() || detail, cwd), ANTIGRAVITY_FINAL_BYTES),
      observedFiles: [...observedFiles].sort().slice(0, 30),
      toolErrors: toolErrors.slice(0, 20),
      toolCalls: toolSteps.size,
      conversationId,
      durationSeconds: null,
      totalTokens: null,
      partial: true,
      budgetExceeded: true
    };
  }

  const response = typeof finalResult['response'] === 'string' ? finalResult['response'].trim() : '';
  if (!response) throw new Error('Antigravity returned an empty successful result.');
  const usage = finalResult['usage'];
  const totalTokens =
    usage && typeof usage === 'object' && typeof (usage as Record<string, unknown>)['total_tokens'] === 'number'
      ? ((usage as Record<string, unknown>)['total_tokens'] as number)
      : null;
  return {
    finalText: truncateUtf8(sanitizeHostPaths(response, cwd), ANTIGRAVITY_FINAL_BYTES),
    observedFiles: [...observedFiles].sort().slice(0, 30),
    toolErrors: toolErrors.slice(0, 20),
    toolCalls: toolSteps.size,
    conversationId,
    durationSeconds: typeof finalResult['duration_seconds'] === 'number' ? finalResult['duration_seconds'] : null,
    totalTokens,
    partial: false,
    budgetExceeded: false
  };
}

function findAntigravityCli(): string {
  const local = process.env['LOCALAPPDATA'];
  const profile = process.env['USERPROFILE'];
  const candidates = [
    local ? path.join(local, 'agy', 'bin', 'agy.exe') : '',
    profile ? path.join(profile, 'AppData', 'Local', 'agy', 'bin', 'agy.exe') : ''
  ].filter(Boolean);
  const pathKey = envKey(process.env, 'Path');
  const pathValue = pathKey ? process.env[pathKey] ?? '' : '';
  for (const entry of pathValue.split(path.delimiter).filter(Boolean).slice(0, 128)) {
    candidates.push(path.join(entry, process.platform === 'win32' ? 'agy.exe' : 'agy'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}

export async function runAntigravity(request: AntigravityRunRequest): Promise<AntigravityRunResult> {
  if (runOverride) return runOverride(request);
  const result = await runBoundedProcess(
    findAntigravityCli(),
    buildAntigravityArgs(request),
    request.cwd,
    request.timeoutMs + ANTIGRAVITY_PROCESS_GRACE_MS,
    ANTIGRAVITY_OUTPUT_BYTES,
    request.hardToolCalls
  );
  try {
    return parseAntigravityStream(result.stdout, request.cwd, {
      allowPartial: request.allowPartial && result.budgetExceeded,
      budgetExceeded: result.budgetExceeded
    });
  } catch (error) {
    if (result.exitCode !== 0 && result.stderr.trim()) {
      const detail = truncateUtf8(sanitizeHostPaths(result.stderr.trim(), request.cwd), 1_200);
      throw new Error(`${(error as Error).message} ${detail}`);
    }
    throw error;
  }
}

export function setAntigravityProcessRunnerForTests(runner: RunOverride | null): void {
  runOverride = runner;
}

/** Test seams for the bounded process/stream contract. */
export const buildAntigravityArgsForTests = buildAntigravityArgs;
export const antigravityChildEnvForTests = antigravityChildEnv;
export const parseAntigravityStreamForTests = parseAntigravityStream;
export const runBoundedProcessForTests = runBoundedProcess;
