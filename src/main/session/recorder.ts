/**
 * The bridge between what happens and what is stored.
 *
 * Two sources feed it. The MCP server reports every tool call with the exact
 * arguments it was given and the exact result it returned — that is authoritative and
 * needs no scraping. The Chrome extension reports what is visible in the ChatGPT page
 * — messages, progress lines, turn boundaries and errors — which is observation, not
 * truth, and is labelled as such.
 *
 * Attribution is the interesting part. A tool call arrives over HTTP with nothing
 * identifying which conversation made it, because ChatGPT's MCP transport does not
 * carry a session id at all. So the recorder uses what it can actually prove: if an
 * agent presented its capability key, the call belongs to that agent; else if exactly
 * one conversation has a turn in flight, it belongs to that one; otherwise it is
 * `inferred` and goes to a separate unattributed stream. It is never filed into
 * whichever chat happened to be busy most recently — with two conversations working at
 * once that quietly writes one chat's work into another chat's history, and there is
 * no way to tell afterwards which entries were real.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  ActivitySummary,
  AgentMessage,
  AssetRef,
  CallAttribution,
  SessionEvent,
  SessionOrigin,
  SessionSummary,
  StoredText,
  ToolCallRecord,
  ToolOutcome,
  TurnOutcome
} from '../../shared/session.js';
import { estimateTokens, originTitle } from '../../shared/session.js';
import { scrubAgentSecrets, scrubAgentSecretsDeep } from '../agent-secrets.js';
import { getConfig } from '../config.js';
import { logInfo, logWarn } from '../logger.js';
import { currentCall, emptyEvidence, type CallEvidence } from '../mcp/call-context.js';
import {
  MAX_MESSAGE_CHARS,
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_USER_MESSAGE_CHARS,
  appendEvent,
  createSession,
  endSession,
  getSession,
  listSessions,
  readEvents,
  reopenSession,
  setSessionOrigin,
  writeAsset,
  writeOverflowText
} from './store.js';
import { summarizeToolCall } from './summarize.js';

/** Assets stop being stored past this much per session; metadata still is. */
const MAX_SESSION_ASSET_BYTES = 192 * 1024 * 1024;
/** Nothing bigger than this is worth keeping as a session asset. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

interface LiveConversation {
  conversationId: string;
  sessionId: string;
  /** Set while ChatGPT is generating, so a tool call can be attributed to it. */
  turnStartedAt: number | null;
  turnId: string | null;
  /**
   * Whether the page currently shows direct generation evidence (the stop control).
   *
   * The turn may remain open while that control flickers away, so this is deliberately
   * separate from turnStartedAt. Weak sole-generation attribution may only use the direct
   * signal; strong per-call/page evidence may still attach work to the open turn while the
   * signal is absent.
   */
  generationVisible: boolean;
  lastSeen: number;
  /**
   * ChatGPT message ids already stored for this session, and what each one said.
   *
   * Reloading the tab makes the extension report the whole visible conversation
   * again, which is what backfills an older chat — but the same message must not
   * land twice, least of all a user message.
   *
   * The *text* is held as well as the id, and that is not belt-and-braces: the current
   * ChatGPT renderer gives streaming assistant prose no `data-message-id` at all, so the
   * extension names it after the turn it belongs to. Live, `data-turn-id` turned out to be
   * neither unique nor stable — the page reuses `request-<conversation>-0` for turn after
   * turn — so id-only de-duplication silently threw away nine of twelve assistant answers
   * in one recorded session: every later turn looked like the first one being replayed.
   * Comparing what was actually said keeps the reload case (identical text, dropped) while
   * letting a genuinely different answer through.
   *
   * Every pairing, not the latest one. A map of id → newest text remembers only the last
   * thing an id said, so a reload that walks a reused id's earlier answers again finds no
   * match and stores them a second time. What is being de-duplicated is the *(id, text)*
   * occurrence, so that is what is kept.
   */
  messageIds: Set<string>;
  /**
   * Turns this session's log started and has not ended.
   *
   * Only these may be closed by the reload-recovery path. A cold page reports a final
   * assistant message tagged with whatever turn id it can read, and those ids are reused
   * turn after turn, so trusting the id alone let a reload append a second completion for
   * a turn that ended long before. Seeded from the log at pickup, so it is right after an
   * app restart and not only for a page that stayed open.
   */
  openTurns: Set<string>;
  /** Highest tool-block count the page has reported for the turn in flight. */
  blocksSeen: number;
  /**
   * When this conversation rendered a tool block that no recorded call has claimed yet.
   *
   * The weaker of the two kinds of evidence about *where a tool call came from*: it says
   * that this page drew a connector row, not which connector or which tool. See
   * claimConversation.
   */
  sightings: number[];
  /**
   * The connector requests this conversation's own message model says it issued.
   *
   * Strictly better evidence than a row, and for the reason the rows failed: ChatGPT draws
   * one row for a run of calls and sometimes draws none at all, so counting rows undercounts
   * the calls a chat made and files the remainder outside it. The message model does not
   * collapse — every request is there, named. Keyed by ChatGPT's own message id, so a page
   * that reports the same turn again adds nothing. See claimNamedCall.
   */
  calls: Map<string, PageCall>;
  /**
   * The visible commentary items of this conversation, by the page's identity for each.
   *
   * One entry per caption block, holding the text already written and the seq it was
   * written at. ChatGPT redraws those blocks constantly; without this the recorder wrote a
   * fresh event for every redraw and the same sentence ended up stored, and drawn, many
   * times over.
   */
  progress: Map<string, ProgressRecord>;
  /**
   * The visible ChatGPT-native activity rows of this conversation, by the page's identity.
   *
   * Same shape and same reason as `progress`: a row's label is rewritten in place as the
   * step completes, and without an identity to grow, each rewrite became another row.
   */
  pageTools: Map<string, ProgressRecord>;
  /**
   * Page identities that turned out to name a caption this conversation already holds.
   *
   * ChatGPT re-stamps a caption mid-turn: it mounts the sentence as an assistant markdown
   * block (`…#a0`), then wraps that block in its reasoning container and rebuilds the node,
   * so the next tick reports the same growing sentence under a commentary stamp (`…#p0`).
   * `adoptedProseId` only rescues the case where the original stamped node survives inside
   * the wrapper; when React replaces it there is nothing left to inherit from, and the one
   * sentence was recorded — and drawn — twice, the first copy frozen at whatever prefix it
   * had reached. Identity here is therefore also derived from the text: a snapshot that
   * begins with the whole of the caption this turn is currently growing *is* that caption,
   * whatever the page now calls it, and the new stamp is aliased to the original id for the
   * rest of the turn.
   */
  progressAlias: Map<string, string>;
}

/** One connector request the page reported, and whether a recorded call has taken it. */
interface PageCall {
  tool: string;
  /** Durable local generation this request was observed under. */
  turnId: string | null;
  /** When the page reported it, bounded to now, as with every other page timestamp. */
  at: number;
  order: number;
  claimed: boolean;
  /**
   * ChatGPT's own request id, and when ChatGPT says the request was created — as opposed to
   * `at`, which is only when the extension's poll happened to see it. The id is the join
   * that identifies this call outright; see joinByRequestId.
   */
  requestId?: string | null;
  issuedAt?: number | null;
  /**
   * The `startedAt` of the MCP call that took this request to prove its own caller.
   *
   * The identity path resolves *before* the call it identifies has been recorded, so
   * without this the same request would still be sitting there unclaimed for the next
   * concurrent caller to read as its own. A reservation is not a claim: the recorder still
   * files the call against this request afterwards, matching on the same `startedAt`, which
   * is what keeps a control call in its own chat's history rather than in the unattributed
   * stream.
   */
  reservedFor?: number;
}

interface ProgressRecord {
  /** Seq of the first record written for this item — where every reader positions it. */
  seq: number;
  /** And the time it was first seen, for the same reason. */
  time: number;
  text: string;
  /** The turn it belongs to, so a re-stamp is only ever matched within its own turn. */
  turnId?: string;
}

/**
 * How far apart two conversations' requests must be before arrival order can decide.
 *
 * Below this they are simultaneous as far as this app can tell, and the identity path
 * refuses rather than guessing which worker is which. See reserveNamedOrigin.
 */
const ORDER_MARGIN_MS = 1_000;

const conversations = new Map<string, LiveConversation>();
/**
 * conversationId → what this app opened that chat for, until the session exists.
 *
 * The extension reports the conversation it just typed a bootstrap into before the page
 * has told the app anything about that conversation, so the origin routinely arrives
 * first. Holding it here is what lets the session be named correctly at creation rather
 * than being created under the bootstrap prompt and renamed a moment later.
 */
const pendingOrigins = new Map<string, SessionOrigin>();
const MAX_PENDING_ORIGINS = 50;
const assetBytes = new Map<string, number>();
/**
 * Where calls go when nothing identifies the conversation that made them.
 *
 * Two situations land here and both are honest: no ChatGPT tab is open at all, so no
 * conversation is known; or several are open and none can be proven. Picking between
 * several open chats would read as certainty in the UI and in a compaction while being
 * a coin flip, so it is not done.
 *
 * What used to land here as well was every call made while the *one* open chat happened
 * not to be visibly generating — a window that opens on every turn, because a tool call
 * can reach the app before the page's next observation does. An hour of work then split
 * itself across a growing pile of "Unattributed activity" sessions while the real chat
 * sat there apparently finished. That case is now filed into the one open conversation
 * and still labelled `inferred`, so the record is complete and the guess is still marked
 * as one. See pickTarget().
 */
let unattributedSessionId: string | null = null;
let lastActiveSessionId: string | null = null;

/**
 * How long a session must have been closed before its return is worth a log line.
 *
 * Reloads, back/forward-cache round-trips and short disconnects all close and reopen a
 * session; only an absence long enough that the user might have gone and done something
 * else is news. The reopen itself always happens — this is purely about what is said.
 */
const REOPEN_NOTICE_MS = 60_000;

const listeners = new Set<() => void>();
let notifyTimer: NodeJS.Timeout | null = null;

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyChanged(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const listener of listeners) listener();
  }, 400);
  notifyTimer.unref?.();
}

export function recordingEnabled(): boolean {
  return getConfig().sessions.record;
}

// ------------------------------------------------------------- sessions

/** The session a conversation writes to, created on first sight. */
export async function sessionForConversation(
  conversationId: string | null,
  title?: string
): Promise<string | null> {
  if (!recordingEnabled()) return null;
  if (!conversationId) return ensureUnattributedSession();
  const existing = conversations.get(conversationId);
  if (existing) {
    existing.lastSeen = Date.now();
    lastActiveSessionId = existing.sessionId;
    if (pendingOrigins.has(conversationId)) await applyOrigin(existing.sessionId, conversationId);
    return existing.sessionId;
  }
  // Reuse a session already recorded for this conversation, so closing and reopening
  // the tab continues the same history instead of fragmenting it.
  const known = (await listSessions()).find((entry) => entry.conversationId === conversationId);
  // A chat this app opened is named for the command that opened it. The alternative —
  // the first thing said in the chat — is this app's own bootstrap prompt.
  const origin = pendingOrigins.get(conversationId) ?? null;
  const summary =
    known ??
    (await createSession({
      conversationId,
      title: origin ? await titleForOrigin(origin) : title,
      origin
    }));
  if (origin && !known) pendingOrigins.delete(conversationId);
  // Reopening a chat that was closed earlier makes its session live again. Appending
  // to a session still stamped with an end time left the UI showing a finished session
  // that was visibly still growing.
  if (known && known.endedAt !== null) {
    const closedFor = Date.now() - known.endedAt;
    await reopenSession(known.id).catch(() => undefined);
    // Only worth saying when the session was actually away. A reload, a bfcache
    // round-trip or a brief disconnect closes and reopens within seconds and changes
    // nothing the user could act on; announcing each one filled the Activity log with
    // ten identical lines in seventy seconds across five tabs.
    if (closedFor >= REOPEN_NOTICE_MS) {
      logInfo(`session ${known.id} reopened — its ChatGPT conversation is active again`);
    }
  }
  const history = known ? await storedHistory(summary.id) : { messageIds: new Set<string>(), openTurns: new Set<string>() };
  conversations.set(conversationId, {
    conversationId,
    sessionId: summary.id,
    turnStartedAt: null,
    turnId: null,
    generationVisible: false,
    lastSeen: Date.now(),
    messageIds: history.messageIds,
    openTurns: history.openTurns,
    blocksSeen: 0,
    sightings: [],
    calls: new Map(),
    progress: new Map(),
    pageTools: new Map(),
    progressAlias: new Map()
  });
  if (!known) {
    await appendEvent(summary.id, {
      time: Date.now(),
      source: 'extension',
      kind: 'session_start',
      conversationId,
      title: summary.title
    });
    logInfo(`session started for a ChatGPT conversation (${summary.id})`);
  }
  if (origin && known) await applyOrigin(summary.id, conversationId);
  lastActiveSessionId = summary.id;
  notifyChanged();
  return summary.id;
}

