/**
 * Browser-owned keyboard chords that manage tabs/windows rather than the page inside them.
 *
 * This classifier is host-agnostic, but the live Desktop connector remains Windows-only. Both
 * Ctrl/Alt and Command/Option spellings are recognized because tool callers may use either naming
 * convention; recognizing a spelling does not expose Desktop on another platform.
 */
const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'cmd']);

const KEY_ALIASES: Record<string, string> = {
  control: 'ctrl',
  option: 'alt',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  pgup: 'pageup',
  page_up: 'pageup',
  pgdn: 'pagedown',
  page_down: 'pagedown',
  arrowleft: 'left',
  arrowright: 'right',
  bracketleft: '[',
  bracketright: ']'
};

const BROWSER_TAB_CHORDS = new Set([
  'ctrl+w',
  'ctrl+shift+w',
  'ctrl+f4',
  'alt+f4',
  'ctrl+t',
  'ctrl+shift+t',
  'ctrl+n',
  'ctrl+shift+n',
  'ctrl+tab',
  'ctrl+shift+tab',
  'ctrl+pageup',
  'ctrl+pagedown',
  'ctrl+shift+q',
  'ctrl+l',
  'alt+d',
  'alt+left',
  'alt+right',
  'alt+home',
  ...Array.from({ length: 9 }, (_, index) => `ctrl+${index + 1}`),
  'cmd+w',
  'cmd+shift+w',
  'cmd+q',
  'cmd+h',
  'cmd+alt+h',
  'cmd+t',
  'cmd+shift+t',
  'cmd+n',
  'cmd+shift+n',
  'cmd+shift+]',
  'cmd+shift+[',
  'cmd+alt+left',
  'cmd+alt+right',
  'cmd+[',
  'cmd+]',
  'cmd+l',
  'cmd+alt+f',
  ...Array.from({ length: 9 }, (_, index) => `cmd+${index + 1}`)
]);

const BROWSER_PROCESS_PATTERN =
  /(^|[\s_-])(chrome|chromium|msedge|edge|firefox|brave|opera|vivaldi|arc|safari)([\s_-]|$)/;

/** The normalized browser-owned chord, or null when the keypress belongs to page content. */
export function browserTabChord(keys: readonly string[]): string | null {
  const parts = keys
    .map((key) => key.trim().toLowerCase())
    .map((key) => KEY_ALIASES[key] ?? key)
    .filter(Boolean);
  const modifiers = new Set(parts.filter((key) => MODIFIERS.has(key)));
  const rest = parts.filter((key) => !MODIFIERS.has(key));
  if (rest.length !== 1) return null;
  const chord = [
    modifiers.has('cmd') && 'cmd',
    modifiers.has('ctrl') && 'ctrl',
    modifiers.has('alt') && 'alt',
    modifiers.has('shift') && 'shift',
    rest[0]
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('+');
  return BROWSER_TAB_CHORDS.has(chord) ? chord : null;
}

/** Whether the Desktop window process identifies a web browser. */
export function isBrowserProcess(process: string): boolean {
  return BROWSER_PROCESS_PATTERN.test(process.trim().toLowerCase().replace(/\.exe$/, ''));
}
