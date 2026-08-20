/**
 * The Chat panel: recorded sessions, their timeline, the brief a compaction left behind,
 * and the settings those need (recording, the browser extension, multi-agent mode).
 *
 * This is a viewer, not a second ChatGPT client, and not a place a compaction is started:
 * a session is compacted by the chat it lives in, from the button the extension puts beside
 * ChatGPT's composer. Everything here arrives through the same fixed IPC channels as the
 * rest of the renderer.
 *
 * The timeline is drawn from what the recorder actually stored. Where a value is a
 * local estimate rather than a fact — token counts above all — the UI says so, because
 * the whole point of this panel is to be more honest than the wall of "Called tool".
 */

import type {
  ActivitySummary,
  AgentState,
  Handoff,
  SessionEvent,
  SessionSummary,
  SwarmState,
  TokenPressure
} from '../shared/session.js';
import { ATTRIBUTION_LABELS, TURN_OUTCOME_LABELS, foldProgress } from '../shared/session.js';
import { chronological } from '../shared/chronology.js';
import type { AppState, Config } from '../shared/types.js';
import { $, ago, clockTime, compactNumber, el, icon, run, toast } from './dom.js';

const api = window.api;

/** Sprite id per tool-call family. Deliberately reuses the existing icon set. */
const KIND_ICON: Record<ActivitySummary['kind'], string> = {
  edit: 'i-pencil',
  create: 'i-plus',
  delete: 'i-trash',
  move: 'i-out',
  read: 'i-eye',
  search: 'i-search',
  browse: 'i-folder',
  run: 'i-terminal',
  process: 'i-terminal',
  screen: 'i-monitor',
  input: 'i-monitor',
  clipboard: 'i-copy',
  session: 'i-steps',
  agent: 'i-bolt',
  other: 'i-bolt'
};

/**
 * Models per page. Twenty fills the list without turning model choice into paging: the
 * catalogue is hundreds long and arrives newest-first, so the model someone wants is
 * usually in the first page or two.
 */
const MODEL_PAGE = 20;

/**
 * Which agent's events the timeline is showing.
 *
 * `null` is everything. `UNATTRIBUTED` is its own bucket rather than being folded into
 * "all", because a call this app could not tie to any agent is a real category — with
 * ChatGPT's stateless connector it is the *default* category — and hiding it inside the
 * total would let a filtered view look complete when it is not.
 */
const UNATTRIBUTED = '\u0000unattributed';
let agentFilter: string | null = null;
/** The session the current filter was chosen in; selecting a different one resets it. */
let filterFor: string | null = null;

interface Deps {
  /** The renderer's single save path — reads every control, including ours. */
  save: () => Promise<void>;
  state: () => AppState | null;
}

let deps: Deps;
let visible = false;

let sessions: SessionSummary[] = [];
let pressure = new Map<string, TokenPressure>();
let activeId: string | null = null;
let selectedId: string | null = null;
let events: SessionEvent[] = [];
let totalEvents = 0;
/** The last swarm the app reported, so the header can summarise it without the log. */
let swarm: SwarmState | null = null;
/** Badges the list is currently drawn with. See repaintBadges. */
let badgeKey = '';

/** Handoff currently shown, and the id it was loaded for. */
let handoff: Handoff | null = null;
let handoffFor: string | null = null;

let listTimer: number | undefined;

// ------------------------------------------------------------------ sessions

function pressureOf(id: string): TokenPressure | null {
  return pressure.get(id) ?? null;
}

/** A short word about a session, drawn as a chip on its row. */
interface Badge {
  text: string;
  tone: '' | 'is-active' | 'is-finished' | 'is-failed';
}

/** Live word per worker state, in the user's vocabulary rather than the protocol's. */
const AGENT_BADGE: Record<AgentState, Badge> = {
  invited: { text: 'opening', tone: 'is-active' },
  active: { text: 'joined', tone: 'is-active' },
  finished: { text: 'finished', tone: 'is-finished' },
  failed: { text: 'failed', tone: 'is-failed' }
};

/**
 * What a row is, and what it is doing right now.
 *
 * Once resume and multi-agent mode are in use, most rows in the list are chats this app
 * opened, and they are all recorded within a minute of each other. A name alone cannot
 * separate them — which run a chat belonged to, whether its tab ever opened, whether the
 * worker in it ever joined — and that is how a user loses track of a delayed tab. The
 * first badge is durable and comes from the session itself; the second is live and comes
 * from the swarm or the compaction currently reported by the app.
 */