/**
 * Records that this app opened a chat, so the session can be named for the work rather
 * than for the bootstrap prompt.
 *
 * Called from the bridge the moment the extension acknowledges having typed a command
 * into a fresh tab — the only point at which the queued command and the conversation it
 * became are both known.
 */
export async function noteChatOrigin(conversationId: string, origin: SessionOrigin): Promise<void> {
  if (!conversationId) return;
  pendingOrigins.set(conversationId, origin);
  while (pendingOrigins.size > MAX_PENDING_ORIGINS) {
    const oldest = pendingOrigins.keys().next();
    if (oldest.done) break;
    pendingOrigins.delete(oldest.value);
  }
  if (!recordingEnabled()) return;
  const live = conversations.get(conversationId);
  const sessionId =
    live?.sessionId ??
    (await listSessions()).find((entry) => entry.conversationId === conversationId)?.id ??
    null;
  // No session yet is the common case: the ack beats the page's first observation.
  // sessionForConversation picks the origin up out of pendingOrigins when it creates one.
  if (sessionId) await applyOrigin(sessionId, conversationId);
}

/** The name for a chat this app opened, taking a resume's name from its source. */
async function titleForOrigin(origin: SessionOrigin): Promise<string> {
  const source = origin.fromSessionId ? await getSession(origin.fromSessionId) : null;
  return originTitle(origin, source?.title ?? null);
}

/** Stamps a pending origin onto an existing session, once. */
async function applyOrigin(sessionId: string, conversationId: string): Promise<void> {
  const origin = pendingOrigins.get(conversationId);
  if (!origin) return;
  pendingOrigins.delete(conversationId);
  const summary = await getSession(sessionId);
  // Already stamped: a worker's bootstrap can be acknowledged more than once, and a
  // second stamp would rename a session that has since become the user's to name.
  if (!summary || summary.origin) return;
  await setSessionOrigin(sessionId, origin, await titleForOrigin(origin)).catch((err: Error) =>
    logWarn(`could not name the ${origin.kind} session: ${err.message}`)
  );
  logInfo(`session ${sessionId} named for the ${origin.kind} chat this app opened`);
  notifyChanged();
}

/** What a session's own log already says, for a conversation being picked up again. */
interface StoredHistory {
  /** Every (id, text) occurrence already written, so a reload cannot store one twice. */
  messageIds: Set<string>;
  /** Turns this log started and never ended — the only ones a recovery may close. */
  openTurns: Set<string>;
}

/**
 * Reads what a session already contains.
 *
 * Read once when a conversation is picked up again, so both de-duplication and turn
 * recovery survive an app restart rather than only a page that was never reloaded.
 *
 * The open-turn ledger is what stops a reload from resurrecting a finished turn. A cold
 * page reports a final assistant message carrying whatever turn id the page has, and
 * those ids are reused; without knowing which turns this log actually left open, the
 * recovery path appended a second completion for a turn that had ended many turns ago.
 */
async function storedHistory(sessionId: string): Promise<StoredHistory> {
  const messageIds = new Set<string>();
  const openTurns = new Set<string>();
  try {
    const events = await readEvents(sessionId, {
      kinds: ['user_message', 'assistant_message', 'page_tool', 'turn_start', 'turn_end']
    });
    for (const event of events) {
      if (event.kind === 'user_message' || event.kind === 'assistant_message') {
        if (event.messageId) messageIds.add(occurrence(event.messageId, storedIdentity(event.message)));
      } else if (event.kind === 'page_tool' && event.messageId) {
        messageIds.add(occurrence(event.messageId, legacyIdentity(event.label)));
      } else if (event.kind === 'turn_start') {
        if (event.turnId) openTurns.add(event.turnId);
      } else if (event.kind === 'turn_end') {
        if (event.turnId) openTurns.delete(event.turnId);
      }
    }
  } catch (err) {
    logWarn(`could not read stored session history: ${(err as Error).message}`);
  }
  return { messageIds, openTurns };
}

/**
 * What one message said, as a value that can be compared with a stored copy of it.
 *
 * A digest of the whole text, and both halves of that matter. It has to be of the *whole*
 * text because a length and a bounded head cannot tell two answers apart that open the same
 * way — which is the exact shape this page produces, since it reuses a turn id and the
 * extension derives the message id from it. And it has to be a digest rather than the text
 * itself because the stored copy may be an elided one: a long answer is capped inline with
 * the remainder in an asset, so comparing stored strings called every long answer different
 * from itself on the next page load and stored it again.
 *
 * Secrets are scrubbed first, so this is an identity for what `storeText` will write.
 */
function textIdentity(text: string): string {
  return createHash('sha256')
    .update(scrubAgentSecrets((text ?? '').trim()))
    .digest('hex')
    .slice(0, 32);
}

/**
 * The same identity, recovered from an event already on disk.
 *
 * `digest` is written by `storeText`, so the identity survives both the inline cap and an
 * app restart — the case that duplicated every long answer, because the restored copy was
 * the truncated one and never matched the live text it was made from.
 *
 * Logs written before digests existed have none, and fall back to the identity those logs
 * were actually de-duplicated by when they were written.
 */
function storedIdentity(stored: StoredText): string {
  if (stored.digest) return stored.digest;
  return `legacy:${stored.chars}:${stored.text.trim().slice(0, 200)}`;
}

/** That same fallback computed from live text, so an old log still de-duplicates. */
function legacyIdentity(text: string): string {
  const value = (text ?? '').trim();
  return `legacy:${value.length}:${value.slice(0, 200)}`;
}

/**
 * One id having said one thing: the unit that is stored at most once.
 *
 * The separator is printable on purpose. A raw NUL byte in a source file makes ripgrep
 * classify it as binary and skip its contents, and a ChatGPT message id contains neither
 * a space nor a colon.
 */
function occurrence(messageId: string, identity: string): string {
  return `${messageId} :: ${identity}`;
}

async function ensureUnattributedSession(): Promise<string | null> {
  if (!recordingEnabled()) return null;
  if (unattributedSessionId) return unattributedSessionId;
  const summary = await createSession({ title: 'Unattributed activity' });
  unattributedSessionId = summary.id;
  lastActiveSessionId = summary.id;
  await appendEvent(summary.id, {
    time: Date.now(),
    source: 'app',
    kind: 'session_start',
    conversationId: null,
    title: summary.title
  });
  notifyChanged();
  return summary.id;
}

/** The session the UI opens by default: whatever was written to most recently. */
export function activeSessionId(): string | null {
  return lastActiveSessionId;
}

/** The unattributed stream, when one has been created. Shown as its own row in the UI. */
export function unattributedSession(): string | null {
  return unattributedSessionId;
}

/**
 * `activeTurnId` is the generation id of the turn this conversation currently has open, or
 * null. It exists so a reloaded content script can adopt the turn it is standing in the
 * middle of instead of minting a second one.
 *
 * The extension's turn ids are `g-<run>-<epoch>-<n>`, where `<run>` is a namespace random
 * per *document*. That is what makes them unique, and it is also why a reload cannot
 * reconstruct one: the old document's namespace died with it. So the new document sees a
 * stop button, believes it is watching a turn nobody has reported, and opens another —
 * splitting one assistant run across two generations, with the progress and prose ids of the
 * second half keyed off a name the first half never used. This app holds the durable half of
 * that identity, so this is where it has to come from.
 */
export function liveConversations(): Array<{
  conversationId: string;
  sessionId: string;
  generating: boolean;
  activeTurnId: string | null;
}> {
  return [...conversations.values()].map((entry) => ({
    conversationId: entry.conversationId,
    sessionId: entry.sessionId,
    generating: entry.turnStartedAt !== null,
    activeTurnId: entry.turnStartedAt !== null ? entry.turnId : null
  }));
}

/**
 * How long a rendered-but-unclaimed tool block stays evidence.
 *
 * Long enough to cover a slow tool and the page's own observation tick, short enough
 * that a block from a previous turn cannot adopt an unrelated call minutes later.
 */
const SIGHTING_TTL_MS = 60_000;
/**
 * How long an otherwise unattributable call waits for the page to catch up.
 *
 * The page renders the block while the call is still running and reports it on its own
 * tick, so for a fast tool the answer routinely beats the evidence. That is the race this
 * whole mechanism exists to survive; without the wait a chat's own quick reads would be
 * filed outside it. Paid off the connector's response path and only when a ChatGPT page
 * is actually there to report something, so no cross-device call is slowed by it.
 */
const SIGHTING_GRACE_MS = 5_000;
const SIGHTING_POLL_MS = 250;
/**
 * How long before a call started its block may have been rendered and still be its own.
 *
 * ChatGPT renders the block as it emits the call, so the block leads the record by about
 * the call's duration. Bounding it stops an older block in the same turn — a built-in
 * from a minute ago, or another connector's — from being banked and then adopting a
 * call that had nothing to do with it.
 */
const SIGHTING_LEAD_MS = 20_000;
/** Bound on unclaimed evidence per conversation, so a runaway page cannot grow it. */
const MAX_SIGHTINGS = 64;

/**
 * Records that a conversation's page has rendered `count` tool blocks this turn.
 *
 * The count is cumulative and idempotent: a retried batch reports the same number and
 * adds nothing. Only the increase becomes new evidence.
 */
function noteToolBlocks(live: LiveConversation, count: number, at: number): void {
  const fresh = count - live.blocksSeen;
  if (fresh <= 0) return;
  live.blocksSeen = count;
  // Stamped with when the page saw it, not with when this process heard about it. The
  // extension journals observations while the app is unreachable and replays them on
  // reconnect, so a block rendered minutes ago arrives looking brand new — and would then
  // be fresh enough to vouch for a call another device is making right now. Evidence is
  // only evidence while the call it belongs to could still be in flight.
  const seenAt = Math.min(at, Date.now());
  if (Date.now() - seenAt >= SIGHTING_TTL_MS) return;
  for (let index = 0; index < Math.min(fresh, MAX_SIGHTINGS); index++) live.sightings.push(seenAt);
  if (live.sightings.length > MAX_SIGHTINGS) live.sightings.splice(0, live.sightings.length - MAX_SIGHTINGS);
  for (const wake of sightingWaiters.splice(0)) wake();
}

/** Bound on per-call evidence held for one conversation. */
const MAX_PAGE_CALLS = 400;

/**
 * Records the connector requests a conversation's own message model says it issued.
 *
 * Cumulative and idempotent by ChatGPT's message id: a reload replays the whole turn and
 * adds nothing, and a call already spent on a recorded call stays spent.
 */
