import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_MCP_PLUGINS } from '../src/renderer/plugins-data.js';
import { initPluginsView } from '../src/renderer/plugins-view.js';

describe('Plugins and MCP Ecosystem', () => {
  let dom: JSDOM;

  beforeAll(async () => {
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
    dom = new JSDOM(html, { url: 'http://localhost' });
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.HTMLInputElement = dom.window.HTMLInputElement;
    globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
    globalThis.localStorage = dom.window.localStorage;
  });

  describe('DOM Integration & Navigation', () => {
    it('exposes a plugins tab button in nav with i-puzzle icon', () => {
      const tab = dom.window.document.querySelector('nav button[data-tab="plugins"]');
      expect(tab).not.toBeNull();
      expect(tab?.textContent).toContain('Plugins');
      expect(tab?.querySelector('svg use')?.getAttribute('href')).toBe('#i-puzzle');
    });

    it('exposes a plugins panel with pluginsMount container', () => {
      const panel = dom.window.document.querySelector('.panel[data-panel="plugins"]');
      expect(panel).not.toBeNull();
      expect(panel?.id).toBe('pluginsPanel');
      expect(panel?.classList.contains('scroll')).toBe(true);
      const mount = panel?.querySelector('#pluginsMount');
      expect(mount).not.toBeNull();
    });

    it('exposes the Outputs & Sources indicator widget in the chat timeline', () => {
      const widget = dom.window.document.getElementById('chatOutputsSourcesWidget');
      expect(widget).not.toBeNull();
      expect(widget?.closest('.view[data-view="timeline"]')).not.toBeNull();

      expect(dom.window.document.getElementById('osOutputsList')).not.toBeNull();
      expect(dom.window.document.getElementById('osNewOutputBtn')).not.toBeNull();
      expect(dom.window.document.getElementById('osSourcesList')).not.toBeNull();
      expect(dom.window.document.getElementById('osAddSourceBtn')).not.toBeNull();
      expect(dom.window.document.getElementById('osViewAllSourcesBtn')).not.toBeNull();
    });
  });

  describe('Built-in MCP Plugins Catalog', () => {
    it('includes all primary MCP servers (Core, Desktop, Filesystem, Git, Memory, Sequential, Fetch)', () => {
      expect(BUILTIN_MCP_PLUGINS.length).toBeGreaterThanOrEqual(7);

      const ids = BUILTIN_MCP_PLUGINS.map((p) => p.id);
      expect(ids).toContain('chat-on-steroids-core');
      expect(ids).toContain('chat-on-steroids-desktop');
      expect(ids).toContain('chat-on-steroids-filesystem');
      expect(ids).toContain('chat-on-steroids-git');
      expect(ids).toContain('chat-on-steroids-memory');
      expect(ids).toContain('chat-on-steroids-sequential');
      expect(ids).toContain('chat-on-steroids-fetch');
    });

    it('exposes core tools (read, apply_patch, exec_command, session, agents)', () => {
      const core = BUILTIN_MCP_PLUGINS.find((p) => p.id === 'chat-on-steroids-core')!;
      expect(core).toBeDefined();
      const toolNames = core.tools.map((t) => t.name);
      expect(toolNames).toContain('read');
      expect(toolNames).toContain('apply_patch');
      expect(toolNames).toContain('exec_command');
      expect(toolNames).toContain('session');
      expect(toolNames).toContain('agents');
    });
  });

  describe('Plugins View Rendering and Interactions', () => {
    it('renders hero, statistics, search input, category filters, and plugin cards', () => {
      initPluginsView('pluginsMount');
      const mount = dom.window.document.getElementById('pluginsMount')!;

      // Hero & Title
      const title = mount.querySelector('.plugins-title');
      expect(title?.textContent).toContain('Plugins & MCP Servers');

      // Stats
      const countVal = mount.querySelector('#pluginsCountVal');
      expect(Number(countVal?.textContent)).toBeGreaterThanOrEqual(7);
      const toolsCountVal = mount.querySelector('#pluginsToolsCountVal');
      expect(toolsCountVal?.textContent).toContain('+');

      // Search & Filters
      const search = mount.querySelector<HTMLInputElement>('#pluginsSearchInput');
      expect(search).not.toBeNull();
      const categories = mount.querySelectorAll('.plugins-filter-btn');
      expect(categories.length).toBeGreaterThanOrEqual(6);

      // Plugin Cards
      const cards = mount.querySelectorAll('.plugin-card');
      expect(cards.length).toBeGreaterThanOrEqual(7);
    });

    it('filters plugins when search input changes', () => {
      initPluginsView('pluginsMount');
      const mount = dom.window.document.getElementById('pluginsMount')!;
      const search = mount.querySelector<HTMLInputElement>('#pluginsSearchInput')!;

      search.value = 'git';
      search.dispatchEvent(new dom.window.Event('input'));

      const cards = mount.querySelectorAll('.plugin-card');
      expect(cards.length).toBe(1);
      expect(cards[0]?.getAttribute('data-plugin-id')).toBe('chat-on-steroids-git');
    });
  });
});
