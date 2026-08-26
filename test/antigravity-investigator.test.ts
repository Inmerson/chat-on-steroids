import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setAntigravityProcessRunnerForTests } from '../src/main/antigravity/runtime.js';
import {
  findAntigravityProjectIdForTests,
  formatAntigravityInvestigation,
  investigateWithAntigravity
} from '../src/main/antigravity/investigator.js';

const temps: string[] = [];

afterEach(async () => {
  setAntigravityProcessRunnerForTests(null);
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Antigravity fast investigator', () => {
  it('uses the shared bounded runtime with the read-only advisory prompt and six-call target', async () => {
    let captured: Parameters<NonNullable<Parameters<typeof setAntigravityProcessRunnerForTests>[0]>>[0] | null = null;
    setAntigravityProcessRunnerForTests(async (request) => {
      captured = request;
      return {
        finalText: 'Likely lifecycle race.',
        observedFiles: ['src/main/bridge.ts'],
        toolErrors: [],
        toolCalls: 4,
        conversationId: 'conv-fast',
        durationSeconds: 3.2,
        totalTokens: 800,
        partial: false,
        budgetExceeded: false
      };
    });

    const result = await investigateWithAntigravity({
      task: 'Trace the request lifecycle across the repository.',
      cwd: process.cwd()
    });

    expect(captured).not.toBeNull();
    expect(captured!.cwd).toBe(process.cwd());
    expect(captured!.timeoutMs).toBe(60_000);
    expect(captured!.hardToolCalls).toBe(8);
    expect(captured!.allowPartial).toBe(true);
    expect(captured!.prompt).toContain('Trace the request lifecycle across the repository.');
    expect(captured!.prompt).toContain('advisory');
    expect(captured!.prompt).toContain('within 6 tool calls');
    expect(result.report).toBe('Likely lifecycle race.');
  });

  it('reuses only an Antigravity project whose folder URI exactly matches the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-ag-projects-'));
    temps.push(root);
    const projects = path.join(root, 'projects');
    const workspace = path.join(root, 'repo');
    await mkdir(projects, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(projects, 'matching.json'),
      JSON.stringify({
        id: 'project-exact',
        projectResources: { resources: [{ folderUri: `file:///${workspace.replace(/\\/g, '/')}` }] }
      }),
      'utf8'
    );
    await writeFile(
      path.join(projects, 'other.json'),
      JSON.stringify({
        id: 'project-other',
        projectResources: { resources: [{ folderUri: `file:///${path.join(root, 'repo-other').replace(/\\/g, '/')}` }] }
      }),
      'utf8'
    );

    expect(await findAntigravityProjectIdForTests(workspace, projects)).toBe('project-exact');
    expect(await findAntigravityProjectIdForTests(path.join(workspace, 'nested'), projects)).toBeNull();
  });

  it('formats a bounded advisory handoff that reminds Prime to verify it', () => {
    const text = formatAntigravityInvestigation({
      report: 'Likely stale state in bridge.ts.',
      observedFiles: ['src/main/bridge.ts'],
      toolErrors: ['grep_search: unavailable'],
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
    expect(text).toContain('src/main/bridge.ts');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });
});
