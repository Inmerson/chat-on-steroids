/**
 * Renderer. No Node, no filesystem, no network — everything goes through window.api.
 *
 * The DOM skeleton lives in index.html; this fills it in and never rebuilds a control
 * the user might be typing into. The permission rows are the one exception: they are
 * generated from CAPABILITIES so a new capability appears without touching markup.
 *
 * Two rules the layout depends on. The window is a fixed frame, so nothing here may
 * change the height of anything outside its own scroll pane — that is why only one
 * permission group is expanded at a time. And the two live numbers tick locally every
 * second, so "verified 8s ago" keeps counting between the 15s reports from the main
 * process instead of freezing at a number that is quietly going stale.
 */

import type { AppApi } from '../preload/index.js';
import type { AppState, Capability, LogEntry } from '../shared/types.js';
import { CAPABILITY_DETAILS, CAPABILITY_LABELS, WRITE_CAPABILITIES } from '../shared/types.js';

declare global {
  interface Window {
    api: AppApi;
  }
}

const api = window.api;

/** Same shape the platform uses; mirrored here only to grey out step 2 until it is valid. */
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

interface Group {
  id: string;
  title: string;
  /** Sprite id from index.html. */
  icon: string;
  blurb: string;
  caps: Capability[];
}

const TOOL_COUNT_BY_CAPABILITY: Record<Capability, number> = {
  browse: 1,
  search: 1,
  read: 3,
  metadata: 1,
  create: 2,
  edit: 3,
  move: 1,
  deleteFile: 1,
  deleteFolder: 1,
  powershell: 1,
  command: 4,
  screen: 5,
  control: 1,
  clipboardRead: 1,
  clipboardWrite: 1
};
const MAX_TOOL_COUNT =
  1 + Object.values(TOOL_COUNT_BY_CAPABILITY).reduce((sum, count) => sum + count, 0) + 1;

const GROUPS: Group[] = [
  {
    id: 'read',
    title: 'Look at files',
    icon: 'i-eye',
    blurb: 'Read and search inside the folders you approved.',
    caps: ['browse', 'search', 'read', 'metadata']
  },
  {
    id: 'write',
    title: 'Change files',
    icon: 'i-pencil',
    blurb: 'Create, edit, move and delete, inside those folders only.',
    caps: ['create', 'edit', 'move', 'deleteFile', 'deleteFolder']
  },
  {
    id: 'desktop',
    title: 'See and use the desktop',
    icon: 'i-monitor',
    blurb: 'Screenshots, the list of open windows, and the mouse and keyboard.',
    caps: ['screen', 'control', 'clipboardRead', 'clipboardWrite']
  },
  {
    id: 'run',
    title: 'Run programs',
    icon: 'i-terminal',
    blurb: 'Start commands as you. The most powerful setting here.',
    caps: ['powershell', 'command']
  }
];

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One icon from the sprite in index.html. */
function icon(name: string, className = 'ico'): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let state: AppState | null = null;
/** Guards against saving while we are writing values into the controls. */
let applying = false;
/** The one expanded permission group, or null. One at a time keeps the layout still. */
let openGroup: string | null = null;
/** Whether the finished setup steps are unfolded again. Reset on every app start. */
let showAllSteps = false;

// ------------------------------------------------------------------ toast

let toastTimer: number | undefined;
function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const node = el('div', 'toast', message);
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), 3200);
}

async function run<T>(
  promise: Promise<{ ok: true; data: T } | { ok: false; error: string }>
): Promise<T | null> {
  const reply = await promise;
  if (!reply.ok) {
    toast(reply.error);
    return null;
  }
  return reply.data;
}

// ------------------------------------------------------------------- tabs

function showTab(name: string): void {
  for (const tab of document.querySelectorAll<HTMLElement>('nav button')) {
    tab.classList.toggle('is-sel', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  }
}

$('tabs').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
  if (button?.dataset.tab) showTab(button.dataset.tab);
});

// ------------------------------------------------------------ permissions

/**
 * Builds the permission rows once: a name that expands the group, and a switch that
 * turns the whole group on or off. Expanding scrolls the row just into view rather
 * than pushing the cards below it, because the window cannot grow.
 */
