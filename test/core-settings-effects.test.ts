import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import { reconcileCoreSettingsEffects } from '../src/main/core/settings-effects.js';

function deps() {
  return {
    startBridge: vi.fn(async () => 8765),
    stopBridge: vi.fn(async () => undefined),
    pauseSwarmForDisable: vi.fn(),
    cancelWorkerCommands: vi.fn(() => 2),
    persistAgentAuthorityNow: vi.fn(async () => true),
    retireGoalDrafts: vi.fn(),
    forgetExposedSurface: vi.fn()
  };
}

describe('Core settings side-effect ownership', () => {
  it('starts the bridge from Core when recording or multi-agent needs the browser', async () => {
    const before = defaultConfig();
    before.sessions.record = false;
    before.multiAgent.enabled = false;
    const after = structuredClone(before);
    after.sessions.record = true;
    const effects = deps();

    await reconcileCoreSettingsEffects(before, after, effects);

    expect(effects.startBridge).toHaveBeenCalledTimes(1);
    expect(effects.stopBridge).not.toHaveBeenCalled();
  });

  it('pauses and durably persists agent authority before stopping an unneeded bridge', async () => {
    const before = defaultConfig();
    before.sessions.record = false;
    before.multiAgent.enabled = true;
    const after = structuredClone(before);
    after.multiAgent.enabled = false;
    const effects = deps();

    await reconcileCoreSettingsEffects(before, after, effects);

    expect(effects.pauseSwarmForDisable).toHaveBeenCalledTimes(1);
    expect(effects.cancelWorkerCommands).toHaveBeenCalledWith('multi-agent mode was turned off');
    expect(effects.persistAgentAuthorityNow).toHaveBeenCalledTimes(1);
    expect(effects.forgetExposedSurface).toHaveBeenCalledTimes(1);
    expect(effects.stopBridge).toHaveBeenCalledTimes(1);
  });

  it('fails closed when disabled agent authority cannot be made durable', async () => {
    const before = defaultConfig();
    before.sessions.record = false;
    before.multiAgent.enabled = true;
    const after = structuredClone(before);
    after.multiAgent.enabled = false;
    const effects = deps();
    effects.persistAgentAuthorityNow.mockResolvedValue(false);

    await expect(reconcileCoreSettingsEffects(before, after, effects)).rejects.toThrow(/durable/i);
    expect(effects.stopBridge).not.toHaveBeenCalled();
  });

  it('retires in-flight goal drafts when the goal runtime settings change', async () => {
    const before = defaultConfig();
    const after = structuredClone(before);
    after.goal.model = 'another/model';
    const effects = deps();

    await reconcileCoreSettingsEffects(before, after, effects);

    expect(effects.retireGoalDrafts).toHaveBeenCalledTimes(1);
  });
});
