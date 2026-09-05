import type { Config } from '../../shared/types.js';

export interface CoreSettingsEffects {
  startBridge(): Promise<number | null>;
  stopBridge(): Promise<void>;
  pauseSwarmForDisable(reason?: string): void;
  cancelWorkerCommands(reason: string): number;
  persistAgentAuthorityNow(): Promise<boolean>;
  retireGoalDrafts(): void;
  forgetExposedSurface(): void;
  forgetWorkspaceRoot(name: string): void;
  renameWorkspaceRoot(name: string, newName: string): void;
}

function goalRuntimeChanged(before: Config, after: Config): boolean {
  return (
    before.goal.enabled !== after.goal.enabled ||
    before.goal.model !== after.goal.model ||
    before.goal.reasoning !== after.goal.reasoning ||
    before.goal.prompt !== after.goal.prompt ||
    before.goal.objectivePrompt !== after.goal.objectivePrompt
  );
}

function reconcileWorkspaceRoots(before: Config, after: Config, effects: CoreSettingsEffects): void {
  const afterByPath = new Map(after.roots.map((root) => [root.path, root]));
  const afterNames = new Set(after.roots.map((root) => root.name));

  for (const oldRoot of before.roots) {
    const samePath = afterByPath.get(oldRoot.path);
    if (samePath && samePath.name !== oldRoot.name) {
      effects.renameWorkspaceRoot(oldRoot.name, samePath.name);
      continue;
    }
    if (!afterNames.has(oldRoot.name)) effects.forgetWorkspaceRoot(oldRoot.name);
  }
}

/**
 * Applies settings transitions that mutate Core-owned runtime state.
 *
 * This intentionally lives in the Core process rather than Electron UI. The config file is the
 * durable desired state; this reconciler is the single owner of bridge/swarm/schema/workspace
 * side effects after Core reloads that desired state. In particular, disabling multi-agent is
 * made durable before the browser bridge is stopped so a UI crash cannot leave worker authority
 * half-paused.
 */
export async function reconcileCoreSettingsEffects(
  before: Config,
  after: Config,
  effects: CoreSettingsEffects
): Promise<void> {
  reconcileWorkspaceRoots(before, after, effects);
  if (goalRuntimeChanged(before, after)) effects.retireGoalDrafts();

  if (before.multiAgent.enabled && !after.multiAgent.enabled) {
    effects.pauseSwarmForDisable('multi-agent mode is disabled');
    effects.cancelWorkerCommands('multi-agent mode was turned off');
    if (!(await effects.persistAgentAuthorityNow())) {
      throw new Error('Multi-agent teardown could not be made durable.');
    }
    effects.forgetExposedSurface();
  }

  const needsBridge = after.sessions.record || after.multiAgent.enabled;
  if (needsBridge) await effects.startBridge();
  else await effects.stopBridge();
}
