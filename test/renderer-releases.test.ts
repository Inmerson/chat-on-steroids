import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RELEASES_DATA } from '../src/renderer/releases-data.js';
import { initReleasesView } from '../src/renderer/releases-view.js';

describe('Release Notes (Sürüm Notları)', () => {
  let dom: JSDOM;

  beforeEach(async () => {
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
    dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
    const w = dom.window;
    Object.assign(globalThis, {
      window: w,
      document: w.document,
      HTMLElement: w.HTMLElement,
      Element: w.Element,
      Node: w.Node,
      HTMLInputElement: w.HTMLInputElement,
      HTMLButtonElement: w.HTMLButtonElement
    });
    if (!(w.HTMLElement.prototype as any).scrollIntoView) {
      (w.HTMLElement.prototype as any).scrollIntoView = () => {};
    }
  });

  afterEach(() => {
    dom.window.close();
  });

  describe('releases data model', () => {
    it('contains all versions from v1.9.2 to v2.2.0', () => {
      const versions = RELEASES_DATA.map((r) => r.version);
      expect(versions).toContain('2.2.0');
      expect(versions).toContain('2.1.2');
      expect(versions).toContain('2.1.1');
      expect(versions).toContain('2.1.0');
      expect(versions).toContain('2.0.5');
      expect(versions).toContain('2.0.2');
      expect(versions).toContain('2.0.1');
      expect(versions).toContain('2.0.0');
      expect(versions).toContain('1.9.8');
      expect(versions).toContain('1.9.2');
      expect(RELEASES_DATA.length).toBeGreaterThanOrEqual(12);
    });

    it('documents key architectural changes in v2.2.0', () => {
      const v220 = RELEASES_DATA.find((r) => r.version === '2.2.0')!;
      expect(v220).toBeDefined();
      expect(v220.channel).toBe('dev');
      const allText = v220.categories.flatMap((c) => c.items.map((i) => i.text)).join(' ');
      expect(allText).toContain('Node Agent');
      expect(allText).toContain('Core Supervisor');
      expect(allText).toContain('Write-only secret');
      expect(allText).toContain('Titlebar');
    });

    it('ensures every release entry has valid metadata and non-empty categories', () => {
      for (const release of RELEASES_DATA) {
        expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(release.title.length).toBeGreaterThan(3);
        expect(release.summary.length).toBeGreaterThan(10);
        expect(release.categories.length).toBeGreaterThan(0);
        for (const cat of release.categories) {
          expect(['feat', 'core', 'fix', 'sec', 'ui']).toContain(cat.id);
          expect(cat.items.length).toBeGreaterThan(0);
          for (const item of cat.items) {
            expect(item.text.length).toBeGreaterThan(5);
          }
        }
      }
    });
  });

  describe('DOM integration & navigation', () => {
    it('exposes a release notes tab button in nav', () => {
      const tab = dom.window.document.querySelector('nav button[data-tab="releases"]');
      expect(tab).not.toBeNull();
      expect(tab?.textContent).toContain('Release notes');
      expect(tab?.querySelector('svg use')?.getAttribute('href')).toBe('#i-sparkle');
    });

    it('exposes a release notes panel with releasesMount container', () => {
      const panel = dom.window.document.querySelector('.panel[data-panel="releases"]');
      expect(panel).not.toBeNull();
      expect(panel?.id).toBe('releasesPanel');
      expect(panel?.classList.contains('scroll')).toBe(true);
      const mount = panel?.querySelector('#releasesMount');
      expect(mount).not.toBeNull();
    });
  });

  describe('releases view rendering and interactions', () => {
    it('renders hero, stats, search input, category filters, and release cards', () => {
      initReleasesView('releasesMount');
      const mount = dom.window.document.getElementById('releasesMount')!;

      // Hero & Title
      const title = mount.querySelector('.releases-title');
      expect(title?.textContent).toContain('Release Notes & Changelog');

      // Stats
      const stats = mount.querySelectorAll('.releases-stat-box');
      expect(stats.length).toBe(3);

      // Search input
      const search = mount.querySelector('#releasesSearchInput') as HTMLInputElement | null;
      expect(search).not.toBeNull();

      // Filter chips
      const filterBtns = mount.querySelectorAll('.releases-filter-btn');
      expect(filterBtns.length).toBe(6);

      // Cards
      const cards = mount.querySelectorAll('.release-card');
      expect(cards.length).toBe(RELEASES_DATA.length);

      // v2.2.0 card
      const card220 = mount.querySelector('#release-card-2-2-0');
      expect(card220).not.toBeNull();
      expect(card220?.textContent).toContain('Multi-Device Fleet');
    });

    it('filters cards and items interactively on search query', () => {
      initReleasesView('releasesMount');
      const searchInput = dom.window.document.getElementById('releasesSearchInput') as HTMLInputElement;

      // Search for supervisor
      searchInput.value = 'supervisor';
      searchInput.dispatchEvent(new dom.window.Event('input'));

      const cards = dom.window.document.querySelectorAll('.release-card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
      const card220 = dom.window.document.querySelector('#release-card-2-2-0');
      expect(card220).not.toBeNull();
      expect(card220?.textContent).toContain('Core Supervisor');

      // Search for something non-existent
      searchInput.value = 'xyznonexistentterm999';
      searchInput.dispatchEvent(new dom.window.Event('input'));

      const emptyCards = dom.window.document.querySelectorAll('.release-card');
      expect(emptyCards.length).toBe(0);
      const emptyMsg = dom.window.document.querySelector('.releases-empty');
      expect(emptyMsg).not.toBeNull();
      expect(emptyMsg?.textContent).toContain('No matching releases found');
    });

    it('filters by category when clicking category pill', () => {
      initReleasesView('releasesMount');
      const secBtn = dom.window.document.querySelector(
        '.releases-filter-btn[data-category="sec"]'
      ) as HTMLButtonElement | null;
      expect(secBtn).not.toBeNull();
      secBtn?.click();

      // Only releases with security items should be shown
      const cards = dom.window.document.querySelectorAll('.release-card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
      for (const card of cards) {
        const sections = card.querySelectorAll('.release-category-section');
        for (const sec of sections) {
          expect(sec.classList.contains('is-sec')).toBe(true);
        }
      }
    });
  });
});
