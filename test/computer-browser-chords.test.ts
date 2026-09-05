import { describe, expect, it } from 'vitest';
import { browserTabChord, isBrowserProcess } from '../src/main/computer/browser-chords.js';

describe('browser tab and window chords', () => {
  it('names the chords a browser takes for its tabs, windows and address bar', () => {
    expect(browserTabChord(['ctrl', 'w'])).toBe('ctrl+w');
    expect(browserTabChord(['Ctrl', 'Shift', 'Tab'])).toBe('ctrl+shift+tab');
    expect(browserTabChord(['shift', 'control', 'w'])).toBe('ctrl+shift+w');
    expect(browserTabChord(['ctrl', 'PageUp'])).toBe('ctrl+pageup');
    expect(browserTabChord(['ctrl', 'pgdn'])).toBe('ctrl+pagedown');
    expect(browserTabChord(['alt', 'ArrowLeft'])).toBe('alt+left');
    expect(browserTabChord(['alt', 'f4'])).toBe('alt+f4');
    expect(browserTabChord(['ctrl', '4'])).toBe('ctrl+4');
    expect(browserTabChord(['ctrl', 'l'])).toBe('ctrl+l');
    expect(browserTabChord(['cmd', 'w'])).toBe('cmd+w');
    expect(browserTabChord(['command', 'shift', 't'])).toBe('cmd+shift+t');
    expect(browserTabChord(['meta', 'q'])).toBe('cmd+q');
    expect(browserTabChord(['cmd', 'option', 'ArrowLeft'])).toBe('cmd+alt+left');
    expect(browserTabChord(['cmd', 'shift', ']'])).toBe('cmd+shift+]');
    expect(browserTabChord(['cmd', 'l'])).toBe('cmd+l');
    expect(browserTabChord(['cmd', '3'])).toBe('cmd+3');
  });

  it('leaves ordinary page keypresses alone', () => {
    expect(browserTabChord(['ctrl', 'r'])).toBeNull();
    expect(browserTabChord(['ctrl', 'v'])).toBeNull();
    expect(browserTabChord(['cmd', 'v'])).toBeNull();
    expect(browserTabChord(['cmd', 's'])).toBeNull();
    expect(browserTabChord(['enter'])).toBeNull();
    expect(browserTabChord(['tab'])).toBeNull();
    expect(browserTabChord(['ctrl', 'alt', 'w'])).toBeNull();
    expect(browserTabChord(['ctrl'])).toBeNull();
    expect(browserTabChord([])).toBeNull();
  });

  it('recognises browser process names without treating unrelated apps as browsers', () => {
    for (const process of [
      'chrome',
      'Chrome.exe',
      'Google Chrome',
      'Google Chrome Canary',
      'msedge',
      'Microsoft Edge',
      'firefox',
      'Brave Browser',
      'Safari',
      'Arc'
    ]) {
      expect(isBrowserProcess(process), process).toBe(true);
    }
    for (const process of ['Archive Utility', 'Finder', 'Terminal', 'notepad', 'Code', '']) {
      expect(isBrowserProcess(process), process).toBe(false);
    }
  });
});
