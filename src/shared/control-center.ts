import type { AgentState } from './session.js';

export const CONTROL_CENTER_VERSION = 1 as const;
export const CONTROL_CENTER_BROWSER_BUDGET = 5 as const;

export type ControlCenterRunHealth = 'running' | 'blocked' | 'failed' | 'verified';
export type ControlCenterWorkflowStatus = 'none' | 'running' | 'needs_verification' | 'awaiting_system_review' | 'verified' | 'blocked';

export interface ControlCenterRunStatus {
  id: string;
  planId: string | null;
  managerAgentId: string | null;
  orchestrationStatus: 'RUNNING' | 'RUN_VERIFIED';
  workflowStatus: ControlCenterWorkflowStatus;
  health: ControlCenterRunHealth;
  progress: {
    verified: number;
    total: number;
  };
  activeAgents: number;
}

export type ControlCenterVerificationStatus = 'none' | 'pending' | 'passed' | 'failed' | 'stale';

export interface ControlCenterVerificationSummary {
  status: ControlCenterVerificationStatus;
  revision: string | null;
  total: number;
  passed: number;
  failed: number;
  lastFinishedAt: number | null;
  error: string | null;
}

export interface ControlCenterWorktree {
  id: string;
  branch: string;
  virtualPath: string;
}

export interface ControlCenterTaskStatus {
  id: string;
  title: string;
  goal: string;
  state:
    | 'PLANNED'
    | 'READY'
    | 'ASSIGNED'
    | 'ACTIVE'
    | 'READY_FOR_REVIEW'
    | 'REVIEWING'
    | 'CHANGES_REQUESTED'
    | 'BLOCKED'
    | 'APPROVED'
    | 'INTEGRATING'
    | 'INTEGRATED'
    | 'VERIFIED'
    | 'FAILED'
    | 'CANCELLED'
    | 'SUPERSEDED';
  riskClass: 'normal' | 'high';
  dependencies: string[];
  assignedWorkerId: string | null;
  reviewerId: string | null;
  reviewRound: number;
  worktree: ControlCenterWorktree | null;
  changedFiles: string[];
  verification: ControlCenterVerificationSummary;
  blockers: string[];
  lastActivityAt: number | null;
}

export type ControlCenterAgentRole = 'prime' | 'manager' | 'worker' | 'reviewer' | 'system_reviewer';
export type ControlCenterAgentState = AgentState | 'unknown';

export interface ControlCenterAgentStatus {
  id: string;
  label: string;
  state: ControlCenterAgentState;
  roles: ControlCenterAgentRole[];
  boundTaskIds: string[];
  reviewedTaskIds: string[];
  chatBound: boolean;
  lastSeenAt: number | null;
  broker: {
    pending: number | null;
    awaitingAck: number | null;
    delivered: number | null;
  };
}

export type ControlCenterEdge =
  | { kind: 'dependency'; fromTaskId: string; toTaskId: string }
  | { kind: 'assignment'; agentId: string; taskId: string }
  | { kind: 'review'; agentId: string; taskId: string };

export type ControlCenterBlockerKind = 'task' | 'integration' | 'verification' | 'system_review' | 'workflow';

export interface ControlCenterBlocker {
  id: string;
  kind: ControlCenterBlockerKind;
  taskId: string | null;
  summary: string;
}

/** Reserved for durable L4/user-authority evidence. V1 has no producer for these yet. */
export interface ControlCenterAttentionItem {
  id: string;
  taskId: string | null;
  authority: 'user';
  summary: string;
}

export interface ControlCenterBrowserStatus {
  budget: typeof CONTROL_CENTER_BROWSER_BUDGET;
  used: number | null;
  queued: number | null;
  status: 'unavailable';
  note: string;
}

export interface ControlCenterStatus {
  version: typeof CONTROL_CENTER_VERSION;
  observedAt: number;
  run: ControlCenterRunStatus | null;
  tasks: ControlCenterTaskStatus[];
  agents: ControlCenterAgentStatus[];
  edges: ControlCenterEdge[];
  blockers: ControlCenterBlocker[];
  needsAttention: ControlCenterAttentionItem[];
  browser: ControlCenterBrowserStatus;
}