function noteCallEvidence(
  live: LiveConversation,
  calls: readonly PageCallEvidence[],
  at: number,
  turnId: string | null
): void {
  const seenAt = Math.min(at, Date.now());
  if (Date.now() - seenAt >= SIGHTING_TTL_MS) return;
  let added = 0;
  for (const call of calls) {
    if (live.calls.has(call.messageId)) continue;
    live.calls.set(call.messageId, {
      tool: call.tool,
      turnId,
      at: seenAt,
      order: call.order,
      claimed: false,
      requestId: call.requestId ?? null,
      issuedAt: typeof call.createTime === 'number' && Number.isFinite(call.createTime) ? call.createTime * 1000 : null
    });
    added++;
  }
  if (live.calls.size > MAX_PAGE_CALLS) {
    for (const key of [...live.calls.keys()].slice(0, live.calls.size - MAX_PAGE_CALLS)) live.calls.delete(key);
  }
  if (added > 0) for (const wake of sightingWaiters.splice(0)) wake();
}

/** Woken when new evidence lands, so a call in flight does not poll for it. */
const sightingWaiters: Array<() => void> = [];

function pruneSightings(): void {
  const cutoff = Date.now() - SIGHTING_TTL_MS;
  for (const entry of conversations.values()) {
    while (entry.sightings.length > 0 && entry.sightings[0]! < cutoff) entry.sightings.shift();
    for (const [key, call] of entry.calls) if (call.at < cutoff) entry.calls.delete(key);
  }
}

/**
 * The conversation whose message model shows an unclaimed request for exactly this tool.
 *
 * This is the primitive `claimConversation` should always have been. That one asks "did
 * some page draw a connector row", which is two inferences short of the question actually
 * being answered: a row does not name its connector, and — the failure that made this
 * necessary — the number of rows is not the number of calls. ChatGPT folds a run of calls
 * into one row (`collapsedSameToolCallCount`), and on a fast turn draws no row at all until
 * long after the call has been answered. Every call the page did not draw a row for was
 * therefore not merely unattributed but *guaranteed* to be unattributed, and a single chat
 * split itself into its real session plus a permanently growing `Unattributed activity`
 * pseudo-chat holding most of its own work.
 *
 * ChatGPT's message model does not fold. Each connector request is its own message with its
 * own id and its own tool path, whatever the renderer does with it afterwards. So the page
 * reports those, and a recorded call is placed by finding the request that names the same
 * tool. That is a genuine identification rather than a narrowing: `read_file` is this app's
 * tool, and a Gmail or Calendar request in the same turn names a different path and cannot
 * match it — which is exactly the false-match the row evidence could never rule out.
 *
 * The same three refusals still apply, for the same reasons. Evidence is consumed, so a
 * conversation can never absorb more calls than it demonstrably made; it must fall inside
 * the claiming call's own window; and two conversations offering the same tool at the same
 * moment is a refusal rather than a coin toss.
 */
function claimNamedCall(
  tool: string,
  startedAt: number,
  requestId: string | null = null
): { live: LiveConversation; turnId: string | null } | null {
  if (!tool) return null;
  pruneSightings();
  // The exact request, when ChatGPT named it. This is not a narrowing of the search below
  // but a different kind of answer: the id on the inbound HTTP request and the id the page
  // holds for the request it issued are the same string, so there is nothing left to infer
  // and nothing two simultaneous workers can confuse. It is honoured even if the evidence
  // was already claimed — one id belongs to one call, so a claim by anything else was a
  // mistake this corrects rather than a competing claim.
  if (requestId) {
    for (const entry of conversations.values()) {
      for (const call of entry.calls.values()) {
        if (call.requestId !== requestId) continue;
        call.claimed = true;
        return { live: entry, turnId: call.turnId ?? entry.turnId };
      }
    }
  }
  const earliest = startedAt - SIGHTING_LEAD_MS;
  // The request this same call already took to prove its caller, if it went that way.
  // Filing it anywhere else would put a control call in the wrong chat's history, and
  // leaving it unfiled would put it in the unattributed stream while the app knew perfectly
  // well whose it was.
  for (const entry of conversations.values()) {
    for (const call of entry.calls.values()) {
      if (call.claimed || call.reservedFor !== startedAt) continue;
      call.claimed = true;
      return { live: entry, turnId: call.turnId ?? entry.turnId };
    }
  }

  const usable = (entry: LiveConversation): Array<[string, PageCall]> =>
    [...entry.calls].filter(
      ([, call]) => !call.claimed && call.reservedFor === undefined && call.tool === tool && call.at >= earliest
    );

  const offering = [...conversations.values()].filter((entry) => usable(entry).length > 0);
  if (offering.length !== 1) return null;
  const only = offering[0]!;
  // Oldest first: calls are answered in the order they were issued within one conversation,
  // so the earliest unclaimed request for this tool is the one this record belongs to.
  const [, call] = usable(only).sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order)[0]!;
  call.claimed = true;
  return { live: only, turnId: call.turnId ?? only.turnId };
}

/**
 * The conversation a tool call demonstrably came from, or null.
 *
 * This is the whole attribution story, so it is worth stating what it rests on and what
 * was tried before it.
 *
 * A tool call arrives over ChatGPT's connector carrying nothing that identifies its
 * caller — no conversation id, no device, no session. The app therefore used what the
 * browser could see: if exactly one conversation was generating, the call was said to be
 * that one's. That inference is false, and false in the ordinary case rather than an
 * exotic one. The connector belongs to a ChatGPT *account*, not to a browser: the same
 * account driving this app from the Android app, from a second browser or from another
 * machine produces calls that arrive here while Chrome sits with an unrelated chat open,
 * and sometimes with an unrelated turn of its own in flight. Measured on the installed
 * build, phone-driven calls took the unattributed count from ~107 to ~188 with a Chrome
 * tab open throughout; under the old rule those would have been written into that Chrome
 * chat's permanent history, and nothing afterwards could tell them apart from its own.
 *
 * What does discriminate by origin is the page itself. ChatGPT renders a tool block in
 * the conversation that made the call — and only in that one. So a conversation whose
 * page has reported an unclaimed connector block has *shown* that it made a connector
 * call, and one whose page has reported nothing has not. A phone-driven turn in a chat
 * that is also open in this browser renders its blocks here too, which is why that case
 * attributes correctly rather than being lost.
 *
 * Three things bound what that is worth, and they are why this is graded evidence rather
 * than proof:
 *
 * - The row says "a connector", not "this connector". Collapsed, it carries no provider
 *   name, tool name or request path — ChatGPT holds all three in client state and shows
 *   them only once the row or its side panel is opened, which this app will not do behind
 *   the user's back. Another connector on the same account renders the same shape. So a
 *   Chrome turn calling Gmail at the same moment the phone calls this app is the residual
 *   false-match, and it is why page-matched calls are recorded as `turn` — matched by
 *   what the page showed — and never as `agent`, which is caller identity.
 * - The evidence is consumed, one block per call, so a conversation can never absorb more
 *   calls than it visibly made, and it must fall inside the claiming call's own window,
 *   so blocks from earlier in the turn cannot be banked up and spent on a later call.
 * - Two conversations showing blocks at once is a refusal, not a coin toss.
 * - So is one block with several calls waiting on it. Calls arrive in order within a
 *   conversation, so competition means callers, and there is nothing in a block that says
 *   which of them it belongs to; handing it to the earliest would file the phone's call
 *   into the browser's chat and put the browser's own call in the unattributed stream —
 *   the exact swap this is built to prevent. Blocks are only awarded when the watching
 *   conversation has shown at least as many as there are calls asking.
 *
 * Anything unproven is preserved in the unattributed stream instead — complete, and
 * honestly labelled as work that could not be placed.
 */
function claimConversation(startedAt: number, competing: number): LiveConversation | null {
  pruneSightings();
  const earliest = startedAt - SIGHTING_LEAD_MS;
  const seen = [...conversations.values()].filter((entry) => entry.sightings.some((at) => at >= earliest));
  if (seen.length !== 1) return null;
  const only = seen[0]!;
  if (only.sightings.filter((at) => at >= earliest).length < competing) return null;
  only.sightings.splice(
    only.sightings.findIndex((at) => at >= earliest),
    1
  );
  return only;
}

/**
 * Discards evidence a call competed for and could not win.
 *
 * Only what was in that call's own window: a block reported after it gave up belongs to
 * whatever comes next and is left alone.
 */
function burnContested(startedAt: number): void {
  const earliest = startedAt - SIGHTING_LEAD_MS;
  for (const entry of conversations.values()) {
    entry.sightings = entry.sightings.filter((at) => at < earliest);
  }
}

/**
 * The same evidence, read without consuming it.
 *
 * For callers that need to know which conversation is making the call they are handling
 * — refuting a mistaken join — rather than filing a record. Everything in the note above
 * about what a connector row does and does not prove applies here too, so this is used to
 * narrow and to contradict, never on its own to authorise.
 */
/**
 * The one ChatGPT chat that is mid-turn right now, or null if that is not a single answer.
 *
 * Strictly stronger than `provenConversation()`, which reports the chat that has *shown*
 * connector rows lately and so keeps answering for a minute after that chat went quiet.
 * This asks only who is generating at this instant: a chat that is not generating is not
 * making tool calls, so a single generating chat is the one that called.
 *
 * Used to scope a workspace to a conversation, where a wrong answer would resolve a
 * relative path inside somebody else's project. Two chats generating at once returns null,
 * and the caller refuses the relative path rather than picking one.
 */
/**
 * The chat a recorded session belongs to, when exactly one live chat is writing to it.
 *
 * Used by compaction to find the workspace of the chat being compacted, which it otherwise
 * has no way to name: a compaction request identifies a session, and the mapping only runs
 * the other way. Ambiguity is answered with null rather than a pick, for the same reason it
 * is everywhere else in the workspace code.
 */
export function soleConversationForSession(sessionId: string): string | null {
  const owners = [...conversations.values()].filter((entry) => entry.sessionId === sessionId);
  return owners.length === 1 ? owners[0]!.conversationId : null;
}

export function soleGeneratingConversation(): string | null {
  // An open durable turn is not always direct proof of current generation: we intentionally
  // keep an `unknown` turn open while ChatGPT flickers its stop control through a connector
  // phase. Workspace fallback happens *before* a tool result can be attributed, so using that
  // uncertain interval here could resolve a phone/other-chat relative path against this
  // browser chat's workspace. Only direct generation-visible state is safe enough for this
  // pre-execution identity shortcut.
  const running = [...conversations.values()].filter(
    (entry) => entry.turnStartedAt !== null && entry.generationVisible && stillReporting(entry)
  );
  return running.length === 1 ? running[0]!.conversationId : null;
}

export function provenConversation(): string | null {
  pruneSightings();
  const seen = [...conversations.values()].filter((entry) => entry.sightings.length > 0);
  return seen.length === 1 ? seen[0]!.conversationId : null;
}

/**
 * Waits for a conversation's page to show a connector block rendered after `after`.
 *
 * The handshake behind a no-argument join, and the one tool where waiting on the browser
 * is the right thing to do: establishing which chat is calling *is* the work, it happens
 * once per agent chat, and the chat in question is one this app opened through the paired
 * extension, so its page is certain to be reporting.
 *
 * ChatGPT renders the row for a tool as it invokes it, before it can have the result, so
 * a conversation that shows a fresh block during this call is one that is making a call
 * right now. Read without consuming, so the record for this same call can still be placed
 * by it afterwards, and refused whenever more than one conversation qualifies.
 */
export async function awaitFreshSighting(after: number, within: number): Promise<string | null> {
  const deadline = Date.now() + within;
  for (;;) {
    pruneSightings();
    const seen = [...conversations.values()].filter((entry) => entry.sightings.some((at) => at >= after));
    if (seen.length === 1) return seen[0]!.conversationId;
    if (seen.length > 1 || Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const at = sightingWaiters.indexOf(wake);
        if (at >= 0) sightingWaiters.splice(at, 1);
        resolve();
      }, SIGHTING_POLL_MS);
      timer.unref?.();
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      sightingWaiters.push(wake);
    });
  }
}

