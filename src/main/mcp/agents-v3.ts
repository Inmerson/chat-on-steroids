import { z } from 'zod';

import { agentForCaller, type Caller } from '../agents.js';
import { assignManagerForPrime } from '../orchestration/manager-authority.js';
import { acceptManagerPlanForCaller } from '../orchestration/manager-surface.js';
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
  accepted: Awaited<ReturnType<typeof acceptManagerPlanForCaller>>
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: accepted.repeated
          ? `Manager plan ${planId} was already accepted with the same content.`
          : `Manager plan ${planId} accepted.`
      }
    ],
    structuredContent: {
      action: 'plan',
      run_id: accepted.runId,
      manager_agent_id: accepted.managerAgentId,
      ready_task_ids: accepted.readyTaskIds,
      repeated: accepted.repeated
    }
  };
}

function extendAgentsSchema(base: z.ZodType): z.ZodType {
  if (!(base instanceof z.ZodObject)) {
    throw new Error('Agent System 3.0 expected the existing agents input schema to remain a Zod object');
  }

  return base
    .safeExtend({
      action: z.enum(['spawn', 'message', 'status', 'finish', 'assign_manager', 'plan']),
      manager_agent_id: z.string().optional(),
      plan_id: z.string().optional(),
      tasks: z.array(managerTaskWireSchema).optional()
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
              const accepted = await acceptManagerPlanForCaller(caller, {
                planId: value['plan_id'] as string,
                tasks: value['tasks'] as z.output<typeof managerTaskWireSchema>[]
              });
              return planResult(value['plan_id'] as string, accepted);
            });
          }

          return handler(input as never);
        }
      );
    }
  };
}
