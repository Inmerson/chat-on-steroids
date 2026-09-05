/**
 * Which ChatGPT conversation opened a live `exec_command` session, for attribution.
 *
 * Codex never needs this. It hangs `UnifiedExecProcessManager` off `session.services`, so a
 * conversation cannot even name another conversation's process: the manager it reaches is a
 * different object. This connector is one long-lived main process serving every chat through
 * one manager, so the same session ids are in scope everywhere and attribution needs separate
 * bookkeeping here.
 *
 * This is attribution state, not an authorization boundary. The secret MCP endpoint is the
 * user's authority boundary, so any authenticated conversation may continue a live session.
 * Keeping the opener here still makes recordings and Compact & Resume bookkeeping useful.
 */

import { requestCorrelation } from '../session/correlation.js';
import { unifiedExecManager } from './manager.js';
import type { BackgroundExecState } from './unified-exec.js';

/** Attribution owners, keyed by the process id `exec_command` handed back as `session_id`. */
export const MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION = 4;

const owners = new Map<number, string | null>();

/**
 * The conversation behind an in-flight MCP request, when it is already proven.
 *
 * Never waits. The correlation registry resolves a request id the moment the page reports the
 * matching connector request, and everything here degrades to "unknown" rather than blocking a
 * command on browser evidence.
 */
export function provenConversation(requestId: string | null, conversationId: string | null): string | null {
  if (conversationId) return conversationId;
  return requestCorrelation(requestId)?.conversationId ?? null;
}

/** Records the conversation that opened a still-running exec session. */
export function noteExecOwner(processId: number | null, conversationId: string | null): void {
  if (processId === null) return;
  owners.set(processId, conversationId);
}

/** Drops a session's owner once it can no longer be written to. */
export function forgetExecOwner(processId: number | null): void {
  if (processId === null) return;
  owners.delete(processId);
}

/** The conversation that opened this session, or null when it was never proven. */
export function execOwner(processId: number): string | null {
  return owners.get(processId) ?? null;
}

/** Retained background work attributed to one proven conversation; never an auth decision. */
export function backgroundExecObligations(conversationId: string | null | undefined): BackgroundExecState {
  if (!conversationId) return { running: [], exitedUnread: [] };
  const processIds = new Set<number>();
  for (const [processId, owner] of owners) if (owner === conversationId) processIds.add(processId);
  return unifiedExecManager.backgroundState(processIds);
}

/** Bounded same-conversation reminders. This projection never drains terminal output. */
export function backgroundExecRecoveryNotices(conversationId: string | null | undefined): string[] {
  const exited = backgroundExecObligations(conversationId).exitedUnread;
  if (exited.length === 0) return [];
  const notices = exited.slice(0, 3).map(
    (session) =>
      `Background session ${session.processId} finished with exit code ${session.exitCode ?? 'unknown'} and has unread output. ` +
      `Poll it with write_stdin(session_id=${session.processId}, chars="").`
  );
  if (exited.length > notices.length) {
    notices.push(`${exited.length - notices.length} more background session result(s) are waiting to be polled.`);
  }
  return notices;
}

/**
 * Whether `processId` is unknown to the connector. Conversation identity is deliberately not
 * consulted for authorization; all authenticated MCP chats share the enabled Core authority.
 */
export function execOwnershipDenied(processId: number, conversationId: string | null): boolean {
  void processId;
  void conversationId;
  return false;
}

/**
 * Moves live process attribution with a proven Compact & Resume chat A→B transition.
 *
 * Continuation publication keeps the opener attribution aligned with the durable session after
 * the frontend chat changes. This hook changes exactly owners equal to `fromConversationId`:
 * anonymous legacy sessions and processes attributed to every other chat are untouched. It is
 * app-internal and carries no discovery/wire surface or authorization meaning.
 */
export function moveExecConversationOwners(fromConversationId: string, toConversationId: string): number {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return 0;
  let moved = 0;
  for (const [processId, owner] of owners) {
    if (owner !== fromConversationId) continue;
    owners.set(processId, toConversationId);
    moved += 1;
  }
  return moved;
}

/** Test seam: the registry is process-global state with no natural lifetime boundary. */
export function resetExecOwnershipForTests(): void {
  owners.clear();
}
