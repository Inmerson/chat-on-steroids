import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();

describe('runtime multi-agent enable regression', () => {
  it('keeps persistence/restore authority in Core and preserves history while disabled', async () => {
    const [core, ui] = await Promise.all([
      readFile(path.join(repo, 'src/main/core/runtime.ts'), 'utf8'),
      readFile(path.join(repo, 'src/main/index.ts'), 'utf8')
    ]);
    const persistSink = core.indexOf('onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot))');
    const restore = core.indexOf('restoreSwarm(await readDurable<SwarmSnapshot>(SWARM_STATE))');
    const disabledPause = core.indexOf("pauseSwarmForDisable('multi-agent mode is disabled')");

    expect(persistSink).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(disabledPause).toBeGreaterThanOrEqual(0);
    expect(persistSink).toBeLessThan(restore);
    expect(restore).toBeLessThan(disabledPause);
    expect(core).not.toContain('await writeDurableNow(SWARM_STATE, null)');
    // Presentation UI must not become a second durable/swarm writer after the Core split.
    expect(ui).not.toContain('onSwarmPersistNow(');
    expect(ui).not.toContain('restoreSwarm(');
  });
});

describe('companion extension setup contract', () => {
  it('keeps standalone recovery visible without pointing an installed app at releases/latest', async () => {
    const [html, renderer, preload, ipc] = await Promise.all([
      readFile(path.join(repo, 'src/renderer/index.html'), 'utf8'),
      readFile(path.join(repo, 'src/renderer/main-app.ts'), 'utf8'),
      readFile(path.join(repo, 'src/preload/index.ts'), 'utf8'),
      readFile(path.join(repo, 'src/main/ipc-ui.ts'), 'utf8')
    ]);

    expect(html).toMatch(/id="bridgeDownload"[\s\S]*?Download extension ZIP/i);
    expect(html).toMatch(/Required for sub-agents/i);
    expect(html).toMatch(/the companion extension must be loaded\s+and connected in ChatGPT/i);
    expect(html).not.toContain('/releases/latest/');
    expect(ipc).not.toContain('/releases/latest/');
    expect(renderer).toContain('api.downloadExtension()');
    expect(preload).toContain("call<boolean>('bridge:downloadExtension')");
    expect(ipc).toContain("handle('bridge:downloadExtension'");
  });
});
