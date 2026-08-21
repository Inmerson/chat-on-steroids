/**
 * The one-time transaction that moves a local session from one ChatGPT chat to another.
 *
 * Compact & Resume is not "summarise, then start again somewhere else". The local session is
 * the durable identity — its recorded history, its title, its workspace, its handoffs, and
 * the swarm it may be coordinating all belong to it — and chats A and B are only two ChatGPT
 * frontends attached to it in turn. So there is exactly one state-transfer mechanism here,
 * the rebind, and the handoff brief is *model context only*: it exists so the model in chat
 * B knows what was happening, not so the app can reconstruct anything from it.
 *
 * ## The transaction
 *
 *   open    — the user pressed the button. The prime binding is pinned so the run does not
 *             die when chat A goes away, and nothing else has changed yet.
 *   summary — ChatGPT's final answer for that exact compaction turn arrived and was stored
 *             as the handoff. Only now is there anything worth opening a chat for.
 *   claim   — one replacement chat, and only one, takes this continuation. A second claimant
 *             is refused rather than served, which is what stops two chats from both
 *             believing they are the continuation.
 *   commit  — chat B proved it exists and accepted the handoff, so the session moves.
 *   abort   — anything went wrong. The session stays attached to chat A, which is the
 *             failure mode every step is arranged around.
 *
 * ## Why commit cannot half-happen
 *
 * The commit is three phases, in this order and for this reason:
 *
 *   preflight — everything that could *decline* is asked before anything is written, and the
 *               answers are pinned. The swarm handover is the one that matters: it is frozen
 *               here, and a session that is a run's prime with no usable handover is refused
 *               outright rather than moved without its swarm.
 *   durable   — the session rebind, the only step that can fail. It stages the change, writes
 *               it atomically, and publishes it into memory only once the write has landed, so
 *               a failure leaves chat A attached in memory *and* on disk. On failure the
 *               preflight is undone: the freeze is released and the transaction is claimable
 *               again.
 *   publish   — the live recorder mapping, the workspace key, the swarm's prime binding. Pure
 *               in-memory map work, none of it able to throw or to change its mind, running
 *               only once the durable record already says chat B.
 *
 * So there is no window in which the session is in B while the workspace or the swarm is
 * still in A. The one thing the publish phase can still find missing is the run itself, if it
 * ended while the write was in flight — and a run that no longer exists has no prime left in
 * chat A to be inconsistent with.
 *
 * The state is flipped to `committing` *synchronously*, before the first await, so two
 * replacement chats racing to commit cannot both pass the check; the loser is refused and
 * the winner's failure restores the state for a retry. Nothing else may move the state
 * backwards out of `committing` — see {@link claimContinuation}, which is monotonic for
 * exactly that reason.
 */

import { randomBytes } from 'node:crypto';
import type { Handoff } from '../../shared/session.js';
import { logInfo, logWarn } from '../logger.js';
import {
  beginPrimeTransfer,
  cancelPrimeTransfer,
  commitPrimeTransfer,
  freezePrimeTransfer,
  thawPrimeTransfer
} from '../agents.js';
import { moveChatWorkspace } from '../workspace.js';
import { writeDurableNow, writeDurableSoon } from '../durable.js';
import { createHandoff } from './handoff.js';
import { rebindConversation } from './recorder.js';
import { getSession, readHandoff, rebindSession } from './store.js';

/**
 * How long a continuation may stay open.
 *
 * Long enough for a slow generation plus a browser that has to be launched, short enough
 * that an abandoned one releases the prime binding and lets an unattended run end rather
 * than staying transferable indefinitely.
 */
export const CONTINUATION_TTL_MS = 10 * 60_000;

export type ContinuationState =
  /** Waiting for ChatGPT's final answer to the compaction turn. */
  | 'awaiting-summary'
  /** The brief is stored; waiting for a replacement chat to claim it. */
  | 'awaiting-chat'
  /** A replacement chat has claimed it and is being opened. */
  | 'claimed'
  /** The rebind is in flight. Set synchronously so two commits cannot race. */
  | 'committing'
  | 'committed'
  | 'aborted';

