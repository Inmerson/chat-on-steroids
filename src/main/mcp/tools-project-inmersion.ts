/**
 * Narrow Project Inmersion convenience tools.
 *
 * These wrappers never widen Chat On Steroids' authority: the configured profile root
 * must already be present in ctx.roots, filesystem paths still pass through sandbox.ts,
 * and process launchers use a closed executable allowlist with shell:false.
 */

import { spawn } from 'node:child_process';
import nodePath from 'node:path';
import { rawPromises as fs } from '../rawfs.js';
import { z } from 'zod';
import { childEnv } from '../exec.js';
import { SandboxError, resolvePath, type Resolved } from '../sandbox.js';
import type { Root } from '../../shared/types.js';
import { fail, friendlyError, guard, ok, type SurfaceRegistrar, type ToolResult } from './kernel.js';

const DEFAULT_PROFILE_ROOT = String.raw`C:\Users\exprt\Project Inmersion`;
const PROFILE_ROOT_ENV = 'CHAT_ON_STEROIDS_PROJECT_INMERSION_ROOT';
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;

const relativePath = z.string().max(2048).default('.');
const timeoutSeconds = z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_MS / 1000).optional();

export function configuredProjectInmersionRoot(): string {
  const configured = process.env[PROFILE_ROOT_ENV]?.trim();
  return configured || DEFAULT_PROFILE_ROOT;
}

function sameNativePath(left: string, right: string): boolean {
  const a = nodePath.resolve(left);
  const b = nodePath.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function projectInmersionRoot(roots: readonly Root[]): Root {
  const wanted = configuredProjectInmersionRoot();
  const root = roots.find((candidate) => sameNativePath(candidate.path, wanted));
  if (!root) {
    throw new SandboxError(
      `PROJECT_ROOT_NOT_APPROVED: approve exactly "${wanted}" in Chat On Steroids before using the Project Inmersion tools.`
    );
  }
  return root;
}

export function normalizeRelativePath(input = '.'): string {
  const value = String(input || '.').trim().replaceAll('\\', '/');
  if (/^(?:[A-Za-z]:\/|\/\/|\/)/.test(value)) throw new SandboxError('Absolute paths are not allowed here; use a Project Inmersion relative path.');
  const parts = value.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) throw new SandboxError('Path traversal ("..") is not allowed');
  return parts.length > 0 ? parts.join('/') : '.';
}

async function resolveProjectPath(roots: readonly Root[], input = '.', allowMissing = false): Promise<Resolved> {
  const root = projectInmersionRoot(roots);
  const relative = normalizeRelativePath(input);
  const virtual = relative === '.' ? `/${root.name}` : `/${root.name}/${relative}`;
  return resolvePath([root], virtual, { allowMissing });
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
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

async function runProcess(executable: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: childEnv(),
      windowsHide: true,
      shell: false,
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

function processText(result: { exitCode: number; stdout: string; stderr: string; truncated: boolean }): string {
  const parts = [`exit_code: ${result.exitCode}`];
  if (result.stdout.trim()) parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.stderr.trim()) parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
  if (result.truncated) parts.push(`(output truncated at ${MAX_PROCESS_OUTPUT_BYTES} bytes per stream)`);
  return parts.join('\n');
}

async function firstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate && (await exists(candidate))) return candidate;
  }
  return null;
}

