import { spawn, type ChildProcess } from 'node:child_process';
import { prepareCommand, terminateProcessTree } from './exec.js';

const MAX_MANAGED_PROCESSES = 16;
const MAX_PROCESS_HISTORY = 32;
const MAX_STREAM_BYTES = 100_000;
const STOP_GRACE_MS = 1_500;
const FORCE_WAIT_MS = 3_000;

export interface ManagedProcessStatus {
  id: string;
  pid: number;
  command: string;
  running: boolean;
  stopping: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Opaque token to pass back on the next status/stop call for delta-only output. */
  cursor: string;
  outputMode: 'tail' | 'delta';
  stdoutCursorLost: boolean;
  stderrCursorLost: boolean;
  stdoutLinesOmitted: number;
  stderrLinesOmitted: number;
  stopMode: 'graceful' | 'forced' | null;
}

interface ManagedProcess {
  id: string;
  child: ChildProcess;
  pid: number;
  command: string;
  startedAt: number;
  endedAt: number | null;
  running: boolean;
  stopping: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: ByteTail;
  stderr: ByteTail;
  stopMode: 'graceful' | 'forced' | null;
}

interface TailView {
  text: string;
  cursorLost: boolean;
  linesOmitted: number;
}

class ByteTail {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private startOffset = 0;
  private endOffset = 0;
  truncated = false;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const copy = Buffer.from(chunk);
    this.chunks.push(copy);
    this.bytes += copy.length;
    this.endOffset += copy.length;

    while (this.bytes > MAX_STREAM_BYTES && this.chunks.length > 0) {
      const overflow = this.bytes - MAX_STREAM_BYTES;
      const first = this.chunks[0]!;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.bytes -= first.length;
        this.startOffset += first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.bytes -= overflow;
        this.startOffset += overflow;
      }
      this.truncated = true;
    }
  }

  cursor(): number {
    return this.endOffset;
  }

  view(maxLines: number, sinceOffset?: number): TailView {
    if (maxLines <= 0) return { text: '', cursorLost: false, linesOmitted: 0 };
    if (sinceOffset !== undefined && sinceOffset > this.endOffset) {
      throw new Error('Output cursor is newer than this process output. Omit cursor to recover.');
    }
    if (this.bytes === 0) {
      return {
        text: '',
        cursorLost: sinceOffset !== undefined && sinceOffset < this.endOffset,
        linesOmitted: 0
      };
    }

    const data = Buffer.concat(this.chunks, this.bytes);
    if (sinceOffset === undefined) {
      const lines = data.toString('utf8').split(/\r?\n/);
      return {
        text: lines.slice(Math.max(0, lines.length - maxLines)).join('\n'),
        cursorLost: false,
        linesOmitted: 0
      };
    }

    const cursorLost = sinceOffset < this.startOffset;
    const effectiveOffset = Math.max(this.startOffset, sinceOffset);
    const byteIndex = Math.max(0, effectiveOffset - this.startOffset);
    const lines = data.subarray(byteIndex).toString('utf8').split(/\r?\n/);
    const linesOmitted = Math.max(0, lines.length - maxLines);
    return {
      // For logs the newest lines are the useful ones. If the caller asks for a
      // smaller line cap than the delta contains, skip the oldest delta and say so.
      text: lines.slice(Math.max(0, lines.length - maxLines)).join('\n'),
      cursorLost,
      linesOmitted
    };
  }
}

const processes = new Map<string, ManagedProcess>();
let nextId = 1;

function runningCount(): number {
  let count = 0;
  for (const entry of processes.values()) if (entry.running) count++;
  return count;
}

function pruneHistory(): void {
  if (processes.size <= MAX_PROCESS_HISTORY) return;
  for (const [id, entry] of processes) {
    if (processes.size <= MAX_PROCESS_HISTORY) break;
    if (!entry.running) processes.delete(id);
  }
}

function encodeCursor(entry: ManagedProcess): string {
  return `${entry.id}.${entry.stdout.cursor().toString(36)}.${entry.stderr.cursor().toString(36)}`;
}

function parseCursor(entry: ManagedProcess, cursor: string): { stdout: number; stderr: number } {
  const match = /^([A-Za-z0-9_-]+)\.([0-9a-z]+)\.([0-9a-z]+)$/.exec(cursor);
  if (!match) throw new Error('Invalid output cursor. Omit cursor to recover.');
  if (match[1] !== entry.id) throw new Error(`Output cursor belongs to ${match[1]}, not ${entry.id}. Omit cursor to recover.`);
  const stdout = Number.parseInt(match[2]!, 36);
  const stderr = Number.parseInt(match[3]!, 36);
  if (!Number.isSafeInteger(stdout) || !Number.isSafeInteger(stderr)) {
    throw new Error('Invalid output cursor. Omit cursor to recover.');
  }
  return { stdout, stderr };
}