interface Continuation {
  token: string;
  sessionId: string;
  /** Chat A: where the session is attached until the commit lands. */
  from: string;
  openedAt: number;
  state: ContinuationState;
  /** The brief, once captured. Handed to whoever opens chat B, and to nothing else. */
  summary: string;
  handoffId: string | null;
  /**
   * The capture in flight, or the settled one. The single-flight lock for {@link attachSummary}.
   */
  capture: Promise<Handoff> | null;
  /**
   * The stored handoff, kept so a repeated capture can be answered with the same success.
   *
   * The connector loses tool results. If the capture's answer never arrives and the page
   * reports the same finished generation again, "null" would read as a failure and start
   * another flow; handing back the handoff that already exists is both true and idempotent.
   */
  handoff: Handoff | null;
  /** Whoever claimed it, so a second claimant is recognised as one. */
  claimedBy: string | null;
  /** Chat B while the durable commit is in flight; persisted for restart recovery. */
  to: string | null;
  /**
   * Whether the compaction instruction has already been handed out for this transaction.
   *
   * Handed out once, and once only. The instruction is not information — submitting it *is*
   * the compaction — so a page asking again after a lost response, a reload, or a second
   * press must not be given something it can send. Two submissions of one prompt are two
   * generations both trying to be the brief, and only one of them can be, which is the
   * ambiguity this whole transaction exists to remove.
   */
  armed: boolean;
  error: string | null;
}

/** At most one continuation per session, and at most one open per prime chat. */
const byToken = new Map<string, Continuation>();
export const CONTINUATIONS_STATE = 'continuations';

interface ContinuationRecord {
  token: string;
  sessionId: string;
  from: string;
  to: string | null;
  openedAt: number;
  state: ContinuationState;
  summary: string;
  handoffId: string | null;
  claimedBy: string | null;
  armed: boolean;
  error: string | null;
}

export interface ContinuationSnapshot {
  version: 1;
  savedAt: number;
  entries: ContinuationRecord[];
}

export function snapshotContinuations(): ContinuationSnapshot {
  return {
    version: 1,
    savedAt: Date.now(),
    entries: [...byToken.values()].map((entry) => ({
      token: entry.token,
      sessionId: entry.sessionId,
      from: entry.from,
      to: entry.to,
      openedAt: entry.openedAt,
      state: entry.state,
      summary: entry.summary.slice(0, 512 * 1024),
      handoffId: entry.handoffId,
      claimedBy: entry.claimedBy,
      armed: entry.armed,
      error: entry.error
    }))
  };
}

function changed(): void {
  writeDurableSoon(CONTINUATIONS_STATE, snapshotContinuations());
}

async function changedNow(): Promise<void> {
  await writeDurableNow(CONTINUATIONS_STATE, snapshotContinuations());
}

export interface ContinuationView {
  token: string;
  sessionId: string;
  from: string;
  state: ContinuationState;
  handoffId: string | null;
  error: string | null;
  openedAt: number;
  armed: boolean;
}

const view = (entry: Continuation): ContinuationView => ({
  token: entry.token,
  sessionId: entry.sessionId,
  from: entry.from,
  state: entry.state,
  handoffId: entry.handoffId,
  error: entry.error,
  openedAt: entry.openedAt,
  armed: entry.armed
});

const isOpen = (entry: Continuation): boolean =>
  entry.state !== 'committed' && entry.state !== 'aborted' && Date.now() - entry.openedAt < CONTINUATION_TTL_MS;

