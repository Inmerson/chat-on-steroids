import { MAX_MESSAGE_CHARS } from '../agents.js';
import type { TaskRecord } from './types.js';

/**
 * The broker currently gives worker bootstrap tasks and ordinary agent messages the same 4K
 * envelope. Keep V3's composed Task Contract inside that existing public limit rather than
 * teaching the scheduler a larger private payload the browser/broker cannot safely carry.
 */
export const MAX_TASK_CONTRACT_CHARS = MAX_MESSAGE_CHARS;

export function assignmentMarker(operationId: string): string {
  const id = operationId.trim();
  if (!id) throw new Error('Assignment marker requires an operation id');
  return `AS3-Assignment: ${id}`;
}

function list(title: string, values: readonly string[], empty = '(none)'): string[] {
  return [title, ...(values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${empty}`])];
}

export function formatTaskContract(task: TaskRecord, operationId: string): string {
  const lines = [
    assignmentMarker(operationId),
    `Task: ${task.taskId}`,
    `Title: ${task.title}`,
    '',
    'Goal:',
    task.goal,
    '',
    ...list('Allowed scope:', task.allowedScope),
    '',
    ...list('Dependencies already verified:', task.dependencies),
    '',
    ...list('Acceptance criteria:', task.acceptanceCriteria),
    '',
    ...list('Expected verification:', task.expectedVerification),
    '',
    ...list('Forbidden actions:', task.forbiddenActions),
    '',
    'Execution rules:',
    '- Work only inside the assigned task worktree and allowed scope.',
    '- Do not broaden scope on your own; report a blocker or scope-change need to the Manager.',
    '- Do not push, deploy, merge, or perform destructive external actions unless the Task Contract explicitly allows it.',
    '- When this piece is complete, report the concrete changes, verification evidence, risks, and blockers through the agent completion path.'
  ];
  const text = lines.join('\n');
  if (text.length > MAX_TASK_CONTRACT_CHARS) {
    throw new Error(`Task Contract is too large (${text.length} characters; limit ${MAX_TASK_CONTRACT_CHARS})`);
  }
  return text;
}

/** Validate a task before any assignment operation id exists. A fixed UUID-length probe makes
 * the size check identical to the contract the scheduler will later send. */
export function assertTaskContractFits(task: TaskRecord): void {
  formatTaskContract(task, '00000000-0000-4000-8000-000000000000');
}
