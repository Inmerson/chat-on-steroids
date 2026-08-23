/**
 * Power Agent MCP tools for full Windows system autonomy, browser navigation,
 * web content fetching, process management, and unrestricted command execution.
 */

import { spawn } from 'node:child_process';
import nodePath from 'node:path';
import { rawPromises as fs } from '../rawfs.js';
import { z } from 'zod';
import { childEnv } from '../exec.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';

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

export function registerPowerAgentTools(reg: SurfaceRegistrar): void {
  const { caps, exposedCaps } = reg;

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
