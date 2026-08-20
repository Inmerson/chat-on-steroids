/**
 * Durable session history.
 *
 * Deliberately separate from the in-memory diagnostics log in logger.ts. That log
 * stays small, redacted and RAM-only; this one is an explicit opt-in feature that
 * writes what actually happened to disk so a five-hour session can be recovered.
 *
 * Structured activity is append-only JSONL. ChatGPT messages are different: streaming
 * changes the content of one logical message, so storing each snapshot as another event
 * creates duplicate transcript rows by construction. Since 1.8 they live in one small
 * canonical map keyed by a stable logical website identity and are atomically replaced in
 * place. Identity is decided by the page/Fiber producer before it gets here; this store never
 * guesses that two different website ids are one message from their text, turn or timing.
 *
 *   sessions/<id>/events.jsonl    tool/turn/error/activity events, append-only
 *   sessions/<id>/messages.json   canonical user/assistant messages, keyed by logical id
 *   sessions/<id>/meta.json       the summary, rewritten atomically
 *   sessions/<id>/assets/<id>     screenshots and other binaries
 *   sessions/<id>/handoffs/<id>.json
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AssetRef,
  Handoff,
  NewSessionEvent,
  SessionEvent,
  SessionOrigin,
  SessionSummary
} from '../../shared/session.js';
import { eventTokens } from '../../shared/session.js';
import { chronological } from '../../shared/chronology.js';
import { getConfig } from '../config.js';
import { logError, logInfo, logWarn } from '../logger.js';

/**
 * Caps on how much of a value is written *inline*, into the JSONL line itself.
 *
 * These are not caps on what is kept. Anything longer is written whole, redacted, as a
 * `.txt` asset beside the log and referenced by `StoredText.assetId`, so the exact
 * arguments of an edit and the exact output of a command stay recoverable however
 * large they were — which is the entire premise of calling this history the source of
 * truth. What the caps buy is a log whose lines a reader can still parse and a summary
 * pass can still skim.
 */
// A Compact & Resume handoff becomes the next chat's opening user message. This is a wire /
// storage safety bound, not a token budget; keep it comfortably above the model's 30k-token
// handoff ceiling so the recorder does not immediately turn the carried brief into an inline
// stub plus asset reference. Truly runaway messages still spill to assets through storeText().
export const MAX_USER_MESSAGE_CHARS = 256_000;
export const MAX_MESSAGE_CHARS = 12_000;
export const MAX_TOOL_ARGS_CHARS = 8_000;
export const MAX_TOOL_RESULT_CHARS = 8_000;
/** Nothing is spilled to an overflow asset past this; a note records the shortfall. */
export const MAX_OVERFLOW_ASSET_CHARS = 8 * 1024 * 1024;
/** A single line that cannot be parsed back is dropped; this bounds the damage. */
const MAX_LINE_BYTES = 512 * 1024;
/** How many sessions the UI shows. Lookups and pruning still see every session. */
const MAX_LISTED_SESSIONS = 200;
/** Hard stop on directory enumeration, so a pathological folder cannot hang the app. */
const MAX_SCANNED_SESSIONS = 5_000;

let root = '';

export function initSessionStore(userDataDir: string): void {
  root = path.join(userDataDir, 'sessions');
}

export function sessionsRoot(): string {
  return root;
}

/**
 * Refuses to touch the disk before somebody has said where.
 *
 * `root` starts empty, and `path.join('', id)` is a *relative* path — so an uninitialised
 * store does not fail, it writes real session folders into whatever the process's working
 * directory happens to be. That stayed invisible for as long as recording was off by
 * default; the moment it was switched on, a test run began scattering recordings through
 * the repository. In the app proper this cannot happen — `initSessionStore` is called
 * during start-up — which is exactly why it needs to be loud rather than left to chance.
 */
function assertReady(): void {
  if (root === '') {
    throw new Error('The session store was used before initSessionStore() named a directory');
  }
}

function sessionDir(id: string): string {
  assertReady();
  return path.join(root, id);
}

/** Ids are generated here and never taken from a caller, so this is a sanity check. */
function assertSessionId(id: string): void {
  if (!/^[0-9a-z-]{8,64}$/i.test(id)) throw new Error('Invalid session id');
}

// ------------------------------------------------------------------ state

interface OpenSession {
  summary: SessionSummary;
  nextSeq: number;
  /** Recent durable events, so incremental /activity polls do not reread the whole JSONL. */
  tail: SessionEvent[];
  /** Serialises appends so two events can never interleave inside one line. */
  queue: Promise<void>;
  /** Canonical ChatGPT messages. A later streaming/final snapshot replaces by stable id. */
  messages: Map<string, MessageEvent>;
  metaDirty: boolean;
  metaTimer: NodeJS.Timeout | null;
}

const open = new Map<string, OpenSession>();
const MAX_EVENT_TAIL = 4096;

type MessageEvent = Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' }>;
type NewMessageEvent = MessageEvent extends infer Event
  ? Event extends MessageEvent
    ? Omit<Event, 'seq'>
    : never
  : never;

function messageKey(event: Pick<MessageEvent, 'kind' | 'messageId'>): string | null {
  return event.messageId ? `${event.kind}\u0000${event.messageId}` : null;
}

function emptySummary(id: string, title: string, conversationId: string | null): SessionSummary {
  const now = Date.now();
  return {
    id,
    title,
    conversationId,
    chatIds: conversationId ? [conversationId] : [],
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    events: 0,
    userMessages: 0,
    toolCalls: 0,
    errors: 0,
    estimatedTokens: 0,
    contextTokens: 0,
    autoCompactThreshold: null,
    autoCompactActiveTurnId: null,
    autoCompactArmedSeq: null,
    autoCompactTurnId: null,
    autoCompactArmedAt: null,
    autoCompactReadyAt: null,
    autoCompactTriggeredAt: null,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: null,
    agents: [],
    origin: null
  };
}

/**
 * Persists one summary atomically, without any live-entry bookkeeping.
 *
 * Split out so a *staged* summary can be written before it is published into memory. That
 * ordering is what makes the compaction rebind safe to fail: see rebindSession.
 */
