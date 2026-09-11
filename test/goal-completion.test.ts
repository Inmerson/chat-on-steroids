import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as durable from '../src/main/durable.js';
import * as execution from '../src/main/execution.js';
import { emptyEvidence, trackInFlight, type CallContext } from '../src/main/mcp/call-context.js';
import { createSession, initSessionStore, resetSessionStoreForTests, updateSessionPlan } from '../src/main/session/store.js';
import { evaluateCompletionCandidate } from '../src/main/goal-completion.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const CHAT_A = 'goal-completion-chat-a';
const CHAT_B = 'goal-completion-chat-b';

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-goal-completion-');
  durable.initDurableStore(dir);
  initSessionStore(dir);
});

afterAll(async () => {
  execution.resetExecutionsForTests();
  resetSessionStoreForTests();
  durable.resetDurableForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  execution.resetExecutionsForTests();
  resetSessionStoreForTests();
  initSessionStore(dir);
  await durable.writeDurableNow(execution.EXECUTION_STATE, null);
});

function callContext(conversationId: string, sessionId: string): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: {
      transportKey: null,
      requestId: null,
      conversationId,
      sessionId
    },
    outcome: null,
    evidence: emptyEvidence()
  };
}

describe('Goal completion evidence gate', () => {
  it('continues when the exact session plan has pending work', async () => {
    const session = await createSession({ conversationId: CHAT_A });
    await updateSessionPlan(
      session.id,
      CHAT_A,
      {
        plan: [
          { step: 'Implement parser', status: 'completed' },
          { step: 'Run integration verification', status: 'pending' }
        ]
      },
      100
    );

    const result = await evaluateCompletionCandidate({
      sessionId: session.id,
      conversationId: CHAT_A,
      objective: ''
    });

    expect(result).toMatchObject({ action: 'continue', reason: 'durable_plan_unfinished' });
    if (result.action !== 'continue') throw new Error('expected a continuation decision');
    expect(result.reply).toContain('Run integration verification');
    expect(result.reply).not.toContain('Implement parser');
  });

  it('continues when the exact session plan has in-progress work', async () => {
    const session = await createSession({ conversationId: CHAT_A });
    await updateSessionPlan(
      session.id,
      CHAT_A,
      { plan: [{ step: 'Finish the active migration', status: 'in_progress' }] },
      100
    );

    await expect(
      evaluateCompletionCandidate({ sessionId: session.id, conversationId: CHAT_A, objective: '' })
    ).resolves.toMatchObject({ action: 'continue', reason: 'durable_plan_unfinished' });
  });

  it('does not let another session plan veto this session', async () => {
    const a = await createSession({ conversationId: CHAT_A });
    const b = await createSession({ conversationId: CHAT_B });
    await updateSessionPlan(
      b.id,
      CHAT_B,
      { plan: [{ step: 'Unfinished work in B', status: 'pending' }] },
      100
    );

    await expect(
      evaluateCompletionCandidate({ sessionId: a.id, conversationId: CHAT_A, objective: '' })
    ).resolves.toEqual({ action: 'allow_stop', reason: 'no_contradictory_core_evidence' });
  });

  it('waits while the exact conversation still owns an in-flight tool call', async () => {
    const session = await createSession({ conversationId: CHAT_A });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = trackInFlight(callContext(CHAT_A, session.id), async () => {
      await blocked;
    });

    try {
      await expect(
        evaluateCompletionCandidate({ sessionId: session.id, conversationId: CHAT_A, objective: '' })
      ).resolves.toEqual({ action: 'wait', reason: 'tool_work_in_flight' });
    } finally {
      release();
      await running;
    }
  });

  it('keeps an infinite execution active after a milestone completion candidate', async () => {
    const session = await createSession({ conversationId: CHAT_A });
    const run = await execution.createExecution({ plan: 'Complete milestone A.', mode: 'infinite' });
    await execution.bindExecutionConversation(run.id, CHAT_A);

    const result = await evaluateCompletionCandidate({
      sessionId: session.id,
      conversationId: CHAT_A,
      objective: 'Keep improving the approved objective.'
    });

    expect(result).toMatchObject({ action: 'continue', reason: 'infinite_execution_milestone_only' });
  });

  it('allows a lightweight no-plan chat to stop when Core has no contradictory evidence', async () => {
    const session = await createSession({ conversationId: CHAT_A });

    await expect(
      evaluateCompletionCandidate({ sessionId: session.id, conversationId: CHAT_A, objective: '' })
    ).resolves.toEqual({ action: 'allow_stop', reason: 'no_contradictory_core_evidence' });
  });
});
