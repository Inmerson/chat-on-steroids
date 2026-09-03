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

  $('controlSummary').replaceChildren(
    addSummary('Run', metrics.health, metrics.health === 'blocked' || metrics.health === 'failed' ? 'is-bad' : metrics.health === 'verified' ? 'is-good' : ''),
    addSummary('Verified', `${metrics.verified} / ${metrics.total}`),
    addSummary('Active agents', String(metrics.activeAgents)),
    addSummary('Blockers', String(metrics.blockers), metrics.blockers ? 'is-bad' : ''),
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
  nodes.replaceChildren(
    ...Object.entries(layout.agents).map(([id, point]) => nodeButton('agent', byAgent.get(id), point, layout)),
    ...Object.entries(layout.tasks).map(([id, point]) => nodeButton('task', byTask.get(id), point, layout))
  );
  renderEdges(status, layout);

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
  selected = { kind, id };
  for (const button of document.querySelectorAll<HTMLButtonElement>('.control-node')) {
    const isSelected = button.dataset.nodeKind === kind && button.dataset.nodeId === id;
    button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  }
  renderInspector();
}

function paint(status: ControlCenterStatus): void {
  lastStatus = status;
  renderSummary(status);
  renderGraph(status);
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
