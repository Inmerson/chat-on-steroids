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
