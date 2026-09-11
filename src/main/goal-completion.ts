import { backgroundExecObligations } from './codex/ownership.js';
import { executionForConversation } from './execution.js';
import { inFlightToolCalls } from './mcp/call-context.js';
import { readSessionPlan } from './session/store.js';

export type CompletionGateDecision =
  | { action: 'allow_stop'; reason: string }
  | { action: 'continue'; reason: string; reply: string }
  | { action: 'wait'; reason: string };

export interface CompletionGateInput {
  sessionId: string;
  conversationId: string;
  objective: string;
}

function continuationReply(steps: string[]): string {
  const remaining = steps.map((step) => step.trim()).filter(Boolean).slice(0, 6);
  if (remaining.length === 1) {
    return `Continue with the remaining requested work: ${remaining[0]}. Finish it and verify it before stopping.`;
  }
  return `Continue with the remaining requested work: ${remaining.join('; ')}. Finish these and verify them before stopping.`;
}

export async function evaluateCompletionCandidate(input: CompletionGateInput): Promise<CompletionGateDecision> {
  const plan = await readSessionPlan(input.sessionId);
  const unfinished = plan?.plan.filter((item) => item.status !== 'completed') ?? [];
  if (unfinished.length > 0) {
    return {
      action: 'continue',
      reason: 'durable_plan_unfinished',
      reply: continuationReply(unfinished.map((item) => item.step))
    };
  }

  if (inFlightToolCalls(input.conversationId) > 0) {
    return { action: 'wait', reason: 'tool_work_in_flight' };
  }

  const background = backgroundExecObligations(input.sessionId);
  if (background.running.length > 0 || background.exitedUnread.length > 0) {
    return { action: 'wait', reason: 'background_exec_unsettled' };
  }

  const execution = executionForConversation(input.conversationId);
  if (execution?.mode === 'infinite') {
    return {
      action: 'continue',
      reason: 'infinite_execution_milestone_only',
      reply:
        'The current milestone may be complete, but this execution is in infinite mode. Continue with the next highest-value in-scope milestone and verify it before moving on.'
    };
  }

  return { action: 'allow_stop', reason: 'no_contradictory_core_evidence' };
}