/**
 * Waits for this exact connector tool to appear in ChatGPT's own message model.
 *
 * This is stronger than `awaitFreshSighting`: a rendered connector row only proves that
 * *some* connector call happened in a conversation, while Fiber `tool_evidence` names the
 * request itself. Prime/worker control calls need identity before their result exists, so
 * this read is deliberately non-consuming; the normal recorder still consumes the same
 * PageCall later when it files the completed MCP call.
 *
 * When the MAIN-world helper is unavailable callers may still fall back to the generic row
 * handshake. More than one conversation offering the same named tool during the window is
 * ambiguous and is refused rather than guessed.
 *
 * `exact` turns that fallback off, and the caller that needs it is `spawn`. A generic row
 * says only that *some* connector call happened in that chat during the window: another
 * conversation calling another connector at the same moment satisfies it just as well, which
 * for spawn would mean an uninvolved chat becoming the prime of a run it never asked for. A
 * binding that cannot be undone is worth a refusal and a retry; nothing else here is.
 */
/**
 * The one conversation whose page has already named this exact tool request, or null.
 *
 * The non-blocking read behind ordinary attribution. `awaitFreshCallOrigin` is this same
 * question asked with a deadline, for the two callers that can afford to wait because
 * establishing identity *is* their work; everything else asks once and accepts null.
 *
 * Named evidence only — no connector-row fallback. A row says some connector call happened
 * in that chat, which without a wait is as likely to be a different call as this one, and a
 * wrong answer here files one chat's work under another chat's agent.
 *
 * Read without consuming: the record for this same call is placed by the same evidence
 * afterwards. Ambiguity is null, never a pick.
 */
/**
 * Conversations whose page has named an unclaimed request for this tool near this call.
 *
 * The window is `[after - SIGHTING_LEAD_MS, now]`, not `[after, now]`, and that lead is the
 * whole point. ChatGPT writes the connector request into its own message model *before* the
 * HTTP call reaches this app, so the evidence that names a call routinely pre-dates the call
 * it names — measured live on 2026-08-18 at **5.5 seconds** ahead, against a 2.5s identity
 * deadline. Requiring `at >= after` therefore threw away the exact evidence it was asking
 * for, and every `agents action=spawn` from a fresh chat was refused `UNIDENTIFIED_CALLER`
 * however long it waited. `claimNamedCall` has always allowed this same lead; the identity
 * path simply never got it.
 *
 * What keeps the lead from letting an *older* call vouch for this one is `claimed`: the
 * recorder consumes a page call when it files the MCP call it belongs to, so evidence still
 * unclaimed is evidence for a call this app has not yet recorded — which, on the identity
 * path, is the call being placed right now. Ambiguity across conversations is still refused
 * rather than guessed.
 */
function namedCandidates(tool: string, after: number, forCall?: number): NamedCandidate[] {
  const earliest = after - SIGHTING_LEAD_MS;
  const out: NamedCandidate[] = [];
  for (const live of conversations.values()) {
    for (const call of live.calls.values()) {
      if (call.claimed || call.tool !== tool || call.at < earliest) continue;
      // A request another call in flight has taken for its own identity is not evidence
      // for this one. Its own call reads it again, which is what makes the wait idempotent.
      if (call.reservedFor !== undefined && call.reservedFor !== forCall) continue;
      out.push({ live, call });
    }
  }
  return out.sort((a, b) => issuedAt(a.call) - issuedAt(b.call) || a.call.order - b.call.order);
}

function namedOrigins(tool: string, after: number): LiveConversation[] {
  const seen = new Set<LiveConversation>();
  for (const candidate of namedCandidates(tool, after)) seen.add(candidate.live);
  return [...seen];
}

/**
 * Takes the one request this call is placing, in order, and reserves it.
 *
 * Ordinary attribution can afford to answer "I don't know" — the call is recorded either
 * way. The identity path cannot: a refusal there is a worker that cannot report its own
 * result. So where `freshCallOrigin` refuses every ambiguity, this resolves the ambiguity
 * that order can genuinely settle.
 *
 * Two workers of the same run call `agents` seconds apart. Both requests are named, both
 * are unclaimed, and both sit inside the 20-second lead window, so "exactly one
 * conversation is offering" is false for both of them and — measured live on 2026-08-18,
 * run f2507104, evidence at 1787053585194 and 1787053589194 against a first identity check
 * at 1787053591624 — *both* workers were told WORKER_IDENTITY_LOST. Concurrency inside a
 * run is the normal case for a swarm, so a rule that refuses it refuses the feature.
 *
 * What can settle it is that these are queues, not a set: requests are issued in an order,
 * they reach this app in that order, and each one is taken exactly once — so the oldest
 * unreserved request is this call's, and reserving it leaves the next one for the next
 * caller. That argument holds only for a timestamp that says when the request was
 * *issued*. `at` is not that timestamp: it is when the extension's observation tick
 * happened to see the row, per tab, so two tabs' stamps can be phase-shifted by more than
 * the gap between the requests they describe. Ordering on it would be ceremony. So the
 * order is taken from ChatGPT's own `create_time`, and where that is missing on either
 * side this refuses exactly as it did before.
 *
 * `ORDER_MARGIN_MS` is where the argument stops even with real times. Two requests issued
 * within a second of each other are close enough that a swap is credible, and a swap here
 * is the one outcome worth refusing over: one worker's `finish` recorded as another's.
 * Beyond the margin, order is information; inside it, this is a coin toss and says so.
 *
 * All of this is now the fallback rather than the answer: when ChatGPT sends a request id,
 * joinByRequestId places the call outright and none of the reasoning here runs. It is kept
 * for evidence that carries no id — an older extension, or a build of ChatGPT that stops
 * sending one — and can go once that is no longer worth supporting.
 */
interface NamedCandidate {
  live: LiveConversation;
  call: PageCall;
}

function issuedAt(call: PageCall): number {
  return call.issuedAt ?? call.at;
}

function reserveNamedOrigin(tool: string, after: number): string | null | 'ambiguous' {
  const candidates = namedCandidates(tool, after, after);
  const mine = candidates.find((candidate) => candidate.call.reservedFor === after);
  if (mine) return mine.live.conversationId;
  const first = candidates[0];
  if (!first) return null;
  const rival = candidates.find((candidate) => candidate.live !== first.live);
  if (rival) {
    // Order is only information if both sides carry ChatGPT's own creation time. Without
    // it the only stamp available is when the extension's poll saw the row, which is a tick
    // of that tab's own loop and can be phase-shifted from another tab's by more than the
    // gap being measured — sorting on it would look like ordering while ordering nothing.
    const timed = first.call.issuedAt !== null && first.call.issuedAt !== undefined
      && rival.call.issuedAt !== null && rival.call.issuedAt !== undefined;
    if (!timed || issuedAt(rival.call) - issuedAt(first.call) < ORDER_MARGIN_MS) return 'ambiguous';
  }
  first.call.reservedFor = after;
  return first.live.conversationId;
}

/**
 * The conversation that issued this exact request, by ChatGPT's own id for it.
 *
 * Nothing here is inferred. ChatGPT stamps a request id on the connector call and on the
 * request in its own message model, the extension reports the second, and this matches
 * them. Where it answers, no window, no ordering and no ambiguity rule applies at all.
 */
function joinByRequestId(requestId: string | null): LiveConversation | null {
  if (!requestId) return null;
  for (const live of conversations.values()) {
    for (const call of live.calls.values()) if (call.requestId === requestId) return live;
  }
  return null;
}

export function freshCallOrigin(tool: string, after: number, requestId: string | null = null): string | null {
  pruneSightings();
  const exact = joinByRequestId(requestId);
  if (exact) return exact.conversationId;
  const named = namedOrigins(tool, after);
  return named.length === 1 ? named[0]!.conversationId : null;
}

export async function awaitFreshCallOrigin(
  tool: string,
  after: number,
  within: number,
  options: { exact?: boolean; requestId?: string | null } = {}
): Promise<string | null> {
  const deadline = Date.now() + within;
  for (;;) {
    pruneSightings();
    // The deterministic answer, whenever ChatGPT gave us one. Everything below it is the
    // fallback for a page whose evidence carries no request id — an older extension, or a
    // build of ChatGPT that stops sending it.
    const joined = joinByRequestId(options.requestId ?? null);
    if (joined) {
      return joined.conversationId;
    }
    const named = reserveNamedOrigin(tool, after);
    if (named === 'ambiguous') {
      return null;
    }
    if (named) {
      return named;
    }

    // Compatibility fallback for a page where the Fiber helper is unavailable. This is the
    // old handshake: weaker because the row does not name the connector/tool, but still
    // scoped to this call's start time and refused on ambiguity.
    const generic = options.exact
      ? []
      : [...conversations.values()].filter((entry) => entry.sightings.some((at) => at >= after));
    if (generic.length === 1) {
      return generic[0]!.conversationId;
    }
    if (generic.length > 1 || Date.now() >= deadline) {
      return null;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const at = sightingWaiters.indexOf(wake);
        if (at >= 0) sightingWaiters.splice(at, 1);
        resolve();
      }, SIGHTING_POLL_MS);
      timer.unref?.();
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      sightingWaiters.push(wake);
    });
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Stores text for one event: bounded inline, complete in an asset when it overflows.
 *
 * `truncated` means "not all of it is on this line", never "the rest is gone" — the
 * whole redacted original goes next to the log and its id travels in the event, so the
 * exact arguments of an edit or the exact output of a build stay recoverable. The one
 * case where material really is lost is text beyond even the overflow limit, and then
 * the inline note says exactly that instead of implying a complete record.
 */
async function storeText(
  sessionId: string,
  text: string,
  cap: number,
  options?: { identify?: boolean }
): Promise<StoredText> {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const value = scrubAgentSecrets(raw);
  // Only where it is used. A digest on every tool result would add sixty-four bytes to
  // every line of the log to answer a question nobody asks of a tool result; messages are
  // the events a reloaded page offers again.
  const identity = options?.identify ? { digest: textIdentity(raw) } : {};
  if (value.length <= cap) return { text: value, truncated: false, chars: value.length, ...identity };
  const assetId = await writeOverflowText(sessionId, value);
  const note = assetId
    ? `\n…[${value.length - cap} more characters stored in full as ${assetId}]`
    : `\n…[${value.length - cap} more characters were too large to store and are lost]`;
  return {
    text: `${value.slice(0, cap)}${note}`,
    truncated: true,
    chars: value.length,
    ...(assetId ? { assetId } : {}),
    // Especially here: the truncated copy is precisely the one that cannot be compared
    // with the live text it came from, which is why long answers were stored again after
    // every restart.
    ...identity
  };
}

/**
 * Fields that must never reach disk, whatever tool they arrive on.
 *
 * `join_key` and friends route and attribute work: writing one into
 * events.jsonl would publish it to session_history, to the Activity feed the extension is
 * sent, and to anything built from the raw log, and anyone holding a live worker's code
 * could then answer in that worker's name. It does not make anybody the prime — that role
 * is bound to a conversation and has no credential at all.
 *
 * They are dropped by name here. Long values are additionally substituted wherever they
 * appear by agent-secrets.ts; the three-character worker code is not, and is instead cut
 * out of the one sentence that hands it out (see redactResult).
 */
const CREDENTIAL_FIELDS = new Set(['joinKey', 'join_key', 'secret']);

/**
 * Removes the argument values that must never be written to disk.
 *
 * Environment overrides can carry credentials, a base64 blob is megabytes of noise,
 * and clipboard text is the one input the user may not have meant to hand over.
 * Everything else is stored verbatim: the point of the record is exact recovery.
 */
