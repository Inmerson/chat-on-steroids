import type { AgentState } from './session.js';

export type AgentActivity = 'starting' | 'working' | 'tool_call' | 'waiting' | 'sleeping' | 'done';
export type AgentHealth = 'healthy' | 'degraded' | 'stalled' | 'blocked' | 'unknown';
export type AgentHealthRecommendedAction = 'none' | 'observe' | 'retry_delivery' | 'user_attention';
export type AgentHealthIdentity = 'exact' | 'missing' | 'conflicting';
export type AgentHealthBrowser = 'present' | 'missing' | 'unknown';

export interface AgentHealthWaitEvidence {
  kind: string;
  deadlineAt: number | null;
  exempt: boolean;
  recommendedAction: Exclude<AgentHealthRecommendedAction, 'none'>;
}

export interface AgentHealthBlockerEvidence {
  kind: string;
  summary: string;
}

export interface AgentHealthEvidence {
  identity: AgentHealthIdentity;
  browser: AgentHealthBrowser;
  runningToolCalls: number;
  generating: boolean | null;
  activeTurn: boolean | null;
  wait: AgentHealthWaitEvidence | null;
  blocker: AgentHealthBlockerEvidence | null;
}

export interface AgentHealthInput extends AgentHealthEvidence {
  agentId: string;
  conversationId: string | null;
  state: AgentState;
  observedAt: number;
}

export interface AgentHealthSnapshot {
  agentId: string;
  conversationId: string | null;
  activity: AgentActivity;
  health: AgentHealth;
  recommendedAction: AgentHealthRecommendedAction;
  reason: string;
  observedAt: number;
  evidence: AgentHealthEvidence;
}

export function evaluateAgentHealth(_input: AgentHealthInput): AgentHealthSnapshot {
  throw new Error('agent health projection not implemented');
}
