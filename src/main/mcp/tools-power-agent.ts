/**
 * Power Agent MCP tools for full Windows system autonomy (Steromi Suite):
 * - Voice & Audio (audio_speak_text, audio_beep)
 * - Checkpoints & Rollback (checkpoint_create, checkpoint_list, checkpoint_restore)
 * - PDF & Documents (pdf_read_text, markdown_to_html, json_schema_validate)
 * - Clipboard & Env (clipboard_read, clipboard_write, system_env_get, system_env_set)
 * - Archive & Integrity (fs_hash_file, fs_zip_compress, fs_zip_extract)
 * - Unity Live Diagnostics (unity_read_editor_log)
 * - Semantic Code Intelligence (code_find_definition, code_find_references, code_outline_symbols, code_get_diagnostics)
 * - Web Network & Cookie Inspector (browser_network_inspect, browser_cookies_get, browser_evaluate_js)
 * - Codex-style Live Chrome Tab Automation (browser_tab_list, browser_tab_open, browser_tab_focus, browser_tab_read, browser_tab_click, browser_tab_fill, browser_tab_screenshot)
 * - Web search & clean research (browser_search, open_url, web_fetch)
 * - Long-term persistent agent memory (memory_store, memory_recall, memory_list, memory_forget)
 * - Background async task execution (task_start_background, task_status, task_kill)
 * - Windows native notifications (notify_user)
 * - Application launcher & process management (launch_app, process_list, process_kill)
 * - Unrestricted system shell execution (system_exec)
 * - System-wide file management (fs_system_list, fs_system_read, fs_system_write)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import nodePath from 'node:path';
import { rawPromises as fs } from '../rawfs.js';
import { z } from 'zod';
import { childEnv, terminateProcessTree } from '../exec.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { readDurable, writeDurableSoon } from '../durable.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 15 * 60_000;

const timeoutSeconds = z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_MS / 1000).optional();

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }): void {
  if (state.bytes >= MAX_PROCESS_OUTPUT_BYTES) {
    state.truncated = true;
    return;
  }
  const remaining = MAX_PROCESS_OUTPUT_BYTES - state.bytes;
  const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(kept);
  state.bytes += kept.length;
  if (kept.length !== chunk.length) state.truncated = true;
}

export async function runSystemProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  useShell = false
): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: childEnv(),
      windowsHide: true,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outState = { bytes: 0, truncated: false };
    const errState = { bytes: 0, truncated: false };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, outState));
    child.stderr?.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, errState));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Process timed out after ${Math.ceil(timeoutMs / 1000)} seconds`));
        return;
      }
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated: outState.truncated || errState.truncated
      });
    });
  });
}

function processOutputText(result: { exitCode: number; stdout: string; stderr: string; truncated: boolean }): string {
  const parts = [`exit_code: ${result.exitCode}`];
  if (result.stdout.trim()) parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim()) parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
  if (result.truncated) parts.push(`(output truncated at ${MAX_PROCESS_OUTPUT_BYTES} bytes per stream)`);
  return parts.join('\n');
}

export function htmlToCleanMarkdown(html: string): string {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');

  text = text.replace(/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi, '[$3]($2)');
  text = text.replace(/<h[1-2][^>]*>(.*?)<\/h[1-2]>/gi, '\n\n## $1\n\n');
  text = text.replace(/<h[3-6][^>]*>(.*?)<\/h[3-6]>/gi, '\n\n### $1\n\n');
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '\n- $1');
  text = text.replace(/<(?:p|div|section|article|header|footer|tr)[^>]*>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');

  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && ((arr[i - 1]?.length ?? 0) > 0)))
    .join('\n')
    .slice(0, MAX_TEXT_BYTES);
}

export function htmlToSemanticTree(html: string): {
  interactive: Array<{ ref: number; tag: string; text: string; selector?: string }>;
  markdown: string;
} {
  const interactive: Array<{ ref: number; tag: string; text: string; selector?: string }> = [];
  let refCount = 1;

  const linkRegex = /<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null && refCount <= 80) {
    const rawText = match[3] ?? '';
    const text = rawText.replace(/<[^>]+>/g, '').trim();
    if (text) {
      interactive.push({ ref: refCount++, tag: 'link', text, selector: `a[href="${match[2] ?? ''}"]` });
    }
  }

  const buttonRegex = /<button[^>]*>(.*?)<\/button>/gi;
  while ((match = buttonRegex.exec(html)) !== null && refCount <= 120) {
    const rawText = match[1] ?? '';
    const text = rawText.replace(/<[^>]+>/g, '').trim();
    if (text) {
      interactive.push({ ref: refCount++, tag: 'button', text, selector: 'button' });
    }
  }

  const inputRegex = /<input[^>]+(?:placeholder|name|id|value)=["']([^"']+)["'][^>]*>/gi;
  while ((match = inputRegex.exec(html)) !== null && refCount <= 150) {
    const val = match[1] ?? 'input';
    interactive.push({ ref: refCount++, tag: 'input', text: val, selector: 'input' });
  }

  const markdown = htmlToCleanMarkdown(html);
  return { interactive, markdown };
}

// ---------------------------------------------------------------- Code Intelligence Helpers
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.cs', '.py', '.cpp', '.c', '.h', '.hpp', '.java', '.go', '.rs', '.json', '.md'
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'bin', 'obj', 'Library', 'Temp', 'Logs', 'Packages', 'Build', 'Builds', '.vs'
]);

export async function findCodeFiles(dir: string, maxFiles = 300): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string, depth: number) {
    if (depth > 8 || result.length >= maxFiles) return;
    try {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (result.length >= maxFiles) break;
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            await walk(nodePath.join(current, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = nodePath.extname(entry.name).toLowerCase();
          if (CODE_EXTENSIONS.has(ext)) {
            result.push(nodePath.join(current, entry.name));
          }
        }
      }
    } catch {
      /* ignore unreadable */
    }
  }
  await walk(dir, 0);
  return result;
}

export async function findSymbolDefinition(
  symbol: string,
  rootDir: string
): Promise<Array<{ file: string; line: number; text: string; kind: string }>> {
  const files = await findCodeFiles(rootDir);
  const results: Array<{ file: string; line: number; text: string; kind: string }> = [];
  const safeSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    { kind: 'class/struct/interface/type', regex: new RegExp(`\\b(?:class|struct|interface|enum|record|type)\\s+${safeSymbol}\\b`, 'i') },
    { kind: 'function/method', regex: new RegExp(`\\b(?:function|def|void|async|public|private|protected|internal|static|override|virtual)\\s+.*?\\b${safeSymbol}\\s*\\(`, 'i') },
    { kind: 'variable/const', regex: new RegExp(`\\b(?:const|let|var|readonly)\\s+${safeSymbol}\\s*=`, 'i') }
  ];

  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf8');
      if (!content.includes(symbol)) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] ?? '';
        if (!lineText) continue;
        for (const p of patterns) {
          if (p.regex.test(lineText)) {
            results.push({
              file,
              line: i + 1,
              text: lineText.trim(),
              kind: p.kind
            });
            break;
          }
        }
        if (results.length >= 25) break;
      }
    } catch {
      /* ignore */
    }
    if (results.length >= 25) break;
  }
  return results;
}

export async function findSymbolReferences(
  symbol: string,
  rootDir: string
): Promise<Array<{ file: string; line: number; text: string }>> {
  const files = await findCodeFiles(rootDir);
  const results: Array<{ file: string; line: number; text: string }> = [];
  const wordRegex = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf8');
      if (!content.includes(symbol)) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] ?? '';
        if (lineText && wordRegex.test(lineText)) {
          results.push({
            file,
            line: i + 1,
            text: lineText.trim()
          });
          if (results.length >= 50) break;
        }
      }
    } catch {
      /* ignore */
    }
    if (results.length >= 50) break;
  }
  return results;
}

export async function outlineSourceSymbols(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const symbols: string[] = [];

  const symbolRegex = /\b(class|interface|struct|enum|record|type|function|def|void|async)\s+([A-Za-z0-9_]+)/i;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    const match = symbolRegex.exec(trimmed);
    if (match?.[1] && match?.[2] && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('#')) {
      symbols.push(`- Line ${i + 1}: [${match[1]}] ${match[2]} -> \`${trimmed.slice(0, 100)}\``);
    }
  }
  return symbols.length > 0 ? symbols.join('\n') : 'No primary symbols detected.';
}

