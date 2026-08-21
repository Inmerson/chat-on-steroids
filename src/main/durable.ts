/**
 * Small durable JSON files in the app's user-data folder.
 *
 * Two things outlive a restart but are not session history: the multi-agent run's
 * state, and the queue of commands waiting for the Chrome extension. Both are tiny,
 * both are rewritten whole, and losing either one silently is the failure that matters
 * — a pending worker→prime message or a "resume in a new chat" command that evaporates
 * because the app was reopened is exactly the class of loss this app exists to prevent.
 *
 * So: write to a temp file, rename over the target (atomic on NTFS), and coalesce
 * bursts on a short timer so a chatty broker does not rewrite the file per message.
 * A parse failure returns null rather than throwing — a corrupt state file must cost
 * the pending work, never the app's ability to start.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logWarn } from './logger.js';

const WRITE_DELAY_MS = 300;

let root = '';
const pending = new Map<string, unknown>();
const timers = new Map<string, NodeJS.Timeout>();
let inFlight: Promise<void> = Promise.resolve();

export function initDurableStore(userDataDir: string): void {
  root = path.join(userDataDir, 'state');
}

export function durableStoreReady(): boolean {
  return root !== '';
}

function fileFor(name: string): string {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`Invalid durable state name: ${name}`);
  return path.join(root, `${name}.json`);
}

export async function readDurable<T>(name: string): Promise<T | null> {
  if (!root) return null;
  try {
    const raw = await fs.readFile(fileFor(name), 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      logWarn(`could not read ${name} state: ${(err as Error).message}`);
    }
    return null;
  }
}

async function flushOne(name: string): Promise<void> {
  if (!pending.has(name)) return;
  const value = pending.get(name);
  pending.delete(name);
  const target = fileFor(name);
  const tmp = `${target}.tmp`;
  try {
    await fs.mkdir(root, { recursive: true });
    if (value === null) {
      await fs.rm(target, { force: true });
      return;
    }
    await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
    await fs.rename(tmp, target);
  } catch (err) {
    logWarn(`could not save ${name} state: ${(err as Error).message}`);
  }
}

/** Queues a write. Repeated calls before the timer fires collapse into one. */
export function writeDurableSoon(name: string, value: unknown): void {
  if (!root) return;
  pending.set(name, value);
  if (timers.has(name)) return;
  const timer = setTimeout(() => {
    timers.delete(name);
    inFlight = inFlight.then(() => flushOne(name));
  }, WRITE_DELAY_MS);
  timer.unref?.();
  timers.set(name, timer);
}

/**
 * Atomically writes one named state before returning.
 *
 * Used for transaction intent immediately before another durable commit: a debounced
 * snapshot is correct for ordinary progress, but cannot close a crash window between two
 * files when recovery needs to know which side of the boundary the process reached.
 */
export async function writeDurableNow(name: string, value: unknown): Promise<void> {
  if (!root) return;
  const timer = timers.get(name);
  if (timer) {
    clearTimeout(timer);
    timers.delete(name);
  }
  pending.set(name, value);
  const write = inFlight.then(() => flushOne(name));
  inFlight = write.catch(() => undefined);
  await write;
}

/** Writes everything queued right now. Called before the app quits, and by tests. */
export async function flushDurable(): Promise<void> {
  for (const [name, timer] of timers) {
    clearTimeout(timer);
    timers.delete(name);
    inFlight = inFlight.then(() => flushOne(name));
  }
  await inFlight;
}

/** Test seam: drops queued writes without touching disk. */
export function resetDurableForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  root = '';
}
