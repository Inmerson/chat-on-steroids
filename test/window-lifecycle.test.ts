import { describe, expect, it, vi } from 'vitest';
import { presentWindow, secondInstanceAction } from '../src/main/window-lifecycle.js';

describe('window lifecycle', () => {
  it('creates a replacement instead of showing a destroyed BrowserWindow', () => {
    const create = vi.fn();
    const destroyed = {
      isDestroyed: () => true,
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    };

    presentWindow(destroyed, create);

    expect(create).toHaveBeenCalledOnce();
    expect(destroyed.show).not.toHaveBeenCalled();
    expect(destroyed.focus).not.toHaveBeenCalled();
  });

  it('restores and focuses a live minimized window', () => {
    const create = vi.fn();
    const live = {
      isDestroyed: () => false,
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    };

    presentWindow(live, create);

    expect(create).not.toHaveBeenCalled();
    expect(live.restore).toHaveBeenCalledOnce();
    expect(live.show).toHaveBeenCalledOnce();
    expect(live.focus).toHaveBeenCalledOnce();
  });

  it('relaunches a second instance request that arrives during shutdown', () => {
    expect(secondInstanceAction(false, false)).toBe('show');
    expect(secondInstanceAction(true, false)).toBe('relaunch');
    expect(secondInstanceAction(false, true)).toBe('relaunch');
  });
});
