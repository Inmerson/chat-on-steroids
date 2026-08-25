/**
 * Session-scoped unattended Goal continuation.
 *
 * The browser proves a ChatGPT turn is settled. This module then projects the durable session
 * to authored user messages plus final assistant answers, asks the bounded Antigravity Goal
 * Driver for one next user message or NO_REPLY, and exposes one idempotent browser-owned draft.
 * Provider credentials, tool calls/results, file contents and browser evidence never enter the
 * Goal prompt.
 */

import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { readEvents, readRecentEvents } from './session/store.js';
import { ANTIGRAVITY_MODEL } from './antigravity/runtime.js';
import { draftGoalWithAntigravity } from './antigravity/goal-driver.js';
import {
  goalForSession,
  goalRevisionMatches,
  markGoalComplete,
  markGoalFailed,
  noteGoalAutoTurn
} from './goal-state.js';
import { continuationForSession } from './session/continuation.js';

/** How many messages of history the Goal Driver is given, newest kept. */
const MAX_CONTEXT_MESSAGES = 120;
/** Total prompt transcript character budget. */
const MAX_CONTEXT_CHARS = 120_000;
/** Per-message projection budget. */
const MAX_MESSAGE_CHARS = 12_000;
/** How long a finished draft stays visible before only its spent tombstone remains. */
const DRAFT_TTL_MS = 10 * 60_000;

/** Temporary compatibility for the upstream picker until Task 7 removes that UI entirely. */
export const MODEL_PAGE_SIZE = 20;

export type GoalStage = 'sending' | 'answering' | 'ready' | 'no-reply' | 'failed';

export interface GoalDraftView {
  token: string;
  conversationId: string;
  turnId: string;
  stage: GoalStage;
  model: string;
  text: string;
  reply: string;
  error: string | null;
}

interface GoalDraft extends GoalDraftView {
  sessionId: string;
  revision: number;
  clientId: string;
  startedAt: number;
  settledAt: number;
  acknowledged: boolean;
  /** Successful browser-send ACK already charged to consecutiveAutoTurns for this token. */
  sentCounted: boolean;
  work: Promise<void> | null;
}

const drafts = new Map<string, GoalDraft>();

export function goalSettings(): {
  enabled: boolean;
  provider: 'antigravity';
  model: typeof ANTIGRAVITY_MODEL;
} {
  return { enabled: getConfig().goal.enabled, provider: 'antigravity', model: ANTIGRAVITY_MODEL };
}

/** Compatibility only; Antigravity uses the already-authenticated local CLI session. */
export async function goalKeyPresent(): Promise<boolean> {
  return true;
}

function view(draft: GoalDraft): GoalDraftView {
  return {
    token: draft.token,
    conversationId: draft.conversationId,
    turnId: draft.turnId,
    stage: draft.stage,
    model: draft.model,
    text: draft.text,
    reply: draft.stage === 'ready' && !draft.acknowledged ? draft.reply : '',
    error: draft.error
  };
}

function expireDraftPayload(draft: GoalDraft): void {
  if (draft.settledAt === 0 || Date.now() - draft.settledAt <= DRAFT_TTL_MS) return;
  draft.acknowledged = true;
  draft.text = '';
  draft.reply = '';
  draft.error = null;
  draft.work = null;
}

export function goalViewFor(conversationId: string, clientId?: string): GoalDraftView | null {
  const draft = drafts.get(conversationId);
  if (!draft) return null;
  expireDraftPayload(draft);
  if (clientId !== undefined && draft.clientId !== clientId) return null;
  if (draft.acknowledged) return null;
  // A browser-visible reply is authority to perform an irreversible send. Re-check the two
  // session-level fences at the moment that authority is projected, not only while the driver
  // was running: a manual revision or Compact & Resume can win after the draft became ready.
  if (
    draft.stage === 'ready' &&
    (!goalRevisionMatches(draft.sessionId, draft.revision) || continuationForSession(draft.sessionId))
  ) {
    retireStale(draft);
    return null;
  }
  return view(draft);
}

export function ackGoalDraft(
  conversationId: string,
  token: string,
  clientId?: string,
  sent = false
): boolean {
  const draft = drafts.get(conversationId);
  if (!draft || draft.token !== token) return false;
  if (clientId !== undefined && draft.clientId !== clientId) return false;
  // The draft token is the exactly-once accounting key. A lost HTTP response may make the
  // browser repeat this ACK, but the same generated send must advance the runaway guard once.
  if (sent && !draft.sentCounted) {
    const updated = noteGoalAutoTurn(draft.sessionId, draft.revision);
    if (updated) draft.sentCounted = true;
  }
  draft.acknowledged = true;
  if (draft.settledAt === 0) draft.settledAt = Date.now();
  return true;
}