async function locatePowerShell(kind: 'powershell' | 'pwsh'): Promise<string> {
  const systemRoot = process.env.SystemRoot || String.raw`C:\Windows`;
  const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
  const candidates =
    kind === 'powershell'
      ? [nodePath.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
      : [
          nodePath.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
          nodePath.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe')
        ];
  const found = await firstExisting(candidates);
  if (!found) throw new Error(`${kind}.exe was not found in the allowlisted install locations`);
  return found;
}

async function locateGit(): Promise<string> {
  const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
  const localAppData = process.env.LOCALAPPDATA || '';
  const found = await firstExisting([
    nodePath.join(programFiles, 'Git', 'cmd', 'git.exe'),
    nodePath.join(programFiles, 'Git', 'bin', 'git.exe'),
    localAppData ? nodePath.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe') : ''
  ]);
  if (!found) throw new Error('git.exe was not found in the allowlisted install locations');
  return found;
}

function unityVersionKey(version: string): number[] {
  return version
    .split(/[^0-9]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((part) => Number(part));
}

function compareVersionKeys(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export async function findUnityEditors(): Promise<Array<{ version: string; executable: string }>> {
  if (process.platform !== 'win32') return [];
  const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
  const editorRoot = nodePath.join(programFiles, 'Unity', 'Hub', 'Editor');
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = (await fs.readdir(editorRoot, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean }>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: Array<{ version: string; executable: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const executable = nodePath.join(editorRoot, entry.name, 'Editor', 'Unity.exe');
    if (await exists(executable)) found.push({ version: entry.name, executable });
  }
  found.sort((a, b) => compareVersionKeys(unityVersionKey(b.version), unityVersionKey(a.version)));
  return found;
}

async function locateUnity(): Promise<{ version: string; executable: string }> {
  const editors = await findUnityEditors();
  const editor = editors[0];
  if (!editor) throw new Error('Unity Editor was not found under the allowlisted Unity Hub install root');
  return editor;
}

export function allowedProgramNames(): Array<'git' | 'powershell' | 'pwsh' | 'unity'> {
  return ['git', 'powershell', 'pwsh', 'unity'];
}

async function locateProgram(program: 'git' | 'powershell' | 'pwsh' | 'unity'): Promise<string> {
  if (program === 'git') return locateGit();
  if (program === 'powershell' || program === 'pwsh') return locatePowerShell(program);
  return (await locateUnity()).executable;
}

export function assertGitPathsSafe(paths: readonly string[]): string[] {
  if (paths.length === 0) throw new SandboxError('At least one git path is required');
  return paths.map((entry) => {
    const value = String(entry).trim();
    if (!value) throw new SandboxError('Git path cannot be empty');
    if (value.startsWith('-')) throw new SandboxError('Git path cannot be an option');
    return normalizeRelativePath(value);
  });
}

async function ensureUnityProject(roots: readonly Root[], project: string): Promise<Resolved> {
  const resolved = await resolveProjectPath(roots, project);
  const settings = nodePath.join(resolved.real, 'ProjectSettings', 'ProjectVersion.txt');
  if (!(await exists(settings))) throw new SandboxError(`${resolved.virtual} is not a Unity project (ProjectSettings/ProjectVersion.txt is missing)`);
  return resolved;
}

function commandResult(result: { exitCode: number; stdout: string; stderr: string; truncated: boolean }): ToolResult {
  const text = processText(result);
  return result.exitCode === 0 ? ok(text) : fail(text);
}

export function registerProjectInmersionTools(reg: SurfaceRegistrar): void {
  const { ctx, caps, exposedCaps } = reg;

  if (exposedCaps.browse) {
    reg.register(
      'workspace_list',
      {
        title: 'List Project Inmersion workspace',
        description: 'List one folder level inside C:\\Users\\exprt\\Project Inmersion. Paths are relative to that fixed approved root.',
        inputSchema: z.object({ path: relativePath.optional() }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ path }) =>
        reg.guarded('browse', 'workspace_list', async () => {
          const resolved = await resolveProjectPath(ctx.roots, path ?? '.');
          const entries = await fs.readdir(resolved.real, { withFileTypes: true });
          const lines = entries
            .slice(0, 500)
            .map((entry) => `${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'o'} ${entry.name}`);
          if (entries.length > 500) lines.push(`... ${entries.length - 500} more entr${entries.length - 500 === 1 ? 'y' : 'ies'} omitted`);
          return ok(`--- ${resolved.virtual} ---\n${lines.join('\n')}`);
        })
    );
  }

  if (exposedCaps.read) {
    reg.register(
      'workspace_read',
      {
        title: 'Read Project Inmersion text file',
        description: 'Read one UTF-8 text file inside the fixed Project Inmersion root.',
        inputSchema: z
          .object({
            path: z.string().min(1).max(2048),
            max_bytes: z.number().int().min(1).max(MAX_TEXT_BYTES).optional()
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ path, max_bytes }) =>
        reg.guarded('read', 'workspace_read', async () => {
          const resolved = await resolveProjectPath(ctx.roots, path);
          const stat = await fs.stat(resolved.real);
          if (!stat.isFile()) return fail(`${resolved.virtual} is not a file`);
          const cap = max_bytes ?? 256 * 1024;
          if (stat.size > cap) return fail(`${resolved.virtual} is ${stat.size} bytes; raise max_bytes or use the general read tool for ranged reads.`);
          const buffer = await fs.readFile(resolved.real);
          if (buffer.includes(0)) return fail(`${resolved.virtual} looks binary; use read/view_image instead.`);
          return ok(`--- ${resolved.virtual} ---\n${buffer.toString('utf8')}`);
        })
    );
  }

  if (exposedCaps.create || exposedCaps.edit) {
    reg.register(
      'workspace_write',
      {
        title: 'Write Project Inmersion text file',
        description: 'Create or replace one UTF-8 text file inside the fixed Project Inmersion root. The normal create/edit permissions remain authoritative.',
        inputSchema: z
          .object({
            path: z.string().min(1).max(2048),
            content: z.string().max(MAX_TEXT_BYTES),
            create_parents: z.boolean().optional().default(false)
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
      },
      async ({ path, content, create_parents }) =>
        guard('workspace_write', async () => {
          const resolved = await resolveProjectPath(ctx.roots, path, true);
          const present = await exists(resolved.real);
          const required = present ? 'edit' : 'create';
          if (!caps[required]) return fail(`TOOL_DISABLED: workspace_write needs the ${required} permission for this path.`);
          if (create_parents) await fs.mkdir(nodePath.dirname(resolved.real), { recursive: true });
          else if (!(await exists(nodePath.dirname(resolved.real)))) return fail('Parent directory does not exist; pass create_parents=true to create it.');
          const checked = await resolveProjectPath(ctx.roots, path, true);
          await fs.writeFile(checked.real, content, 'utf8');
          return ok(`${present ? 'updated' : 'created'} ${checked.virtual} (${Buffer.byteLength(content, 'utf8')} bytes)`);
        })
    );
  }

  if (exposedCaps.command) {
    reg.register(
      'shell_exec',
      {
        title: 'Run an allowlisted Project Inmersion command',
        description: 'Run only PowerShell, pwsh, Git, or Unity Editor with shell=false. cwd is always inside the fixed Project Inmersion root. Note: cwd containment is not an OS sandbox; PowerShell/Unity can still access other locations with the Windows user privileges they inherit.',
        inputSchema: z
          .object({
            program: z.enum(['powershell', 'pwsh', 'git', 'unity']),
            args: z.array(z.string().max(4096)).max(128).default([]),
            cwd: relativePath.optional(),
            timeout_seconds: timeoutSeconds
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ program, args, cwd, timeout_seconds }) =>
        reg.guarded('command', 'shell_exec', async () => {
          const workdir = await resolveProjectPath(ctx.roots, cwd ?? '.');
          const executable = await locateProgram(program);
          const result = await runProcess(executable, args, workdir.real, (timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT_MS / 1000) * 1000);
          return commandResult(result);
        })
    );

    reg.register(
      'unity_find_editor',
      {
        title: 'Find Unity Editor',
        description: 'Find Unity Hub Editor installs in the allowlisted Program Files Unity location and return newest-first.',
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async () =>
        reg.guarded('command', 'unity_find_editor', async () => {
          // Also prove the fixed project root is approved; these tools are one profile, not a generic program inventory surface.
          projectInmersionRoot(ctx.roots);
          const editors = await findUnityEditors();
          if (editors.length === 0) return fail('Unity Editor was not found under C:\\Program Files\\Unity\\Hub\\Editor.');
          return ok(editors.map((editor) => `${editor.version}\t${editor.executable}`).join('\n'));
        })
    );

    reg.register(
      'unity_open_project',
      {
        title: 'Open Unity project',
        description: 'Open a Unity project located inside Project Inmersion using the newest detected Unity Editor.',
        inputSchema: z.object({ project: z.string().min(1).max(2048) }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      },
      async ({ project }) =>
        reg.guarded('command', 'unity_open_project', async () => {
          const resolved = await ensureUnityProject(ctx.roots, project);
          const editor = await locateUnity();
          const child = spawn(editor.executable, ['-projectPath', resolved.real], {
            cwd: resolved.real,
            env: childEnv(),
            windowsHide: false,
            detached: true,
            shell: false,
            stdio: 'ignore'
          });
          child.unref();
          return ok(`opened ${resolved.virtual} with Unity ${editor.version} (pid ${child.pid ?? 'unknown'})`);
        })
    );

    reg.register(
      'unity_run_tests',
      {
        title: 'Run Unity tests',
        description: 'Run EditMode or PlayMode tests in batch mode for a Unity project inside Project Inmersion.',
        inputSchema: z
          .object({
            project: z.string().min(1).max(2048),
            test_platform: z.enum(['EditMode', 'PlayMode']).default('PlayMode'),
            test_filter: z.string().max(1024).optional(),
            timeout_seconds: timeoutSeconds
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      },
      async ({ project, test_platform, test_filter, timeout_seconds }) =>
        reg.guarded('command', 'unity_run_tests', async () => {
          const resolved = await ensureUnityProject(ctx.roots, project);
          const editor = await locateUnity();
          const resultPath = nodePath.join(resolved.real, 'Temp', 'ChatOnSteroidsTestResults.xml');
          const args = [
            '-batchmode',
            '-nographics',
            '-projectPath',
            resolved.real,
            '-runTests',
            '-testPlatform',
            test_platform,
            '-testResults',
            resultPath,
            '-logFile',
            '-'
          ];
          if (test_filter) args.push('-testFilter', test_filter);
          const result = await runProcess(editor.executable, args, resolved.real, (timeout_seconds ?? 900) * 1000);
          return commandResult(result);
        })
    );

    const registerUnityBuild = (name: 'unity_build_android' | 'unity_export_ios', target: 'Android' | 'iOS'): void => {
      reg.register(
        name,
        {
          title: target === 'Android' ? 'Build Unity Android' : 'Export Unity iOS',
          description: `Run a project-owned static Unity build method for ${target}. The project path and cwd stay inside Project Inmersion; execute_method must name the static method that calls Unity BuildPipeline.`,
          inputSchema: z
            .object({
              project: z.string().min(1).max(2048),
              execute_method: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.+]*$/).max(256),
              timeout_seconds: timeoutSeconds
            })
            .strict(),
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        },
        async ({ project, execute_method, timeout_seconds }) =>
          reg.guarded('command', name, async () => {
            const resolved = await ensureUnityProject(ctx.roots, project);
            const editor = await locateUnity();
            const result = await runProcess(
              editor.executable,
              [
                '-batchmode',
                '-nographics',
                '-quit',
                '-projectPath',
                resolved.real,
                '-buildTarget',
                target,
                '-executeMethod',
                execute_method,
                '-logFile',
                '-'
              ],
              resolved.real,
              (timeout_seconds ?? 1800) * 1000
            );
            return commandResult(result);
          })
      );
    };
    registerUnityBuild('unity_build_android', 'Android');
    registerUnityBuild('unity_export_ios', 'iOS');

    reg.register(
      'git_status',
      {
        title: 'Git status',
        description: 'Run git status --short --branch in a repository inside Project Inmersion.',
        inputSchema: z.object({ repo: relativePath.optional() }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async ({ repo }) =>
        reg.guarded('command', 'git_status', async () => {
          const resolved = await resolveProjectPath(ctx.roots, repo ?? '.');
          const git = await locateGit();
          return commandResult(await runProcess(git, ['status', '--short', '--branch'], resolved.real, DEFAULT_COMMAND_TIMEOUT_MS));
        })
    );

    reg.register(
      'git_commit',
      {
        title: 'Git commit selected files',
        description: 'Commit only explicitly named repository-relative files inside Project Inmersion. Refuses to run when unrelated changes are already staged.',
        inputSchema: z
          .object({
            repo: relativePath.optional(),
            message: z.string().trim().min(1).max(500),
            paths: z.array(z.string().min(1).max(2048)).min(1).max(100)
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      },
      async ({ repo, message, paths }) =>
        reg.guarded('command', 'git_commit', async () => {
          const resolved = await resolveProjectPath(ctx.roots, repo ?? '.');
          const git = await locateGit();
          const selected = assertGitPathsSafe(paths);
          // Resolve each selected path through the same fixed root before git sees it.
          for (const path of selected) await resolveProjectPath(ctx.roots, normalizeRelativePath(`${repo ?? '.'}/${path}`), true);
          const staged = await runProcess(git, ['diff', '--cached', '--name-only'], resolved.real, DEFAULT_COMMAND_TIMEOUT_MS);
          if (staged.exitCode !== 0) return fail(processText(staged));
          if (staged.stdout.trim()) return fail('git_commit refused: the repository already has staged changes. Commit or unstage them explicitly first.');
          const added = await runProcess(git, ['add', '--', ...selected], resolved.real, DEFAULT_COMMAND_TIMEOUT_MS);
          if (added.exitCode !== 0) return fail(processText(added));
          const checked = await runProcess(git, ['diff', '--cached', '--check'], resolved.real, DEFAULT_COMMAND_TIMEOUT_MS);
          if (checked.exitCode !== 0) return fail(processText(checked));
          const committed = await runProcess(git, ['commit', '-m', message], resolved.real, DEFAULT_COMMAND_TIMEOUT_MS);
          return commandResult(committed);
        })
    );
  }
}