function sweep(): void {
  for (const entry of [...byToken.values()]) {
    // A commit in flight is never swept. It holds a frozen prime handover and an in-flight
    // durable write, and expiring it here would let any passing lookup abort a transaction
    // that is about to land — the write would still complete, on a transaction that had been
    // declared dead and had released the very handover it was carrying. The deadline applies
    // to *waiting*, and once the durable phase starts there is nothing left to wait for.
    if (entry.state === 'committing') continue;
    if (entry.state === 'committed' || entry.state === 'aborted') {
      // Kept briefly so a repeated ack can be answered with "already done" rather than with
      // a fresh transaction, then forgotten.
      if (Date.now() - entry.openedAt > CONTINUATION_TTL_MS * 2) byToken.delete(entry.token);
      continue;
    }
    if (Date.now() - entry.openedAt >= CONTINUATION_TTL_MS) {
      abortContinuation(entry.token, 'it took too long and was given up on');
    }
  }
}

/** The open continuation for a session, if there is one. */
export function continuationForSession(sessionId: string): ContinuationView | null {
  sweep();
  for (const entry of byToken.values()) {
    if (entry.sessionId === sessionId && isOpen(entry)) return view(entry);
  }
  return null;
}

export function continuationByToken(token: string): ContinuationView | null {
  sweep();
  const entry = byToken.get(token);
  return entry ? view(entry) : null;
}

/**
 * Begins a continuation for the session attached to `fromConversationId`.
 *
 * Idempotent per session: pressing the button twice is one transaction, answered with the
 * one already running. That is deliberate — the previous design let each press become its
 * own handoff and its own fresh tab.
 */
export function openContinuation(sessionId: string, fromConversationId: string): ContinuationView {
  sweep();
  const existing = [...byToken.values()].find((entry) => entry.sessionId === sessionId && isOpen(entry));
  if (existing) return view(existing);
  const entry: Continuation = {
    token: randomBytes(16).toString('base64url'),
    armed: false,
    sessionId,
    from: fromConversationId,
    openedAt: Date.now(),
    state: 'awaiting-summary',
    summary: '',
    handoffId: null,
    capture: null,
    handoff: null,
    claimedBy: null,
    to: null,
    error: null
  };
  byToken.set(entry.token, entry);
  // Pin the swarm's prime binding for the duration. Without this the prime chat closing
  // mid-handover would end the very run the handover exists to carry across.
  beginPrimeTransfer(fromConversationId);
  changed();
  logInfo(`continuation ${entry.token.slice(0, 8)} opened for session ${sessionId} in chat ${fromConversationId}`);
  return view(entry);
}

/**
 * Hands the compaction instruction out, once.
 *
 * True means the caller may submit it. False means somebody already has — a duplicate press,
 * a retried request whose answer was lost, a tab reloaded into the same button — and the
 * answer to that is the transaction that already exists, never a second turn writing a
 * second brief.
 */
export function armContinuation(token: string): boolean {
  const entry = byToken.get(token);
  if (!entry || !isOpen(entry) || entry.state !== 'awaiting-summary' || entry.armed) return false;
  entry.armed = true;
  changed();
  return true;
}

/**
 * Stores ChatGPT's final answer for the compaction turn as this session's handoff.
 *
 * The caller is responsible for having captured the answer belonging to that exact
 * generation; this refuses only what it can see is wrong — an empty brief, or one arriving
 * for a continuation that is no longer waiting for it. An empty or interrupted answer leaves
 * the transaction where it was, so the session stays in chat A and nothing is opened.
 *
 * Exactly one handoff is written per continuation. A capture arriving after that one exists
 * is answered with it — the same id, reported as the success it is — because the alternative
 * is a lost tool result looking like a failure and driving a second flow. That holds whether
 * the retry carries the identical text or a re-observed variant of it: there is one brief for
 * this compaction, and it is the one already stored.
 */
export async function attachSummary(token: string, text: string): Promise<Handoff | null> {
  const brief = text.trim();
  if (!brief) return null;
  return capture(token, brief, async (entry) =>
    createHandoff({
      sessionId: entry.sessionId,
      text: brief,
      reason: 'compact and resume'
    })
  );
}

/**
 * The one path a brief becomes this continuation's.
 *
 * Single-flight, and the lock is taken before the first await. Two captures of the same
 * finished generation — the page reporting it twice, or a retried report racing the original
 * — would otherwise both see `awaiting-summary`, both produce a handoff, and both store: two
 * briefs for one compaction, of which the second silently wins. Duplicates wait on the first
 * attempt and are answered with its result.
 */
