/**
 * The session recorder, its store, and everything that reads back out of it.
 *
 * Real files in a real temp folder, because the properties that matter here are
 * durability properties: a torn line must cost one event and not a session, a
 * reopened conversation must continue its own log, and a handoff must survive the
 * pruner. None of that is observable against an in-memory fake.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { lineDelta, formatDelta } from '../src/main/diffstat.js';
import { chunkText } from '../src/main/mcp/tools.js';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import {
  awaitFreshCallOrigin,
  closeConversation,
  freshCallOrigin,
  flushRecorder,
  liveConversations,
  noteChatOrigin,
  recordChatObservations,
  recordToolCall,
  rebindConversation,
  repairDeterministicAttribution,
  resetRecorderForTests,
  sessionForConversation,
  setAgentBinder
} from '../src/main/session/recorder.js';
import {
  appendEvent,
  autoCompactionReady,
  claimAutoCompaction,
  createSession,
  deleteSession,
  endSession,
  flushSessions,
  getSession,
  initSessionStore,
  latestHandoff,
  listSessions,
  MAX_MESSAGE_CHARS,
  pruneSessions,
  readAsset,
  readEvents,
  readHandoff,
  rebindSession,
  renameSession,
  reopenSession,
  resetSessionStoreForTests,
  saveHandoff,
  sessionsRoot,
  unsetSessionRootForTests,
  upsertMessageEvent,
  writeAsset
} from '../src/main/session/store.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';
import { HANDOFF_BRIEF_RULES, nativeHandoffPrompt } from '../src/main/session/handoff-prompt.js';
import {
  estimateTokens,
  eventTokens,
  foldProgress,
  originTitle,
  tokenPressure,
  type SessionEvent,
  type SessionOrigin
} from '../src/shared/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

async function enableRecording(record = true): Promise<void> {
  await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-session-');
  initConfigPath(dir);
  initSessionStore(dir);
  await enableRecording();
});

afterAll(async () => {
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(() => {
  resetRecorderForTests();
  resetSessionStoreForTests();
});

const evidence = (patch: Partial<ReturnType<typeof emptyEvidence>> = {}) => ({ ...emptyEvidence(), ...patch });
const legacyRecordChatObservations = recordChatObservations as unknown as (
  conversationId: string,
  observations: readonly unknown[],
  agent?: string | null
) => Promise<{ sessionId: string | null; stored: number }>;

// Compile-only shims for the skipped 1.7 heuristic regression archive below. Production no
// longer exports either API; keeping that block skipped is useful history without reviving
// the dead ownership mechanisms just to satisfy TypeScript.
const setBrowserReporterPresent = (_present: () => boolean): void => undefined;
const soleGeneratingConversation = (): string | null => null;

// ------------------------------------------------------------------- store

describe('session store', () => {
  it('numbers events in append order and reads them back unchanged', async () => {
    const summary = await createSession({ title: 'ordering', conversationId: null });
    const kinds: SessionEvent['kind'][] = ['user_message', 'turn_start', 'progress', 'turn_end'];
    await appendEvent(summary.id, {
      time: 1000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'do the thing', truncated: false, chars: 12 }
    });
    await appendEvent(summary.id, { time: 1001, source: 'extension', kind: 'turn_start' });
    await appendEvent(summary.id, {
      time: 1002,
      source: 'extension',
      kind: 'progress',
      message: { text: 'reading files', truncated: false, chars: 13 }
    });
    await appendEvent(summary.id, { time: 1003, source: 'extension', kind: 'turn_end', outcome: 'completed' });

    const events = await readEvents(summary.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.kind)).toEqual(kinds);
  });

  it('reorders late events only inside the durable turn that owns them', async () => {
    const summary = await createSession({ title: 'deferred append' });
    await appendEvent(summary.id, { time: 1000, source: 'extension', kind: 'turn_start', turnId: 'g-order' });
    await appendEvent(summary.id, {
      time: 5000,
      source: 'extension',
      kind: 'progress',
      turnId: 'g-order',
      message: { text: 'later progress', truncated: false, chars: 14 }
    });
    // Arrived late, but logically happened between the two rows above.
    await appendEvent(summary.id, {
      time: 2000,
      source: 'extension',
      kind: 'progress',
      turnId: 'g-order',
      message: { text: 'earlier progress', truncated: false, chars: 16 }
    });
    await appendEvent(summary.id, { time: 6000, source: 'extension', kind: 'turn_end', turnId: 'g-order', outcome: 'completed' });
    const events = await readEvents(summary.id);
    expect(events.map((event) => event.kind)).toEqual(['turn_start', 'progress', 'progress', 'turn_end']);
    expect(events.slice(1, 3).map((event) => event.time)).toEqual([2000, 5000]);
    // The JSONL stays append-only: the logically earlier progress still has the later seq.
    expect(events[1]!.seq).toBeGreaterThan(events[2]!.seq);
  });

  it('keeps a session from ageing backwards when a call is written late', async () => {
    const summary = await createSession({ title: 'late append' });
    const now = Date.now();
    await appendEvent(summary.id, { time: now, source: 'extension', kind: 'turn_end', outcome: 'completed' });
    await appendEvent(summary.id, { time: now - 5000, source: 'mcp', kind: 'turn_start' });
    expect((await getSession(summary.id))?.updatedAt).toBe(now);
  });

  it('filters by kind and by starting sequence number', async () => {
    const summary = await createSession({ title: 'filters' });
    for (let i = 0; i < 6; i++) {
      await appendEvent(summary.id, {
        time: 1000 + i,
        source: 'extension',
        kind: i % 2 === 0 ? 'progress' : 'turn_start',
        ...(i % 2 === 0 ? { message: { text: `step ${i}`, truncated: false, chars: 6 } } : {})
      } as never);
    }
    const progress = await readEvents(summary.id, { kinds: ['progress'] });
    expect(progress).toHaveLength(3);
    const tail = await readEvents(summary.id, { from: 4 });
    expect(tail.every((event) => event.seq >= 4)).toBe(true);
    expect(await readEvents(summary.id, { limit: 2 })).toHaveLength(2);
  });

  it('never downgrades a final canonical message when a stale streaming snapshot arrives later', async () => {
    const summary = await createSession({ title: 'terminal canonical final' });
    const messageId = 'msg-terminal-final';
    const final = await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Complete answer.', truncated: false, chars: 16 },
      renderedHtml: { text: '<p><strong>Complete</strong> answer.</p>', truncated: false, chars: 40 },
      state: 'final',
      final: true
    });
    const stale = await upsertMessageEvent(summary.id, {
      time: 120,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Complete', truncated: false, chars: 8 },
      renderedHtml: { text: '<p>Complete</p>', truncated: false, chars: 15 },
      state: 'streaming',
      final: false
    });

    expect(stale.changed).toBe(false);
    expect(stale.event.seq).toBe(final.event.seq);
    const [stored] = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(stored?.kind === 'assistant_message' && stored.final).toBe(true);
    expect(stored?.kind === 'assistant_message' && stored.message.text).toBe('Complete answer.');
  });

  it('keeps rich HTML when the same canonical prose is reobserved without rendered HTML', async () => {
    const summary = await createSession({ title: 'sparse rich final' });
    const messageId = 'msg-sparse-rich';
    const message = { text: 'Bold answer', truncated: false, chars: 11 };
    await upsertMessageEvent(summary.id, {
      time: 200,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message,
      renderedHtml: { text: '<p><strong>Bold</strong> answer</p>', truncated: false, chars: 35 },
      state: 'final',
      final: true
    });
    const repeated = await upsertMessageEvent(summary.id, {
      time: 220,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message,
      state: 'final',
      final: true
    });

    expect(repeated.changed).toBe(false);
    expect(repeated.event.kind === 'assistant_message' && repeated.event.renderedHtml?.text).toBe(
      '<p><strong>Bold</strong> answer</p>'
    );
    expect(await readEvents(summary.id, { kinds: ['assistant_message'] })).toHaveLength(1);
  });

  it('revises one canonical row only when the website logical identity is the same', async () => {
    const summary = await createSession({ title: 'stable website identity' });
    const turnId = 'g-stream-growth';
    const logicalId = 'thought-website-parent';
    const snapshots = [
      'Eight calls in, still zero writes.',
      'Eight calls in, still zero writes. The repo was already very',
      'Eight calls in, still zero writes. The repo was already very dirty before this check.'
    ];

    for (let index = 0; index < snapshots.length; index++) {
      const text = snapshots[index]!;
      await upsertMessageEvent(summary.id, {
        time: 100 + index,
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId: logicalId,
        message: { text, truncated: false, chars: text.length },
        state: index === snapshots.length - 1 ? 'final' : 'streaming',
        final: index === snapshots.length - 1
      });
    }

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind === 'assistant_message' && messages[0].messageId).toBe(logicalId);
    expect(messages[0]?.kind === 'assistant_message' && messages[0].message.text).toBe(snapshots.at(-1));
    expect(messages[0]?.kind === 'assistant_message' && messages[0].state).toBe('final');
  });

  it('keeps the first sequence as the origin of a revised stable user message', async () => {
    const summary = await createSession({ title: 'stable user boundary' });
    const message = { text: 'the user turn boundary', truncated: false, chars: 22 };
    const first = await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'user_message',
      turnId: 'page-user-before',
      messageId: 'user-stable-boundary',
      message
    });
    const revised = await upsertMessageEvent(summary.id, {
      time: 200,
      source: 'extension',
      kind: 'user_message',
      turnId: 'page-user-after',
      messageId: 'user-stable-boundary',
      message
    });

    expect(revised.changed).toBe(true);
    expect(first.event.kind === 'user_message' && first.event.origin).toBe(first.event.seq);
    expect(revised.event.kind === 'user_message' && revised.event.origin).toBe(first.event.seq);
    expect(revised.event.seq).toBeGreaterThan(first.event.seq);
    const stored = await readEvents(summary.id, { kinds: ['user_message'] });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.kind === 'user_message' && stored[0].origin).toBe(first.event.seq);
  });

  it('never merges distinct website identities merely because their prose is a prefix continuation', async () => {
    const summary = await createSession({ title: 'distinct website identities' });
    const turnId = 'g-distinct-prefix';
    const first = 'First checkpoint.';
    const second = 'First checkpoint. Second checkpoint.';

    for (const [messageId, text] of [
      ['thought-parent-a', first],
      ['thought-parent-b', second]
    ] as const) {
      await upsertMessageEvent(summary.id, {
        time: Date.now(),
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId,
        message: { text, truncated: false, chars: text.length },
        state: 'streaming',
        final: false
      });
    }

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(2);
    expect(messages.map((event) => event.kind === 'assistant_message' && event.messageId)).toEqual([
      'thought-parent-a',
      'thought-parent-b'
    ]);
  });

  it('does not merge separate streaming commentary that merely shares a turn', async () => {
    const summary = await createSession({ title: 'separate streaming commentary' });
    const turnId = 'g-separate-commentary';
    for (const [messageId, text] of [
      ['comment-a', 'First three are clean; continuing the checks.'],
      ['comment-b', 'Eight calls in; still zero writes.']
    ] as const) {
      await upsertMessageEvent(summary.id, {
        time: Date.now(),
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId,
        message: { text, truncated: false, chars: text.length },
        state: 'streaming',
        final: false
      });
    }

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(2);
    expect(messages.map((event) => event.kind === 'assistant_message' && event.message.text)).toEqual([
      'First three are clean; continuing the checks.',
      'Eight calls in; still zero writes.'
    ]);
  });

  it('keeps a settled raw website id distinct from a different provisional id', async () => {
    const summary = await createSession({ title: 'different id at final' });
    const turnId = 'g-stream-final-remount';
    const text = 'The completed answer is already fully visible.';
    await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'assistant_message',
      turnId,
      messageId: 'raw-streaming',
      message: { text, truncated: false, chars: text.length },
      state: 'streaming',
      final: false
    });
    await upsertMessageEvent(summary.id, {
      time: 110,
      source: 'extension',
      kind: 'assistant_message',
      turnId,
      messageId: 'raw-final-remount',
      message: { text, truncated: false, chars: text.length },
      state: 'final',
      final: true
    });

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(2);
    expect(messages.map((event) => event.kind === 'assistant_message' && event.messageId)).toEqual([
      'raw-streaming',
      'raw-final-remount'
    ]);
    expect(messages[1]?.kind === 'assistant_message' && messages[1].state).toBe('final');
  });

  it('keeps running counters and a token estimate on the summary', async () => {
    const summary = await createSession({ title: 'counters' });
    await appendEvent(summary.id, {
      time: 1,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'x'.repeat(400), truncated: false, chars: 400 }
    });
    await appendEvent(summary.id, {
      time: 2,
      source: 'extension',
      kind: 'chat_error',
      message: { text: 'something broke', truncated: false, chars: 15 }
    });
    await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', outcome: 'interrupted' });

    const after = await getSession(summary.id);
    expect(after?.userMessages).toBe(1);
    expect(after?.errors).toBe(1);
    expect(after?.lastTurnOutcome).toBe('interrupted');
    expect(after?.estimatedTokens).toBeGreaterThanOrEqual(100);
  });

  it('does not advance seq or summary state when the durable append fails', async () => {
    const summary = await createSession({ title: 'append failure is not an event' });
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(
        appendEvent(summary.id, {
          time: 10,
          source: 'extension',
          kind: 'user_message',
          message: { text: 'phantom', truncated: false, chars: 7 }
        })
      ).rejects.toThrow('disk full');
    } finally {
      append.mockRestore();
    }

    const afterFailure = await getSession(summary.id);
    expect(afterFailure?.events).toBe(0);
    expect(afterFailure?.userMessages).toBe(0);
    expect(await readEvents(summary.id)).toHaveLength(0);

    const written = await appendEvent(summary.id, {
      time: 11,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'real', truncated: false, chars: 4 }
    });
    expect(written.seq).toBe(1);
    expect((await getSession(summary.id))?.events).toBe(1);
  });

  it('skips a torn final line and keeps appending after it', async () => {
    const summary = await createSession({ title: 'recovery' });
    await appendEvent(summary.id, {
      time: 1,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'first', truncated: false, chars: 5 }
    });
    await appendEvent(summary.id, {
      time: 2,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'second', truncated: false, chars: 6 }
    });

    // Exactly what a crash mid-append leaves behind: a line with no closing brace.
    const file = path.join(sessionsRoot(), summary.id, 'events.jsonl');
    await fs.appendFile(file, '{"seq":3,"kind":"user_mess', 'utf8');
    resetSessionStoreForTests();

    const recovered = await readEvents(summary.id);
    expect(recovered).toHaveLength(2);

    await appendEvent(summary.id, {
      time: 4,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'third', truncated: false, chars: 5 }
    });
    const all = await readEvents(summary.id);
    expect(all).toHaveLength(3);
    // The number after a torn line must not collide with one already used.
    expect(new Set(all.map((event) => event.seq)).size).toBe(3);
    expect(all[2]!.seq).toBeGreaterThan(all[1]!.seq);
  });

  it('recovers a session whose meta.json is gone', async () => {
    const summary = await createSession({ title: 'no meta' });
    await appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start' });
    resetSessionStoreForTests();
    await fs.rm(path.join(sessionsRoot(), summary.id, 'meta.json'), { force: true });

    await appendEvent(summary.id, { time: 2, source: 'extension', kind: 'turn_end', outcome: 'completed' });
    const events = await readEvents(summary.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it('stores assets once per content and refuses a malformed asset id', async () => {
    const summary = await createSession({ title: 'assets' });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const first = await writeAsset(summary.id, png, 'image/png');
    const second = await writeAsset(summary.id, png, 'image/png');
    expect(second.id).toBe(first.id);
    expect(first.id.endsWith('.png')).toBe(true);

    const files = await fs.readdir(path.join(sessionsRoot(), summary.id, 'assets'));
    expect(files).toHaveLength(1);
    expect(await readAsset(summary.id, first.id)).toEqual(png);
    expect(await readAsset(summary.id, '../../../config.json')).toBeNull();
  });

  it('arms automatic compaction only on a real below-to-above threshold crossing', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'auto edge', conversationId: 'conv-auto-edge' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        messageId: 'u1',
        message: { text: 'a'.repeat(30_000), truncated: false, chars: 30_000 }
      });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

      await appendEvent(summary.id, { time: 2, source: 'extension', kind: 'turn_start', turnId: 't-edge' });
      await appendEvent(summary.id, {
        time: 3,
        source: 'extension',
        kind: 'user_message',
        messageId: 'u2',
        turnId: 't-edge',
        message: { text: 'b'.repeat(12_000), truncated: false, chars: 12_000 }
      });
      let current = await getSession(summary.id);
      expect(current?.autoCompactThreshold).toBe(10_000);
      expect(current?.autoCompactArmedAt).toBe(3);
      expect(current?.autoCompactReadyAt).toBeNull();

      await appendEvent(summary.id, { time: 4, source: 'extension', kind: 'turn_end', turnId: 't-edge', outcome: 'completed' });
      current = await getSession(summary.id);
      expect(autoCompactionReady(current)).toBe(true);
      expect(current?.autoCompactReadyAt).toBe(4);
      expect(await claimAutoCompaction(summary.id, 'conv-auto-edge')).toBe(true);
      expect(await claimAutoCompaction(summary.id, 'conv-auto-edge')).toBe(false);
      expect((await getSession(summary.id))?.autoCompactTriggeredAt).not.toBeNull();
    } finally {
      await saveConfig(base);
    }
  });

  it('never makes a stopped crossing ready, even if a final assistant snapshot arrived first', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'stopped auto edge', conversationId: 'conv-auto-stopped' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        messageId: 'before',
        message: { text: 'a'.repeat(30_000), truncated: false, chars: 30_000 }
      });
      await appendEvent(summary.id, { time: 2, source: 'extension', kind: 'turn_start', turnId: 't-stop' });
      await appendEvent(summary.id, {
        time: 3,
        source: 'extension',
        kind: 'user_message',
        messageId: 'cross',
        turnId: 't-stop',
        message: { text: 'b'.repeat(12_000), truncated: false, chars: 12_000 }
      });
      await appendEvent(summary.id, {
        time: 4,
        source: 'extension',
        kind: 'assistant_message',
        messageId: 'a-stop',
        turnId: 't-stop',
        message: { text: 'Looks final for a moment.', truncated: false, chars: 25 },
        state: 'final',
        final: true
      });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

      // An unrelated completion cannot release this edge either.
      await appendEvent(summary.id, { time: 5, source: 'extension', kind: 'turn_end', turnId: 't-other', outcome: 'completed' });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

      await appendEvent(summary.id, { time: 6, source: 'extension', kind: 'turn_end', turnId: 't-stop', outcome: 'stopped' });
      const current = await getSession(summary.id);
      expect(autoCompactionReady(current)).toBe(false);
      expect(current?.autoCompactArmedAt).toBeNull();
      expect(current?.autoCompactReadyAt).toBeNull();
      expect(current?.autoCompactTurnId).toBeNull();
    } finally {
      await saveConfig(base);
    }
  });

  it('keeps an automatic edge the crossing turn lost, until a turn finishes cleanly', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'lost edge', conversationId: 'conv-lost-edge' });
      await appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start', turnId: 't-crossed' });
      await appendEvent(summary.id, {
        time: 2,
        source: 'extension',
        kind: 'user_message',
        messageId: 'cross',
        turnId: 't-crossed',
        message: { text: 'c'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      expect((await getSession(summary.id))?.autoCompactArmedAt).toBe(2);

      // The turn that crossed the line was interrupted. A counter that only grows can never
      // cross it again, so treating this as the end of the matter loses the trigger forever.
      await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', turnId: 't-crossed', outcome: 'interrupted' });
      let current = await getSession(summary.id);
      expect(autoCompactionReady(current)).toBe(false);
      expect(current?.autoCompactReadyAt).toBeNull();
      expect(current?.autoCompactThreshold).toBe(10_000);

      // A turn that fails does not make it ready either.
      await appendEvent(summary.id, { time: 4, source: 'extension', kind: 'turn_start', turnId: 't-failed' });
      await appendEvent(summary.id, { time: 5, source: 'extension', kind: 'turn_end', turnId: 't-failed', outcome: 'failed' });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

      // The next turn this log opens and sees finish cleanly does.
      await appendEvent(summary.id, { time: 6, source: 'extension', kind: 'turn_start', turnId: 't-clean' });
      await appendEvent(summary.id, { time: 7, source: 'extension', kind: 'turn_end', turnId: 't-clean', outcome: 'completed' });
      current = await getSession(summary.id);
      expect(autoCompactionReady(current)).toBe(true);
      expect(current?.autoCompactReadyAt).toBe(7);

      // Still exactly one automatic compaction per chat: claiming it is terminal, and later
      // clean turns above the line cannot produce a second.
      expect(await claimAutoCompaction(summary.id, 'conv-lost-edge')).toBe(true);
      await appendEvent(summary.id, { time: 8, source: 'extension', kind: 'turn_start', turnId: 't-after' });
      await appendEvent(summary.id, { time: 9, source: 'extension', kind: 'turn_end', turnId: 't-after', outcome: 'completed' });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(false);
      expect(await claimAutoCompaction(summary.id, 'conv-lost-edge')).toBe(false);
    } finally {
      await saveConfig(base);
    }
  });

  it('does not turn stale transcript hydration into a live automatic crossing', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'hydrated stale chat', conversationId: 'conv-hydrated-stale' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        messageId: 'historic-user',
        message: { text: 'x'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      await appendEvent(summary.id, {
        time: 2,
        source: 'extension',
        kind: 'assistant_message',
        messageId: 'historic-answer',
        message: { text: 'old settled answer', truncated: false, chars: 18 },
        state: 'final',
        final: true
      });
      let current = await getSession(summary.id);
      expect(current?.contextTokens).toBeGreaterThan(10_000);
      expect(autoCompactionReady(current)).toBe(false);
      expect(current?.autoCompactArmedAt).toBeNull();

      // Even a later clean turn while the chat remains above the line is not a new crossing.
      await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_start', turnId: 't-later' });
      await appendEvent(summary.id, { time: 4, source: 'extension', kind: 'turn_end', turnId: 't-later', outcome: 'completed' });
      current = await getSession(summary.id);
      expect(autoCompactionReady(current)).toBe(false);
      expect(current?.autoCompactReadyAt).toBeNull();
    } finally {
      await saveConfig(base);
    }
  });

  it('does not synthesize an automatic crossing when an old chat is already above the threshold', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: false, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'stale high chat', conversationId: 'conv-stale-high' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        messageId: 'old',
        message: { text: 'x'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      expect((await getSession(summary.id))?.contextTokens).toBeGreaterThan(10_000);

      // Turning automatic compaction on, opening the chat, or writing another message while
      // already above the line is still not a threshold crossing.
      await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
      await appendEvent(summary.id, {
        time: 2,
        source: 'extension',
        kind: 'user_message',
        messageId: 'new',
        message: { text: 'still here', truncated: false, chars: 10 }
      });
      const current = await getSession(summary.id);
      expect(autoCompactionReady(current)).toBe(false);
      expect(current?.autoCompactArmedAt).toBeNull();
      expect(current?.autoCompactReadyAt).toBeNull();
    } finally {
      await saveConfig(base);
    }
  });

  it('forgets an unclaimed automatic edge when a genuinely closed chat is reopened later', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'stale ready edge', conversationId: 'conv-stale-ready' });
      await appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start', turnId: 't-ready' });
      await appendEvent(summary.id, {
        time: 2,
        source: 'extension',
        kind: 'user_message',
        messageId: 'cross-ready',
        turnId: 't-ready',
        message: { text: 'r'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', turnId: 't-ready', outcome: 'completed' });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);

      await endSession(summary.id);
      await reopenSession(summary.id);
      const reopened = await getSession(summary.id);
      expect(autoCompactionReady(reopened)).toBe(false);
      expect(reopened?.autoCompactThreshold).toBeNull();
      expect(reopened?.autoCompactReadyAt).toBeNull();
      expect(reopened?.autoCompactTurnId).toBeNull();
      expect(await claimAutoCompaction(summary.id, 'conv-stale-ready')).toBe(false);
    } finally {
      await saveConfig(base);
    }
  });
});

// ---------------------------------------------------------------- handoffs

describe('handoff storage', () => {
  const handoff = (sessionId: string, id: string, createdAt: number) => ({
    id,
    sessionId,
    createdAt,
    model: 'deepseek/test',
    reasoning: 'medium',
    text: 'TASK — finish the thing',
    sourceEvents: 3,
    sourceTokens: 120,
    notes: []
  });

  it('saves, reads back and reports the newest across sessions', async () => {
    const older = await createSession({ title: 'older' });
    const newer = await createSession({ title: 'newer' });
    await saveHandoff(handoff(older.id, '2026-01-01-aaaaaaaa', 1000));
    await saveHandoff(handoff(newer.id, '2026-01-02-bbbbbbbb', 2000));
    await appendEvent(older.id, {
      time: 1000,
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-01-aaaaaaaa',
      chars: 23,
      reason: 'manual'
    });
    await appendEvent(newer.id, {
      time: 2000,
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-02-bbbbbbbb',
      chars: 23,
      reason: 'resume'
    });

    expect((await readHandoff(older.id, '2026-01-01-aaaaaaaa'))?.text).toContain('TASK');
    expect((await latestHandoff())?.id).toBe('2026-01-02-bbbbbbbb');
    expect((await getSession(newer.id))?.lastHandoffId).toBe('2026-01-02-bbbbbbbb');
    await deleteSession(older.id);
    await deleteSession(newer.id);
  });

  it('never prunes the session holding the newest handoff', async () => {
    const stale = await createSession({ title: 'stale' });
    const kept = await createSession({ title: 'kept' });
    await saveHandoff(handoff(kept.id, '2026-01-03-cccccccc', Date.now()));
    await appendEvent(kept.id, {
      time: Date.now(),
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-03-cccccccc',
      chars: 23,
      reason: 'manual'
    });

    // Age both sessions past the retention window by rewriting their summaries.
    // Flushed first: the test seam forgets state without writing meta.json.
    await flushSessions();
    resetSessionStoreForTests();
    const long = Date.now() - 90 * 24 * 3600_000;
    for (const id of [stale.id, kept.id]) {
      const metaPath = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(metaPath, JSON.stringify({ ...meta, updatedAt: long }), 'utf8');
    }

    const removed = await pruneSessions(30);
    expect(removed).toBeGreaterThanOrEqual(1);
    const ids = (await listSessions()).map((entry) => entry.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(stale.id);
    await deleteSession(kept.id);
  });

  it('splits a long brief on blank lines and keeps every character', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => `SECTION ${i}\n${'detail '.repeat(20)}`);
    const text = blocks.join('\n\n');
    const parts = chunkText(text, 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(500);
    expect(parts.join('\n\n')).toBe(text);
  });

  it('splits a single oversized block rather than returning it whole', () => {
    const parts = chunkText('x'.repeat(2500), 1000);
    expect(parts).toHaveLength(3);
    expect(parts.join('')).toHaveLength(2500);
  });

  it('returns one part when the brief already fits', () => {
    expect(chunkText('short brief', 1000)).toEqual(['short brief']);
  });

  it('asks for user-authoritative handoffs up to the documented 30k-token ceiling', () => {
    const prompt = nativeHandoffPrompt();
    expect(prompt).toContain(HANDOFF_BRIEF_RULES);
    expect(prompt).toMatch(/user's messages as the highest-authority source/i);
    expect(prompt).toMatch(/10,000[–-]30,000 tokens/i);
    expect(prompt).toMatch(/~6,000-token brief is normally too short/i);
    expect(prompt).toMatch(/Never exceed 30,000 tokens/i);
    expect(prompt).toMatch(/lossless operational compression/i);
    expect(prompt).toMatch(/failure.*root cause.*change.*verification/i);
    expect(prompt).toMatch(/PLANNED \/ DECIDED/i);
    expect(prompt).toMatch(/FAILED \/ UNRESOLVED/i);
    expect(prompt).toMatch(/VERIFICATION/i);
    expect(prompt).toMatch(/completed and verified/i);
  });
});

// ---------------------------------------------------------------- recorder

describe.skip('legacy recorder heuristics removed in 1.8', () => {
  // Historical fixtures below intentionally contain browser observation kinds 1.8 no longer
  // accepts. Keep the archive compileable without widening the production ChatObservation
  // contract back to progress/tool_block/turn_state.
  const recordChatObservations = legacyRecordChatObservations;
  it('records nothing at all while recording is switched off', async () => {
    const before = (await listSessions()).length;
    await enableRecording(false);
    try {
      expect(await sessionForConversation('conv-off')).toBeNull();
      expect(
        await recordToolCall({
          tool: 'read_file',
          args: { path: '/project/a.ts' },
          content: [{ type: 'text', text: 'x' }],
          outcome: 'ok',
          durationMs: 5,
          startedAt: Date.now()
        })
      ).toBeNull();
      expect(await listSessions()).toHaveLength(before);
    } finally {
      await enableRecording(true);
    }
  });

  /**
   * One sentence, re-stamped by the page halfway through being typed.
   *
   * Live in a worker chat: ChatGPT mounted "I'm checking the README directly and will
   * report only the heading" as an assistant markdown block (`#a0`), then wrapped it in its
   * reasoning container and rebuilt the node, so the rest of the same sentence arrived under
   * a commentary stamp (`#p0`). Both were recorded, and the Chat panel drew the sentence
   * twice with the first copy frozen at its prefix. A snapshot that begins with the whole of
   * the caption this turn is growing is that caption, whatever the page now calls it.
   */
  it('keeps one caption when ChatGPT re-stamps it mid-sentence', async () => {
    const sessionId = await sessionForConversation('conv-restamp');
    const now = Date.now();
    await recordChatObservations('conv-restamp', [
      { kind: 'turn_start', time: now, turnId: 'turn-restamp' },
      { kind: 'progress', time: now, turnId: 'turn-restamp', text: 'Checking the README and will', progressId: 'turn-restamp#a0' },
      {
        kind: 'progress',
        time: now + 1,
        turnId: 'turn-restamp',
        text: 'Checking the README and will report only the heading',
        progressId: 'turn-restamp#a0'
      },
      {
        kind: 'progress',
        time: now + 2,
        turnId: 'turn-restamp',
        text: 'Checking the README and will report only the heading',
        progressId: 'turn-restamp#p0'
      },
      {
        kind: 'progress',
        time: now + 3,
        turnId: 'turn-restamp',
        text: 'Checking the README and will report only the heading plus one sentence.',
        progressId: 'turn-restamp#p0'
      }
    ]);

    const stored = await readEvents(sessionId!, { kinds: ['progress'] });
    expect(new Set(stored.map((event) => (event as { progressId?: string }).progressId)).size).toBe(1);
    const last = stored.at(-1)!;
    expect(last.kind === 'progress' && last.message.text).toBe(
      'Checking the README and will report only the heading plus one sentence.'
    );
  });

  it('forks a reused DOM progress id when ChatGPT starts a genuinely new caption', async () => {
    const sessionId = await sessionForConversation('conv-reused-progress-root');
    const now = Date.now();
    await recordChatObservations('conv-reused-progress-root', [
      { kind: 'turn_start', time: now, turnId: 'turn-reused-progress-root' },
      {
        kind: 'progress',
        time: now + 1,
        turnId: 'turn-reused-progress-root',
        text: 'Inspecting session attribution',
        progressId: 'turn-reused-progress-root#p0'
      },
      {
        // Same DOM root, much later, completely different logical commentary. This is the
        // live shape that put "Inspection finished…" at the beginning of a 15 minute turn.
        kind: 'progress',
        time: now + 15_000,
        turnId: 'turn-reused-progress-root',
        text: 'Inspection finished, no files modified. The ranked',
        progressId: 'turn-reused-progress-root#p0'
      },
      {
        kind: 'progress',
        time: now + 15_001,
        turnId: 'turn-reused-progress-root',
        text: 'Inspection finished, no files modified. The ranked critique is ready.',
        progressId: 'turn-reused-progress-root#p0'
      }
    ]);

    const stored = await readEvents(sessionId!, { kinds: ['progress'] });
    expect(stored).toHaveLength(3);
    expect(stored[0]!.kind === 'progress' && stored[0]!.progressId).toBe('turn-reused-progress-root#p0');
    expect(stored[1]!.kind === 'progress' && stored[1]!.progressId).not.toBe('turn-reused-progress-root#p0');
    expect(stored[1]!.kind === 'progress' && stored[1]!.origin).toBeUndefined();
    expect(stored[2]!.kind === 'progress' && stored[2]!.origin).toBe(stored[1]!.seq);
    expect(stored[1]!.time).toBe(now + 15_000);
  });

  it('restores the newest still-open generation after the recorder restarts', async () => {
    const now = Date.now();
    const before = await sessionForConversation('conv-open-after-restart');
    await recordChatObservations('conv-open-after-restart', [
      { kind: 'turn_start', time: now, turnId: 'g-old-document-1' }
    ]);
    expect(liveConversations().find((entry) => entry.conversationId === 'conv-open-after-restart')?.activeTurnId).toBe(
      'g-old-document-1'
    );

    // Memory is gone; the durable session remains. A replacement content script must be
    // handed the old document's generation id instead of minting a second one.
    resetRecorderForTests();
    const after = await sessionForConversation('conv-open-after-restart');
    expect(after).toBe(before);
    const restored = liveConversations().find((entry) => entry.conversationId === 'conv-open-after-restart');
    expect(restored?.generating).toBe(true);
    expect(restored?.activeTurnId).toBe('g-old-document-1');
  });

  it('attributes a tool call to the conversation whose page showed the tool block', async () => {
    const sessionId = await sessionForConversation('conv-turn');
    await recordChatObservations('conv-turn', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-77' },
      { kind: 'tool_block', time: Date.now(), turnId: 'turn-77', count: 1 }
    ]);
    const call = await recordToolCall({
      tool: 'apply_patch',
      args: { patch: '*** Begin Patch\n*** Update File: /project/src/main.ts\n*** End Patch' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 42,
      startedAt: Date.now(),
      evidence: evidence({ changes: [{ path: '/project/src/main.ts', added: 18, removed: 4, approximate: false }] })
    });

    expect(call?.attribution).toBe('turn');
    expect(call?.summary.title).toBe('Edited src/main.ts');
    expect(call?.summary.metric).toBe('+18 −4');

    const stored = await readEvents(sessionId!, { kinds: ['tool_call'] });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.turnId).toBe('turn-77');
  });

  /**
   * The call that came from somewhere else entirely.
   *
   * The connector belongs to a ChatGPT account, not to a browser. The same account
   * driving this app from the Android app, from a second browser or from another machine
   * produces tool calls that arrive here while Chrome sits with an unrelated chat open
   * and idle — which is not a rare case: it is what happens whenever the user picks up
   * their phone. Measured on the installed build, phone-driven calls took the
   * unattributed count from ~107 to ~188 with a Chrome tab open throughout.
   *
   * So an open tab is evidence about the browser and never about the caller. Filing an
   * unproven call into the one chat that happens to be open writes another device's work
   * into that chat's permanent history, and nothing afterwards can tell the two apart.
   */
  it('refuses to file a call into an open chat that merely happens to be the only one', async () => {
    const sessionId = await sessionForConversation('conv-between-turns');
    await recordChatObservations('conv-between-turns', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-1' },
      { kind: 'turn_end', time: Date.now(), turnId: 'turn-1', outcome: 'completed' }
    ]);

    const call = await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/a.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 3,
      startedAt: Date.now()
    });

    expect(call?.attribution).toBe('inferred');
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(0);
    const unattributed = (await listSessions()).find((entry) => entry.title === 'Unattributed activity');
    expect(unattributed, 'a call with no proof of origin must not join the open chat').toBeDefined();
    expect(await readEvents(unattributed!.id, { kinds: ['tool_call'] })).toHaveLength(1);
  });

  /**
   * The same thing one step worse: the open Chrome chat is *live*, polling the app every
   * couple of seconds, while the work is being driven from the phone. Liveness is the
   * strongest browser-side signal there is, and it still says nothing about the caller.
   */
  it('keeps a foreign call out of a chat that is live but not generating', async () => {
    const sessionId = await sessionForConversation('conv-live-idle');
    await recordChatObservations('conv-live-idle', [
      { kind: 'user_message', time: Date.now(), text: 'unrelated question', messageId: 'live-1' }
    ]);
    expect(liveConversations().some((entry) => entry.conversationId === 'conv-live-idle')).toBe(true);

    const call = await recordToolCall({
      tool: 'run_command',
      args: { command: 'npm test' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 9,
      startedAt: Date.now()
    });

    expect(call?.attribution).toBe('inferred');
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(0);
  });

  /**
   * The split-chat blocker, from the app's side.
   *
   * ChatGPT folds a run of same-tool calls into one row and, on a fast turn, draws no row
   * at all. Counting rows therefore counted low, and every call the page had not drawn was
   * not merely unattributed but *guaranteed* to be — one real chat became its own session
   * plus a permanently growing `Unattributed activity` holding most of its work (369
   * events against the real session's 140, measured on the installed build).
   *
   * The message model does not fold: five calls are five requests with five ids, whatever
   * the renderer draws. So five recorded calls are placeable from evidence that names one
   * row's worth of them.
   */
  it('places every call of a run ChatGPT folded into a single tool row', async () => {
    const sessionId = await sessionForConversation('conv-folded');
    const unattributedBefore =
      (await listSessions()).find((entry) => entry.title === 'Unattributed activity')?.toolCalls ?? 0;
    const now = Date.now();
    await recordChatObservations('conv-folded', [
      { kind: 'turn_start', time: now, turnId: 'turn-folded' },
      // What the page drew: one row for the whole run.
      { kind: 'tool_block', time: now, turnId: 'turn-folded', count: 1 },
      // What the page's own message model holds.
      {
        kind: 'tool_evidence',
        time: now,
        turnId: 'turn-folded',
        calls: Array.from({ length: 5 }, (_unused, index) => ({
          messageId: `msg-${index}`,
          tool: 'read_file',
          order: index,
          answered: true
        }))
      }
    ]);

    const calls = [];
    for (let index = 0; index < 5; index++) {
      calls.push(
        await recordToolCall({
          tool: 'read_file',
          args: { path: `/project/${index}.ts` },
          content: [{ type: 'text', text: 'ok' }],
          outcome: 'ok',
          durationMs: 2,
          startedAt: Date.now()
        })
      );
    }

    expect(calls.map((call) => call?.attribution)).toEqual(['turn', 'turn', 'turn', 'turn', 'turn']);
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(5);
    const unattributedAfter =
      (await listSessions()).find((entry) => entry.title === 'Unattributed activity')?.toolCalls ?? 0;
    expect(unattributedAfter, 'nothing should have been left unplaced').toBe(unattributedBefore);
  });

  /**
   * Two workers calling one tool at the same instant. Live (run `f2507104`, again in
   * `f5159b6f`) both were refused `WORKER_IDENTITY_LOST`, because the only thing separating
   * them was a time window and both sat inside it. ChatGPT's own request id separates them
   * outright: the `wfr_…` on the inbound HTTP request is the `wfr_…` the page holds for the
   * request it issued, so each call is placed in the chat that made it and neither has to be
   * guessed at.
   */
  it('places simultaneous same-tool calls from two chats by the request id ChatGPT sent', async () => {
    const now = Date.now();
    const first = await sessionForConversation('conv-worker-1');
    const second = await sessionForConversation('conv-worker-2');
    for (const [conversationId, requestId] of [
      ['conv-worker-1', 'wfr_worker1'],
      ['conv-worker-2', 'wfr_worker2']
    ] as const) {
      await recordChatObservations(conversationId, [
        { kind: 'turn_start', time: now, turnId: `turn-${requestId}` },
        {
          kind: 'tool_evidence',
          time: now,
          turnId: `turn-${requestId}`,
          calls: [{ messageId: `msg-${requestId}`, tool: 'agents', order: 0, answered: false, requestId }]
        }
      ]);
    }

    const [callTwo, callOne] = await Promise.all([
      recordToolCall({
        tool: 'agents',
        args: { action: 'status' },
        content: [{ type: 'text', text: 'ok' }],
        outcome: 'ok',
        durationMs: 1,
        startedAt: Date.now(),
        requestId: 'wfr_worker2'
      }),
      recordToolCall({
        tool: 'agents',
        args: { action: 'status' },
        content: [{ type: 'text', text: 'ok' }],
        outcome: 'ok',
        durationMs: 1,
        startedAt: Date.now(),
        requestId: 'wfr_worker1'
      })
    ]);

    expect(callOne?.attribution).toBe('turn');
    expect(callTwo?.attribution).toBe('turn');
    expect(await readEvents(first!, { kinds: ['tool_call'] })).toHaveLength(1);
    expect(await readEvents(second!, { kinds: ['tool_call'] })).toHaveLength(1);
  });

  /**
   * Live 1.8 regression: ChatGPT reuses one request_id for every connector request in a
   * single assistant turn. The second message/tool under that key is more evidence for the
   * same owner, not a contradiction. Treating it as a per-call id split a fresh chat after
   * its first few calls and sent the rest to Unattributed activity.
   */
  it('keeps a turn-level request id owned when later calls in the same chat have different messages and tools', async () => {
    const now = Date.now();
    const conversationId = 'conv-shared-turn-request';
    const requestId = 'wfr_shared_turn';
    const sessionId = await sessionForConversation(conversationId);
    const unattributedBefore =
      (await listSessions()).find((entry) => entry.title === 'Unattributed activity')?.toolCalls ?? 0;

    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: now, turnId: 'turn-shared-request' },
      {
        kind: 'tool_evidence',
        time: now,
        turnId: 'turn-shared-request',
        calls: [{ messageId: 'msg-read', tool: 'read', order: 0, answered: true, requestId }]
      }
    ]);
    const first = await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/a.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: now + 1,
      requestId
    });

    await recordChatObservations(conversationId, [
      {
        kind: 'tool_evidence',
        time: now + 2,
        turnId: 'turn-shared-request',
        calls: [{ messageId: 'msg-exec', tool: 'exec_command', order: 1, answered: false, requestId }]
      }
    ]);
    expect(freshCallOrigin('exec_command', now + 2, requestId)).toBe(conversationId);

    const second = await recordToolCall({
      tool: 'exec_command',
      args: { cmd: 'rg foo' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: now + 3,
      requestId
    });

    expect(first?.conversationId).toBe(conversationId);
    expect(second?.conversationId).toBe(conversationId);
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(2);
    const unattributedAfter =
      (await listSessions()).find((entry) => entry.title === 'Unattributed activity')?.toolCalls ?? 0;
    expect(unattributedAfter).toBe(unattributedBefore);
  });
  it('does not substitute another chat’s agents request while an exact HTTP request id is still waiting', async () => {
    const now = Date.now();
    await sessionForConversation('conv-prime');
    await sessionForConversation('conv-worker');

    await recordChatObservations('conv-worker', [
      { kind: 'turn_start', time: now, turnId: 'turn-worker' },
      {
        kind: 'tool_evidence',
        time: now,
        turnId: 'turn-worker',
        calls: [
          {
            messageId: 'worker-agents',
            tool: 'agents',
            order: 0,
            answered: false,
            requestId: 'wfr_worker',
            createTime: now / 1000
          }
        ]
      }
    ]);

    // This MCP call says it is wfr_prime. Seeing a worker agents request nearby must not
    // turn the prime into worker-1 while the prime page is one observation tick late.
    expect(freshCallOrigin('agents', now, 'wfr_prime')).toBeNull();

    const waiting = awaitFreshCallOrigin('agents', now, 1_000, { requestId: 'wfr_prime' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordChatObservations('conv-prime', [
      { kind: 'turn_start', time: now + 10, turnId: 'turn-prime' },
      {
        kind: 'tool_evidence',
        time: now + 10,
        turnId: 'turn-prime',
        calls: [
          {
            messageId: 'prime-agents',
            tool: 'agents',
            order: 0,
            answered: false,
            requestId: 'wfr_prime',
            createTime: (now + 10) / 1000
          }
        ]
      }
    ]);

    expect(await waiting).toBe('conv-prime');
  });

  it('leaves an unmatched HTTP-id call unattributed instead of borrowing another chat’s evidence', async () => {
    const now = Date.now();
    const worker = await sessionForConversation('conv-worker-only');
    await recordChatObservations('conv-worker-only', [
      { kind: 'turn_start', time: now, turnId: 'turn-worker-only' },
      {
        kind: 'tool_evidence',
        time: now,
        turnId: 'turn-worker-only',
        calls: [
          {
            messageId: 'worker-read',
            tool: 'read',
            order: 0,
            answered: false,
            requestId: 'wfr_worker_read',
            createTime: now / 1000
          }
        ]
      }
    ]);

    const workerBefore = (await readEvents(worker!, { kinds: ['tool_call'] })).length;
    const call = await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/a.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: now,
      requestId: 'wfr_prime_read'
    });

    expect(call?.attribution).toBe('inferred');
    expect((await readEvents(worker!, { kinds: ['tool_call'] })).length).toBe(workerBefore);
    const unattributed = (await listSessions()).find((entry) => entry.title === 'Unattributed activity');
    expect(unattributed?.toolCalls).toBeGreaterThan(0);
  });

  it('repairs an old unattributed bucket once every call has the same proven request-id owner', async () => {
    const now = Date.now();
    const conversationId = 'conv-repair';
    const requestId = 'wfr-repair';
    const target = await sessionForConversation(conversationId);
    await recordChatObservations(conversationId, [
      {
        kind: 'tool_evidence',
        time: now,
        calls: [
          {
            messageId: 'msg-repair',
            tool: 'read',
            order: 0,
            answered: false,
            requestId,
            createTime: now / 1000
          }
        ]
      }
    ]);

    const source = await createSession({ title: 'Unattributed activity' });
    await appendEvent(source.id, {
      time: now,
      source: 'app',
      kind: 'session_start',
      conversationId: null,
      title: source.title
    });
    const image = await writeAsset(source.id, Buffer.from('fake image bytes'), 'image/png');
    await appendEvent(source.id, {
      time: now + 1,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'call-repair',
        tool: 'read',
        attribution: 'unattributed',
        requestId,
        conversationId: null,
        attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok',
        durationMs: 1,
        summary: { kind: 'read', tone: 'neutral', title: 'Read repair fixture' },
        assets: [image]
      }
    });

    expect(await repairDeterministicAttribution()).toEqual({ sessions: 1, calls: 1 });
    expect(await getSession(source.id)).toBeNull();

    const repaired = await readEvents(target!, { kinds: ['tool_call'] });
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.kind === 'tool_call' && repaired[0].call).toMatchObject({
      callId: 'call-repair',
      requestId,
      conversationId,
      attribution: 'request_id',
      attributionMethod: 'request_id'
    });
    expect(await readAsset(target!, image.id)).toEqual(Buffer.from('fake image bytes'));
  });

  it('repairs the proven part of a mixed bucket and leaves only the genuinely unknown call', async () => {
    const now = Date.now();
    await sessionForConversation('conv-known');
    await recordChatObservations('conv-known', [
      {
        kind: 'tool_evidence',
        time: now,
        calls: [
          {
            messageId: 'msg-known',
            tool: 'read',
            order: 0,
            answered: false,
            requestId: 'wfr-known',
            createTime: now / 1000
          }
        ]
      }
    ]);

    const source = await createSession({ title: 'Unattributed activity' });
    await appendEvent(source.id, {
      time: now,
      source: 'app',
      kind: 'session_start',
      conversationId: null,
      title: source.title
    });
    for (const [callId, requestId] of [
      ['known-call', 'wfr-known'],
      ['unknown-call', 'wfr-unknown']
    ] as const) {
      await appendEvent(source.id, {
        time: now + 1,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId,
          tool: 'read',
          attribution: 'unattributed',
          requestId,
          conversationId: null,
          attributionMethod: 'unattributed',
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok',
          durationMs: 1,
          summary: { kind: 'read', tone: 'neutral', title: callId }
        }
      });
    }

    expect(await repairDeterministicAttribution()).toEqual({ sessions: 1, calls: 1 });
    expect(await getSession(source.id)).not.toBeNull();
    const left = await readEvents(source.id, { kinds: ['tool_call'] });
    expect(left).toHaveLength(1);
    expect(left[0]?.kind === 'tool_call' && left[0].call.callId).toBe('unknown-call');

    const target = await sessionForConversation('conv-known');
    const repaired = await readEvents(target!, { kinds: ['tool_call'] });
    expect(repaired.some((event) => event.kind === 'tool_call' && event.call.callId === 'known-call')).toBe(true);
  });

  it('repairs an already-unattributed call as soon as its exact request id is later observed', async () => {
    const now = Date.now();
    const conversationId = 'conv-late-request-proof';
    const requestId = 'wfr-late-request-proof';
    const target = await sessionForConversation(conversationId);
    expect(target).toBeTruthy();

    const source = await createSession({ title: 'Unattributed activity' });
    await appendEvent(source.id, {
      time: now,
      source: 'app',
      kind: 'session_start',
      conversationId: null,
      title: source.title
    });
    await appendEvent(source.id, {
      time: now + 1,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'call-late-request-proof',
        tool: 'read',
        attribution: 'unattributed',
        requestId,
        conversationId: null,
        attributionMethod: 'unattributed',
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok',
        durationMs: 1,
        summary: { kind: 'read', tone: 'neutral', title: 'Read before page proof' }
      }
    });

    await recordChatObservations(conversationId, [
      {
        kind: 'tool_evidence',
        time: now + 10,
        fiberConversationId: conversationId,
        calls: [
          {
            messageId: 'page-request-message-late-proof',
            tool: 'read',
            order: 0,
            answered: true,
            requestId,
            createTime: now / 1000
          }
        ]
      }
    ]);
    // Production repair is debounced; flushRecorder is the deterministic durability barrier
    // and forces a queued repair to complete before returning.
    await flushRecorder();

    expect(await getSession(source.id)).toBeNull();
    const moved = await readEvents(target!, { kinds: ['tool_call'] });
    expect(moved.some((event) =>
      event.kind === 'tool_call' &&
      event.call.callId === 'call-late-request-proof' &&
      event.call.conversationId === conversationId &&
      event.call.attributionMethod === 'request_id'
    )).toBe(true);
  });

  /**
   * The blackout case. A browser that reports no request ids at all cannot answer the join
   * for anybody, so treating the id on the HTTP request as a requirement sent a whole
   * working session to "Unattributed activity" while the older evidence sat unused.
   */
  it('falls back to page evidence when no conversation is reporting request ids', async () => {
    const now = Date.now();
    const sessionId = await sessionForConversation('conv-no-ids');
    await recordChatObservations('conv-no-ids', [
      { kind: 'turn_start', time: now, turnId: 'turn-no-ids' },
      {
        kind: 'tool_evidence',
        time: now,
        turnId: 'turn-no-ids',
        calls: [{ messageId: 'msg-no-id', tool: 'read', order: 0, answered: false }]
      }
    ]);

    const call = await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/a.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 2,
      startedAt: now,
      requestId: 'wfr_no_mate'
    });

    expect(call?.attribution).toBe('turn');
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(1);
    expect(freshCallOrigin('read', now, 'wfr_no_mate')).toBeNull();
  });

  it('fails closed when one HTTP request id is reported by two conversations', async () => {
    const now = Date.now();
    for (const conversationId of ['conv-a', 'conv-b']) {
      await sessionForConversation(conversationId);
      await recordChatObservations(conversationId, [
        { kind: 'turn_start', time: now, turnId: `turn-${conversationId}` },
        {
          kind: 'tool_evidence',
          time: now,
          turnId: `turn-${conversationId}`,
          calls: [
            {
              messageId: `msg-${conversationId}`,
              tool: 'agents',
              order: 0,
              answered: false,
              requestId: 'wfr_conflict',
              createTime: now / 1000
            }
          ]
        }
      ]);
    }

    expect(freshCallOrigin('agents', now, 'wfr_conflict')).toBeNull();
  });

  /** The other half: a turn that rendered no row at all still accounts for its calls. */
  it('places a call in a turn the page drew no tool row for', async () => {
    const sessionId = await sessionForConversation('conv-rowless');
    await recordChatObservations('conv-rowless', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-rowless' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 'turn-rowless',
        calls: [{ messageId: 'msg-only', tool: 'search_files', order: 0, answered: false }]
      }
    ]);

    const call = await recordToolCall({
      tool: 'search_files',
      args: { query: 'packSession' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 4,
      startedAt: Date.now()
    });

    expect(call?.attribution).toBe('turn');
    const stored = await readEvents(sessionId!, { kinds: ['tool_call'] });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.turnId).toBe('turn-rowless');
  });

  /**
   * Naming the tool is what makes this evidence rather than a narrowing, so the name has
   * to be load-bearing: a turn that asked for `read_file` cannot vouch for a `screenshot`.
   */
  it('will not let evidence for one tool vouch for a call to another', async () => {
    const sessionId = await sessionForConversation('conv-wrong-tool');
    await recordChatObservations('conv-wrong-tool', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-wrong' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 'turn-wrong',
        calls: [{ messageId: 'msg-read', tool: 'read_file', order: 0, answered: true }]
      }
    ]);

    const call = await recordToolCall({
      tool: 'screenshot',
      args: {},
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 5,
      startedAt: Date.now()
    });

    expect(call?.attribution).toBe('inferred');
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(0);
  });

  /** Evidence is consumed, so one request can never place two records. */
  it('spends each named request once', async () => {
    const sessionId = await sessionForConversation('conv-spend-once');
    await recordChatObservations('conv-spend-once', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-spend' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 'turn-spend',
        calls: [{ messageId: 'msg-one', tool: 'list_roots', order: 0, answered: true }]
      },
      // A replay of the same turn after a reload adds nothing: the id is already known.
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: 'turn-spend',
        calls: [{ messageId: 'msg-one', tool: 'list_roots', order: 0, answered: true }]
      }
    ]);

    const first = await recordToolCall({
      tool: 'list_roots',
      args: {},
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now()
    });
    const second = await recordToolCall({
      tool: 'list_roots',
      args: {},
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now()
    });

    expect(first?.attribution).toBe('turn');
    expect(second?.attribution).toBe('inferred');
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(1);
  });

  /**
   * The race the whole mechanism exists for, from the app's side.
   *
   * A fast read is answered before the page has reported anything at all — not the block,
   * not even the turn it belongs to. Refusing to wait unless a turn is already known to be
   * running would fail exactly these calls, which are the commonest kind, and file a
   * chat's own work outside it.
   */
  it('waits for a page that has not caught up yet, turn and all', async () => {
    const sessionId = await sessionForConversation('conv-slow-page');
    const startedAt = Date.now();
    const filing = recordToolCall({
      tool: 'read_file',
      args: { path: '/project/late.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    await recordChatObservations('conv-slow-page', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-late' },
      { kind: 'tool_block', time: Date.now(), turnId: 'turn-late', count: 1 }
    ]);

    const call = await filing;
    expect(call?.attribution).toBe('turn');
    const stored = await readEvents(sessionId!, { kinds: ['tool_call'] });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.turnId).toBe('turn-late');
  });

  /**
   * A burst from somewhere else, with an open browser that has nothing to say about it.
   *
   * Each call waits for the page independently, so the burst costs one grace period
   * between them rather than one each. Serialising the waits would put the last of twenty
   * calls minutes behind — by which time a genuine block for it has expired — and would
   * hold every one of them in memory until then.
   */
  it('does not make a burst of foreign calls queue behind each other', async () => {
    await sessionForConversation('conv-burst-watcher');
    const startedAt = Date.now();
    const calls = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        recordToolCall({
          tool: 'read_file',
          args: { path: `/project/${index}.ts` },
          content: [{ type: 'text', text: 'ok' }],
          outcome: 'ok',
          durationMs: 1,
          startedAt: Date.now()
        })
      )
    );
    await flushRecorder();
    const elapsed = Date.now() - startedAt;

    expect(calls.every((call) => call?.attribution === 'inferred')).toBe(true);
    expect(elapsed, 'twenty unmatched calls must not cost twenty grace periods').toBeLessThan(8000);
  });

  it("still places a chat's own call made after a foreign burst", async () => {
    const sessionId = await sessionForConversation('conv-after-burst');
    await Promise.all(
      Array.from({ length: 10 }, () =>
        recordToolCall({
          tool: 'read_file',
          args: { path: '/project/foreign.ts' },
          content: [{ type: 'text', text: 'ok' }],
          outcome: 'ok',
          durationMs: 1,
          startedAt: Date.now()
        })
      )
    );

    await recordChatObservations('conv-after-burst', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-after' },
      { kind: 'tool_block', time: Date.now(), turnId: 'turn-after', count: 1 }
    ]);
    const mine = await recordToolCall({
      tool: 'edit_file',
      args: { path: '/project/mine.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now()
    });

    expect(mine?.attribution).toBe('turn');
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(1);
  });

  /**
   * One chat, working through a list, with nothing drawn for any of it.
   *
   * A call reaches the recorder only once its tool has finished, and then waits up to the
   * sighting grace for the page to catch up. So an ordinary burst of *sequential* calls — the
   * model cannot ask for the next one before this one comes back — has all of its attribution
   * waits open at once, and counting those waits as competition made every call in the burst
   * declare every other one contested. That disables the sole-live-generation grade outright,
   * which is the only grade a turn has when ChatGPT draws no row, so the chat's own work went
   * to "Unattributed activity" while the chat was demonstrably mid-turn: session
   * `2026-08-17-09ab937b`, runs of calls 2.8 and 3.9 seconds apart, every one of them
   * `inferred`.
   *
   * Waiting together is not running together, and only running together is ambiguous.
   */
  it('keeps a burst of sequential calls with the one chat that was generating', async () => {
    await sessionForConversation('conv-burst');
    await recordChatObservations('conv-burst', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-burst' }
    ]);

    // Three calls, strictly one after another and milliseconds apart, so all three grace
    // windows overlap and none of the executions do. No block is ever drawn for them.
    const filing: Array<Promise<{ attribution: string; turnId?: string | null } | null>> = [];
    let at = Date.now();
    for (const path of ['/project/one.ts', '/project/two.ts', '/project/three.ts']) {
      filing.push(
        recordToolCall({
          tool: 'read_file',
          args: { path },
          content: [{ type: 'text', text: 'ok' }],
          outcome: 'ok',
          durationMs: 5,
          startedAt: at
        }) as Promise<{ attribution: string; turnId?: string | null } | null>
      );
      // The next call starts after the previous one returned: 5 ms of work, 45 ms of model.
      at += 50;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const placed = await Promise.all(filing);
    expect(placed.map((call) => call?.attribution)).toEqual(['generation', 'generation', 'generation']);
    const stored = await readEvents((await sessionForConversation('conv-burst'))!, { kinds: ['tool_call'] });
    expect(stored, 'all three belong to the chat that was mid-turn').toHaveLength(3);
    // And to the generation that was open, so they sit inside that turn rather than beside it.
    expect(new Set(stored.map((event) => event.turnId))).toEqual(new Set(['turn-burst']));
  });

  it('keeps an open quiet turn but withdraws weak generation identity until the page is live again', async () => {
    await sessionForConversation('conv-flicker-state');
    await recordChatObservations('conv-flicker-state', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-flicker-state' }
    ]);
    expect(soleGeneratingConversation()).toBe('conv-flicker-state');

    await recordChatObservations('conv-flicker-state', [
      { kind: 'turn_state', time: Date.now(), turnId: 'turn-flicker-state', active: false }
    ]);
    expect(soleGeneratingConversation()).toBeNull();
    const live = liveConversations().find((entry) => entry.conversationId === 'conv-flicker-state');
    expect(live?.activeTurnId).toBe('turn-flicker-state');

    await recordChatObservations('conv-flicker-state', [
      { kind: 'turn_state', time: Date.now(), turnId: 'turn-flicker-state', active: true }
    ]);
    expect(soleGeneratingConversation()).toBe('conv-flicker-state');
  });

  it('uses named call evidence to keep a connector call on its durable turn while generation is visually quiet', async () => {
    const now = Date.now();
    const sessionId = await sessionForConversation('conv-named-quiet');
    await recordChatObservations('conv-named-quiet', [
      { kind: 'turn_start', time: now, turnId: 'turn-named-quiet' },
      { kind: 'turn_state', time: now + 1, turnId: 'turn-named-quiet', active: false },
      {
        kind: 'tool_evidence',
        time: now + 2,
        turnId: 'turn-named-quiet',
        calls: [{ messageId: 'named-quiet-read', tool: 'read_file', order: 0, answered: false }]
      }
    ]);

    const placed = await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/quiet.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: now + 2
    });
    expect(placed?.attribution).toBe('turn');
    const stored = await readEvents(sessionId!, { kinds: ['tool_call'] });
    expect(stored[0]?.turnId).toBe('turn-named-quiet');
  });

  /**
   * The same three calls, genuinely overlapping this time.
   *
   * Concurrency is what a single caller cannot produce, so it stays ambiguous — and stickily
   * so, since one of them timing out first is not a finding about who called.
   */
  it('still refuses a generation to calls that really did run at the same time', async () => {
    await sessionForConversation('conv-parallel');
    await recordChatObservations('conv-parallel', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-parallel' }
    ]);

    const startedAt = Date.now();
    const both = [
      recordToolCall({
        tool: 'read_file',
        args: { path: '/project/left.ts' },
        content: [{ type: 'text', text: 'ok' }],
        outcome: 'ok',
        durationMs: 400,
        startedAt
      }),
      recordToolCall({
        tool: 'read_file',
        args: { path: '/project/right.ts' },
        content: [{ type: 'text', text: 'ok' }],
        outcome: 'ok',
        // Started while the first was still running, and finished after it.
        durationMs: 400,
        startedAt: startedAt + 200
      })
    ];

    const placed = await Promise.all(both);
    expect(placed.map((call) => call?.attribution)).toEqual(['inferred', 'inferred']);
  });

  /**
   * One block, two callers, and no way to tell which of them it belongs to.
   *
   * The browser and the phone can both be calling this app at once, and a block says only
   * that *a* connector call was made here. Handing it to either one is a coin toss with
   * the worst possible losing side: the phone's work written into the browser's history
   * while the browser's own call is filed as unplaceable.
   *
   * The trap is that the ambiguity looks like it resolves itself. The two calls give up a
   * fraction of a second apart, and the moment the first one leaves, the block is the only
   * one left for the only call still waiting — so a guard that just counts what is pending
   * would let the straggler take it. Timing out is not evidence about who called.
   */
  it('never lets one contested block fall to whichever call gives up last', async () => {
    await sessionForConversation('conv-contested');
    const chrome = recordToolCall({
      tool: 'read_file',
      args: { path: '/project/chrome.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now()
    });
    // Staggered, so their grace periods end at different moments.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const phone = recordToolCall({
      tool: 'read_file',
      args: { path: '/project/phone.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now()
    });

    // Chrome renders exactly one block, for one of them.
    await recordChatObservations('conv-contested', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-contested' },
      { kind: 'tool_block', time: Date.now(), turnId: 'turn-contested', count: 1 }
    ]);

    expect((await chrome)?.attribution).toBe('inferred');
    expect((await phone)?.attribution).toBe('inferred');
    const chat = (await listSessions()).find((entry) => entry.title !== 'Unattributed activity' && entry.events > 0);
    expect(chat && (await readEvents(chat.id, { kinds: ['tool_call'] })).length, 'neither call may land here').toBeFalsy();
  });

  /**
   * The app restarted; the Chrome tab did not.
   *
   * The recorder's map of live chats is memory, so it is empty for a while after a restart
   * even though the same page is still open and still polling. Taking that emptiness as
   * "no browser could be reporting" would file the browser's own first call as unplaceable
   * milliseconds before the page reported the block that places it — and that first call
   * is exactly when the user is watching.
   */
  it('waits for a page that was already open before the app restarted', async () => {
    const before = await sessionForConversation('conv-survivor');
    await recordChatObservations('conv-survivor', [
      { kind: 'user_message', time: Date.now(), text: 'carry on', messageId: 'survivor-1' }
    ]);

    // Only the recorder restarts. The bridge still hears the page polling.
    resetRecorderForTests();
    setBrowserReporterPresent(() => true);
    expect(liveConversations()).toHaveLength(0);

    const filing = recordToolCall({
      tool: 'read_file',
      args: { path: '/project/after-restart.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 2,
      startedAt: Date.now()
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    await recordChatObservations('conv-survivor', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-after-restart' },
      { kind: 'tool_block', time: Date.now(), turnId: 'turn-after-restart', count: 1 }
    ]);

    expect((await filing)?.attribution).toBe('turn');
    const stored = await readEvents(before!, { kinds: ['tool_call'] });
    expect(stored, 'the call belongs to the chat that was open all along').toHaveLength(1);
  });

  it('does not wait at all when no browser is there to report anything', async () => {
    setBrowserReporterPresent(() => false);
    const startedAt = Date.now();
    const call = await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/phone.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt
    });
    expect(call?.attribution).toBe('inferred');
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  /**
   * Evidence delivered late is evidence about when it was *seen*.
   *
   * The extension journals observations while the app is unreachable and replays them on
   * reconnect, so a block rendered before a restart arrives looking brand new. Believing
   * the delivery time would let a block from ten minutes ago vouch for a call another
   * device is making right now.
   */
  it('ignores a tool block that was rendered long before it was delivered', async () => {
    const sessionId = await sessionForConversation('conv-replayed');
    await recordChatObservations('conv-replayed', [
      { kind: 'turn_start', time: Date.now() - 600_000, turnId: 'turn-old' },
      { kind: 'tool_block', time: Date.now() - 600_000, turnId: 'turn-old', count: 1 }
    ]);

    const call = await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/a.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 2,
      startedAt: Date.now()
    });

    expect(call?.attribution).toBe('inferred');
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(0);
  });

  /**
   * The prime agent's chat is the user's own, so nothing opened it on the app's behalf and
   * no extension report can name it. It is bound from the evidence for create_agents
   * itself — which does not exist yet while create_agents is running, so reading it there
   * would silently never bind and the prime would attribute per call forever.
   */
  it('binds the prime to its chat once the call that created it can be placed', async () => {
    const bound: Array<[string, string]> = [];
    setAgentBinder((agent, conversationId) => bound.push([agent, conversationId]));
    await sessionForConversation('conv-prime-chat');

    const filing = recordToolCall({
      tool: 'create_agents',
      args: { workers: [{ task: 'release hardening' }] },
      content: [{ type: 'text', text: 'created' }],
      outcome: 'ok',
      durationMs: 5,
      startedAt: Date.now(),
      bind: 'prime'
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    await recordChatObservations('conv-prime-chat', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-prime-1' },
      { kind: 'tool_block', time: Date.now(), turnId: 'turn-prime-1', count: 1 }
    ]);

    expect((await filing)?.attribution).toBe('turn');
    expect(bound).toEqual([['prime', 'conv-prime-chat']]);
  });

  it('binds nothing when the call that would have named the chat cannot be placed', async () => {
    const bound: Array<[string, string]> = [];
    setAgentBinder((agent, conversationId) => bound.push([agent, conversationId]));
    await sessionForConversation('conv-prime-elsewhere');

    const call = await recordToolCall({
      tool: 'create_agents',
      args: { workers: [{ task: 'release hardening' }] },
      content: [{ type: 'text', text: 'created' }],
      outcome: 'ok',
      durationMs: 5,
      startedAt: Date.now(),
      bind: 'prime'
    });

    expect(call?.attribution).toBe('inferred');
    expect(bound, 'binding the wrong chat poisons every later call the prime makes').toEqual([]);
  });

  it('will not choose between two open chats', async () => {
    await sessionForConversation('conv-two-a');
    await sessionForConversation('conv-two-b');

    const call = await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/b.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 3,
      startedAt: Date.now()
    });

    expect(call?.attribution).toBe('inferred');
    const unattributed = (await listSessions()).find((entry) => entry.title === 'Unattributed activity');
    expect(unattributed, 'an ambiguous call must not be filed into either chat').toBeDefined();
    expect(await readEvents(unattributed!.id, { kinds: ['tool_call'] })).toHaveLength(1);
  });

  it('places an authenticated but not-yet-bound agent by page evidence, and says so', async () => {
    const sessionId = await sessionForConversation('conv-restored-prime');
    await recordChatObservations('conv-restored-prime', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-prime' },
      { kind: 'tool_block', time: Date.now(), turnId: 'turn-prime', count: 1 }
    ]);
    const call = await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/a.ts' },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 2,
      startedAt: Date.now(),
      agent: 'prime'
    });
    // The key proves who called; only the page evidence says from where, so the record
    // must not claim the stronger grade.
    expect(call?.attribution).toBe('turn');
    const stored = await readEvents(sessionId!, { kinds: ['tool_call'] });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.turnId).toBe('turn-prime');
    expect(stored[0]!.agent).toBe('prime');
  });

  it('marks a call inferred when no conversation is demonstrably generating', async () => {
    await sessionForConversation('conv-a');
    await sessionForConversation('conv-b');
    const call = await recordToolCall({
      tool: 'find',
      args: { query: 'registerTool', mode: 'content' },
      content: [{ type: 'text', text: 'found' }],
      outcome: 'ok',
      durationMs: 10,
      startedAt: Date.now(),
      evidence: evidence({ count: 30 })
    });
    expect(call?.attribution).toBe('inferred');
    expect(call?.summary.title).toBe('Searched "registerTool"');
    expect(call?.summary.detail).toBe('30 matches in file contents');
  });

  it('stores a user message once however often the page reports it', async () => {
    const observation = {
      kind: 'user_message' as const,
      time: Date.now(),
      text: 'the original five-hour requirement',
      messageId: 'msg-1'
    };
    const first = await recordChatObservations('conv-dedup', [observation]);
    const second = await recordChatObservations('conv-dedup', [observation, { ...observation, messageId: 'msg-2' }]);

    expect(first.stored).toBe(1);
    expect(second.stored).toBe(1);
    const events = await readEvents(first.sessionId!, { kinds: ['user_message'] });
    expect(events.map((event) => (event.kind === 'user_message' ? event.messageId : null))).toEqual(['msg-1', 'msg-2']);
  });

  it('keeps de-duplicating after the app forgets the conversation', async () => {
    const observation = {
      kind: 'user_message' as const,
      time: Date.now(),
      text: 'still one message',
      messageId: 'msg-restart'
    };
    const first = await recordChatObservations('conv-restart', [observation]);
    resetRecorderForTests();
    const second = await recordChatObservations('conv-restart', [observation]);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.stored).toBe(0);
    expect(await readEvents(first.sessionId!, { kinds: ['user_message'] })).toHaveLength(1);
  });

  it('keeps de-duplicating an answer too long to store inline', async () => {
    // Longer than the inline cap, so what lands on the log line is an elided copy plus a
    // note. Comparing that copy with the live text it was made from is what used to store
    // every long answer again on every reload.
    const answer = `The whole five-hour requirement, once more. ${'context, caveats, and the rest. '.repeat(600)}`;
    expect(answer.length).toBeGreaterThan(MAX_MESSAGE_CHARS);
    const observation = {
      kind: 'assistant_message' as const,
      time: Date.now(),
      text: answer,
      messageId: 'msg-long',
      final: true
    };

    const first = await recordChatObservations('conv-long-restart', [observation]);
    expect(first.stored).toBe(1);
    const written = await readEvents(first.sessionId!, { kinds: ['assistant_message'] });
    expect(written).toHaveLength(1);
    const message = written[0]!.kind === 'assistant_message' ? written[0]!.message : null;
    expect(message?.truncated).toBe(true);
    expect(message?.text.length).toBeLessThan(answer.length);
    expect(message?.chars).toBe(answer.length);
    // The identity has to be on the line, because the line no longer carries the text.
    expect(message?.digest).toMatch(/^[0-9a-f]{32}$/);

    resetRecorderForTests();
    const second = await recordChatObservations('conv-long-restart', [observation]);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.stored).toBe(0);
    expect(await readEvents(first.sessionId!, { kinds: ['assistant_message'] })).toHaveLength(1);
  });

  it('stores at most one final answer for one local generation even after a React remount renames it', async () => {
    const now = Date.now();
    const first = await recordChatObservations('conv-final-generation', [
      { kind: 'turn_start', time: now, turnId: 'g-final-1' },
      {
        kind: 'assistant_message',
        time: now + 1,
        turnId: 'g-final-1',
        messageId: 'assistant:g-final-1',
        text: 'the completed answer',
        final: true
      },
      { kind: 'turn_end', time: now + 2, turnId: 'g-final-1', outcome: 'completed' }
    ]);

    // Same logical generation, but React remounted the final prose under another page id.
    const second = await recordChatObservations('conv-final-generation', [
      {
        kind: 'assistant_message',
        time: now + 3,
        turnId: 'g-final-1',
        messageId: 'some-new-dom-message-id',
        text: 'the completed answer',
        final: true
      }
    ]);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.stored).toBe(0);
    expect(await readEvents(first.sessionId!, { kinds: ['assistant_message'] })).toHaveLength(1);
  });

  it('tells two long answers apart when only their endings differ', async () => {
    // Same id, same length, same opening, same elided copy on the log line: everything a
    // head-and-length identity can see is identical, and only the whole text differs. The
    // page really does reuse a turn id, so this is the case that must not collapse.
    const shared = `${'Both answers open with exactly these words, at length. '.repeat(20)}${'the same middle. '.repeat(700)}`;
    const one = `${shared}ending one`;
    const other = `${shared}ending two`;
    expect(one.length).toBe(other.length);
    expect(one.length).toBeGreaterThan(MAX_MESSAGE_CHARS);

    const base = { kind: 'assistant_message' as const, time: Date.now(), messageId: 'msg-twins', final: true };
    const first = await recordChatObservations('conv-long-twins', [{ ...base, text: one }]);
    resetRecorderForTests();
    const second = await recordChatObservations('conv-long-twins', [{ ...base, text: other }]);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.stored).toBe(1);
    const written = await readEvents(first.sessionId!, { kinds: ['assistant_message'] });
    expect(written).toHaveLength(2);
    const digests = written.map((event) => (event.kind === 'assistant_message' ? event.message.digest : null));
    expect(digests[0]).not.toBe(digests[1]);
    // And the inline copies really are indistinguishable, so nothing else could have done it.
    const inline = written.map((event) => (event.kind === 'assistant_message' ? event.message.text.slice(0, 500) : null));
    expect(inline[0]).toBe(inline[1]);
  });

  it('reuses the session of a conversation that is reopened', async () => {
    const first = await sessionForConversation('conv-reopen');
    resetRecorderForTests();
    const second = await sessionForConversation('conv-reopen');
    expect(second).toBe(first);
    // The reopen must not write a second session_start into the same log.
    expect(await readEvents(first!, { kinds: ['session_start'] })).toHaveLength(1);
  });

  it('marks a page detach as unknown and reconciles a final answer after reload', async () => {
    const sessionId = await sessionForConversation('conv-closing');
    const started = Date.now();
    await recordChatObservations('conv-closing', [{ kind: 'turn_start', time: started, turnId: 't1' }]);
    expect(liveConversations()[0]?.generating).toBe(true);

    await closeConversation('conv-closing');
    let ends = await readEvents(sessionId!, { kinds: ['turn_end'] });
    expect(ends).toHaveLength(1);
    expect(ends[0]!.kind === 'turn_end' && ends[0]!.outcome).toBe('unknown');
    expect(ends[0]!.kind === 'turn_end' && ends[0]!.turnId).toBe('t1');
    expect(liveConversations()).toHaveLength(0);

    const reopened = await recordChatObservations('conv-closing', [
      {
        kind: 'assistant_message',
        // After the page went away, which is what makes the recovered end the later one.
        time: started + 60_000,
        turnId: 't1',
        messageId: 'assistant-after-reload',
        text: 'the answer finished while the page was gone',
        final: true
      }
    ]);
    expect(reopened.sessionId).toBe(sessionId);
    ends = await readEvents(sessionId!, { kinds: ['turn_end'] });
    expect(ends.map((event) => (event.kind === 'turn_end' ? event.outcome : null))).toEqual(['unknown', 'completed']);
    expect(ends[1]!.kind === 'turn_end' && ends[1]!.detail).toMatch(/recovered/);

    // A second reload re-observes the same final message but must not append another
    // synthetic completion.
    const duplicate = await recordChatObservations('conv-closing', [
      {
        kind: 'assistant_message',
        time: 30,
        turnId: 't1',
        messageId: 'assistant-after-reload',
        text: 'the answer finished while the page was gone',
        final: true
      }
    ]);
    expect(duplicate.stored).toBe(0);
    expect(await readEvents(sessionId!, { kinds: ['turn_end'] })).toHaveLength(2);
  });

  it('records the outcome the page reported, without upgrading a guess', async () => {
    const sessionId = await sessionForConversation('conv-outcomes');
    await recordChatObservations('conv-outcomes', [
      { kind: 'turn_start', time: 1, turnId: 'turn-stalled' },
      { kind: 'turn_end', time: 2, turnId: 'turn-stalled', outcome: 'stalled', detail: 'no visible output for ten minutes' },
      { kind: 'turn_start', time: 3, turnId: 'turn-unknown' },
      { kind: 'turn_end', time: 4, turnId: 'turn-unknown' }
    ]);
    const ends = await readEvents(sessionId!, { kinds: ['turn_end'] });
    expect(ends.map((event) => (event.kind === 'turn_end' ? event.outcome : null))).toEqual(['stalled', 'unknown']);
  });

  it('drops unnamed lifecycle boundaries and never lets a stale end close the current named turn', async () => {
    const sessionId = await sessionForConversation('conv-lifecycle-identity');
    await recordChatObservations('conv-lifecycle-identity', [
      { kind: 'turn_start', time: 1 },
      { kind: 'turn_end', time: 2, outcome: 'unknown' },
      { kind: 'turn_start', time: 3, turnId: 'turn-old' },
      { kind: 'turn_start', time: 4, turnId: 'turn-current' },
      { kind: 'turn_end', time: 5, turnId: 'turn-old', outcome: 'unknown' }
    ]);

    const lifecycle = await readEvents(sessionId!, { kinds: ['turn_start', 'turn_end'] });
    expect(lifecycle.map((event) => [event.kind, 'turnId' in event ? event.turnId : null])).toEqual([
      ['turn_start', 'turn-old'],
      ['turn_start', 'turn-current'],
      ['turn_end', 'turn-old']
    ]);
    expect(liveConversations().find((item) => item.conversationId === 'conv-lifecycle-identity')).toMatchObject({
      generating: true,
      activeTurnId: 'turn-current'
    });
  });

  it('keeps credentials and clipboard text out of the log', async () => {
    const sessionId = await sessionForConversation('conv-redact');
    await recordChatObservations('conv-redact', [
      { kind: 'turn_start', time: Date.now(), turnId: 'redact-turn' },
      { kind: 'tool_block', time: Date.now(), turnId: 'redact-turn', count: 2 }
    ]);
    const call = await recordToolCall({
      tool: 'exec_command',
      args: { cmd: 'npm test', env: { TOKEN: 'super-secret-value' } },
      content: [{ type: 'text', text: 'exit 0' }],
      outcome: 'ok',
      durationMs: 4800,
      startedAt: Date.now(),
      evidence: evidence({ exitCode: 0, durationMs: 4800 })
    });
    expect(call?.args.text).not.toContain('super-secret-value');
    expect(call?.args.text).toContain('***');
    expect(call?.summary.metric).toBe('✓ 4.8s');

    // Clipboard text now travels inside computer's actions and results, so the redaction
    // has to follow the action rather than a tool name — in both directions.
    const clip = await recordToolCall({
      tool: 'computer',
      args: { actions: [{ type: 'write_clipboard', text: 'a passphrase the user copied' }, { type: 'read_clipboard' }] },
      content: [
        { type: 'text', text: 'Done: write_clipboard, read_clipboard.\nClipboard read 1: "whatever the user had copied"' }
      ],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now()
    });
    expect(clip?.args.text).not.toContain('a passphrase the user copied');
    expect(clip?.result.text).not.toContain('whatever the user had copied');
    // The rest of the reply still says what happened.
    expect(clip?.result.text).toContain('Done: write_clipboard, read_clipboard.');
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(2);
  });

  it('stores an image result as an asset instead of inlining it', async () => {
    const sessionId = await sessionForConversation('conv-shot');
    await recordChatObservations('conv-shot', [
      { kind: 'turn_start', time: Date.now(), turnId: 'shot-turn' },
      { kind: 'tool_block', time: Date.now(), turnId: 'shot-turn', count: 1 }
    ]);
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
    const call = await recordToolCall({
      tool: 'screenshot',
      args: {},
      content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
      outcome: 'ok',
      durationMs: 120,
      startedAt: Date.now()
    });
    expect(call?.assets?.[0]?.bytes).toBe(png.length);
    expect(call?.result.text).not.toContain(png.toString('base64'));
    expect(await readAsset(sessionId!, call!.assets![0]!.id)).toEqual(png);
  });

  it('caps a very long user message but says how much was cut', async () => {
    const huge = 'y'.repeat(40_000);
    const result = await recordChatObservations('conv-long', [
      { kind: 'user_message', time: Date.now(), text: huge, messageId: 'big' }
    ]);
    const events = await readEvents(result.sessionId!, { kinds: ['user_message'] });
    const stored = events[0]!;
    expect(stored.kind === 'user_message' && stored.message.truncated).toBe(true);
    expect(stored.kind === 'user_message' && stored.message.chars).toBe(40_000);
    expect(stored.kind === 'user_message' && stored.message.text.length).toBeGreaterThan(30_000);
  });
});

