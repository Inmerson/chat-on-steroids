import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  resetSessionStoreForTests,
  unsetSessionRootForTests
} from '../src/main/session/store.js';
import {
  observeRequestCorrelation,
  requestCorrelation,
  resetCorrelationRegistryForTests,
  restoreRequestCorrelations
} from '../src/main/session/correlation.js';

const call = (id: string, requestId: string, conversationId: string) => ({
  time: Date.now(), source: 'mcp' as const, kind: 'tool_call' as const,
  call: {
    callId: id, tool: 'read', attribution: 'request_id' as const,
    requestId, conversationId, attributionMethod: 'request_id' as const,
    args: { text: '{}', truncated: false, chars: 2 },
    result: { text: 'ok', truncated: false, chars: 2 },
    outcome: 'ok' as const, durationMs: 1,
    summary: { kind: 'read' as const, tone: 'neutral' as const, title: id }
  }
});

afterEach(() => {
  resetCorrelationRegistryForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
});

it('reconciles a stale nonempty correlation snapshot with newer durable attributed history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'clf-stale-correlation-'));
  try {
    initDurableStore(dir);
    initSessionStore(dir);
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const session = await createSession({ title: 'stale index repro', conversationId });

    observeRequestCorrelation({
      requestId: 'wfr_old', conversationId, sessionId: session.id,
      messageId: 'msg-old', tool: 'read', observedAt: 1
    });
    await appendEvent(session.id, call('call-old', 'wfr_old', conversationId));
    await flushDurable(); // disk snapshot contains only wfr_old

    observeRequestCorrelation({
      requestId: 'wfr_new', conversationId, sessionId: session.id,
      messageId: 'msg-new', tool: 'read', observedAt: 2
    });
    await appendEvent(session.id, call('call-new', 'wfr_new', conversationId));
    // Simulate process loss inside the 300ms debounce window: session JSONL is already durable,
    // while the updated correlation snapshot is still only queued in memory.
    resetCorrelationRegistryForTests();
    resetDurableForTests();
    initDurableStore(dir);

    await restoreRequestCorrelations();
    expect(requestCorrelation('wfr_old')?.conversationId).toBe(conversationId);
    // This is the desired invariant and currently fails: restore returns after seeing wfr_old
    // and never scans the durable call-new event.
    expect(requestCorrelation('wfr_new')?.conversationId).toBe(conversationId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
