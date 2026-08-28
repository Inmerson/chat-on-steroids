import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_START_ARG,
  isBackgroundStartup,
  syncLoginStartup
} from '../src/main/background-startup.js';

describe('browserless Core startup', () => {
  it('recognizes only the dedicated background startup argument', () => {
    expect(isBackgroundStartup(['Chat On Steroids.exe', BACKGROUND_START_ARG])).toBe(true);
    expect(isBackgroundStartup(['Chat On Steroids.exe', '--background-worker'])).toBe(false);
    expect(isBackgroundStartup(['Chat On Steroids.exe'])).toBe(false);
  });

  it('registers packaged Windows startup with the same hidden argument used by bootstrap', () => {
    const setLoginItemSettings = vi.fn();
    syncLoginStartup({ isPackaged: true, setLoginItemSettings }, true, 'win32');

    expect(setLoginItemSettings).toHaveBeenCalledOnce();
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: [BACKGROUND_START_ARG]
    });
  });

  it('removes the same Windows startup entry when auto-connect is disabled', () => {
    const setLoginItemSettings = vi.fn();
    syncLoginStartup({ isPackaged: true, setLoginItemSettings }, false, 'win32');

    expect(setLoginItemSettings).toHaveBeenCalledOnce();
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      args: [BACKGROUND_START_ARG]
    });
  });

  it.each([
    { platform: 'linux' as const, packaged: true },
    { platform: 'darwin' as const, packaged: true },
    { platform: 'win32' as const, packaged: false }
  ])('does not alter login startup on unsupported/dev host $platform packaged=$packaged', ({ platform, packaged }) => {
    const setLoginItemSettings = vi.fn();
    syncLoginStartup({ isPackaged: packaged, setLoginItemSettings }, true, platform);
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });
});
