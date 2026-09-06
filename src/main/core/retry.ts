export type ToolRetryPolicy = 'never' | 'one-safe-retry';

export interface ToolRetryInput {
  toolName: string;
  operation?: string;
}

const READ_ONLY_TOOLS = new Set(['read', 'view_image', 'find', 'observe']);
const READ_ONLY_SESSION_OPERATIONS = new Set(['read', 'search']);

/**
 * Automatic replay is allowed only when the operation contract itself is read-only.
 *
 * This classifier does not decide *whether* a retry is safe in a particular failure. The
 * execution bridge must additionally prove the failure happened before execution was accepted.
 * If commit status is ambiguous, even a read-only classification is not a reason to replay.
 */
export function toolRetryPolicy(input: ToolRetryInput): ToolRetryPolicy {
  if (READ_ONLY_TOOLS.has(input.toolName)) return 'one-safe-retry';
  if (input.toolName === 'session' && input.operation && READ_ONLY_SESSION_OPERATIONS.has(input.operation)) {
    return 'one-safe-retry';
  }
  return 'never';
}
