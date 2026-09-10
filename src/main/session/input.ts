/**
 * Durable user-authored input routing.
 *
 * Existing-session input is handed only to an MCP call proven to belong to the exact
 * session/conversation pair. Fresh-chat input is leased to one browser document and is
 * never reassigned after an ambiguous native send. Binary attachment bytes remain in the
 * Core-owned staging store; this file persists metadata/ownership only.
 */
import { z } from 'zod';
import { readDurableStrict, writeDurableNow } from '../durable.js';
import { findSessionByConversation, getSession } from './store.js';
import { recordDeliveredInput } from './input-history.js';
import { attachmentSchema, validateInputAttachments } from './input-attachments.js';
import { validateInputImages } from './input-images.js';

const imageSchema = z.object({
  name: z.string().min(1).max(110),
  dataUrl: z.string().max(512100)
}).strict();

export const inputArgs = z.object({
  id: z.string().uuid(),
  sessionId: z.string().min(8).max(64).nullable(),
  text: z.string().trim().min(1).max(16000),
  attachments: z.array(attachmentSchema).max(20).default([]),
  images: z.array(imageSchema).max(4).default([]),
  model: z.string().max(80).nullable().optional(),
  reasoningEffort: z.string().max(32).nullable().optional()
}).strict();
export type InputArgs = z.infer<typeof inputArgs>;

const entrySchema = inputArgs.extend({
  state: z.enum(['queued', 'browser', 'tool', 'sent', 'cancelled', 'failed']),
  owner: z.string().max(200).nullable(),
  createdAt: z.number().int().nonnegative(),
  conversationId: z.string().nullable(),
  offeredAt: z.number().int().nonnegative().optional(),
  deliveredAt: z.number().int().nonnegative().optional(),
  sendStartedAt: z.number().int().nonnegative().optional(),
  messageId: z.string().min(1).max(256).optional(),
  error: z.string().max(300).optional(),
  deliveredSessionId: z.string().min(8).max(64).optional(),
  historyRecorded: z.boolean().optional()
}).strict();
export type InputEntry = z.infer<typeof entrySchema>;

const STATE = 'session-input';
let entries: InputEntry[] | null = null;
let chain: Promise<unknown> = Promise.resolve();
/**
 * Evidence that a tool result carrying this input was actually prepared for handout in
 * this process lifetime. Deliberately non-durable: after restart we cannot prove the old
 * response reached the model, so the stable input must be re-offered instead of confirmed.
 */
const toolHandouts = new Map<string, { requestId: string; handedOutAt: number }>();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

async function load(): Promise<InputEntry[]> {
  if (entries) return entries;
  try {
    const parsed = z.array(entrySchema).safeParse((await readDurableStrict<unknown>(STATE)) ?? []);
    if (!parsed.success) throw new Error('invalid input outbox schema');
    entries = parsed.data;
    return entries;
  } catch {
    throw new Error('The message outbox could not be read safely');
  }
}

async function commit(next: InputEntry[]): Promise<void> {
  await writeDurableNow(STATE, next);
  entries = next;
}

function sameInput(entry: InputEntry, input: InputArgs): boolean {
  const authored: InputArgs = {
    id: entry.id,
    sessionId: entry.sessionId,
    text: entry.text,
    attachments: entry.attachments,
    images: entry.images,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort })
  };
  return JSON.stringify(authored) === JSON.stringify(input);
}

async function exactSessionConversation(sessionId: string, conversationId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  return session?.conversationId === conversationId;
}

/**
 * Best-effort projection of durable delivery receipts into canonical session history.
 * Delivery authority never depends on recorder success: failures leave historyRecorded false
 * so a later outbox read can retry without reopening transport.
 */
async function publishHistory(): Promise<void> {
  let current = await load();
  let next = current;
  let changed = false;

  for (const original of current) {
    let row = next.find((entry) => entry.id === original.id) ?? original;
    if (!row.sessionId && !row.deliveredSessionId && row.state === 'sent' && row.conversationId) {
      const session = await findSessionByConversation(row.conversationId, { requireUnique: true });
      if (session) {
        const rebound = { ...row, deliveredSessionId: session.id };
        next = next.map((entry) => entry.id === row.id ? rebound : entry);
        row = rebound;
        changed = true;
      }
    }

    const recordable = !row.historyRecorded && (
      (row.state === 'tool' && !!row.owner && Number.isFinite(row.offeredAt)) ||
      (row.state === 'sent' && !!row.messageId && Number.isFinite(row.deliveredAt))
    );
    if (!recordable) continue;
    try {
      if (await recordDeliveredInput(row)) {
        next = next.map((entry) => entry.id === row.id ? { ...entry, historyRecorded: true } : entry);
        changed = true;
      }
    } catch {
      // The durable handout/receipt remains authoritative and will be retried later.
    }
  }

  if (changed) await commit(next);
}