async function capture(
  token: string,
  text: string,
  produce: (entry: Continuation) => Promise<Handoff>
): Promise<Handoff | null> {
  sweep();
  const entry = byToken.get(token);
  if (!entry) return null;
  // Deliberately ahead of the liveness check: a handoff that was written stays answerable
  // even once the transaction it belonged to has expired or been abandoned. The brief is on
  // disk either way, and telling a retry "no such thing" would be a lie about durable state.
  if (entry.handoff) {
    if (entry.handoff.text.trim() !== text.trim()) {
      logWarn(`continuation ${entry.token.slice(0, 8)} re-captured a different brief; keeping handoff ${entry.handoffId}`);
    }
    return entry.handoff;
  }
  if (entry.capture) return settle(entry, entry.capture);
  if (!isOpen(entry)) return null;
  if (entry.state !== 'awaiting-summary') return null;
  entry.capture = (async () => {
    const handoff = await produce(entry);
    entry.summary = handoff.text;
    entry.handoffId = handoff.id;
    entry.handoff = handoff;
    entry.state = 'awaiting-chat';
    await changedNow();
    logInfo(`continuation ${entry.token.slice(0, 8)} captured handoff ${handoff.id}`);
    return handoff;
  })();
  return settle(entry, entry.capture);
}

/**
 * Awaits one capture attempt on behalf of every caller waiting on it.
 *
 * Both the caller that started the write and the duplicates that joined it come through
 * here, so a failure is the same answer for all of them: null, meaning "not stored, ask
 * again" — rather than a resolved null for one and a rejected promise for the others, which
 * would surface to a retrying page as a tool error for a step that merely has to be redone.
 */
async function settle(entry: Continuation, capture: Promise<Handoff>): Promise<Handoff | null> {
  try {
    return await capture;
  } catch (err) {
    // Nothing was written, so the transaction goes back to waiting for a brief rather than
    // being stuck behind a lock held by an attempt that failed. Cleared only if this is
    // still the attempt that failed, so a retry already in flight is not disturbed.
    if (entry.capture === capture) entry.capture = null;
    logWarn(`continuation ${entry.token.slice(0, 8)} could not store the brief — ${(err as Error).message}`);
    return null;
  }
}

/**
 * Takes this continuation for one replacement chat, and returns the brief to send.
 *
 * One claim, ever. A second claimant — a duplicate command, a second tab redeeming the same
 * marker — is refused, which is the whole of "never allow two replacement chats to claim the
 * same continuation". Re-claiming with the *same* claimant is allowed, because that is a
 * retry of one attempt rather than a second attempt.
 *
 * The state machine only ever moves forwards here. A retry that arrives while the commit is
 * already in flight is answered with the brief — that is all a retrying claimant wants — but
 * must not put the state back to `claimed`, because `committing` is the lock that stops a
 * second {@link commitContinuation} from entering while the first is still awaiting its
 * durable write. Writing the state back was that lock's one escape hatch.
 */
export function claimContinuation(token: string, claimant: string): { summary: string } | null {
  sweep();
  const entry = byToken.get(token);
  if (!entry || !isOpen(entry)) return null;
  if (entry.state === 'awaiting-summary') return null;
  if (entry.claimedBy !== null && entry.claimedBy !== claimant) return null;
  if (entry.state === 'awaiting-chat' || entry.state === 'claimed') {
    entry.claimedBy = claimant;
    entry.state = 'claimed';
    changed();
  }
  // Anything further along — `committing` — keeps its state and is answered read-only.
  return { summary: entry.summary };
}

/**
 * Moves the session to chat B. The only place the attachment ever changes.
 *
 * See the file docblock for the ordering argument. Returns false without changing anything
 * when the continuation is not in a committable state, when chat B is not a real distinct
 * conversation, when the swarm handover this session needs is unavailable, or when the
 * durable rebind failed — in every one of those cases the session is still attached to chat A.
 */
