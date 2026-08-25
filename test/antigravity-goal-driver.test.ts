import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AntigravityRunRequest, AntigravityRunResult } from '../src/main/antigravity/runtime.js';

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env['TEMP'] ?? process.env['TMP'] ?? process.cwd()
  }
}));

const runtime = await import('../src/main/antigravity/runtime.js');
const goalDriver = await import('../src/main/antigravity/goal-driver.js');

const baseResult = (finalText: string): AntigravityRunResult => ({
  finalText,
  observedFiles: [],
  toolErrors: [],
  toolCalls: 0,
  conversationId: 'goal-driver-test',
  durationSeconds: 0.1,
  totalTokens: 100,
  partial: false,
  budgetExceeded: false
});

beforeEach(() => {
  goalDriver.setGoalDriverForTests(null);
});

afterEach(() => {
  runtime.setAntigravityProcessRunnerForTests(null);
  goalDriver.setGoalDriverForTests(null);
});

describe('Antigravity Goal Driver', () => {
  it('runs in app-owned scratch space with no repository tool budget and an explicit goal contract', async () => {
    let captured: AntigravityRunRequest | null = null;
    runtime.setAntigravityProcessRunnerForTests(async (request) => {
      captured = request;
      return baseResult('  run the parser tests next  ');
    });

    const result = await goalDriver.draftGoalWithAntigravity({
      goal: 'build the parser',
      messages: [
        { role: 'user', content: 'build the parser' },
        { role: 'assistant', content: 'parser written, tests pending' }
      ]
    });

    expect(result).toEqual({ kind: 'message', text: 'run the parser tests next' });
    expect(captured).not.toBeNull();
    expect(captured!.cwd.toLowerCase()).not.toContain(process.cwd().toLowerCase());
    expect(captured!.hardToolCalls).toBe(0);
    expect(captured!.timeoutMs).toBeLessThan(180_000);
    expect(captured!.allowPartial).toBe(false);
    expect(captured!.projectId).toBeUndefined();
    expect(captured!.newProject).toBeUndefined();
    expect(captured!.prompt).toContain('ACTIVE GOAL:\nbuild the parser');
    expect(captured!.prompt).toContain('exactly NO_REPLY');
    expect(captured!.prompt).toContain('parser written, tests pending');
  });

  it('accepts exact NO_REPLY as the only no-message protocol record', async () => {
    runtime.setAntigravityProcessRunnerForTests(async () => baseResult('NO_REPLY'));
    await expect(
      goalDriver.draftGoalWithAntigravity({ goal: 'finish it', messages: [{ role: 'user', content: 'finish it' }] })
    ).resolves.toEqual({ kind: 'no-reply', raw: 'NO_REPLY' });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['x'.repeat(4_001), 'too long'],
    ['NO_REPLY\ncontinue anyway', 'protocol'],
    ['continue anyway\nNO_REPLY', 'protocol']
  ])('rejects malformed output: %s', async (finalText, expected) => {
    runtime.setAntigravityProcessRunnerForTests(async () => baseResult(finalText));
    await expect(
      goalDriver.draftGoalWithAntigravity({ goal: 'finish it', messages: [{ role: 'user', content: 'finish it' }] })
    ).rejects.toThrow(new RegExp(expected, 'i'));
  });

  it('rejects any tool-derived or partial runtime evidence', async () => {
    for (const patch of [
      { toolCalls: 1 },
      { toolErrors: ['read_file failed'] },
      { partial: true },
      { budgetExceeded: true },
      { observedFiles: ['src/main/index.ts'] }
    ] satisfies Array<Partial<AntigravityRunResult>>) {
      runtime.setAntigravityProcessRunnerForTests(async () => ({ ...baseResult('continue'), ...patch }));
      await expect(
        goalDriver.draftGoalWithAntigravity({ goal: 'finish it', messages: [{ role: 'user', content: 'finish it' }] })
      ).rejects.toThrow(/tool|partial|evidence|budget/i);
    }
  });
});
