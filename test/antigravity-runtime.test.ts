import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_MODEL,
  antigravityChildEnvForTests,
  buildAntigravityArgsForTests,
  parseAntigravityStreamForTests,
  runBoundedProcessForTests
} from '../src/main/antigravity/runtime.js';

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cos-antigravity-runtime-'));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('shared Antigravity CLI runtime', () => {
  it('pins Flash Low in plan+sandbox mode and never inherits paid API keys', () => {
    const args = buildAntigravityArgsForTests({
      prompt: 'Inspect the repo.',
      cwd: 'C:\\work\\repo',
      timeoutMs: 45_000,
      hardToolCalls: 8,
      allowPartial: true,
      projectId: 'project-123'
    });
    const childEnv = antigravityChildEnvForTests({
      Path: 'C:\\Windows\\System32',
      GEMINI_API_KEY: 'gemini-secret',
      GOOGLE_API_KEY: 'google-secret',
      OPENROUTER_API_KEY: 'openrouter-secret'
    });

    expect(ANTIGRAVITY_MODEL).toBe('gemini-3.7-flash-low');
    expect(args).toContain('--model');
    expect(args).toContain('gemini-3.7-flash-low');
    expect(args).toContain('--effort');
    expect(args).toContain('low');
    expect(args).toContain('--mode');
    expect(args).toContain('plan');
    expect(args).toContain('--sandbox');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--project');
    expect(args).toContain('project-123');
    expect(args).toContain('--print-timeout');
    expect(args).toContain('45s');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(childEnv.GEMINI_API_KEY).toBeUndefined();
    expect(childEnv.GOOGLE_API_KEY).toBeUndefined();
    expect(childEnv.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('uses --new-project only when explicitly requested', () => {
    const fresh = buildAntigravityArgsForTests({
      prompt: 'Inspect.',
      cwd: 'C:\\work\\repo',
      timeoutMs: 1_001,
      hardToolCalls: 8,
      allowPartial: true,
      newProject: true
    });
    const neutral = buildAntigravityArgsForTests({
      prompt: 'Inspect.',
      cwd: 'C:\\work\\repo',
      timeoutMs: 1_001,
      hardToolCalls: 8,
      allowPartial: true
    });

    expect(fresh).toContain('--new-project');
    expect(neutral).not.toContain('--new-project');
    expect(neutral).not.toContain('--project');
    expect(fresh[fresh.indexOf('--print-timeout') + 1]).toBe('2s');
  });

  it('parses final evidence and sanitizes absolute host paths', () => {
    const cwd = 'C:\\work\\repo';
    const stdout = [
      JSON.stringify({ event: 'init', conversation_id: 'conv-1' }),
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
        step_update: {
          step_index: 2,
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'grep_search',
          tool_info: {
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
          response: 'Likely issue in C:\\work\\repo\\src\\main\\index.ts; ignore C:\\Users\\someone\\private.txt.',
          duration_seconds: 8.2,
          usage: { total_tokens: 1234 }
        }
      })
    ].join('\n');

    const parsed = parseAntigravityStreamForTests(stdout, cwd);
    expect(parsed.conversationId).toBe('conv-1');
    expect(parsed.durationSeconds).toBe(8.2);
    expect(parsed.totalTokens).toBe(1234);
    expect(parsed.observedFiles).toEqual(['src/main/index.ts']);
    expect(parsed.toolCalls).toBe(2);
    expect(parsed.toolErrors).toHaveLength(1);
    expect(parsed.finalText).toContain('src\\main\\index.ts');
    expect(parsed.finalText).not.toContain('C:\\work\\repo');
    expect(parsed.finalText).not.toContain('C:\\Users\\someone');
    expect(parsed.toolErrors[0]).not.toContain('C:\\Users\\someone');
    expect(parsed.partial).toBe(false);
    expect(parsed.budgetExceeded).toBe(false);
  });

  it('bounds output, terminates on the ninth tool start, and returns partial evidence', async () => {
    const dir = await tempDir();
    const script = path.join(dir, 'budgeted.cjs');
    await writeFile(
      script,
      [
        "let i=0;",
        "const timer=setInterval(()=>{",
        " i++;",
        " console.log(JSON.stringify({event:'step_update',step_update:{step_index:i,state:'ACTIVE',step_type:'tool',tool_name:'read_file',tool_info:{parameters:{Path:'src/file'+i+'.ts'}}}}));",
        " if(i>=20){clearInterval(timer); setTimeout(()=>{}, 10000);}",
        "},15);"
      ].join('\n'),
      'utf8'
    );

    const capped = await runBoundedProcessForTests(process.execPath, [script], dir, 5_000, 64 * 1024, 8);
    expect(capped.budgetExceeded).toBe(true);
    expect(capped.timedOut).toBe(false);
    expect(Buffer.byteLength(capped.stdout, 'utf8')).toBeLessThanOrEqual(64 * 1024);

    const parsed = parseAntigravityStreamForTests(capped.stdout, dir, {
      allowPartial: true,
      budgetExceeded: true
    });
    expect(parsed.budgetExceeded).toBe(true);
    expect(parsed.partial).toBe(true);
    expect(parsed.toolCalls).toBeGreaterThanOrEqual(9);
  });

  it('kills a process that exceeds its timeout', async () => {
    const dir = await tempDir();
    const slow = path.join(dir, 'slow.cjs');
    await writeFile(slow, "setTimeout(() => process.stdout.write('late'), 30000);\n", 'utf8');
    await expect(runBoundedProcessForTests(process.execPath, [slow], dir, 100, 64 * 1024, 8)).rejects.toThrow(/timed out/i);
  });
});