function statusOf(entry: ManagedProcess, maxLines: number, cursor?: string): ManagedProcessStatus {
  const ended = entry.endedAt ?? Date.now();
  const parsed = cursor === undefined ? undefined : parseCursor(entry, cursor);
  const stdout = entry.stdout.view(maxLines, parsed?.stdout);
  const stderr = entry.stderr.view(maxLines, parsed?.stderr);
  return {
    id: entry.id,
    pid: entry.pid,
    command: entry.command,
    running: entry.running,
    stopping: entry.stopping,
    exitCode: entry.exitCode,
    signal: entry.signal,
    startedAt: entry.startedAt,
    durationMs: Math.max(0, ended - entry.startedAt),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: entry.stdout.truncated,
    stderrTruncated: entry.stderr.truncated,
    cursor: encodeCursor(entry),
    outputMode: cursor === undefined ? 'tail' : 'delta',
    stdoutCursorLost: stdout.cursorLost,
    stderrCursorLost: stderr.cursorLost,
    stdoutLinesOmitted: stdout.linesOmitted,
    stderrLinesOmitted: stderr.linesOmitted,
    stopMode: entry.stopMode
  };
}

export async function startManagedProcess(
  command: string,
  args: readonly string[],
  cwd: string
): Promise<ManagedProcessStatus> {
  if (runningCount() >= MAX_MANAGED_PROCESSES) {
    throw new Error(`Too many managed processes are running (limit ${MAX_MANAGED_PROCESSES})`);
  }

  const prepared = prepareCommand(command, args, cwd);
  const child = spawn(prepared.file, prepared.args, {
    cwd,
    env: prepared.env,
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const id = `p${nextId++}`;
  const stdout = new ByteTail();
  const stderr = new ByteTail();
  const startedAt = Date.now();

  const entry: ManagedProcess = {
    id,
    child,
    pid: 0,
    command,
    startedAt,
    endedAt: null,
    running: true,
    stopping: false,
    exitCode: null,
    signal: null,
    stdout,
    stderr,
    stopMode: null
  };

  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('close', (code, signal) => {
    entry.running = false;
    entry.stopping = false;
    entry.exitCode = code;
    entry.signal = signal;
    entry.endedAt = Date.now();
    pruneHistory();
  });

  await new Promise<void>((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`Failed to start: ${error.message}`)));
    child.once('spawn', () => resolve());
  });

  if (child.pid === undefined) throw new Error('Program started without a process id');
  entry.pid = child.pid;
  processes.set(id, entry);
  pruneHistory();
  return statusOf(entry, 40);
}

export function getManagedProcess(id: string, maxLines = 80, cursor?: string): ManagedProcessStatus {
  const entry = processes.get(id);
  if (!entry) throw new Error(`Unknown managed process id: ${id}`);
  return statusOf(entry, maxLines, cursor);
}

export function listManagedProcesses(): ManagedProcessStatus[] {
  return [...processes.values()].map((entry) => statusOf(entry, 0));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopManagedProcess(
  id: string,
  maxLines = 80,
  cursor?: string
): Promise<ManagedProcessStatus> {
  const entry = processes.get(id);
  if (!entry) throw new Error(`Unknown managed process id: ${id}`);
  if (!entry.running) return statusOf(entry, maxLines, cursor);

  // Parse before changing anything, so a bad cursor cannot accidentally stop a job.
  if (cursor !== undefined) parseCursor(entry, cursor);

  entry.stopping = true;
  const closed = new Promise<void>((resolve) => entry.child.once('close', () => resolve()));

  // taskkill /T without /F is the least-destructive tree-aware primitive Windows
  // gives us without creating a native Job Object bridge. It gets one short chance.
  await terminateProcessTree(entry.pid, false);
  await Promise.race([closed, delay(STOP_GRACE_MS)]);

  if (entry.running) {
    entry.stopMode = 'forced';
    await terminateProcessTree(entry.pid, true);
    await Promise.race([closed, delay(FORCE_WAIT_MS)]);
  } else {
    entry.stopMode = 'graceful';
  }

  if (entry.running) {
    entry.stopping = false;
    throw new Error(
      `Process ${id} is still running after graceful and forced tree termination. Retry stop or inspect it manually.`
    );
  }
  return statusOf(entry, maxLines, cursor);
}

export async function stopAllManagedProcesses(): Promise<void> {
  const ids = [...processes.values()].filter((entry) => entry.running).map((entry) => entry.id);
  await Promise.all(ids.map((id) => stopManagedProcess(id, 1).then(() => undefined).catch(() => undefined)));
}
