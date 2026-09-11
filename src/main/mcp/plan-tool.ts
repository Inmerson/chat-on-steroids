import { agentPlanUpdateSchema } from '../../shared/agent-plan.js';
import { updateSessionPlan } from '../session/store.js';
import { currentCall, currentCaller } from './call-context.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

/**
 * Displays one durable task plan for the proven local session. This is intentionally not an
 * orchestration authority: it never advances Agent System 3.0 or durable execution state.
 */
export function registerPlanTool(reg: SurfaceRegistrar): void {
  reg.register(
    'update_plan',
    toolDeclaration('update_plan', () => ({
      title: 'Update plan',
      description:
        'Updates your task plan in the user’s app. Use for work with several meaningful steps; skip simple tasks. ' +
        'Send the complete plan with short step headlines, useful details and current statuses. Keep at most one ' +
        'step in_progress. Update after completing a step or changing approach. This only displays a plan; it does ' +
        'not execute or orchestrate work.',
      inputSchema: agentPlanUpdateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    })),
    (update) =>
      guard('update_plan', async () => {
        if (!reg.sessionToolsLive) {
          return reg.featureDisabled('Session recording', 'Settings → Chat');
        }
        const caller = currentCaller();
        const call = currentCall();
        if (!caller.sessionId || !caller.conversationId || !call) {
          return fail(
            'Exact chat identity is required to update its plan. No plan was changed; retry after the companion reconnects.'
          );
        }
        const accepted = await updateSessionPlan(
          caller.sessionId,
          caller.conversationId,
          update,
          call.startedAt
        );
        return accepted
          ? ok('Plan updated')
          : fail('This plan update is stale or its chat was replaced. The current plan was preserved.');
      })
  );
}
