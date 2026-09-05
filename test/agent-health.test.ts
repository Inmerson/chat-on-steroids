import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectAgentHealthEvidence, evaluateAgentHealth } from '../src/main/agent-health.js';
import type { AgentHealthEvidence, AgentHealthInput } from '../src/shared/agent-health.js';
import type { AgentInfo, AgentState } from '../src/shared/session.js';

const NOW = 2_000_000_000;

function broker(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'worker-1',
    role: 'worker',
    label: 'Health worker',
    task: 'test health projection',
    state: 'active',
    createdAt: NOW - 10_000,
    activatedAt: NOW - 9_000,
    finishedAt: null,
    result: null,
    pending: 0,
    awaitingAck: 0,
    delivered: 0,
    conversationId: 'chat-worker-1',
    detachedAt: null,
    lastSeenAt: NOW - 1_000,
    revivable: true,
    sleptAt: null,
    contextTokens: 100,
    ...overrides
  };
}

function evidence(overrides: Partial<AgentHealthEvidence> = {}): AgentHealthEvidence {
  return {
    identity: 'exact',
    browserPresent: true,
    runningToolCalls: 0,
    generating: false,
    activeTurnId: false,
    workflowBlocked: false,
    finiteWait: null,
    ...overrides
  };
}

function input(evidenceOverrides: Partial<AgentHealthEvidence> = {}, brokerOverrides: Partial<AgentInfo> = {}): AgentHealthInput {
  return {
    id: brokerOverrides.id ?? 'worker-1',
    broker: broker(brokerOverrides),
    evidence: evidence(evidenceOverrides)
  };
}

function state(value: AgentState): Partial<AgentInfo> {
  return { state: value };
}

