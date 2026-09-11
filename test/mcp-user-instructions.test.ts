import { afterAll, beforeAll, afterEach, expect, it, vi } from 'vitest';
import { CAPABILITIES, type Capabilities } from '../src/shared/types.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { pluginManager } from '../src/main/plugins/manager.js';
import { serverInstructions } from '../src/main/mcp/instructions.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';

const allCapabilities = (): Capabilities =>
  Object.fromEntries(CAPABILITIES.map((name) => [name, true])) as Capabilities;

const ctx = {
  roots: [{ name: 'workspace', path: process.cwd() }],
  caps: allCapabilities(),
  readOnly: false,
  sessionTools: true,
  agentTools: true
};

beforeAll(async () => {
  directory = await makeTempDir('clf-coding-instructions-');
  initConfigPath(directory);
  await saveConfig(defaultConfig());
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await removeTempDir(directory);
});

it('starts Core with adapted Codex autonomy while preserving current local-tool contracts', () => {
  const text = serverInstructions(ctx, 'core', 'win32');
  expect(text.startsWith('You are a coding agent working with the user through Chat On Steroids.')).toBe(true);
  expect(text).toContain('Do not settle for a partial or "helpful enough" solution');
  expect(text).toContain('look for AGENTS.md');
  expect(text).toContain('/workspace');
  expect(text).toContain('later paths may be relative');
  expect(text).toContain('PowerShell does not expand * or ? for native programs');
  expect(text).toContain('Use update_plan');
  expect(text).toContain('session action=search');
  expect(text).toContain('agents action=spawn');
  expect(text).toContain('Code Mode:');
  expect(text).toContain('tools.<name>(args)');
  expect(text).not.toMatch(/SKILL\.md|functions\.|tool_search|approval auto-review|user-requested computer shutdown/);
});

it('projects only capabilities that belong to the current surface and platform', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const text = serverInstructions(ctx, 'core', platform);
    expect(text, platform).not.toContain('Chat On Steroids Desktop');
    expect(text, platform).not.toContain('observe first, then computer');
    expect(text, platform).not.toContain('mouse and keyboard');
  }
  const desktop = serverInstructions(ctx, 'desktop', 'win32');
  expect(desktop).toContain('observe first, then computer');
  expect(desktop).not.toContain('apply_patch is the only way to change files');
});

it('mentions plan/session and workers only when those current feature surfaces are exposed', () => {
  const bare = serverInstructions({ ...ctx, sessionTools: false, agentTools: false }, 'core', 'win32');
  expect(bare).not.toContain('Use update_plan');
  expect(bare).not.toContain('agents action=spawn');

  const sessions = serverInstructions({ ...ctx, sessionTools: true, agentTools: false }, 'core', 'win32');
  expect(sessions).toContain('Use update_plan');
  expect(sessions).not.toContain('agents action=spawn');
});

it('mentions Plugins Code Mode only when the synthetic exec wrapper can actually be published', () => {
  vi.spyOn(pluginManager, 'tools').mockReturnValue([]);
  expect(serverInstructions(ctx, 'plugins', 'win32')).not.toContain('Code Mode:');

  vi.mocked(pluginManager.tools).mockReturnValue([
    { name: 'lookup', description: 'Fixture lookup', inputSchema: { type: 'object' } } as any
  ]);
  expect(serverInstructions(ctx, 'plugins', 'win32')).toContain('Code Mode:');

  vi.mocked(pluginManager.tools).mockReturnValue([
    { name: 'exec', description: 'Real upstream exec', inputSchema: { type: 'object' } } as any
  ]);
  expect(serverInstructions(ctx, 'plugins', 'win32')).not.toContain('Code Mode:');
});