describe('canonical recorder 1.8', () => {
  const tool = (requestId: string, startedAt = Date.now()) =>
    recordToolCall({
      tool: 'read',
      args: { paths: ['/project/a.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok' as const,
      durationMs: 1,
      startedAt,
      requestId
    });

  it('creates exactly one session when the same conversation is first observed concurrently', async () => {
    const conversationId = 'conv-concurrent-first-sight';
    const [first, second] = await Promise.all([
      sessionForConversation(conversationId),
      sessionForConversation(conversationId)
    ]);
    expect(second).toBe(first);
    expect((await listSessions()).filter((entry) => entry.conversationId === conversationId)).toHaveLength(1);
    expect(await readEvents(first!, { kinds: ['session_start'] })).toHaveLength(1);
  });

  it('many streaming updates become exactly one final canonical message', async () => {
    const conversationId = 'conv-canonical-stream';
    const messageId = 'msg-stream-123';
    const result = await recordChatObservations(conversationId, [
      { kind: 'assistant_message', time: 100, messageId, text: 'I inspected', renderedHtml: '<p>I inspected</p>', state: 'streaming' },
      { kind: 'assistant_message', time: 110, messageId, text: 'I inspected the current tree', renderedHtml: '<p>I inspected the current tree</p>', state: 'streaming' },
      { kind: 'assistant_message', time: 120, messageId, text: 'I inspected the current tree.', renderedHtml: '<p><strong>I inspected</strong> the current tree.</p>', state: 'final', final: true }
    ]);

    const messages = await readEvents(result.sessionId!, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.kind).toBe('assistant_message');
    if (message.kind !== 'assistant_message') throw new Error('wrong event');
    expect(message.messageId).toBe(messageId);
    expect(message.state).toBe('final');
    expect(message.final).toBe(true);
    expect(message.message.text).toBe('I inspected the current tree.');
    expect(message.renderedHtml?.text).toBe('<p><strong>I inspected</strong> the current tree.</p>');
  });

  it('repeating the same final snapshot never creates another logical message', async () => {
    const conversationId = 'conv-repeat-final';
    const snapshot = {
      kind: 'assistant_message' as const,
      time: 200,
      messageId: 'msg-repeat-final',
      text: 'Done.',
      renderedHtml: '<p>Done.</p>',
      state: 'final' as const,
      final: true
    };
    const first = await recordChatObservations(conversationId, [snapshot]);
    await recordChatObservations(conversationId, [{ ...snapshot, time: 210 }, { ...snapshot, time: 220 }]);
    const messages = await readEvents(first.sessionId!, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
  });

  it('correlates every hidden or rowless MCP request independently by request id', async () => {
    const conversationId = 'conv-rowless-modern';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    await recordChatObservations(conversationId, [
      {
        kind: 'tool_evidence',
        time: now,
        fiberConversationId: conversationId,
        calls: Array.from({ length: 5 }, (_unused, index) => ({
          messageId: `hidden-${index}`,
          tool: 'read',
          order: index,
          answered: false,
          requestId: `wfr_hidden_${index}`
        }))
      }
    ]);
    for (let index = 0; index < 5; index++) await tool(`wfr_hidden_${index}`, now + index);
    const calls = await readEvents(sessionId!, { kinds: ['tool_call'] });
    expect(calls).toHaveLength(5);
    for (const event of calls) {
      if (event.kind !== 'tool_call') throw new Error('wrong event');
      expect(event.call.attributionMethod).toBe('request_id');
      expect(event.call.conversationId).toBe(conversationId);
      expect(event.call.requestId).toMatch(/^wfr_hidden_/);
    }
  });

  it('never cross-attributes concurrent same-tool calls from two chats', async () => {
    const now = Date.now();
    const firstId = 'conv-concurrent-a';
    const secondId = 'conv-concurrent-b';
    const first = await sessionForConversation(firstId);
    const second = await sessionForConversation(secondId);
    await recordChatObservations(firstId, [{
      kind: 'tool_evidence', time: now, fiberConversationId: firstId,
      calls: [{ messageId: 'call-a', tool: 'read', order: 0, answered: false, requestId: 'wfr_concurrent_a' }]
    }]);
    await recordChatObservations(secondId, [{
      kind: 'tool_evidence', time: now, fiberConversationId: secondId,
      calls: [{ messageId: 'call-b', tool: 'read', order: 0, answered: false, requestId: 'wfr_concurrent_b' }]
    }]);

    await Promise.all([tool('wfr_concurrent_b', now), tool('wfr_concurrent_a', now)]);
    const firstCalls = await readEvents(first!, { kinds: ['tool_call'] });
    const secondCalls = await readEvents(second!, { kinds: ['tool_call'] });
    expect(firstCalls).toHaveLength(1);
    expect(secondCalls).toHaveLength(1);
    expect(firstCalls[0]!.kind === 'tool_call' && firstCalls[0]!.call.requestId).toBe('wfr_concurrent_a');
    expect(secondCalls[0]!.kind === 'tool_call' && secondCalls[0]!.call.requestId).toBe('wfr_concurrent_b');
  });

  it('keeps an unmatched modern request unattributed and never borrows another chat', async () => {
    vi.useFakeTimers();
    try {
      const other = await sessionForConversation('conv-other-evidence');
      await recordChatObservations('conv-other-evidence', [{
        kind: 'tool_evidence', time: Date.now(), fiberConversationId: 'conv-other-evidence',
        calls: [{ messageId: 'other-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_other' }]
      }]);
      const pending = tool('wfr_missing', Date.now());
      await vi.advanceTimersByTimeAsync(15_100);
      const call = await pending;
      expect(call?.attributionMethod).toBe('unattributed');
      expect(call?.conversationId).toBeNull();
      expect(await readEvents(other!, { kinds: ['tool_call'] })).toHaveLength(0);
      const unattributed = (await listSessions()).find((entry) => entry.title === 'Unattributed activity');
      expect(unattributed?.toolCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects URL/Fiber conversation conflicts instead of choosing either identity', async () => {
    const now = Date.now();
    await sessionForConversation('conv-url-identity');
    await sessionForConversation('conv-fiber-identity');
    await recordChatObservations('conv-url-identity', [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: 'conv-fiber-identity',
      calls: [{ messageId: 'conflict-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_identity_conflict' }]
    }]);
    const call = await tool('wfr_identity_conflict', now);
    expect(call?.attributionMethod).toBe('unattributed');
    expect(call?.conversationId).toBeNull();
  });

  it('preserves captured rendered Markdown HTML on the canonical transcript message', async () => {
    const html = '<h2>Heading</h2><p><strong>bold</strong> and <em>italic</em></p><pre><code>const x = 1;</code></pre><table><tbody><tr><td>A</td></tr></tbody></table>';
    const result = await recordChatObservations('conv-rendered', [{
      kind: 'assistant_message', time: 300, messageId: 'msg-rendered', text: 'Heading\nbold and italic\nconst x = 1;\nA', renderedHtml: html, state: 'final', final: true
    }]);
    const [message] = await readEvents(result.sessionId!, { kinds: ['assistant_message'] });
    expect(message?.kind === 'assistant_message' && message.renderedHtml?.text).toBe(html);
  });

  it('keeps one message anchored before tool calls while streaming revisions update it', async () => {
    const conversationId = 'conv-interleaved';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: now, messageId: 'msg-interleaved', text: 'Working', renderedHtml: '<p>Working</p>', state: 'streaming'
    }]);
    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence', time: now + 10, fiberConversationId: conversationId,
      calls: [{ messageId: 'tool-interleaved', tool: 'read', order: 0, answered: false, requestId: 'wfr_interleaved' }]
    }]);
    await tool('wfr_interleaved', now + 20);
    await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: now + 30, messageId: 'msg-interleaved', text: 'Working — done', renderedHtml: '<p>Working — <strong>done</strong></p>', state: 'final', final: true
    }]);
    const timeline = (await readEvents(sessionId!)).filter((event) => event.kind === 'assistant_message' || event.kind === 'tool_call');
    expect(timeline.map((event) => event.kind)).toEqual(['assistant_message', 'tool_call']);
    expect(timeline.filter((event) => event.kind === 'assistant_message')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ naming

/**
 * What a chat this app opened is called.
 *
 * A session is normally named after the first thing said in it, which for a resumed or
 * worker chat is the bootstrap prompt this app typed itself. The installed build's
 * session list was consequently a column of near-identical rows reading
 * `Continue the previous ChatGPT ...` and `You are worker agent "worker-1" in a ...`,
 * with nothing to say which run any of them belonged to.
 */
describe('naming the chats this app opened', () => {
  const worker: SessionOrigin = {
    kind: 'worker',
    fromSessionId: null,
    agentId: 'worker-1',
    task: 'Port the recorder tests to the new fixture'
  };

  it('names a worker chat for its agent and task', () => {
    expect(originTitle(worker, null)).toBe('worker-1 · Port the recorder tests to the new fixture');
  });

  it('names a resumed chat after the session it continues', () => {
    expect(originTitle({ kind: 'resume', fromSessionId: 's1', agentId: null, task: '' }, 'Fix the bridge')).toBe(
      'Resumed · Fix the bridge'
    );
  });

  // A resumed chat is itself resumable, and a long session is resumed repeatedly.
  it('does not stack the prefix when a resumed chat is resumed again', () => {
    expect(
      originTitle({ kind: 'resume', fromSessionId: 's1', agentId: null, task: '' }, 'Resumed · Fix the bridge')
    ).toBe('Resumed · Fix the bridge');
  });

  it('shortens a task that would otherwise fill the row', () => {
    const long = { ...worker, task: 'x'.repeat(200) };
    expect(originTitle(long, null).length).toBeLessThan(80);
    expect(originTitle(long, null).endsWith('…')).toBe(true);
  });

  it('still names a resume whose source session has been deleted', () => {
    expect(originTitle({ kind: 'resume', fromSessionId: null, agentId: null, task: '' }, null)).toBe(
      'Resumed session'
    );
  });

  /**
   * The ordering that actually happens: the extension acknowledges typing the bootstrap
   * into the fresh tab before that tab has told the app anything about itself, so the
   * origin is known before the session exists.
   */
  it('names the session at creation when the origin arrives first', async () => {
    const source = await createSession({ title: 'Fix the bridge' });
    await noteChatOrigin('conv-fresh', {
      kind: 'resume',
      fromSessionId: source.id,
      agentId: null,
      task: ''
    });
    const sessionId = await recordChatObservations('conv-fresh', [
      {
        kind: 'user_message',
        time: Date.now(),
        text: 'Continue the previous ChatGPT Local Files session. Read the handoff below.',
        messageId: 'boot-1'
      }
    ]);
    const summary = await getSession(sessionId.sessionId!);
    expect(summary?.title).toBe('Resumed · Fix the bridge');
    expect(summary?.origin?.kind).toBe('resume');
    expect(summary?.origin?.fromSessionId).toBe(source.id);
  });

  /** The other ordering: a slow ack, or a page that reported itself unusually fast. */
  it('renames a session that was already created under the bootstrap prompt', async () => {
    const opened = await recordChatObservations('conv-late', [
      {
        kind: 'user_message',
        time: Date.now(),
        text: 'You are worker agent "worker-1" in a ChatGPT Local Files run.',
        messageId: 'boot-2'
      }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toContain('worker agent');

    await noteChatOrigin('conv-late', worker);
    const summary = await getSession(opened.sessionId!);
    expect(summary?.title).toBe('worker-1 · Port the recorder tests to the new fixture');
    expect(summary?.origin?.agentId).toBe('worker-1');
  });

  /**
   * A worker's bootstrap stays leased until the worker joins, so the same command can be
   * acknowledged more than once. The second ack must not rename a session whose name has
   * since become somebody else's to choose.
   */
  it('stamps an origin once', async () => {
    const opened = await recordChatObservations('conv-twice', [
      { kind: 'user_message', time: Date.now(), text: 'bootstrap', messageId: 'boot-3' }
    ]);
    await noteChatOrigin('conv-twice', worker);
    await renameSession(opened.sessionId!, 'Renamed by hand');
    await noteChatOrigin('conv-twice', { ...worker, task: 'Something else entirely' });
    expect((await getSession(opened.sessionId!))?.title).toBe('Renamed by hand');
  });

  it('leaves a chat the user started alone', async () => {
    const opened = await recordChatObservations('conv-organic', [
      { kind: 'user_message', time: Date.now(), text: 'why is the bridge flaky', messageId: 'm-1' }
    ]);
    const summary = await getSession(opened.sessionId!);
    expect(summary?.title).toBe('why is the bridge flaky');
    expect(summary?.origin).toBeNull();
  });

  it('promotes only the generic fallback when the first authored user title arrives late', async () => {
    const conversationId = 'conv-late-first-user-title';
    const sessionId = await sessionForConversation(conversationId);
    expect((await getSession(sessionId!))?.title).toBe('ChatGPT session');

    const observed = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'the real opening question', messageId: 'late-first-user' }
    ]);
    expect(observed.sessionId).toBe(sessionId);
    expect((await getSession(sessionId!))?.title).toBe('the real opening question');

    const manualConversation = 'conv-manual-title-before-user';
    const manualSessionId = await sessionForConversation(manualConversation);
    await renameSession(manualSessionId!, 'My chosen title');
    await recordChatObservations(manualConversation, [
      { kind: 'user_message', time: Date.now(), text: 'must not replace manual title', messageId: 'manual-first-user' }
    ]);
    expect((await getSession(manualSessionId!))?.title).toBe('My chosen title');
  });

  it('promotes the first-user fallback to ChatGPT’s real generated conversation title', async () => {
    const conversationId = 'conv-real-page-title';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'bro fix this exact thing please', messageId: 'title-user-1' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('bro fix this exact thing please');

    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Fix Local Files Reconstruction' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Fix Local Files Reconstruction');

    await renameSession(opened.sessionId!, 'My manual title');
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'A Later ChatGPT Rename' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('My manual title');
  });

  it('recovers a late worker call agent from the durable worker session origin after live broker state is gone', async () => {
    const conversationId = 'conv-late-worker-call';
    const requestId = 'wfr_late_worker_exact';
    await noteChatOrigin(conversationId, worker);
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'worker bootstrap', messageId: 'worker-boot-late-call' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: conversationId,
        calls: [{ messageId: 'worker-late-request', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    const originalSessionId = opened.sessionId!;
    await closeConversation(conversationId);
    expect((await getSession(originalSessionId))?.endedAt).not.toBeNull();

    const call = await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/src/main.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 5,
      startedAt: Date.now(),
      requestId,
      // Deliberately contradictory live broker context. Durable request/session epoch wins.
      agent: 'prime'
    });

    expect(call?.conversationId).toBe(conversationId);
    expect(call?.attributionMethod).toBe('request_id');
    const stored = await readEvents(originalSessionId, { kinds: ['tool_call'] });
    expect(stored).toHaveLength(1);
    const recorded = stored[0];
    expect(recorded?.kind === 'tool_call' && recorded.agent).toBe('worker-1');
    expect(recorded?.kind === 'tool_call' && recorded.call.requestId).toBe(requestId);
    // A late request is not evidence that the worker tab or browser conversation reopened.
    expect((await getSession(originalSessionId))?.endedAt).not.toBeNull();
  });

  it('pins a late pre-transfer request to its original session epoch even after the old conversation starts a fresh session', async () => {
    const oldConversation = 'conv-worker-before-transfer';
    const newConversation = 'conv-worker-after-transfer';
    const oldRequest = 'wfr_worker_before_transfer';
    const freshRequest = 'wfr_stale_tab_fresh_epoch';
    await noteChatOrigin(oldConversation, worker);
    const original = await recordChatObservations(oldConversation, [
      { kind: 'user_message', time: Date.now(), text: 'worker bootstrap', messageId: 'boot-before-transfer' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: oldConversation,
        calls: [{ messageId: 'old-request-message', tool: 'read', order: 0, answered: false, requestId: oldRequest }]
      }
    ]);
    const originalSessionId = original.sessionId!;

    expect(await rebindSession(originalSessionId, oldConversation, newConversation)).toBe(true);
    rebindConversation(originalSessionId, oldConversation, newConversation);

    // The stale old tab is now honestly a new local session epoch for the same old ChatGPT id.
    const stale = await recordChatObservations(oldConversation, [
      { kind: 'user_message', time: Date.now(), text: 'stale tab carried on', messageId: 'stale-epoch-user' }
    ]);
    const staleSessionId = stale.sessionId!;
    expect(staleSessionId).not.toBe(originalSessionId);

    // A request proved before the transfer stays pinned to the exact old session epoch even
    // though live broker context is now contradictory and the old conversation has a new epoch.
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/old.ts'] },
      content: [{ type: 'text', text: 'old request completed late' }],
      outcome: 'ok',
      durationMs: 10,
      startedAt: Date.now(),
      requestId: oldRequest,
      agent: 'prime'
    });
    const originalCalls = await readEvents(originalSessionId, { kinds: ['tool_call'] });
    const staleCallsBefore = await readEvents(staleSessionId, { kinds: ['tool_call'] });
    expect(originalCalls).toHaveLength(1);
    expect(staleCallsBefore).toHaveLength(0);
    expect(originalCalls[0]?.kind === 'tool_call' && originalCalls[0].agent).toBe('worker-1');

    // This must not be implemented as "historical session always wins": a genuinely new
    // request first proved in the stale tab's new epoch belongs to that new epoch.
    await recordChatObservations(oldConversation, [
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: oldConversation,
        calls: [{ messageId: 'fresh-request-message', tool: 'read', order: 0, answered: false, requestId: freshRequest }]
      }
    ]);
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/fresh.ts'] },
      content: [{ type: 'text', text: 'fresh request' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId: freshRequest,
      agent: null
    });
    const staleCallsAfter = await readEvents(staleSessionId, { kinds: ['tool_call'] });
    expect(staleCallsAfter).toHaveLength(1);
    expect(staleCallsAfter[0]?.kind === 'tool_call' && staleCallsAfter[0].call.requestId).toBe(freshRequest);
  });
});