async function writeSummary(summary: SessionSummary): Promise<void> {
  const dir = sessionDir(summary.id);
  const target = path.join(dir, 'meta.json');
  const tmp = `${target}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(summary, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

async function writeMeta(entry: OpenSession): Promise<void> {
  await writeSummary(entry.summary);
  entry.metaDirty = false;
}

/**
 * The summary is rewritten on a short delay rather than on every event. A long agent
 * session appends thousands of events; rewriting the summary for each one would turn
 * an append-only log into a write-amplified one for no benefit.
 */
function scheduleMeta(entry: OpenSession): void {
  entry.metaDirty = true;
  if (entry.metaTimer) return;
  entry.metaTimer = setTimeout(() => {
    entry.metaTimer = null;
    void writeMeta(entry).catch((err) => logError(`session meta write failed: ${(err as Error).message}`));
  }, 1500);
  entry.metaTimer.unref?.();
}

/** Flushes any pending summary write. Called before the app quits and before reads. */
export async function flushSessions(): Promise<void> {
  for (const entry of open.values()) {
    if (entry.metaTimer) {
      clearTimeout(entry.metaTimer);
      entry.metaTimer = null;
    }
    await entry.queue.catch(() => undefined);
    if (entry.metaDirty) await writeMeta(entry).catch(() => undefined);
  }
}

// ----------------------------------------------------------------- create

export async function createSession(options: {
  title?: string;
  conversationId?: string | null;
  origin?: SessionOrigin | null;
}): Promise<SessionSummary> {
  const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const summary = emptySummary(id, options.title?.trim() || 'ChatGPT session', options.conversationId ?? null);
  summary.origin = options.origin ?? null;
  const entry: OpenSession = {
    summary,
    nextSeq: 1,
    tail: [],
    queue: Promise.resolve(),
    messages: new Map(),
    metaDirty: false,
    metaTimer: null
  };
  open.set(id, entry);
  await fs.mkdir(sessionDir(id), { recursive: true });
  await fs.writeFile(path.join(sessionDir(id), 'events.jsonl'), '', { flag: 'a' });
  await fs.writeFile(path.join(sessionDir(id), 'messages.json'), '{}', { flag: 'a' });
  await writeMeta(entry);
  return { ...summary };
}

// ----------------------------------------------------------------- append

/** Reads the highest seq already on disk, so a restart never reuses a number. */
async function lastSeqOnDisk(id: string): Promise<number> {
  try {
    const file = path.join(sessionDir(id), 'events.jsonl');
    const stat = await fs.stat(file);
    const from = Math.max(0, stat.size - 128 * 1024);
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as SessionEvent;
          if (typeof parsed.seq === 'number') return parsed.seq;
        } catch {
          // A torn final line is expected after a crash; keep looking backwards.
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    // No file yet, or unreadable: start from zero and let the append recreate it.
  }
  return 0;
}

/**
 * Closes off a torn last line before anything is appended after it.
 *
 * A crash mid-append leaves a line with no newline. Appending straight onto it would
 * glue a perfectly good new event onto the wreckage and lose that one too, so the
 * damage is sealed with a newline first: one event lost, which is the promise.
 */
async function sealTornTail(id: string): Promise<void> {
  const file = path.join(sessionDir(id), 'events.jsonl');
  try {
    const stat = await fs.stat(file);
    if (stat.size === 0) return;
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, stat.size - 1);
      if (buffer[0] === 0x0a) return;
    } finally {
      await handle.close();
    }
    await fs.appendFile(file, '\n', 'utf8');
    logWarn(`session ${id}: sealed an unterminated final line before appending`);
  } catch {
    // No file yet, or unreadable: the append will recreate it.
  }
}

/** Canonical message snapshot file. Unknown/legacy shapes are ignored, never guessed. */
async function readCanonicalMessages(id: string): Promise<Map<string, MessageEvent>> {
  const out = new Map<string, MessageEvent>();
  try {
    const raw = await fs.readFile(path.join(sessionDir(id), 'messages.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const event = value as MessageEvent;
      if ((event.kind !== 'user_message' && event.kind !== 'assistant_message') || typeof event.seq !== 'number') continue;
      const expected = messageKey(event);
      if (!expected || expected !== key) continue;
      out.set(key, event);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn(`session ${id}: canonical message file unreadable; legacy event log remains available`);
    }
  }
  return out;
}

async function writeCanonicalMessages(id: string, messages: Map<string, MessageEvent>): Promise<void> {
  const target = path.join(sessionDir(id), 'messages.json');
  const tmp = `${target}.tmp`;
  const object: Record<string, MessageEvent> = {};
  for (const [key, value] of messages) object[key] = value;
  const text = JSON.stringify(object);
  if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new Error('Canonical message store is too large');
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, target);
}

async function ensureOpen(id: string): Promise<OpenSession> {
  assertSessionId(id);
  const existing = open.get(id);
  if (existing) return existing;
  await sealTornTail(id);
  const summary = (await readMeta(id)) ?? emptySummary(id, 'Recovered session', null);
  const messages = await readCanonicalMessages(id);
  let messageSeq = 0;
  for (const event of messages.values()) messageSeq = Math.max(messageSeq, event.seq);
  const entry: OpenSession = {
    summary,
    nextSeq: Math.max(await lastSeqOnDisk(id), messageSeq) + 1,
    tail: [],
    queue: Promise.resolve(),
    messages,
    metaDirty: false,
    metaTimer: null
  };
  open.set(id, entry);
  return entry;
}

function applyToSummary(summary: SessionSummary, event: SessionEvent): void {
  const beforeContextTokens = summary.contextTokens;
  summary.events += 1;
  // Never backwards. A tool call is written once the app knows which chat it belongs to,
  // which can be after the page has already reported the end of the turn it ran in, and
  // the call carries the time it started. Taking that literally would age a session back
  // to before its own last event and drop it down a list sorted by recency.
  summary.updatedAt = Math.max(summary.updatedAt, event.time);
  const tokens = eventTokens(event);
  summary.estimatedTokens += tokens;
  // What the attached chat is carrying. Reset by a compaction rebind; see rebindSession.
  summary.contextTokens += tokens;
  updateAutoCompaction(summary, event, beforeContextTokens);
  if (event.kind === 'user_message') summary.userMessages += 1;
  if (event.kind === 'tool_call') {
    summary.toolCalls += 1;
    if (event.call.outcome === 'error') summary.errors += 1;
  }
  if (event.kind === 'chat_error') summary.errors += 1;
  if (event.kind === 'turn_end') summary.lastTurnOutcome = event.outcome;
  if (event.kind === 'handoff') {
    summary.lastHandoffId = event.handoffId;
    summary.lastHandoffAt = event.time;
  }
  if (event.agent && !summary.agents.includes(event.agent)) summary.agents.push(event.agent);
}

/**
 * Maintains the durable edge-trigger for automatic compaction.
 *
 * This deliberately lives beside `contextTokens`, not in the browser poller. Opening an old
 * chat at 350k therefore observes an already-high counter and does nothing; only a real
 * mutation that moves the current chat from below the configured threshold to at/above it
 * can arm the trigger. A polling gap can skip from 299k to 307k and still produces one edge.
 *
 * The edge is not immediately actionable. The exact turn that crossed the line must finish
 * successfully first. A final assistant revision is deliberately insufficient: only that
 * turn's `turn_end: completed` can make the one-shot trigger ready.
 */
function updateAutoCompaction(summary: SessionSummary, event: SessionEvent, beforeContextTokens: number): void {
  const config = getConfig().compaction;
  const threshold = config.autoTokens;

  // Keep the local lifecycle projection even while automatic compaction is disabled. If the
  // switch is enabled during a live turn, later events still have an exact turn to belong to.
  if (event.kind === 'turn_start' && event.turnId) summary.autoCompactActiveTurnId = event.turnId;

  const clearArm = (): void => {
    summary.autoCompactArmedAt = null;
    summary.autoCompactArmedSeq = null;
    summary.autoCompactTurnId = null;
    summary.autoCompactReadyAt = null;
  };
  const closeActiveTurn = (): void => {
    if (
      event.kind === 'turn_end' &&
      summary.autoCompactActiveTurnId !== null &&
      (!event.turnId || event.turnId === summary.autoCompactActiveTurnId)
    ) {
      summary.autoCompactActiveTurnId = null;
    }
  };

  if (!config.auto || threshold <= 0) {
    clearArm();
    summary.autoCompactThreshold = null;
    closeActiveTurn();
    return;
  }

  // A changed threshold starts a new baseline. Lowering the setting underneath an already
  // huge/stale chat is not a synthetic crossing and therefore never auto-compacts it.
  if (summary.autoCompactThreshold !== null && summary.autoCompactThreshold !== threshold) {
    summary.autoCompactThreshold = null;
    clearArm();
  }

  // A claim is terminal for this attached chat. Compact & Resume will rebind the durable
  // session and reset the latch; a failed/stopped automatic attempt is never retried here.
  if (summary.autoCompactTriggeredAt !== null) {
    closeActiveTurn();
    return;
  }

  // A user message is observed immediately before this content script announces turn_start.
  // Preserve that one adjacency so a large prompt can be the edge, but do not let a historical
  // message discovered while opening a stale chat sit around and arm some unrelated future turn.
  if (summary.autoCompactArmedAt !== null && summary.autoCompactTurnId === null) {
    const adjacent = summary.autoCompactArmedSeq !== null && event.seq === summary.autoCompactArmedSeq + 1;
    if (event.kind === 'turn_start' && event.turnId && adjacent) {
      summary.autoCompactTurnId = event.turnId;
    } else if (event.seq !== summary.autoCompactArmedSeq) {
      clearArm();
      summary.autoCompactThreshold = null;
    }
  }

  const crossed = beforeContextTokens < threshold && summary.contextTokens >= threshold;
  if (crossed) {
    const activeTurn = summary.autoCompactActiveTurnId;
    if (activeTurn && event.turnId === activeTurn) {
      summary.autoCompactThreshold = threshold;
      summary.autoCompactArmedAt = event.time;
      summary.autoCompactArmedSeq = event.seq;
      summary.autoCompactTurnId = activeTurn;
      summary.autoCompactReadyAt = null;
    } else if (event.kind === 'user_message') {
      // The extension records the just-sent user message before turn_start. Hold the edge for
      // exactly the next event; only that immediate turn_start may bind it to a generation.
      summary.autoCompactThreshold = threshold;
      summary.autoCompactArmedAt = event.time;
      summary.autoCompactArmedSeq = event.seq;
      summary.autoCompactTurnId = null;
      summary.autoCompactReadyAt = null;
    }
  }

  if (event.kind === 'turn_start' && summary.autoCompactTurnId && summary.autoCompactTurnId !== event.turnId) {
    clearArm();
    summary.autoCompactThreshold = null;
  }

  if (event.kind === 'turn_end' && summary.autoCompactTurnId && event.turnId === summary.autoCompactTurnId) {
    if (event.outcome === 'completed') summary.autoCompactReadyAt = event.time;
    // Final assistant snapshots are deliberately insufficient. Only the matching turn_end can
    // make an edge ready, so stopped/failed/interrupted turns can never leak a ready bit.
    summary.autoCompactArmedAt = null;
    summary.autoCompactArmedSeq = null;
    summary.autoCompactTurnId = null;
  } else if (
    // The crossing turn did not finish cleanly, and a counter that only grows can never cross
    // the same line a second time — so the edge above is a one-shot that a single interrupted
    // turn destroys forever. That is not a corner case: replaying a real 587-event session
    // through this function armed correctly at the crossing, lost the arm to `interrupted` on
    // that very turn, and then ran to 433k tokens against a 40k threshold without ever
    // becoming ready. Automatic compaction has never fired on this machine for that reason.
    //
    // So the edge stays spent-but-unconsumed (`autoCompactThreshold` still names it, nothing
    // is armed, nothing is ready, nothing is claimed) and the *next* turn to end cleanly makes
    // it ready. What that costs is only the delay; what it must not cost is the rule that keeps
    // old chats safe, so this still demands a turn that this log itself opened and is now
    // closing. Opening a stale finished chat replays no lifecycle, so it arms nothing, exactly
    // as before. And `autoCompactTriggeredAt` above still makes the whole thing once per chat.
    event.kind === 'turn_end' &&
    event.outcome === 'completed' &&
    summary.autoCompactThreshold === threshold &&
    summary.autoCompactTurnId === null &&
    summary.autoCompactReadyAt === null &&
    summary.contextTokens >= threshold &&
    summary.autoCompactActiveTurnId !== null &&
    (!event.turnId || event.turnId === summary.autoCompactActiveTurnId)
  ) {
    summary.autoCompactReadyAt = event.time;
  }

  closeActiveTurn();
}

/** Whether this session currently has one unconsumed, still-valid automatic trigger. */
export function autoCompactionReady(summary: SessionSummary | null | undefined): boolean {
  if (!summary || summary.autoCompactReadyAt === null || summary.autoCompactTriggeredAt !== null) return false;
  const config = getConfig().compaction;
  return config.auto && config.autoTokens > 0 && summary.autoCompactThreshold === config.autoTokens;
}

/**
 * Atomically consumes the one automatic trigger before the browser starts doing anything.
 *
 * Consumption is durable and happens before ChatGPT is stopped or prompted. If the browser
 * then disappears, the stop barrier fails, or the user cancels, reopening the same old chat
 * cannot replay the automatic trigger. A manual Compact & Resume is still always available.
 */
export async function claimAutoCompaction(sessionId: string, conversationId: string): Promise<boolean> {
  const entry = await ensureOpen(sessionId);
  const claim = entry.queue.then(async () => {
    if (entry.summary.conversationId !== conversationId || !autoCompactionReady(entry.summary)) return false;
    const staged: SessionSummary = {
      ...entry.summary,
      autoCompactArmedAt: null,
      autoCompactArmedSeq: null,
      autoCompactTurnId: null,
      autoCompactReadyAt: null,
      autoCompactTriggeredAt: Date.now()
    };
    await writeSummary(staged);
    Object.assign(entry.summary, staged);
    entry.metaDirty = false;
    return true;
  });
  entry.queue = claim.then(
    () => undefined,
    (err: Error) => logError(`automatic compaction claim failed: ${err.message}`)
  );
  return claim;
}

/**
 * Appends one event and returns it with its assigned sequence number.
 *
 * The sequence number, not the timestamp, defines order: the extension and the MCP
 * server both feed this store and their clocks are the same clock, but events can
 * arrive out of order when the browser batches its observations.
 */
export function appendEvent(sessionId: string, event: NewSessionEvent): Promise<SessionEvent> {
  return ensureOpen(sessionId).then((entry) => {
    // Sequence assignment, durable append and projection update are one serial operation.
    // The previous implementation incremented nextSeq and mutated the summary *before* the
    // append succeeded. A disk failure therefore created a permanent seq gap and could even
    // persist meta.json claiming events/tool calls/tokens that never existed in events.jsonl.
    // Keep the append-only journal authoritative: nothing in memory advances until the line
    // is on disk.
    const write = entry.queue.then(async () => {
      const full = { ...event, seq: entry.nextSeq } as SessionEvent;
      const line = `${JSON.stringify(full)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        throw new Error('Session event is too large to store');
      }
      await fs.appendFile(path.join(sessionDir(sessionId), 'events.jsonl'), line, 'utf8');
      entry.nextSeq += 1;
      entry.tail.push(full);
      if (entry.tail.length > MAX_EVENT_TAIL) entry.tail.splice(0, entry.tail.length - MAX_EVENT_TAIL);
      applyToSummary(entry.summary, full);
      scheduleMeta(entry);
      return full;
    });
    entry.queue = write.then(
      () => undefined,
      (err: Error) => {
        logError(`session append failed: ${err.message}`);
      }
    );
    return write;
  });
}

