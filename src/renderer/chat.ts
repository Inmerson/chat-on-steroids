/**
 * The Chat panel: recorded sessions, their timeline, compaction, and the settings the
 * two of them need (recording, the browser extension, OpenRouter, multi-agent mode).
 *
 * This is a viewer, not a second ChatGPT client. It never talks to ChatGPT, never
 * reads a file and never sees a key: everything arrives through the same fixed IPC
 * channels as the rest of the renderer, and the OpenRouter key travels one way only.
 *
 * The timeline is drawn from what the recorder actually stored. Where a value is a
 * local estimate rather than a fact — token counts above all — the UI says so, because
 * the whole point of this panel is to be more honest than the wall of "Called tool".
 */

import type {
  ActivitySummary,
  CompactionStage,
  CompactionState,
  Handoff,
  OpenRouterModel,
  SessionEvent,
  SessionSummary,
  SwarmState,
  TokenPressure
} from '../shared/session.js';
import { COMPACTION_STAGE_LABELS, TURN_OUTCOME_LABELS } from '../shared/session.js';
import type { AppState, Config } from '../shared/types.js';
import { $, ago, clockTime, compactNumber, el, icon, run, toast } from './dom.js';

const api = window.api;

/** Stages in the order they happen. `idle` and `error` are not steps. */
const STAGES: CompactionStage[] = [
  'collecting',
  'preparing',
  'sending',
  'thinking',
  'streaming',
  'saving',
  'ready'
];

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
let compaction: CompactionState | null = null;

/** Handoff currently shown, and the id it was loaded for. */
let handoff: Handoff | null = null;
let handoffFor: string | null = null;

/** Everything we have seen of the OpenRouter catalogue, for honest capability notes. */
const modelIndex = new Map<string, OpenRouterModel>();
let modelOffset = 0;
let modelTotal = 0;

let listTimer: number | undefined;

// ------------------------------------------------------------------ sessions

function pressureOf(id: string): TokenPressure | null {
  return pressure.get(id) ?? null;
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
  const sub = el('div', 'sess-sub', bits.join(' · '));

  const level = pressureOf(summary.id);
  const bar = el('div', `bar${level ? ` is-${level.level}` : ''}`);
  const fill = el('i');
  const share = level && level.limit > 0 ? Math.min(100, (level.estimated / level.limit) * 100) : 0;
  fill.style.width = `${share.toFixed(1)}%`;
  bar.append(fill);
  bar.title = `~${compactNumber(summary.estimatedTokens)} estimated tokens of recorded text`;

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
  events = detail.events;
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
    paintCompaction();
    return;
  }
  if (handoffFor === wanted) return;
  const loaded = await run(api.getHandoff(summary!.id, wanted));
  handoff = loaded ?? null;
  handoffFor = wanted;
  paintCompaction();
}

// ------------------------------------------------------------------ timeline

function textBlock(className: string, value: string, truncated: boolean, chars: number): HTMLElement {
  const node = el('p', className, value);
  if (truncated) {
    node.append(el('span', 'cut', ` … cut, ${compactNumber(chars)} characters in the original`));
  }
  return node;
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
  facts.textContent = `${call.tool} · ${call.outcome} · ${Math.round(call.durationMs)} ms · attributed by ${call.attribution}`;
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
      box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      return box;
    }
    case 'progress':
      return el('p', 'meta', event.message.text);
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
    case 'handoff':
      return el(
        'p',
        'meta is-good',
        `Handoff saved — ${event.model}, ${compactNumber(event.chars)} characters (${event.reason})`
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
  const box = $('agentFilter');
  const named = [...new Set(events.flatMap((event) => (event.agent ? [event.agent] : [])))].sort();
  const anyUnattributed = events.some((event) => !event.agent);
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
    facts.push(`~${compactNumber(summary.estimatedTokens)} estimated tokens`);
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

  paintButtons();
}

