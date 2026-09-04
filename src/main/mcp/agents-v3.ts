import { z } from 'zod';

import { agentForCaller, type Caller } from '../agents.js';
import { assignManagerForPrime } from '../orchestration/manager-authority.js';
import { acceptAndScheduleManagerPlanForCaller } from '../orchestration/manager-surface.js';
import {
  advanceWorkflowForCaller,
  submitRunReviewForCaller,
  submitTaskCompletionForCaller,
  submitTaskReviewForCaller
} from '../orchestration/workflow.js';
import { repairPrimeFromResumeShadow } from '../session/continuation.js';
import { awaitFreshCallOrigin } from '../session/recorder.js';
import { currentCall, currentCaller } from './call-context.js';
import {
  adoptAgent,
  guard,
  IDENTITY_EVIDENCE_MS,
  PRIME_EVIDENCE_MS,
  type SurfaceRegistrar,
  type ToolResult
} from './kernel.js';

/**
 * The wire only describes the Manager package's structure. The orchestration kernel performs
 * the authoritative bounds, graph, hierarchy and duplicate validation immediately before the
 * first journal mutation, so duplicating numeric limits here would only inflate discovery.
 */
const managerTaskWireSchema = z
  .object({
    taskId: z.string(),
    parentTaskId: z.string().nullable(),
    title: z.string(),
    goal: z.string(),
    allowedScope: z.array(z.string()),
    dependencies: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    expectedVerification: z.array(z.string()),
    forbiddenActions: z.array(z.string()),
    riskClass: z.enum(['normal', 'high'])
  })
  .strict();

const boundedWireText = z.string().min(1).max(1000);
const boundedWireList = z.array(boundedWireText).max(100);
const revisionWireSchema = z.string().regex(/^[0-9a-fA-F]{40}$/);
const completionVerificationWireSchema = z
  .object({
    command: boundedWireText,
    outcome: z.enum(['passed', 'failed']),
    revision: revisionWireSchema
  })
  .strict();

async function callerNowForAgentV3(startedAt: number): Promise<Caller> {
  const base = currentCaller();
  const window = base.requestId ? IDENTITY_EVIDENCE_MS : PRIME_EVIDENCE_MS;
  const resolved =
    base.conversationId ??
    (await awaitFreshCallOrigin('agents', startedAt, window, {
      requestId: base.requestId
    }));
  const caller: Caller = { ...base, conversationId: resolved };
  if (resolved) {
    const call = currentCall();
    if (call) call.caller.conversationId = resolved;
    await repairPrimeFromResumeShadow(resolved);
  }
  await adoptAgent(agentForCaller(caller));
  return caller;
}

function assignManagerResult(runId: string, managerAgentId: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `${managerAgentId} is now the designated Manager for Agent System 3.0.`
      }
    ],
    structuredContent: {
      action: 'assign_manager',
      run_id: runId,
      manager_agent_id: managerAgentId
    }
  };
}

function planResult(
  planId: string,
  accepted: Awaited<ReturnType<typeof acceptAndScheduleManagerPlanForCaller>>
): ToolResult {
  const scheduledIds = accepted.scheduling.scheduled.map((entry) => entry.taskId);
  const scheduleNote = accepted.scheduling.needsWorkspace
    ? ' Scheduling is waiting for the Prime conversation to establish a proven approved workspace.'
    : scheduledIds.length > 0
      ? ` Scheduled now: ${scheduledIds.join(', ')}.`
      : '';
  return {
    content: [
      {
        type: 'text',
        text: (accepted.repeated
          ? `Manager plan ${planId} was already accepted with the same content.`
          : `Manager plan ${planId} accepted.`) + scheduleNote
      }
    ],
    structuredContent: {
      action: 'plan',
      run_id: accepted.runId,
      manager_agent_id: accepted.managerAgentId,
      ready_task_ids: accepted.readyTaskIds,
      repeated: accepted.repeated,
      scheduled: accepted.scheduling.scheduled,
      still_ready_task_ids: accepted.scheduling.stillReady,
      blocked: accepted.scheduling.blocked,
      needs_workspace: accepted.scheduling.needsWorkspace
    }
  };
}