export function enqueueInput(raw: InputArgs): Promise<InputEntry> {
  return serial(async () => {
    const input = inputArgs.parse(raw);
    await validateInputAttachments(input.attachments);
    await validateInputImages(input.images);
    const current = await load();
    const prior = current.find((entry) => entry.id === input.id);
    if (prior) {
      if (!sameInput(prior, input)) throw new Error('Message id already belongs to different input');
      return { ...prior };
    }
    const conversationId = input.sessionId ? (await getSession(input.sessionId))?.conversationId ?? null : null;
    if (input.sessionId && !conversationId) throw new Error('This recording has no current ChatGPT conversation');
    const entry: InputEntry = {
      ...input,
      state: 'queued',
      owner: null,
      createdAt: Date.now(),
      conversationId
    };
    const isTerminal = (row: InputEntry) => ['sent', 'cancelled', 'failed'].includes(row.state);
    const needsHistoryRepair = (row: InputEntry) => row.state === 'sent' && row.historyRecorded !== true &&
      !!row.messageId && Number.isFinite(row.deliveredAt);
    const deliveryActive = current.filter((row) => !isTerminal(row)).length;
    if (deliveryActive >= 100) throw new Error('The message outbox is full');
    const protectedRows = current.filter((row) => !isTerminal(row) || needsHistoryRepair(row));
    if (protectedRows.length >= 199) throw new Error('The message outbox is full');
    const historySlots = 199 - protectedRows.length;
    const completedHistory = current
      .filter((row) => isTerminal(row) && !needsHistoryRepair(row))
      .slice(-historySlots);
    await commit([...completedHistory, ...protectedRows, entry]);
    return { ...entry };
  });
}

export function listInputs(): Promise<InputEntry[]> {
  return serial(async () => {
    await load();
    await publishHistory();
    return (await load()).map((entry) => ({ ...entry }));
  });
}

/** Metadata used by attachment staging cleanup; paths/bytes never leave Core. */
export function retainedInputAttachmentIds(): Promise<Set<string>> {
  return serial(async () => new Set((await load())
    .filter((entry) => !['sent', 'cancelled', 'failed'].includes(entry.state))
    .flatMap((entry) => entry.attachments.map((attachment) => attachment.id))));
}

export function pendingBrowserInputs(): Promise<Array<{
  id: string;
  conversationId: null;
  state: 'queued' | 'browser';
  owner: string | null;
  sendStarted: boolean;
}>> {
  return serial(async () => (await load())
    .filter((entry) => entry.sessionId === null && entry.conversationId === null && ['queued', 'browser'].includes(entry.state))
    .map((entry) => ({
      id: entry.id,
      conversationId: null,
      state: entry.state as 'queued' | 'browser',
      owner: entry.owner,
      sendStarted: entry.sendStartedAt !== undefined
    })));
}

export function claimBrowserInput(id: string, owner: string, conversationId: string | null): Promise<InputEntry | null> {
  return serial(async () => {
    if (!owner) return null;
    const current = await load();
    const row = current.find((entry) => entry.id === id);
    // This tranche allows browser-native delivery only for fresh chats. Existing-chat input
    // stays on the exact MCP correlation path until lifecycle policy is ported separately.
    if (!row || row.sessionId !== null || row.conversationId !== null || conversationId !== null) return null;
    if (row.state === 'browser' && row.owner === owner) return { ...row };
    if (row.state !== 'queued') return null;
    const claimed: InputEntry = { ...row, state: 'browser', owner, offeredAt: Date.now() };
    await commit(current.map((entry) => entry.id === id ? claimed : entry));
    return { ...claimed };
  });
}