function buildGroups(): void {
  $('groups').replaceChildren(
    ...GROUPS.map((group) => {
      const root = el('div', 'perm');
      root.dataset.group = group.id;

      const main = document.createElement('button');
      main.className = 'perm-main';
      main.type = 'button';
      const text = el('span');
      text.append(el('b', '', group.title), el('em', 'group-count'));
      main.append(icon('i-chev', 'ico chev'), icon(group.icon), text);
      main.addEventListener('click', () => {
        openGroup = openGroup === group.id ? null : group.id;
        paintGroups();
        if (openGroup === group.id) root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });

      const sw = el('span', 'sw');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'group-box';
      box.title = `Turn everything in "${group.title}" on or off`;
      box.addEventListener('change', () => {
        for (const cap of group.caps) {
          const input = capInput(cap);
          if (!input.disabled) input.checked = box.checked;
        }
        void save();
      });
      sw.append(box, el('i'));

      const head = el('div', 'perm-head');
      head.append(main, sw);

      const tools = el('div', 'tools');
      for (const cap of group.caps) {
        const label = el('label', 'tool');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.cap = cap;
        input.addEventListener('change', () => void save());
        const body = el('span');
        body.append(el('strong', '', CAPABILITY_LABELS[cap]), el('em', '', CAPABILITY_DETAILS[cap]));
        label.append(input, body);
        tools.append(label);
      }

      root.append(head, tools);
      return root;
    })
  );
}

function capInput(cap: Capability): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`[data-cap="${cap}"]`)!;
}

/** Refreshes counts, the tri-state switches, and what read-only mode has locked. */
function paintGroups(): void {
  if (!state) return;
  const { readOnly } = state.config;

  for (const group of GROUPS) {
    const root = document.querySelector<HTMLElement>(`[data-group="${group.id}"]`)!;
    root.classList.toggle('is-open', openGroup === group.id);

    const usable = group.caps.filter((cap) => !(readOnly && WRITE_CAPABILITIES.includes(cap)));
    const on = group.caps.filter((cap) => capInput(cap).checked);

    const box = root.querySelector<HTMLInputElement>('.group-box')!;
    box.checked = usable.length > 0 && usable.every((cap) => capInput(cap).checked);
    box.indeterminate = !box.checked && on.length > 0;
    box.disabled = usable.length === 0;

    root.querySelector<HTMLElement>('.group-count')!.textContent =
      usable.length === 0
        ? 'off in read-only mode'
        : on.length === 0
          ? 'off'
          : on.length === group.caps.length
            ? `${on.length} permissions`
            : `${on.length} of ${group.caps.length} permissions`;

    root.classList.toggle('is-on', on.length > 0);
    root.classList.toggle('is-locked', usable.length === 0);
  }

  for (const cap of WRITE_CAPABILITIES) capInput(cap).disabled = readOnly;
}

/** How many MCP tools ChatGPT can currently discover, including list_roots. */
function toolsOn(next: AppState): number {
  const { capabilities, readOnly } = next.config;
  const enabled = (Object.keys(capabilities) as Capability[]).filter(
    (cap) => capabilities[cap] && !(readOnly && WRITE_CAPABILITIES.includes(cap))
  );
  let count = 1;
  for (const cap of enabled) count += TOOL_COUNT_BY_CAPABILITY[cap];
  // write_binary_file is shared by Create and Edit, so count it once when either is live.
  if (enabled.includes('create') || enabled.includes('edit')) count += 1;
  return count;
}

// ------------------------------------------------------------------ save

