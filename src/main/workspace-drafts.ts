/**
 * Durable, local-only drafts for the desktop workspace composer.
 *
 * A draft is deliberately not a bridge command. It may survive a restart, but it can never
 * type into a ChatGPT page. Delivery is added only when the target conversation is proven
 * current and owned by this application.
 */
import { readDurable, writeDurableNow } from './durable.js';

const STATE = 'workspace-drafts';
const MAX_DRAFT_CHARS = 16_000;

export interface WorkspaceDraft {
  sessionId: string;
  text: string;
  updatedAt: number;
}

let loaded: Promise<Map<string, WorkspaceDraft>> | null = null;

async function drafts(): Promise<Map<string, WorkspaceDraft>> {
  loaded ??= (async () => {
    const saved = await readDurable<unknown>(STATE);
    const rows = Array.isArray(saved) ? saved : [];
    const next = new Map<string, WorkspaceDraft>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const value = row as Record<string, unknown>;
      if (typeof value.sessionId !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(value.sessionId)) continue;
      if (typeof value.text !== 'string' || value.text.length > MAX_DRAFT_CHARS) continue;
      if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) continue;
      next.set(value.sessionId, { sessionId: value.sessionId, text: value.text, updatedAt: value.updatedAt });
    }
    return next;
  })();
  return loaded;
}

export async function listWorkspaceDrafts(): Promise<WorkspaceDraft[]> {
  return [...(await drafts()).values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveWorkspaceDraft(sessionId: string, text: string, now = Date.now()): Promise<WorkspaceDraft | null> {
  if (!/^[0-9a-z-]{8,64}$/i.test(sessionId)) throw new Error('Invalid session id');
  if (text.length > MAX_DRAFT_CHARS) throw new Error(`Draft exceeds ${MAX_DRAFT_CHARS} characters`);
  const current = await drafts();
  const trimmed = text.trim();
  if (trimmed) current.set(sessionId, { sessionId, text, updatedAt: now });
  else current.delete(sessionId);
  const snapshot = [...current.values()];
  await writeDurableNow(STATE, snapshot.length ? snapshot : null);
  return current.get(sessionId) ?? null;
}

export function resetWorkspaceDraftsForTests(): void { loaded = null; }