function redactArgs(tool: string, args: unknown): unknown {
  if (!args || typeof args !== 'object') return scrubAgentSecretsDeep(args);
  const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (copy['env'] && typeof copy['env'] === 'object') {
    copy['env'] = Object.fromEntries(Object.keys(copy['env'] as object).map((key) => [key, '***']));
  }
  if (typeof copy['dataBase64'] === 'string') {
    copy['dataBase64'] = `<${(copy['dataBase64'] as string).length} base64 characters not stored>`;
  }
  // Clipboard text arrives inside computer's action list, so the redaction follows the
  // action rather than the tool name: the text the user copied is theirs, and one of these
  // steps buried in a batch of clicks must not be the thing that writes it to disk.
  if (tool === 'computer' && Array.isArray(copy['actions'])) {
    copy['actions'] = (copy['actions'] as unknown[]).map((action) => {
      if (!action || typeof action !== 'object') return action;
      const step = action as Record<string, unknown>;
      if (step['type'] !== 'write_clipboard' || typeof step['text'] !== 'string') return action;
      return { ...step, text: `<${(step['text'] as string).length} characters not stored>` };
    });
  }
  for (const field of Object.keys(copy)) {
    if (CREDENTIAL_FIELDS.has(field)) copy[field] = '<agent key removed>';
  }
  return scrubAgentSecretsDeep(copy);
}

function redactResult(tool: string, text: string): string {
  // The other half of the clipboard rule: what was read comes back as its own line in
  // computer's reply, and only that line is dropped, so the rest of the result — which
  // actions ran, where the pointer ended up — still says what happened.
  if (tool === 'computer' && text.includes('Clipboard read ')) {
    return text
      .split('\n')
      .map((line) =>
        line.startsWith('Clipboard read ')
          ? `${line.slice(0, line.indexOf(':') + 1)} <clipboard text not stored>`
          : line
      )
      .join('\n');
  }
  return text;
}

/**
 * Keeps live agent keys out of the one-line summary.
 *
 * Summaries are built from the *raw* arguments, on purpose — the point of a summary is
 * to name what was actually done — and some of them quote an argument directly, such as
 * the first line of a PowerShell script. A key pasted into one of those would otherwise
 * travel to events.jsonl, the Activity feed and the extension while args and result were
 * both properly scrubbed.
 */
function scrubSummary(summary: ActivitySummary): ActivitySummary {
  return {
    ...summary,
    title: scrubAgentSecrets(summary.title),
    ...(summary.detail === undefined ? {} : { detail: scrubAgentSecrets(summary.detail) }),
    ...(summary.metric === undefined ? {} : { metric: scrubAgentSecrets(summary.metric) })
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 0) ?? 'null';
  } catch {
    return '"<arguments could not be serialised>"';
  }
}

// -------------------------------------------------------------- tool calls

export interface ToolContentPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolCallInput {
  tool: string;
  args: unknown;
  content: readonly ToolContentPart[];
  outcome: ToolOutcome;
  durationMs: number;
  startedAt: number;
  evidence?: CallEvidence;
  agent?: string | null;
  /** Agent to bind to this call's conversation once it is identified. See CallContext. */
  bind?: string | null;
  /**
   * ChatGPT's id for the HTTP request that carried this call, when it sent one.
   *
   * The page's evidence for the same call carries the same id, so this places the call in
   * the conversation that issued it outright — including when two workers call one tool at
   * the same instant, which no window or ordering rule can separate. See inbound.ts.
   */
  requestId?: string | null;
}

/** Writing runs one at a time, so the log keeps call order. See recordToolCall. */
let recordChain: Promise<unknown> = Promise.resolve();

/**
 * Records one MCP tool call.
 *
 * Never throws into the caller: a broken recorder must not break the connector, so a
 * storage failure is logged and the tool result is returned to ChatGPT regardless.
 *
 * The work is queued rather than run inline. Attribution can have to wait a moment for
 * the page to report the tool block that shows where the call came from, and nothing
 * ChatGPT is waiting on may wait on the browser: with sequential file and command tools
 * a second of that per call is the difference between a companion that feels immediate
 * and one that feels broken. The connector fires this and moves on; the returned promise
 * is for tests and for the flush at quit.
 *
 * The two halves are queued differently on purpose. Every call's evidence window opens
 * the moment the call lands, all of them at once, so a burst of a hundred cross-device
 * calls costs one grace period between them rather than a hundred — and a real block
 * arriving mid-burst is still fresh when the call it belongs to looks for it, instead of
 * having expired behind a queue. Only the write is serialised, in call order, so the log
 * stays in order. Claims are handed out in call order too, so which call takes which
 * block does not depend on scheduling.
 *
 * The cost of not blocking the connector is a crash window: a call whose evidence has not
 * resolved yet exists only in memory, so a power loss inside those couple of seconds
 * loses it, where the old inline write would not have. Quitting flushes. That is the
 * whole of the tradeoff, and it is bounded by SIGHTING_GRACE_MS.
 */
export function recordToolCall(input: ToolCallInput): Promise<ToolCallRecord | null> {
  if (!recordingEnabled()) return Promise.resolve(null);
  // Started now, not when the queue reaches this call: the wait is for the page, and the
  // page is not waiting for our queue.
  const attributing = awaitSighting(
    input.agent ?? null,
    input.tool,
    input.startedAt,
    input.durationMs,
    input.requestId ?? null
  ).then((target) => {
    // The one place a conversation binding can be established from a call rather than
    // from the extension's report. It exists for the prime agent, whose chat is the
    // user's own and so was never opened by this app: without it the prime would attribute
    // per call forever and never be known to sit anywhere, which the broker needs in order
    // to defend an idle run's ownership. Deliberately after the fact — at the moment
    // `spawn` runs, the block for that call itself has usually not been reported
    // yet, so reading the evidence before answering finds nothing and binds nothing.
    if (input.bind && target.conversationId) bindAgentConversation(input.bind, target.conversationId);
    return target;
  });
  const filed = recordChain.then(async () => fileToolCall(input, await attributing));
  recordChain = filed.then(
    () => undefined,
    () => undefined
  );
  return filed;
}

/** Waits for every queued tool call to be written. Called before the app quits. */
export async function flushRecorder(): Promise<void> {
  // Twice: the chain is extended by calls whose attribution was still resolving when the
  // first await was set up, and settling those adds their writes to the end of it.
  await recordChain.catch(() => undefined);
  await recordChain.catch(() => undefined);
}

async function fileToolCall(input: ToolCallInput, target: Target): Promise<ToolCallRecord | null> {
  if (!recordingEnabled()) return null;
  try {
    const evidence = input.evidence ?? currentCall()?.evidence ?? emptyEvidence();
    const sessionId = await targetSession(target);
    if (!sessionId) return null;

    const textParts = input.content.filter((part) => part.type === 'text').map((part) => part.text ?? '');
    // Scrub before summarisation too. A failed tool may put the first line of its
    // result into ActivitySummary.detail; scrubbing only in storeText would keep the
    // raw capability out of args/result while still leaking it through that summary to
    // events.jsonl, the renderer and the extension activity feed.
    const resultText = scrubAgentSecrets(redactResult(input.tool, textParts.join('\n')));
    const assets: AssetRef[] = [...evidence.assets];
    for (const part of input.content) {
      if (part.type !== 'image' || !part.data) continue;
      const asset = await storeImage(sessionId, part.data, part.mimeType ?? 'image/png');
      if (asset) assets.push(asset);
    }

    const summary: ActivitySummary = scrubSummary(
      summarizeToolCall({
        tool: input.tool,
        args: input.args,
        evidence,
        outcome: input.outcome,
        durationMs: input.durationMs,
        resultHead: resultText.split('\n', 1)[0] ?? ''
      })
    );

    const call: ToolCallRecord = {
      callId: randomUUID(),
      tool: input.tool,
      attribution: target.attribution,
      args: await storeText(sessionId, safeJson(redactArgs(input.tool, input.args)), MAX_TOOL_ARGS_CHARS),
      result: await storeText(sessionId, resultText, MAX_TOOL_RESULT_CHARS),
      outcome: input.outcome,
      durationMs: input.durationMs,
      summary,
      ...(evidence.changes.length > 0 ? { changes: evidence.changes } : {}),
      ...(assets.length > 0 ? { assets } : {})
    };

    await appendEvent(sessionId, {
      time: input.startedAt,
      source: 'mcp',
      kind: 'tool_call',
      call,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(target.turnId ? { turnId: target.turnId } : {})
    });
    notifyChanged();
    return call;
  } catch (err) {
    logWarn(`session recorder could not store a tool call: ${(err as Error).message}`);
    return null;
  }
}

interface Target {
  conversationId: string | null;
  attribution: CallAttribution;
  turnId: string | null;
}

/**
 * How far before a call started the conversation it belongs to must already have been
 * generating.
 *
 * A turn is in flight before it emits its first call, never after, so a generation that
 * began *after* the call cannot be its origin. The slack is for clock and reporting skew
 * between the page's observation tick and the connector's own timestamp.
 */
const GENERATION_SLACK_MS = 2_000;

/**
 * How long a conversation's "I am generating" stays believable without a fresh report.
 *
 * A generation is a statement about *now*, and this memory is the last thing the page said
 * rather than a fact about the page. Live: the browser was closed mid-turn, the worker's turn
 * carried on server-side at ChatGPT, and its next call was filed into that chat as "placed by
 * the only chat generating" — an answer produced entirely from state nothing could refresh
 * any more. The extension reports every few seconds while a turn runs, so anything older than
 * this is a page that has stopped talking to us, whatever it last claimed.
 */
const LIVE_REPORT_TTL_MS = 20_000;

/** Whether this conversation is still reporting, as opposed to remembered. */
function stillReporting(entry: LiveConversation): boolean {
  return Date.now() - entry.lastSeen <= LIVE_REPORT_TTL_MS;
}

/**
 * The one ChatGPT chat that was demonstrably mid-turn when this call arrived.
 *
 * Not consumed, unlike the per-call and per-row evidence: one generation legitimately
 * covers a whole run of calls, and consuming it would put the first call of a turn in the
 * chat and the next twenty outside it — which is a fair description of what the installed
 * build actually did.
 *
 * This is the weakest grade in the ladder and it is fenced accordingly. Four refusals, each
 * for a case where placing the call would be a guess wearing a label:
 *
 * - Two chats mid-turn at once. Undecidable, and picking one reads as certainty.
 * - The turn had already ended. A generation is a statement about *now*; a chat that
 *   stopped is not calling, and a grace period after the stop would only mean a chat could
 *   quietly adopt the next device's work for as long as the period lasted.
 * - The chat's own message model named the requests it made and none of them is this call.
 *   Named evidence is the strongest thing the page offers, and `claimNamedCall` has already
 *   tried it: reaching here means the page said what it asked for and this was not among
 *   it, or that every matching request was already spent on an earlier record. Overriding
 *   that with "well, it was generating" is how one browser request comes to vouch for five
 *   connector calls.
 * - The call raced another unplaced call. Two calls in flight and one chat generating does
 *   not say which of them is the chat's, and the ambiguity does not resolve when one of
 *   them gives up first — see burnContested, which exists for exactly this on the row path.
 */
function claimGeneration(startedAt: number, contested: boolean): LiveConversation | null {
  if (contested) return null;
  const running = [...conversations.values()].filter(
    (entry) =>
      entry.turnStartedAt !== null &&
      entry.generationVisible &&
      stillReporting(entry) &&
      entry.turnStartedAt <= startedAt + GENERATION_SLACK_MS
  );
  if (running.length !== 1) return null;
  const only = running[0]!;
  const earliest = startedAt - SIGHTING_LEAD_MS;
  const named = [...only.calls.values()].filter((call) => call.at >= earliest);
  if (named.length > 0) return null;
  return only;
}

