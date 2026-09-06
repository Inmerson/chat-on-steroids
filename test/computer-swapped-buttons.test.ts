import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe('a swapped-button mouse still gets semantic primary and secondary clicks', () => {
  const buttonFlags = (() => {
    const start = HELPER_SCRIPT.indexOf('static void ButtonFlags');
    expect(start, 'ButtonFlags should still exist in the helper').toBeGreaterThan(-1);
    return HELPER_SCRIPT.slice(start, HELPER_SCRIPT.indexOf('public static void Click', start));
  })();

  it('decides from the live Windows setting rather than a cached constant', () => {
    expect(buttonFlags).toMatch(/GetSystemMetrics\(SM_SWAPBUTTON\)/);
  });

  it('inverts both halves of primary and secondary clicks when buttons are swapped', () => {
    expect(buttonFlags).toMatch(/swapped \? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN/);
    expect(buttonFlags).toMatch(/swapped \? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP/);
    expect(buttonFlags).toMatch(/swapped \? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_RIGHTDOWN/);
    expect(buttonFlags).toMatch(/swapped \? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_RIGHTUP/);
  });

  it('leaves middle and wheel clicks out of the primary-secondary swap', () => {
    const middle = buttonFlags.slice(buttonFlags.indexOf('case "middle"'));
    expect(middle.slice(0, middle.indexOf('break'))).not.toMatch(/swapped/);
  });

  it('uses the documented Windows SM_SWAPBUTTON index', () => {
    expect(HELPER_SCRIPT).toMatch(/const int SM_SWAPBUTTON = 23;/);
  });

  it('routes Click, Drag and click_ref fallback through the shared button mapping', () => {
    for (const caller of ['public static void Click', 'public static void Drag']) {
      const start = HELPER_SCRIPT.indexOf(caller);
      expect(start, caller + ' should still exist').toBeGreaterThan(-1);
      const body = HELPER_SCRIPT.slice(start, start + 600);
      expect(body).toMatch(/ButtonFlags\(button, out down, out up\)/);
    }
    expect(HELPER_SCRIPT).toMatch(/\[Clf\]::Click\(/);
  });
});
