import type {
  AgentActivity,
  AgentFiniteWaitEvidence,
  AgentHealthInput,
  AgentHealthRecommendedAction,
  AgentHealthSnapshot
} from '../shared/agent-health.js';

function activityFor(input: AgentHealthInput): AgentActivity {
  const broker = input.broker;
  if (broker?.state === 'finished' || broker?.state === 'failed') return 'done';
  if (broker?.state === 'sleeping') return 'sleeping';
  if (input.evidence.runningToolCalls > 0) return 'tool_call';
  if (input.evidence.generating || input.evidence.activeTurnId) return 'working';
  if (broker?.state === 'invited') return 'starting';
  if (broker?.state === 'waking' || (broker?.pending ?? 0) > 0 || (broker?.awaitingAck ?? 0) > 0) return 'waiting';
  if (!broker) return 'waiting';
  return broker.state === 'active' || broker.state === 'detached' ? 'working' : 'waiting';
}

function timingIsValid(wait: AgentFiniteWaitEvidence, observedAt: number): boolean {
  return (
    Number.isFinite(wait.startedAt) &&
    wait.startedAt <= observedAt &&
    Number.isFinite(wait.deadlineMs) &&
    wait.deadlineMs > 0
  );
}

function result(
  input: AgentHealthInput,
  observedAt: number,
  activity: AgentActivity,
  health: AgentHealthSnapshot['health'],
  recommendedAction: AgentHealthRecommendedAction,
  reason: string
): AgentHealthSnapshot {
  const { evidence } = input;
  return {
    agentId: input.id,
    conversationId: input.broker?.conversationId ?? null,
    activity,
    health,
    observedAt,
    lastSeenAt: input.broker?.lastSeenAt ?? null,
    recommendedAction,
    reason,
    evidence: {
      identity: evidence.identity,
      browserPresent: evidence.browserPresent,
      runningToolCalls: evidence.runningToolCalls,
      generating: evidence.generating,
      activeTurnId: evidence.activeTurnId,
      workflowBlocked: evidence.workflowBlocked,
      finiteWaitKind: evidence.finiteWait?.kind ?? null
    }
  };
}

export function evaluateAgentHealth(input: AgentHealthInput, observedAt: number): AgentHealthSnapshot {
  const activity = activityFor(input);
  const { broker, evidence } = input;

  if (evidence.workflowBlocked) {
    return result(input, observedAt, activity, 'blocked', 'user_attention', 'Workflow evidence reports a blocking condition.');
  }

  if (evidence.identity !== 'exact') {
    const detail = evidence.identity === 'conflict' ? 'conflicting' : 'missing';
    return result(
      input,
      observedAt,
      activity,
      'unknown',
      'observe',
      `Conversation identity evidence is ${detail}; exact attribution is unavailable.`
    );
  }

  if (evidence.runningToolCalls > 0 || evidence.generating || evidence.activeTurnId) {
    let reason: string;
    if (evidence.runningToolCalls > 0) {
      reason = `Exact conversation has ${evidence.runningToolCalls} MCP call${evidence.runningToolCalls === 1 ? '' : 's'} still inside dispatch.`;
    } else if (evidence.generating) {
      reason = 'Exact conversation is reporting active generation.';
    } else {
      reason = 'Exact conversation has an active turn identifier.';
    }
    return result(input, observedAt, activity, 'healthy', 'none', reason);
  }

  if (broker?.state === 'finished' || broker?.state === 'failed' || broker?.state === 'sleeping') {
    return result(input, observedAt, activity, 'healthy', 'none', `Broker lifecycle state is ${broker.state}.`);
  }

  if (evidence.finiteWait) {
    const wait = evidence.finiteWait;
    if (!timingIsValid(wait, observedAt)) {
      return result(
        input,
        observedAt,
        activity,
        'degraded',
        'observe',
        `Finite ${wait.kind} timing evidence is invalid or future-dated.`
      );
    }
    if (!wait.exempt && observedAt > wait.startedAt + wait.deadlineMs) {
      return result(
        input,
        observedAt,
        activity,
        'stalled',
        wait.recommendedAction,
        `Finite ${wait.kind} wait exceeded its existing ${wait.deadlineMs} ms deadline.`
      );
    }
  }

  if (broker?.state === 'detached') {
    return result(input, observedAt, activity, 'degraded', 'observe', 'Broker lifecycle state is detached.');
  }

  if (broker?.lastSeenAt !== null && broker?.lastSeenAt !== undefined) {
    if (!Number.isFinite(broker.lastSeenAt) || broker.lastSeenAt > observedAt) {
      return result(
        input,
        observedAt,
        activity,
        'degraded',
        'observe',
        'First-hand liveness timestamp is invalid or future-dated.'
      );
    }
  }

  if (
    broker &&
    (broker.state === 'active' || broker.state === 'invited' || broker.state === 'waking') &&
    evidence.browserPresent !== true
  ) {
    return result(
      input,
      observedAt,
      activity,
      'degraded',
      'observe',
      'No current browser-presence evidence is available for this active lifecycle state.'
    );
  }

  return result(input, observedAt, activity, 'healthy', 'none', 'Available exact evidence shows no health exception.');
}