export function releaseBrowserInput(id: string, owner: string): Promise<boolean> {
  return serial(async () => {
    if (!owner) return false;
    const current = await load();
    const row = current.find((entry) => entry.id === id);
    if (
      !row ||
      row.sessionId !== null ||
      row.conversationId !== null ||
      row.state !== 'browser' ||
      row.owner !== owner ||
      row.sendStartedAt !== undefined
    ) {
      return false;
    }
    const released: InputEntry = {
      ...row,
      state: 'queued',
      owner: null,
      offeredAt: undefined
    };
    await commit(current.map((entry) => entry.id === id ? released : entry));
    return true;
  });
}

export function markBrowserInputSendStarted(id: string, owner: string, now = Date.now()): Promise<boolean> {
  return serial(async () => {
    if (!owner || !Number.isSafeInteger(now) || now < 0) return false;
    const current = await load();
    const row = current.find((entry) => entry.id === id);
    if (!row || row.sessionId !== null || row.conversationId !== null || row.state !== 'browser' || row.owner !== owner) {
      return false;
    }
    if (row.sendStartedAt !== undefined) return true;
    await commit(current.map((entry) => entry.id === id ? { ...row, sendStartedAt: now } : entry));
    return true;
  });
}

export function acknowledgeBrowserInput(
  id: string,
  owner: string,
  conversationId: string,
  messageId = `input:${id}`
): Promise<boolean> {
  return serial(async () => {
    if (!conversationId || !messageId) return false;
    const current = await load();
    const row = current.find((entry) => entry.id === id);
    if (!row || row.owner !== owner || row.sessionId !== null) return false;
    if (row.state === 'sent') {
      return row.conversationId === conversationId && row.messageId === messageId;
    }
    if (row.state !== 'browser') return false;
    const sent: InputEntry = {
      ...row,
      state: 'sent',
      conversationId,
      messageId,
      deliveredAt: Date.now()
    };
    await commit(current.map((entry) => entry.id === id ? { ...sent, historyRecorded: undefined } : entry));
    await publishHistory();
    return true;
  });
}

export function offerToolInput(
  sessionId: string | null,
  conversationId: string | null,
  requestId: string | null,
  now = Date.now()
): Promise<InputEntry[]> {
  return serial(async () => {
    if (!sessionId || !conversationId || !requestId) return [];
    const current = await load();
    if (!(await exactSessionConversation(sessionId, conversationId))) return [];
    const row = current.find((entry) =>
      entry.sessionId === sessionId &&
      entry.conversationId === conversationId &&
      (entry.state === 'queued' || entry.state === 'tool'));
    if (!row) return [];
    const offered: InputEntry = { ...row, state: 'tool', owner: requestId, offeredAt: now };
    if (row.state !== 'tool' || row.owner !== requestId || row.offeredAt !== now) {
      await commit(current.map((entry) => entry.id === row.id ? offered : entry));
    }
    await publishHistory();
    const published = (await load()).find((entry) => entry.id === row.id) ?? offered;
    toolHandouts.set(row.id, { requestId, handedOutAt: now });
    return [{ ...published }];
  });
}

export function acknowledgeToolInput(
  sessionId: string | null,
  conversationId: string | null,
  requestId: string | null,
  now = Date.now()
): Promise<boolean> {
  return serial(async () => {
    if (!sessionId || !conversationId || !requestId || !(await exactSessionConversation(sessionId, conversationId))) return false;
    const current = await load();
    const row = current.find((entry) =>
      entry.sessionId === sessionId && entry.conversationId === conversationId && entry.state === 'tool' && entry.owner !== requestId);
    if (!row) return false;
    const handout = toolHandouts.get(row.id);
    if (!handout || handout.requestId !== row.owner || now <= handout.handedOutAt) return false;
    const sent: InputEntry = { ...row, state: 'sent', messageId: `input:${row.id}`, deliveredAt: now, historyRecorded: undefined };
    await commit(current.map((entry) => entry.id === row.id ? sent : entry));
    toolHandouts.delete(row.id);
    await publishHistory();
    return true;
  });
}

export function cancelInput(id: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find((entry) => entry.id === id);
    if (!row || !['queued', 'browser'].includes(row.state)) return false;
    const cancelled: InputEntry = { ...row, state: 'cancelled', error: row.state === 'browser'
      ? 'Delivery was cancelled locally; an already-sent native message will not be replayed.' : undefined };
    await commit(current.map((entry) => entry.id === row.id ? cancelled : entry));
    return true;
  });
}

export function resetInputForTests(): void {
  entries = null;
  chain = Promise.resolve();
  toolHandouts.clear();
}
