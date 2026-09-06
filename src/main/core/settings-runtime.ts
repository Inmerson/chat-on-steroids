import type { Config } from '../../shared/types.js';
import { pauseSwarmForDisable, persistAgentAuthorityNow } from '../agents.js';
import { cancelWorkerCommands, startBridge, stopBridge } from '../bridge.js';
import { applySettings } from '../connection.js';
import { retireGoalDrafts } from '../goal.js';
import { forgetExposedSurface } from '../mcp/server.js';
import { forgetWorkspaceRoot, renameWorkspaceRoot } from '../workspace.js';
import { reconcileCoreSettingsEffects } from './settings-effects.js';

/** One authority path for every durable config transition performed inside Core. */
export async function applyCoreSettingsTransition(before: Config, after: Config): Promise<void> {
  await reconcileCoreSettingsEffects(before, after, {
    startBridge,
    stopBridge,
    pauseSwarmForDisable,
    cancelWorkerCommands,
    persistAgentAuthorityNow,
    retireGoalDrafts,
    forgetExposedSurface,
    forgetWorkspaceRoot,
    renameWorkspaceRoot
  });
  await applySettings();
}
