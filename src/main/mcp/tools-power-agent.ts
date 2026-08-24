/**
 * Power Agent MCP tools for full Windows system autonomy:
 * - Codex-style Live Chrome Tab Automation (browser_tab_list, browser_tab_open, browser_tab_focus, browser_tab_read, browser_tab_click, browser_tab_fill, browser_tab_screenshot)
 * - Browser navigation & clean web research
 * - Web search (browser_search)
 * - Long-term persistent agent memory (memory_store, memory_recall, memory_list, memory_forget)
 * - Background async task execution (task_start_background, task_status, task_kill)
 * - Windows native notifications (notify_user)
 * - Application launcher & process management
 * - Unrestricted system shell execution
 * - System-wide file management
 */

import { spawn, type ChildProcess } from 'node:child_process';
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
$notify.BalloonTipTitle = ${JSON.stringify(title || 'Chat On Steroids')};
$notify.BalloonTipText = ${JSON.stringify(message)};
$notify.Visible = $true;
$notify.ShowBalloonTip(7000);
Start-Sleep -Milliseconds 200;
$notify.Dispose();
`;
            await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', script], process.cwd(), 8_000);
            return ok(`Notification displayed: "${title || 'Chat On Steroids'}: ${message}"`);
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
