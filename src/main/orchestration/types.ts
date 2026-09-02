export type TaskState =
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

export type TaskRiskClass = 'normal' | 'high';

export type ReviewOutcome = 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED';

export type AssignmentStrategy = 'reuse' | 'spawn';

export interface CompletionVerification {
  command: string;
  outcome: 'passed' | 'failed';
  revision: string | null;
}

export interface TaskCompletionPackage {
  status: 'ready_for_review';
  revision: string | null;
  changedFiles: string[];
  verification: CompletionVerification[];
  risks: string[];
  notes: string[];
}

/**
 * Durable identity of one task-isolated Git worktree.
 *
 * The native path is app state, never model authority. It is persisted so crash recovery can
 * re-bind a worker to the exact filesystem view that was prepared before its task was sent.
 */
export interface TaskWorktreeRecord {
  worktreeId: string;
  taskId: string;
  branch: string;
  baseRevision: string;
  realPath: string;
  virtualPath: string;
}

/** Write-before-action record for a worktree that may or may not have reached disk yet. */
export interface WorktreeIntentRecord extends TaskWorktreeRecord {
  operationId: string;
}

/** Write-before-action record for a worker assignment that may need broker reconciliation. */
export interface AssignmentIntentRecord {
  operationId: string;
  taskId: string;
  strategy: AssignmentStrategy;
  /** Exact sleeping worker for reuse; null when the broker will create a fresh worker. */
  requestedWorkerId: string | null;
  /** Digest of the deterministic Task Contract carrying operationId. */
  contractDigest: string;
}

export interface TaskRecord {
  taskId: string;
  parentTaskId: string | null;
  title: string;
  goal: string;
  /** Files/folders or other bounded resources this task may intentionally change. */
  allowedScope: string[];
  dependencies: string[];
  /** Observable conditions a reviewer must check before approval. */
  acceptanceCriteria: string[];
  /** Verification the worker is expected to execute and report, not pre-recorded proof. */
  expectedVerification: string[];
  /** Explicit user-owned or out-of-scope actions this task must not perform. */
  forbiddenActions: string[];
  state: TaskState;
  assignedWorkerId: string | null;
  reviewerId: string | null;
  worktreeId: string | null;
  reviewRound: number;
  /** Deterministic kernel-owned retry allowance. A Manager cannot reset this field. */
  retryBudget: number;
  riskClass: TaskRiskClass;
  completionPackage: TaskCompletionPackage | null;
}