// ---------------------------------------------------------------- compaction

function stageChips(state: CompactionState): HTMLElement {
  const box = el('div', 'stages');
  const current = STAGES.indexOf(state.stage);
  for (const [index, stage] of STAGES.entries()) {
    const chip = el('span', 'stage', COMPACTION_STAGE_LABELS[stage]);
    if (state.stage === 'error') {
      if (index < current) chip.classList.add('is-done');
    } else if (current >= 0) {
      if (index < current) chip.classList.add('is-done');
      if (index === current) chip.classList.add('is-now');
    }
    box.append(chip);
  }
  return box;
}

function paintCompaction(): void {
  const state = compaction;
  const box = $('compactState');

  if (!state || state.stage === 'idle') {
    box.replaceChildren(
      el(
        'p',
        'hint',
        'No compaction has run in this app session. Compacting reads the recorded history and asks the model for a handoff brief — the raw history is never replaced or deleted.'
      )
    );
  } else {
    const parts: HTMLElement[] = [stageChips(state)];
    // A history too large for one request is compacted in passes, each carrying the
    // brief so far. Showing which pass is running is the difference between "this is
    // taking a while" and "this is stuck".
    if (state.step) parts.push(el('p', 'hint is-step', state.step));
    const facts = el('p', 'hint');
    const bits = [state.model || 'model not chosen yet'];
    if (state.received > 0) bits.push(`${compactNumber(state.received)} characters received`);
    if (state.startedAt !== null) {
      const end = state.finishedAt ?? Date.now();
      bits.push(`${Math.max(0, Math.round((end - state.startedAt) / 1000))}s`);
    }
    facts.textContent = bits.join(' · ');
    parts.push(facts);

    if (state.error) parts.push(el('p', 'errbox', state.error));
    if (state.reasoning && deps.state()?.config.compaction.showReasoning) {
      parts.push(el('h4', '', 'Model reasoning'));
      parts.push(el('pre', 'pre is-quiet', state.reasoning.slice(-2000)));
    }
    if (state.preview && state.stage !== 'ready') {
      parts.push(el('h4', '', 'Brief so far'));
      parts.push(el('pre', 'pre', state.preview));
    }
    box.replaceChildren(...parts);
  }

  const hand = $('handoffBox');
  if (handoff) {
    const parts: HTMLElement[] = [];
    const head = el('p', 'hint');
    head.textContent = `${handoff.model} · ${compactNumber(handoff.text.length)} characters · from ${handoff.sourceEvents} events (~${compactNumber(handoff.sourceTokens)} tokens) · ${ago(handoff.createdAt)}`;
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

  paintButtons();
}

function paintButtons(): void {
  const state = deps.state();
  const running =
    compaction !== null && compaction.stage !== 'idle' && compaction.stage !== 'ready' && compaction.stage !== 'error';
  const compactBtn = $<HTMLButtonElement>('compactBtn');
  const resumeBtn = $<HTMLButtonElement>('resumeBtn');
  const cancelBtn = $<HTMLButtonElement>('cancelCompact');

  const hasKey = state?.hasOpenRouterKey === true;
  const paired = state?.bridge.paired === true;
  const blocked = selectedId === null || running || !hasKey;

  compactBtn.disabled = blocked;
  compactBtn.title = !hasKey
    ? 'Add an OpenRouter API key in Settings first.'
    : selectedId === null
      ? 'Select a session first.'
      : '';

  resumeBtn.disabled = blocked || !paired;
  resumeBtn.title = !paired
    ? 'Pair the Chrome extension first — it is what opens the fresh chat.'
    : compactBtn.title;

  cancelBtn.hidden = !running;
}

// ----------------------------------------------------------------- settings

function priceLabel(model: OpenRouterModel): string {
  if (model.promptPrice === null) return 'price unknown';
  const perMillion = model.promptPrice * 1_000_000;
  return `$${perMillion < 1 ? perMillion.toFixed(3) : perMillion.toFixed(2)}/M in`;
}

function modelRow(model: OpenRouterModel, chosen: string): HTMLElement {
  const row = el('div', 'model');
  row.dataset.model = model.id;
  if (model.id === chosen) row.classList.add('is-sel');
  const top = el('div', 'model-top');
  top.append(el('b', '', model.name));
  if (model.reasoningLevels.length > 0) {
    top.append(el('span', 'chip', `reasoning: ${model.reasoningLevels.join('/')}`));
  }
  const sub = el('div', 'model-sub');
  sub.textContent = `${model.id} · ${model.contextLength ? `${compactNumber(model.contextLength)} ctx` : 'context unknown'} · ${priceLabel(model)}`;
  sub.title = model.id;
  row.append(top, sub);
  return row;
}

async function loadModels(refresh = false): Promise<void> {
  const query = $<HTMLInputElement>('modelSearch').value.trim();
  const page = await run(
    api.listModels({ refresh, offset: modelOffset, limit: MODEL_PAGE, query })
  );
  if (!page) return;
  modelTotal = page.total;
  modelOffset = page.offset;
  for (const model of page.models) modelIndex.set(model.id, model);
  const chosen = $<HTMLInputElement>('compactModel').value;
  $('modelList').replaceChildren(...page.models.map((model) => modelRow(model, chosen)));
  $('modelPage').textContent =
    modelTotal === 0
      ? 'No models matched'
      : `${modelOffset + 1}–${Math.min(modelOffset + MODEL_PAGE, modelTotal)} of ${modelTotal}`;
  $<HTMLButtonElement>('modelPrev').disabled = modelOffset === 0;
  $<HTMLButtonElement>('modelNext').disabled = modelOffset + MODEL_PAGE >= modelTotal;
  paintReasoningHint();
}

/**
 * Offers exactly the reasoning efforts the chosen model advertises.
 *
 * Not cosmetic: an effort a model does not accept is a provider error mid-compaction,
 * not a setting that gets quietly ignored. So an unsupported option is disabled here and
 * omitted from the request in openrouter.ts, and if the current choice is one of them
 * the select falls back to something the model will actually take.
 */
function paintReasoningHint(): void {
  const chosen = $<HTMLInputElement>('compactModel').value;
  const known = modelIndex.get(chosen) ?? null;
  const select = $<HTMLSelectElement>('compactReasoning');
  // Unknown model: leave everything selectable rather than guessing it supports nothing.
  const levels: readonly string[] | null = known ? known.reasoningLevels : null;
  for (const option of select.options) {
    option.disabled = option.value !== 'off' && levels !== null && !levels.includes(option.value);
  }
  if (select.selectedOptions[0]?.disabled) select.value = levels && levels.length > 0 ? levels[0]! : 'off';

  $('reasoningHint').textContent =
    chosen === ''
      ? 'No model chosen yet. The first compaction resolves a sensible default from the live catalogue.'
      : known === null
        ? 'Load the model list to see which reasoning efforts this model accepts.'
        : levels && levels.length > 0
          ? `This model accepts ${levels.join(', ')}. Anything else is left out of the request rather than sent and rejected.`
          : 'This model takes no reasoning parameter, so none is sent.';
}

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
  const list = $('swarmList');
  if (state.agents.length === 0) {
    list.replaceChildren(el('p', 'hint', 'No agents. The prime agent creates workers with the create_agents tool.'));
  } else {
    list.replaceChildren(
      ...state.agents.map((agent) => {
        const row = el('div', 'agent');
        const top = el('div', 'model-top');
        top.append(el('b', '', agent.label || agent.id));
        top.append(el('span', 'chip', agent.role));
        top.append(el('span', `chip is-${agent.state}`, agent.state));
        const sub = el('div', 'model-sub');
        const bits = [`${agent.pending} pending`, `${agent.delivered} delivered`];
        if (agent.conversationId) bits.push('chat bound');
        if (agent.claims.length > 0) bits.push(`${agent.claims.length} claimed path(s)`);
        sub.textContent = bits.join(' · ');
        row.append(top, sub);
        if (agent.task) row.append(el('p', 'hint', agent.task));
        return row;
      })
    );
  }
  $<HTMLButtonElement>('swarmReset').disabled = !state.running;
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
      model: $<HTMLInputElement>('compactModel').value.trim(),
      reasoning: $<HTMLSelectElement>('compactReasoning').value as Config['compaction']['reasoning'],
      showReasoning: $<HTMLInputElement>('compactShowReasoning').checked
    },
    multiAgent: {
      enabled: $<HTMLInputElement>('maEnabled').checked,
      maxWorkers: number('maWorkers', current.multiAgent.maxWorkers, 1, 8)
    }
  };
}

