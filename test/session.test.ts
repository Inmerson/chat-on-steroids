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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { lineDelta, formatDelta } from '../src/main/diffstat.js';
import { chunkText } from '../src/main/mcp/tools.js';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import { packSession } from '../src/main/session/compact.js';
import {
  closeConversation,
  liveConversations,
  recordChatObservations,
  recordToolCall,
  resetRecorderForTests,
  sessionForConversation
} from '../src/main/session/recorder.js';
import {
  appendEvent,
  createSession,
  deleteSession,
  flushSessions,
  getSession,
  initSessionStore,
  latestHandoff,
  listSessions,
  pruneSessions,
  readAsset,
  readEvents,
  readHandoff,
  resetSessionStoreForTests,
  saveHandoff,
  sessionsRoot,
  writeAsset
} from '../src/main/session/store.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';
import { estimateTokens, eventTokens, tokenPressure, type SessionEvent } from '../src/shared/session.js';
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

  it('orders by sequence even when timestamps arrive out of order', async () => {
    const summary = await createSession({ title: 'clock skew' });
    await appendEvent(summary.id, { time: 5000, source: 'extension', kind: 'turn_start' });
    await appendEvent(summary.id, { time: 1000, source: 'extension', kind: 'turn_end', outcome: 'unknown' });
    const events = await readEvents(summary.id);
    expect(events.map((event) => event.kind)).toEqual(['turn_start', 'turn_end']);
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
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
      model: 'deepseek/test',
      chars: 23,
      reason: 'manual'
    });
    await appendEvent(newer.id, {
      time: 2000,
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-02-bbbbbbbb',
      model: 'deepseek/test',
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
      model: 'deepseek/test',
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
});

// ---------------------------------------------------------------- recorder