/**
 * Decides which conversation a tool call belongs to.
 *
 * Four grades of evidence, strongest first, and each recorded as what it is rather than
 * being flattened into one confident answer.
 *
 * An agent bound to a conversation by the extension — which watched itself open that chat
 * — is authoritative and is recorded as `agent`. Note what that branch does *not* do: an
 * authenticated agent whose binding is missing can still have its call placed by page
 * evidence, but that placement stays `turn`, because the key proves who is calling and not
 * which chat they are calling from.
 *
 * Then per-call evidence: a request in the page's own message model naming this exact tool.
 * Then a drawn connector block, which says only that the chat asked for *something*.
 *
 * And finally — this is the change that made the record usable — the fact that exactly one
 * ChatGPT chat was mid-turn. That last one was previously refused on principle, on the
 * grounds that the connector is account-scoped so a mid-turn browser chat does not *prove*
 * the call came from the browser. The principle is sound and the outcome was not: ChatGPT
 * folds a run of calls into one rendered row and on a fast turn draws no row at all, so
 * every call the page did not draw was guaranteed unattributable. Measured on the installed
 * 1.7 build over one working session, 53 of the chat's own calls went to `Unattributed
 * activity` against 24 that reached the chat. Missing half the work is not a more honest
 * record than a placed call labelled `generation`; the grade is what carries the doubt, and
 * the stronger evidence above still wins whenever it exists, including when it names a
 * different conversation.
 */
function pickTarget(
  agent: string | null,
  tool: string,
  startedAt: number,
  competing: number,
  contested: boolean,
  requestId: string | null = null
): Target {
  if (agent) {
    const bound = [...conversations.values()].find((entry) => agentConversation(agent) === entry.conversationId);
    if (bound) return { conversationId: bound.conversationId, attribution: 'agent', turnId: bound.turnId };
  }
  // Named evidence first. A request in the page's own message model says which tool this
  // conversation asked for; a drawn row says only that it asked for something, and there
  // are fewer rows than calls. Trying the rows first would let a row from an unrelated
  // built-in be spent on a call the named evidence could have placed exactly.
  const named = claimNamedCall(tool, startedAt, requestId);
  if (named) return { conversationId: named.live.conversationId, attribution: 'turn', turnId: named.turnId };
  const claimed = claimConversation(startedAt, competing);
  if (claimed) return { conversationId: claimed.conversationId, attribution: 'turn', turnId: claimed.turnId };
  const running = claimGeneration(startedAt, contested);
  if (running) return { conversationId: running.conversationId, attribution: 'generation', turnId: running.turnId };
  return { conversationId: null, attribution: agent ? 'agent' : 'inferred', turnId: null };
}

/**
 * Calls still looking for evidence, each with the window it actually ran in.
 *
 * What makes two calls ambiguous is that they *ran* at the same time — one machine cannot
 * have made both, so a single rendered block cannot say which of them it stands for. What
 * does not make them ambiguous is that they are both still waiting to be placed.
 *
 * That distinction used to be missing: this was a set of tickets and contention was
 * `claiming.size > 1`. A call is only handed to the recorder once its tool has *finished*,
 * and then waits up to SIGHTING_GRACE_MS for the page to catch up — so two strictly
 * sequential calls three seconds apart, one after the other in a single chat with nothing
 * else running anywhere, sat in that set together and declared each other contested. That
 * disables claimGeneration() outright (`if (contested) return null`), which is the last
 * grade of evidence a fast turn has, so an ordinary burst of sequential calls in one live
 * conversation graded `inferred` and went to "Unattributed activity" — visible in session
 * `2026-08-17-09ab937b` as runs of calls 2.8 and 3.9 seconds apart while the chat that made
 * them was demonstrably mid-turn.
 *
 * Overlap is measured between execution intervals, both of which are known exactly by the
 * time either call gets here. Genuinely concurrent calls still contest each other, and
 * still do so stickily, which is what keeps the cross-device protection intact.
 */
let nextTicket = 0;
interface Claim {
  /** When the tool started running. */
  from: number;
  /** When it stopped. Equal to `from` for an instantaneous call. */
  to: number;
}
const claiming = new Map<number, Claim>();

/**
 * Calls that were genuinely running at the same time as this one.
 *
 * Half-open intervals, `[from, to)`, and no tolerance either side. Both endpoints are stamped
 * by this process — `startedAt` when the kernel dispatches the call, `durationMs` measured
 * around the same execution — so there is no second clock to reconcile and nothing for a
 * slack window to absorb. A call that begins in the same millisecond another ended is the
 * next call, not a concurrent one, which is exactly what half-open says; a proximity margin
 * would instead have declared ordinary back-to-back calls contested and reintroduced the
 * failure this is here to fix.
 *
 * A zero-duration call is a point, and `from < to` is false for it against itself. Two of
 * them landing in the same millisecond genuinely cannot be ordered from these stamps, so the
 * degenerate case is resolved the ambiguous way: equal points overlap.
 */
function overlapping(ticket: number, span: Claim): number {
  let count = 0;
  for (const [other, held] of claiming) {
    if (other === ticket) continue;
    const apart = held.from >= span.to || span.from >= held.to;
    if (!apart || (held.from === span.from && held.to === span.to)) count++;
  }
  return count;
}

/**
 * Whether a rendered block is on the table that several waiting calls could each be.
 *
 * This is the other half of what "contested" has to mean, and the half that keeps the
 * cross-device protection intact once execution overlap stops standing in for it.
 *
 * A block says a connector call was made in this chat, and one block cannot answer for two
 * calls. So when the page has reported one while more than one call is still unplaced, the
 * evidence is short, and short evidence is ambiguous *whether or not* those calls ran at the
 * same time: the browser and the phone taking turns look exactly like one chat working
 * through a list. Neither may then fall back to the sole-live-generation grade, because that
 * is precisely the swap — the phone's work written into the browser's history — that the
 * refusal exists to prevent.
 *
 * What it does not cover is the case this whole change is about: several sequential calls
 * with *no* block drawn for any of them. ChatGPT folds a run of calls into one row and on a
 * fast turn draws none at all, which is the documented reason claimGeneration exists, and
 * nothing there is contested by anything. Session `2026-08-17-09ab937b` is the measurement:
 * runs of calls 2.8 and 3.9 seconds apart — inside the five-second grace, so all mutually
 * "claiming", none of them actually concurrent — graded `inferred` and filed as unattributed
 * while the chat that made them was demonstrably mid-turn.
 */
function shortEvidence(startedAt: number): boolean {
  if (claiming.size < 2) return false;
  const earliest = startedAt - SIGHTING_LEAD_MS;
  for (const entry of conversations.values()) {
    const held = entry.sightings.filter((at) => at >= earliest).length;
    if (held > 0 && held < claiming.size) return true;
  }
  return false;
}

/**
 * Whether a ChatGPT page could still report something about the call in flight.
 *
 * Asked of the bridge, which hears from the extension directly, rather than of this
 * module's own map of live conversations. The map is memory: it is empty for a while after
 * the app restarts even though the same Chrome tab never closed and is still polling. A
 * call arriving in that window would see nothing, decide the answer was already final and
 * file the browser's own work as unplaceable — a couple of milliseconds before the page
 * reported the very block that would have placed it.
 *
 * The cost of asking the wider question is that a phone-driven call pays the grace while
 * any ChatGPT tab is open. It is paid off the connector's response path, so nobody waits
 * on it, and the honest answer is worth more than the milliseconds.
 */
let browserReporterPresent: () => boolean = () => false;

export function setBrowserReporterPresent(present: () => boolean): void {
  browserReporterPresent = present;
}

function browserCouldReport(): boolean {
  // Only chats still reporting. A remembered one is exactly the case this must say no to:
  // with the browser gone there is nothing coming, and waiting for it spends the grace
  // period on every call before answering the same way regardless.
  if ([...conversations.values()].some(stillReporting)) return true;
  try {
    return browserReporterPresent();
  } catch {
    return false;
  }
}

/**
 * Waits briefly for the page to report the block that belongs to a call in flight.
 *
 * The page renders the block as the model emits the call and reports it on its own tick,
 * so for a fast tool the result can beat the evidence by a second or so. That is a race,
 * not an absence, and losing it would file a chat's own work outside it. The wait has to
 * cover the page not having reported the *turn* yet either, which is the same race one
 * step earlier and the likeliest one for a quick read: requiring a turn to be visibly in
 * flight before waiting would fail exactly the calls this is for.
 *
 * So the test for whether waiting can help is whether any ChatGPT page is there to report
 * anything. When none is — no tab open, or the call came from the phone — the answer is
 * already final and is taken immediately.
 *
 * This deliberately never runs on the path that answers ChatGPT: recordToolCall starts it
 * and moves on, so the wait costs the caller nothing. It is event-driven, so a block that
 * arrives wakes it at once, and the full grace is only ever spent by a call that has no
 * block coming.
 */
async function awaitSighting(
  agent: string | null,
  tool: string,
  startedAt: number,
  durationMs: number,
  requestId: string | null = null
): Promise<Target> {
  const deadline = Date.now() + SIGHTING_GRACE_MS;
  const ticket = nextTicket++;
  const span: Claim = { from: startedAt, to: startedAt + Math.max(0, durationMs) };
  claiming.set(ticket, span);
  // Whether this call was ever racing another that actually ran alongside it. Sticky,
  // because a race that has ended still happened: the ambiguity between two simultaneous
  // callers is not resolved by one of them timing out first, and treating it as resolved is
  // how the straggler ends up with the other device's evidence. See claimGeneration.
  let contested = false;
  try {
    for (;;) {
      // Overlap or short evidence, never mere company. Every call here is waiting for the
      // page to catch up, and two calls waiting at the same time is the normal shape of one
      // chat working through a list. See `claiming` and shortEvidence.
      //
      // `competing` stays the count of everything unplaced, because that one guards a scarce
      // consumable: a block may only be awarded when the conversation has shown at least as
      // many as there are calls that could take it, and that is true however they were
      // spaced.
      contested = contested || overlapping(ticket, span) > 0 || shortEvidence(startedAt);
      const target = pickTarget(agent, tool, startedAt, claiming.size, contested, requestId);
      // Evidence ends the wait; the absence of evidence does not. `agent`, `turn` and a
      // dead end are all findings about this call. A sole live generation is not one: it
      // is what is left when nothing has identified the caller *yet*, and the whole reason
      // this grace window exists is that the page reports the thing that would identify it
      // late. Returning on it immediately meant a fast call was filed into whichever chat
      // happened to be generating a beat before the request naming the tool arrived — and
      // that request might have named a different conversation, or contradicted this one.
      // So the weak grade is a candidate held until the window closes, re-evaluated on
      // every tick so a veto that appears in the meantime still takes it away.
      if (target.conversationId !== null && target.attribution !== 'generation') return target;
      if (!browserCouldReport()) return target;
      if (Date.now() >= deadline) {
        // Giving up is not a finding about this call, so it must not turn contested
        // evidence into clean evidence for whoever is still waiting. Two calls and one
        // block means the block cannot be placed; if this call simply timed out first,
        // the block would become unique the moment it left and the *other* call would
        // take it — which, when this was the browser's call and that one came from the
        // phone, is precisely the swap the whole mechanism exists to prevent.
        burnContested(startedAt);
        return target;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const at = sightingWaiters.indexOf(wake);
          if (at >= 0) sightingWaiters.splice(at, 1);
          resolve();
        }, SIGHTING_POLL_MS);
        timer.unref?.();
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        sightingWaiters.push(wake);
      });
    }
  } finally {
    claiming.delete(ticket);
  }
}

/** Set by the agent broker so a worker's calls land in that worker's own session. */
let agentConversationLookup: (agent: string) => string | null = () => null;
let agentBinder: (agent: string, conversationId: string) => void = () => undefined;

export function setAgentConversationLookup(lookup: (agent: string) => string | null): void {
  agentConversationLookup = lookup;
}

/** Set by the agent broker, for the deferred prime binding in recordToolCall. */
export function setAgentBinder(bind: (agent: string, conversationId: string) => void): void {
  agentBinder = bind;
}