function sessionBadges(summary: SessionSummary): Badge[] {
  const badges: Badge[] = [];
  const origin = summary.origin;
  // The one session that is not a chat. Saying so on the row is what stops it reading
  // as a chat that mysteriously lost its name.
  if (summary.conversationId === null) return [{ text: 'not a chat', tone: '' }];
  if (origin?.kind === 'worker') badges.push({ text: origin.agentId ?? 'worker', tone: '' });
  else if (origin?.kind === 'resume') badges.push({ text: 'resumed', tone: '' });
  else if (summary.agents.includes('prime')) badges.push({ text: 'prime', tone: '' });

  // Agent ids are reused across runs (`worker-1`, `worker-2`, ...). Matching only by that
  // short id made old worker sessions inherit the *current* run's live badge, so a worker
  // chat from 20 minutes ago suddenly said "joined" again when a new worker-2 started.
  // Conversation id is the durable identity of the actual ChatGPT tab, so only that exact
  // worker session may borrow the live swarm state.
  const agent = origin?.agentId
    ? swarm?.agents.find(
        (entry) => entry.id === origin.agentId && Boolean(entry.conversationId) && entry.conversationId === summary.conversationId
      )
    : undefined;
  if (agent) {
    badges.push(AGENT_BADGE[agent.state]);
    return badges;
  }

  return badges;
}

function sessionRow(summary: SessionSummary): HTMLElement {
  const row = el('div', 'sess');
  row.dataset.id = summary.id;
  if (summary.id === selectedId) row.classList.add('is-sel');
  if (summary.id === activeId && summary.endedAt === null) row.classList.add('is-live');

  const top = el('div', 'sess-top');
  const title = el('b', '', summary.title || 'Untitled session');
  title.title = summary.title;
  const when = el('em', '', ago(summary.updatedAt));
  top.append(title, when);

  const bits: string[] = [
    `${summary.userMessages} message${summary.userMessages === 1 ? '' : 's'}`,
    `${summary.toolCalls} tool${summary.toolCalls === 1 ? '' : 's'}`
  ];
  if (summary.errors > 0) bits.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
  if (summary.agents.length > 0) bits.push(`${summary.agents.length} agents`);
  const sub = el('div', 'sess-sub');
  for (const badge of sessionBadges(summary)) {
    sub.append(el('span', `chip${badge.tone ? ` ${badge.tone}` : ''}`, badge.text));
  }
  sub.append(el('span', 'sess-bits', bits.join(' · ')));

  const level = pressureOf(summary.id);
  const bar = el('div', `bar${level ? ` is-${level.level}` : ''}`);
  const fill = el('i');
  const share = level && level.limit > 0 ? Math.min(100, (level.estimated / level.limit) * 100) : 0;
  fill.style.width = `${share.toFixed(1)}%`;
  bar.append(fill);
  bar.title = `~${compactNumber(summary.estimatedTokens)} rough context tokens from messages and tool I/O; transient progress is excluded`;

  const remove = document.createElement('button');
  remove.className = 'btn sess-del';
  remove.type = 'button';
  remove.title = 'Delete this recorded session';
  remove.append(icon('i-trash'));
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    void deleteSession(summary.id);
  });

  row.append(top, sub, bar, remove);
  return row;
}

async function deleteSession(id: string): Promise<void> {
  const done = await run(api.deleteSession(id));
  if (done === null) return;
  if (selectedId === id) {
    selectedId = null;
    events = [];
    handoff = null;
    handoffFor = null;
  }
  toast('Session deleted');
  await loadSessions();
}

async function loadSessions(): Promise<void> {
  const list = await run(api.listSessions());
  if (!list) return;
  sessions = list.sessions;
  activeId = list.activeId;
  pressure = new Map(list.pressure.map((entry) => [entry.id, entry]));
  if (selectedId !== null && !sessions.some((s) => s.id === selectedId)) selectedId = null;
  if (selectedId === null) selectedId = activeId ?? sessions[0]?.id ?? null;
  paintSessions();
  await loadDetail();
}

function paintSessions(): void {
  const list = $('sessionList');
  list.replaceChildren(...sessions.map(sessionRow));
  badgeKey = badgeSignature();
  $('sessionsEmpty').hidden = sessions.length > 0;

  const recording = deps.state()?.config.sessions.record === true;
  $('sessionsFoot').textContent = recording
    ? `${sessions.length} recorded session${sessions.length === 1 ? '' : 's'}${
        activeId ? ' · one live now' : ''
      }`
    : 'Recording is off. Turn it on in Settings to record new sessions.';
}