function workflowResult(action: string, text: string, structuredContent: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { action, ...structuredContent }
  };
}

function extendAgentsSchema(base: z.ZodType): z.ZodType {
  if (!(base instanceof z.ZodObject)) {
    throw new Error('Agent System 3.0 expected the existing agents input schema to remain a Zod object');
  }

  return base
    .safeExtend({
      action: z.enum([
        'spawn', 'message', 'status', 'finish', 'assign_manager', 'plan',
        'complete_task', 'review_task', 'review_run', 'advance'
      ]),
      manager_agent_id: z.string().optional(),
      plan_id: z.string().optional(),
      tasks: z.array(managerTaskWireSchema).optional(),
      task_id: z.string().min(1).max(160).optional(),
      revision: revisionWireSchema.optional(),
      changed_files: z.array(z.string().min(1).max(1000)).max(100).optional(),
      verification: z.array(completionVerificationWireSchema).max(100).optional(),
      risks: boundedWireList.optional(),
      notes: boundedWireList.optional(),
      verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED']).optional(),
      findings: boundedWireList.optional()
    })
    .superRefine((input, ctx) => {
      if (input.action === 'assign_manager') {
        if (!input.manager_agent_id) {
          ctx.addIssue({ code: 'custom', path: ['manager_agent_id'], message: 'action=assign_manager requires manager_agent_id' });
        }
      } else if (input.manager_agent_id !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['manager_agent_id'], message: 'manager_agent_id is only valid with action=assign_manager' });
      }

      if (input.action === 'plan') {
        if (!input.plan_id) ctx.addIssue({ code: 'custom', path: ['plan_id'], message: 'action=plan requires plan_id' });
        if (!input.tasks) ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'action=plan requires tasks' });
      } else {
        if (input.plan_id !== undefined) {
          ctx.addIssue({ code: 'custom', path: ['plan_id'], message: 'plan_id is only valid with action=plan' });
        }
        if (input.tasks !== undefined) {
          ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'tasks is only valid with action=plan' });
        }
      }


      const completionAction = input.action === 'complete_task';
      const taskReviewAction = input.action === 'review_task';
      const runReviewAction = input.action === 'review_run';
      if (completionAction || taskReviewAction) {
        if (!input.task_id) ctx.addIssue({ code: 'custom', path: ['task_id'], message: `${input.action} requires task_id` });
      } else if (input.task_id !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['task_id'], message: 'task_id is only valid with action=complete_task or action=review_task' });
      }

      const completionFields = ['revision', 'changed_files', 'verification', 'risks', 'notes'] as const;
      if (completionAction) {
        for (const field of completionFields) {
          if (input[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `action=complete_task requires ${field}` });
        }
      } else {
        for (const field of completionFields) {
          if (input[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is only valid with action=complete_task` });
        }
      }

      if (taskReviewAction || runReviewAction) {
        if (!input.verdict) ctx.addIssue({ code: 'custom', path: ['verdict'], message: `${input.action} requires verdict` });
        if (input.findings === undefined) ctx.addIssue({ code: 'custom', path: ['findings'], message: `${input.action} requires findings` });
        if (runReviewAction && input.verdict === 'CHANGES_REQUESTED') {
          ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'action=review_run accepts only APPROVED or BLOCKED' });
        }
      } else {
        if (input.verdict !== undefined) ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'verdict is only valid with a review action' });
        if (input.findings !== undefined) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'findings is only valid with a review action' });
      }
    });
}

/**
 * Extends only the existing `agents` registration. Every V2 call still reaches the original
 * handler unchanged; the base object's refinements stay attached through `safeExtend`, and V3
 * remains one flat public schema rather than an `anyOf` expansion.
 */
export function decorateCoreRegistrarWithAgentV3(reg: SurfaceRegistrar): SurfaceRegistrar {
  return {
    ...reg,
    register(name, config, handler) {
      if (name !== 'agents') {
        reg.register(name, config, handler);
        return;
      }

      const inputSchema = extendAgentsSchema(config.inputSchema);
      reg.register(
        name,
        {
          ...config,
          inputSchema
        },
        async (input) => {
          const value = input as Record<string, unknown>;
          if (value['action'] === 'assign_manager') {
            const startedAt = currentCall()?.startedAt ?? Date.now();
            return guard('agents', async () => {
              if (!reg.agentToolsLive) {
                return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
              }
              const caller = await callerNowForAgentV3(startedAt);
              const authority = await assignManagerForPrime(caller, value['manager_agent_id'] as string);
              return assignManagerResult(authority.runId, authority.agentId);
            });
          }

          if (value['action'] === 'plan') {
            const startedAt = currentCall()?.startedAt ?? Date.now();
            return guard('agents', async () => {
              if (!reg.agentToolsLive) {
                return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
              }
              const caller = await callerNowForAgentV3(startedAt);
              const accepted = await acceptAndScheduleManagerPlanForCaller(
                caller,
                {
                  planId: value['plan_id'] as string,
                  tasks: value['tasks'] as z.output<typeof managerTaskWireSchema>[]
                },
                reg.ctx.roots
              );
              return planResult(value['plan_id'] as string, accepted);
            });
          }

          if (value['action'] === 'complete_task') {
            const startedAt = currentCall()?.startedAt ?? Date.now();
            return guard('agents', async () => {
              if (!reg.agentToolsLive) return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
              const caller = await callerNowForAgentV3(startedAt);
              const result = await submitTaskCompletionForCaller(
                caller,
                {
                  taskId: value['task_id'] as string,
                  revision: value['revision'] as string,
                  changedFiles: value['changed_files'] as string[],
                  verification: value['verification'] as Array<{ command: string; outcome: 'passed' | 'failed'; revision: string }>,
                  risks: value['risks'] as string[],
                  notes: value['notes'] as string[]
                },
                reg.ctx.roots,
                reg.caps.command
              );
              return workflowResult('complete_task', `Task ${result.taskId} completion evidence was accepted for review.`, {
                task_id: result.taskId,
                reviewer_id: result.reviewerId
              });
            });
          }

          if (value['action'] === 'review_task') {
            const startedAt = currentCall()?.startedAt ?? Date.now();
            return guard('agents', async () => {
              if (!reg.agentToolsLive) return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
              const caller = await callerNowForAgentV3(startedAt);
              const result = await submitTaskReviewForCaller(
                caller,
                {
                  taskId: value['task_id'] as string,
                  verdict: value['verdict'] as 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED',
                  findings: value['findings'] as string[]
                },
                reg.ctx.roots,
                reg.caps.command
              );
              return workflowResult('review_task', `Review verdict ${result.verdict} recorded for task ${result.taskId}.`, {
                task_id: result.taskId,
                verdict: result.verdict
              });
            });
          }

          if (value['action'] === 'review_run') {
            const startedAt = currentCall()?.startedAt ?? Date.now();
            return guard('agents', async () => {
              if (!reg.agentToolsLive) return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
              const caller = await callerNowForAgentV3(startedAt);
              const result = await submitRunReviewForCaller(
                caller,
                value['verdict'] as 'APPROVED' | 'BLOCKED',
                value['findings'] as string[]
              );
              return workflowResult('review_run', `System Review verdict ${result.verdict} recorded.`, { verdict: result.verdict });
            });
          }

          if (value['action'] === 'advance') {
            const startedAt = currentCall()?.startedAt ?? Date.now();
            return guard('agents', async () => {
              if (!reg.agentToolsLive) return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
              const caller = await callerNowForAgentV3(startedAt);
              await advanceWorkflowForCaller(caller, reg.ctx.roots, reg.caps.command);
              return workflowResult('advance', 'The deterministic Agent System 3.0 kernel advanced every currently eligible step.', {});
            });
          }

          return handler(input as never);
        }
      );
    }
  };
}
