import type { AppApi } from '../preload/index.js';
import type { ControlCenterStatus } from '../shared/control-center.js';
import { $, el, run } from './dom.js';

interface Point {
  x: number;
  y: number;
}

export interface ControlCenterLayout {
  width: number;
  height: number;
  agents: Record<string, Point>;
  tasks: Record<string, Point>;
  taskDepths: Record<string, number>;
}

const TASK_COLUMN_COUNT = 2;
const TASK_COLUMN_START_X = 250;
const TASK_COLUMN_STEP_X = 220;
const TASK_ROW_STEP_Y = 96;
const TASK_GROUP_GAP_Y = 28;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? (value as UnknownRecord) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function idOf(value: unknown): string {
  const item = record(value);
  return stringValue(item.id) ?? stringValue(item.taskId) ?? stringValue(item.agentId) ?? '';
}

function dependenciesOf(value: unknown): string[] {
  const raw = record(value).dependencies;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Pure layout seam. Inputs are sorted by durable identity before placement so a projector
 * changing array order cannot make the canvas jump between otherwise identical refreshes.
 */
export function computeControlCenterLayout(input: {
  agents: readonly unknown[];
  tasks: readonly unknown[];
}): ControlCenterLayout {
  const agents = [...input.agents].filter((item) => idOf(item)).sort((a, b) => idOf(a).localeCompare(idOf(b)));
  const tasks = [...input.tasks].filter((item) => idOf(item)).sort((a, b) => idOf(a).localeCompare(idOf(b)));
  const taskIds = new Set(tasks.map(idOf));
  const depths = new Map<string, number>();

  // Repeated relaxation is deliberately bounded. A valid DAG settles before taskCount passes;
  // anything still unresolved is a malformed/cyclic dependency and stays in depth 0 rather
  // than growing forever or making the renderer invent an ordering the source did not prove.
  for (let pass = 0; pass < tasks.length; pass += 1) {
    let changed = false;
    for (const task of tasks) {
      const id = idOf(task);
      const deps = dependenciesOf(task).filter((dep) => taskIds.has(dep));
      if (deps.length === 0) {
        if (!depths.has(id)) {
          depths.set(id, 0);
          changed = true;
        }
        continue;
      }
      if (!deps.every((dep) => depths.has(dep))) continue;
      const next = 1 + Math.max(...deps.map((dep) => depths.get(dep) ?? 0));
      if (depths.get(id) !== next) {
        depths.set(id, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const task of tasks) if (!depths.has(idOf(task))) depths.set(idOf(task), 0);

  const taskDepths = Object.fromEntries([...depths].sort(([a], [b]) => a.localeCompare(b)));
  const maxDepth = Math.max(0, ...Object.values(taskDepths));
  const visibleTaskColumns = Math.min(TASK_COLUMN_COUNT, maxDepth + 1);
  const positions: ControlCenterLayout = {
    width: TASK_COLUMN_START_X + visibleTaskColumns * TASK_COLUMN_STEP_X,
    height: 140,
    agents: {},
    tasks: {},
    taskDepths
  };

  agents.forEach((agent, index) => {
    positions.agents[idOf(agent)] = { x: 24, y: 26 + index * 84 };
  });

  const depthCounts = new Map<number, number>();
  for (const task of tasks) {
    const depth = taskDepths[idOf(task)] ?? 0;
    depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);
  }

  const groupOffsets = new Map<number, number>();
  let taskSpan = 0;
  const lastGroup = Math.floor(maxDepth / TASK_COLUMN_COUNT);
  for (let group = 0; group <= lastGroup; group += 1) {
    groupOffsets.set(group, taskSpan);
    const firstDepth = group * TASK_COLUMN_COUNT;
    const rows = Math.max(
      1,
      ...Array.from({ length: TASK_COLUMN_COUNT }, (_, column) => depthCounts.get(firstDepth + column) ?? 0)
    );
    taskSpan += rows * TASK_ROW_STEP_Y;
    if (group < lastGroup) taskSpan += TASK_GROUP_GAP_Y;
  }

  const bandCounts = new Map<number, number>();
  for (const task of tasks) {
    const id = idOf(task);
    const depth = taskDepths[id] ?? 0;
    const row = bandCounts.get(depth) ?? 0;
    bandCounts.set(depth, row + 1);
    const group = Math.floor(depth / TASK_COLUMN_COUNT);
    const column = depth % TASK_COLUMN_COUNT;
    positions.tasks[id] = {
      x: TASK_COLUMN_START_X + column * TASK_COLUMN_STEP_X,
      y: 26 + (groupOffsets.get(group) ?? 0) + row * TASK_ROW_STEP_Y
    };
  }

  positions.height = Math.max(140, 52 + agents.length * 84, 52 + taskSpan);
  return positions;
}

export interface ControlCenterGenerationGate {
  next(): number;
  isCurrent(generation: number): boolean;
}

/** The request generation is the identity crossing the async renderer boundary. */
export function createControlCenterGenerationGate(): ControlCenterGenerationGate {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (generation) => generation === current
  };
}

const gate = createControlCenterGenerationGate();
const POLL_MS = 5_000;
let api: AppApi | null = null;
let visible = false;
let poll: number | null = null;
let selected: { kind: 'agent' | 'task'; id: string } | null = null;
let activeFilter: ControlCenterFilter | null = null;
let searchQuery = '';
let lastStatus: ControlCenterStatus | null = null;

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function addSummary(label: string, value: string, tone = '', title = ''): HTMLElement {
  const item = el('div', `control-summary-item${tone ? ` ${tone}` : ''}`);
  if (title) item.title = title;
  item.append(el('span', '', label), el('b', '', value));
  return item;
}

function addSummaryAction(
  label: string,
  value: string,
  filter: ControlCenterFilter,
  tone = '',
  title = '',
  enabled = true
): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `control-summary-item control-summary-action${tone ? ` ${tone}` : ''}`;
  item.dataset.controlFilter = filter;
  item.setAttribute('aria-pressed', activeFilter === filter ? 'true' : 'false');
  item.disabled = !enabled;
  if (title) item.title = title;
  item.append(el('span', '', label), el('b', '', value));
  item.addEventListener('click', () => activateFilter(filter));
  return item;
}

export interface ControlCenterRunMetrics {
  health: string;
  verified: number;
  total: number;
  activeAgents: number;
  blockers: number;
  attention: number;
  browser: string;
  browserNote: string;
}

export function controlCenterRunMetrics(status: unknown): ControlCenterRunMetrics {
  const statusRecord = record(status);
  const runState = record(statusRecord.run);
  const progress = record(runState.progress);
  const tasks = Array.isArray(statusRecord.tasks) ? statusRecord.tasks : [];
  const agents = Array.isArray(statusRecord.agents) ? statusRecord.agents : [];
  const blockers = Array.isArray(statusRecord.blockers) ? statusRecord.blockers : [];
  const attention = Array.isArray(statusRecord.needsAttention) ? statusRecord.needsAttention : [];
  const browser = record(statusRecord.browser);
  const verified = numberValue(progress.verified) ?? numberValue(runState.verifiedTasks) ?? numberValue(runState.verified) ?? 0;
  const total = numberValue(progress.total) ?? numberValue(runState.totalTasks) ?? numberValue(runState.total) ?? tasks.length;
  const health = stringValue(runState.health) ?? (statusRecord.run ? 'active' : 'idle');
  const activeAgents = numberValue(runState.activeAgents) ?? agents.filter((agent) => {
    const state = stringValue(record(agent).state) ?? stringValue(record(agent).liveness);
    return state === 'working' || state === 'active' || state === 'joined' || state === 'running';
  }).length;
  const budget = numberValue(browser.budget) ?? 5;
  const used = numberValue(browser.used);

  return {
    health,
    verified,
    total,
    activeAgents,
    blockers: blockers.length,
    attention: attention.length,
    browser: `${used === null ? '—' : used} / ${budget}`,
    browserNote: stringValue(browser.note) ?? ''
  };
}

function renderSummary(status: ControlCenterStatus): void {
  const metrics = controlCenterRunMetrics(status);
  const blockedTaskCount = controlCenterFilterTaskIds(status, 'blocked').length;

  $('controlSummary').replaceChildren(
    addSummary('Run', metrics.health, metrics.health === 'blocked' || metrics.health === 'failed' ? 'is-bad' : metrics.health === 'verified' ? 'is-good' : ''),
    addSummary('Verified', `${metrics.verified} / ${metrics.total}`),
    addSummary('Active agents', String(metrics.activeAgents)),
    addSummaryAction(
      'Blockers',
      String(metrics.blockers),
      'blocked',
      metrics.blockers ? 'is-bad' : '',
      metrics.blockers > 0 && blockedTaskCount === 0 ? 'The current blocker is global and has no task node to focus.' : '',
      blockedTaskCount > 0
    ),
    addSummary('Needs you', String(metrics.attention), metrics.attention ? 'is-bad' : ''),
    addSummary('Browser agents', metrics.browser, '', metrics.browserNote)
  );
}

export function controlCenterNodeTone(state: string | null): string {
  const normalized = state?.toLowerCase() ?? null;
  if (normalized === 'verified' || normalized === 'finished' || normalized === 'passed' || normalized === 'complete') return ' is-good';
  if (normalized === 'blocked' || normalized === 'failed' || normalized === 'error') return ' is-bad';
  if (
    normalized === 'active' ||
    normalized === 'working' ||
    normalized === 'running' ||
    normalized === 'review' ||
    normalized === 'reviewing'
  ) return ' is-active';
  return '';
}

function roleText(value: unknown): string {
  const roles = textList(record(value).roles ?? record(value).roleTags);
  return roles.length ? roles.join(' · ') : 'Agent';
}

function nodeButton(kind: 'agent' | 'task', value: unknown, point: Point, layout: ControlCenterLayout): HTMLButtonElement {
  const item = record(value);
  const id = idOf(value);
  const state = stringValue(item.state) ?? stringValue(item.liveness) ?? 'unknown';
  const title = kind === 'agent'
    ? stringValue(item.label) ?? id
    : stringValue(item.title) ?? stringValue(item.name) ?? id;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `control-node control-${kind}${controlCenterNodeTone(state)}`;
  button.dataset.nodeKind = kind;
  button.dataset.nodeId = id;
  button.setAttribute('aria-label', `${kind === 'agent' ? 'Agent' : 'Task'} ${title}, ${state}`);
  button.setAttribute('aria-pressed', selected?.kind === kind && selected.id === id ? 'true' : 'false');
  const maxLeft = kind === 'agent' ? '24px' : `calc(100% - ${kind === 'task' ? '182px' : '164px'})`;
  const percent = Math.max(0, Math.min(100, (point.x / layout.width) * 100));
  button.style.left = kind === 'agent' ? '24px' : `clamp(210px, ${percent.toFixed(3)}%, ${maxLeft})`;
  button.style.top = `${point.y}px`;
  button.append(
    el('span', 'control-node-kicker', kind === 'agent' ? roleText(item) : state),
    el('strong', '', title),
    el('span', 'control-node-meta', kind === 'agent' ? state : controlCenterTaskMeta(item))
  );
  button.addEventListener('click', () => selectNode(kind, id));
  return button;
}

export function controlCenterTaskMeta(value: unknown): string {
  const task = record(value);
  const risk = stringValue(task.riskClass) ?? stringValue(task.risk);
  const owner =
    stringValue(task.assignedWorkerId) ??
    stringValue(task.assignedWorker) ??
    stringValue(task.workerId) ??
    stringValue(task.owner);
  const verification = stringValue(record(task.verification).status);
  return [risk ? `${risk} risk` : null, owner, verification].filter(Boolean).join(' · ') || 'unassigned';
}

function edgeType(edge: UnknownRecord): string {
  return stringValue(edge.type) ?? stringValue(edge.kind) ?? 'dependency';
}

export function controlCenterEdgeEndpoints(value: unknown): [string, string] | null {
  const edge = record(value);
  const kind = stringValue(edge.kind) ?? stringValue(edge.type);
  if (kind === 'dependency') {
    const fromTaskId = stringValue(edge.fromTaskId);
    const toTaskId = stringValue(edge.toTaskId);
    if (fromTaskId && toTaskId) return [fromTaskId, toTaskId];
  }
  if (kind === 'assignment' || kind === 'review') {
    const agentId = stringValue(edge.agentId);
    const taskId = stringValue(edge.taskId);
    if (agentId && taskId) return [agentId, taskId];
  }
  const from = stringValue(edge.from) ?? stringValue(edge.source) ?? stringValue(edge.fromId);
  const to = stringValue(edge.to) ?? stringValue(edge.target) ?? stringValue(edge.toId);
  return from && to ? [from, to] : null;
}

export interface ControlCenterSelection {
  kind: 'agent' | 'task';
  id: string;
}

export type ControlCenterFilter = 'verified' | 'active' | 'blocked' | 'neutral';

export function nextControlCenterSelection(
  current: ControlCenterSelection | null,
  activated: ControlCenterSelection
): ControlCenterSelection | null {
  return current?.kind === activated.kind && current.id === activated.id ? null : activated;
}

export function nextControlCenterFilter(
  current: ControlCenterFilter | null,
  activated: ControlCenterFilter
): ControlCenterFilter | null {
  return current === activated ? null : activated;
}

function normalizedSearchQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function controlCenterSearchFields(kind: 'agent' | 'task', value: unknown): string[] {
  const item = record(value);
  return (kind === 'agent'
    ? [idOf(value), stringValue(item.label)]
    : [idOf(value), stringValue(item.title) ?? stringValue(item.name)])
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.toLocaleLowerCase());
}