/** Writes app state into this panel's controls. Called from the renderer's apply(). */
export function chatApply(state: AppState): void {
  const { config, bridge } = state;

  $<HTMLInputElement>('sessRecord').checked = config.sessions.record;
  $<HTMLInputElement>('sessRetain').value = String(config.sessions.retainDays);
  $<HTMLInputElement>('sessAdvisory').value = String(config.sessions.advisoryTokens);
  $<HTMLInputElement>('sessLimit').value = String(config.sessions.limitTokens);

  $<HTMLInputElement>('compactModel').value = config.compaction.model;
  $<HTMLSelectElement>('compactReasoning').value = config.compaction.reasoning;
  $<HTMLInputElement>('compactShowReasoning').checked = config.compaction.showReasoning;

  $<HTMLInputElement>('maEnabled').checked = config.multiAgent.enabled;
  $<HTMLInputElement>('maWorkers').value = String(config.multiAgent.maxWorkers);

  $<HTMLInputElement>('orKey').placeholder = state.hasOpenRouterKey ? '•••••••• stored' : 'sk-or-…';
  $('orKeyState').textContent = state.hasOpenRouterKey
    ? 'A key is stored, encrypted by Windows. Type a new one to replace it.'
    : 'Stored encrypted by Windows. It never reaches this window, the browser extension or the log.';
  $<HTMLButtonElement>('orRemove').disabled = !state.hasOpenRouterKey;

  // Extension bridge.
  const code = bridge.pairingCode;
  $('pairCode').textContent = code ?? '';
  $('pairCodeBox').hidden = code === null;
  $<HTMLButtonElement>('bridgePair').hidden = code !== null;
  $<HTMLButtonElement>('bridgeCancel').hidden = code === null;
  $<HTMLButtonElement>('bridgeUnpair').disabled = !bridge.paired;
  $('bridgeState').textContent = !bridge.running
    ? 'The local bridge is off. Turn recording or multi-agent mode on to start it.'
    : bridge.paired
      ? `Paired. Listening on 127.0.0.1:${bridge.port ?? '?'} · last message ${ago(bridge.lastSeenAt)}.`
      : `Listening on 127.0.0.1:${bridge.port ?? '?'} · no extension paired yet.`;
  $('bridgeState').classList.toggle('is-warn', bridge.running && !bridge.paired);
  void showExtensionPath();

  paintReasoningHint();
  paintButtons();
  if (sessions.length > 0) paintSessions();
}