// --------------------------------------------------------------- summaries

describe('tool summaries', () => {
  const summarize = (tool: string, args: unknown, patch: Partial<ReturnType<typeof emptyEvidence>> = {}, outcome: 'ok' | 'error' | 'rejected' = 'ok', durationMs = 10) =>
    summarizeToolCall({ tool, args, evidence: evidence(patch), outcome, durationMs, resultHead: 'head line' });

  /** The patch text a summary reads its intent off. */
  const patch = (header: string, path: string): string =>
    `*** Begin Patch\n*** ${header}: ${path}\n*** End Patch`;

  it('names one edited file and totals several', () => {
    const one = summarize('apply_patch', { patch: patch('Update File', '/p/src/a.ts') }, {
      changes: [{ path: '/p/src/a.ts', added: 18, removed: 4, approximate: false }]
    });
    expect(one.title).toBe('Edited src/a.ts');
    expect(one.metric).toBe('+18 −4');

    const many = summarize('apply_patch', { patch: patch('Update File', '/p/a.ts') }, {
      changes: [
        { path: '/p/a.ts', added: 40, removed: 9, approximate: false },
        { path: '/p/b.ts', added: 32, removed: 10, approximate: false }
      ]
    });
    expect(many.title).toBe('Edited 2 files');
    expect(many.metric).toBe('+72 −19');
  });

  it('marks an approximate diffstat rather than pretending it is exact', () => {
    const summary = summarize('apply_patch', { patch: patch('Update File', '/p/big.ts') }, {
      changes: [{ path: '/p/big.ts', added: 4000, removed: 3000, approximate: true }]
    });
    expect(summary.metric).toBe('~+4000 −3000');
  });

  // One tool now covers create, edit, move and delete, so the title has to come from what
  // the patch did. A timeline that said "Applied a patch" four times would be useless.
  it('tells creates, deletes and moves apart from the patch itself', () => {
    expect(summarize('apply_patch', { patch: patch('Add File', '/p/src/history.ts') }, {
      changes: [{ path: '/p/src/history.ts', added: 214, removed: 0, approximate: false }]
    })).toMatchObject({ title: 'Created src/history.ts', metric: '+214', kind: 'create' });

    expect(summarize('apply_patch', { patch: patch('Delete File', '/p/old-helper.ts') }, {
      changes: [{ path: '/p/old-helper.ts', added: 0, removed: 83, approximate: false }]
    })).toMatchObject({ title: 'Deleted old-helper.ts', metric: '−83', tone: 'warn', kind: 'delete' });

    const moved = summarize(
      'apply_patch',
      { patch: '*** Begin Patch\n*** Move to: /p/new.ts\n*** End Patch' },
      { changes: [{ path: '/p/new.ts', added: 0, removed: 0, approximate: false }] }
    );
    expect(moved).toMatchObject({ title: 'Moved new.ts', kind: 'move' });

    // A patch that both adds and updates is simply an edit; it must not claim to be a create.
    const mixed = summarize(
      'apply_patch',
      { patch: `${patch('Add File', '/p/a.ts')}\n*** Update File: /p/b.ts` },
      {
        changes: [
          { path: '/p/a.ts', added: 5, removed: 0, approximate: false },
          { path: '/p/b.ts', added: 1, removed: 1, approximate: false }
        ]
      }
    );
    expect(mixed.kind).toBe('edit');
  });

  it('describes a read by its paths and range', () => {
    expect(summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 })).toMatchObject({
      title: 'Read tools.ts',
      detail: 'lines 200–420',
      metric: '221 lines'
    });
    expect(
      summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 }, { detail: 'lines 200–237' })
    ).toMatchObject({ detail: 'lines 200–237', metric: '38 lines' });
    expect(summarize('read', { paths: ['/p/a.ts', '/p/b.ts', '/p/c.ts'] })).toMatchObject({
      title: 'Read 3 paths',
      detail: 'a.ts, b.ts, c.ts'
    });
  });

  it('reports how a command exited', () => {
    expect(summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: 0, durationMs: 4800 })).toMatchObject({
      title: 'Ran npm run verify',
      metric: '✓ 4.8s',
      tone: 'good'
    });
    const failed = summarize('exec_command', { cmd: 'npm test' }, { exitCode: 1, durationMs: 900 });
    expect(failed.title).toContain('Command failed');
    expect(failed.metric).toBe('✕ exit 1');
    expect(failed.tone).toBe('bad');
    expect(summarize('exec_command', { cmd: 'sleep 100' }, { exitCode: null, timedOut: true }).metric).toBe(
      '✕ timed out'
    );
    expect(
      summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: null, durationMs: 10_000 })
    ).toMatchObject({ title: 'Started npm run verify', metric: 'running', tone: 'neutral' });
  });

  it('says which way a session was interrupted', () => {
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'kill' })).toMatchObject({
      title: 'Stopped session p1',
      tone: 'warn'
    });
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'int' }).title).toBe('Interrupted session p1');
    expect(summarize('write_stdin', { session_id: 'p1', chars: 'y\n' }).title).toBe('Wrote to session p1');
    expect(summarize('write_stdin', { session_id: 'p1' }).title).toBe('Waited on session p1');
  });

  it('keeps the subject but not the claim when a call fails or is refused', () => {
    const refused = summarize('apply_patch', { patch: patch('Delete File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 0, removed: 3, approximate: false }]
    }, 'rejected');
    expect(refused.title).toBe('Refused to delete x.ts');
    expect(refused.metric).toBe('refused');
    expect(refused.tone).toBe('warn');

    const errored = summarize('apply_patch', { patch: patch('Update File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 1, removed: 1, approximate: false }]
    }, 'error');
    expect(errored.title).toBe('Could not edit x.ts');
    expect(errored.metric).toBe('✕ failed');
    expect(errored.detail).toBe('head line');
    expect(errored.tone).toBe('bad');
  });

  it('says a failed call failed in words, for every tool family', () => {
    const cases: Array<[string, unknown, string]> = [
      ['read', { paths: ['/p/x.ts'] }, 'Could not read x.ts'],
      ['find', { query: 'todo' }, 'Could not search "todo"'],
      ['apply_patch', { patch: patch('Update File', '/p/x.ts') }, 'Could not apply a patch'],
      ['exec_command', { cmd: 'npm test' }, 'Could not run npm test'],
      ['observe', {}, 'Could not look at the screen'],
      ['agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }, 'Could not create 2 worker agents'],
      ['agents', { action: 'join' }, 'Could not join the agent swarm'],
      ['agents', { action: 'finish', result: 'done' }, 'Could not report the finished task'],
      ['some_future_tool', {}, 'Could not run some_future_tool']
    ];
    for (const [tool, args, title] of cases) {
      const summary = summarize(tool, args, {}, 'error');
      expect(summary.title, tool).toBe(title);
      // Nothing may still read as an accomplished action.
      expect(summary.title, tool).not.toMatch(/^(Read|Applied|Created|Searched|Ran|Joined|Reported|Looked) /);
    }
  });

  it('reads the action out of the flat session and agents tools', () => {
    expect(summarize('agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }).title).toBe(
      'Created 2 worker agents'
    );
    expect(summarize('agents', { action: 'message', to: 'worker-2' }).title).toBe('Messaged worker-2');
    expect(summarize('agents', { action: 'status' }).title).toBe('Checked agent status');
    expect(summarize('session', { action: 'history', query: 'tunnel' }).title).toBe(
      'Searched session history "tunnel"'
    );
    expect(summarize('session', { action: 'history' }).title).toBe('Read the session timeline');
  });

  it('names the desktop action rather than saying "computer"', () => {
    expect(summarize('computer', { actions: [{ type: 'click_ref', ref: 'e1' }] })).toMatchObject({
      title: 'Clicked',
      kind: 'input'
    });
    // Clipboard-only work is not desktop input and should not read as if it were.
    expect(summarize('computer', { actions: [{ type: 'read_clipboard' }] })).toMatchObject({
      title: 'Read the clipboard',
      kind: 'clipboard'
    });
    expect(
      summarize('computer', { actions: [{ type: 'write_clipboard', text: 'x' }, { type: 'keypress', keys: ['ctrl', 'v'] }] })
    ).toMatchObject({ kind: 'input', detail: '2 actions' });
  });

  it('shows the command that actually ran instead of the words "a command"', () => {
    const single = summarize('exec_command', { cmd: 'Get-Process -Name node' }, { exitCode: 0, durationMs: 120 });
    expect(single.title).toBe('Ran Get-Process -Name node');

    const many = summarize(
      'exec_command',
      { cmd: '# find the build\r\nGet-ChildItem -Recurse -Filter *.log\nSelect-Object -First 5' },
      { exitCode: 0, durationMs: 120 }
    );
    // Comments are skipped, the first real line leads, and the rest is signalled.
    expect(many.title).toBe('Ran Get-ChildItem -Recurse -Filter *.log …');

    const long = summarize('exec_command', { cmd: `Write-Output ${'x'.repeat(200)}` }, { exitCode: 0 });
    expect(long.title.length).toBeLessThan(90);
    expect(long.title.endsWith('…')).toBe(true);

    expect(summarize('exec_command', {}, { exitCode: 1, durationMs: 5 }).title).toBe('Command failed  a command');
  });

  it('falls back to the tool name rather than "Called tool"', () => {
    expect(summarize('some_future_tool', {}).title).toBe('Ran some_future_tool');
  });
});

// ---------------------------------------------------------------- diffstat

describe('line deltas', () => {
  it('counts a pure insertion and a pure deletion exactly', () => {
    expect(lineDelta('a\nb\n', 'a\nnew\nb\n')).toEqual({ added: 1, removed: 0, approximate: false });
    expect(lineDelta('a\nb\nc\n', 'a\nc\n')).toEqual({ added: 0, removed: 1, approximate: false });
  });

  it('counts a replacement as one added and one removed', () => {
    expect(lineDelta('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('reports nothing for identical text, including a new file', () => {
    expect(lineDelta('same\n', 'same\n')).toEqual({ added: 0, removed: 0, approximate: false });
    expect(lineDelta('', 'one\ntwo\n')).toEqual({ added: 2, removed: 0, approximate: false });
    expect(formatDelta({ added: 0, removed: 0 })).toBeNull();
  });

  it('handles a reordered block without inventing changes', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const after = ['a', 'c', 'b', 'd', 'e'].join('\n');
    expect(lineDelta(before, after)).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('counts sparse edits exactly even when they are thousands of lines apart', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = 'changed ten';
    after[3500] = 'changed thirty-five hundred';
    expect(lineDelta(before.join('\n'), after.join('\n'))).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('normalizes CRLF/LF for sparse large-file counting', () => {
    const before = Array.from({ length: 3200 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[5] = 'changed five';
    after[3000] = 'changed three thousand';
    expect(lineDelta(`${before.join('\r\n')}\r\n`, `${after.join('\n')}\n`)).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('says so when a rewrite is too large to diff exactly', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 4000 }, (_, i) => `changed ${i}`).join('\n');
    const delta = lineDelta(before, after);
    expect(delta.approximate).toBe(true);
    expect(delta.added).toBe(4000);
  });

  it('formats the metric the way the timeline shows it', () => {
    expect(formatDelta({ added: 18, removed: 4 })).toBe('+18 −4');
    expect(formatDelta({ added: 214, removed: 0 })).toBe('+214');
    expect(formatDelta({ added: 0, removed: 83 })).toBe('−83');
  });
});

// ------------------------------------------------------------------ tokens

describe('token estimation', () => {
  it('is an explicit approximation of local text only', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(4001))).toBe(1001);
  });

  it('weighs an event by the text actually kept', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'c1',
        tool: 'read_file',
        attribution: 'turn',
        args: { text: 'a'.repeat(400), truncated: false, chars: 400 },
        result: { text: 'b'.repeat(800), truncated: false, chars: 800 },
        outcome: 'ok',
        durationMs: 3,
        summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' }
      }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(100 + 200 + Math.ceil('Read a.ts'.length / 4));
  });

  it('does not inflate the context advisory with transient progress captions', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'extension',
      kind: 'progress',
      message: { text: 'reasoning status '.repeat(100), truncated: false, chars: 1700 }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(0);
  });

  it('counts a brokered agent message, which the model does read', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'app',
      kind: 'agent_message',
      messageId: 'm1',
      from: 'worker-1',
      to: 'prime',
      message: { text: 'r'.repeat(1200), truncated: false, chars: 1200 },
      delivery: 'delivered'
    } as SessionEvent;
    expect(eventTokens(event)).toBe(300);
  });

  it('grades pressure against the configured thresholds', () => {
    expect(tokenPressure(50_000, 180_000, 200_000).level).toBe('ok');
    expect(tokenPressure(185_000, 180_000, 200_000).level).toBe('large');
    expect(tokenPressure(220_000, 180_000, 200_000).level).toBe('huge');
  });
});

