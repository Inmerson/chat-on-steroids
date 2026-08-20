/**
 * Which ChatGPT conversation owns a live `exec_command` session.
 *
 * Codex never needs this. It hangs `UnifiedExecProcessManager` off `session.services`, so a
 * conversation cannot even name another conversation's process: the manager it reaches is a
 * different object. This connector is one long-lived main process serving every chat through
 * one manager, so the same session ids are in scope everywhere, and `write_stdin(session_id)`
 * on a numeric id from another chat would otherwise reach that chat's shell.
 *
 * The rule is deliberately one-sided: a call is refused only when this app can *prove* the
 * process belongs to a different conversation. Identity here comes from ChatGPT's own request
 * correlation, which is not always resolved by the time a command runs, and an unproven guess
 * must never take a working terminal away from the chat that opened it.
 */

import { requestCorrelation } from '../session/correlation.js';

/** Owners, keyed by the process id `exec_command` handed back as `session_id`. */
const owners = new Map<number, string>();

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
  if (processId === null || !conversationId) return;
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

/**
 * Whether `conversationId` may write to `processId`.
 *
 * Unknown on either side is allowed. Only two known and different conversations are a refusal.
 */
export function execOwnershipDenied(processId: number, conversationId: string | null): boolean {
  if (!conversationId) return false;
  const owner = owners.get(processId);
  return owner !== undefined && owner !== conversationId;
}

/** Test seam: the registry is process-global state with no natural lifetime boundary. */
export function resetExecOwnershipForTests(): void {
  owners.clear();
}
