/**
 * Durable session history.
 *
 * Deliberately separate from the in-memory diagnostics log in logger.ts. That log
 * stays small, redacted and RAM-only; this one is an explicit opt-in feature that
 * writes what actually happened to disk so a five-hour session can be recovered.
 *
 * Storage is one append-only JSONL file per session. Appends are the only write, so a
 * crash can lose at most the final line, and reading skips a torn line instead of
 * failing. Screenshots and other binaries live beside the log as files, referenced by
 * id, rather than being inlined as base64 into a text record nobody can read.
 *
 *   sessions/<id>/events.jsonl    one JSON event per line, never rewritten
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
export const MAX_USER_MESSAGE_CHARS = 32_000;
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
  /** Serialises appends so two events can never interleave inside one line. */
  queue: Promise<void>;
  metaDirty: boolean;
  metaTimer: NodeJS.Timeout | null;
}

const open = new Map<string, OpenSession>();

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
  const entry: OpenSession = { summary, nextSeq: 1, queue: Promise.resolve(), metaDirty: false, metaTimer: null };
  open.set(id, entry);
  await fs.mkdir(sessionDir(id), { recursive: true });
  await fs.writeFile(path.join(sessionDir(id), 'events.jsonl'), '', { flag: 'a' });
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

async function ensureOpen(id: string): Promise<OpenSession> {
  assertSessionId(id);
  const existing = open.get(id);
  if (existing) return existing;
  await sealTornTail(id);
  const summary = (await readMeta(id)) ?? emptySummary(id, 'Recovered session', null);
  const entry: OpenSession = {
    summary,
    nextSeq: (await lastSeqOnDisk(id)) + 1,
    queue: Promise.resolve(),
    metaDirty: false,
    metaTimer: null
  };
  open.set(id, entry);
  return entry;
}

function applyToSummary(summary: SessionSummary, event: SessionEvent): void {
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
 * Appends one event and returns it with its assigned sequence number.
 *
 * The sequence number, not the timestamp, defines order: the extension and the MCP
 * server both feed this store and their clocks are the same clock, but events can
 * arrive out of order when the browser batches its observations.
 */
export function appendEvent(sessionId: string, event: NewSessionEvent): Promise<SessionEvent> {
  return ensureOpen(sessionId).then((entry) => {
    const full = { ...event, seq: entry.nextSeq++ } as SessionEvent;
    const line = `${JSON.stringify(full)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      // Nothing that reaches here should be this big; refuse rather than write a
      // record that the reader would then have to skip.
      return Promise.reject(new Error('Session event is too large to store'));
    }
    const write = entry.queue.then(() =>
      fs.appendFile(path.join(sessionDir(sessionId), 'events.jsonl'), line, 'utf8')
    );
    entry.queue = write.then(
      () => undefined,
      (err: Error) => {
        logError(`session append failed: ${err.message}`);
      }
    );
    applyToSummary(entry.summary, full);
    scheduleMeta(entry);
    return write.then(() => full);
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
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: SessionEvent[] = [];
  let damaged = 0;
  const from = options.from ?? 0;
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
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
    out.push(parsed);
    if (out.length >= limit) break;
  }
  if (damaged > 0) logWarn(`session ${sessionId}: skipped ${damaged} unreadable event line(s)`);
  // Stored in append order and handed back in the order things happened, which are no
  // longer the same thing. A tool call is written once the app has worked out which chat
  // it belongs to, and that can take a moment longer than the page takes to report the
  // answer the call fed into — so the file can hold the call after the reply, and reading
  // it back that way would show, in the timeline and in a compaction, a tool running after
  // the answer that depended on it. Every source stamps `time` from the same machine's
  // clock at the moment the thing happened, so that is the order; seq breaks ties and
  // keeps this stable. Paging is untouched: `from` and `limit` still work in seq, which is
  // what makes the cursor monotonic.
  // session_start is a marker rather than an observation, and a session cannot have begun
  // after its own contents: a batch journalled by the extension while the app was down
  // creates the session now and carries events from before that, which would otherwise
  // sort the opening line into the middle.
  const at = (event: SessionEvent): number => (event.kind === 'session_start' ? -Infinity : event.time);
  out.sort((left, right) => at(left) - at(right) || left.seq - right.seq);
  return out;
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
      contextTokens: typeof parsed.contextTokens === 'number' ? parsed.contextTokens : parsed.estimatedTokens
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