function bindAgentConversation(agent: string, conversationId: string): void {
  try {
    agentBinder(agent, conversationId);
  } catch (err) {
    logWarn(`could not bind ${agent} to its conversation: ${(err as Error).message}`);
  }
}

function agentConversation(agent: string): string | null {
  try {
    return agentConversationLookup(agent);
  } catch {
    return null;
  }
}

/**
 * The session an event is physically written to.
 *
 * Anything that could not be tied to a conversation goes to the unattributed stream.
 * The previous behaviour — fall back to whichever session was written to last — was
 * the dangerous one: with two workers generating at once it appended one agent's calls
 * into the other's raw history, and nothing downstream could tell that had happened.
 */
async function targetSession(target: Target): Promise<string | null> {
  if (target.conversationId) return sessionForConversation(target.conversationId);
  return ensureUnattributedSession();
}

async function storeImage(sessionId: string, base64: string, mimeType: string): Promise<AssetRef | null> {
  try {
    const used = assetBytes.get(sessionId) ?? 0;
    if (used >= MAX_SESSION_ASSET_BYTES) return null;
    const data = Buffer.from(base64, 'base64');
    if (data.length === 0 || data.length > MAX_ASSET_BYTES) return null;
    const asset = await writeAsset(sessionId, data, mimeType);
    assetBytes.set(sessionId, used + data.length);
    return asset;
  } catch (err) {
    logWarn(`session asset not stored: ${(err as Error).message}`);
    return null;
  }
}

// ------------------------------------------------------- extension events

/** One observation from the ChatGPT page. Validated by the bridge before it lands. */
export interface ChatObservation {
  kind:
    | 'user_message'
    | 'assistant_message'
    | 'progress'
    | 'page_tool'
    | 'turn_start'
    | 'turn_state'
    | 'turn_end'
    | 'chat_error'
    | 'tool_block'
    | 'tool_evidence';
  time: number;
  text?: string;
  messageId?: string;
  turnId?: string;
  final?: boolean;
  /** turn_state only: whether direct page generation evidence is visible. */
  active?: boolean;
  outcome?: TurnOutcome;
  detail?: string;
  /** tool_block only: how many tool blocks this turn has rendered so far. */
  count?: number;
  /** progress only: the page's identity for the commentary item this text belongs to. */
  progressId?: string;
  /** tool_evidence only: the connector requests this turn's message model holds. */
  calls?: PageCallEvidence[];
}

/**
 * One connector request, as the page's own message model describes it.
 *
 * Deliberately tiny. The tool name is the whole point — it is what makes this a match on
 * *which* call rather than on "a call happened" — and nothing here carries an argument
 * value, a result body, or anything else the page could be induced to leak through it.
 */
export interface PageCallEvidence {
  /** ChatGPT's message id for the request, which is what makes this idempotent. */
  messageId: string;
  tool: string;
  /** Position within the turn, used only to break ties between same-tool requests. */
  order: number;
  /** Whether the page has seen a result come back yet. Recorded for diagnosis only. */
  answered: boolean;
  /**
   * ChatGPT's own request id, and its own creation time in seconds.
   *
   * The id is what ties this request to the MCP call it issued: the connector request
   * arrives carrying the same `wfr_…`. `at` cannot do that job — it is when the extension
   * *observed* the row, a poll tick that is phase-shifted per tab, so it cannot even order
   * two workers' requests reliably, whatever it looks like it is doing.
   */
  requestId?: string | null;
  createTime?: number | null;
}

/** Identified page items held per conversation before the oldest are dropped. */
const MAX_LIVE_ITEMS = 200;
/**
 * How many (id, text) occurrences one conversation remembers.
 *
 * Reached only by a chat that genuinely says that many things: a tab left open for days
 * reports the same visible transcript on every tick and adds nothing. Oldest goes first,
 * which is the right end to lose — a reload replays the *visible* transcript, and what
 * has scrolled out of the page cannot be offered again.
 */
const MAX_MESSAGE_OCCURRENCES = 2_000;

/**
 * Stores one visible commentary item, superseding the record it already has.
 *
 * The page reports the item's whole current text every time it changes, under an id that
 * is stable for as long as the item is. So the newest snapshot simply *is* the item, and
 * what gets written is that snapshot, marked with the id and the seq of the first write so
 * every reader folds the run back into the one caption it is.
 *
 * This deliberately no longer accumulates, and the accumulation is worth naming because it
 * is what shipped and what failed. The previous version treated each snapshot as a set of
 * lines to union into the lines it already held. Live, ChatGPT's commentary container holds
 * both the raw streaming buffer and the parsed markdown of the same sentence at once, so a
 * snapshot's own text already reads `…basically confirms` followed by `…basically confirms
 * the gate theory`. Union against the previous snapshot could not recognise that as the
 * same sentence, appended it, and the next snapshot then contained *that* — one recorded
 * caption grew from 104 characters to 2,251 across five events, saying the same thing five
 * times over. Replacing cannot compound: the stored text is never longer than what the page
 * currently shows.
 *
 * A snapshot the held text already contains is a shrink or a redraw and is dropped, so a
 * container that momentarily loses its tail does not rewrite the caption backwards.
 *
 * Returns false when nothing was written, so the caller does not count it as stored.
 */
async function recordProgress(
  sessionId: string,
  live: LiveConversation | undefined,
  item: ChatObservation,
  base: { time: number; source: 'extension'; turnId?: string; agent?: string }
): Promise<boolean> {
  const incoming = (item.text ?? '').trim();
  if (!incoming) return false;
  const id = live && item.progressId ? continuedItem(live, item.progressId, incoming, base.turnId) : item.progressId;
  if (!live || !id) {
    // No identity to grow: the old behaviour, which is the honest fallback for a page whose
    // commentary this build cannot name.
    await appendEvent(sessionId, {
      ...base,
      kind: 'progress',
      message: await storeText(sessionId, incoming, 2000)
    });
    return true;
  }

  const held = live.progress.get(id);
  if (held && held.text.includes(incoming)) return false;

  const event = await appendEvent(sessionId, {
    ...base,
    // The item is where it first appeared, not where it last grew. A caption that keeps
    // growing while three tool calls run belongs above those calls, which is where it was
    // written; stamping each growth with its own time would drag it below them.
    time: held ? held.time : base.time,
    kind: 'progress',
    message: await storeText(sessionId, incoming, 4000),
    progressId: id,
    ...(held ? { origin: held.seq } : {})
  });
  live.progress.set(id, {
    seq: held ? held.seq : event.seq,
    time: held ? held.time : base.time,
    text: incoming,
    turnId: held?.turnId ?? base.turnId
  });
  trimLiveItems(live.progress);
  return true;
}

/**
 * The identity this snapshot should be recorded under: its own, or the one it continues.
 *
 * A stamp already holding a record is taken at face value — that is the ordinary path and
 * it must stay cheap. A stamp seen for the first time is checked against the caption this
 * turn is currently growing: if the snapshot starts with the whole of that caption's text,
 * the page re-stamped one sentence rather than starting a second one, and the alias makes
 * every later tick land on the original record. Only the newest caption of the same turn is
 * considered, and only a prefix counts — two genuinely different captions do not begin with
 * each other, but one that is still being typed always begins with what it had a tick ago.
 */
function continuedItem(live: LiveConversation, id: string, incoming: string, turnId?: string): string {
  const alias = live.progressAlias.get(id);
  if (alias) return alias;
  if (live.progress.has(id)) return id;

  let newest: { id: string; record: ProgressRecord } | null = null;
  for (const [held, record] of live.progress) {
    if (record.turnId !== turnId) continue;
    if (!newest || record.seq > newest.record.seq) newest = { id: held, record };
  }
  if (!newest || !incoming.startsWith(newest.record.text)) return id;

  live.progressAlias.set(id, newest.id);
  trimLiveItems(live.progressAlias);
  return newest.id;
}

/**
 * Stores one visible ChatGPT-native activity row, superseding the record it already has.
 *
 * The same contract as `recordProgress`, for the same reason. ChatGPT rewrites an activity
 * row's label as the step finishes, and the extension used to name each row by its position
 * in the turn plus a hash of that label — so "Inspecting project files" and "Inspected
 * project files" were two different rows, and a re-layout that shifted the row's index made
 * a third. One recorded session held fifty-four `page_tool` events for what the page had
 * shown as roughly a dozen steps.
 */
async function recordPageTool(
  sessionId: string,
  live: LiveConversation | undefined,
  item: ChatObservation,
  base: { time: number; source: 'extension'; turnId?: string; agent?: string }
): Promise<boolean> {
  const id = item.messageId;
  const label = (item.text ?? '').slice(0, 300).trim();
  if (!id || !label) return false;
  if (!live) {
    await appendEvent(sessionId, { ...base, kind: 'page_tool', messageId: id, label });
    return true;
  }

  const held = live.pageTools.get(id);
  if (held && held.text === label) return false;

  const event = await appendEvent(sessionId, {
    ...base,
    time: held ? held.time : base.time,
    kind: 'page_tool',
    messageId: id,
    label,
    ...(held ? { origin: held.seq } : {})
  });
  live.pageTools.set(id, { seq: held ? held.seq : event.seq, time: held ? held.time : base.time, text: label });
  trimLiveItems(live.pageTools);
  return true;
}

function trimLiveItems(held: Map<string, unknown>): void {
  if (held.size <= MAX_LIVE_ITEMS) return;
  for (const key of [...held.keys()].slice(0, held.size - MAX_LIVE_ITEMS)) held.delete(key);
}