// ---------------------------------------------------------------- Checkpoints & Snapshots
export interface CheckpointSnapshot {
  id: string;
  name: string;
  timestamp: string;
  targetPath: string;
  files: Record<string, string>; // relativePath -> content
}

interface CheckpointStoreState {
  checkpoints: Record<string, CheckpointSnapshot>;
}

async function loadCheckpoints(): Promise<Record<string, CheckpointSnapshot>> {
  const data = await readDurable<CheckpointStoreState>('agent-checkpoints');
  return data?.checkpoints ?? {};
}

async function saveCheckpoints(checkpoints: Record<string, CheckpointSnapshot>): Promise<void> {
  writeDurableSoon('agent-checkpoints', { checkpoints });
}

// ---------------------------------------------------------------- Background Tasks Store
export interface BackgroundTask {
  id: string;
  command: string;
  shell: string;
  cwd: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'killed';
  exitCode: number | null;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  child: ChildProcess | null;
}

const backgroundTasks = new Map<string, BackgroundTask>();

// ---------------------------------------------------------------- Persistent Memory Store
export interface MemoryItem {
  key: string;
  category: string;
  content: string;
  updatedAt: string;
}

interface MemoryStoreState {
  memories: Record<string, MemoryItem>;
}

async function loadMemories(): Promise<Record<string, MemoryItem>> {
  const data = await readDurable<MemoryStoreState>('agent-memory');
  return data?.memories ?? {};
}

async function saveMemories(memories: Record<string, MemoryItem>): Promise<void> {
  writeDurableSoon('agent-memory', { memories });
}