/** Called when the Chat tab becomes visible or is left, so it only polls when shown. */
export function chatVisible(next: boolean): void {
  visible = next;
  if (next) void refreshAll();
}

async function refreshAll(): Promise<void> {
  await loadSessions();
  const state = await run(api.getCompaction());
  if (state) {
    compaction = state;
    paintCompaction();
  }
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

function showView(name: string): void {
  for (const button of $('chatView').querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.classList.toggle('is-sel', button.dataset.view === name);
  }
  for (const view of document.querySelectorAll<HTMLElement>('#chatBody > .view')) {
    view.hidden = view.dataset.view !== name;
  }
  if (name === 'settings' && modelTotal === 0) void loadModels();
}

async function startCompaction(resume: boolean): Promise<void> {
  if (selectedId === null) return;
  const result = await run(api.compact(selectedId, resume));
  if (!result) return;
  handoffFor = null;
  toast(resume ? 'Handoff saved. Opening a fresh chat…' : 'Handoff saved');
  await loadSessions();
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
    if (button?.dataset.view) showView(button.dataset.view);
  });

  $('agentFilter').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-agent]');
    if (!button) return;
    agentFilter = button.dataset.agent === '' ? null : (button.dataset.agent ?? null);
    paintDetail();
  });

  $('chatRefresh').addEventListener('click', () => void refreshAll());
  $('compactBtn').addEventListener('click', () => void startCompaction(false));
  $('resumeBtn').addEventListener('click', () => void startCompaction(true));
  $('cancelCompact').addEventListener('click', () => void run(api.cancelCompaction()));

  $('copyHandoff').addEventListener('click', async () => {
    if (!handoff) return;
    await navigator.clipboard.writeText(handoff.text);
    toast('Handoff copied');
  });

  $('orKey').addEventListener('blur', async () => {
    const input = $<HTMLInputElement>('orKey');
    if (input.value === '') return;
    const state = await run(api.setOpenRouterKey(input.value));
    input.value = '';
    if (state) {
      toast('OpenRouter key stored');
      modelIndex.clear();
      modelOffset = 0;
      void loadModels(true);
    }
  });

  $('orRemove').addEventListener('click', async () => {
    const state = await run(api.setOpenRouterKey(''));
    if (state) toast('OpenRouter key removed');
  });

  $('modelRefresh').addEventListener('click', () => {
    modelOffset = 0;
    void loadModels(true);
  });
  $('modelPrev').addEventListener('click', () => {
    modelOffset = Math.max(0, modelOffset - MODEL_PAGE);
    void loadModels();
  });
  $('modelNext').addEventListener('click', () => {
    modelOffset += MODEL_PAGE;
    void loadModels();
  });
  let searchTimer: number | undefined;
  $('modelSearch').addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      modelOffset = 0;
      void loadModels();
    }, 250);
  });
  $('modelList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-model]');
    if (!row?.dataset.model) return;
    $<HTMLInputElement>('compactModel').value = row.dataset.model;
    for (const other of $('modelList').querySelectorAll('[data-model]')) {
      other.classList.toggle('is-sel', other === row);
    }
    paintReasoningHint();
    void deps.save();
  });

  $('swarmReset').addEventListener('click', async () => {
    const state = await run(api.resetSwarm());
    if (state) {
      paintSwarm(state);
      toast('Swarm cleared');
    }
  });

  for (const id of [
    'sessRecord',
    'sessRetain',
    'sessAdvisory',
    'sessLimit',
    'compactReasoning',
    'compactShowReasoning',
    'maEnabled',
    'maWorkers'
  ]) {
    $(id).addEventListener('change', () => void deps.save());
  }

  $('bridgePair').addEventListener('click', () => void run(api.pairExtension()));
  $('bridgeCancel').addEventListener('click', () => void run(api.cancelPairing()));
  $('bridgeUnpair').addEventListener('click', async () => {
    const state = await run(api.unpairExtension());
    if (state) toast('Extension unpaired');
  });
  $('bridgeFolder').addEventListener('click', async () => {
    const dir = await run(api.openExtensionFolder());
    if (dir) toast('Extension folder opened');
  });

  api.onSessionChanged(scheduleReload);
  api.onCompactionChanged((state) => {
    compaction = state;
    if (state.stage === 'ready') handoffFor = null;
    paintCompaction();
    if (state.stage === 'ready') void loadSessions();
  });
  api.onSwarmChanged(paintSwarm);
}
