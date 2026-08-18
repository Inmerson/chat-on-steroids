/**
 * Creating and storing a handoff.
 *
 * One store, one writer: the ChatGPT conversation being compacted writes its own brief as
 * its final answer, and this is where that brief is saved. The id is minted here rather
 * than taken from the text — a model that invents its own handoff id can collide with a
 * real one, overwrite it, or hand the next chat an id that resolves to somebody else's
 * brief.
 */

import { randomUUID } from 'node:crypto';
import type { Handoff } from '../../shared/session.js';
import { logInfo } from '../logger.js';
import { recordHandoff } from './recorder.js';
import { getSession, saveHandoff } from './store.js';

export interface CreateHandoffInput {
  sessionId: string;
  /** The brief itself. */
  text: string;
  notes?: readonly string[];
  /** Recorded on the session's `handoff` event so the timeline can say why it exists. */
  reason: string;
  /** How the recording looked when the brief was written. Defaults to the session's own counts. */
  sourceEvents?: number;
  sourceTokens?: number;
}

/** A fresh, unique handoff id. Never taken from a caller, and never from a model. */
export function newHandoffId(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Writes one handoff and records it against its session.
 *
 * The order matters: the file is written before the event, because the event is what
 * makes the handoff discoverable (`summary.lastHandoffId`) and a session claiming a
 * handoff whose file does not exist is worse than a file nothing points at yet.
 */
export async function createHandoff(input: CreateHandoffInput): Promise<Handoff> {
  const text = input.text.trim();
  if (!text) throw new Error('A handoff cannot be empty');
  const summary = await getSession(input.sessionId);
  if (!summary) throw new Error('That session no longer exists');
  const handoff: Handoff = {
    id: newHandoffId(),
    sessionId: input.sessionId,
    createdAt: Date.now(),
    text,
    sourceEvents: input.sourceEvents ?? summary.events,
    sourceTokens: input.sourceTokens ?? summary.estimatedTokens,
    // The working folder is deliberately not here. It belongs to the durable local session
    // and moves with the session's rebind (see `moveChatWorkspace`), so writing it into the
    // brief as well would be a second, weaker copy of state the commit already carries.
    notes: [...(input.notes ?? [])]
  };
  await saveHandoff(handoff);
  await recordHandoff(input.sessionId, handoff.id, handoff.text.length, input.reason);
  logInfo(`handoff ${handoff.id} saved (${handoff.text.length} characters)`);
  return handoff;
}
