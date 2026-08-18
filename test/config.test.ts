import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, loadConfig, saveConfig, updateConfig } from '../src/main/config.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-config-');
  initConfigPath(dir);
});

afterAll(async () => {
  await removeTempDir(dir);
});

describe('settings migration', () => {
  it('preserves old settings when new safe-default capabilities and UI prefs are added', async () => {
    const oldConfig = {
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }],
      capabilities: {
        browse: true,
        search: true,
        read: true,
        metadata: true,
        create: true,
        edit: true,
        move: false,
        deleteFile: false,
        powershell: true,
        command: true,
        screen: true,
        control: true
      },
      readOnly: false,
      tunnel: {
        kind: 'openai',
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        binaryPath: ''
      },
      ui: { minimizeToTray: true, autoConnect: true }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(oldConfig), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual(oldConfig.roots);
    expect(loaded.capabilities.create).toBe(true);
    expect(loaded.capabilities.clipboardRead).toBe(false);
    expect(loaded.capabilities.clipboardWrite).toBe(false);
    expect(loaded.ui.autoConnect).toBe(true);
    expect(loaded.ui.privacyScreenshots).toBe(false);
    // The one tunnel id a pre-split config had is Core's, because Core is the connector
    // the app cannot work without. Desktop is a second, optional tunnel that starts empty
    // rather than inheriting Core's id — publishing Core twice would be worse than not
    // publishing Desktop at all.
    expect(loaded.tunnel.tunnelId).toBe(oldConfig.tunnel.tunnelId);
    expect(loaded.tunnel.desktopTunnelId).toBe('');
  });

  it('folds a PowerShell-only permission into the single command permission', async () => {
    // `powershell` and `command` were one tool each and are now the single exec_command.
    // A user who had granted only PowerShell keeps the ability they chose; the dead key
    // does not survive into the saved config.
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        capabilities: { ...defaultConfig().capabilities, powershell: true, deleteFolder: true }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(true);
    expect(Object.keys(loaded.capabilities)).not.toContain('powershell');
    // `deleteFolder` is dropped rather than folded into deleteFile: they were never the
    // same permission, and turning one into the other would widen what the user approved.
    expect(Object.keys(loaded.capabilities)).not.toContain('deleteFolder');
    expect(loaded.capabilities.deleteFile).toBe(false);
  });

  it('renames a saved root that claims a reserved virtual namespace', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...defaultConfig(), roots: [{ name: 'skills', path: 'C:\\Users\\example\\skills' }] }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots[0]?.name).toBe('skills-folder');
    expect(loaded.roots[0]?.path).toBe('C:\\Users\\example\\skills');
  });

  it('round-trips a second tunnel id for the Desktop connector', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      tunnel: {
        ...config.tunnel,
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        desktopTunnelId: 'tunnel_fedcba9876543210fedcba9876543210'
      }
    });
    const loaded = await loadConfig();
    expect(loaded.tunnel.tunnelId).toBe('tunnel_0123456789abcdef0123456789abcdef');
    expect(loaded.tunnel.desktopTunnelId).toBe('tunnel_fedcba9876543210fedcba9876543210');
  });

  /**
   * Automatic compaction ends the chat the user is working in and opens a fresh one, and it
   * used to start off on the grounds that this is not something to do to somebody who never
   * asked for it. In use that reasoning turned out to be backwards: the alternative to
   * compacting is hitting the ceiling mid-thought and losing the thread entirely, which is
   * the worse thing to have happen to somebody who never asked for it. So it starts on, at
   * the ceiling rather than at the advisory line.
   */
  it('starts with automatic compaction on at the ceiling', async () => {
    await saveConfig(defaultConfig());
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(loaded.sessions.limitTokens);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  /**
   * The migration, and the line it must not cross. A config still carrying both old
   * defaults never had a decision made about it, so it moves to the new one. A config
   * carrying anything else is somebody's own setting and is left exactly as it is.
   */
  it('moves an untouched old default onto the new one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  it('leaves a user who turned automatic compaction off turned off', async () => {
    const config = defaultConfig();
    // Off, but at a threshold they chose: that is a decision, not an untouched default.
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 250_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.compaction.autoTokens).toBe(250_000);
  });

  it('keeps an automatic compaction the user configured', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      compaction: { ...config.compaction, auto: true, autoTokens: 150_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 150_000 });
  });

  /**
   * A config written before these fields existed gets the current defaults, like any other
   * absent field: absent is not a decision, so it reads as whatever the app decides now.
   */
  it('reads a config from before the setting existed as the current default', async () => {
    const config = defaultConfig();
    const older = { ...config, compaction: { ...config.compaction } } as Record<string, any>;
    delete older.compaction.auto;
    delete older.compaction.autoTokens;
    await saveConfig(older as ReturnType<typeof defaultConfig>);
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  it('serializes concurrent read-modify-write changes instead of losing one', async () => {
    await saveConfig(defaultConfig());
    const first = updateConfig(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...config, roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }] };
    });
    const second = updateConfig((config) => ({
      ...config,
      ui: { ...config.ui, theme: 'dark' as const }
    }));
    await Promise.all([first, second]);

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual([{ name: 'project', path: 'C:\\Users\\example\\project' }]);
    expect(loaded.ui.theme).toBe('dark');
  });
});

/**
 * Two product decisions that live in code rather than in a document, so they are pinned
 * here: the app is useless with recording off, and three concurrent workers reproducibly
 * trips ChatGPT's rate limit.
 */
describe('shipped defaults', () => {
  it('records sessions from first launch', () => {
    expect(defaultConfig().sessions.record).toBe(true);
  });

  it('starts multi-agent off, and caps a fresh run at two workers', () => {
    const config = defaultConfig();
    expect(config.multiAgent.enabled).toBe(false);
    expect(config.multiAgent.maxWorkers).toBe(2);
  });

  /**
   * The default moved after this app had already shipped with recording off. Turning it on
   * underneath somebody who switched it off would be changing a privacy setting on their
   * behalf, so the new default is for configs that do not have the key at all.
   */
  it('leaves an existing choice to record alone', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: false } });
    expect((await loadConfig()).sessions.record).toBe(false);
  });

  it('applies the new default to a config written before the setting existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { sessions: _dropped, ...withoutSessions } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutSessions), 'utf8');
    expect((await loadConfig()).sessions.record).toBe(true);
  });
});