/**
 * Creates or revises one canonical ChatGPT message by its own stable id.
 *
 * `seq` is the revision/cursor sequence so an incremental reader notices an update. `origin`
 * preserves the sequence/time position where that stable website message first appeared, so
 * revisions cannot move either a user response boundary or assistant prose through later work.
 */
export function upsertMessageEvent(
  sessionId: string,
  event: NewMessageEvent
): Promise<{ event: MessageEvent; changed: boolean }> {
  const directKey = messageKey(event as MessageEvent);
  if (!directKey) throw new Error('Canonical message update requires ChatGPT messageId');
  return ensureOpen(sessionId).then((entry) => {
    const write = entry.queue.then(async () => {
      const key = directKey;
      const previous = entry.messages.get(key);
      // Final is terminal for one canonical ChatGPT message. The page can briefly re-report
      // an older streaming DOM snapshot after settling/remounting; accepting that snapshot
      // would turn a completed answer back into a partial one and could replace its text.
      if (
        previous?.kind === 'assistant_message' &&
        event.kind === 'assistant_message' &&
        (previous.final === true || previous.state === 'final') &&
        event.final !== true &&
        event.state !== 'final'
      ) {
        return { event: previous, changed: false };
      }

      const nextEvent: NewMessageEvent =
        previous?.kind === 'assistant_message' && event.kind === 'assistant_message'
          ? {
              ...event,
              // The producer already supplied the stable website identity. Keep that exact
              // identity through every revision; a different id is a different logical row.
              messageId: previous.messageId,
              // `final` is a compatibility mirror of state, not an independent truth.
              state: event.state === 'final' || event.final === true ? 'final' : 'streaming',
              final: event.state === 'final' || event.final === true,
              // A sparse re-observation of the same prose must not throw away the richer
              // representation we already captured. If the prose itself changed, omitting
              // HTML deliberately falls back to the new plain text instead of showing stale
              // markup for different content.
              ...(event.renderedHtml === undefined && JSON.stringify(previous.message) === JSON.stringify(event.message)
                ? { renderedHtml: previous.renderedHtml }
                : {})
            }
          : event;
      if (
        previous &&
        previous.kind === nextEvent.kind &&
        JSON.stringify(previous.message) === JSON.stringify(nextEvent.message) &&
        (previous.kind !== 'assistant_message' ||
          (nextEvent.kind === 'assistant_message' &&
            JSON.stringify(previous.renderedHtml ?? null) === JSON.stringify(nextEvent.renderedHtml ?? null) &&
            previous.state === nextEvent.state &&
            previous.final === nextEvent.final)) &&
        (nextEvent.turnId === undefined || previous.turnId === nextEvent.turnId) &&
        (nextEvent.agent === undefined || previous.agent === nextEvent.agent)
      ) {
        return { event: previous, changed: false };
      }
      const full = {
        ...nextEvent,
        // First appearance is chronology; current seq is delivery cursor/revision.
        time: previous?.time ?? nextEvent.time,
        ...(previous?.turnId && !nextEvent.turnId ? { turnId: previous.turnId } : {}),
        ...(previous?.agent && !nextEvent.agent ? { agent: previous.agent } : {}),
        ...(nextEvent.kind === 'assistant_message' || nextEvent.kind === 'user_message'
          ? { origin: previous?.kind === nextEvent.kind ? previous.origin ?? previous.seq : entry.nextSeq }
          : {}),
        seq: entry.nextSeq
      } as MessageEvent;

      const staged = new Map(entry.messages);
      staged.set(key, full);
      await writeCanonicalMessages(sessionId, staged);

      entry.nextSeq += 1;
      entry.messages = staged;
      if (!previous) {
        applyToSummary(entry.summary, full);
      } else {
        // A revision is not another logical event. Only its text/token weight and recency
        // replace what the previous snapshot contributed to the session projection.
        const beforeContextTokens = entry.summary.contextTokens;
        const delta = eventTokens(full) - eventTokens(previous);
        entry.summary.estimatedTokens = Math.max(0, entry.summary.estimatedTokens + delta);
        entry.summary.contextTokens = Math.max(0, entry.summary.contextTokens + delta);
        updateAutoCompaction(entry.summary, full, beforeContextTokens);
        entry.summary.updatedAt = Math.max(entry.summary.updatedAt, nextEvent.time);
        if (full.agent && !entry.summary.agents.includes(full.agent)) entry.summary.agents.push(full.agent);
      }
      scheduleMeta(entry);
      return { event: full, changed: true };
    });
    entry.queue = write.then(
      () => undefined,
      (err: Error) => logError(`session message upsert failed: ${err.message}`)
    );
    return write;
  });
}

