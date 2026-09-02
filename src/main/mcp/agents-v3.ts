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

const managerTaskSchema = z
  .object({
    taskId: z.string().min(1).max(160),
    parentTaskId: z.string().min(1).max(160).nullable(),
    title: z.string().min(1).max(500),
    goal: z.string().min(1).max(4000),
    allowedScope: z.array(z.string().min(1).max(4000)).max(100),
    dependencies: z.array(z.string().min(1).max(160)).max(100),
    acceptanceCriteria: z.array(z.string().min(1).max(4000)).min(1).max(100),
    expectedVerification: z.array(z.string().min(1).max(4000)).max(100),
    forbiddenActions: z.array(z.string().min(1).max(4000)).max(100),
    riskClass: z.enum(['normal', 'high'])
  })
  .strict();

const assignManagerSchema = z
  .object({
    action: z.literal('assign_manager'),
    manager_agent_id: z.string().min(1).max(40)
  })
  .strict();

const managerPlanSchema = z
  .object({
    action: z.literal('plan'),
    plan_id: z.string().min(1).max(160),
    tasks: z.array(managerTaskSchema).min(1).max(200)
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

/**
 * Extends only the existing `agents` registration. Every V2 call still reaches the original
 * schema and handler unchanged; V3 adds two strict alternatives without adding another tool.
 */
export function decorateCoreRegistrarWithAgentV3(reg: SurfaceRegistrar): SurfaceRegistrar {
  return {
    ...reg,
    register(name, config, handler) {
      if (name !== 'agents') {
        reg.register(name, config, handler);
        return;
      }

      const inputSchema = z.union([config.inputSchema, assignManagerSchema, managerPlanSchema]);
      reg.register(
        name,
        {
          ...config,
          description:
            `${config.description} ` +
            'Agent System 3.0: a proven Prime may designate one owned worker with action=assign_manager; ' +
            'the designated Manager submits the dependency graph with action=plan. Run and Manager authority are derived by the app, never supplied on plan calls.',
          inputSchema
        },
        async (input) => {
          const v3 = input as z.output<typeof assignManagerSchema> | z.output<typeof managerPlanSchema> | z.output<typeof config.inputSchema>;
          if (typeof v3 === 'object' && v3 !== null && 'action' in v3 && v3.action === 'assign_manager') {
            const startedAt = currentCall()?.startedAt ?? Date.now();
            return guard('agents', async () => {
              if (!reg.agentToolsLive) {
                return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
              }
              const caller = await callerNowForAgentV3(startedAt);
              const authority = await assignManagerForPrime(caller, v3.manager_agent_id);
              return assignManagerResult(authority.runId, authority.agentId);
            });
          }

          if (typeof v3 === 'object' && v3 !== null && 'action' in v3 && v3.action === 'plan') {
            const startedAt = currentCall()?.startedAt ?? Date.now();
            return guard('agents', async () => {
              if (!reg.agentToolsLive) {
                return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
              }
              const caller = await callerNowForAgentV3(startedAt);
              const accepted = await acceptManagerPlanForCaller(caller, {
                planId: v3.plan_id,
                tasks: v3.tasks
              });
              return planResult(v3.plan_id, accepted);
            });
          }

          return handler(input as never);
        }
      );
    }
  };
}