async function save(over: { readOnly?: boolean; theme?: 'light' | 'dark' } = {}): Promise<void> {
  if (applying || !state) return;
  const capabilities = { ...state.config.capabilities };
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    capabilities[input.dataset.cap as Capability] = input.checked;
  }
  const readOnly = over.readOnly ?? state.config.readOnly;
  const previous = state.config;
  const toolSurfaceChanged = (Object.keys(capabilities) as Capability[]).some((cap) => {
    const before = previous.capabilities[cap] && !(previous.readOnly && WRITE_CAPABILITIES.includes(cap));
    const after = capabilities[cap] && !(readOnly && WRITE_CAPABILITIES.includes(cap));
    return before !== after;
  });
  const next = await run(
    api.saveSettings({
      capabilities,
      readOnly,
      tunnel: {
        kind: $<HTMLSelectElement>('tunnelKind').value as 'openai' | 'cloudflared' | 'manual',
        tunnelId: $<HTMLInputElement>('tunnelId').value.trim(),
        binaryPath: $<HTMLInputElement>('binaryPath').value.trim()
      },
      ui: {
        autoConnect: $<HTMLInputElement>('autoConnect').checked,
        minimizeToTray: $<HTMLInputElement>('minimizeToTray').checked,
        privacyScreenshots: $<HTMLInputElement>('privacyScreenshots').checked,
        theme: over.theme ?? state.config.ui.theme
      }
    })
  );
  if (next) {
    apply(next);
    if (toolSurfaceChanged) {
      toast('Tools changed. Start a new ChatGPT conversation to guarantee the new tool list is loaded.');
    }
  } else await refresh();
}

// ---------------------------------------------------------------- helpers

const STATUS_TEXT: Record<AppState['status']['state'], string> = {
  disconnected: 'Not connected',
  'starting-server': 'Starting',
  'connecting-tunnel': 'Connecting',
  connected: 'Connected',
  offline: 'No internet',
  'auth-failed': 'Sign-in failed',
  'tunnel-unavailable': 'Tunnel unavailable'
};

const METHOD_HINT: Record<string, string> = {
  openai:
    'ChatGPT reaches this PC through an OpenAI tunnel. Nothing is exposed to the open internet.',
  cloudflared:
    'Creates a temporary public https address with Cloudflare. The address changes on every restart.',
  manual: 'This app only listens on localhost. You are responsible for exposing it.'
};

