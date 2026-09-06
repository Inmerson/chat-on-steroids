/**
 * The workspace joins recorded chat context with the existing read-only Agent
 * Control Center. It owns presentation navigation only; session selection and
 * orchestration authority remain in their current modules.
 */
export function initWorkspaceShell(
  root: ParentNode,
  actions: { openControl: () => void; getStatus: () => Promise<unknown | null> }
): void {
  const openControl = root.querySelector<HTMLButtonElement>('#workspaceOpenControl');
  openControl?.addEventListener('click', actions.openControl);
  refresh = async () => renderWorkspacePulse(root, await actions.getStatus());
}

export interface WorkspacePulseMetrics {
  label: string;
  detail: string;
  tone: 'is-good' | 'is-active' | 'is-bad' | '';
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function numberAt(value: unknown, key: string): number {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : null;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
}

/** A compact, read-only projection of authoritative Control Center state. */
export function workspacePulseMetrics(status: unknown): WorkspacePulseMetrics {
  const source = status && typeof status === 'object' ? status as Record<string, unknown> : {};
  const run = source.run && typeof source.run === 'object' ? source.run as Record<string, unknown> : null;
  const progress = run?.progress && typeof run.progress === 'object' ? run.progress as Record<string, unknown> : {};
  const blockers = count(source.blockers);
  const attention = count(source.needsAttention);
  const verified = numberAt(progress, 'verified');
  const total = numberAt(progress, 'total');
  const health = typeof run?.health === 'string' ? run.health : 'idle';
  const agents = numberAt(run, 'activeAgents');
  const progressText = total ? `${verified} of ${total} tasks verified` : 'No managed run';
  if (blockers || attention || health === 'blocked' || health === 'failed') {
    return { label: 'Needs attention', detail: `${blockers} blocker${blockers === 1 ? '' : 's'} · ${attention} needs you`, tone: 'is-bad' };
  }
  if (health === 'verified') return { label: 'Run verified', detail: progressText, tone: 'is-good' };
  if (health === 'running') return { label: `${agents} agent${agents === 1 ? '' : 's'} active`, detail: progressText, tone: 'is-active' };
  return { label: 'No active run', detail: 'Session history is ready when you are.', tone: '' };
}

/** Renders text only; detailed state remains in Control Center. */
export function renderWorkspacePulse(root: ParentNode, status: unknown): void {
  const metrics = workspacePulseMetrics(status);
  const label = root.querySelector<HTMLElement>('#workspacePulse');
  const detail = root.querySelector<HTMLElement>('#workspacePulseDetail');
  if (label) { label.textContent = metrics.label; label.className = `workspace-pulse-label ${metrics.tone}`; }
  if (detail) detail.textContent = metrics.detail;
}

let refresh: (() => Promise<void>) | null = null;
let polling: number | null = null;

export function workspaceVisible(nextVisible: boolean): void {
  if (polling !== null) { window.clearInterval(polling); polling = null; }
  if (!nextVisible || !refresh) return;
  void refresh();
  polling = window.setInterval(() => void refresh?.(), 5_000);
}