export async function commitContinuation(token: string, toConversationId: string): Promise<boolean> {
  sweep();
  const entry = byToken.get(token);
  if (!entry) return false;
  // A repeated ack for a commit that already landed is that same commit, not a second one.
  if (entry.state === 'committed') return true;
  if (!isOpen(entry)) return false;
  if (entry.state !== 'awaiting-chat' && entry.state !== 'claimed') return false;
  if (!toConversationId || toConversationId === entry.from) return false;

  // Synchronous, before the first await: two replacement chats racing here must not both
  // get past this line.
  const wasClaimed = entry.state === 'claimed';
  entry.state = 'committing';
  entry.to = toConversationId;
  // Recovery intent must be durable before the session's own atomic rebind. If the app
  // stops after that rebind, startup can prove chat B from meta.json and finish publication.
  await changedNow();

  // --- preflight. Everything that may decline, asked before anything is written.
  const swarm = freezePrimeTransfer(entry.from);
  if (swarm === 'unavailable') {
    // This chat is a run's prime and the handover is gone or expired. Moving the session
    // without the swarm would leave a run coordinated by a chat nobody is attached to, so
    // the whole commit is refused and chat A stays exactly as it is.
    entry.state = wasClaimed ? 'claimed' : 'awaiting-chat';
    entry.to = null;
    entry.error = 'the swarm handover expired, so the session stayed in the current chat';
    await changedNow();
    logWarn(`continuation ${entry.token.slice(0, 8)} refused: no usable prime handover from ${entry.from}`);
    return false;
  }

  // --- durable. The only step that can fail.
  const moved = await rebindSession(entry.sessionId, entry.from, toConversationId);
  if (!moved) {
    // Nothing was published, in memory or on disk. Undo the preflight and go back to
    // claimable so the caller may retry.
    if (swarm === 'frozen') thawPrimeTransfer(entry.from);
    entry.state = wasClaimed ? 'claimed' : 'awaiting-chat';
    entry.to = null;
    entry.error = 'the local session could not be moved to the new chat';
    await changedNow();
    logWarn(`continuation ${entry.token.slice(0, 8)} could not rebind session ${entry.sessionId}`);
    return false;
  }

  // --- publish. Total: map work only, on a durable record that already says chat B.
  rebindConversation(entry.sessionId, entry.from, toConversationId);
  moveChatWorkspace(entry.from, toConversationId);
  if (swarm === 'frozen' && !commitPrimeTransfer(entry.from, toConversationId)) {
    // The frozen handover cannot expire, so the only way here is that the run ended outright
    // while the write was in flight. There is no prime left in chat A to be split from.
    logWarn(`continuation ${entry.token.slice(0, 8)} committed after its run ended; no prime to move`);
  }
  entry.state = 'committed';
  entry.to = toConversationId;
  entry.error = null;
  await changedNow();
  logInfo(
    `continuation ${entry.token.slice(0, 8)} committed: session ${entry.sessionId} is now chat ${toConversationId}`
  );
  return true;
}

/**
 * Gives up, leaving the session attached to chat A.
 *
 * Refuses once the durable phase has started. `committing` is the commit's lock, and an
 * abort that could clear it would cancel the frozen prime handover under a write that is
 * still going to land — the session would move on disk while the swarm stayed behind. The
 * commit either succeeds, or restores a claimable state itself and can be aborted then.
 */
export function abortContinuation(token: string, reason: string): boolean {
  const entry = byToken.get(token);
  if (!entry || entry.state === 'committing') return false;
  if (entry.state === 'committed' || entry.state === 'aborted') return false;
  entry.state = 'aborted';
  entry.error = reason;
  cancelPrimeTransfer(entry.from);
  changed();
  logWarn(`continuation ${entry.token.slice(0, 8)} abandoned — ${reason}`);
  return true;
}