async function loadDetail(): Promise<void> {
  if (selectedId === null) {
    events = [];
    totalEvents = 0;
    paintDetail();
    return;
  }
  const detail = await run(api.getSession(selectedId));
  if (!detail) return;
  // User/assistant prose is canonical in messages.json, while structured page activity stays
  // append-only by design: ChatGPT can grow one commentary caption or rewrite one activity
  // label several times. `foldProgress` turns those snapshots back into the one logical row
  // their stable progressId/messageId names, then chronology places that row at its first
  // appearance. This helper existed already but was never wired into the desktop reader,
  // which is why "Inspecting…" and "Inspected…" still appeared as siblings.
  events = chronological(foldProgress(detail.events));
  totalEvents = detail.total;
  paintDetail();
  void loadHandoff();
}

async function loadHandoff(): Promise<void> {
  const summary = sessions.find((s) => s.id === selectedId) ?? null;
  const wanted = summary?.lastHandoffId ?? null;
  if (wanted === null) {
    handoff = null;
    handoffFor = null;
    paintHandoff();
    return;
  }
  if (handoffFor === wanted) return;
  const loaded = await run(api.getHandoff(summary!.id, wanted));
  handoff = loaded ?? null;
  handoffFor = wanted;
  paintHandoff();
}

// ------------------------------------------------------------------ timeline

function textBlock(className: string, value: string, truncated: boolean, chars: number): HTMLElement {
  const node = el('p', className, value);
  if (truncated) {
    node.append(el('span', 'cut', ` … cut, ${compactNumber(chars)} characters in the original`));
  }
  return node;
}

const RENDERED_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'MARK', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);
const DROP_RENDERED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK'
]);

