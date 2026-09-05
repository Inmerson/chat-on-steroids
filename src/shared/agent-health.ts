import type { AgentInfo } from './session.js';

export type AgentActivity = 'starting' | 'working' | 'tool_call' | 'waiting' | 'sleeping' | 'done';
export type AgentHealth = 'healthy' | 'degraded' | 'stalled' | 'blocked' | 'unknown';
export type AgentHealthRecommendedAction = 'none' | 'observe' | 'wake' | 'retry_delivery' | 'user_attention';

export interface AgentFiniteWaitEvidence {
  kind: 'transfer' | 'delivery' | 'stale_command';
  startedAt: number;
  deadlineMs: number;
  exempt: boolean;
  recommendedAction: 'observe' | 'retry_delivery' | 'user_attention';
}

export interface AgentHealthEvidence {
  identity: 'exact' | 'missing' | 'conflict';
  browserPresent: boolean | null;
  runningToolCalls: number;
  generating: boolean;
  activeTurnId: boolean;
  workflowBlocked: boolean;
  finiteWait: AgentFiniteWaitEvidence | null;
}

export interface AgentHealthInput {
  id: string;
  broker: AgentInfo | null;
  evidence: AgentHealthEvidence;
}

export interface AgentHealthSnapshot {
  agentId: string;
  conversationId: string | null;
  activity: AgentActivity;
  health: AgentHealth;
  observedAt: number;
  lastSeenAt: number | null;
  recommendedAction: AgentHealthRecommendedAction;
  reason: string;
  evidence: {
    identity: AgentHealthEvidence['identity'];
    browserPresent: boolean | null;
    runningToolCalls: number;
    generating: boolean;
    activeTurnId: boolean;
    workflowBlocked: boolean;
    finiteWaitKind: AgentFiniteWaitEvidence['kind'] | null;
  };
}