export async function recordChatObservations(
  conversationId: string,
  observations: readonly ChatObservation[],
  agent?: string | null
): Promise<{ sessionId: string | null; stored: number }> {
  if (!recordingEnabled()) return { sessionId: null, stored: 0 };
  const firstUser = observations.find((item) => item.kind === 'user_message');
  const sessionId = await sessionForConversation(
    conversationId,
    firstUser?.text ? firstUser.text.slice(0, 80) : undefined
  );
  if (!sessionId) return { sessionId: null, stored: 0 };
  const live = conversations.get(conversationId);
  let stored = 0;
  // A cold/reloaded page can discover that a turn finished while the content script was
  // absent. There is then a new final assistant message but no live `generating -> false`
  // transition for content.js to report, and nothing would close the turn.
  //
  // What this must not do is invent a lifecycle event out of a page-supplied turn id. The
  // page reuses those ids, so a reload showing the whole transcript again carries a final
  // tagged with an id whose turn ended many turns ago; closing it appended a second
  // completed turn 6 in the middle of turn 11. So the recovery is state-based: it may only
  // close a turn this very log opened and never ended, which `openTurns` knows even across
  // an app restart. Everything else is backfill — historical prose, stored as prose,
  // changing no turn's lifecycle.
  const explicitEnds = new Set(
    observations.filter((item) => item.kind === 'turn_end' && item.turnId).map((item) => item.turnId as string)
  );
  const recoveredFinal = [...observations]
    .reverse()
    .find(
      (item) =>
        item.kind === 'assistant_message' &&
        item.final === true &&
        item.turnId &&
        !explicitEnds.has(item.turnId) &&
        live?.openTurns.has(item.turnId) === true
    );

  for (const item of observations) {
    // A reloaded tab reports the whole visible conversation again. Backfilling an
    // older chat is the point; storing the same message twice is not — but "the same
    // message" means the same words, not merely the same id. The renderer gives streaming
    // assistant prose no id of its own, so the extension derives one, and an id that turns
    // out to repeat must cost one duplicate at worst rather than every answer after the
    // first. `page_tool` is excluded here entirely: its whole model is that the same id is
    // reported again as the row's label is rewritten, and recordPageTool decides.
    if (item.kind === 'user_message' || item.kind === 'assistant_message') {
      if (item.messageId && live) {
        const seen = occurrence(item.messageId, textIdentity(item.text ?? ''));
        // Also the identity a log written before digests existed would hold, so upgrading
        // does not replay every message in every open chat exactly once.
        if (live.messageIds.has(seen) || live.messageIds.has(occurrence(item.messageId, legacyIdentity(item.text ?? '')))) {
          continue;
        }
        live.messageIds.add(seen);
        // Bounded: a tab left open for days reports the same visible transcript on every
        // tick, so this only grows when something genuinely new is said, but a very long
        // chat should still not be able to grow it without limit.
        if (live.messageIds.size > MAX_MESSAGE_OCCURRENCES) {
          live.messageIds.delete(live.messageIds.values().next().value as string);
        }
      }
    }
    const base = {
      time: item.time,
      source: 'extension' as const,
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...(agent ? { agent } : {})
    };
    switch (item.kind) {
      case 'user_message':
        await appendEvent(sessionId, {
          ...base,
          kind: 'user_message',
          message: await storeText(sessionId, item.text ?? '', MAX_USER_MESSAGE_CHARS, { identify: true }),
          ...(item.messageId ? { messageId: item.messageId } : {})
        });
        break;
      case 'assistant_message':
        await appendEvent(sessionId, {
          ...base,
          kind: 'assistant_message',
          message: await storeText(sessionId, item.text ?? '', MAX_MESSAGE_CHARS, { identify: true }),
          final: item.final === true,
          ...(item.messageId ? { messageId: item.messageId } : {})
        });
        if (item === recoveredFinal && item.turnId) {
          if (live) {
            live.openTurns.delete(item.turnId);
            // Only if this is the turn the page is still holding open. A recovery for an
            // earlier turn says nothing about what is generating now.
            if (live.turnId === item.turnId) {
              live.turnStartedAt = null;
              live.turnId = null;
            }
          }
          await appendEvent(sessionId, {
            time: item.time,
            source: 'extension',
            kind: 'turn_end',
            turnId: item.turnId,
            outcome: 'completed',
            detail: 'recovered from a final assistant message after the ChatGPT page reloaded',
            ...(agent ? { agent } : {})
          });
          stored++;
        }
        break;
      case 'progress': {
        const written = await recordProgress(sessionId, live, item, base);
        if (!written) continue;
        break;
      }
      case 'page_tool': {
        const written = await recordPageTool(sessionId, live, item, base);
        if (!written) continue;
        break;
      }
      case 'chat_error':
        await appendEvent(sessionId, {
          ...base,
          kind: 'chat_error',
          message: await storeText(sessionId, item.text ?? '', 2000)
        });
        break;
      case 'turn_start':
        if (live) {
          // Only if the page saw this recently. The extension journals observations while
          // the app is unreachable and replays them on reconnect, so a turn that started
          // ten minutes ago arrives looking brand new — and a chat wrongly believed to be
          // mid-turn *right now* is the one thing that could hand another device's call to
          // it. The same rule the block and named-call evidence already follow.
          live.turnStartedAt = Date.now() - item.time < SIGHTING_TTL_MS ? item.time : null;
          live.turnId = item.turnId ?? null;
          live.generationVisible = true;
          live.blocksSeen = 0;
          // A new turn's commentary is new commentary, whatever it says. Carrying the last
          // turn's items over would let a caption from the previous turn be superseded by
          // this one's — and the extension already mints per-generation ids, so an entry
          // surviving here could only ever match the wrong thing.
          live.progress.clear();
          live.pageTools.clear();
          if (item.turnId) live.openTurns.add(item.turnId);
        }
        await appendEvent(sessionId, { ...base, kind: 'turn_start' });
        break;
      // Ephemeral only. A turn can stay logically open through a missing stop control, but
      // weak generation fallback must not use that ambiguous interval to steal another
      // device's call. Strong named/page evidence still carries the durable turn id.
      case 'turn_state':
        if (live && (!item.turnId || live.turnId === item.turnId)) live.generationVisible = item.active === true;
        continue;
      // Not stored: this is the page proving that *this* conversation made a tool call,
      // which is a fact about attribution rather than a thing that happened in the chat.
      // See noteToolBlocks and claimConversation.
      case 'tool_block':
        if (live) noteToolBlocks(live, Math.max(0, Math.floor(item.count ?? 0)), item.time);
        continue;
      // Also not stored, and for the same reason: this is the page describing which calls
      // it made, which is a fact about attribution rather than something that happened in
      // the chat. The calls themselves are recorded by the connector, once each.
      case 'tool_evidence':
        if (live && item.calls && item.calls.length > 0) noteCallEvidence(live, item.calls, item.time, item.turnId ?? null);
        continue;
      case 'turn_end':
        if (live) {
          live.turnStartedAt = null;
          live.turnId = null;
          live.generationVisible = false;
          // A tool call is recorded before its result reaches ChatGPT, and ChatGPT cannot
          // end the turn before that result arrives. So evidence still unclaimed when the
          // turn ends belongs to no call this app will ever see, and keeping it would let
          // a finished turn vouch for somebody else's next one.
          live.blocksSeen = 0;
          live.sightings.length = 0;
          live.calls.clear();
          if (item.turnId) live.openTurns.delete(item.turnId);
        }
        await appendEvent(sessionId, {
          ...base,
          kind: 'turn_end',
          outcome: item.outcome ?? 'unknown',
          ...(item.detail ? { detail: item.detail } : {})
        });
        break;
    }
    stored++;
  }
  notifyChanged();
  return { sessionId, stored };
}

/** Records something the app itself decided, e.g. a saved handoff. */
export async function recordNote(sessionId: string, text: string): Promise<void> {
  if (!recordingEnabled()) return;
  await appendEvent(sessionId, {
    time: Date.now(),
    source: 'app',
    kind: 'note',
    message: await storeText(sessionId, text, 4000)
  }).catch(() => undefined);
  notifyChanged();
}

/**
 * Records a brokered message in the relevant agent's own session.
 *
 * Called twice per message and on purpose. `sent` goes into the sender's history when
 * the broker accepts it; `delivered` goes into the recipient's when the recipient
 * proves it received it. Without the second one a worker's report would live only in
 * the worker's session and the broker's volatile queue, so compacting the prime — the
 * exact thing Compact & Resume does while workers keep running — would produce a brief
 * that omits everything the workers had told it.
 *
 * A message can be offered several times before it is acknowledged; only the single
 * acknowledgement produces a `delivered` record, so retries never duplicate history.
 */
export async function recordAgentMessage(message: AgentMessage, delivery: 'sent' | 'delivered'): Promise<void> {
  if (!recordingEnabled()) return;
  const owner = delivery === 'sent' ? message.from : message.to;
  try {
    const conversationId = agentConversation(owner);
    const sessionId = conversationId ? await sessionForConversation(conversationId) : await ensureUnattributedSession();
    if (!sessionId) return;
    await appendEvent(sessionId, {
      time: delivery === 'sent' ? message.time : Date.now(),
      source: 'app',
      kind: 'agent_message',
      agent: owner,
      messageId: message.id,
      from: message.from,
      to: message.to,
      message: await storeText(sessionId, message.text, MAX_MESSAGE_CHARS),
      delivery
    });
    notifyChanged();
  } catch (err) {
    logWarn(`session recorder could not store an agent message: ${(err as Error).message}`);
  }
}

export async function recordHandoff(
  sessionId: string,
  handoffId: string,
  chars: number,
  reason: string
): Promise<void> {
  await appendEvent(sessionId, {
    time: Date.now(),
    source: 'app',
    kind: 'handoff',
    handoffId,
    chars,
    reason
  }).catch(() => undefined);
  notifyChanged();
}

/**
 * Called when a conversation page goes away.
 *
 * `pagehide` cannot tell a reload from a real tab close, and ChatGPT may keep a server
 * generation alive while the page is absent. Calling that "interrupted" was therefore
 * too strong and made a reload look like a failed turn even when the final answer was
 * waiting on the page a moment later. Record the lifecycle break as unknown; if the
 * chat reopens with a new final assistant message, recordChatObservations reconciles it
 * to a later completed turn_end.
 */
export async function closeConversation(conversationId: string): Promise<void> {
  const live = conversations.get(conversationId);
  if (!live) return;
  if (live.turnStartedAt !== null) {
    await appendEvent(live.sessionId, {
      time: Date.now(),
      source: 'extension',
      kind: 'turn_end',
      outcome: 'unknown',
      detail: 'the ChatGPT page detached while generating; outcome may be recovered when the chat reopens'
    }).catch(() => undefined);
  }
  conversations.delete(conversationId);
  await endSession(live.sessionId).catch(() => undefined);
  notifyChanged();
}

/**
 * Points the live recorder at the ChatGPT conversation that has replaced this session's.
 *
 * The in-memory half of the Compact & Resume commit. Chat B is a different page, so
 * everything that describes the *page* starts empty — its message ids, its open turns, its
 * sightings and its in-flight calls all belong to chat A's DOM and would otherwise make B's
 * first observations look like duplicates of A's. Everything that describes the *session* —
 * which is to say the session id itself, and through it the whole recorded history — is
 * exactly what does not move.
 *
 * Chat A's entry is dropped outright. A stale tab still sitting on A must not go on
 * appending into a session that has moved; without the mapping its next observation starts
 * a fresh session of its own, which is the honest outcome.
 *
 * Pure map work and total, because the commit calls it only once the durable session write
 * has landed and nothing after that point is allowed to fail.
 */
export function rebindConversation(sessionId: string, fromConversationId: string, toConversationId: string): void {
  const previous = conversations.get(fromConversationId);
  if (previous?.sessionId === sessionId) conversations.delete(fromConversationId);
  conversations.set(toConversationId, {
    conversationId: toConversationId,
    sessionId,
    turnStartedAt: null,
    turnId: null,
    generationVisible: false,
    lastSeen: Date.now(),
    messageIds: new Set<string>(),
    openTurns: new Set<string>(),
    blocksSeen: 0,
    sightings: [],
    calls: new Map(),
    progress: new Map(),
    pageTools: new Map(),
    progressAlias: new Map()
  });
  lastActiveSessionId = sessionId;
  notifyChanged();
}

/**
 * Detaches a session from everything still pointing at it, before it is deleted.
 *
 * Deleting a session whose ChatGPT tab is still open used to leave the conversation
 * mapped to a folder that no longer existed, so the next observation from that tab
 * appended into nothing and recording for that chat silently stopped. Forgetting the
 * mapping means the next event starts a fresh session instead, which is the only
 * outcome that keeps recording alive.
 */
export function forgetSession(sessionId: string): string[] {
  const affected: string[] = [];
  for (const [conversationId, entry] of conversations) {
    if (entry.sessionId !== sessionId) continue;
    conversations.delete(conversationId);
    affected.push(conversationId);
  }
  if (unattributedSessionId === sessionId) unattributedSessionId = null;
  if (lastActiveSessionId === sessionId) lastActiveSessionId = null;
  assetBytes.delete(sessionId);
  if (affected.length > 0) {
    logInfo(`session ${sessionId} deleted while live; ${affected.length} conversation(s) will start a new session`);
  }
  return affected;
}

/** Rough token estimate for a session, from the text actually stored. */
export async function sessionTokens(sessionId: string): Promise<number> {
  const summary = await getSession(sessionId);
  return summary?.estimatedTokens ?? 0;
}

export function estimate(text: string): number {
  return estimateTokens(text);
}

/** Test seam. */
export function resetRecorderForTests(): void {
  conversations.clear();
  pendingOrigins.clear();
  assetBytes.clear();
  unattributedSessionId = null;
  lastActiveSessionId = null;
  agentConversationLookup = () => null;
  agentBinder = () => undefined;
  browserReporterPresent = () => false;
  claiming.clear();
  sightingWaiters.length = 0;
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
}

export function markSessionActive(sessionId: string): void {
  lastActiveSessionId = sessionId;
}

export type { SessionSummary, SessionEvent };