export function controlCenterSearchMatches(status: unknown, query: string): ControlCenterSelection[] {
  const needle = normalizedSearchQuery(query);
  if (!needle) return [];
  const statusRecord = record(status);
  const candidates: Array<{ selection: ControlCenterSelection; score: number }> = [];
  for (const kind of ['agent', 'task'] as const) {
    const list = kind === 'agent' ? statusRecord.agents : statusRecord.tasks;
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const id = idOf(value);
      if (!id) continue;
      const fields = controlCenterSearchFields(kind, value);
      if (!fields.some((field) => field.includes(needle))) continue;
      const score = fields.some((field) => field === needle)
        ? 0
        : fields.some((field) => field.startsWith(needle))
          ? 1
          : 2;
      candidates.push({ selection: { kind, id }, score });
    }
  }
  return candidates
    .sort((a, b) => a.score - b.score || a.selection.id.localeCompare(b.selection.id) || a.selection.kind.localeCompare(b.selection.kind))
    .map(({ selection }) => selection);
}

export function controlCenterSearchNodeIds(status: unknown, query: string): string[] {
  const matchIds = new Set(controlCenterSearchMatches(status, query).map((match) => match.id));
  const ids = new Set(matchIds);
  const edges = Array.isArray(record(status).edges) ? (record(status).edges as unknown[]) : [];
  for (const edge of edges) {
    const endpoints = controlCenterEdgeEndpoints(edge);
    if (!endpoints) continue;
    const [fromId, toId] = endpoints;
    if (matchIds.has(fromId) || matchIds.has(toId)) {
      ids.add(fromId);
      ids.add(toId);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function controlCenterTaskFilter(value: unknown): ControlCenterFilter {
  const task = record(value);
  if (textList(task.blockers).length > 0) return 'blocked';
  const tone = controlCenterNodeTone(stringValue(task.state));
  if (tone.includes('is-good')) return 'verified';
  if (tone.includes('is-bad')) return 'blocked';
  if (tone.includes('is-active')) return 'active';
  return 'neutral';
}

export function controlCenterFilterTaskIds(status: unknown, filter: ControlCenterFilter): string[] {
  const tasks = Array.isArray(record(status).tasks) ? (record(status).tasks as unknown[]) : [];
  return tasks
    .filter((task) => idOf(task) && controlCenterTaskFilter(task) === filter)
    .map(idOf)
    .sort((a, b) => a.localeCompare(b));
}

export function controlCenterFilterNodeIds(status: unknown, filter: ControlCenterFilter): string[] {
  const taskIds = new Set(controlCenterFilterTaskIds(status, filter));
  const ids = new Set(taskIds);
  const edges = Array.isArray(record(status).edges) ? (record(status).edges as unknown[]) : [];
  for (const edge of edges) {
    const endpoints = controlCenterEdgeEndpoints(edge);
    if (!endpoints) continue;
    const [fromId, toId] = endpoints;
    if (taskIds.has(fromId) || taskIds.has(toId)) {
      ids.add(fromId);
      ids.add(toId);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** One-hop graph focus: the selected node plus only nodes joined to it by a rendered edge. */
export function controlCenterConnectedNodeIds(status: unknown, selection: ControlCenterSelection | null): string[] {
  if (!selection) return [];
  const ids = new Set<string>([selection.id]);
  const edges = Array.isArray(record(status).edges) ? (record(status).edges as unknown[]) : [];
  for (const edge of edges) {
    const endpoints = controlCenterEdgeEndpoints(edge);
    if (!endpoints) continue;
    const [fromId, toId] = endpoints;
    if (fromId === selection.id || toId === selection.id) {
      ids.add(fromId);
      ids.add(toId);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function applyControlCenterGraphFocus(
  root: ParentNode,
  status: unknown,
  selection: ControlCenterSelection | null
): void {
  const focusedIds = new Set(controlCenterConnectedNodeIds(status, selection));
  const focusActive = focusedIds.size > 0;
  for (const button of root.querySelectorAll<HTMLButtonElement>('.control-node')) {
    const id = button.dataset.nodeId ?? '';
    const isSelected = Boolean(selection && selection.kind === button.dataset.nodeKind && selection.id === id);
    button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    button.classList.toggle('is-dimmed', focusActive && !focusedIds.has(id));
    button.classList.toggle('is-related', focusActive && focusedIds.has(id) && !isSelected);
  }
  for (const edge of root.querySelectorAll<SVGPathElement>('.control-edge')) {
    const fromId = edge.dataset.fromId ?? '';
    const toId = edge.dataset.toId ?? '';
    const isRelated = Boolean(selection && (fromId === selection.id || toId === selection.id));
    edge.classList.toggle('is-related', focusActive && isRelated);
    edge.classList.toggle('is-dimmed', focusActive && !isRelated);
  }
}

export function applyControlCenterGraphFilter(
  root: ParentNode,
  status: unknown,
  filter: ControlCenterFilter | null
): void {
  const taskIds = filter ? new Set(controlCenterFilterTaskIds(status, filter)) : new Set<string>();
  const focusedIds = filter ? new Set(controlCenterFilterNodeIds(status, filter)) : new Set<string>();
  const filterActive = taskIds.size > 0;
  for (const button of root.querySelectorAll<HTMLButtonElement>('.control-node')) {
    const id = button.dataset.nodeId ?? '';
    button.setAttribute('aria-pressed', 'false');
    button.classList.toggle('is-dimmed', filterActive && !focusedIds.has(id));
    button.classList.toggle('is-related', filterActive && focusedIds.has(id));
  }
  for (const edge of root.querySelectorAll<SVGPathElement>('.control-edge')) {
    const fromId = edge.dataset.fromId ?? '';
    const toId = edge.dataset.toId ?? '';
    const isRelated = taskIds.has(fromId) || taskIds.has(toId);
    edge.classList.toggle('is-related', filterActive && isRelated);
    edge.classList.toggle('is-dimmed', filterActive && !isRelated);
  }
}

export function applyControlCenterGraphSearch(root: ParentNode, status: unknown, query: string): void {
  const needle = normalizedSearchQuery(query);
  const matches = new Set(controlCenterSearchMatches(status, query).map((match) => match.id));
  const focusedIds = new Set(controlCenterSearchNodeIds(status, query));
  const searchActive = needle.length > 0;
  for (const button of root.querySelectorAll<HTMLButtonElement>('.control-node')) {
    const id = button.dataset.nodeId ?? '';
    button.setAttribute('aria-pressed', 'false');
    button.classList.toggle('is-dimmed', searchActive && !focusedIds.has(id));
    button.classList.toggle('is-related', searchActive && focusedIds.has(id));
  }
  for (const edge of root.querySelectorAll<SVGPathElement>('.control-edge')) {
    const fromId = edge.dataset.fromId ?? '';
    const toId = edge.dataset.toId ?? '';
    const isRelated = matches.has(fromId) || matches.has(toId);
    edge.classList.toggle('is-related', searchActive && isRelated);
    edge.classList.toggle('is-dimmed', searchActive && !isRelated);
  }
}

function syncFilterControls(status: ControlCenterStatus): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-control-filter]')) {
    const filter = button.dataset.controlFilter as ControlCenterFilter | undefined;
    if (!filter) continue;
    const count = controlCenterFilterTaskIds(status, filter).length;
    button.setAttribute('aria-pressed', activeFilter === filter ? 'true' : 'false');
    if (button.closest('#controlLegend')) {
      button.disabled = count === 0;
      const counter = button.querySelector<HTMLElement>('.control-filter-count');
      if (counter) counter.textContent = String(count);
    }
  }
}

function renderEdges(status: ControlCenterStatus, layout: ControlCenterLayout): void {
  const svg = document.getElementById('controlEdges') as unknown as SVGSVGElement;
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  const edges = Array.isArray(record(status).edges) ? (record(status).edges as unknown[]) : [];
  for (const raw of edges) {
    const edge = record(raw);
    const ends = controlCenterEdgeEndpoints(edge);
    if (!ends) continue;
    const [fromId, toId] = ends;
    const from = layout.agents[fromId] ?? layout.tasks[fromId];
    const to = layout.tasks[toId] ?? layout.agents[toId];
    if (!from || !to) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const fromX = from.x + (layout.agents[fromId] ? 154 : 176);
    const toX = to.x;
    const fromY = from.y + 34;
    const toY = to.y + 34;
    const bend = Math.max(32, (toX - fromX) / 2);
    path.setAttribute('d', `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`);
    path.setAttribute('class', `control-edge is-${edgeType(edge)}`);
    path.dataset.fromId = fromId;
    path.dataset.toId = toId;
    svg.append(path);
  }
}

function renderGraph(status: ControlCenterStatus): void {
  const statusRecord = record(status);
  const agents = Array.isArray(statusRecord.agents) ? statusRecord.agents : [];
  const tasks = Array.isArray(statusRecord.tasks) ? statusRecord.tasks : [];
  const layout = computeControlCenterLayout({ agents, tasks });
  const nodes = $('controlNodes');
  nodes.style.height = `${layout.height}px`;
  const byAgent = new Map(agents.map((agent) => [idOf(agent), agent]));
  const byTask = new Map(tasks.map((task) => [idOf(task), task]));
  const nodeIds = new Set([...byAgent.keys(), ...byTask.keys()]);
  if (selected && !nodeIds.has(selected.id)) selected = null;
  nodes.replaceChildren(
    ...Object.entries(layout.agents).map(([id, point]) => nodeButton('agent', byAgent.get(id), point, layout)),
    ...Object.entries(layout.tasks).map(([id, point]) => nodeButton('task', byTask.get(id), point, layout))
  );
  renderEdges(status, layout);
  if (selected) applyControlCenterGraphFocus(document, status, selected);
  else if (normalizedSearchQuery(searchQuery)) applyControlCenterGraphSearch(document, status, searchQuery);
  else applyControlCenterGraphFilter(document, status, activeFilter);

  const idle = $('controlEmpty');
  idle.hidden = statusRecord.run !== null && statusRecord.run !== undefined;
  if (!idle.hidden) idle.textContent = 'No Agent System 3.0 run is active. The canvas will populate when orchestration starts.';
  const degraded = $('controlDegraded');
  const unknownAgents = agents.filter((agent) => {
    const state = stringValue(record(agent).state) ?? stringValue(record(agent).liveness);
    return state === 'unknown';
  });
  degraded.hidden = unknownAgents.length === 0;
  degraded.textContent = unknownAgents.length
    ? 'Live broker presence is unavailable for some agents. Durable ownership is shown with unknown liveness.'
    : '';
}

function detailRow(label: string, value: string | null): HTMLElement | null {
  if (!value) return null;
  const row = el('div', 'control-detail-row');
  row.append(el('span', '', label), el('b', '', value));
  return row;
}

function arrayRow(label: string, value: unknown): HTMLElement | null {
  const items = textList(value);
  return items.length ? detailRow(label, items.join(', ')) : null;
}

function inspectAgent(item: UnknownRecord): HTMLElement[] {
  const rows = [
    detailRow('State', stringValue(item.state) ?? stringValue(item.liveness) ?? 'unknown'),
    detailRow('Roles', roleText(item)),
    detailRow('Chat bound', typeof item.chatBound === 'boolean' ? (item.chatBound ? 'yes' : 'no') : null),
    arrayRow('Tasks', item.boundTaskIds ?? item.taskIds),
    arrayRow('Reviews', item.reviewedTaskIds ?? item.reviewTaskIds)
  ];
  const counters = record(item.broker);
  const pending = numberValue(counters.pending);
  const awaitingAck = numberValue(counters.awaitingAck);
  const delivered = numberValue(counters.delivered);
  if ('broker' in item) {
    rows.push(
      detailRow(
        'Broker',
        `${pending ?? '—'} pending · ${awaitingAck ?? '—'} awaiting ack · ${delivered ?? '—'} delivered`
      )
    );
  }
  return rows.filter((row): row is HTMLElement => row !== null);
}

export interface ControlCenterInspectorDetail {
  label: string;
  value: string;
}

function detail(label: string, value: string | null): ControlCenterInspectorDetail | null {
  return value ? { label, value } : null;
}

function arrayDetail(label: string, value: unknown): ControlCenterInspectorDetail | null {
  const items = textList(value);
  return items.length ? detail(label, items.join(', ')) : null;
}

function timestampDetail(label: string, value: unknown): ControlCenterInspectorDetail | null {
  const timestamp = numberValue(value);
  return timestamp === null ? null : detail(label, new Date(timestamp).toISOString());
}

/**
 * A strict display whitelist for task detail. In particular, only the projector's
 * `virtualPath` is ever copied out of worktree metadata; an unexpected `realPath` field is
 * intentionally unreachable from this function and therefore from the inspector DOM.
 */
export function controlCenterTaskInspectorDetails(value: unknown): ControlCenterInspectorDetail[] {
  const item = record(value);
  const worktree = record(item.worktree);
  const verification = record(item.verification);
  const verificationStatus = stringValue(verification.status) ?? 'none';
  const verificationTotal = numberValue(verification.total);
  const verificationPassed = numberValue(verification.passed);
  const verificationFailed = numberValue(verification.failed);
  const verificationText =
    verificationTotal === null
      ? verificationStatus
      : `${verificationStatus} · ${verificationPassed ?? 0}/${verificationTotal} passed${verificationFailed ? ` · ${verificationFailed} failed` : ''}`;
  const details = [
    detail('State', stringValue(item.state) ?? 'unknown'),
    detail('Goal', stringValue(item.goal)),
    detail('Risk', stringValue(item.riskClass) ?? stringValue(item.risk)),
    arrayDetail('Dependencies', item.dependencies),
    detail(
      'Worker',
      stringValue(item.assignedWorkerId) ?? stringValue(item.assignedWorker) ?? stringValue(item.workerId) ?? stringValue(item.owner)
    ),
    detail('Reviewer', stringValue(item.reviewerId) ?? stringValue(item.reviewer)),
    detail('Review round', numberValue(item.reviewRound) === null ? null : String(numberValue(item.reviewRound))),
    detail('Branch', stringValue(worktree.branch) ?? stringValue(item.branch)),
    detail('Worktree', stringValue(worktree.virtualPath) ?? stringValue(item.virtualPath)),
    detail('Verification', verificationText),
    detail('Verification revision', stringValue(verification.revision)),
    timestampDetail('Verification finished', verification.lastFinishedAt),
    detail('Verification error', stringValue(verification.error)),
    arrayDetail('Blockers', item.blockers),
    arrayDetail('Changed files', item.changedFiles),
    timestampDetail('Last activity', item.lastActivityAt)
  ];
  return details.filter((entry): entry is ControlCenterInspectorDetail => entry !== null);
}

function inspectTask(item: UnknownRecord): HTMLElement[] {
  return controlCenterTaskInspectorDetails(item).map(({ label, value }) => detailRow(label, value)!);
}

function renderInspector(): void {
  const title = $('controlInspectorTitle');
  const body = $('controlInspectorBody');
  if (!lastStatus || !selected) {
    title.textContent = 'Inspector';
    body.replaceChildren(el('p', 'empty', 'Select an agent or task to inspect its read-only details.'));
    return;
  }
  const list = selected.kind === 'agent' ? record(lastStatus).agents : record(lastStatus).tasks;
  const raw = Array.isArray(list) ? list.find((entry) => idOf(entry) === selected!.id) : null;
  if (!raw) {
    selected = null;
    renderInspector();
    return;
  }
  const item = record(raw);
  title.textContent = selected.kind === 'agent'
    ? stringValue(item.label) ?? selected.id
    : stringValue(item.title) ?? stringValue(item.name) ?? selected.id;
  body.replaceChildren(...(selected.kind === 'agent' ? inspectAgent(item) : inspectTask(item)));
}

function selectNode(kind: 'agent' | 'task', id: string): void {
  activeFilter = null;
  searchQuery = '';
  const search = document.getElementById('controlSearch') as HTMLInputElement | null;
  if (search) search.value = '';
  selected = nextControlCenterSelection(selected, { kind, id });
  if (lastStatus) {
    applyControlCenterGraphFocus(document, lastStatus, selected);
    syncFilterControls(lastStatus);
  }
  renderInspector();
}

function activateFilter(filter: ControlCenterFilter): void {
  selected = null;
  searchQuery = '';
  const search = document.getElementById('controlSearch') as HTMLInputElement | null;
  if (search) search.value = '';
  activeFilter = nextControlCenterFilter(activeFilter, filter);
  if (lastStatus) {
    applyControlCenterGraphFilter(document, lastStatus, activeFilter);
    syncFilterControls(lastStatus);
  }
  renderInspector();
}

function paint(status: ControlCenterStatus): void {
  lastStatus = status;
  if (activeFilter && controlCenterFilterTaskIds(status, activeFilter).length === 0) activeFilter = null;
  renderSummary(status);
  renderGraph(status);
  syncFilterControls(status);
  renderInspector();
  const observedAt = numberValue(record(status).observedAt);
  $('controlObserved').textContent = observedAt === null ? '' : `Observed ${new Date(observedAt).toLocaleTimeString()}`;
}

async function refreshControlCenter(): Promise<void> {
  if (!api || !visible) return;
  const generation = gate.next();
  const next = await run(api.getControlCenter());
  if (!next || !visible || !gate.isCurrent(generation)) return;
  paint(next);
}

function startPoll(): void {
  if (poll !== null) return;
  poll = window.setInterval(() => void refreshControlCenter(), POLL_MS);
}

function stopPoll(): void {
  if (poll === null) return;
  window.clearInterval(poll);
  poll = null;
}

export function initControlCenter(nextApi: AppApi): void {
  api = nextApi;
  $('controlRefresh').addEventListener('click', () => void refreshControlCenter());
  $('controlSearch').addEventListener('input', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    searchQuery = input.value;
    selected = null;
    activeFilter = null;
    if (lastStatus) {
      applyControlCenterGraphSearch(document, lastStatus, searchQuery);
      syncFilterControls(lastStatus);
    }
    renderInspector();
  });
  $('controlSearch').addEventListener('keydown', (rawEvent) => {
    const event = rawEvent as KeyboardEvent;
    const input = event.currentTarget as HTMLInputElement;
    if (event.key === 'Enter') {
      if (!lastStatus) return;
      const first = controlCenterSearchMatches(lastStatus, input.value)[0];
      if (!first) return;
      event.preventDefault();
      selectNode(first.kind, first.id);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      input.value = '';
      searchQuery = '';
      selected = null;
      activeFilter = null;
      if (lastStatus) {
        applyControlCenterGraphSearch(document, lastStatus, '');
        syncFilterControls(lastStatus);
      }
      renderInspector();
    }
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('#controlLegend [data-control-filter]')) {
    const filter = button.dataset.controlFilter as ControlCenterFilter | undefined;
    if (filter) button.addEventListener('click', () => activateFilter(filter));
  }
  api.onSwarmChanged(() => {
    if (visible) void refreshControlCenter();
  });
  renderInspector();
}

export function controlCenterVisible(nextVisible: boolean): void {
  if (visible === nextVisible) return;
  visible = nextVisible;
  if (visible) {
    startPoll();
    void refreshControlCenter();
  } else {
    stopPoll();
    // Invalidate any request that started while the panel was visible.
    gate.next();
  }
}
