import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ANTIGRAVITY_MODEL, runAntigravity, type AntigravityRunResult } from './runtime.js';

const TARGET_TOOL_CALLS = 6;
const MAX_TOOL_CALLS = 8;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PROJECT_FILES = 128;
const MAX_PROJECT_FILE_BYTES = 64 * 1024;
const HANDOFF_BYTES = 16 * 1024;

export interface AntigravityInvestigation {
  report: string;
  observedFiles: string[];
  toolErrors: string[];
  toolCalls: number;
  conversationId: string | null;
  durationSeconds: number | null;
  totalTokens: number | null;
  partial: boolean;
  budgetExceeded: boolean;
}

type InvestigatorOverride = (input: { task: string; cwd: string }) => Promise<AntigravityInvestigation>;

let investigatorOverride: InvestigatorOverride | null = null;

function projectsDir(): string {
  return path.join(os.homedir(), '.gemini', 'config', 'projects');
}

function normalizeFsPath(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function folderUriPath(value: string): string | null {
  if (!value.toLowerCase().startsWith('file://')) return null;
  let raw = value.slice('file://'.length);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
  return raw.replace(/\//g, path.sep);
}

async function findAntigravityProjectId(cwd: string, directory = projectsDir()): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const target = normalizeFsPath(cwd);
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json')).slice(0, MAX_PROJECT_FILES)) {
    try {
      const text = await readFile(path.join(directory, entry.name), 'utf8');
      if (Buffer.byteLength(text, 'utf8') > MAX_PROJECT_FILE_BYTES) continue;
      const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as {
        id?: unknown;
        projectResources?: { resources?: Array<{ folderUri?: unknown }> };
      };
      if (typeof parsed.id !== 'string' || !parsed.id) continue;
      const resources = parsed.projectResources?.resources ?? [];
      const matches = resources.some((resource) => {
        if (typeof resource.folderUri !== 'string') return false;
        const folder = folderUriPath(resource.folderUri);
        return folder !== null && normalizeFsPath(folder) === target;
      });
      if (matches) return parsed.id;
    } catch {
      // One stale/corrupt Antigravity project file must not disable the fast lane.
    }
  }
  return null;
}

function investigatorPrompt(task: string): string {
  return [
    'Fast advisory investigation for Chat On Steroids Prime.',
    'Read-only reconnaissance only. Do not edit files, run release/deploy actions, or make final verification claims.',
    `Finish the useful investigation within ${TARGET_TOOL_CALLS} tool calls when possible; prioritize direct source evidence.`,
    'Return a compact root-cause/evidence report. Prime will independently verify every consequential claim.',
    '',
    `Task: ${task.trim()}`
  ].join('\n');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const input = Buffer.from(value, 'utf8');
  if (input.length <= maxBytes) return value;
  return input.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '');
}

function projectResult(result: AntigravityRunResult): AntigravityInvestigation {
  return {
    report: result.finalText,
    observedFiles: result.observedFiles,
    toolErrors: result.toolErrors,
    toolCalls: result.toolCalls,
    conversationId: result.conversationId,
    durationSeconds: result.durationSeconds,
    totalTokens: result.totalTokens,
    partial: result.partial,
    budgetExceeded: result.budgetExceeded
  };
}

async function runInvestigator(input: { task: string; cwd: string }): Promise<AntigravityInvestigation> {
  const projectId = await findAntigravityProjectId(input.cwd);
  const result = await runAntigravity({
    prompt: investigatorPrompt(input.task),
    cwd: input.cwd,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    hardToolCalls: MAX_TOOL_CALLS,
    allowPartial: true,
    projectId,
    newProject: projectId === null
  });
  return projectResult(result);
}

export function investigateWithAntigravity(input: { task: string; cwd: string }): Promise<AntigravityInvestigation> {
  return (investigatorOverride ?? runInvestigator)(input);
}

export function setAntigravityInvestigatorForTests(investigator: InvestigatorOverride | null): void {
  investigatorOverride = investigator;
}

export function formatAntigravityInvestigation(result: AntigravityInvestigation): string {
  const lines = ['Antigravity Flash investigator (advisory; Prime must independently verify):', result.report];
  if (result.observedFiles.length > 0) {
    lines.push('', 'Observed source files:', ...result.observedFiles.map((file) => `- ${file}`));
  }
  if (result.partial && result.budgetExceeded) {
    lines.push('', `Fast Lane stopped at the ${MAX_TOOL_CALLS}-tool budget; treat this as partial evidence only.`);
  }
  if (result.toolErrors.length > 0) {
    lines.push('', 'Tool warnings:', ...result.toolErrors.map((error) => `- ${error}`));
  }
  lines.push('', `Evidence telemetry: ${result.toolCalls} tool call(s) observed.`);
  return truncateUtf8(lines.join('\n'), HANDOFF_BYTES);
}

export { ANTIGRAVITY_MODEL };

/** Test seam for exact project-folder matching. */
export const findAntigravityProjectIdForTests = findAntigravityProjectId;