export function retireGoalDrafts(): number {
  let retired = 0;
  for (const draft of drafts.values()) {
    if (draft.acknowledged) continue;
    draft.acknowledged = true;
    if (draft.settledAt === 0) draft.settledAt = Date.now();
    draft.text = '';
    draft.reply = '';
    retired += 1;
  }
  return retired;
}

export function resetGoalStateForTests(): void {
  drafts.clear();
  firstUserCache.clear();
}

export interface StartGoalDraftInput {
  sessionId: string;
  conversationId: string;
  turnId: string;
  clientId?: string;
  /** Captured durable Goal revision. Optional only during the Task 4 -> Task 6 bridge migration. */
  revision?: number;
}

export function startGoalDraft(input: StartGoalDraftInput): GoalDraftView {
  const existing = drafts.get(input.conversationId);
  const clientId = input.clientId ?? '';
  const active = goalForSession(input.sessionId);
  const revision = input.revision ?? active?.revision ?? 0;
  if (existing) expireDraftPayload(existing);
  if (existing && !existing.acknowledged && existing.clientId !== clientId) {
    throw new Error('goal_owned_elsewhere');
  }
  if (existing && existing.turnId === input.turnId && existing.revision === revision) return view(existing);
  if (existing) drafts.delete(input.conversationId);

  const draft: GoalDraft = {
    token: `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    revision,
    clientId,
    turnId: input.turnId,
    stage: 'sending',
    model: ANTIGRAVITY_MODEL,
    text: '',
    reply: '',
    error: null,
    startedAt: Date.now(),
    settledAt: 0,
    acknowledged: false,
    sentCounted: false,
    work: null
  };
  drafts.set(input.conversationId, draft);
  draft.work = run(draft);
  return view(draft);
}

function settle(draft: GoalDraft, stage: GoalStage, error: string | null = null): void {
  if (drafts.get(draft.conversationId) !== draft) return;
  draft.stage = stage;
  draft.error = error;
  draft.settledAt = Date.now();
}

function stillCurrent(draft: GoalDraft): boolean {
  return (
    !draft.acknowledged &&
    drafts.get(draft.conversationId) === draft &&
    goalRevisionMatches(draft.sessionId, draft.revision) &&
    continuationForSession(draft.sessionId) === null
  );
}

function retireStale(draft: GoalDraft): void {
  if (drafts.get(draft.conversationId) !== draft) return;
  draft.acknowledged = true;
  draft.text = '';
  draft.reply = '';
  if (draft.settledAt === 0) draft.settledAt = Date.now();
}

async function run(draft: GoalDraft): Promise<void> {
  try {
    if (!stillCurrent(draft)) return retireStale(draft);
    const active = goalForSession(draft.sessionId);
    if (!active || active.revision !== draft.revision || active.status !== 'active') return retireStale(draft);

    const messages = await conversationMessages(draft.sessionId);
    if (!stillCurrent(draft)) return retireStale(draft);

    draft.stage = 'answering';
    const result = await draftGoalWithAntigravity({ goal: active.text, messages });
    if (!stillCurrent(draft)) return retireStale(draft);

    if (result.kind === 'no-reply') {
      if (!markGoalComplete(draft.sessionId, draft.revision)) return retireStale(draft);
      draft.reply = '';
      logInfo(`goal: ${ANTIGRAVITY_MODEL} completed revision ${draft.revision} in ${draft.conversationId}`);
      return settle(draft, 'no-reply');
    }

    draft.text = result.text;
    draft.reply = humanReply(result.text);
    logInfo(`goal: drafted ${result.text.length} characters for ${draft.conversationId} with ${ANTIGRAVITY_MODEL}`);
    settle(draft, 'ready');
  } catch (error) {
    if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
    if (!goalRevisionMatches(draft.sessionId, draft.revision)) return retireStale(draft);
    const detail = error instanceof Error ? error.message : String(error);
    markGoalFailed(draft.sessionId, draft.revision);
    logWarn(`goal: draft for ${draft.conversationId} failed - ${detail}`);
    settle(draft, 'failed', `goal_failed: ${detail}`);
  }
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const firstUserCache = new Map<string, ChatMessage>();

function userVisibleToGoal(event: { provenance?: string }): boolean {
  return event.provenance === undefined || event.provenance === 'manual';
}

async function firstUserMessage(sessionId: string): Promise<ChatMessage | null> {
  const cached = firstUserCache.get(sessionId);
  if (cached) return cached;
  const events = await readEvents(sessionId, { kinds: ['user_message'] });
  const event = events.find((row) => row.kind === 'user_message' && userVisibleToGoal(row));
  if (!event || event.kind !== 'user_message') return null;
  const content = clip(event.message.text);
  if (!content) return null;
  const message: ChatMessage = { role: 'user', content };
  firstUserCache.set(sessionId, message);
  while (firstUserCache.size > 128) {
    const oldest = firstUserCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    firstUserCache.delete(oldest);
  }
  return message;
}

export async function conversationMessages(sessionId: string): Promise<ChatMessage[]> {
  const recentLimit = MAX_CONTEXT_MESSAGES * 2;
  const events = await readRecentEvents(sessionId, recentLimit, { kinds: ['user_message', 'assistant_message'] });
  const ordered: ChatMessage[] = [];
  const byStableMessage = new Map<string, number>();

  for (const event of events) {
    let next: ChatMessage | null = null;
    if (event.kind === 'user_message' && userVisibleToGoal(event)) {
      const content = clip(event.message.text);
      if (content) next = { role: 'user', content };
    } else if (event.kind === 'assistant_message' && event.final) {
      const content = clip(event.message.text);
      if (content) next = { role: 'assistant', content };
    }
    if (!next) continue;

    const stableId = 'messageId' in event && typeof event.messageId === 'string' && event.messageId ? event.messageId : null;
    const key = stableId ? `${event.kind}\u0000${stableId}` : null;
    const existingAt = key ? byStableMessage.get(key) : undefined;
    if (existingAt !== undefined) ordered[existingAt] = next;
    else {
      if (key) byStableMessage.set(key, ordered.length);
      ordered.push(next);
    }
  }

  let firstUserAt = ordered.findIndex((message) => message.role === 'user');
  let firstUser = firstUserAt >= 0 ? ordered[firstUserAt]! : null;
  if (events.length >= recentLimit) {
    const original = await firstUserMessage(sessionId);
    if (original) {
      firstUser = original;
      if (firstUserAt < 0 || ordered[firstUserAt]?.content !== original.content) firstUserAt = -1;
    }
  }

  const totalChars = ordered.reduce((sum, message) => sum + message.content.length, 0);
  if (firstUserAt >= 0 && ordered.length <= MAX_CONTEXT_MESSAGES && totalChars <= MAX_CONTEXT_CHARS) return ordered;

  const kept: ChatMessage[] = [];
  let chars = firstUser?.content.length ?? 0;
  const tailSlots = MAX_CONTEXT_MESSAGES - (firstUser ? 1 : 0);
  for (let at = ordered.length - 1; at >= 0 && kept.length < tailSlots; at -= 1) {
    if (at === firstUserAt) continue;
    const message = ordered[at]!;
    if (chars + message.content.length > MAX_CONTEXT_CHARS) break;
    chars += message.content.length;
    kept.push(message);
  }
  kept.reverse();
  if (firstUser) kept.unshift(firstUser);
  return kept;
}

/** FNV-1a over the draft, so every choice below is the draft's own and never a clock's. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0 || 1;
}

/** xorshift32. Small, and the only thing it decides is which words carry the mistakes. */
function stepped(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/**
 * The em dash, and the spaced en dash that is the same move by another character.
 *
 * A comma is what that sentence looks like when it is typed instead, so that is the default.
 * The exceptions are the shapes where a comma would be wrong or doubled: a dash opening or
 * closing a line is a bullet or a trailing thought and simply goes, a dash already sitting
 * against punctuation leaves a space behind, and a dash between two digits is a range and
 * becomes the hyphen somebody would actually have reached for.
 *
 * The whitespace class is horizontal only. A plain `\s*` would have swallowed the newlines
 * around a dash at the start of a line and welded a list into one paragraph.
 */
function undash(text: string): string {
  return text.replace(/[^\S\r\n]*[—–][^\S\r\n]*/g, (match, at: number, whole: string) => {
    const before = at > 0 ? whole[at - 1] : '';
    const after = whole[at + match.length] ?? '';
    if (!before || before === '\n') return '';
    if (!after || after === '\n') return '';
    if (/[0-9]/.test(before) && /[0-9]/.test(after)) return '-';
    if (/[,;:]/.test(before) || /[,;:.!?]/.test(after)) return ' ';
    return ', ';
  });
}

/**
 * Text a mistake must never be put into.
 *
 * A typo is only harmless in prose. Inside a path, a command, a URL or a file name it is a
 * different instruction, and the whole point of this message is that ChatGPT acts on it.
 */
const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|\S+[\\/@]\S+|[\w-]+\.[\w-]+/g;

/** One plain lowercase word: no capitals, so an acronym or a model id is never a candidate. */
const CANDIDATE = /(?<![\w'’-])[a-z][a-z'’]{2,}[a-z](?![\w'’-])/g;

/**
 * The mistake this word would carry, or null when it has none available.
 *
 * In the order a real one happens. The dropped apostrophe is far and away the commonest and
 * the least jarring to read, so it is tried first; the collapsed double letter next; the
 * transposition last, because it is the most visible and a message full of them reads as
 * broken rather than as fast.
 */
function mistyped(word: string): string | null {
  if (/['’]/.test(word)) {
    const dropped = word.replace(/['’]/g, '');
    if (dropped.length >= 3 && dropped !== word) return dropped;
  }
  if (word.length >= 5) {
    const doubled = /([a-z])\1/.exec(word);
    if (doubled) return word.slice(0, doubled.index) + word.slice(doubled.index + 1);
  }
  if (word.length >= 5) {
    // Never the first or last letter: those are the two a reader recognises a word by at a
    // glance, and swapping either reads as a different word rather than as a slip.
    for (let at = Math.floor((word.length - 1) / 2); at >= 1; at--) {
      if (at + 1 <= word.length - 2 && word[at] !== word[at + 1]) {
        return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
      }
    }
  }
  return null;
}

/** Every word that could carry a mistake, with where it is and what it becomes. */
function typoSites(text: string): Array<{ at: number; word: string; typo: string }> {
  const guarded: Array<[number, number]> = [];
  PROTECTED.lastIndex = 0;
  for (let found = PROTECTED.exec(text); found; found = PROTECTED.exec(text)) {
    guarded.push([found.index, found.index + found[0].length]);
  }
  const out: Array<{ at: number; word: string; typo: string }> = [];
  CANDIDATE.lastIndex = 0;
  for (let found = CANDIDATE.exec(text); found; found = CANDIDATE.exec(text)) {
    const at = found.index;
    const word = found[0];
    if (guarded.some(([from, to]) => at < to && at + word.length > from)) continue;
    const typo = mistyped(word);
    if (typo) out.push({ at, word, typo });
  }
  return out;
}

/**
 * The finished draft, as it would have been typed.
 *
 * `undash` always runs. The mistakes are deliberately few — one, and one more for every
 * couple of hundred characters after that, never more than three — because a message with a
 * slip in every sentence is a tell of its own in the other direction. They are spread by
 * dividing the candidate words into that many buckets and taking one from each, so two of
 * them never land in the same breath.
 */
export function humanReply(reply: string): string {
  const text = undash(reply);
  const sites = typoSites(text);
  if (sites.length === 0) return text;
  const wanted = Math.min(3, 1 + Math.floor(text.length / 220));
  const next = stepped(seedOf(text));
  const chosen = new Set<number>();
  const bucket = sites.length / wanted;
  for (let index = 0; index < wanted; index++) {
    const from = Math.floor(index * bucket);
    const to = Math.max(from + 1, Math.min(sites.length, Math.floor((index + 1) * bucket)));
    chosen.add(from + (next() % (to - from)));
  }
  let out = text;
  // Back to front, so an edit never moves the offset of one still to come.
  for (const index of [...chosen].sort((a, b) => b - a)) {
    const site = sites[index]!;
    out = out.slice(0, site.at) + site.typo + out.slice(site.at + site.word.length);
  }
  return out;
}

function clip(text: string): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length <= MAX_MESSAGE_CHARS) return trimmed;
  // Goal Mode is specifically trying to decide what still remains after ChatGPT's *finished*
  // answer. Long answers commonly put the verification/result/conclusion at the end, so keeping
  // only the prefix can remove the exact evidence needed to stop the loop and make it ask for
  // work that is already done. Preserve both ends inside the same hard per-message budget.
  const marker = '\n[… cut …]\n';
  const contentBudget = MAX_MESSAGE_CHARS - marker.length;
  const head = Math.ceil(contentBudget / 2);
  const tail = contentBudget - head;
  return `${trimmed.slice(0, head)}${marker}${trimmed.slice(-tail)}`;
}


export interface GoalModel {
  id: string;
  name: string;
  created: number;
  contextLength: number;
}

/** Network-free compatibility while the old picker is removed in Task 7. */
export async function listGoalModels(offset = 0, limit = MODEL_PAGE_SIZE): Promise<{ models: GoalModel[]; total: number }> {
  const all: GoalModel[] = [
    { id: ANTIGRAVITY_MODEL, name: 'Gemini 3.7 Flash Low', created: 0, contextLength: 0 }
  ];
  const from = Math.max(0, Math.floor(offset));
  const count = Math.max(1, Math.min(100, Math.floor(limit)));
  return { models: all.slice(from, from + count), total: all.length };
}