// ------------------------------------------------------------------- read

export interface ReadOptions {
  /** First sequence number to return, inclusive. */
  from?: number;
  limit?: number;
  kinds?: readonly SessionEvent['kind'][];
  agent?: string;
}

/**
 * Reads events back.
 *
 * A malformed line is skipped and counted rather than throwing: the whole point of
 * an append-only log is that a half-written final line costs one event, not the
 * session. Reading the file in one go is fine at the sizes the caps allow.
 */
export async function readEvents(sessionId: string, options: ReadOptions = {}): Promise<SessionEvent[]> {
  assertSessionId(sessionId);
  await flushSessions();
  const from = options.from ?? 0;
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

  // /activity is an incremental feed. Canonical messages use their latest revision seq for
  // the cursor while preserving their first-appearance time/origin for chronology.
  const active = open.get(sessionId);
  if (options.from !== undefined && active) {
    if (from >= active.nextSeq) return [];
    const cacheFloor = Math.max(1, active.nextSeq - MAX_EVENT_TAIL);
    if (from >= cacheFloor) {
      const cached: SessionEvent[] = [...active.tail, ...active.messages.values()].filter((parsed) => {
        if (parsed.seq < from) return false;
        if (options.kinds && !options.kinds.includes(parsed.kind)) return false;
        if (options.agent && parsed.agent !== options.agent) return false;
        return true;
      });
      return chronological(cached).slice(0, limit);
    }
  }
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') raw = '';
    else throw err;
  }
  const messages = active?.messages ?? (await readCanonicalMessages(sessionId));
  const canonicalKeys = new Set(messages.keys());
  const out: SessionEvent[] = [];
  let damaged = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line) as SessionEvent;
    } catch {
      damaged++;
      continue;
    }
    if (typeof parsed?.seq !== 'number' || typeof parsed?.kind !== 'string') {
      damaged++;
      continue;
    }
    if (parsed.seq < from) continue;
    if (options.kinds && !options.kinds.includes(parsed.kind)) continue;
    if (options.agent && parsed.agent !== options.agent) continue;
    // Once a message has a canonical record, a pre-1.8 append-only snapshot with the same
    // ChatGPT identity is legacy journal history, not another transcript item.
    if ((parsed.kind === 'user_message' || parsed.kind === 'assistant_message') && messageKey(parsed) && canonicalKeys.has(messageKey(parsed)!)) {
      continue;
    }
    out.push(parsed);
  }
  for (const message of messages.values()) {
    if (message.seq < from) continue;
    if (options.kinds && !options.kinds.includes(message.kind)) continue;
    if (options.agent && message.agent !== options.agent) continue;
    out.push(message);
  }
  if (damaged > 0) logWarn(`session ${sessionId}: skipped ${damaged} unreadable event line(s)`);
  // `seq` is the immutable cursor domain; logical chronology is only allowed to reorder a
  // bounded turn whose `turn_start` is present in this read window. Global time sorting used
  // to move unrelated/replayed page history across turn boundaries and disagreed with the
  // extension renderer, which already used the shared rule. One function now defines the
  // transcript order everywhere.
  return chronological(out).slice(0, limit);
}

