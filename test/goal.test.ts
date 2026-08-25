/**
 * Session Goal lifecycle and privacy boundary.
 *
 * Provider transport is tested in antigravity-goal-driver.test.ts. This file pins the durable
 * session/revision contract, transcript projection, browser draft idempotency and the exact
 * message the page is allowed to type.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalDriverResult } from '../src/main/antigravity/goal-driver.js';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8')
  }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests } = await import(
  '../src/main/session/store.js'
);
const goalState = await import('../src/main/goal-state.js');
const goalDriver = await import('../src/main/antigravity/goal-driver.js');
const goal = await import('../src/main/goal.js');
const continuation = await import('../src/main/session/continuation.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

async function settled(conversationId: string, clientId?: string): Promise<NonNullable<ReturnType<typeof goal.goalViewFor>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = goal.goalViewFor(conversationId, clientId);
    if (view && view.stage !== 'sending' && view.stage !== 'answering') return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the draft never settled');
}

async function activeSession(conversationId: string, text = 'build the parser'): Promise<{ sessionId: string; revision: number }> {
  const session = await createSession({ title: 'goal', conversationId });
  const messageId = `manual-${conversationId}`;
  await appendEvent(session.id, {
    time: 1_000,
    source: 'extension',
    kind: 'user_message',
    messageId,
    provenance: 'manual',
    message: { text, truncated: false, chars: text.length }
  });
  const state = goalState.noteManualGoal(session.id, text, messageId);
  return { sessionId: session.id, revision: state.revision };
}

beforeAll(async () => {
  dir = await makeTempDir('clf-goal-antigravity-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
});

afterAll(async () => {
  goalDriver.setGoalDriverForTests(null);
  resetDurableForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  goal.resetGoalStateForTests();
  goalState.resetGoalStatesForTests();
  goalDriver.setGoalDriverForTests(null);
  continuation.resetContinuationsForTests();
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true } });
});

afterEach(() => {
  goalDriver.setGoalDriverForTests(null);
});

describe('what the Goal Driver may see', () => {
  it('projects only manual/legacy user rows and final assistant answers', async () => {
    const session = await createSession({ title: 'goal transcript', conversationId: 'c-projection' });
    await appendEvent(session.id, {
      time: 1,
      source: 'extension',
      kind: 'user_message',
      messageId: 'u-manual',
      provenance: 'manual',
      message: { text: 'build the parser', truncated: false, chars: 16 }
    });
    await appendEvent(session.id, {
      time: 2,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'a-1',
      final: true,
      message: { text: 'parser written', truncated: false, chars: 14 }
    });
    await appendEvent(session.id, {
      time: 3,
      source: 'extension',
      kind: 'user_message',
      messageId: 'u-goal',
      provenance: 'goal',
      message: { text: 'run the tests', truncated: false, chars: 13 }
    });
    await appendEvent(session.id, {
      time: 4,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'a-2',
      final: true,
      message: { text: 'tests passed', truncated: false, chars: 12 }
    });
    await appendEvent(session.id, {
      time: 5,
      source: 'extension',
      kind: 'user_message',
      messageId: 'u-bootstrap',
      provenance: 'bootstrap',
      message: { text: 'Continue previous session', truncated: false, chars: 25 }
    });
    await appendEvent(session.id, {
      time: 6,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'a-stream',
      final: false,
      message: { text: 'half written', truncated: false, chars: 12 }
    });
    await appendEvent(session.id, {
      time: 7,
      source: 'extension',
      kind: 'user_message',
      messageId: 'u-legacy',
      message: { text: 'legacy authored context', truncated: false, chars: 23 }
    });

    expect(await goal.conversationMessages(session.id)).toEqual([
      { role: 'user', content: 'build the parser' },
      { role: 'assistant', content: 'parser written' },
      { role: 'assistant', content: 'tests passed' },
      { role: 'user', content: 'legacy authored context' }
    ]);
  });

  it('never sends tool calls/results and preserves the conclusion of a long final answer', async () => {
    const session = await createSession({ title: 'goal privacy', conversationId: 'c-privacy' });
    await appendEvent(session.id, {
      time: 1,
      source: 'extension',
      kind: 'user_message',
      provenance: 'manual',
      message: { text: 'fix the race', truncated: false, chars: 12 }
    });
    await appendEvent(session.id, {
      time: 2,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'secret-call',
        tool: 'read',
        attribution: 'request_id',
        requestId: 'wfr_secret',
        conversationId: 'c-privacy',
        attributionMethod: 'request_id',
        args: { text: '{"path":"C:/private/secret.env"}', truncated: false, chars: 31 },
        result: { text: 'SECRET=hunter2', truncated: false, chars: 14 },
        outcome: 'ok',
        durationMs: 1,
        summary: { kind: 'read', tone: 'neutral', title: 'Read secret.env' }
      }
    });
    const conclusion = 'FINAL RESULT: all focused tests are green';
    const answer = `analysis starts here\n${'x'.repeat(14_000)}\n${conclusion}`;
    await appendEvent(session.id, {
      time: 3,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: { text: answer, truncated: false, chars: answer.length }
    });

    const messages = await goal.conversationMessages(session.id);
    const projected = JSON.stringify(messages);
    expect(projected).not.toContain('hunter2');
    expect(projected).not.toContain('secret.env');
    expect(messages.at(-1)?.content).toContain(conclusion);
    expect(messages.at(-1)?.content.length).toBeLessThanOrEqual(12_000);
  });
});

describe('Antigravity-backed draft lifecycle', () => {
  it('passes the active goal and bounded transcript to the driver without an API-key gate', async () => {
    const { sessionId, revision } = await activeSession('c-driver');
    await appendEvent(sessionId, {
      time: 2_000,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: { text: 'parser written, tests pending', truncated: false, chars: 28 }
    });
    let captured: Parameters<typeof goalDriver.draftGoalWithAntigravity>[0] | null = null;
    goalDriver.setGoalDriverForTests(async (input) => {
      captured = input;
      return { kind: 'message', text: 'run the parser tests next' };
    });

    goal.startGoalDraft({ sessionId, conversationId: 'c-driver', turnId: 'g-1', revision } as any);
    const view = await settled('c-driver');

    expect(view.stage).toBe('ready');
    expect(view.model).toBe('gemini-3.7-flash-low');
    expect(view.reply).toBe(goal.humanReply('run the parser tests next'));
    expect(captured).toEqual({
      goal: 'build the parser',
      messages: [
        { role: 'user', content: 'build the parser' },
        { role: 'assistant', content: 'parser written, tests pending' }
      ]
    });
    expect(goal.goalSettings()).toMatchObject({
      enabled: true,
      provider: 'antigravity',
      model: 'gemini-3.7-flash-low'
    });
  });

  it('marks the captured goal revision complete on NO_REPLY', async () => {
    const { sessionId, revision } = await activeSession('c-done');
    goalDriver.setGoalDriverForTests(async () => ({ kind: 'no-reply', raw: 'NO_REPLY' }));

    goal.startGoalDraft({ sessionId, conversationId: 'c-done', turnId: 'g-1', revision } as any);
    const view = await settled('c-done');
    expect(view.stage).toBe('no-reply');
    expect(view.reply).toBe('');
    expect(goalState.goalForSession(sessionId)).toMatchObject({ revision, status: 'complete' });
  });

  it('marks the captured goal revision failed when the driver fails', async () => {
    const { sessionId, revision } = await activeSession('c-failed');
    goalDriver.setGoalDriverForTests(async () => {
      throw new Error('agy unavailable');
    });

    goal.startGoalDraft({ sessionId, conversationId: 'c-failed', turnId: 'g-1', revision } as any);
    const view = await settled('c-failed');
    expect(view.stage).toBe('failed');
    expect(view.error).toMatch(/agy unavailable/i);
    expect(goalState.goalForSession(sessionId)).toMatchObject({ revision, status: 'failed' });
  });
});

describe('revision and continuation fences', () => {
  it('never exposes a late result from an older goal revision', async () => {
    const active = await activeSession('c-stale-revision', 'first goal');
    let release!: (value: GoalDriverResult) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    goalDriver.setGoalDriverForTests(async () => {
      entered();
      return await new Promise<GoalDriverResult>((resolve) => { release = resolve; });
    });
    goal.startGoalDraft({ sessionId: active.sessionId, conversationId: 'c-stale-revision', turnId: 'g-1', revision: active.revision });
    await started;
    const newer = goalState.noteManualGoal(active.sessionId, 'newer goal', 'manual-newer');
    release({ kind: 'message', text: 'stale follow-up' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(goal.goalViewFor('c-stale-revision')).toBeNull();
    expect(goalState.goalForSession(active.sessionId)).toMatchObject({ revision: newer.revision, consecutiveAutoTurns: 0, status: 'active' });
  });

  it('withdraws a ready reply as soon as Compact & Resume owns the session', async () => {
    const active = await activeSession('c-compaction-wins', 'finish the migration');
    goalDriver.setGoalDriverForTests(async () => ({ kind: 'message', text: 'continue after this' }));
    goal.startGoalDraft({ sessionId: active.sessionId, conversationId: 'c-compaction-wins', turnId: 'g-1', revision: active.revision });
    expect((await settled('c-compaction-wins')).reply).not.toBe('');
    await continuation.openContinuationNow(active.sessionId, 'c-compaction-wins');
    expect(goal.goalViewFor('c-compaction-wins')).toBeNull();
  });

  it('counts successful generated sends once and stops the revision at 32', async () => {
    const active = await activeSession('c-auto-cap', 'long unattended goal');
    goalDriver.setGoalDriverForTests(async () => ({ kind: 'message', text: 'continue' }));
    for (let index = 0; index < 32; index += 1) {
      const started = goal.startGoalDraft({
        sessionId: active.sessionId,
        conversationId: 'c-auto-cap',
        turnId: `g-${index}`,
        revision: active.revision
      });
      await settled('c-auto-cap');
      expect(goal.ackGoalDraft('c-auto-cap', started.token, undefined, true)).toBe(true);
      // Lost ACK replay must not count twice.
      expect(goal.ackGoalDraft('c-auto-cap', started.token, undefined, true)).toBe(true);
    }
    expect(goalState.goalForSession(active.sessionId)).toMatchObject({ status: 'stopped', consecutiveAutoTurns: 32 });
  });
});

describe('one draft per generation', () => {
  it('answers a repeated request for the same turn with the same draft and one driver call', async () => {
    const { sessionId, revision } = await activeSession('c-once', 'carry on');
    let calls = 0;
    goalDriver.setGoalDriverForTests(async () => {
      calls += 1;
      return { kind: 'message', text: 'and the docs' };
    });

    const first = goal.startGoalDraft({ sessionId, conversationId: 'c-once', turnId: 'g-1', revision } as any);
    const second = goal.startGoalDraft({ sessionId, conversationId: 'c-once', turnId: 'g-1', revision } as any);
    expect(second.token).toBe(first.token);
    await settled('c-once');
    expect(calls).toBe(1);
  });

  it('gives one browser tab exclusive authority to type an unspent draft', async () => {
    const { sessionId, revision } = await activeSession('c-tab-owner', 'finish this once');
    goalDriver.setGoalDriverForTests(async () => ({ kind: 'message', text: 'one follow-up only' }));

    const first = goal.startGoalDraft({
      sessionId,
      conversationId: 'c-tab-owner',
      turnId: 'tab-a-generation',
      clientId: 'tab-a',
      revision
    } as any);
    await settled('c-tab-owner', 'tab-a');

    expect(goal.goalViewFor('c-tab-owner', 'tab-a')?.token).toBe(first.token);
    expect(goal.goalViewFor('c-tab-owner', 'tab-b')).toBeNull();
    expect(() =>
      goal.startGoalDraft({
        sessionId,
        conversationId: 'c-tab-owner',
        turnId: 'tab-b-generation',
        clientId: 'tab-b',
        revision
      } as any)
    ).toThrow('goal_owned_elsewhere');
    expect(goal.ackGoalDraft('c-tab-owner', first.token, 'tab-b')).toBe(false);
  });

  it('keeps an acknowledged generation spent and never publishes a late driver result', async () => {
    const { sessionId, revision } = await activeSession('c-ack', 'again');
    let resolveDriver!: (value: GoalDriverResult) => void;
    let calls = 0;
    goalDriver.setGoalDriverForTests(
      () =>
        new Promise((resolve) => {
          calls += 1;
          resolveDriver = resolve;
        })
    );

    const first = goal.startGoalDraft({ sessionId, conversationId: 'c-ack', turnId: 'g-1', revision } as any);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(goal.ackGoalDraft('c-ack', first.token)).toBe(true);
    resolveDriver({ kind: 'message', text: 'late reply must disappear' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(goal.goalViewFor('c-ack')).toBeNull();
    const retried = goal.startGoalDraft({ sessionId, conversationId: 'c-ack', turnId: 'g-1', revision } as any);
    expect(retried.token).toBe(first.token);
    expect(calls).toBe(1);
  });

  it('retires every outstanding draft without allowing the same generation to redraft', async () => {
    const { sessionId, revision } = await activeSession('c-retire', 'keep going');
    let calls = 0;
    goalDriver.setGoalDriverForTests(
      () =>
        new Promise(() => {
          calls += 1;
        })
    );

    const first = goal.startGoalDraft({ sessionId, conversationId: 'c-retire', turnId: 'g-retire', revision } as any);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(goal.retireGoalDrafts()).toBe(1);
    expect(goal.goalViewFor('c-retire')).toBeNull();
    const retried = goal.startGoalDraft({ sessionId, conversationId: 'c-retire', turnId: 'g-retire', revision } as any);
    expect(retried.token).toBe(first.token);
    expect(calls).toBe(1);
  });

  it('expires only the visible payload, not the generation tombstone', async () => {
    const { sessionId, revision } = await activeSession('c-expired', 'keep going');
    let calls = 0;
    goalDriver.setGoalDriverForTests(async () => {
      calls += 1;
      return { kind: 'message', text: 'one last correction' };
    });

    const first = goal.startGoalDraft({ sessionId, conversationId: 'c-expired', turnId: 'g-expired', revision } as any);
    expect((await settled('c-expired')).stage).toBe('ready');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    try {
      expect(goal.goalViewFor('c-expired')).toBeNull();
      const retried = goal.startGoalDraft({ sessionId, conversationId: 'c-expired', turnId: 'g-expired', revision } as any);
      expect(retried.token).toBe(first.token);
      expect(calls).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('the message a person would have typed', () => {
  it('removes em dashes without touching protected paths, commands or URLs', () => {
    const written =
      'run `npm run verify` first — then look at src/renderer/chat.ts, and report at https://example.com/build/latest please';
    const typed = goal.humanReply(written);
    expect(typed).not.toContain('—');
    expect(typed).toContain('`npm run verify`');
    expect(typed).toContain('src/renderer/chat.ts');
    expect(typed).toContain('https://example.com/build/latest');
  });

  it('is deterministic for a retried draft', () => {
    const written =
      'the settings sheet still overflows on the right, can you cap the column and check the select as well. i really do not want another guess about it.';
    expect(goal.humanReply(written)).toBe(goal.humanReply(written));
    expect(goal.humanReply(`${written} also the picker.`)).not.toBe(goal.humanReply(written));
  });

  it('leaves a message with nothing to spoil unchanged', () => {
    expect(goal.humanReply('ok cool')).toBe('ok cool');
  });
});
