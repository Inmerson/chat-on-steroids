import { describe, expect, it } from 'vitest';
import {
  act,
  actAndCapture,
  activeWindow,
  findUi,
  focusWindow,
  getWindowState,
  listWindows,
  screenshot,
  waitForWindow
} from '../src/main/computer/index.js';
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

  // Capturing deliberately no longer demands the foreground: looking at a window that
  // something else is covering is a picture, not a failure. A window that does not exist
  // at all is still an error, and it has to say so as one.
  it('captures a window that will not come forward, but refuses one that does not exist', async () => {
    await expect(screenshot({ window: 999_999_999, maxWidth: 320 })).rejects.toThrow(
      /No window with that id/i
    );
    const { windows } = await listWindows();
    const background = windows.find((w) => w.state !== 'minimized');
    if (!background) return;
    const shot = await screenshot({ window: background.id, maxWidth: 320 });
    expect(shot.width).toBeGreaterThan(0);
    expect(typeof shot.focused).toBe('boolean');
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
    for (const element of result.elements) expect(element.ref).toMatch(/^g\d+_e\d+_\d+$/);
  });

  it('returns a Codex-style window state with semantic UI refs', async () => {
    const state = await getWindowState({ includeScreenshot: false, maxElements: 8 });
    expect(state.window.id).toBeGreaterThan(0);
    expect(state.screenshot).toBeNull();
    expect(state.elements.length).toBeLessThanOrEqual(8);
    for (const element of state.elements) expect(element.ref).toMatch(/^g\d+_e\d+_\d+$/);
  });

  it('refuses an invented semantic element ref instead of clicking cached coordinates', async () => {
    await expect(act([{ type: 'click_ref', ref: 'g1_e999999_999999' }])).rejects.toThrow(/UNKNOWN_UI_REF/);
  });

  it('refuses coordinates from a frame the screen has moved on from', async () => {
    const stale = await screenshot({ maxWidth: 320 });
    const current = await screenshot({ maxWidth: 320 });
    expect(current.frameId).toBeGreaterThan(stale.frameId);

    await expect(act([{ type: 'move', x: 1, y: 1 }], { frameId: stale.frameId })).rejects.toThrow(/STALE_FRAME/);
    // The current frame still works, and omitting the id stays backward compatible.
    await expect(act([{ type: 'move', x: 1, y: 1 }], { frameId: current.frameId })).resolves.toBeTruthy();
    await expect(act([{ type: 'move', x: 1, y: 1 }])).resolves.toBeTruthy();
  });

  it('does not check the frame for semantic refs, which do not use coordinates', async () => {
    const stale = await screenshot({ maxWidth: 320 });
    await screenshot({ maxWidth: 320 });
    // Nothing here should mention the frame: the failure must be about the ref itself.
    await expect(
      act([{ type: 'click_ref', ref: 'g1_e999999_999999' }], { frameId: stale.frameId })
    ).rejects.toThrow(/UNKNOWN_UI_REF/);
  });

  it('takes its verification picture before anyone else can touch the desktop', async () => {
    // captureAfter exists to make action and verification one round trip. If the lock is
    // released between them, another agent's capture can land in the gap and the "after"
    // picture proves nothing about the action it was supposed to verify.
    const order: string[] = [];
    const base = await screenshot({ maxWidth: 320 });

    const combined = actAndCapture([{ type: 'move', x: 1, y: 1 }], {
      frameId: base.frameId,
      capture: { maxWidth: 320 }
    }).then((result) => {
      order.push('combined');
      return result;
    });
    const interloper = screenshot({ maxWidth: 320 }).then((shot) => {
      order.push('interloper');
      return shot;
    });

    const [result, other] = await Promise.all([combined, interloper]);
    expect(result.screenshot).not.toBeNull();
    expect(order).toEqual(['combined', 'interloper']);
    // Frames are numbered in capture order: the verification picture is the very next one
    // after the frame the action was aimed at, and the interloper's comes after that.
    expect(result.screenshot!.frameId).toBe(base.frameId + 1);
    expect(other.frameId).toBe(result.screenshot!.frameId + 1);
  });

  it('resolves a captureAfter crop against the frame that was current before the actions', async () => {
    const base = await screenshot({ maxWidth: 320 });
    const width = Math.min(64, base.width);
    const height = Math.min(48, base.height);
    const result = await actAndCapture([{ type: 'wait', ms: 0 }], {
      capture: { crop: { x: 0, y: 0, width, height } }
    });
    expect(result.screenshot).not.toBeNull();
    expect(result.screenshot!.width).toBe(width);
    expect(result.screenshot!.height).toBe(height);
  });

  it('pairs window state element centres with the screenshot it returned', async () => {
    // A competing capture is fired while get_window_state is mid-acquisition. The state
    // it returns must describe one moment: centres computed against its own screenshot,
    // never against the frame the interloper installed.
    const statePromise = getWindowState({ includeScreenshot: true, maxWidth: 640, maxElements: 12 });
    const interloper = screenshot({ maxWidth: 320 });
    const [state, other] = await Promise.all([statePromise, interloper]);

    expect(state.screenshot).not.toBeNull();
    const shot = state.screenshot!;
    // Different capture, therefore a different region and scale to be mapped against.
    expect(shot.frameId).not.toBe(other.frameId);
    expect(state.elements.length).toBeGreaterThan(0);

    let checked = 0;
    for (const element of state.elements) {
      if (!element.imageBounds || !element.imageCenter) continue;
      checked++;
      // Recompute the mapping from the screenshot that came back with these elements.
      // Any other frame's region or scale gives different numbers.
      expect(element.imageBounds.x).toBe(Math.round((element.bounds.x - shot.region.x) * shot.scale));
      expect(element.imageBounds.y).toBe(Math.round((element.bounds.y - shot.region.y) * shot.scale));
      expect(element.imageBounds.width).toBe(Math.round(element.bounds.width * shot.scale));
      expect(element.imageCenter.x).toBe(
        Math.round(element.imageBounds.x + element.imageBounds.width / 2)
      );
      expect(element.imageBounds.x + element.imageBounds.width).toBeLessThanOrEqual(shot.width);
      expect(element.imageBounds.y + element.imageBounds.height).toBeLessThanOrEqual(shot.height);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('refuses a ref minted before the desktop helper restarted', async () => {
    // A UI Automation runtime id is meaningless to a different helper process, so acting
    // on one would target whatever now holds that id rather than what the model saw.
    const state = await getWindowState({ includeScreenshot: false, maxElements: 4 });
    const live = state.elements.find((element) => element.ref.startsWith('g'));
    if (!live) return;
    const older = live.ref.replace(/^g(\d+)/, (_match, gen: string) => `g${Number(gen) - 1}`);
    await expect(act([{ type: 'click_ref', ref: older }])).rejects.toThrow(/UNKNOWN_UI_REF|STALE_REF/);
  });
});
