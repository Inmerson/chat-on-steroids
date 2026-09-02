import type { Caller } from '../agents.js';
import { managerForCaller } from './manager-authority.js';
import {
  acceptInitialManagerPlan,
  type ManagerPlanAcceptance,
  type ManagerTaskPlan
} from './manager-plan.js';

export interface ManagerPlanRequest {
  planId: string;
  tasks: ManagerTaskPlan[];
}

export async function acceptManagerPlanForCaller(
  caller: Caller,
  request: ManagerPlanRequest
): Promise<ManagerPlanAcceptance & { runId: string; managerAgentId: string }> {
  const authority = await managerForCaller(caller);
  const accepted = await acceptInitialManagerPlan({
    planId: request.planId,
    runId: authority.runId,
    managerAgentId: authority.agentId,
    tasks: request.tasks
  });
  return {
    ...accepted,
    runId: authority.runId,
    managerAgentId: authority.agentId
  };
}