describe('recorder', () => {
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

  it('attributes a tool call to the one conversation that is generating', async () => {
    const sessionId = await sessionForConversation('conv-turn');
    await recordChatObservations('conv-turn', [
      { kind: 'turn_start', time: Date.now(), turnId: 'turn-77' }
    ]);
    const call = await recordToolCall({
      tool: 'edit_file',
      args: { path: '/project/src/main.ts' },
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

  it('marks a call inferred when no conversation is demonstrably generating', async () => {
    await sessionForConversation('conv-a');
    await sessionForConversation('conv-b');
    const call = await recordToolCall({
      tool: 'search_files',
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

  it('reuses the session of a conversation that is reopened', async () => {
    const first = await sessionForConversation('conv-reopen');
    resetRecorderForTests();
    const second = await sessionForConversation('conv-reopen');
    expect(second).toBe(first);
    // The reopen must not write a second session_start into the same log.
    expect(await readEvents(first!, { kinds: ['session_start'] })).toHaveLength(1);
  });

  it('closes an open turn as interrupted when the tab goes away', async () => {
    const sessionId = await sessionForConversation('conv-closing');
    await recordChatObservations('conv-closing', [{ kind: 'turn_start', time: Date.now(), turnId: 't1' }]);
    expect(liveConversations()[0]?.generating).toBe(true);

    await closeConversation('conv-closing');
    const ends = await readEvents(sessionId!, { kinds: ['turn_end'] });
    expect(ends).toHaveLength(1);
    expect(ends[0]!.kind === 'turn_end' && ends[0]!.outcome).toBe('interrupted');
    expect(liveConversations()).toHaveLength(0);
  });

  it('records the outcome the page reported, without upgrading a guess', async () => {
    const sessionId = await sessionForConversation('conv-outcomes');
    await recordChatObservations('conv-outcomes', [
      { kind: 'turn_start', time: 1 },
      { kind: 'turn_end', time: 2, outcome: 'stalled', detail: 'no visible output for ten minutes' },
      { kind: 'turn_start', time: 3 },
      { kind: 'turn_end', time: 4 }
    ]);
    const ends = await readEvents(sessionId!, { kinds: ['turn_end'] });
    expect(ends.map((event) => (event.kind === 'turn_end' ? event.outcome : null))).toEqual(['stalled', 'unknown']);
  });

  it('keeps credentials and clipboard text out of the log', async () => {
    const sessionId = await sessionForConversation('conv-redact');
    await recordChatObservations('conv-redact', [{ kind: 'turn_start', time: Date.now(), turnId: 'redact-turn' }]);
    const call = await recordToolCall({
      tool: 'run_command',
      args: { command: 'npm', args: ['test'], env: { TOKEN: 'super-secret-value' } },
      content: [{ type: 'text', text: 'exit 0' }],
      outcome: 'ok',
      durationMs: 4800,
      startedAt: Date.now(),
      evidence: evidence({ exitCode: 0, durationMs: 4800 })
    });
    expect(call?.args.text).not.toContain('super-secret-value');
    expect(call?.args.text).toContain('***');
    expect(call?.summary.metric).toBe('✓ 4.8s');

    const clip = await recordToolCall({
      tool: 'read_clipboard',
      args: {},
      content: [{ type: 'text', text: 'whatever the user had copied' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now()
    });
    expect(clip?.result.text).not.toContain('whatever the user had copied');
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(2);
  });

  it('stores an image result as an asset instead of inlining it', async () => {
    const sessionId = await sessionForConversation('conv-shot');
    await recordChatObservations('conv-shot', [{ kind: 'turn_start', time: Date.now(), turnId: 'shot-turn' }]);
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

// --------------------------------------------------------------- summaries

describe('tool summaries', () => {
  const summarize = (tool: string, args: unknown, patch: Partial<ReturnType<typeof emptyEvidence>> = {}, outcome: 'ok' | 'error' | 'rejected' = 'ok', durationMs = 10) =>
    summarizeToolCall({ tool, args, evidence: evidence(patch), outcome, durationMs, resultHead: 'head line' });

  it('names one edited file and totals several', () => {
    const one = summarize('edit_file', { path: '/p/src/a.ts' }, {
      changes: [{ path: '/p/src/a.ts', added: 18, removed: 4, approximate: false }]
    });
    expect(one.title).toBe('Edited src/a.ts');
    expect(one.metric).toBe('+18 −4');

    const many = summarize('edit_files', { files: [] }, {
      changes: [
        { path: '/p/a.ts', added: 40, removed: 9, approximate: false },
        { path: '/p/b.ts', added: 32, removed: 10, approximate: false }
      ]
    });
    expect(many.title).toBe('Edited 2 files');
    expect(many.metric).toBe('+72 −19');
  });

  it('marks an approximate diffstat rather than pretending it is exact', () => {
    const summary = summarize('write_file', { path: '/p/big.ts' }, {
      changes: [{ path: '/p/big.ts', added: 4000, removed: 3000, approximate: true }]
    });
    expect(summary.metric).toBe('~+4000 −3000');
  });

  it('describes creates, deletes, moves and reads in their own shape', () => {
    expect(summarize('create_file', { path: '/p/src/history.ts' }, {
      changes: [{ path: '/p/src/history.ts', added: 214, removed: 0, approximate: false }]
    })).toMatchObject({ title: 'Created src/history.ts', metric: '+214' });

    expect(summarize('delete_file', { path: '/p/old-helper.ts' }, {
      changes: [{ path: '/p/old-helper.ts', added: 0, removed: 83, approximate: false }]
    })).toMatchObject({ title: 'Deleted old-helper.ts', metric: '−83', tone: 'warn' });

    expect(summarize('move_path', { from: '/p/old.ts', to: '/p/new.ts' }).title).toBe('Moved old.ts → new.ts');
    expect(summarize('read_file', { path: '/p/tools.ts', startLine: 200, endLine: 420 })).toMatchObject({
      title: 'Read tools.ts',
      detail: 'lines 200–420'
    });
  });

  it('reports how a command exited', () => {
    expect(summarize('run_command', { command: 'npm', args: ['run', 'verify'] }, { exitCode: 0, durationMs: 4800 })).toMatchObject({
      title: 'Ran npm run verify',
      metric: '✓ 4.8s',
      tone: 'good'
    });
    const failed = summarize('run_command', { command: 'npm', args: ['test'] }, { exitCode: 1, durationMs: 900 });
    expect(failed.title).toContain('Command failed');
    expect(failed.metric).toBe('✕ exit 1');
    expect(failed.tone).toBe('bad');
    expect(summarize('run_command', { command: 'sleep' }, { exitCode: null, timedOut: true }).metric).toBe('✕ timed out');
  });

  it('keeps the subject when a call fails or is refused', () => {
    const refused = summarize('delete_file', { path: '/p/x.ts' }, {}, 'rejected');
    expect(refused.title).toBe('Deleted x.ts');
    expect(refused.metric).toBe('refused');
    expect(refused.tone).toBe('warn');

    const errored = summarize('edit_file', { path: '/p/x.ts' }, {}, 'error');
    expect(errored.metric).toBe('✕ failed');
    expect(errored.detail).toBe('head line');
    expect(errored.tone).toBe('bad');
  });

  it('counts the workers a create_agents call actually asked for', () => {
    expect(summarize('create_agents', { workers: [{ task: 'a' }, { task: 'b' }] }).title).toBe('Created 2 worker agents');
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

  it('grades pressure against the configured thresholds', () => {
    expect(tokenPressure(50_000, 180_000, 200_000).level).toBe('ok');
    expect(tokenPressure(185_000, 180_000, 200_000).level).toBe('large');
    expect(tokenPressure(220_000, 180_000, 200_000).level).toBe('huge');
  });
});

// ------------------------------------------------------------------- pack

describe('compaction pack', () => {
  const summary = {
    id: '2026-08-15-abcdabcd',
    title: 'long session',
    conversationId: 'conv-1',
    startedAt: 1,
    updatedAt: 2,
    endedAt: null,
    events: 0,
    userMessages: 2,
    toolCalls: 2,
    errors: 1,
    estimatedTokens: 1000,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: 'interrupted' as const,
    agents: []
  };

  const events: SessionEvent[] = [
    {
      seq: 1,
      time: 1,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'REQUIREMENT ONE: never lose this', truncated: false, chars: 32 }
    },
    {
      seq: 2,
      time: 2,
      source: 'extension',
      kind: 'progress',
      message: { text: 'chatter '.repeat(200), truncated: false, chars: 1600 }
    },
    {
      seq: 3,
      time: 3,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: { text: 'commentary '.repeat(200), truncated: false, chars: 2200 }
    },
    {
      seq: 4,
      time: 4,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'c-fail',
        tool: 'run_command',
        attribution: 'turn',
        args: { text: '{"command":"npm","args":["test"]}', truncated: false, chars: 33 },
        result: { text: 'FAILING TEST: recorder.test.ts', truncated: false, chars: 30 },
        outcome: 'error',
        durationMs: 900,
        summary: { title: 'Command failed  npm test', metric: '✕ exit 1', tone: 'bad', kind: 'run' }
      }
    },
    {
      seq: 5,
      time: 5,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'c-edit',
        tool: 'edit_file',
        attribution: 'turn',
        args: { text: '{"path":"/p/src/store.ts"}', truncated: false, chars: 26 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok',
        durationMs: 20,
        summary: { title: 'Edited src/store.ts', metric: '+18 −4', tone: 'good', kind: 'edit' },
        changes: [{ path: '/p/src/store.ts', added: 18, removed: 4, approximate: false }]
      }
    },
    {
      seq: 6,
      time: 6,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'CORRECTION: requirement one changed', truncated: false, chars: 35 }
    },
    { seq: 7, time: 7, source: 'extension', kind: 'turn_end', outcome: 'interrupted' }
  ];

  it('keeps every user message even when the budget is tiny', () => {
    const pack = packSession(summary, events, 1500);
    const text = pack.parts.join('\n');
    expect(text).toContain('REQUIREMENT ONE: never lose this');
    expect(text).toContain('CORRECTION: requirement one changed');
    // Narration is what a tight budget is allowed to lose.
    expect(text).not.toContain('commentary commentary');
    expect(pack.notes.join(' ')).toMatch(/did not fit/);
  });

  it('promotes failures and file changes above commentary', () => {
    const pack = packSession(summary, events, 1500);
    const text = pack.parts.join('\n');
    expect(text).toContain('FAILING TEST');
    expect(text).toContain('/p/src/store.ts +18 −4');
    expect(text).toContain('TURN ENDED: interrupted');
  });

  it('includes the commentary when there is room for it', () => {
    const pack = packSession(summary, events, 200_000);
    const text = pack.parts.join('\n');
    expect(text).toContain('commentary commentary');
    expect(text).toContain('progress:');
    expect(pack.notes).toHaveLength(0);
    expect(pack.events).toBe(events.length);
    expect(pack.tokens).toBeGreaterThan(0);
  });

  it('stages essential history across multiple requests instead of silently exceeding the model budget', () => {
    const huge: SessionEvent[] = Array.from({ length: 8 }, (_, index) => ({
      seq: index + 1,
      time: index + 1,
      source: 'extension' as const,
      kind: 'user_message' as const,
      message: {
        text: `REQUIREMENT ${index}: ${String(index).repeat(7000)}`,
        truncated: false,
        chars: 7015
      }
    }));
    const pack = packSession({ ...summary, events: huge.length, userMessages: huge.length }, huge, 10_000);
    expect(pack.parts.length).toBeGreaterThan(1);
    expect(pack.notes.join(' ')).toMatch(/passes to fit the model's context/);
    const combined = pack.parts.join('\n');
    for (let index = 0; index < huge.length; index++) expect(combined).toContain(`REQUIREMENT ${index}:`);
    // Header/markers add a small fixed overhead, but no part may balloon anywhere near
    // the complete essential history just because tier 1 did not fit in one request.
    expect(Math.max(...pack.parts.map((part) => part.length))).toBeLessThan(12_000);
  });

  it('states what the recording itself already lost', () => {
    const truncated: SessionEvent[] = [
      {
        seq: 1,
        time: 1,
        source: 'extension',
        kind: 'user_message',
        message: { text: 'cut here', truncated: true, chars: 90_000 }
      }
    ];
    expect(packSession(summary, truncated, 10_000).notes.join(' ')).toMatch(/longer than the recorder's cap/);
  });
});
