import { spawn, type ChildProcess } from 'node:child_process';
import { prepareCommand, terminateProcessTree } from './exec.js';

const MAX_MANAGED_PROCESSES = 16;
const MAX_PROCESS_HISTORY = 32;
const MAX_STREAM_BYTES = 100_000;

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
}

class ByteTail {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    // Keep the original chunk immutable from our point of view. Node stream buffers
    // are not normally reused, but a copy makes this class independent of that detail.
    const copy = Buffer.from(chunk);
    this.chunks.push(copy);
    this.bytes += copy.length;

    while (this.bytes > MAX_STREAM_BYTES && this.chunks.length > 0) {
      const overflow = this.bytes - MAX_STREAM_BYTES;
      const first = this.chunks[0]!;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.bytes -= overflow;
      }
      this.truncated = true;
    }
  }

  text(maxLines: number): string {
    if (this.bytes === 0 || maxLines <= 0) return '';
    const text = Buffer.concat(this.chunks, this.bytes).toString('utf8');
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
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

function statusOf(entry: ManagedProcess, maxLines: number): ManagedProcessStatus {
  const ended = entry.endedAt ?? Date.now();
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
    stdout: entry.stdout.text(maxLines),
    stderr: entry.stderr.text(maxLines),
    stdoutTruncated: entry.stdout.truncated,
    stderrTruncated: entry.stderr.truncated
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
    stderr
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

  if (child.pid === undefined) {
    throw new Error('Program started without a process id');
  }
  entry.pid = child.pid;
  processes.set(id, entry);
  pruneHistory();
  return statusOf(entry, 40);
}

export function getManagedProcess(id: string, maxLines = 80): ManagedProcessStatus {
  const entry = processes.get(id);
  if (!entry) throw new Error(`Unknown managed process id: ${id}`);
  return statusOf(entry, maxLines);
}

export function listManagedProcesses(): ManagedProcessStatus[] {
  return [...processes.values()].map((entry) => statusOf(entry, 0));
}

export async function stopManagedProcess(id: string, maxLines = 80): Promise<ManagedProcessStatus> {
  const entry = processes.get(id);
  if (!entry) throw new Error(`Unknown managed process id: ${id}`);
  if (!entry.running) return statusOf(entry, maxLines);

  entry.stopping = true;
  const closed = new Promise<void>((resolve) => entry.child.once('close', () => resolve()));
  await terminateProcessTree(entry.pid);
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  return statusOf(entry, maxLines);
}

export async function stopAllManagedProcesses(): Promise<void> {
  const ids = [...processes.values()].filter((entry) => entry.running).map((entry) => entry.id);
  await Promise.all(ids.map((id) => stopManagedProcess(id, 1).then(() => undefined).catch(() => undefined)));
}