function safeRenderedHref(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Sanitizes ChatGPT's captured rendered HTML without reparsing Markdown.
 *
 * The page is untrusted input even though the extension produced the observation. Preserve
 * semantic Markdown tags, discard executable/form/embed content, strip every attribute by
 * default, and allow only the tiny attribute set that affects normal Markdown semantics.
 */
export function renderedMessage(html: string, fallback: string): HTMLElement {
  const box = el('div', 'msg rich');
  if (!html) {
    box.textContent = fallback;
    return box;
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  const visit = (parent: ParentNode): void => {
    for (const node of [...parent.childNodes]) {
      // Namespace elements (SVG/MathML) are not HTMLElements. Checking HTMLElement here
      // would let exactly the foreign content in DROP_RENDERED_TAGS bypass traversal and
      // attribute stripping. nodeType is realm-agnostic and covers every DOM Element.
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tagName = element.tagName.toUpperCase();
      if (DROP_RENDERED_TAGS.has(tagName)) {
        element.remove();
        continue;
      }
      visit(element);
      if (!RENDERED_TAGS.has(tagName)) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      const href = tagName === 'A' ? safeRenderedHref(element.getAttribute('href') ?? '') : null;
      const title = element.getAttribute('title');
      const start = tagName === 'OL' ? element.getAttribute('start') : null;
      const colSpan = tagName === 'TD' || tagName === 'TH' ? element.getAttribute('colspan') : null;
      const rowSpan = tagName === 'TD' || tagName === 'TH' ? element.getAttribute('rowspan') : null;
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      if (href) {
        element.setAttribute('href', href);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noreferrer noopener');
      }
      if (title) element.setAttribute('title', title.slice(0, 500));
      if (start && /^\d{1,6}$/.test(start)) element.setAttribute('start', start);
      if (colSpan && /^\d{1,3}$/.test(colSpan)) element.setAttribute('colspan', colSpan);
      if (rowSpan && /^\d{1,3}$/.test(rowSpan)) element.setAttribute('rowspan', rowSpan);
    }
  };
  visit(template.content);
  box.append(template.content);
  if (!box.textContent?.trim() && fallback) box.textContent = fallback;
  return box;
}

function toolBody(event: Extract<SessionEvent, { kind: 'tool_call' }>): HTMLElement {
  const { call } = event;
  const box = document.createElement('details');
  box.className = `tool tone-${call.summary.tone}`;

  const head = document.createElement('summary');
  head.append(icon(KIND_ICON[call.summary.kind] ?? 'i-bolt', 'ico tool-ico'));
  head.append(el('b', '', call.summary.title));
  if (call.summary.detail) head.append(el('em', '', call.summary.detail));
  if (call.summary.metric) head.append(el('span', 'metric', call.summary.metric));
  box.append(head);

  const raw = el('div', 'raw');
  const facts = el('p', 'raw-facts');
  facts.textContent =
    `${call.tool} · ${call.outcome} · ${Math.round(call.durationMs)} ms · ` +
    `placed by ${ATTRIBUTION_LABELS[call.attribution] ?? call.attribution}`;
  raw.append(facts);

  if (call.changes && call.changes.length > 0) {
    const changes = el('ul', 'changes');
    for (const change of call.changes) {
      const li = el('li');
      li.append(el('code', '', change.path));
      const counts = `+${change.added} −${change.removed}${change.approximate ? ' (approx.)' : ''}`;
      li.append(el('span', 'metric', counts));
      changes.append(li);
    }
    raw.append(changes);
  }

  raw.append(el('h4', '', 'Arguments'));
  raw.append(textBlock('pre', call.args.text, call.args.truncated, call.args.chars));
  raw.append(el('h4', '', 'Result'));
  raw.append(textBlock('pre', call.result.text, call.result.truncated, call.result.chars));

  for (const asset of call.assets ?? []) {
    raw.append(el('p', 'raw-facts', `asset ${asset.id} · ${asset.mimeType} · ${compactNumber(asset.bytes)} bytes`));
  }

  box.append(raw);
  return box;
}

function eventBody(event: SessionEvent): HTMLElement {
  switch (event.kind) {
    case 'session_start':
      return el('p', 'meta', `Session started — ${event.title}`);
    case 'user_message': {
      const box = el('div', 'said is-user');
      box.append(el('b', '', 'You'));
      box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      return box;
    }
    case 'assistant_message': {
      const box = el('div', 'said');
      box.append(el('b', '', event.final ? 'ChatGPT' : 'ChatGPT (partial)'));
      box.append(renderedMessage(event.renderedHtml?.text ?? '', event.message.text));
      return box;
    }
    case 'progress':
      return el('p', 'meta is-progress', event.message.text);
    case 'page_tool': {
      const line = el('p', 'meta is-progress thinking-line');
      line.append(icon('i-bolt', 'ico thinking-ico'), el('span', '', event.label));
      return line;
    }
    case 'turn_start':
      return el('p', 'meta', 'Turn started');
    case 'turn_end': {
      const line = el(
        'p',
        event.outcome === 'completed' ? 'meta' : 'meta is-warn',
        `Turn ${TURN_OUTCOME_LABELS[event.outcome]}${event.detail ? ` — ${event.detail}` : ''}`
      );
      return line;
    }
    case 'chat_error':
      return textBlock('meta is-bad', event.message.text, event.message.truncated, event.message.chars);
    case 'tool_call':
      return toolBody(event);
    case 'note':
      return el('p', 'meta', event.message.text);
    /**
     * Rendered rather than left to fall through to "Unknown event".
     *
     * The timeline is how the user checks what the agents actually said to each other, and
     * a run of grey "Unknown event" rows in the middle of a multi-agent session reads as a
     * broken log — the one impression a session recorder cannot afford to give.
     */
    case 'agent_message': {
      const box = el('div', 'said');
      // Which end of the message this record is. The same message is written once here and
      // once in the other agent's session, so without this a pair reads as two messages.
      box.title =
        event.delivery === 'sent'
          ? `Sent by ${event.from}; recorded when the app accepted it`
          : `Received by ${event.to}; recorded when it acknowledged delivery`;
      box.append(el('b', '', `${event.from} → ${event.to}`));
      box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      return box;
    }
    case 'handoff':
      return el(
        'p',
        'meta is-good',
        `Handoff saved — ${compactNumber(event.chars)} characters (${event.reason})`
      );
    default:
      return el('p', 'meta', 'Unknown event');
  }
}

function eventRow(event: SessionEvent): HTMLElement {
  const row = el('div', `ev ev-${event.kind}`);
  const time = document.createElement('time');
  time.textContent = clockTime(event.time);
  time.title = new Date(event.time).toLocaleString();
  const body = el('div', 'ev-body');
  if (event.agent) body.append(el('span', 'chip', event.agent));
  body.append(eventBody(event));
  row.append(time, body);
  return row;
}

/**
 * The agent chips above the timeline.
 *
 * Drawn only when this session actually has more than one attribution in it, so a
 * single-agent session — which is every session unless multi-agent mode is running —
 * keeps exactly the view it had before.
 */
function paintAgentFilter(): void {
  const box = $('chatAgentFilter');
  const named = [...new Set(events.flatMap((event) => (event.agent ? [event.agent] : [])))].sort();
  const anyUnattributed = events.some((event) => !event.agent);
  // A filter belongs to the session it was chosen in. Carrying it across a selection
  // change showed the next session's timeline as empty with no chip lit to explain why —
  // and agent ids repeat between runs, so it could also silently hide half of one. The
  // same guard catches an agent that simply is not in this session's events.
  if (filterFor !== selectedId) {
    agentFilter = null;
    filterFor = selectedId;
  } else if (agentFilter !== null && agentFilter !== UNATTRIBUTED && !named.includes(agentFilter)) {
    agentFilter = null;
  }
  if (named.length === 0 || (named.length === 1 && !anyUnattributed)) {
    box.hidden = true;
    box.replaceChildren();
    agentFilter = null;
    return;
  }
  const buttons: HTMLElement[] = [];
  const chip = (value: string | null, label: string): HTMLElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.agent = value ?? '';
    if (agentFilter === value) button.classList.add('is-sel');
    return button;
  };
  buttons.push(chip(null, 'All'));
  for (const agent of named) buttons.push(chip(agent, agent));
  if (anyUnattributed) buttons.push(chip(UNATTRIBUTED, 'Unattributed'));
  box.replaceChildren(...buttons);
  box.hidden = false;
}

function visibleEvents(): SessionEvent[] {
  if (agentFilter === null) return events;
  if (agentFilter === UNATTRIBUTED) return events.filter((event) => !event.agent);
  return events.filter((event) => event.agent === agentFilter);
}

function paintDetail(): void {
  const summary = sessions.find((s) => s.id === selectedId) ?? null;
  $('chatTitle').textContent = summary ? summary.title || 'Untitled session' : 'No session selected';

  paintAgentFilter();
  const shown = visibleEvents();

  // The scroller is the card body, not the list: a live session appends to the bottom,
  // so stay pinned there unless the user has scrolled up to read something.
  const pane = $('chatBody');
  const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40;
  $('timeline').replaceChildren(...shown.map(eventRow));
  $('timelineEmpty').hidden = shown.length > 0;
  if (atBottom) pane.scrollTop = pane.scrollHeight;

  const facts: string[] = [];
  if (summary) {
    facts.push(`${totalEvents} event${totalEvents === 1 ? '' : 's'}`);
    if (events.length < totalEvents) facts.push(`showing the last ${events.length}`);
    if (agentFilter !== null) {
      facts.push(`filtered to ${agentFilter === UNATTRIBUTED ? 'unattributed' : agentFilter} — ${shown.length} shown`);
    }
    facts.push(`~${compactNumber(summary.estimatedTokens)} rough context tokens`);
    const level = pressureOf(summary.id);
    if (level && level.level !== 'ok') {
      facts.push(
        level.level === 'huge'
          ? 'past the compaction threshold — compact before continuing'
          : 'large — compaction is worth doing soon'
      );
    }
    if (summary.lastTurnOutcome && summary.lastTurnOutcome !== 'completed') {
      facts.push(`last turn ${TURN_OUTCOME_LABELS[summary.lastTurnOutcome]}`);
    }
  }
  $('chatFoot').textContent = facts.join(' · ');
  $('chatFoot').classList.toggle('is-warn', pressureOf(selectedId ?? '')?.level === 'huge');
}

// -------------------------------------------------------------------- handoff

/**
 * The brief the last compaction of this session left behind.
 *
 * A record, not a control. The compaction itself happens in the ChatGPT conversation — the
 * chat writes its own brief as its final answer — so what is worth showing here is the
 * document that came out of it, and any warning attached to it.
 */
function paintHandoff(): void {
  const hand = $('handoffBox');
  if (handoff) {
    const parts: HTMLElement[] = [];
    const head = el('p', 'hint');
    head.textContent = `${compactNumber(handoff.text.length)} characters · from ${handoff.sourceEvents} events (~${compactNumber(handoff.sourceTokens)} tokens) · ${ago(handoff.createdAt)}`;
    parts.push(head);
    for (const note of handoff.notes) parts.push(el('p', 'hint is-warn', note));
    parts.push(el('pre', 'pre', handoff.text));
    hand.replaceChildren(...parts);
    $('handoffHead').hidden = false;
    $('copyHandoff').hidden = false;
  } else {
    hand.replaceChildren();
    $('handoffHead').hidden = true;
    $('copyHandoff').hidden = true;
  }
  paintStateLine();
}

/**
 * One line under the header saying what is happening right now.
 *
 * The complaint this answers: the only place a user could find out whether a worker's chat
 * had opened was the raw Activity log, which is a diagnostics view rather than an answer to
 * "what is happening".
 */
function paintStateLine(): void {
  const note = $('chatState');
  const { text, tone } = stateLine();
  note.textContent = text;
  note.className = `subhead-note${tone ? ` ${tone}` : ''}`;
  repaintBadges();
}

/**
 * Redraws the list when a row's badges would change, and not otherwise.
 *
 * The badges follow live state, which changes as fast as the recorder writes. Rebuilding
 * every row for each of those would be a list that flickers while it is being read, so the
 * redraw is keyed on the badges themselves.
 */
function repaintBadges(): void {
  const key = badgeSignature();
  if (key === badgeKey) return;
  paintSessions();
}

function badgeSignature(): string {
  return sessions.map((entry) => sessionBadges(entry).map((badge) => badge.text).join(',')).join('|');
}

function stateLine(): { text: string; tone: '' | 'is-live' | 'is-bad' } {
  // Recording follows the conversation the browser can see. A tool call arrives over the
  // connector carrying nothing that identifies its caller, so work driven from the phone,
  // from another browser or from another machine can only be recorded as what it is:
  // real, complete, and not placeable in any chat this app can observe.
  const selected = sessions.find((entry) => entry.id === selectedId) ?? null;
  if (selected && selected.conversationId === null) {
    return {
      text: 'Work this app could not place in a chat — driven from another device, or with no ChatGPT tab open',
      tone: ''
    };
  }

  const workers = swarm?.agents.filter((agent) => agent.role === 'worker') ?? [];
  if (workers.length === 0) return { text: '', tone: '' };
  const count = (state: AgentState): number => workers.filter((agent) => agent.state === state).length;
  const parts: string[] = [];
  if (count('active') > 0) parts.push(`${count('active')} working`);
  // "invited" is a worker whose ChatGPT tab has been asked for but has not joined yet.
  if (count('invited') > 0) parts.push(`${count('invited')} opening`);
  if (count('finished') > 0) parts.push(`${count('finished')} finished`);
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  return {
    text: `${workers.length === 1 ? '1 worker' : `${workers.length} workers`} · ${parts.join(' · ')}`,
    tone: count('failed') > 0 ? 'is-bad' : count('invited') > 0 || count('active') > 0 ? 'is-live' : ''
  };
}

// ----------------------------------------------------------------- settings

/**
 * Shows where the extension actually is on this machine.
 *
 * An installed build has no source tree, so "load extension/ from the repo" is advice
 * that cannot be followed. Asked once and cached, because the answer cannot change while
 * the app is running.
 */
let extensionPathShown = false;
async function showExtensionPath(): Promise<void> {
  if (extensionPathShown) return;
  extensionPathShown = true;
  const dir = await run(api.extensionPath());
  const node = $('extensionPath');
  if (dir) {
    node.textContent = `Extension folder: ${dir}`;
    node.classList.remove('is-warn');
  } else {
    node.textContent =
      'The extension folder is missing from this installation. Reinstall the app, or use the extension\\ folder from a source checkout.';
    node.classList.add('is-warn');
    $<HTMLButtonElement>('bridgeFolder').disabled = true;
  }
}

function paintSwarm(state: SwarmState): void {
  swarm = state;
  paintStateLine();
  const list = $('swarmList');
  if (state.agents.length === 0) {
    list.replaceChildren(el('p', 'hint', 'No agents. The prime agent creates workers with the agents tool’s spawn action.'));
  } else {
    list.replaceChildren(
      ...state.agents.map((agent) => {
        const row = el('div', 'agent');
        const top = el('div', 'model-top');
        top.append(el('b', '', agent.label || agent.id));
        top.append(el('span', 'chip', agent.role));
        top.append(el('span', `chip is-${agent.state}`, agent.state));
        // Clearing is offered where the agent is, not only as one global reset at the
        // bottom of a settings form. The two rows mean different things and the tooltip
        // says which: the prime is the run, a worker is one slot.
        const over = agent.state === 'finished' || agent.state === 'failed';
        if (!over) {
          const clear = el('button', 'btn btn-quiet agent-clear');
          clear.append(icon('i-x'));
          clear.dataset.clear = agent.id;
          clear.title =
            agent.role === 'prime'
              ? 'Clear session — ends this run and every worker in it'
              : `Clear session — ends ${agent.id} and frees its slot`;
          top.append(clear);
        }
        // The one place a recovery key can be asked for, and only where it means anything:
        // a live worker slot whose chat never reported which conversation it is. Everything
        // else about worker identity happens without anybody pressing anything.
        if (!over && agent.role === 'worker' && !agent.conversationId) {
          const recover = el('button', 'btn btn-quiet agent-clear');
          recover.append(icon('i-key'));
          recover.dataset.recover = agent.id;
          recover.title = `Copy a one-time recovery key — paste it into ${agent.id}'s chat if it opened but was never bound`;
          top.append(recover);
        }
        const sub = el('div', 'model-sub');
        const bits = [`${agent.pending} pending`, `${agent.delivered} delivered`];
        if (agent.conversationId) bits.push('chat bound');
        sub.textContent = bits.join(' · ');
        row.append(top, sub);
        if (agent.task) row.append(el('p', 'hint', agent.task));
        // Why it failed, not just that it did. A worker only reaches this state when its
        // chat could not be opened, and the reason is the only actionable part.
        if (agent.state === 'failed' && agent.result) row.append(el('p', 'hint is-warn', agent.result));
        return row;
      })
    );
  }
  // Usable whenever there is a run to clear, not only while a worker is still going.
  // Gating on `running` left finished-but-present swarm state with no way out, which is
  // exactly the state a user wants to clear before starting the next run.
  $<HTMLButtonElement>('swarmReset').disabled = state.agents.length === 0;
}

/** Reads the three config sections this panel owns, for the renderer's save path. */
export function chatSettingsPatch(current: Config): {
  sessions: Config['sessions'];
  compaction: Config['compaction'];
  multiAgent: Config['multiAgent'];
} {
  const number = (id: string, fallback: number, min: number, max: number): number => {
    const raw = Number($<HTMLInputElement>(id).value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
  };
  return {
    sessions: {
      record: $<HTMLInputElement>('sessRecord').checked,
      retainDays: number('sessRetain', current.sessions.retainDays, 0, 3650),
      advisoryTokens: number('sessAdvisory', current.sessions.advisoryTokens, 10_000, 2_000_000),
      limitTokens: number('sessLimit', current.sessions.limitTokens, 10_000, 4_000_000)
    },
    compaction: {
      auto: $<HTMLInputElement>('autoCompact').checked,
      autoTokens: number('autoCompactTokens', current.compaction.autoTokens, 10_000, 4_000_000)
    },
    multiAgent: {
      enabled: $<HTMLInputElement>('maEnabled').checked,
      maxWorkers: number('maWorkers', current.multiAgent.maxWorkers, 1, 8)
    }
  };
}

/** Writes app state into this panel's controls. Called from the renderer's apply(). */
/**
 * Says in words what the automatic switch will actually do, including the parts that are
 * easy to be surprised by: which chat ends, and that the number it fires on is an estimate
 * rather than ChatGPT's own accounting.
 */
function applyAutoCompactHint(config: Config): void {
  const { auto, autoTokens } = config.compaction;
  const tokens = compactNumber(autoTokens);
  $('autoCompactHint').textContent = !auto
    ? 'Off. Compaction only happens when you press Compact & resume in the ChatGPT tab.'
    : `Past roughly ${tokens} recorded tokens, this chat is stopped and asked to write its own ` +
      'handoff, then a fresh chat opens carrying it. Each chat is compacted once; the fresh one ' +
      'starts its own count.';
}

export function chatApply(state: AppState): void {
  const { config, bridge } = state;

  $<HTMLInputElement>('sessRecord').checked = config.sessions.record;
  $<HTMLInputElement>('sessRetain').value = String(config.sessions.retainDays);
  $<HTMLInputElement>('sessAdvisory').value = String(config.sessions.advisoryTokens);
  $<HTMLInputElement>('sessLimit').value = String(config.sessions.limitTokens);

  $<HTMLInputElement>('autoCompact').checked = config.compaction.auto;
  $<HTMLInputElement>('autoCompactTokens').value = String(config.compaction.autoTokens);
  applyAutoCompactHint(config);

  $<HTMLInputElement>('maEnabled').checked = config.multiAgent.enabled;
  $<HTMLInputElement>('maWorkers').value = String(config.multiAgent.maxWorkers);

  // Extension bridge. Connecting is automatic, so this reports rather than asks.
  $<HTMLButtonElement>('bridgeUnpair').disabled = !bridge.paired;
  $('bridgeState').textContent = !bridge.running
    ? 'The local bridge is off. Turn recording or multi-agent mode on to start it.'
    : bridge.paired
      ? `Connected. Listening on 127.0.0.1:${bridge.port ?? '?'} · last message ${ago(bridge.lastSeenAt)}.`
      : `Listening on 127.0.0.1:${bridge.port ?? '?'} · no browser has connected yet.`;
  $('bridgeState').classList.toggle('is-warn', bridge.running && !bridge.paired);
  void showExtensionPath();

  if (sessions.length > 0) paintSessions();
}

/** Called when the Chat tab becomes visible or is left, so it only polls when shown. */
export function chatVisible(next: boolean): void {
  visible = next;
  if (next) void refreshAll();
}

async function refreshAll(): Promise<void> {
  await loadSessions();
  const swarmNow = await run(api.getSwarm());
  if (swarmNow) paintSwarm(swarmNow);
}

/** Sessions change on every recorded event, so the reload is coalesced. */
function scheduleReload(): void {
  if (!visible) return;
  window.clearTimeout(listTimer);
  listTimer = window.setTimeout(() => void loadSessions(), 400);
}

// ------------------------------------------------------------------- wiring

/**
 * Switches the session card's body.
 *
 * Settings is reachable only from the gear, so it is deliberately not one of the switcher
 * buttons: while it is open no switcher button is selected, and the gear itself carries
 * the selected state instead. That is what keeps a property sheet from reading as a third
 * view of this session.
 */
function showView(name: string): void {
  for (const button of $('chatView').querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.classList.toggle('is-sel', button.dataset.view === name);
  }
  for (const view of document.querySelectorAll<HTMLElement>('#chatBody > .view')) {
    view.hidden = view.dataset.view !== name;
  }
  $('chatSettingsBtn').classList.toggle('is-on', name === 'settings');
}

/** Timeline or Compaction — whichever the gear was opened over. */
let lastContentView = 'timeline';

/** The gear toggles: pressing it again returns to the view the user came from. */
function toggleSettings(): void {
  const settings = document.querySelector<HTMLElement>('#chatBody > .view[data-view="settings"]');
  showView(settings && !settings.hidden ? lastContentView : 'settings');
}

export function initChat(next: Deps): void {
  deps = next;

  $('sessionList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!row?.dataset.id || row.dataset.id === selectedId) return;
    selectedId = row.dataset.id;
    handoff = null;
    handoffFor = null;
    paintSessions();
    void loadDetail();
  });

  $('chatView').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (!button?.dataset.view) return;
    lastContentView = button.dataset.view;
    showView(button.dataset.view);
  });

  $('chatSettingsBtn').addEventListener('click', () => toggleSettings());

  $('chatAgentFilter').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-agent]');
    if (!button) return;
    agentFilter = button.dataset.agent === '' ? null : (button.dataset.agent ?? null);
    paintDetail();
  });

  $('chatRefresh').addEventListener('click', () => void refreshAll());

  $('copyHandoff').addEventListener('click', async () => {
    if (!handoff) return;
    const copied = await run(api.writeClipboard(handoff.text));
    if (copied) toast('Handoff copied');
  });

  $('swarmReset').addEventListener('click', async () => {
    const state = await run(api.resetSwarm());
    if (state) {
      paintSwarm(state);
      toast('Swarm cleared');
    }
  });

  // Which of the two things happened is decided in the main process and reported back,
  // so the toast describes the actual outcome rather than the intent of the click.
  $('swarmList').addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const recoverId = target.closest<HTMLElement>('[data-recover]')?.dataset.recover;
    if (recoverId) {
      // Straight to the clipboard, never onto the screen: the user pastes it into the chat
      // that lost its binding, which is the only thing it can be used for.
      const minted = await run(api.recoveryKey(recoverId));
      if (!minted) return;
      if (!minted.key) {
        toast(`${recoverId} has nothing to recover`);
        return;
      }
      const copied = await run(api.writeClipboard(minted.key));
      toast(
        copied
          ? `Recovery key copied — in ${recoverId}'s chat, ask it to call agents action=join with that as join_key`
          : 'Could not copy the recovery key'
      );
      return;
    }
    const button = target.closest<HTMLElement>('[data-clear]');
    const id = button?.dataset.clear;
    if (!id) return;
    const outcome = await run(api.clearAgent(id));
    if (!outcome) return;
    paintSwarm(outcome.swarm);
    toast(
      outcome.cleared === 'run'
        ? 'Run cleared — every worker ended'
        : outcome.cleared === 'worker'
          ? `${id} cleared — its slot is free`
          : outcome.reason
    );
  });

  for (const id of [
    'sessRecord',
    'sessRetain',
    'sessAdvisory',
    'sessLimit',
    'autoCompact',
    'maEnabled',
    'maWorkers'
  ]) {
    $(id).addEventListener('change', () => void deps.save());
  }

  $('bridgeUnpair').addEventListener('click', async () => {
    const state = await run(api.unpairExtension());
    if (state) toast('Browser disconnected');
  });
  $('bridgeFolder').addEventListener('click', async () => {
    const dir = await run(api.openExtensionFolder());
    if (dir) toast('Extension folder opened');
  });

  api.onSessionChanged(scheduleReload);
  api.onSwarmChanged(paintSwarm);
}
