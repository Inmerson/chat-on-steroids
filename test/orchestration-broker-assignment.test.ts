import { describe, expect, it } from 'vitest';

import {
  assignmentEvidenceInSnapshot,
  assignmentMarker
} from '../src/main/orchestration/broker-assignment.js';

function worker(id: string, task: string, queue: Array<{ text: string }> = []) {
  return {
    info: {
      id,
      role: 'worker',
      label: id,
      task,
      state: 'sleeping',
      createdAt: 1,
      activatedAt: 2,
      finishedAt: null,
      result: null,
      pending: queue.length,
      awaitingAck: 0,
      delivered: 0,
      conversationId: `chat-${id}`,
      detachedAt: null,
      lastSeenAt: 3,
      revivable: true,
      sleptAt: 4,
      contextTokens: 0
    },
    queue: queue.map((entry, index) => ({
      id: `m-${index}`,
      from: 'prime',
      to: id,
      time: index,
      text: entry.text,
      offeredAt: null,
      offers: 0,
      offeredOnFinish: false,
      offeredViaRevival: false,
      ackedAt: null
    }))
  };
}

const base = {
  version: 5,
  savedAt: 1,
  runId: 'broker-run',
  primeConversationId: 'prime-A',
  startedAt: 1,
  agents: [],
  dormantRuns: []
} as const;

describe('V3 broker assignment evidence', () => {
  it('finds a fresh-spawn assignment marker in the exact owner worker task', () => {
    const marker = assignmentMarker('11111111-1111-4111-8111-111111111111');
    const snapshot = { ...base, agents: [worker('worker-2', `${marker}\nTask: T1`)] };
    expect(assignmentEvidenceInSnapshot(snapshot, 'prime-A', marker)).toEqual({
      workerId: 'worker-2',
      source: 'bootstrap_task'
    });
  });

  it('finds a reuse assignment marker in the durable worker queue', () => {
    const marker = assignmentMarker('22222222-2222-4222-8222-222222222222');
    const snapshot = {
      ...base,
      agents: [worker('worker-2', 'old task', [{ text: `${marker}\nTask: T2` }])]
    };
    expect(assignmentEvidenceInSnapshot(snapshot, 'prime-A', marker)).toEqual({
      workerId: 'worker-2',
      source: 'message_queue'
    });
  });

  it('never searches another Prime history for assignment evidence', () => {
    const marker = assignmentMarker('33333333-3333-4333-8333-333333333333');
    const snapshot = {
      ...base,
      primeConversationId: 'prime-B',
      agents: [worker('worker-1', `${marker}\nTask: B`)],
      dormantRuns: [{
        primeConversationId: 'prime-A',
        startedAt: 1,
        parkedAt: 2,
        agents: [worker('worker-2', 'A old task')]
      }]
    };
    expect(assignmentEvidenceInSnapshot(snapshot, 'prime-A', marker)).toBeNull();
  });

  it('fails closed when one assignment marker appears under two workers', () => {
    const marker = assignmentMarker('44444444-4444-4444-8444-444444444444');
    const snapshot = {
      ...base,
      agents: [worker('worker-2', marker), worker('worker-3', 'old', [{ text: marker }])]
    };
    expect(() => assignmentEvidenceInSnapshot(snapshot, 'prime-A', marker)).toThrow(/ambiguous/i);
  });

  it('returns null rather than guessing when no exact marker line exists', () => {
    const marker = assignmentMarker('55555555-5555-4555-8555-555555555555');
    const snapshot = { ...base, agents: [worker('worker-2', `prefix ${marker} suffix`)] };
    expect(assignmentEvidenceInSnapshot(snapshot, 'prime-A', marker)).toBeNull();
  });
});