/**
 * Atomically keeps only the supplied tool calls in an Unattributed activity session.
 *
 * This is deliberately not a general history editor. 1.8.2 uses it for one deterministic
 * migration: calls whose exact request-id owner is now known are copied to that owner's
 * session, then removed from the legacy Unattributed bucket. Unknown calls remain under the
 * same local session id. Re-sequencing is safe here because this bucket has no ChatGPT
 * conversation, canonical messages, or turn lifecycle: it is only a holding area for calls.
 */
export async function rewriteUnattributedToolCalls(
  sessionId: string,
  calls: readonly Extract<SessionEvent, { kind: 'tool_call' }>[]
): Promise<void> {
  assertSessionId(sessionId);
  const entry = await ensureOpen(sessionId);
  const rewrite = entry.queue.then(async () => {
    if (entry.summary.conversationId !== null || entry.summary.title !== 'Unattributed activity') {
      throw new Error(`Session ${sessionId} is not an Unattributed activity bucket`);
    }

    const start: SessionEvent = {
      seq: 1,
      time: entry.summary.startedAt,
      source: 'app',
      kind: 'session_start',
      conversationId: null,
      title: entry.summary.title
    };
    const kept: SessionEvent[] = [start, ...calls.map((event, index) => ({ ...event, seq: index + 2 }))];

    const target = path.join(sessionDir(sessionId), 'events.jsonl');
    const tmp = `${target}.repair-${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(tmp, kept.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
    await fs.rename(tmp, target);

    const staged: SessionSummary = {
      ...entry.summary,
      updatedAt: entry.summary.startedAt,
      events: 0,
      userMessages: 0,
      toolCalls: 0,
      errors: 0,
      estimatedTokens: 0,
      contextTokens: 0,
      autoCompactThreshold: null,
      autoCompactActiveTurnId: null,
      autoCompactArmedSeq: null,
      autoCompactTurnId: null,
      autoCompactArmedAt: null,
      autoCompactReadyAt: null,
      autoCompactTriggeredAt: null,
      lastHandoffId: null,
      lastHandoffAt: null,
      lastTurnOutcome: null,
      agents: []
    };
    for (const event of kept) applyToSummary(staged, event);
    await writeSummary(staged);

    Object.assign(entry.summary, staged);
    entry.nextSeq = kept.length + 1;
    entry.tail = kept.slice(-MAX_EVENT_TAIL);
    entry.metaDirty = false;
  });
  entry.queue = rewrite.then(
    () => undefined,
    (err: Error) => logError(`session unattributed repair failed: ${err.message}`)
  );
  await rewrite;
}

async function readMeta(id: string): Promise<SessionSummary | null> {
  try {
    const raw = await fs.readFile(path.join(sessionDir(id), 'meta.json'), 'utf8');
    const parsed = JSON.parse(raw) as SessionSummary;
    if (typeof parsed?.id !== 'string') return null;
    // A meta.json written before agents, app-opened chats or the session lineage existed
    // has no such field. A session recorded before the lineage was a single chat by
    // definition, and everything it holds was in that chat's context, so both defaults are
    // the truth rather than a placeholder.
    return {
      ...parsed,
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      origin: parsed.origin ?? null,
      chatIds: Array.isArray(parsed.chatIds)
        ? parsed.chatIds
        : parsed.conversationId
          ? [parsed.conversationId]
          : [],
      contextTokens: typeof parsed.contextTokens === 'number' ? parsed.contextTokens : parsed.estimatedTokens,
      autoCompactThreshold: typeof parsed.autoCompactThreshold === 'number' ? parsed.autoCompactThreshold : null,
      autoCompactActiveTurnId: typeof parsed.autoCompactActiveTurnId === 'string' ? parsed.autoCompactActiveTurnId : null,
      autoCompactArmedSeq: typeof parsed.autoCompactArmedSeq === 'number' ? parsed.autoCompactArmedSeq : null,
      autoCompactTurnId: typeof parsed.autoCompactTurnId === 'string' ? parsed.autoCompactTurnId : null,
      autoCompactArmedAt: typeof parsed.autoCompactArmedAt === 'number' ? parsed.autoCompactArmedAt : null,
      autoCompactReadyAt: typeof parsed.autoCompactReadyAt === 'number' ? parsed.autoCompactReadyAt : null,
      autoCompactTriggeredAt: typeof parsed.autoCompactTriggeredAt === 'number' ? parsed.autoCompactTriggeredAt : null
    };
  } catch {
    return null;
  }
}

/**
 * Every readable session, newest first. Live summaries win over what is on disk.
 *
 * The whole directory is enumerated before anything is sorted or capped. Slicing an
 * arbitrary readdir order first — which is what this used to do — meant that past a
 * few hundred sessions the newest handoff could simply fall outside the window, so
 * "resume the last session" would resume some other one, and pruning would spare the
 * wrong folders. Reading a few hundred small meta.json files is cheap next to that.
 */
async function readAllSummaries(): Promise<SessionSummary[]> {
  assertReady();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  let scanned = 0;
  for (const name of names) {
    if (!/^[0-9a-z-]{8,64}$/i.test(name)) continue;
    if (++scanned > MAX_SCANNED_SESSIONS) {
      logWarn(`session store: more than ${MAX_SCANNED_SESSIONS} session folders; older ones were not scanned`);
      break;
    }
    const live = open.get(name);
    const summary = live ? live.summary : await readMeta(name);
    if (summary) summaries.push({ ...summary });
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/** Newest first, capped for the UI. */
export async function listSessions(): Promise<SessionSummary[]> {
  return (await readAllSummaries()).slice(0, MAX_LISTED_SESSIONS);
}

/** Full bounded maintenance view. Never use this directly for UI payloads. */
export async function listAllSessions(): Promise<SessionSummary[]> {
  return readAllSummaries();
}

/**
 * Finds the durable session that owns one ChatGPT conversation id.
 *
 * `listSessions()` is intentionally capped for the UI and therefore must never be used as an
 * ownership index: once a chat falls outside the newest 200, doing so silently turns "not in
 * the list" into "never existed" and can fork a second session for the same conversation.
 *
 * Page/browser reopen paths use the default current-only lookup. A proven late MCP request may
 * opt into `includeHistorical` so a conversation that was superseded by Compact & Resume still
 * resolves to the durable session whose `chatIds` lineage contains it. Ambiguity fails closed.
 */
export async function findSessionByConversation(
  conversationId: string,
  options: { includeHistorical?: boolean; requireUnique?: boolean } = {}
): Promise<SessionSummary | null> {
  if (!conversationId) return null;
  const all = await readAllSummaries();
  const current = all.filter((summary) => summary.conversationId === conversationId);
  if (current.length === 1) return current[0] ?? null;
  if (current.length > 1) {
    if (options.requireUnique === true) {
      logWarn(`session store: conversation ${conversationId} is current on ${current.length} sessions; refusing safety-sensitive lookup`);
      return null;
    }
    // Browser/page reopen semantics historically used the newest current session. Keep that
    // deterministic choice rather than manufacturing a third session. Safety-sensitive
    // callers (orphan retirement) opt into requireUnique above.
    return current[0] ?? null;
  }
  if (options.includeHistorical !== true) return null;
  const historical = all.filter((summary) => summary.chatIds.includes(conversationId));
  if (historical.length === 1) return historical[0] ?? null;
  if (historical.length > 1) {
    logWarn(`session store: conversation ${conversationId} appears in ${historical.length} session lineages; refusing to guess`);
  }
  return null;
}

/**
 * Filesystem time of the newest durable mutation belonging to a session.
 *
 * Session event timestamps describe when an action happened, not when it finally reached
 * disk. A five-minute MCP call therefore appends today with a `startedAt` from five minutes
 * ago. Stale/orphan cleanup must not look only at that semantic clock and immediately retire
 * work that was just written. The max mtime of the three mutable session projections is the
 * durable inactivity clock it needs.
 */
export async function sessionDurableModifiedAt(id: string): Promise<number | null> {
  assertSessionId(id);
  let newest = 0;
  for (const name of ['events.jsonl', 'messages.json', 'meta.json']) {
    try {
      const stat = await fs.stat(path.join(sessionDir(id), name));
      newest = Math.max(newest, stat.mtimeMs);
    } catch {
      // A session can legitimately predate messages.json or have no structured events yet.
    }
  }
  return newest > 0 ? newest : null;
}

export async function getSession(id: string): Promise<SessionSummary | null> {
  assertSessionId(id);
  const live = open.get(id);
  if (live) return { ...live.summary };
  return readMeta(id);
}

export async function endSession(id: string): Promise<void> {
  const entry = open.get(id);
  if (!entry) return;
  entry.summary.endedAt = Date.now();
  await entry.queue.catch(() => undefined);
  await writeMeta(entry);
  open.delete(id);
}

/**
 * Marks a session live again.
 *
 * Closing a ChatGPT tab ends its session, and reopening the same conversation
 * continues it — deliberately, so a chat is one history rather than a fragment per
 * visit. Without this the reopened session kept the `endedAt` from the close, and
 * everything after it was appended to a session the UI still drew as finished.
 */
export async function reopenSession(id: string): Promise<void> {
  const entry = await ensureOpen(id);
  if (entry.summary.endedAt === null) return;
  entry.summary.endedAt = null;
  // Reopening a genuinely closed tab starts a new browser lifetime for this conversation.
  // An unclaimed threshold edge from the old lifetime must not spring days later merely
  // because somebody opened the stale chat again. A same-tab reload never reaches here:
  // background.js keeps that conversation open across document reloads.
  entry.summary.autoCompactActiveTurnId = null;
  entry.summary.autoCompactThreshold = null;
  entry.summary.autoCompactTurnId = null;
  entry.summary.autoCompactArmedAt = null;
  entry.summary.autoCompactArmedSeq = null;
  entry.summary.autoCompactReadyAt = null;
  entry.summary.updatedAt = Date.now();
  await writeMeta(entry);
}

export async function renameSession(id: string, title: string): Promise<void> {
  const entry = await ensureOpen(id);
  entry.summary.title = title.slice(0, 120);
  await writeMeta(entry);
}

/**
 * Records that this app opened the chat, and names the session accordingly.
 *
 * One write rather than a rename followed by a stamp, because the two are the same
 * fact: the origin is where the name came from, and a session that carried one without
 * the other would either show the bootstrap prompt as its name or claim a role the
 * name contradicts.
 */
export async function setSessionOrigin(id: string, origin: SessionOrigin, title: string): Promise<void> {
  const entry = await ensureOpen(id);
  entry.summary.origin = origin;
  entry.summary.title = title.slice(0, 120);
  await writeMeta(entry);
}

/**
 * Attaches this durable session to a different ChatGPT conversation.
 *
 * The single canonical session-transfer primitive: Compact & Resume does not create a
 * second session and copy state into it, it moves the one session's frontend from chat A
 * to chat B. Everything the session owns — its recorded history, its title, its origin, its
 * handoffs, and by extension the workspace and swarm binding keyed off it — follows for
 * free, precisely because none of it was ever keyed on the ChatGPT conversation.
 *
 * `contextTokens` is the one figure that resets, and it is not an exception to that rule:
 * it measures what the *attached chat* is carrying, and chat B is carrying only the
 * handoff. `estimatedTokens` keeps counting the session's whole life.
 *
 * Refuses rather than guesses when the session is not attached where the caller thinks it
 * is. That check is what makes the commit safe to retry and impossible to apply twice.
 *
 * ## Commit on success, never before
 *
 * The move is staged on a *clone* and only published into the live summary once the durable
 * write has actually landed. Mutating the live summary first and writing afterwards looked
 * equivalent and was not: a failed `writeMeta` returned false while memory already said
 * chat B, and the next scheduled flush then wrote that state to disk anyway — so a commit
 * that reported failure completed itself a second later. The requirement is absolute in the
 * other direction: a failed A→B commit leaves the session attached to A, in memory and on
 * disk alike. Publishing is a field-by-field copy into the existing object, because callers
 * hold that reference.
 */
export async function rebindSession(
  id: string,
  fromConversationId: string,
  toConversationId: string
): Promise<boolean> {
  if (!toConversationId || fromConversationId === toConversationId) return false;
  const entry = await ensureOpen(id);
  if (entry.summary.conversationId !== fromConversationId) return false;

  const staged: SessionSummary = {
    ...entry.summary,
    conversationId: toConversationId,
    chatIds: entry.summary.chatIds.includes(toConversationId)
      ? [...entry.summary.chatIds]
      : [...entry.summary.chatIds, toConversationId],
    contextTokens: 0,
    autoCompactThreshold: null,
    autoCompactActiveTurnId: null,
    autoCompactArmedSeq: null,
    autoCompactTurnId: null,
    autoCompactArmedAt: null,
    autoCompactReadyAt: null,
    autoCompactTriggeredAt: null,
    updatedAt: Date.now(),
    // A session whose chat was closed during the handover is live again the moment its new
    // chat is attached; leaving `endedAt` set would draw a visibly growing session as over.
    endedAt: null
  };

  // Any queued append must be on disk before the meta that describes it, or a crash between
  // the two leaves a summary claiming events the log does not have.
  await entry.queue.catch(() => undefined);
  try {
    await writeSummary(staged);
  } catch (err) {
    logWarn(`session ${id} could not be moved to ${toConversationId}: ${(err as Error).message}`);
    return false;
  }

  // Past this point nothing can fail: the durable record already says chat B.
  Object.assign(entry.summary, staged);
  entry.metaDirty = false;
  logInfo(`session ${id} moved from ChatGPT conversation ${fromConversationId} to ${toConversationId}`);
  return true;
}

// ----------------------------------------------------------------- assets

/**
 * Stores a binary beside the log and returns a reference.
 *
 * Content-addressed, so a screenshot taken twice costs one file. This is the whole
 * reason the log stays readable: a 300 KB PNG never becomes a 400 KB base64 string
 * inside a line that a summary pass then has to skip over.
 */
export async function writeAsset(
  sessionId: string,
  data: Buffer,
  mimeType: string
): Promise<AssetRef> {
  assertSessionId(sessionId);
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 32);
  const extension =
    mimeType === 'image/png'
      ? '.png'
      : mimeType === 'image/jpeg'
        ? '.jpg'
        : mimeType === 'text/plain'
          ? '.txt'
          : '.bin';
  const id = `${hash}${extension}`;
  const dir = path.join(sessionDir(sessionId), 'assets');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, id);
  try {
    await fs.writeFile(target, data, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return { id, mimeType, bytes: data.length };
}

export async function readAsset(sessionId: string, assetId: string): Promise<Buffer | null> {
  assertSessionId(sessionId);
  if (!/^[0-9a-f]{8,64}\.(png|jpg|txt|bin)$/.test(assetId)) return null;
  try {
    return await fs.readFile(path.join(sessionDir(sessionId), 'assets', assetId));
  } catch {
    return null;
  }
}

/**
 * Stores text too long to sit inline, and returns the reference to put in the event.
 *
 * Content-addressed like any other asset, so a command run twice with the same enormous
 * output costs one file. Returns null only when the text is beyond even this — at which
 * point the event says so rather than pretending the record is complete.
 */
export async function writeOverflowText(sessionId: string, text: string): Promise<string | null> {
  if (text.length > MAX_OVERFLOW_ASSET_CHARS) return null;
  try {
    const asset = await writeAsset(sessionId, Buffer.from(text, 'utf8'), 'text/plain');
    return asset.id;
  } catch (err) {
    logWarn(`session ${sessionId}: overflow text not stored: ${(err as Error).message}`);
    return null;
  }
}

/** Reads back text spilled by writeOverflowText. */
export async function readOverflowText(sessionId: string, assetId: string): Promise<string | null> {
  const data = await readAsset(sessionId, assetId);
  return data ? data.toString('utf8') : null;
}

// --------------------------------------------------------------- handoffs

export async function saveHandoff(handoff: Handoff): Promise<void> {
  assertSessionId(handoff.sessionId);
  const dir = path.join(sessionDir(handoff.sessionId), 'handoffs');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${handoff.id}.json`);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(handoff, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

export async function readHandoff(sessionId: string, handoffId: string): Promise<Handoff | null> {
  assertSessionId(sessionId);
  if (!/^[0-9a-z-]{8,64}$/i.test(handoffId)) return null;
  try {
    const raw = await fs.readFile(path.join(sessionDir(sessionId), 'handoffs', `${handoffId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as Handoff;
    return typeof parsed?.text === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The newest handoff across every session — what a fresh chat asks for by default.
 *
 * Deliberately over every session rather than the capped UI list: the point of "the last
 * handoff" is that it is the last one, and "unless you happen to have more than two
 * hundred sessions" is not a property worth shipping.
 */
export async function latestHandoff(): Promise<Handoff | null> {
  const sessions = await readAllSummaries();
  let best: Handoff | null = null;
  for (const summary of sessions) {
    if (!summary.lastHandoffId) continue;
    const handoff = await readHandoff(summary.id, summary.lastHandoffId);
    if (handoff && (!best || handoff.createdAt > best.createdAt)) best = handoff;
  }
  return best;
}

// ------------------------------------------------------------------ prune

/**
 * Deletes sessions older than the retention window.
 *
 * A session that holds the newest handoff is kept regardless: deleting the thing a
 * fresh conversation is about to resume from would be the one unrecoverable mistake
 * this store can make.
 */
export async function pruneSessions(retainDays: number): Promise<number> {
  if (retainDays <= 0) return 0;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const sessions = await readAllSummaries();
  const newestHandoff = await latestHandoff();
  let removed = 0;
  for (const summary of sessions) {
    if (summary.updatedAt >= cutoff) continue;
    if (open.has(summary.id)) continue;
    if (newestHandoff && newestHandoff.sessionId === summary.id) continue;
    try {
      await fs.rm(sessionDir(summary.id), { recursive: true, force: true });
      removed++;
    } catch (err) {
      logWarn(`could not remove old session ${summary.id}: ${(err as Error).message}`);
    }
  }
  return removed;
}

export async function deleteSession(id: string): Promise<void> {
  assertSessionId(id);
  const entry = open.get(id);
  if (entry) {
    if (entry.metaTimer) clearTimeout(entry.metaTimer);
    await entry.queue.catch(() => undefined);
    open.delete(id);
  }
  await fs.rm(sessionDir(id), { recursive: true, force: true });
}

/** Test seam: forgets in-memory state without touching the files. */
export function resetSessionStoreForTests(): void {
  for (const entry of open.values()) if (entry.metaTimer) clearTimeout(entry.metaTimer);
  open.clear();
}

/** Test seam: puts the store back to never having been told where to write. */
export function unsetSessionRootForTests(): void {
  root = '';
}
