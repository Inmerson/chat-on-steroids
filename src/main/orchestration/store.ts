import { promises as fs } from 'node:fs';
import path from 'node:path';

export type OrchestrationEventType =
  | 'RUN_CREATED'
  | 'RUN_VERIFIED'
  | 'MANAGER_ASSIGNED'
  | 'TASK_CREATED'
  | 'TASK_READY'
  | 'TASK_WORKTREE_INTENT'
  | 'TASK_WORKTREE_READY'
  | 'TASK_WORKTREE_FAILED'
  | 'TASK_ASSIGNMENT_INTENT'
  | 'TASK_ASSIGNMENT_ABORTED'
  | 'TASK_ASSIGNED'
  | 'TASK_ACTIVATED'
  | 'TASK_BLOCKED'
  | 'TASK_REVIEW_READY'
  | 'TASK_REVIEWING'
  | 'TASK_CHANGES_REQUESTED'
  | 'TASK_APPROVED'
  | 'TASK_INTEGRATING'
  | 'TASK_INTEGRATED'
  | 'TASK_VERIFIED'
  | 'TASK_FAILED'
  | 'TASK_CANCELLED'
  | 'TASK_SUPERSEDED';

export interface OrchestrationEvent<Payload extends Record<string, unknown> = Record<string, unknown>> {
  seq: number;
  eventId: string;
  runId: string;
  time: number;
  type: OrchestrationEventType;
  actor: string;
  entityId: string;
  payload: Payload;
}

export type NewOrchestrationEvent<Payload extends Record<string, unknown> = Record<string, unknown>> = Omit<
  OrchestrationEvent<Payload>,
  'seq'
>;

export interface OrchestrationSnapshot<State = unknown> {
  version: 1;
  lastSeq: number;
  state: State;
}

let root = '';
let writes: Promise<void> = Promise.resolve();
let nextSeq: number | null = null;

export function initOrchestrationStore(userDataDir: string): void {
  root = path.join(userDataDir, 'state', 'orchestration');
  writes = Promise.resolve();
  nextSeq = null;
}

function requireRoot(): string {
  if (!root) throw new Error('Orchestration store is not initialized');
  return root;
}

function journalFile(): string {
  return path.join(requireRoot(), 'journal.jsonl');
}

function snapshotFile(): string {
  return path.join(requireRoot(), 'snapshot.json');
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const queued = writes.then(work);
  writes = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface ParsedJournal {
  events: OrchestrationEvent[];
  /** UTF-8 byte length of the last fully terminated record; null when no torn tail exists. */
  repairLength: number | null;
}

function parseJournal(raw: string): ParsedJournal {
  const events: OrchestrationEvent[] = [];
  let previousSeq = 0;
  const hasTornTail = raw.length > 0 && !raw.endsWith('\n');
  const lastNewline = hasTornTail ? raw.lastIndexOf('\n') : raw.length - 1;
  const committedPrefix = hasTornTail ? raw.slice(0, lastNewline + 1) : raw;
  for (const line of committedPrefix.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as OrchestrationEvent;
    if (!Number.isInteger(event.seq) || event.seq <= 0) {
      throw new Error(`Invalid orchestration sequence: ${String(event.seq)}`);
    }
    if (event.seq <= previousSeq) {
      throw new Error(`Orchestration sequence regression: ${previousSeq} -> ${event.seq}`);
    }
    previousSeq = event.seq;
    events.push(event);
  }
  return {
    events,
    repairLength: hasTornTail ? Buffer.byteLength(committedPrefix, 'utf8') : null
  };
}

async function readJournalFromDisk(): Promise<ParsedJournal> {
  const raw = await readText(journalFile());
  return raw === null ? { events: [], repairLength: null } : parseJournal(raw);
}

async function readEventsFromDisk(): Promise<OrchestrationEvent[]> {
  return (await readJournalFromDisk()).events;
}

async function readSnapshotFromDisk<State = unknown>(): Promise<OrchestrationSnapshot<State> | null> {
  const raw = await readText(snapshotFile());
  return raw === null ? null : (JSON.parse(raw) as OrchestrationSnapshot<State>);
}

async function currentSequence(): Promise<number> {
  if (nextSeq !== null) return nextSeq;
  const [journal, snapshot] = await Promise.all([readJournalFromDisk(), readSnapshotFromDisk()]);
  if (journal.repairLength !== null) {
    await fs.truncate(journalFile(), journal.repairLength);
  }
  const lastEvent = journal.events.at(-1);
  const journalSeq = lastEvent?.seq ?? 0;
  nextSeq = Math.max(journalSeq, snapshot?.lastSeq ?? 0);
  return nextSeq;
}

/**
 * Appends one logical orchestration mutation as a contiguous event range through one serialized
 * store operation. Callers must finish all validation before invoking this function: once this
 * append begins, every event in the supplied batch is part of the accepted durable history.
 */
export function appendOrchestrationEvents(
  inputs: readonly NewOrchestrationEvent[]
): Promise<OrchestrationEvent[]> {
  if (inputs.length === 0) return Promise.resolve([]);
  return enqueue(async () => {
    const base = await currentSequence();
    const events = inputs.map((input, index) => ({ ...input, seq: base + index + 1 })) as OrchestrationEvent[];
    await fs.mkdir(requireRoot(), { recursive: true });
    await fs.appendFile(journalFile(), events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
    nextSeq = events.at(-1)?.seq ?? base;
    return events;
  });
}

export function appendOrchestrationEvent<Payload extends Record<string, unknown>>(
  input: NewOrchestrationEvent<Payload>
): Promise<OrchestrationEvent<Payload>> {
  return appendOrchestrationEvents([input as NewOrchestrationEvent]).then((events) => {
    const event = events[0];
    if (!event) throw new Error('Orchestration append returned no event');
    return event as OrchestrationEvent<Payload>;
  });
}

export async function readOrchestrationEvents(afterSeq = 0): Promise<OrchestrationEvent[]> {
  await writes;
  return (await readEventsFromDisk()).filter((event) => event.seq > afterSeq);
}

export function writeOrchestrationSnapshot<State>(snapshot: OrchestrationSnapshot<State>): Promise<void> {
  return enqueue(async () => {
    await fs.mkdir(requireRoot(), { recursive: true });
    const target = snapshotFile();
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf8');
    await fs.rename(tmp, target);
    if (nextSeq === null || snapshot.lastSeq > nextSeq) nextSeq = snapshot.lastSeq;
  });
}

export async function readOrchestrationSnapshot<State = unknown>(): Promise<OrchestrationSnapshot<State> | null> {
  await writes;
  return readSnapshotFromDisk<State>();
}

export function resetOrchestrationStoreForTests(): void {
  root = '';
  writes = Promise.resolve();
  nextSeq = null;
}
