import { describe, expect, it } from 'vitest';
import { activeWindow, findUi, focusWindow, listWindows, screenshot, waitForWindow } from '../src/main/computer/index.js';
import { IS_WINDOWS } from './helpers.js';

describe.runIf(IS_WINDOWS)('desktop helper', () => {
  it('starts once and serves repeated window queries', async () => {
    const first = await listWindows();
    const second = await listWindows();
    expect(first.screen.width).toBeGreaterThan(0);
    expect(first.screen.height).toBeGreaterThan(0);
    expect(Array.isArray(first.windows)).toBe(true);
    expect(second.screen.width).toBe(first.screen.width);
  });

  it('reports the active window without a screenshot', async () => {
    const result = await activeWindow();
    expect(result.screen.width).toBeGreaterThan(0);
    if (result.window) {
      expect(result.window.id).toBeGreaterThan(0);
      expect(result.window.width).toBeGreaterThan(0);
    }
  });

  it('reports a failed focus instead of claiming success', async () => {
    expect(await focusWindow(999_999_999)).toBe(false);
  });

  it('refuses a window screenshot when the target cannot be focused', async () => {
    await expect(screenshot({ window: 999_999_999, maxWidth: 320 })).rejects.toThrow(/FOCUS_FAILED/);
  });

  it('crops using coordinates from the most recent returned frame', async () => {
    const base = await screenshot({ maxWidth: 320 });
    const width = Math.min(100, base.width);
    const height = Math.min(80, base.height);
    const crop = await screenshot({ crop: { x: 0, y: 0, width, height } });
    expect(crop.width).toBe(width);
    expect(crop.height).toBe(height);
    expect(crop.region.width).toBeGreaterThan(0);
    expect(crop.region.height).toBeGreaterThan(0);
  });

  it('waits for an existing visible window without a fixed sleep', async () => {
    const { windows } = await listWindows();
    const candidate = windows[0];
    if (!candidate) return;
    const found = await waitForWindow({ process: candidate.process, timeoutMs: 1000 });
    expect(found.process.toLowerCase()).toContain(candidate.process.toLowerCase());
  });

  it('queries Windows UI Automation without requiring a screenshot', async () => {
    const result = await findUi({ role: 'Button', maxResults: 5 });
    expect(result.window).toBeGreaterThan(0);
    expect(Array.isArray(result.elements)).toBe(true);
    expect(result.elements.length).toBeLessThanOrEqual(5);
  });
});