/** "12s ago" for a timestamp the main process vouched for, "never" for null. */
function ago(atMs: number | null): string {
  if (atMs === null) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (seconds < 3) return 'just now';
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/** The same age as one glanceable token: "8s", "2m", "—" when there is nothing. */
function shortAgo(atMs: number | null): string {
  if (atMs === null) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (seconds < 3) return 'now';
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/**
 * True while the bridge is up and Disconnect is the meaningful action. Offline
 * counts: the tunnel is still alive and retrying, it just cannot reach OpenAI.
 */
function isRunning(value: AppState['status']['state']): boolean {
  return (
    value === 'connected' ||
    value === 'offline' ||
    value === 'starting-server' ||
    value === 'connecting-tunnel'
  );
}

/** What still has to happen before connecting can work, in the order of the wizard. */
function missingStep(next: AppState): { step: string; text: string } | null {
  const { config } = next;
  if (config.roots.length === 0) {
    return { step: 'folder', text: 'Choose a folder to share — step 1.' };
  }
  if (config.tunnel.kind === 'openai') {
    if (!TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId)) {
      return { step: 'tunnel', text: 'Create a tunnel and paste its ID — step 2.' };
    }
    if (!next.hasApiKey) {
      return { step: 'key', text: 'Add a restricted API key — step 3.' };
    }
  } else if (!next.resolvedBinary && config.tunnel.kind === 'cloudflared') {
    return { step: 'connect', text: 'cloudflared was not found on this PC.' };
  }
  return null;
}

// ----------------------------------------------------------------- render

function apply(next: AppState): void {
  state = next;
  applying = true;
  const { config, status } = next;

  const connected = status.state === 'connected';
  const offline = status.state === 'offline';
  const busy = status.state === 'starting-server' || status.state === 'connecting-tunnel';
  const failed = status.state === 'auth-failed' || status.state === 'tunnel-unavailable';
  const running = isRunning(status.state);
  const missing = missingStep(next);

  // ---- theme
  const dark = config.ui.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeIcon').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('themeBtn').title = dark ? 'Switch to light mode' : 'Switch to dark mode';

  // ---- header
  const live = $('live');
  live.className = `live${
    connected ? ' is-connected' : offline ? ' is-offline' : busy ? ' is-busy' : failed ? ' is-error' : ''
  }`;
  $('liveState').textContent = STATUS_TEXT[status.state];

  const id = config.tunnel.tunnelId;
  $('headerSub').textContent =
    config.tunnel.kind === 'openai'
      ? TUNNEL_ID_PATTERN.test(id)
        ? `${id.slice(0, 11)}…${id.slice(-4)}`
        : 'No tunnel yet'
      : (status.publicUrl ?? status.localUrl ?? config.tunnel.kind);

  const connectBtn = $<HTMLButtonElement>('connectBtn');
  connectBtn.classList.toggle('is-running', running);
  $('connectLabel').textContent = running ? 'Disconnect' : 'Connect';
  connectBtn.disabled = !running && missing !== null;
  connectBtn.title = !running && missing ? missing.text : '';

  // ---- health numbers and facts
  paintClock();
  $('facts').replaceChildren(...facts(next));

  // ---- permissions
  $('readOnlyBtn').classList.toggle('is-on', config.readOnly);
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    input.checked = config.capabilities[input.dataset.cap as Capability];
  }
  paintGroups();

  // ---- folders
  $('rootList').replaceChildren(
    ...config.roots.map((root) => {
      const row = el('div', 'root');
      const remove = document.createElement('button');
      remove.className = 'btn';
      remove.type = 'button';
      remove.title = `Stop sharing /${root.name}`;
      remove.append(icon('i-trash'));
      remove.addEventListener('click', async () => {
        const result = await run(api.removeRoot(root.name));
        if (result) apply(result);
      });
      const path = el('span', '', root.path);
      path.title = root.path;
      row.append(icon('i-folder'), el('b', '', `/${root.name}`), path, remove);
      return row;
    })
  );
  $('rootsEmpty').hidden = config.roots.length > 0;

  // ---- nav badge
  $('setupBadge').hidden = missing === null;

  // ---- wizard
  $<HTMLSelectElement>('tunnelKind').value = config.tunnel.kind;
  $('methodHint').textContent = METHOD_HINT[config.tunnel.kind] ?? '';
  $<HTMLInputElement>('tunnelId').value = config.tunnel.tunnelId;
  $<HTMLInputElement>('binaryPath').value = config.tunnel.binaryPath;
  $<HTMLInputElement>('autoConnect').checked = config.ui.autoConnect;
  $<HTMLInputElement>('minimizeToTray').checked = config.ui.minimizeToTray;
  $<HTMLInputElement>('privacyScreenshots').checked = config.ui.privacyScreenshots;

  const openai = config.tunnel.kind === 'openai';
  step('tunnel').hidden = !openai;
  step('key').hidden = !openai;

  $('wizFolders').textContent =
    config.roots.length === 0 ? 'None yet' : config.roots.map((r) => `/${r.name}`).join('  ');
  $<HTMLInputElement>('apiKey').placeholder = next.hasApiKey ? '•••••••• stored' : 'sk-…';
  $('apiKeyState').textContent = next.hasApiKey
    ? 'A key is stored, encrypted by Windows. Type a new one to replace it, or use Remove stored API key.'
    : 'Stored encrypted by Windows. It is never shown again and never leaves this app.';
  $<HTMLButtonElement>('removeApiKey').disabled = !next.hasApiKey;

  const wizConnect = $<HTMLButtonElement>('wizConnect');
  wizConnect.textContent = running ? 'Disconnect' : 'Connect';
  wizConnect.disabled = connectBtn.disabled;
  $('wizStatus').textContent = running || failed ? status.detail || STATUS_TEXT[status.state] : '';

  $('chatgptConn').replaceChildren(
    openai
      ? frag('For the connection, choose ', 'Tunnel', ' and pick the tunnel you made in step 2.')
      : frag('For the connection, paste the URL below into ', 'MCP server URL', '.')
  );

  // Says plainly whether the connector has ever reached this app, because a
  // FORBIDDEN inside one ChatGPT conversation is not the same as a broken setup.
  // The middle case is the one that costs hours: ChatGPT connects and reads the tool
  // list, but the model is never allowed to call anything — Developer mode is off.
  const chatgptNote = $('wizChatgpt');
  chatgptNote.classList.toggle('is-warn', status.lastRequestAt !== null && status.lastToolCallAt === null);
  chatgptNote.textContent =
    status.lastRequestAt === null
      ? 'ChatGPT has not called this app yet.'
      : status.lastToolCallAt === null
        ? `ChatGPT connected ${ago(status.lastRequestAt)} but has never run a tool. If it says “does not support developer MCPs”, switch Developer mode back on in ChatGPT → Settings → Apps & Connectors → Advanced.`
        : `ChatGPT ran a tool ${ago(status.lastToolCallAt)} — the whole chain works.`;

  const shownUrl = status.publicUrl ?? (config.tunnel.kind === 'manual' ? status.localUrl : null);
  $('publicUrlField').hidden = !shownUrl;
  $<HTMLInputElement>('publicUrl').value = shownUrl ?? '';

  // Step marks: everything before the first unfinished step counts as done.
  const order = ['folder', 'tunnel', 'key', 'connect', 'chatgpt'];
  const done = new Set<string>();
  if (config.roots.length > 0) done.add('folder');
  if (!openai || TUNNEL_ID_PATTERN.test(config.tunnel.tunnelId)) done.add('tunnel');
  if (!openai || next.hasApiKey) done.add('key');
  if (connected) done.add('connect');
  // The only honest proof step 5 is finished: ChatGPT has actually called this app.
  if (status.lastRequestAt !== null) done.add('chatgpt');
  const current = order.find((name) => !done.has(name)) ?? null;
  for (const name of order) {
    const node = step(name);
    node.classList.toggle('is-done', done.has(name));
    node.classList.toggle('is-current', name === current);
  }

  // Setup that is finished should stop reading like a to-do list: the instructions
  // collapse away so the page fits without scrolling, and come back on request.
  const allDone = current === null;
  $('wizard').classList.toggle('is-tidy', allDone && !showAllSteps);
  const expand = $<HTMLButtonElement>('wizExpand');
  expand.hidden = !allDone;
  expand.textContent = showAllSteps ? 'Hide finished steps' : 'Show all steps';

  const needsBinary = config.tunnel.kind !== 'manual';
  $('binaryState').textContent = !needsBinary
    ? 'Not needed for this method.'
    : next.resolvedBinary
      ? `Using ${next.resolvedBinary}`
      : 'Not found. Install it, or choose the file with Browse.';
  $('versionLine').textContent = next.bundledTunnelVersion
    ? `Recent activity only — no file contents, no credentials. Bundled tunnel-client ${next.bundledTunnelVersion}.`
    : 'Recent activity only. File contents and credentials are never recorded.';

  applying = false;
}

