import type { Caller } from '../agents.js';
import type { Root } from '../../shared/types.js';
import { managerForCaller } from './manager-authority.js';
import {
  acceptInitialManagerPlan,
  type ManagerPlanAcceptance,
  type ManagerTaskPlan
} from './manager-plan.js';
import {
  runManagerSchedulerCycle,
  type SchedulerCycleResult
} from './scheduler.js';

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

export type ManagerSchedulerRunner = (
  caller: Caller,
  roots: readonly Root[]
) => Promise<SchedulerCycleResult>;

export async function acceptAndScheduleManagerPlanForCaller(
  caller: Caller,
  request: ManagerPlanRequest,
  roots: readonly Root[],
  schedule: ManagerSchedulerRunner = runManagerSchedulerCycle
): Promise<
  ManagerPlanAcceptance & {
    runId: string;
    managerAgentId: string;
    scheduling: SchedulerCycleResult;
  }
> {
  const accepted = await acceptManagerPlanForCaller(caller, request);
  const scheduling = await schedule(caller, roots);
  return { ...accepted, scheduling };
}
