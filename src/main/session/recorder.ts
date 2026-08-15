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

import { randomUUID } from 'node:crypto';
import type {
  ActivitySummary,
  AgentMessage,
  AssetRef,
  CallAttribution,
  SessionEvent,
  SessionSummary,
  StoredText,
  ToolCallRecord,
  ToolOutcome,
  TurnOutcome
} from '../../shared/session.js';
import { estimateTokens } from '../../shared/session.js';
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
  lastSeen: number;
  /**
   * ChatGPT message ids already stored for this session.
   *
   * Reloading the tab makes the extension report the whole visible conversation
   * again, which is what backfills an older chat — but the same message must not
   * land twice, least of all a user message.
   */
  messageIds: Set<string>;
}

const conversations = new Map<string, LiveConversation>();
const assetBytes = new Map<string, number>();
/**
 * Where calls go when nothing identifies the conversation that made them.
 *
 * Two situations land here and both are honest: the extension is not running, so no
 * conversation is known at all; or several are and none can be proven. The alternative
 * — filing the call into the most recently active chat — reads as certainty in the UI
 * and in a compaction, while being a coin flip.
 */
let unattributedSessionId: string | null = null;
let lastActiveSessionId: string | null = null;

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
    return existing.sessionId;
  }
  // Reuse a session already recorded for this conversation, so closing and reopening
  // the tab continues the same history instead of fragmenting it.
  const known = (await listSessions()).find((entry) => entry.conversationId === conversationId);
  const summary = known ?? (await createSession({ conversationId, title }));
  // Reopening a chat that was closed earlier makes its session live again. Appending
  // to a session still stamped with an end time left the UI showing a finished session
  // that was visibly still growing.
  if (known && known.endedAt !== null) {
    await reopenSession(known.id).catch(() => undefined);
    logInfo(`session ${known.id} reopened — its ChatGPT conversation is active again`);
  }
  conversations.set(conversationId, {
    conversationId,
    sessionId: summary.id,
    turnStartedAt: null,
    turnId: null,
    lastSeen: Date.now(),
    messageIds: known ? await storedMessageIds(summary.id) : new Set()
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
  lastActiveSessionId = summary.id;
  notifyChanged();
  return summary.id;
}

/**
 * Message ids already in a session's log.
 *
 * Read once when a conversation is picked up again, so de-duplication survives an app
 * restart rather than only a page that was never reloaded.
 */
async function storedMessageIds(sessionId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const events = await readEvents(sessionId, { kinds: ['user_message', 'assistant_message'] });
    for (const event of events) {
      if ((event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId) {
        ids.add(event.messageId);
      }
    }
  } catch (err) {
    logWarn(`could not read stored message ids: ${(err as Error).message}`);
  }
  return ids;
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

export function liveConversations(): Array<{ conversationId: string; sessionId: string; generating: boolean }> {
  return [...conversations.values()].map((entry) => ({
    conversationId: entry.conversationId,
    sessionId: entry.sessionId,
    generating: entry.turnStartedAt !== null
  }));
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
async function storeText(sessionId: string, text: string, cap: number): Promise<StoredText> {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const value = scrubAgentSecrets(raw);
  if (value.length <= cap) return { text: value, truncated: false, chars: value.length };
  const assetId = await writeOverflowText(sessionId, value);
  const note = assetId
    ? `\n…[${value.length - cap} more characters stored in full as ${assetId}]`
    : `\n…[${value.length - cap} more characters were too large to store and are lost]`;
  return {
    text: `${value.slice(0, cap)}${note}`,
    truncated: true,
    chars: value.length,
    ...(assetId ? { assetId } : {})
  };
}

/**
 * Fields that must never reach disk, whatever tool they arrive on.
 *
 * `agent_key`, `joinKey` and friends are capabilities: writing one into events.jsonl
 * would publish it to session_history, to the Activity feed the extension is sent, and
 * to anything built from the raw log — and a published worker key is how a worker
 * becomes the prime. They are dropped by name here, and agent-secrets.ts scrubs the
 * live values out of every other field as a second pass, because the model may quote a
 * key anywhere it likes.
 */
const CREDENTIAL_FIELDS = new Set(['agent_key', 'agentKey', 'joinKey', 'join_key', 'secret', 'primeSecret']);

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
  if (tool === 'write_clipboard' && typeof copy['text'] === 'string') {
    copy['text'] = `<${(copy['text'] as string).length} characters not stored>`;
  }
  for (const field of Object.keys(copy)) {
    if (CREDENTIAL_FIELDS.has(field)) copy[field] = '<agent key removed>';
  }
  return scrubAgentSecretsDeep(copy);
}

function redactResult(tool: string, text: string): string {
  if (tool === 'read_clipboard') return `<clipboard text not stored (${text.length} characters)>`;
  return text;
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
}

/**
 * Records one MCP tool call.
 *
 * Never throws into the caller: a broken recorder must not break the connector, so a
 * storage failure is logged and the tool result is returned to ChatGPT regardless.
 */
export async function recordToolCall(input: ToolCallInput): Promise<ToolCallRecord | null> {
  if (!recordingEnabled()) return null;
  try {
    const evidence = input.evidence ?? currentCall()?.evidence ?? emptyEvidence();
    const target = pickTarget(input.agent ?? null);
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

    const summary: ActivitySummary = summarizeToolCall({
      tool: input.tool,
      args: input.args,
      evidence,
      outcome: input.outcome,
      durationMs: input.durationMs,
      resultHead: resultText.split('\n', 1)[0] ?? ''
    });

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
 * Decides which conversation a tool call belongs to.
 *
 * The honest ordering: an agent that identified itself, then a single conversation
 * that is demonstrably generating right now, then a guess that is labelled a guess.
 */
function pickTarget(agent: string | null): Target {
  if (agent) {
    const bound = [...conversations.values()].find((entry) => agentConversation(agent) === entry.conversationId);
    if (bound) return { conversationId: bound.conversationId, attribution: 'agent', turnId: bound.turnId };
    return { conversationId: null, attribution: 'agent', turnId: null };
  }
  const generating = [...conversations.values()].filter((entry) => entry.turnStartedAt !== null);
  if (generating.length === 1) {
    const only = generating[0]!;
    return { conversationId: only.conversationId, attribution: 'turn', turnId: only.turnId };
  }
  return { conversationId: null, attribution: 'inferred', turnId: null };
}

/** Set by the agent broker so a worker's calls land in that worker's own session. */
let agentConversationLookup: (agent: string) => string | null = () => null;

export function setAgentConversationLookup(lookup: (agent: string) => string | null): void {
  agentConversationLookup = lookup;
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
  kind: 'user_message' | 'assistant_message' | 'progress' | 'turn_start' | 'turn_end' | 'chat_error';
  time: number;
  text?: string;
  messageId?: string;
  turnId?: string;
  final?: boolean;
  outcome?: TurnOutcome;
  detail?: string;
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

  for (const item of observations) {
    // A reloaded tab reports the whole visible conversation again. Backfilling an
    // older chat is the point; storing the same message twice is not.
    if (item.kind === 'user_message' || item.kind === 'assistant_message') {
      if (item.messageId && live) {
        if (live.messageIds.has(item.messageId)) continue;
        live.messageIds.add(item.messageId);
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
          message: await storeText(sessionId, item.text ?? '', MAX_USER_MESSAGE_CHARS),
          ...(item.messageId ? { messageId: item.messageId } : {})
        });
        break;
      case 'assistant_message':
        await appendEvent(sessionId, {
          ...base,
          kind: 'assistant_message',
          message: await storeText(sessionId, item.text ?? '', MAX_MESSAGE_CHARS),
          final: item.final === true,
          ...(item.messageId ? { messageId: item.messageId } : {})
        });
        break;
      case 'progress':
        await appendEvent(sessionId, {
          ...base,
          kind: 'progress',
          message: await storeText(sessionId, item.text ?? '', 2000)
        });
        break;
      case 'chat_error':
        await appendEvent(sessionId, {
          ...base,
          kind: 'chat_error',
          message: await storeText(sessionId, item.text ?? '', 2000)
        });
        break;
      case 'turn_start':
        if (live) {
          live.turnStartedAt = item.time;
          live.turnId = item.turnId ?? null;
        }
        await appendEvent(sessionId, { ...base, kind: 'turn_start' });
        break;
      case 'turn_end':
        if (live) {
          live.turnStartedAt = null;
          live.turnId = null;
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
  model: string,
  chars: number,
  reason: string
): Promise<void> {
  await appendEvent(sessionId, {
    time: Date.now(),
    source: 'app',
    kind: 'handoff',
    handoffId,
    model,
    chars,
    reason
  }).catch(() => undefined);
  notifyChanged();
}

/** Called when a conversation's tab goes away, so an unfinished turn is not left open. */
export async function closeConversation(conversationId: string): Promise<void> {
  const live = conversations.get(conversationId);
  if (!live) return;
  if (live.turnStartedAt !== null) {
    await appendEvent(live.sessionId, {
      time: Date.now(),
      source: 'extension',
      kind: 'turn_end',
      outcome: 'interrupted',
      detail: 'the ChatGPT tab was closed or navigated away while generating'
    }).catch(() => undefined);
  }
  conversations.delete(conversationId);
  await endSession(live.sessionId).catch(() => undefined);
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
  assetBytes.clear();
  unattributedSessionId = null;
  lastActiveSessionId = null;
  agentConversationLookup = () => null;
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
}

export function markSessionActive(sessionId: string): void {
  lastActiveSessionId = sessionId;
}

export type { SessionSummary, SessionEvent };