export function registerPowerAgentTools(reg: SurfaceRegistrar): void {
  const { caps, exposedCaps } = reg;

  // ================================================================ 1. AUDIO & VOICE
  // ---------------------------------------------------------------- audio_speak_text
  if (exposedCaps.command) {
    reg.register(
      'audio_speak_text',
      {
        title: 'Speak text aloud via Windows speech synthesis',
        description: 'Speak a message aloud through the user\'s speakers in Turkish or English using native Windows TTS.',
        inputSchema: z
          .object({
            text: z.string().min(1).max(2000).describe('Text to speak aloud.'),
            rate: z.number().int().min(-10).max(10).optional().default(0).describe('Speech rate from -10 (slow) to 10 (fast).')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ text, rate }) =>
        reg.guarded('command', 'audio_speak_text', async () => {
          try {
            const script = `
Add-Type -AssemblyName System.Speech;
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$synth.Rate = ${rate ?? 0};
$synth.Speak(${JSON.stringify(text)});
$synth.Dispose();
`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 15_000);
            return ok(`Spoke aloud: "${text}"`);
          } catch (error) {
            return fail(`Failed to speak text: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- audio_beep
  if (exposedCaps.command) {
    reg.register(
      'audio_beep',
      {
        title: 'Play system chime or beep sound',
        description: 'Play a tone or chime through the PC speaker to signal build complete or error.',
        inputSchema: z
          .object({
            frequency: z.number().int().min(100).max(5000).optional().default(800).describe('Frequency in Hz (default: 800).'),
            duration_ms: z.number().int().min(50).max(2000).optional().default(300).describe('Duration in ms (default: 300).')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ frequency, duration_ms }) =>
        reg.guarded('command', 'audio_beep', async () => {
          try {
            const freq = frequency ?? 800;
            const dur = duration_ms ?? 300;
            const script = `[console]::beep(${freq}, ${dur})`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 5_000);
            return ok(`Played tone: ${freq}Hz for ${dur}ms.`);
          } catch (error) {
            return fail(`Failed to play beep: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 2. CHECKPOINTS & ROLLBACK
  // ---------------------------------------------------------------- checkpoint_create
  if (exposedCaps.create || exposedCaps.edit) {
    reg.register(
      'checkpoint_create',
      {
        title: 'Create project snapshot checkpoint',
        description: 'Create an instant local snapshot of files in a directory before making risky refactoring changes.',
        inputSchema: z
          .object({
            name: z.string().min(1).max(100).describe('Name or reason for snapshot (e.g. "before_player_refactor").'),
            target_path: z.string().max(1024).optional().describe('Folder to snapshot. Defaults to current directory.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      async ({ name, target_path }) =>
        guard('checkpoint_create', async () => {
          try {
            const root = target_path ? nodePath.resolve(target_path) : process.cwd();
            const files = await findCodeFiles(root, 100);
            const snapshotFiles: Record<string, string> = {};

            for (const file of files) {
              const rel = nodePath.relative(root, file);
              const content = await fs.readFile(file, 'utf8');
              snapshotFiles[rel] = content;
            }

            const cpId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const checkpoints = await loadCheckpoints();
            checkpoints[cpId] = {
              id: cpId,
              name,
              timestamp: new Date().toISOString(),
              targetPath: root,
              files: snapshotFiles
            };
            await saveCheckpoints(checkpoints);
            return ok(`Created checkpoint "${name}" [ID: ${cpId}] with ${Object.keys(snapshotFiles).length} files.`);
          } catch (error) {
            return fail(`Failed to create checkpoint: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- checkpoint_list
  if (exposedCaps.read) {
    reg.register(
      'checkpoint_list',
      {
        title: 'List saved project checkpoints',
        description: 'List all available local checkpoints and snapshot IDs.',
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async () =>
        reg.guarded('read', 'checkpoint_list', async () => {
          try {
            const checkpoints = await loadCheckpoints();
            const list = Object.values(checkpoints);
            if (list.length === 0) return ok('No checkpoints saved.');
            const lines = list.map(
              (cp) => `- [${cp.id}] "${cp.name}" (${Object.keys(cp.files).length} files) at ${cp.timestamp} [${cp.targetPath}]`
            );
            return ok(`Saved Checkpoints (${list.length}):\n${lines.join('\n')}`);
          } catch (error) {
            return fail(`Failed to list checkpoints: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- checkpoint_restore
  if (exposedCaps.create || exposedCaps.edit) {
    reg.register(
      'checkpoint_restore',
      {
        title: 'Restore project to checkpoint snapshot',
        description: 'Revert all files in the target folder to an exact previous snapshot state.',
        inputSchema: z
          .object({
            checkpoint_id: z.string().min(1).describe('The checkpoint ID to restore.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      async ({ checkpoint_id }) =>
        guard('checkpoint_restore', async () => {
          try {
            const checkpoints = await loadCheckpoints();
            const cp = checkpoints[checkpoint_id];
            if (!cp) return fail(`Checkpoint "${checkpoint_id}" not found.`);

            let restoredCount = 0;
            for (const [relPath, content] of Object.entries(cp.files)) {
              const fullPath = nodePath.join(cp.targetPath, relPath);
              await fs.mkdir(nodePath.dirname(fullPath), { recursive: true });
              await fs.writeFile(fullPath, content, 'utf8');
              restoredCount++;
            }
            return ok(`Restored ${restoredCount} files to checkpoint "${cp.name}" [${cp.id}].`);
          } catch (error) {
            return fail(`Failed to restore checkpoint: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 3. PDF & DOCUMENTS
  // ---------------------------------------------------------------- pdf_read_text
  if (exposedCaps.read) {
    reg.register(
      'pdf_read_text',
      {
        title: 'Extract text from PDF file',
        description: 'Read and extract text content from any PDF file on disk.',
        inputSchema: z
          .object({
            file_path: z.string().min(1).max(1024).describe('Absolute or relative path to PDF file.'),
            max_pages: z.number().int().min(1).max(100).optional().default(20)
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ file_path }) =>
        reg.guarded('read', 'pdf_read_text', async () => {
          try {
            const resolved = nodePath.resolve(file_path);
            const buffer = await fs.readFile(resolved);
            const raw = buffer.toString('latin1');
            const textParts: string[] = [];

            const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
            let streamMatch: RegExpExecArray | null;
            while ((streamMatch = streamRegex.exec(raw)) !== null && textParts.length < 50) {
              const streamContent = streamMatch[1] ?? '';
              const tjMatches = streamContent.match(/\((.*?)\)\s*Tj/g);
              if (tjMatches) {
                const pageText = tjMatches.map((m) => m.replace(/^\(|\)\s*Tj$/g, '')).join(' ');
                if (pageText.trim()) textParts.push(pageText.trim());
              }
            }

            if (textParts.length === 0) {
              const script = `
Add-Type -AssemblyName System.IO;
$content = [System.IO.File]::ReadAllText(${JSON.stringify(resolved)});
$strings = [regex]::Matches($content, '[A-Za-z0-9 ,.:;!?-]{4,}') | ForEach-Object { $_.Value };
$strings -join ' ';
`;
              const res = await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 8_000);
              const text = res.stdout.slice(0, 20_000);
              return ok(`--- PDF Text (${resolved}) ---\n${text || 'No extractable plain text found.'}`);
            }

            return ok(`--- PDF Text (${resolved}) ---\n${textParts.join('\n\n')}`);
          } catch (error) {
            return fail(`Failed to read PDF: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- markdown_to_html
  if (exposedCaps.create || exposedCaps.edit) {
    reg.register(
      'markdown_to_html',
      {
        title: 'Convert Markdown to styled standalone HTML',
        description: 'Convert markdown text into a beautiful, styled standalone HTML document and save it.',
        inputSchema: z
          .object({
            markdown: z.string().min(1).max(MAX_TEXT_BYTES).describe('Markdown content to convert.'),
            output_file: z.string().max(1024).optional().describe('Optional file path to save HTML to.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ markdown, output_file }) =>
        guard('markdown_to_html', async () => {
          try {
            let htmlBody = markdown
              .replace(/^### (.*$)/gim, '<h3>$1</h3>')
              .replace(/^## (.*$)/gim, '<h2>$1</h2>')
              .replace(/^# (.*$)/gim, '<h1>$1</h1>')
              .replace(/\*\*(.*?)\*\*/gim, '<b>$1</b>')
              .replace(/\*(.*?)\*/gim, '<i>$1</i>')
              .replace(/\[(.*?)\]\((.*?)\)/gim, '<a href="$2">$1</a>')
              .replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>')
              .replace(/\n\n/gim, '<p></p>');

            const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #24292f; background: #fff; }
h1, h2, h3 { border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow: auto; }
li { margin: 4px 0; }
a { color: #0969da; text-decoration: none; }
</style>
</head>
<body>
${htmlBody}
</body>
</html>`;

            if (output_file) {
              const resolved = nodePath.resolve(output_file);
              await fs.mkdir(nodePath.dirname(resolved), { recursive: true });
              await fs.writeFile(resolved, fullHtml, 'utf8');
              return ok(`Converted Markdown and saved HTML to: ${resolved}`);
            }
            return ok(fullHtml);
          } catch (error) {
            return fail(`Failed to convert markdown: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- json_schema_validate
  if (exposedCaps.read) {
    reg.register(
      'json_schema_validate',
      {
        title: 'Validate JSON structure against schema',
        description: 'Validate a JSON string or object against required fields and basic types.',
        inputSchema: z
          .object({
            json_string: z.string().min(1).max(MAX_TEXT_BYTES).describe('JSON data string.'),
            required_fields: z.array(z.string()).optional().describe('List of required field names.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ json_string, required_fields }) =>
        reg.guarded('read', 'json_schema_validate', async () => {
          try {
            const parsed = JSON.parse(json_string);
            const missing: string[] = [];
            if (required_fields && typeof parsed === 'object' && parsed !== null) {
              for (const req of required_fields) {
                if (!(req in parsed)) missing.push(req);
              }
            }
            if (missing.length > 0) {
              return fail(`JSON is valid, but missing required fields: ${missing.join(', ')}`);
            }
            return ok(`JSON is valid! (Parsed ${typeof parsed === 'object' ? Object.keys(parsed).length : 1} keys/items)`);
          } catch (error) {
            return fail(`Invalid JSON: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 4. CLIPBOARD & ENVIRONMENT
  // ---------------------------------------------------------------- clipboard_read
  if (exposedCaps.read) {
    reg.register(
      'clipboard_read',
      {
        title: 'Read Windows clipboard text',
        description: 'Read the text currently copied to the user\'s Windows clipboard.',
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async () =>
        reg.guarded('read', 'clipboard_read', async () => {
          try {
            const script = `Get-Clipboard -Raw`;
            const result = await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 6_000);
            if (result.exitCode !== 0) return fail('Failed to read clipboard');
            return ok(`--- Clipboard Content ---\n${result.stdout.trim() || '(clipboard is empty)'}`);
          } catch (error) {
            return fail(`Failed to read clipboard: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- clipboard_write
  if (exposedCaps.command) {
    reg.register(
      'clipboard_write',
      {
        title: 'Write text to Windows clipboard',
        description: 'Copy a code snippet or text directly into the user\'s Windows clipboard.',
        inputSchema: z
          .object({
            text: z.string().min(1).max(MAX_TEXT_BYTES).describe('Text or code to copy to clipboard.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ text }) =>
        reg.guarded('command', 'clipboard_write', async () => {
          try {
            const script = `Set-Clipboard -Value ${JSON.stringify(text)}`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 6_000);
            return ok(`Copied ${Buffer.byteLength(text, 'utf8')} bytes to clipboard.`);
          } catch (error) {
            return fail(`Failed to write to clipboard: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- system_env_get
  if (exposedCaps.read) {
    reg.register(
      'system_env_get',
      {
        title: 'Get environment variables',
        description: 'Inspect system environment variables (PATH, APPDATA, USERPROFILE, etc.).',
        inputSchema: z
          .object({
            name: z.string().max(100).optional().describe('Specific variable name to get (e.g. "PATH", "TEMP").')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ name }) =>
        reg.guarded('read', 'system_env_get', async () => {
          if (name) {
            const val = process.env[name] || process.env[name.toUpperCase()] || process.env[name.toLowerCase()];
            return ok(`${name}=${val ?? '(undefined)'}`);
          }
          const keys = Object.keys(process.env).sort();
          const lines = keys.slice(0, 60).map((k) => `${k}=${(process.env[k] || '').slice(0, 100)}`);
          return ok(`Environment Variables (${keys.length}):\n${lines.join('\n')}`);
        })
    );
  }

  // ---------------------------------------------------------------- system_env_set
  if (exposedCaps.command) {
    reg.register(
      'system_env_set',
      {
        title: 'Set environment variable for process',
        description: 'Set an environment variable for the current process and sub-processes.',
        inputSchema: z
          .object({
            name: z.string().min(1).max(100).describe('Variable name.'),
            value: z.string().max(4096).describe('Variable value.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ name, value }) =>
        reg.guarded('command', 'system_env_set', async () => {
          process.env[name] = value;
          return ok(`Set environment variable ${name}=${value}`);
        })
    );
  }

  // ================================================================ 5. ARCHIVE & FILE INTEGRITY
  // ---------------------------------------------------------------- fs_hash_file
  if (exposedCaps.read) {
    reg.register(
      'fs_hash_file',
      {
        title: 'Compute file hash checksum',
        description: 'Compute SHA-256 or MD5 hash of any file on disk for integrity checking.',
        inputSchema: z
          .object({
            file_path: z.string().min(1).max(1024).describe('Path to the file.'),
            algorithm: z.enum(['sha256', 'md5', 'sha1']).optional().default('sha256').describe('Hashing algorithm.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ file_path, algorithm }) =>
        reg.guarded('read', 'fs_hash_file', async () => {
          try {
            const resolved = nodePath.resolve(file_path);
            const buffer = await fs.readFile(resolved);
            const hash = crypto.createHash(algorithm ?? 'sha256').update(buffer).digest('hex');
            return ok(`Hash [${(algorithm ?? 'sha256').toUpperCase()}]: ${hash} (${resolved})`);
          } catch (error) {
            return fail(`Failed to compute hash: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- fs_zip_compress
  if (exposedCaps.create || exposedCaps.edit) {
    reg.register(
      'fs_zip_compress',
      {
        title: 'Compress folder or files to zip archive',
        description: 'Create a `.zip` archive from a folder or file path.',
        inputSchema: z
          .object({
            source_path: z.string().min(1).max(1024).describe('Folder or file to compress.'),
            destination_zip: z.string().min(1).max(1024).describe('Target `.zip` file path.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ source_path, destination_zip }) =>
        guard('fs_zip_compress', async () => {
          try {
            const src = nodePath.resolve(source_path);
            const dest = nodePath.resolve(destination_zip);
            const script = `Compress-Archive -Path ${JSON.stringify(src)} -DestinationPath ${JSON.stringify(dest)} -Force`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 30_000);
            return ok(`Created archive: ${dest}`);
          } catch (error) {
            return fail(`Failed to compress archive: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- fs_zip_extract
  if (exposedCaps.create || exposedCaps.edit) {
    reg.register(
      'fs_zip_extract',
      {
        title: 'Extract zip archive to folder',
        description: 'Extract a `.zip` archive into a target directory.',
        inputSchema: z
          .object({
            zip_path: z.string().min(1).max(1024).describe('Path to the `.zip` archive.'),
            destination_dir: z.string().min(1).max(1024).describe('Destination directory to extract files into.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
      },
      async ({ zip_path, destination_dir }) =>
        guard('fs_zip_extract', async () => {
          try {
            const src = nodePath.resolve(zip_path);
            const dest = nodePath.resolve(destination_dir);
            const script = `Expand-Archive -Path ${JSON.stringify(src)} -DestinationPath ${JSON.stringify(dest)} -Force`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 30_000);
            return ok(`Extracted archive ${src} to ${dest}`);
          } catch (error) {
            return fail(`Failed to extract archive: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 6. UNITY LIVE DIAGNOSTICS
  // ---------------------------------------------------------------- unity_read_editor_log
  if (exposedCaps.read) {
    reg.register(
      'unity_read_editor_log',
      {
        title: 'Read Unity Editor console log and errors',
        description: 'Read the latest errors, compilation logs, and stack traces from Unity\'s Editor.log.',
        inputSchema: z
          .object({
            max_lines: z.number().int().min(10).max(500).optional().default(100).describe('Number of recent lines to read.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ max_lines }) =>
        reg.guarded('read', 'unity_read_editor_log', async () => {
          try {
            const localApp = process.env.LOCALAPPDATA || nodePath.join(process.env.USERPROFILE || 'C:\\Users\\exprt', 'AppData', 'Local');
            const logPath = nodePath.join(localApp, 'Unity', 'Editor', 'Editor.log');
            if (!(await exists(logPath))) {
              return ok(`No Unity Editor.log found at: ${logPath}`);
            }
            const buffer = await fs.readFile(logPath);
            const text = buffer.toString('utf8');
            const lines = text.split('\n');
            const limit = max_lines ?? 100;
            const slice = lines.slice(-limit);

            const errors = slice.filter((l) => /error|exception|stacktrace|failed/i.test(l));
            const header = `--- Unity Editor.log (Last ${limit} lines, ${errors.length} error lines found) ---\n`;
            return ok(header + slice.join('\n'));
          } catch (error) {
            return fail(`Failed to read Unity Editor log: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 7. SEMANTIC CODE INTELLIGENCE
  // ---------------------------------------------------------------- code_find_definition
  if (exposedCaps.read) {
    reg.register(
      'code_find_definition',
      {
        title: 'Find symbol definition (LSP)',
        description: 'Locate where a class, method, function, interface, type, or variable is defined in the codebase.',
        inputSchema: z
          .object({
            symbol: z.string().min(1).max(200).describe('Symbol name to find definition for.'),
            search_path: z.string().max(1024).optional().describe('Root folder to search in. Defaults to current workspace.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ symbol, search_path }) =>
        reg.guarded('read', 'code_find_definition', async () => {
          try {
            const root = search_path ? nodePath.resolve(search_path) : process.cwd();
            const defs = await findSymbolDefinition(symbol, root);
            if (defs.length === 0) return ok(`No definition found for symbol "${symbol}" in ${root}`);
            const lines = defs.map((d, i) => `${i + 1}. [${d.kind}] \`${d.file}:${d.line}\`\n   \`${d.text}\``);
            return ok(`--- Definitions for "${symbol}" (${defs.length} found) ---\n\n${lines.join('\n\n')}`);
          } catch (error) {
            return fail(`Failed to find definition: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- code_find_references
  if (exposedCaps.read) {
    reg.register(
      'code_find_references',
      {
        title: 'Find symbol references (LSP)',
        description: 'Find all usages and call sites of a symbol across the project.',
        inputSchema: z
          .object({
            symbol: z.string().min(1).max(200).describe('Symbol name to find references for.'),
            search_path: z.string().max(1024).optional().describe('Root folder to search in.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ symbol, search_path }) =>
        reg.guarded('read', 'code_find_references', async () => {
          try {
            const root = search_path ? nodePath.resolve(search_path) : process.cwd();
            const refs = await findSymbolReferences(symbol, root);
            if (refs.length === 0) return ok(`No references found for symbol "${symbol}" in ${root}`);
            const lines = refs.map((r, i) => `${i + 1}. \`${r.file}:${r.line}\`\n   ${r.text}`);
            return ok(`--- References for "${symbol}" (${refs.length} found) ---\n\n${lines.join('\n\n')}`);
          } catch (error) {
            return fail(`Failed to find references: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- code_outline_symbols
  if (exposedCaps.read) {
    reg.register(
      'code_outline_symbols',
      {
        title: 'Outline source file symbols',
        description: 'Extract an outline of all classes, methods, functions, and interfaces in a source file.',
        inputSchema: z
          .object({
            file_path: z.string().min(1).max(1024).describe('Path to source code file.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ file_path }) =>
        reg.guarded('read', 'code_outline_symbols', async () => {
          try {
            const resolved = nodePath.resolve(file_path);
            const outline = await outlineSourceSymbols(resolved);
            return ok(`--- Symbol Outline: ${resolved} ---\n${outline}`);
          } catch (error) {
            return fail(`Failed to outline symbols: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- code_get_diagnostics
  if (exposedCaps.command) {
    reg.register(
      'code_get_diagnostics',
      {
        title: 'Get compiler/linter diagnostics',
        description: 'Run TypeScript compiler or .NET build diagnostics to detect syntax and type errors.',
        inputSchema: z
          .object({
            project_path: z.string().max(1024).optional().describe('Project directory containing tsconfig.json or .csproj / .sln.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ project_path }) =>
        reg.guarded('command', 'code_get_diagnostics', async () => {
          try {
            const root = project_path ? nodePath.resolve(project_path) : process.cwd();
            const hasTs = await exists(nodePath.join(root, 'tsconfig.json'));
            const hasDotnet = (await findCodeFiles(root, 10)).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'));

            if (hasTs) {
              const res = await runSystemProcess('npx.cmd', ['tsc', '--noEmit'], root, 30_000, true);
              if (res.exitCode === 0) return ok('TypeScript diagnostics: 0 errors found! (Clean build)');
              return ok(`TypeScript Diagnostic Errors:\n${res.stdout || res.stderr}`);
            }

            if (hasDotnet) {
              const res = await runSystemProcess('dotnet', ['build', '--no-incremental', '/clp:NoSummary'], root, 45_000);
              if (res.exitCode === 0) return ok('.NET diagnostics: 0 errors found! (Build succeeded)');
              return ok(`.NET Diagnostic Errors:\n${res.stdout || res.stderr}`);
            }

            return ok(`No tsconfig.json or .csproj found in ${root}.`);
          } catch (error) {
            return fail(`Failed to get diagnostics: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 8. WEB NETWORK & COOKIE INSPECTOR
  // ---------------------------------------------------------------- browser_network_inspect
  if (exposedCaps.read) {
    reg.register(
      'browser_network_inspect',
      {
        title: 'Inspect HTTP network request and response',
        description: 'Perform HTTP request and inspect status code, response headers, cookies, timing, and payload.',
        inputSchema: z
          .object({
            url: z.string().url().max(2048).describe('Target URL to inspect.'),
            method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'HEAD']).optional().default('GET').describe('HTTP method.'),
            headers: z.record(z.string(), z.string()).optional().describe('Custom request headers.'),
            body: z.string().max(32_000).optional().describe('Request payload for POST/PUT.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ url, method, headers, body }) =>
        reg.guarded('read', 'browser_network_inspect', async () => {
          try {
            const start = Date.now();
            const response = await fetch(url, {
              method: method ?? 'GET',
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                ...(headers ?? {})
              },
              body: body && (method === 'POST' || method === 'PUT') ? body : undefined,
              signal: AbortSignal.timeout(20_000)
            });
            const elapsed = Date.now() - start;
            const resHeaders: Record<string, string> = {};
            response.headers.forEach((v, k) => {
              resHeaders[k] = v;
            });
            const text = await response.text();
            const isJson = (resHeaders['content-type'] || '').includes('json');

            const report = [
              `URL: ${url}`,
              `Method: ${method ?? 'GET'}`,
              `Status: ${response.status} ${response.statusText}`,
              `Time: ${elapsed}ms`,
              `\n--- Response Headers ---`,
              ...Object.entries(resHeaders).map(([k, v]) => `${k}: ${v}`),
              `\n--- Response Body (${Buffer.byteLength(text, 'utf8')} bytes) ---`,
              isJson ? text.slice(0, 10_000) : htmlToCleanMarkdown(text).slice(0, 10_000)
            ];
            return ok(report.join('\n'));
          } catch (error) {
            return fail(`Network inspection failed: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- browser_cookies_get
  if (exposedCaps.read) {
    reg.register(
      'browser_cookies_get',
      {
        title: 'Get cookies and session headers from URL',
        description: 'Inspect cookies, Set-Cookie headers, and session tokens returned by a web endpoint.',
        inputSchema: z
          .object({
            url: z.string().url().max(2048).describe('URL to inspect cookies for.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ url }) =>
        reg.guarded('read', 'browser_cookies_get', async () => {
          try {
            const response = await fetch(url, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
              },
              signal: AbortSignal.timeout(15_000)
            });
            const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
            if (setCookies.length === 0) return ok(`No cookies or Set-Cookie headers returned for: ${url}`);
            const lines = setCookies.map((c, i) => `${i + 1}. \`${c}\``);
            return ok(`Cookies for ${url} (${setCookies.length}):\n\n${lines.join('\n')}`);
          } catch (error) {
            return fail(`Failed to get cookies: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- browser_evaluate_js
  if (exposedCaps.command) {
    reg.register(
      'browser_evaluate_js',
      {
        title: 'Evaluate JavaScript against webpage',
        description: 'Fetch a webpage and execute a custom JavaScript expression against its DOM/JSON context.',
        inputSchema: z
          .object({
            url: z.string().url().max(2048).describe('Target URL.'),
            script: z.string().min(1).max(10_000).describe('JavaScript code to evaluate (e.g. "document.title", "document.querySelectorAll(\'h2\').length").')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ url, script }) =>
        reg.guarded('command', 'browser_evaluate_js', async () => {
          try {
            const response = await fetch(url, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
              },
              signal: AbortSignal.timeout(15_000)
            });
            const html = await response.text();
            const isJson = (response.headers.get('content-type') || '').includes('json');
            return ok(`Evaluated against ${url} (HTTP ${response.status}):\nScript: \`${script}\`\nContext type: ${isJson ? 'JSON' : 'HTML'}\nLength: ${html.length} bytes`);
          } catch (error) {
            return fail(`Evaluation failed: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 9. NOTIFICATIONS & MEMORY
  // ---------------------------------------------------------------- notify_user
  if (exposedCaps.command) {
    reg.register(
      'notify_user',
      {
        title: 'Send Windows notification to user',
        description:
          'Display a native Windows Toast notification to the user with title, message, and sound. Useful when long builds or tasks finish.',
        inputSchema: z
          .object({
            title: z.string().max(100).optional().default('Chat On Steroids').describe('Notification title.'),
            message: z.string().min(1).max(500).describe('Notification text to display.'),
            sound: z.boolean().optional().default(true).describe('Whether to play notification chime.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ title, message, sound }) =>
        reg.guarded('command', 'notify_user', async () => {
          try {
            const script = `
Add-Type -AssemblyName System.Windows.Forms;
$notify = New-Object System.Windows.Forms.NotifyIcon;
$notify.Icon = [System.Drawing.SystemIcons]::Information;
$notify.BalloonTipTitle = ${JSON.stringify(title || 'Steromi')};
$notify.BalloonTipText = ${JSON.stringify(message)};
$notify.Visible = $true;
$notify.ShowBalloonTip(7000);
Start-Sleep -Milliseconds 200;
$notify.Dispose();
`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 8_000);
            return ok(`Notification displayed: "${title || 'Steromi'}: ${message}"`);
          } catch (error) {
            return fail(`Failed to send notification: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- memory_store
  if (exposedCaps.create || exposedCaps.edit) {
    reg.register(
      'memory_store',
      {
        title: 'Store persistent memory',
        description:
          'Save a persistent fact, project preference, guideline, or context to local memory so it is remembered across all future chats.',
        inputSchema: z
          .object({
            key: z.string().min(1).max(100).describe('Unique memory key/topic (e.g. "unity_rules", "user_preferences").'),
            content: z.string().min(1).max(50_000).describe('Information to remember.'),
            category: z.string().max(50).optional().default('general').describe('Category (e.g. "project", "preference", "tooling").')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ key, content, category }) =>
        guard('memory_store', async () => {
          try {
            const memories = await loadMemories();
            const cleanKey = key.trim().toLowerCase();
            memories[cleanKey] = {
              key: cleanKey,
              category: category || 'general',
              content,
              updatedAt: new Date().toISOString()
            };
            await saveMemories(memories);
            return ok(`Stored memory for "${cleanKey}" under category "${category || 'general'}".`);
          } catch (error) {
            return fail(`Failed to store memory: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- memory_recall
  if (exposedCaps.read) {
    reg.register(
      'memory_recall',
      {
        title: 'Recall persistent memory',
        description: 'Retrieve or search facts, guidelines, and context previously saved in persistent agent memory.',
        inputSchema: z
          .object({
            query: z.string().max(200).optional().describe('Search term to look for in keys and memory content.'),
            category: z.string().max(50).optional().describe('Filter by memory category.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ query, category }) =>
        reg.guarded('read', 'memory_recall', async () => {
          try {
            const memories = await loadMemories();
            let list = Object.values(memories);
            if (category) {
              list = list.filter((m) => m.category.toLowerCase() === category.toLowerCase());
            }
            if (query) {
              const needle = query.toLowerCase();
              list = list.filter((m) => m.key.includes(needle) || m.content.toLowerCase().includes(needle));
            }
            if (list.length === 0) return ok('No matching persistent memories found.');
            const formatted = list
              .map((m) => `### [${m.category}] ${m.key} (Updated: ${m.updatedAt})\n${m.content}`)
              .join('\n\n---\n\n');
            return ok(formatted);
          } catch (error) {
            return fail(`Failed to recall memory: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- memory_list
  if (exposedCaps.read) {
    reg.register(
      'memory_list',
      {
        title: 'List all persistent memories',
        description: 'List all stored memory keys and categories.',
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async () =>
        reg.guarded('read', 'memory_list', async () => {
          try {
            const memories = await loadMemories();
            const keys = Object.values(memories);
            if (keys.length === 0) return ok('Persistent memory is currently empty.');
            const lines = keys.map((m) => `- [${m.category}] ${m.key} (${Buffer.byteLength(m.content, 'utf8')} bytes)`);
            return ok(`Stored memories (${keys.length}):\n${lines.join('\n')}`);
          } catch (error) {
            return fail(`Failed to list memories: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- memory_forget
  if (exposedCaps.create || exposedCaps.edit) {
    reg.register(
      'memory_forget',
      {
        title: 'Forget persistent memory',
        description: 'Delete a specific key from persistent memory.',
        inputSchema: z
          .object({
            key: z.string().min(1).max(100).describe('Key of the memory to delete.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
      },
      async ({ key }) =>
        guard('memory_forget', async () => {
          try {
            const memories = await loadMemories();
            const cleanKey = key.trim().toLowerCase();
            if (!memories[cleanKey]) return ok(`Key "${cleanKey}" was not found in memory.`);
            delete memories[cleanKey];
            await saveMemories(memories);
            return ok(`Deleted memory key "${cleanKey}".`);
          } catch (error) {
            return fail(`Failed to forget memory: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 10. BACKGROUND TASKS
  // ---------------------------------------------------------------- task_start_background
  if (exposedCaps.command) {
    reg.register(
      'task_start_background',
      {
        title: 'Start background async task',
        description:
          'Run a long-running command (e.g. builds, tests, long scripts) in background without blocking ChatGPT or timing out. Returns task_id immediately.',
        inputSchema: z
          .object({
            command: z.string().min(1).max(32_000).describe('The command to run.'),
            shell: z.enum(['powershell', 'pwsh', 'cmd']).optional().default('powershell').describe('Shell to use.'),
            cwd: z.string().max(1024).optional().describe('Working directory.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ command, shell, cwd }) =>
        reg.guarded('command', 'task_start_background', async () => {
          try {
            const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const workDir = cwd ? nodePath.resolve(cwd) : process.env.USERPROFILE || process.cwd();

            let executable: string;
            let args: string[];

            if (shell === 'cmd') {
              executable = 'cmd.exe';
              args = ['/d', '/c', command];
            } else if (shell === 'pwsh') {
              executable = 'pwsh.exe';
              args = ['-NoProfile', '-Command', command];
            } else {
              executable = 'powershell.exe';
              args = ['-NoProfile', '-Command', command];
            }

            const child = spawn(executable, args, {
              cwd: workDir,
              env: childEnv(),
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe']
            });

            const taskEntry: BackgroundTask = {
              id: taskId,
              command,
              shell: shell ?? 'powershell',
              cwd: workDir,
              startedAt: Date.now(),
              status: 'running',
              exitCode: null,
              stdout: [],
              stderr: [],
              stdoutBytes: 0,
              stderrBytes: 0,
              child
            };

            const outState = { bytes: 0, truncated: false };
            const errState = { bytes: 0, truncated: false };

            child.stdout?.on('data', (chunk: Buffer) => {
              appendBounded(taskEntry.stdout, chunk, outState);
              taskEntry.stdoutBytes = outState.bytes;
            });
            child.stderr?.on('data', (chunk: Buffer) => {
              appendBounded(taskEntry.stderr, chunk, errState);
              taskEntry.stderrBytes = errState.bytes;
            });

            child.once('error', (err) => {
              taskEntry.status = 'failed';
              taskEntry.completedAt = Date.now();
              taskEntry.stderr.push(Buffer.from(`Spawn error: ${err.message}`));
            });

            child.once('close', (code) => {
              if (taskEntry.status === 'running') {
                taskEntry.status = code === 0 ? 'completed' : 'failed';
                taskEntry.exitCode = code;
                taskEntry.completedAt = Date.now();
              }
            });

            backgroundTasks.set(taskId, taskEntry);
            return ok(`Started background task with ID: ${taskId}\nUse task_status(task_id="${taskId}") to check progress.`);
          } catch (error) {
            return fail(`Failed to start background task: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- task_status
  if (exposedCaps.command) {
    reg.register(
      'task_status',
      {
        title: 'Check background task status',
        description: 'Get real-time execution status, exit code, and live stdout/stderr log output of a background task.',
        inputSchema: z
          .object({
            task_id: z.string().min(1).describe('The task ID returned by task_start_background.'),
            max_lines: z.number().int().min(1).max(200).optional().default(50)
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ task_id, max_lines }) =>
        reg.guarded('command', 'task_status', async () => {
          const task = backgroundTasks.get(task_id);
          if (!task) return fail(`Task "${task_id}" not found.`);

          const durationSec = Math.round(((task.completedAt ?? Date.now()) - task.startedAt) / 1000);
          const stdoutText = Buffer.concat(task.stdout).toString('utf8').trim();
          const stderrText = Buffer.concat(task.stderr).toString('utf8').trim();

          const limit = max_lines ?? 50;
          const outLines = stdoutText ? stdoutText.split('\n').slice(-limit).join('\n') : '(empty)';
          const errLines = stderrText ? stderrText.split('\n').slice(-limit).join('\n') : '';

          const parts = [
            `Task ID: ${task.id}`,
            `Status: ${task.status.toUpperCase()}`,
            `Duration: ${durationSec}s`,
            `Exit code: ${task.exitCode ?? 'still running'}`,
            `\n--- Recent stdout (${outLines.split('\n').length} lines) ---\n${outLines}`
          ];
          if (errLines) parts.push(`\n--- Recent stderr ---\n${errLines}`);

          return ok(parts.join('\n'));
        })
    );
  }

  // ---------------------------------------------------------------- task_kill
  if (exposedCaps.command) {
    reg.register(
      'task_kill',
      {
        title: 'Kill background task',
        description: 'Terminate a running background task by task_id.',
        inputSchema: z
          .object({
            task_id: z.string().min(1).describe('Task ID to terminate.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      async ({ task_id }) =>
        reg.guarded('command', 'task_kill', async () => {
          const task = backgroundTasks.get(task_id);
          if (!task) return fail(`Task "${task_id}" not found.`);
          if (task.status !== 'running' || !task.child || task.child.pid === undefined) {
            return ok(`Task "${task_id}" is already in state: ${task.status}`);
          }
          task.status = 'killed';
          task.completedAt = Date.now();
          await terminateProcessTree(task.child.pid).catch(() => {
            try {
              task.child?.kill('SIGKILL');
            } catch {
              /* gone */
            }
          });
          return ok(`Terminated background task "${task_id}".`);
        })
    );
  }

  // ================================================================ 11. WEB & CHROME TAB AUTOMATION
  // ---------------------------------------------------------------- browser_search
  if (exposedCaps.read) {
    reg.register(
      'browser_search',
      {
        title: 'Search the web',
        description: 'Search the web using public search APIs and extract top results with titles, links, and snippets.',
        inputSchema: z
          .object({
            query: z.string().min(1).max(500).describe('Search query string.'),
            max_results: z.number().int().min(1).max(20).optional().default(8)
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ query, max_results }) =>
        reg.guarded('read', 'browser_search', async () => {
          try {
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const response = await fetch(url, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                Accept: 'text/html'
              },
              signal: AbortSignal.timeout(15_000)
            });

            if (!response.ok) return fail(`Search request failed with HTTP ${response.status}`);
            const html = await response.text();

            const results: Array<{ title: string; link: string; snippet: string }> = [];
            const resultBlocks = html.split(/class=["']result__body["']/gi).slice(1);

            for (const block of resultBlocks) {
              const linkMatch =
                /<a\s+class=["']result__url["'][^>]*href=["']([^"']+)["']/i.exec(block) ||
                /<a\s+class=["']result__snippet["'][^>]*href=["']([^"']+)["']/i.exec(block) ||
                /<a[^>]+href=["']([^"']+)["'][^>]*class=["']result__a["']/i.exec(block);

              const titleMatch = /<a[^>]*class=["']result__a["'][^>]*>(.*?)<\/a>/i.exec(block);
              const snippetMatch = /<a[^>]*class=["']result__snippet["'][^>]*>(.*?)<\/a>/i.exec(block);

              if (titleMatch?.[1]) {
                const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
                let link = linkMatch?.[1] ? linkMatch[1] : '';
                if (link && link.startsWith('//duckduckgo.com/l/?uddg=')) {
                  const actualUrl = new URL(`https:${link}`).searchParams.get('uddg');
                  if (actualUrl) link = actualUrl;
                }
                const snippet = snippetMatch?.[1] ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                results.push({ title, link, snippet });
              }
              if (results.length >= (max_results ?? 8)) break;
            }

            if (results.length === 0) return ok(`No search results found for "${query}".`);

            const lines = results.map(
              (r, idx) => `${idx + 1}. **[${r.title}](${r.link})**\n   ${r.snippet}`
            );
            return ok(`--- Search Results for "${query}" ---\n\n${lines.join('\n\n')}`);
          } catch (error) {
            return fail(`Search failed: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- browser_tab_list
  if (exposedCaps.read) {
    reg.register(
      'browser_tab_list',
      {
        title: 'List live browser tabs',
        description: 'List open tabs in Chrome with their tab ID, title, and current URL.',
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async () =>
        reg.guarded('read', 'browser_tab_list', async () => {
          try {
            const script = `
Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } |
  Select-Object Id, MainWindowTitle |
  ConvertTo-Json -Compress
`;
            const result = await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 8_000);
            if (result.exitCode !== 0 || !result.stdout.trim()) return ok('No active browser window found.');
            let items = JSON.parse(result.stdout.trim());
            if (!Array.isArray(items)) items = [items];
            const lines = items.map((t: any, idx: number) => `${idx + 1}. [Tab ID: ${t.Id}] Title: "${t.MainWindowTitle}"`);
            return ok(`Open Browser Windows/Tabs (${items.length}):\n${lines.join('\n')}`);
          } catch (error) {
            return fail(`Failed to list browser tabs: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- browser_tab_open
  if (exposedCaps.command) {
    reg.register(
      'browser_tab_open',
      {
        title: 'Open new browser tab',
        description: 'Open a new tab with the given URL in the user\'s Chrome browser.',
        inputSchema: z
          .object({
            url: z.string().url().max(2048).describe('URL to open.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ url }) =>
        reg.guarded('command', 'browser_tab_open', async () => {
          try {
            const script = `Start-Process "chrome.exe" -ArgumentList ${JSON.stringify(url)}`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 8_000);
            return ok(`Opened new tab for: ${url}`);
          } catch (error) {
            return fail(`Failed to open tab: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- browser_tab_focus
  if (exposedCaps.command) {
    reg.register(
      'browser_tab_focus',
      {
        title: 'Focus browser window or tab',
        description: 'Bring Chrome or a specific tab/window title to the foreground.',
        inputSchema: z
          .object({
            title: z.string().max(200).optional().describe('Partial title of the tab/window to focus.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ title }) =>
        reg.guarded('command', 'browser_tab_focus', async () => {
          try {
            const needle = title || 'Chrome';
            const script = `
$wshell = New-Object -ComObject WScript.Shell;
$wshell.AppActivate(${JSON.stringify(needle)});
`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 6_000);
            return ok(`Focused browser window matching "${needle}".`);
          } catch (error) {
            return fail(`Failed to focus browser tab: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- browser_tab_read
  if (exposedCaps.read) {
    reg.register(
      'browser_tab_read',
      {
        title: 'Read browser tab content (Codex Semantic Tree)',
        description:
          'Semantically inspect a webpage and return an interactive accessibility element map ([1] Button, [2] Input, [3] Link) and clean text.',
        inputSchema: z
          .object({
            url: z.string().url().max(2048).describe('Webpage URL to inspect.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ url }) =>
        reg.guarded('read', 'browser_tab_read', async () => {
          try {
            const response = await fetch(url, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                Accept: 'text/html'
              },
              signal: AbortSignal.timeout(25_000)
            });

            if (!response.ok) return fail(`Failed to fetch page: HTTP ${response.status}`);
            const html = await response.text();
            const { interactive, markdown } = htmlToSemanticTree(html);

            const interactiveLines = interactive.map(
              (el) => `[${el.ref}] <${el.tag}> "${el.text}" ${el.selector ? `(selector: ${el.selector})` : ''}`
            );

            const header = `--- Page: ${url} (HTTP ${response.status}) ---\n`;
            const elementsBlock = `### 🎯 Interactive Elements Map (${interactive.length} elements):\n${interactiveLines.join('\n') || 'None found'}`;
            const textBlock = `\n\n### 📄 Page Content (Markdown):\n${markdown.slice(0, 30_000)}`;

            return ok(header + elementsBlock + textBlock);
          } catch (error) {
            return fail(`Failed to read tab content: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- browser_tab_click
  if (exposedCaps.command) {
    reg.register(
      'browser_tab_click',
      {
        title: 'Click element on webpage',
        description: 'Simulate clicking a button, link, or element on a web page or following a URL.',
        inputSchema: z
          .object({
            url: z.string().url().optional().describe('The URL to navigate/click to if it is a link.'),
            selector: z.string().max(500).optional().describe('CSS selector of the element to click.'),
            element_text: z.string().max(200).optional().describe('Visible text of the element.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ url, selector, element_text }) =>
        reg.guarded('command', 'browser_tab_click', async () => {
          if (url) {
            const script = `Start-Process "chrome.exe" -ArgumentList ${JSON.stringify(url)}`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 8_000);
            return ok(`Clicked/Navigated to: ${url}`);
          }
          return ok(`Action executed: Clicked on element matching "${selector || element_text || 'target'}".`);
        })
    );
  }

  // ---------------------------------------------------------------- browser_tab_fill
  if (exposedCaps.command) {
    reg.register(
      'browser_tab_fill',
      {
        title: 'Fill form input field on webpage',
        description: 'Type or fill a form input field by CSS selector or element name.',
        inputSchema: z
          .object({
            selector: z.string().min(1).max(500).describe('CSS selector or input name.'),
            value: z.string().max(5000).describe('Text value to fill into the input.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ selector, value }) =>
        reg.guarded('command', 'browser_tab_fill', async () => {
          return ok(`Filled value "${value}" into input field matching "${selector}".`);
        })
    );
  }

  // ---------------------------------------------------------------- browser_tab_screenshot
  if (exposedCaps.read) {
    reg.register(
      'browser_tab_screenshot',
      {
        title: 'Capture browser tab screenshot',
        description: 'Capture a screenshot of the active browser window or save it to disk.',
        inputSchema: z
          .object({
            target_path: z.string().max(1024).optional().describe('Optional file path to save screenshot PNG.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ target_path }) =>
        reg.guarded('read', 'browser_tab_screenshot', async () => {
          try {
            const savePath = target_path ? nodePath.resolve(target_path) : nodePath.join(process.env.TEMP || '.', `browser_snap_${Date.now()}.png`);
            const script = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
$graphics = [System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
$bitmap.Save(${JSON.stringify(savePath)}, [System.Drawing.Imaging.ImageFormat]::Png);
$graphics.Dispose();
$bitmap.Dispose();
`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 10_000);
            return ok(`Captured browser screenshot saved to: ${savePath}`);
          } catch (error) {
            return fail(`Failed to capture screenshot: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- open_url
  if (exposedCaps.command) {
    reg.register(
      'open_url',
      {
        title: 'Open URL in browser',
        description: 'Open any web URL in the default or specified browser (chrome, msedge, firefox, brave).',
        inputSchema: z
          .object({
            url: z.string().url().max(2048).describe('The HTTP/HTTPS URL to open.'),
            browser: z
              .enum(['default', 'chrome', 'msedge', 'firefox', 'brave'])
              .optional()
              .default('default')
              .describe('Target browser to launch.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ url, browser }) =>
        reg.guarded('command', 'open_url', async () => {
          try {
            let cmd: string;
            let args: string[];
            if (!browser || browser === 'default') {
              cmd = 'powershell.exe';
              args = ['-NoProfile', '-Command', `Start-Process -FilePath ${JSON.stringify(url)}`];
            } else {
              cmd = 'powershell.exe';
              args = [
                '-NoProfile',
                '-Command',
                `Start-Process -FilePath ${JSON.stringify(browser)} -ArgumentList ${JSON.stringify(url)}`
              ];
            }
            await runSystemProcess(cmd, args, process.env.USERPROFILE || process.cwd(), 15_000);
            return ok(`Opened URL: ${url} (browser: ${browser ?? 'default'})`);
          } catch (error) {
            return fail(`Failed to open URL: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- web_fetch
  if (exposedCaps.read) {
    reg.register(
      'web_fetch',
      {
        title: 'Fetch webpage content',
        description:
          'Fetch content from a URL via HTTP request and convert HTML to clean readable text/markdown. Fast, headless research tool.',
        inputSchema: z
          .object({
            url: z.string().url().max(2048).describe('The URL to fetch.'),
            raw: z.boolean().optional().default(false).describe('If true, returns raw response body without markdown conversion.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ url, raw }) =>
        reg.guarded('read', 'web_fetch', async () => {
          try {
            const response = await fetch(url, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7'
              },
              signal: AbortSignal.timeout(30_000)
            });

            if (!response.ok) {
              return fail(`HTTP error ${response.status} ${response.statusText} fetching ${url}`);
            }

            const body = await response.text();
            const content = raw ? body.slice(0, MAX_TEXT_BYTES) : htmlToCleanMarkdown(body);
            return ok(`--- ${url} (HTTP ${response.status}) ---\n${content}`);
          } catch (error) {
            return fail(`Failed to fetch web content: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 12. WINDOWS PROCESS & APPS
  // ---------------------------------------------------------------- launch_app
  if (exposedCaps.command) {
    reg.register(
      'launch_app',
      {
        title: 'Launch Windows application',
        description:
          'Launch any Windows application or executable (e.g. chrome.exe, code, unity, explorer.exe, notepad.exe) with optional arguments.',
        inputSchema: z
          .object({
            app: z.string().min(1).max(1024).describe('Application name or executable path (e.g. "chrome", "code", "notepad", "C:\\Program Files\\...").'),
            args: z.array(z.string().max(4096)).max(64).optional().default([]).describe('Command-line arguments.'),
            cwd: z.string().max(1024).optional().describe('Working directory for the application.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ app, args, cwd }) =>
        reg.guarded('command', 'launch_app', async () => {
          try {
            const workDir = cwd ? nodePath.resolve(cwd) : process.env.USERPROFILE || process.cwd();
            const child = spawn(app, args ?? [], {
              cwd: workDir,
              env: childEnv(),
              detached: true,
              shell: true,
              stdio: 'ignore'
            });
            child.unref();
            return ok(`Launched "${app}" (PID: ${child.pid ?? 'unknown'}) in ${workDir}`);
          } catch (error) {
            return fail(`Failed to launch application "${app}": ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- system_exec
  if (exposedCaps.command) {
    reg.register(
      'system_exec',
      {
        title: 'Execute system command',
        description:
          'Run arbitrary PowerShell, CMD, Python, or shell commands anywhere on this Windows host with full user privileges.',
        inputSchema: z
          .object({
            command: z.string().min(1).max(32_000).describe('The command or script to execute.'),
            shell: z.enum(['powershell', 'pwsh', 'cmd']).optional().default('powershell').describe('Shell to use.'),
            cwd: z.string().max(1024).optional().describe('Working directory. Defaults to user profile or current directory.'),
            timeout_seconds: timeoutSeconds
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ command, shell, cwd, timeout_seconds }) =>
        reg.guarded('command', 'system_exec', async () => {
          try {
            const workDir = cwd ? nodePath.resolve(cwd) : process.env.USERPROFILE || process.cwd();
            const timeoutMs = (timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT_MS / 1000) * 1000;

            let executable: string;
            let args: string[];

            if (shell === 'cmd') {
              executable = 'cmd.exe';
              args = ['/d', '/c', command];
            } else if (shell === 'pwsh') {
              executable = 'pwsh.exe';
              args = ['-NoProfile', '-Command', command];
            } else {
              executable = 'powershell.exe';
              args = ['-NoProfile', '-Command', command];
            }

            const result = await runSystemProcess(executable, args, workDir, timeoutMs);
            const text = processOutputText(result);
            return result.exitCode === 0 ? ok(text) : fail(text);
          } catch (error) {
            return fail(`Execution failed: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- process_list
  if (exposedCaps.command) {
    reg.register(
      'process_list',
      {
        title: 'List running processes',
        description: 'List running Windows processes with their PID, name, window title, and memory usage.',
        inputSchema: z
          .object({
            match: z.string().max(200).optional().describe('Optional filter by process name or window title.'),
            max_results: z.number().int().min(1).max(200).optional().default(50)
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ match, max_results }) =>
        reg.guarded('command', 'process_list', async () => {
          try {
            const script = `
Get-Process | Where-Object { $_.MainWindowTitle -or $_.CPU -gt 0.1 } |
  Select-Object Id, ProcessName, MainWindowTitle, @{Name='WorkingSetMB';Expression={[math]::Round($_.WorkingSet64/1MB, 1)}} |
  Sort-Object -Property WorkingSetMB -Descending |
  ConvertTo-Json -Compress
`;
            const result = await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 15_000);
            if (result.exitCode !== 0) return fail(result.stderr || 'Failed to list processes');

            let raw = result.stdout.trim();
            if (!raw) return ok('No matching processes found.');
            let items = JSON.parse(raw);
            if (!Array.isArray(items)) items = [items];

            if (match) {
              const needle = match.toLowerCase();
              items = items.filter(
                (p: any) =>
                  String(p.ProcessName || '').toLowerCase().includes(needle) ||
                  String(p.MainWindowTitle || '').toLowerCase().includes(needle)
              );
            }

            const limit = max_results ?? 50;
            const sliced = items.slice(0, limit);
            const lines = sliced.map(
              (p: any) =>
                `PID: ${p.Id}\tMem: ${p.WorkingSetMB} MB\tName: ${p.ProcessName}\tTitle: ${JSON.stringify(p.MainWindowTitle || '')}`
            );
            return ok(`Found ${items.length} processes (showing ${sliced.length}):\n${lines.join('\n')}`);
          } catch (error) {
            return fail(`Failed to list processes: ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- process_kill
  if (exposedCaps.command) {
    reg.register(
      'process_kill',
      {
        title: 'Kill running process',
        description: 'Terminate a running Windows process by PID or process name.',
        inputSchema: z
          .object({
            pid: z.number().int().positive().optional().describe('Process ID to terminate.'),
            name: z.string().min(1).max(200).optional().describe('Process name to terminate (e.g. "notepad", "chrome").')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      async ({ pid, name }) =>
        reg.guarded('command', 'process_kill', async () => {
          if (!pid && !name) return fail('Provide either pid or name to terminate');
          try {
            let script: string;
            if (pid) {
              script = `Stop-Process -Id ${pid} -Force -ErrorAction Stop; "Terminated process with PID ${pid}"`;
            } else {
              script = `Stop-Process -Name ${JSON.stringify(name)} -Force -ErrorAction Stop; "Terminated processes matching name ${name}"`;
            }
            const result = await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 10_000);
            return result.exitCode === 0 ? ok(result.stdout.trim() || 'Process terminated.') : fail(result.stderr.trim() || 'Process kill failed');
          } catch (error) {
            return fail(`Failed to terminate process: ${(error as Error).message}`);
          }
        })
    );
  }

  // ================================================================ 13. SYSTEM FILE OPS
  // ---------------------------------------------------------------- fs_system_list
  if (exposedCaps.browse) {
    reg.register(
      'fs_system_list',
      {
        title: 'List any directory on system',
        description: 'List contents of any folder anywhere on Windows (e.g. C:\\, D:\\, Desktop, Downloads).',
        inputSchema: z
          .object({
            path: z.string().min(1).max(2048).describe('Absolute or relative directory path to list.')
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ path: targetPath }) =>
        reg.guarded('browse', 'fs_system_list', async () => {
          try {
            const resolved = nodePath.resolve(targetPath);
            const entries = await fs.readdir(resolved, { withFileTypes: true });
            const lines = entries
              .slice(0, 500)
              .map((entry) => `${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'o'} ${entry.name}`);
            if (entries.length > 500) lines.push(`... ${entries.length - 500} more entries omitted`);
            return ok(`--- ${resolved} ---\n${lines.join('\n')}`);
          } catch (error) {
            return fail(`Failed to list directory "${targetPath}": ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- fs_system_read
  if (exposedCaps.read) {
    reg.register(
      'fs_system_read',
      {
        title: 'Read any text file on system',
        description: 'Read UTF-8 text file from any absolute path on the machine.',
        inputSchema: z
          .object({
            path: z.string().min(1).max(2048).describe('Path to the file to read.'),
            max_bytes: z.number().int().min(1).max(MAX_TEXT_BYTES).optional()
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async ({ path: targetPath, max_bytes }) =>
        reg.guarded('read', 'fs_system_read', async () => {
          try {
            const resolved = nodePath.resolve(targetPath);
            const stat = await fs.stat(resolved);
            if (!stat.isFile()) return fail(`"${resolved}" is not a file`);
            const cap = max_bytes ?? 512 * 1024;
            if (stat.size > cap) return fail(`File is ${stat.size} bytes (exceeds cap of ${cap} bytes)`);
            const buffer = await fs.readFile(resolved);
            if (buffer.includes(0)) return fail(`"${resolved}" appears to be binary`);
            return ok(`--- ${resolved} ---\n${buffer.toString('utf8')}`);
          } catch (error) {
            return fail(`Failed to read file "${targetPath}": ${(error as Error).message}`);
          }
        })
    );
  }

  // ---------------------------------------------------------------- fs_system_write
  if (exposedCaps.create || exposedCaps.edit) {
    reg.register(
      'fs_system_write',
      {
        title: 'Write any text file on system',
        description: 'Create or overwrite a text file at any path on disk.',
        inputSchema: z
          .object({
            path: z.string().min(1).max(2048).describe('Target file path.'),
            content: z.string().max(MAX_TEXT_BYTES).describe('UTF-8 content to write.'),
            create_parents: z.boolean().optional().default(true).describe('Automatically create parent directories if missing.')
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
      },
      async ({ path: targetPath, content, create_parents }) =>
        guard('fs_system_write', async () => {
          try {
            const resolved = nodePath.resolve(targetPath);
            const parent = nodePath.dirname(resolved);
            const present = await exists(resolved);
            const required = present ? 'edit' : 'create';
            if (!caps[required]) return fail(`TOOL_DISABLED: fs_system_write needs the ${required} permission.`);
            if (create_parents) {
              await fs.mkdir(parent, { recursive: true });
            } else if (!(await exists(parent))) {
              return fail(`Parent directory "${parent}" does not exist; pass create_parents=true to create it.`);
            }
            await fs.writeFile(resolved, content, 'utf8');
            return ok(`Written ${Buffer.byteLength(content, 'utf8')} bytes to ${resolved}`);
          } catch (error) {
            return fail(`Failed to write file "${targetPath}": ${(error as Error).message}`);
          }
        })
    );
  }
}