describe('agent health projection', () => {
  it('composes exact agent health evidence only when browser identity matches broker identity', () => {
    const brokerState = broker();
    expect(
      collectAgentHealthEvidence({
        id: brokerState.id,
        broker: brokerState,
        browser: {
          agentId: brokerState.id,
          conversationId: brokerState.conversationId,
          browserPresent: true,
          generating: true,
          activeTurnId: true,
          finiteWait: null
        },
        runningToolCalls: 3,
        transfer: null,
        workflowBlocked: false
      })
    ).toEqual({
      identity: 'exact',
      browserPresent: true,
      runningToolCalls: 3,
      generating: true,
      activeTurnId: true,
      workflowBlocked: false,
      finiteWait: null
    });
  });

  it('fails evidence composition closed on missing or conflicting conversation identity', () => {
    expect(
      collectAgentHealthEvidence({
        id: 'worker-missing',
        broker: null,
        browser: null,
        runningToolCalls: 0,
        transfer: null,
        workflowBlocked: false
      }).identity
    ).toBe('missing');

    const brokerState = broker();
    expect(
      collectAgentHealthEvidence({
        id: brokerState.id,
        broker: brokerState,
        browser: {
          agentId: brokerState.id,
          conversationId: 'different-chat',
          browserPresent: true,
          generating: false,
          activeTurnId: false,
          finiteWait: null
        },
        runningToolCalls: 0,
        transfer: null,
        workflowBlocked: false
      }).identity
    ).toBe('conflict');
  });

  it('gives Prime transfer health evidence precedence over bridge command wait evidence', () => {
    const brokerState = broker({ id: 'prime', role: 'prime', conversationId: 'prime-chat' });
    expect(
      collectAgentHealthEvidence({
        id: 'prime',
        broker: brokerState,
        browser: {
          agentId: 'prime',
          conversationId: 'prime-chat',
          browserPresent: true,
          generating: false,
          activeTurnId: false,
          finiteWait: {
            kind: 'delivery',
            startedAt: NOW - 1_000,
            deadlineMs: 90_000,
            exempt: false,
            recommendedAction: 'retry_delivery'
          }
        },
        runningToolCalls: 0,
        transfer: { startedAt: NOW - 2_000, deadlineMs: 10 * 60_000, frozen: true },
        workflowBlocked: false
      }).finiteWait
    ).toEqual({
      kind: 'transfer',
      startedAt: NOW - 2_000,
      deadlineMs: 10 * 60_000,
      exempt: true,
      recommendedAction: 'observe'
    });
  });

  it('prioritizes an in-flight MCP call over generation and reports healthy work', () => {
    expect(evaluateAgentHealth(input({ runningToolCalls: 1, generating: true }), NOW)).toMatchObject({
      agentId: 'worker-1',
      conversationId: 'chat-worker-1',
      activity: 'tool_call',
      health: 'healthy',
      recommendedAction: 'none',
      evidence: { runningToolCalls: 1, generating: true }
    });
  });

  it('keeps an open generating turn healthy despite old liveness and missing browser presence', () => {
    expect(
      evaluateAgentHealth(
        input({ generating: true, browserPresent: false }, { lastSeenAt: NOW - 60 * 60_000 }),
        NOW
      )
    ).toMatchObject({ activity: 'working', health: 'healthy', recommendedAction: 'none' });
  });

  it('projects detached agents as degraded observers', () => {
    expect(evaluateAgentHealth(input({}, { state: 'detached', detachedAt: NOW - 60_000 }), NOW)).toMatchObject({
      activity: 'working',
      health: 'degraded',
      recommendedAction: 'observe'
    });
  });

  it('projects sleeping agents as healthy without treating page presence as work evidence', () => {
    expect(evaluateAgentHealth(input({ browserPresent: true }, state('sleeping')), NOW)).toMatchObject({
      activity: 'sleeping',
      health: 'healthy'
    });
  });

  it('projects terminal agents as done and healthy', () => {
    expect(evaluateAgentHealth(input({}, state('finished')), NOW)).toMatchObject({ activity: 'done', health: 'healthy' });
    expect(evaluateAgentHealth(input({}, state('failed')), NOW)).toMatchObject({ activity: 'done', health: 'healthy' });
  });

  it('fails closed when exact identity is missing or conflicting', () => {
    expect(evaluateAgentHealth(input({ identity: 'missing' }), NOW)).toMatchObject({
      health: 'unknown',
      recommendedAction: 'observe'
    });
    expect(evaluateAgentHealth(input({ identity: 'conflict' }), NOW)).toMatchObject({
      health: 'unknown',
      recommendedAction: 'observe'
    });
  });

  it('gives an explicit workflow blocker precedence over missing identity', () => {
    expect(evaluateAgentHealth(input({ workflowBlocked: true, identity: 'missing' }), NOW)).toMatchObject({
      health: 'blocked',
      recommendedAction: 'user_attention'
    });
  });

  it('does not stall a finite wait before its existing deadline', () => {
    expect(
      evaluateAgentHealth(
        input({
          finiteWait: {
            kind: 'delivery',
            startedAt: NOW - 89_000,
            deadlineMs: 90_000,
            exempt: false,
            recommendedAction: 'retry_delivery'
          }
        }),
        NOW
      )
    ).toMatchObject({ health: 'healthy', recommendedAction: 'none' });
  });

  it('stalls a non-exempt finite wait after its existing deadline', () => {
    expect(
      evaluateAgentHealth(
        input({
          finiteWait: {
            kind: 'delivery',
            startedAt: NOW - 90_001,
            deadlineMs: 90_000,
            exempt: false,
            recommendedAction: 'retry_delivery'
          }
        }),
        NOW
      )
    ).toMatchObject({
      health: 'stalled',
      recommendedAction: 'retry_delivery',
      evidence: { finiteWaitKind: 'delivery' }
    });
  });

  it('does not stall an exempt finite wait after its nominal deadline', () => {
    expect(
      evaluateAgentHealth(
        input({
          finiteWait: {
            kind: 'transfer',
            startedAt: NOW - 20 * 60_000,
            deadlineMs: 10 * 60_000,
            exempt: true,
            recommendedAction: 'observe'
          }
        }),
        NOW
      )
    ).toMatchObject({ health: 'healthy', recommendedAction: 'none' });
  });

  it('degrades invalid finite-wait timing instead of manufacturing elapsed-time proof', () => {
    for (const finiteWait of [
      {
        kind: 'delivery' as const,
        startedAt: NOW + 1,
        deadlineMs: 90_000,
        exempt: false,
        recommendedAction: 'retry_delivery' as const
      },
      {
        kind: 'delivery' as const,
        startedAt: NOW - 10_000,
        deadlineMs: 0,
        exempt: false,
        recommendedAction: 'retry_delivery' as const
      }
    ]) {
      const snapshot = evaluateAgentHealth(input({ finiteWait }), NOW);
      expect(snapshot).toMatchObject({ health: 'degraded', recommendedAction: 'observe' });
      expect(snapshot.reason).toMatch(/invalid|future|timing/i);
    }
  });

  it('degrades future first-hand liveness evidence instead of treating it as elapsed-time proof', () => {
    const snapshot = evaluateAgentHealth(input({}, { lastSeenAt: NOW + 60_000 }), NOW);
    expect(snapshot).toMatchObject({ health: 'degraded', recommendedAction: 'observe' });
    expect(snapshot.reason).toMatch(/invalid|future/i);
  });

  it('degrades active, invited, and waking agents when browser evidence is absent or unknown', () => {
    for (const agentState of ['active', 'invited', 'waking'] as const) {
      expect(evaluateAgentHealth(input({ browserPresent: null }, { state: agentState }), NOW)).toMatchObject({
        health: 'degraded',
        recommendedAction: 'observe'
      });
    }
  });

  it('is a pure projection and does not mutate broker state', () => {
    const brokerState = broker({ pending: 2, awaitingAck: 1 });
    const before = structuredClone(brokerState);
    const healthInput: AgentHealthInput = {
      id: brokerState.id,
      broker: brokerState,
      evidence: evidence()
    };

    evaluateAgentHealth(healthInput, NOW);

    expect(brokerState).toEqual(before);
  });

  it('projects a missing broker conservatively without inventing a conversation', () => {
    const snapshot = evaluateAgentHealth(
      { id: 'worker-missing', broker: null, evidence: evidence({ identity: 'missing', browserPresent: null }) },
      NOW
    );
    expect(snapshot).toMatchObject({
      agentId: 'worker-missing',
      conversationId: null,
      activity: 'waiting',
      health: 'unknown',
      recommendedAction: 'observe'
    });
  });

  it('keeps health projection and Control Center health wiring read-only by source contract', () => {
    const healthSource = readFileSync(new URL('../src/main/agent-health.ts', import.meta.url), 'utf8');
    const controlCenterSource = readFileSync(
      new URL('../src/main/orchestration/control-center.ts', import.meta.url),
      'utf8'
    );

    for (const forbidden of [
      'wake(',
      'sleepWorker(',
      'finishAgent(',
      'failAgent(',
      'terminateProcess(',
      'terminateProcessIfUnusedSince(',
      'process.kill',
      'taskkill',
      'setInterval('
    ]) {
      expect(healthSource, `agent-health.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }

    for (const forbidden of ['sleepWorker', 'finishAgent', 'failAgent', 'workerConversationGone']) {
      expect(controlCenterSource, `control-center.ts must not import or call ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`)
      );
    }
  });
});
