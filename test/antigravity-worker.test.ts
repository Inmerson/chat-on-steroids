import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_AGENT_NAME,
  ANTIGRAVITY_MAX_TOOL_CALLS,
  ANTIGRAVITY_MODEL,
  ANTIGRAVITY_TARGET_TOOL_CALLS,
  buildAntigravityArgs,
  ensureAntigravityInvestigatorAgent,
  findAntigravityProjectId,
  formatAntigravityInvestigation,
  parseAntigravityStream,
  runBoundedProcess
} from '../src/main/antigravity-worker.js';

const tempDirs: string[] = [];

async function tempDir(prefix = 'cos-agy-worker-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Antigravity fast investigator', () => {
  it('pins Gemini 3.7 Flash and the real read-only safety boundary', () => {
    const args = buildAntigravityArgs('Find the likely root cause.', 45_000, 'project-123');

    expect(ANTIGRAVITY_MODEL).toBe('gemini-3.7-flash-low');
    expect(ANTIGRAVITY_TARGET_TOOL_CALLS).toBe(6);
    expect(ANTIGRAVITY_MAX_TOOL_CALLS).toBe(8);
    expect(ANTIGRAVITY_AGENT_NAME).toBe('chat-on-steroids-fast-investigator');
    expect(args[args.indexOf('--agent') + 1]).toBe(ANTIGRAVITY_AGENT_NAME);
    expect(args[args.indexOf('--model') + 1]).toBe(ANTIGRAVITY_MODEL);
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    expect(args[args.indexOf('--mode') + 1]).toBe('plan');
    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).not.toContain('--json-schema');
    expect(args[args.indexOf('--project') + 1]).toBe('project-123');
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('45s');
  });

  it('creates a real Antigravity project only when the workspace has no reusable project id', () => {
    const fresh = buildAntigravityArgs('Inspect the repo.', 45_000, null);
    expect(fresh).toContain('--new-project');
    expect(fresh).not.toContain('--project');
  });

  it('keeps the per-task prompt narrow because standing safety rules live in the managed agent', () => {
    const args = buildAntigravityArgs('Trace the failing request path.', 45_000, 'p1');
    const prompt = args[args.indexOf('-p') + 1] ?? '';

    expect(prompt).toContain('Trace the failing request path.');
    expect(prompt).toContain('advisory');
    expect(prompt).toContain('within 6 tool calls');
    expect(prompt.length).toBeLessThan(900);
  });

  it('finds an existing Antigravity project by exact workspace folder and ignores unrelated projects', async () => {
    const workspace = await tempDir('cos-agy-project-');
    const projects = path.join(workspace, 'projects');
    await mkdir(projects);
    const folderUri = `file://${workspace.replace(/\\/g, '/')}`;
    await writeFile(
      path.join(projects, 'match.json'),
      JSON.stringify({ id: 'match-id', name: 'match', projectResources: { resources: [{ folderUri }] } }),
      'utf8'
    );
    await writeFile(
      path.join(projects, 'other.json'),
      JSON.stringify({
        id: 'other-id',
        name: 'other',
        projectResources: { resources: [{ folderUri: 'file://C:/definitely/not/the/workspace' }] }
      }),
      'utf8'
    );

    await expect(findAntigravityProjectId(workspace, projects)).resolves.toBe('match-id');
  });

  it('manages only its own Antigravity agent definition and refuses a user-owned collision', async () => {
    const dir = await tempDir('cos-agy-agent-');
    const managedPath = path.join(dir, `${ANTIGRAVITY_AGENT_NAME}.md`);
    await ensureAntigravityInvestigatorAgent(managedPath);
    const first = await readFile(managedPath, 'utf8');
    expect(first).toContain('managed-by: chat-on-steroids');
    expect(first).toContain('read-only investigator');
    expect(first).toContain('read_file');
    expect(first).toContain('grep_search');
    expect(first).not.toContain('write_file');
    await expect(ensureAntigravityInvestigatorAgent(managedPath)).resolves.toBeUndefined();

    const collision = path.join(dir, 'collision.md');
    await writeFile(collision, 'user-authored agent', 'utf8');
    await expect(ensureAntigravityInvestigatorAgent(collision)).rejects.toThrow(/refus|collision|managed/i);
  });

  it('derives evidence from stream events, sanitizes host paths, and treats model prose as advisory', () => {
    const cwd = 'C:\\work\\repo';
    const stdout = [
      JSON.stringify({
        event: 'init',
        conversation_id: 'conv-1',
        init: { model: ANTIGRAVITY_MODEL, cwd }
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { name: 'read_file', parameters: { Path: 'C:/work/repo/src/main/index.ts' }, output: '200 lines' }
        }
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'grep_search',
          tool_info: {
            name: 'grep_search',
            parameters: { SearchPath: 'C:/work/repo' },
            error: { message: 'failed near C:\\Users\\someone\\private.txt' }
          }
        }
      }),
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-1',
          status: 'SUCCESS',
          response:
            'Likely lifecycle issue in [index.ts](file:///C:/work/repo/src/main/index.ts#L42). Ignore C:\\Users\\someone\\private.txt.',
          duration_seconds: 8.2,
          usage: { total_tokens: 1234 }
        }
      })
    ].join('\n');

    const parsed = parseAntigravityStream(stdout, cwd);
    expect(parsed.conversationId).toBe('conv-1');
    expect(parsed.durationSeconds).toBe(8.2);
    expect(parsed.totalTokens).toBe(1234);
    expect(parsed.observedFiles).toEqual(['src/main/index.ts']);
    expect(parsed.toolCalls).toBe(2);
    expect(parsed.toolErrors).toHaveLength(1);
    expect(parsed.report).toContain('src/main/index.ts#L42');
    expect(parsed.report).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(parsed.report).not.toContain('someone');
    expect(parsed.toolErrors[0]).not.toContain('someone');
    expect(parsed.partial).toBe(false);
    expect(parsed.budgetExceeded).toBe(false);
  });

  it('returns bounded partial evidence when the enforced tool budget stops the worker before a final result', () => {
    const cwd = 'C:\\work\\repo';
    const stdout = [
      JSON.stringify({ event: 'init', conversation_id: 'conv-budget' }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { parameters: { Path: 'C:/work/repo/src/main/index.ts' } }
        }
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'Likely lifecycle issue.' }
      })
    ].join('\n');

    const parsed = parseAntigravityStream(stdout, cwd, { allowPartial: true, budgetExceeded: true });
    expect(parsed.partial).toBe(true);
    expect(parsed.budgetExceeded).toBe(true);
    expect(parsed.report).toContain('Likely lifecycle issue');
    expect(parsed.observedFiles).toEqual(['src/main/index.ts']);
  });

  it('rejects failed or missing final result events instead of returning plausible partial output', () => {
    expect(() =>
      parseAntigravityStream(
        JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error: 'authentication required' } }),
        'C:\\work\\repo'
      )
    ).toThrow(/authentication required/i);

    expect(() =>
      parseAntigravityStream(JSON.stringify({ event: 'step_update', step_update: { state: 'DONE' } }), 'C:\\work\\repo')
    ).toThrow(/final result/i);
  });

  it('bounds subprocess stdout and kills runs that exceed the deadline', async () => {
    const dir = await tempDir();
    const noisy = path.join(dir, 'noisy.cjs');
    await writeFile(noisy, "process.stdout.write('x'.repeat(200000));\n", 'utf8');

    const bounded = await runBoundedProcess(process.execPath, [noisy], dir, 5_000, 32_000);
    expect(Buffer.byteLength(bounded.stdout, 'utf8')).toBeLessThanOrEqual(32_000);
    expect(bounded.truncated).toBe(true);

    const budgeted = path.join(dir, 'budgeted.cjs');
    await writeFile(
      budgeted,
      [
        "let i=0;",
        "const timer=setInterval(()=>{",
        " i++;",
        " console.log(JSON.stringify({event:'step_update',step_update:{step_index:i,state:'ACTIVE',step_type:'tool',tool_name:'read_file',tool_info:{parameters:{Path:'file'+i+'.ts'}}}}));",
        " if(i>=10) clearInterval(timer);",
        "},25);"
      ].join('\n'),
      'utf8'
    );
    const capped = await runBoundedProcess(process.execPath, [budgeted], dir, 5_000, 32_000, 2);
    expect(capped.budgetExceeded).toBe(true);
    expect(capped.timedOut).toBe(false);

    const slow = path.join(dir, 'slow.cjs');
    await writeFile(slow, "setTimeout(() => process.stdout.write('late'), 30000);\n", 'utf8');
    await expect(runBoundedProcess(process.execPath, [slow], dir, 100, 32_000)).rejects.toThrow(/timed out/i);
  });

  it('formats a compact advisory handoff with observed evidence and tool warnings', () => {
    const text = formatAntigravityInvestigation({
      report: 'Likely stale session state in src/main/server.ts:42.',
      observedFiles: ['src/main/server.ts'],
      toolErrors: ['grep_search: search unavailable'],
      toolCalls: 3,
      conversationId: 'conv-2',
      durationSeconds: 7.1,
      totalTokens: 900,
      partial: false,
      budgetExceeded: false
    });

    expect(text).toContain('Antigravity Flash investigator');
    expect(text).toContain('advisory');
    expect(text).toContain('Prime must independently verify');
    expect(text).toContain('src/main/server.ts');
    expect(text).toContain('Tool warnings');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(16_000);
  });
});