/**
 * The Health card's plain-fact list: what is actually happening in the background,
 * in the order you would ask about it. A field the tunnel could not report shows a
 * dash rather than a plausible-looking number.
 */
function facts(next: AppState): HTMLElement[] {
  const { status, config } = next;
  const rows: [string, string, boolean?][] = [];
  const health = status.health;

  if (isRunning(status.state)) {
    rows.push(['Route to OpenAI', health?.route ?? 'starting…']);
    rows.push([
      'Poll errors',
      health?.pollErrors === null || health?.pollErrors === undefined
        ? '—'
        : String(health.pollErrors),
      (health?.pollErrors ?? 0) > 0
    ]);
    const probe = health?.probe ?? null;
    rows.push([
      'Tunnel → this app',
      probe ?? 'checking…',
      probe !== null && probe !== 'ok' && probe !== 'success' && probe !== 'healthy'
    ]);
    rows.push(['Tunnel uptime', duration(health?.uptimeSeconds ?? null)]);
    // Requests but no tool call is what an account with Developer mode switched off
    // looks like from here, and it is invisible in every other number on this card.
    if (status.lastRequestAt !== null) {
      rows.push([
        'ChatGPT ran a tool',
        status.lastToolCallAt === null ? 'never — check Developer mode' : ago(status.lastToolCallAt),
        status.lastToolCallAt === null
      ]);
    }
    if (health?.clientVersion) rows.push(['Tunnel client', health.clientVersion]);
    if (status.localUrl) rows.push(['Local server', status.localUrl.replace(/^https?:\/\//, '')]);
  } else {
    rows.push(['Route to OpenAI', 'not running']);
  }

  rows.push([
    'Tools ChatGPT can see',
    `${toolsOn(next)} of ${MAX_TOOL_COUNT} · ${config.roots.length} folder${config.roots.length === 1 ? '' : 's'}`
  ]);

  return rows.map(([label, value, bad]) => {
    const row = el('div', 'fact');
    const code = el('code', bad ? 'is-bad' : '', value);
    // The row is cut to fit, so the full value has to stay reachable somehow.
    code.title = value;
    row.append(el('span', '', label), code);
    return row;
  });
}

/**
 * Repaints only what ages: the two numbers and the header note. Runs every second so
 * "verified 8s ago" keeps counting between reports instead of freezing.
 */
function paintClock(): void {
  if (!state) return;
  const { status } = state;
  const running = isRunning(status.state);
  const connected = status.state === 'connected';

  const handshake = $('bigHandshake');
  handshake.textContent = shortAgo(status.handshakeAt);
  handshake.className = connected ? '' : status.state === 'offline' ? 'is-bad' : 'is-cold';

  const request = $('bigRequest');
  request.textContent = shortAgo(status.lastRequestAt);
  request.className = status.lastRequestAt === null ? 'is-cold' : '';

  $('liveNote').textContent = running
    ? status.handshakeAt === null
      ? 'no handshake yet'
      : `verified ${ago(status.handshakeAt)}`
    : '';
}

window.setInterval(paintClock, 1000);

function step(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-step="${name}"]`)!;
}

/** Builds "text <strong>bold</strong> text" without touching innerHTML. */
function frag(before: string, bold: string, after: string): DocumentFragment {
  const f = document.createDocumentFragment();
  f.append(before, el('strong', '', bold), after);
  return f;
}

// ------------------------------------------------------------------- log

/** Anything the user might have to act on. Counted so problems are never buried. */
let problems = 0;

/**
 * Splits a log line into a short subject and the rest, so the eye can scan the left
 * column. "tunnel: no such host" and "request POST /mcp → 200" both work.
 */
function splitMessage(message: string): [string, string] {
  const colon = message.indexOf(': ');
  if (colon > 0 && colon <= 24) return [message.slice(0, colon), message.slice(colon + 2)];
  const space = message.indexOf(' ');
  if (space > 0 && space <= 24) return [message.slice(0, space), message.slice(space + 1)];
  return [message, ''];
}

function logRow(entry: LogEntry): HTMLElement {
  const [what, rest] = splitMessage(entry.message);
  const line = el('p', entry.level === 'info' ? '' : 'bad');
  const time = document.createElement('time');
  time.textContent = new Date(entry.time).toLocaleTimeString();
  line.append(time, el('span', 'what', what), el('span', 'rest', rest));
  return line;
}

function addLogLine(entry: LogEntry): void {
  if (entry.level !== 'info') {
    problems += 1;
    for (const id of ['homeProblems', 'logProblems']) {
      const badge = $(id);
      badge.hidden = false;
      badge.textContent = `${problems} problem${problems === 1 ? '' : 's'}`;
    }
  }
  for (const id of ['homeFeed', 'fullFeed']) {
    const view = $(id);
    const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
    view.append(logRow(entry));
    while (view.childElementCount > 500) view.firstElementChild?.remove();
    if (atBottom) view.scrollTop = view.scrollHeight;
  }
}

$('logFilter').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (!button) return;
  for (const other of $('logFilter').querySelectorAll('button')) {
    other.classList.toggle('is-sel', other === button);
  }
  $('fullFeed').classList.toggle('only-bad', button.dataset.filter === 'bad');
});

// --------------------------------------------------------------- wiring

async function addFolder(): Promise<void> {
  const next = await run(api.addRoot());
  if (next) apply(next);
}

async function toggleConnection(): Promise<void> {
  if (!state) return;
  // Mirrors the button label exactly, so a click always does what it says.
  const next = await run(isRunning(state.status.state) ? api.disconnect() : api.connect());
  if (next) apply(next);
}

/** Runs the main-process self-test and lists a line per link in the chain. */
async function runChecks(): Promise<void> {
  const button = $<HTMLButtonElement>('runChecks');
  button.disabled = true;
  $('runChecksLabel').textContent = 'Checking…';
  try {
    const result = await run(api.runDiagnostics());
    if (!result) return;
    $('checksSummary').textContent = result.summary;
    $('checkList').replaceChildren(
      ...result.checks.map((check) => {
        const li = el(
          'li',
          check.ok === true ? 'check is-ok' : check.ok === false ? 'check is-bad' : 'check'
        );
        const mark = el('span', 'check-mark', check.ok === true ? '✓' : check.ok === false ? '!' : '·');
        const body = el('div');
        body.append(el('strong', '', check.name), el('p', '', check.detail));
        li.append(mark, body);
        return li;
      })
    );
    $('checksBox').hidden = false;
    $('checksBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    button.disabled = false;
    $('runChecksLabel').textContent = 'Run checks';
  }
}

$('runChecks').addEventListener('click', () => void runChecks());
$('closeChecks').addEventListener('click', () => {
  $('checksBox').hidden = true;
});

$('themeBtn').addEventListener('click', () => {
  if (!state) return;
  const next = state.config.ui.theme === 'dark' ? 'light' : 'dark';
  // Applied immediately so the click feels instant; the save confirms it.
  document.documentElement.dataset.theme = next;
  void save({ theme: next });
});

$('readOnlyBtn').addEventListener('click', () => {
  if (state) void save({ readOnly: !state.config.readOnly });
});

$('addFolder').addEventListener('click', () => void addFolder());
$('wizAddFolder').addEventListener('click', () => void addFolder());

$('wizExpand').addEventListener('click', () => {
  showAllSteps = !showAllSteps;
  if (state) apply(state);
});
$('connectBtn').addEventListener('click', () => void toggleConnection());
$('wizConnect').addEventListener('click', () => void toggleConnection());

$('pickBinary').addEventListener('click', async () => {
  const next = await run(api.pickBinary());
  if (next) apply(next);
});

$('copyUrl').addEventListener('click', async () => {
  await navigator.clipboard.writeText($<HTMLInputElement>('publicUrl').value);
  toast('URL copied');
});

for (const id of ['copyLog', 'copyLogText']) {
  $(id).addEventListener('click', async () => {
    const text = await run(api.getLogText());
    if (text === null) return;
    await navigator.clipboard.writeText(text);
    toast('Activity copied');
  });
}

$('copyLogJson').addEventListener('click', async () => {
  const text = await run(api.getLogJson());
  if (text === null) return;
  await navigator.clipboard.writeText(text);
  toast('Activity JSON copied');
});

// The API key is written on blur so it is not saved keystroke by keystroke.
$('apiKey').addEventListener('blur', async () => {
  const input = $<HTMLInputElement>('apiKey');
  if (input.value === '') return;
  const next = await run(api.setApiKey(input.value));
  input.value = '';
  if (next) {
    apply(next);
    toast('API key stored');
  }
});

$('removeApiKey').addEventListener('click', async () => {
  const next = await run(api.setApiKey(''));
  if (next) {
    apply(next);
    toast('API key removed');
  }
});

for (const id of ['autoConnect', 'minimizeToTray', 'privacyScreenshots', 'tunnelKind', 'tunnelId']) {
  $(id).addEventListener('change', () => void save());
}

document.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-link]');
  if (link?.dataset.link) void api.openLink(link.dataset.link);
});

api.onStateChanged(apply);
api.onLogEntry(addLogLine);

async function refresh(): Promise<void> {
  const next = await run(api.getState());
  if (next) apply(next);
}

buildGroups();

void (async () => {
  await refresh();
  // A first run has nothing set up, so open on the wizard rather than an empty Home.
  if (state && missingStep(state)?.step === 'folder') showTab('setup');
  const entries = await run(api.getLog());
  for (const entry of entries ?? []) addLogLine(entry);
})();