/**
 * The log is append-only, so a commentary line being written arrives as a run of records
 * under one id. Every reader that is not watching it live wants the opposite: the newest
 * text, once, where the line started.
 */
describe('folding redrawn commentary', () => {
  const progress = (seq: number, progressId: string, text: string, origin?: number): SessionEvent =>
    ({
      seq,
      time: seq,
      source: 'extension',
      kind: 'progress',
      progressId,
      ...(origin === undefined ? {} : { origin }),
      message: { text, truncated: false, chars: text.length }
    }) as SessionEvent;

  it('keeps the newest text at the earliest record’s position', () => {
    const folded = foldProgress([
      progress(1, 'p1', 'Monitoring'),
      progress(2, 'p2', 'Reading'),
      progress(3, 'p1', 'Monitoring the review', 1),
      progress(4, 'p1', 'Wrote the summary', 1)
    ]);

    expect(folded.map((event) => event.seq)).toEqual([1, 2]);
    expect(folded.map((event) => (event as { message: { text: string } }).message.text)).toEqual([
      'Wrote the summary',
      'Reading'
    ]);
  });

  it('leaves everything that is not identified commentary exactly where it was', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 1, source: 'extension', kind: 'turn_start' } as SessionEvent,
      progress(2, 'p1', 'first'),
      // No id: an older recording, or a page that would not take the stamp. Nothing to fold.
      {
        seq: 3,
        time: 3,
        source: 'extension',
        kind: 'progress',
        message: { text: 'unidentified', truncated: false, chars: 12 }
      } as SessionEvent,
      progress(4, 'p1', 'second', 2),
      { seq: 5, time: 5, source: 'extension', kind: 'turn_end', outcome: 'completed' } as SessionEvent
    ];

    const folded = foldProgress(events);
    expect(folded.map((event) => event.seq)).toEqual([1, 2, 3, 5]);
    expect(foldProgress(events)).toEqual(folded);
    // Non-destructive: the original array is untouched.
    expect(events).toHaveLength(5);
  });
});

/**
 * Where the store writes when nobody has told it where.
 *
 * `root` starts as the empty string, and `path.join('', id)` is a relative path — so an
 * uninitialised store did not fail, it wrote real session folders into the process's
 * working directory. Recording being off by default hid that completely. The moment it
 * was turned on, a test run started leaving recordings scattered through the repository,
 * and the only reason it was noticed was `git status`.
 */
describe('a session store nobody has pointed anywhere', () => {
  afterEach(() => {
    initSessionStore(dir);
  });

  it('refuses to write rather than falling back to the working directory', async () => {
    unsetSessionRootForTests();
    await expect(createSession({ conversationId: null })).rejects.toThrow(/initSessionStore/);
  });

  it('refuses to read as well, instead of reporting an empty history', async () => {
    unsetSessionRootForTests();
    await expect(listSessions()).rejects.toThrow(/initSessionStore/);
  });
});