/**
 * Restores open continuation transactions after the agent/session projections are loaded.
 *
 * A persisted `committing` record is resolved from the authoritative session meta: if it
 * already names chat B, the durable commit landed and publication is completed; if it still
 * names A, the move did not land and the transaction becomes claimable again. Any third
 * identity is quarantined as aborted rather than guessed across chats.
 */
export async function restoreContinuations(snapshot: ContinuationSnapshot | null): Promise<void> {
  byToken.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.entries)) return;
  const now = Date.now();
  const validStates = new Set<ContinuationState>([
    'awaiting-summary',
    'awaiting-chat',
    'claimed',
    'committing',
    'committed',
    'aborted'
  ]);
  for (const raw of snapshot.entries.slice(0, 32)) {
    if (
      !raw ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(raw.token) ||
      !/^[0-9a-z-]{8,64}$/i.test(raw.sessionId) ||
      typeof raw.from !== 'string' ||
      raw.from.length === 0 || raw.from.length > 256 ||
      !validStates.has(raw.state) ||
      !Number.isFinite(raw.openedAt) ||
      now - raw.openedAt >= CONTINUATION_TTL_MS * 2
    ) {
      continue;
    }
    if (raw.state === 'committed' || raw.state === 'aborted') continue;
    const entry: Continuation = {
      token: raw.token,
      sessionId: raw.sessionId,
      from: raw.from,
      to: typeof raw.to === 'string' && raw.to ? raw.to : null,
      openedAt: raw.openedAt,
      state: raw.state,
      summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 512 * 1024) : '',
      handoffId: typeof raw.handoffId === 'string' ? raw.handoffId : null,
      capture: null,
      handoff: null,
      claimedBy: typeof raw.claimedBy === 'string' ? raw.claimedBy : null,
      armed: raw.armed === true,
      error: typeof raw.error === 'string' ? raw.error : null
    };
    if (entry.handoffId) {
      try {
        entry.handoff = await readHandoff(entry.sessionId, entry.handoffId);
      } catch (err) {
        logWarn(`continuation ${entry.token.slice(0, 8)} handoff recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (entry.state === 'committing') {
      let session = null;
      try {
        session = await getSession(entry.sessionId);
      } catch (err) {
        logWarn(`continuation ${entry.token.slice(0, 8)} session recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (session && entry.to && session.conversationId === entry.to) {
        rebindConversation(entry.sessionId, entry.from, entry.to);
        moveChatWorkspace(entry.from, entry.to);
        commitPrimeTransfer(entry.from, entry.to);
        entry.state = 'committed';
        entry.error = 'Recovered a continuation whose durable session move had completed before restart.';
        logInfo(`continuation ${entry.token.slice(0, 8)} recovered after durable commit`);
      } else if (session && session.conversationId === entry.from) {
        thawPrimeTransfer(entry.from);
        entry.state = entry.claimedBy ? 'claimed' : 'awaiting-chat';
        entry.to = null;
        entry.error = 'Recovered before the durable session move; the continuation can be retried.';
        beginPrimeTransfer(entry.from);
      } else {
        entry.state = 'aborted';
        entry.error = 'Recovery found an unexpected session attachment and refused to guess a chat.';
        cancelPrimeTransfer(entry.from);
      }
    } else if (entry.state !== 'aborted') {
      // A stored brief is required for every post-capture state. Missing/corrupt durable
      // handoff data is not an empty valid brief and must not be typed into a new chat.
      if (entry.state !== 'awaiting-summary' && !entry.handoff) {
        entry.state = 'aborted';
        entry.error = 'The saved handoff could not be recovered.';
        cancelPrimeTransfer(entry.from);
      } else {
        beginPrimeTransfer(entry.from);
      }
    }
    byToken.set(entry.token, entry);
  }
  try {
    await changedNow();
  } catch (err) {
    // Broken recovery state must not prevent the whole app from opening. New commits still
    // require an immediate durable write and therefore continue to fail closed.
    logWarn(`continuation recovery could not persist its repaired snapshot: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Test seam. */
export function resetContinuationsForTests(): void {
  byToken.clear();
  changed();
}
