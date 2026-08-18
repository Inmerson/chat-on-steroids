import { spawn, type ChildProcess } from 'node:child_process';
import {
  cleanPowerShellStderr,
  prepareCommand,
  prepareShellCommand,
  terminateProcessTree,
  type AgentShell,
  type CommandEnvironment,
  type PreparedCommand
} from './exec.js';

/**
 * The subset of node-pty this app uses, declared here rather than imported.
 *
 * node-pty is loaded lazily and may legitimately be absent — an unsupported architecture,
 * a stripped install — and a type-only import would still be a hard build edge. Naming the
 * shape locally also documents exactly how much of that library CLF depends on.
 */
interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    // A list, which node-pty quotes for Windows itself, or a finished command line as one
    // string for the shell whose quoting nobody else gets right. See the cmd.exe branch of
    // prepareShellCommand.
    args: readonly string[] | string,
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ): PtyProcess;
}

let ptyModule: Promise<PtyModule | null> | null = null;

/**
 * Loads node-pty once, or decides for good that this machine does not have it.
 *
 * The binaries ship as Node-API prebuilds, so there is no compile step and no ABI tie to a
 * particular Electron version, but "no compile step" is not the same as "cannot fail": a
 * build could be packaged without the unpacked binaries, or run on an architecture with no
 * prebuild. Failing to a pipe with an honest message beats taking the whole app down over a
 * capability most calls do not ask for.
 */
async function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import('node-pty')
    .then((module) => ((module as { default?: PtyModule }).default ?? module) as PtyModule)
    .catch(() => null);
  return ptyModule;
}

export async function ptyAvailable(): Promise<boolean> {
  return (await loadPty()) !== null;
}

export const DEFAULT_TTY_COLS = 120;
export const DEFAULT_TTY_ROWS = 30;

const MAX_MANAGED_PROCESSES = 16;
const MAX_PROCESS_HISTORY = 32;
const MAX_STREAM_BYTES = 100_000;
const STOP_GRACE_MS = 1_500;
const FORCE_WAIT_MS = 3_000;
export const MAX_PROCESS_INPUT_CHARS = 64_000;
export const MAX_EXEC_YIELD_MS = 30_000;
/*
 * There is deliberately no wall-clock lifetime cap on a managed process.
 *
 * An earlier revision reaped shell sessions after half an hour on the theory that anything
 * still running by then had hung. Dev servers, watch builds, long test matrices and log
 * tails are all normal, all long-lived, and all indistinguishable from a hang from in here
 * — so the cap would have killed exactly the sessions the tool exists to keep alive, at a
 * moment the model had no way to predict. Lifetime is bound to the session instead: a
 * process ends when it exits, when someone stops it, or when the app tears the session
 * down. What is bounded is memory, not time; see ByteTail and pruneHistory.
 */

export class ProcessError extends Error {}

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
  /** Delta lines held back by the line cap; the returned cursor still points at them. */
  stdoutLinesPending: number;
  stderrLinesPending: number;
  stopMode: 'graceful' | 'forced' | null;
  /** True when the program is attached to a real console; then stderr is merged into stdout. */
  tty: boolean;
  cols: number;
  rows: number;
}

interface ManagedProcess {
  id: string;
  child: ChildProcess | null;
  pty: PtyProcess | null;
  tty: boolean;
  cols: number;
  rows: number;
  /** Run once when the program ends, whichever kind of process it is. */
  closers: Set<() => void>;
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
  /**
   * Delta lines that were produced but held back by the line cap. They are still behind
   * the returned cursor, so the next call with that cursor returns them.
   */
  linesPending: number;
  /**
   * Byte offset the caller has now consumed — the end of the text actually returned, and
   * never further. Two things could otherwise push it past what was delivered: a chunk
   * boundary landing inside a UTF-8 sequence, and a delta longer than the line cap.
   * Acknowledging either would lose output that no cursor could get back.
   */
  nextOffset: number;
}

/** True for a UTF-8 continuation byte (10xxxxxx), which can never start a character. */
function isContinuation(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/** Moves an arbitrary byte index forward to the next character boundary. */
function alignForward(data: Buffer, index: number): number {
  let at = Math.max(0, Math.min(index, data.length));
  while (at < data.length && isContinuation(data[at]!)) at++;
  return at;
}

/**
 * Moves an end index back off a trailing partial character. A multi-byte sequence that
 * has not fully arrived yet stays unread until the rest of it does.
 */
function alignBack(data: Buffer, end: number): number {
  const stop = Math.max(0, Math.min(end, data.length));
  for (let lead = stop - 1; lead >= 0 && lead >= stop - 4; lead--) {
    const byte = data[lead]!;
    if (isContinuation(byte)) continue;
    const needed =
      byte < 0x80
        ? 1
        : (byte & 0b1110_0000) === 0b1100_0000
          ? 2
          : (byte & 0b1111_0000) === 0b1110_0000
            ? 3
            : (byte & 0b1111_1000) === 0b1111_0000
              ? 4
              : 1;
    return lead + needed <= stop ? stop : lead;
  }
  // No lead byte within reach: the data is not UTF-8, so there is nothing to protect.
  return stop;
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

  view(maxLines: number, sinceOffset?: number): TailView {
    if (maxLines <= 0) return { text: '', cursorLost: false, linesPending: 0, nextOffset: this.endOffset };
    if (sinceOffset !== undefined && sinceOffset > this.endOffset) {
      throw new ProcessError('Output cursor is newer than this process output. Omit cursor to recover.');
    }
    if (this.bytes === 0) {
      return {
        text: '',
        cursorLost: sinceOffset !== undefined && sinceOffset < this.endOffset,
        linesPending: 0,
        nextOffset: this.endOffset
      };
    }

    const data = Buffer.concat(this.chunks, this.bytes);
    // A chunk boundary is not a character boundary. Read only up to the last complete
    // character; the tail of a half-written character waits for its remaining bytes.
    const readableEnd = alignBack(data, data.length);
    const streamEnd = this.startOffset + readableEnd;

    const cursorLost = sinceOffset !== undefined && sinceOffset < this.startOffset;
    // startOffset itself can sit inside a character once the head has been dropped to
    // stay under the byte cap, so even the no-cursor read has to align.
    const from =
      sinceOffset === undefined
        ? alignForward(data, 0)
        : alignForward(data, Math.max(0, Math.max(this.startOffset, sinceOffset) - this.startOffset));
    if (from >= readableEnd) {
      // Nothing new is readable. Never move the cursor backwards over a partial character.
      return {
        text: '',
        cursorLost,
        linesPending: 0,
        nextOffset: sinceOffset === undefined ? streamEnd : Math.max(sinceOffset, streamEnd)
      };
    }

    const slice = data.subarray(from, readableEnd);
    if (sinceOffset === undefined) {
      // Snapshot: the newest lines are the useful ones, and there is no prior cursor for
      // the older ones to be recovered against anyway.
      const lines = slice.toString('utf8').split(/\r?\n/);
      return {
        text: lines.slice(Math.max(0, lines.length - maxLines)).join('\n'),
        cursorLost: false,
        linesPending: 0,
        nextOffset: streamEnd
      };
    }

    // Delta: return the OLDEST maxLines and advance exactly past them. Returning the
    // newest instead would leave the skipped lines behind a cursor that already claims
    // them, and nothing could ever read them again.
    let cut = slice.length;
    let seen = 0;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] !== 0x0a) continue;
      if (++seen === maxLines) {
        cut = i + 1;
        break;
      }
    }
    const rest = slice.subarray(cut);
    return {
      text: slice.subarray(0, cut).toString('utf8').split(/\r?\n/).join('\n'),
      cursorLost,
      linesPending: rest.length === 0 ? 0 : rest.toString('utf8').split(/\r?\n/).filter((line) => line !== '').length,
      nextOffset: this.startOffset + from + cut
    };
  }
}

/**
 * What a person would see on the screen, from what the program wrote to the console.
 *
 * A real console is real, so a real console's bytes come back: colour codes, cursor moves,
 * window-title updates, alternate-screen switches, the redraw a progress bar does forty
 * times a second. Handing those to a reader with no terminal is not honesty, it is noise —
 * and expensive noise, because every escape sequence is tokens. So the bytes are kept
 * exactly as received (the cursor counts them, and a delta must line up with what arrived)
 * and only this rendering step drops the control traffic.
 *
 * The one place it does more than delete: a bare carriage return means the program went
 * back to the start of the line to write over it, so only what it wrote last survives —
 * which is why a progress bar reads as one finished line instead of forty.
 */
export function renderTerminalText(raw: string): string {
  const withoutEscapes = raw
    // OSC — window title and friends, ended by BEL or ST.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    // CSI — colours, cursor movement, erase, private mode set/reset.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Everything else introduced by ESC: charset selection, keypad mode, single shifts.
    .replace(/\x1b[ -/]*[0-~]/g, '')
    // A console ends its lines with CRLF. That carriage return is a line terminator, not
    // an overwrite, and mistaking it for one below would delete every line of output.
    .replace(/\r\n/g, '\n');
  return withoutEscapes
    .split('\n')
    .map((line) => {
      const overwritten = line.split('\r');
      const visible = overwritten[overwritten.length - 1] ?? '';
      // Control characters that survived carry no meaning without a screen to apply them to.
      return visible.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    })
    .join('\n');
}

const processes = new Map<string, ManagedProcess>();
let nextId = 1;

function onClose(entry: ManagedProcess, listener: () => void): () => void {
  entry.closers.add(listener);
  return () => entry.closers.delete(listener);
}

function markClosed(entry: ManagedProcess, exitCode: number | null, signal: NodeJS.Signals | null): void {
  if (!entry.running) return;
  entry.running = false;
  entry.stopping = false;
  entry.exitCode = exitCode;
  entry.signal = signal;
  entry.endedAt = Date.now();
  const listeners = [...entry.closers];
  entry.closers.clear();
  for (const listener of listeners) listener();
  pruneHistory();
}

/**
 * node-pty reports the console's process id a beat after spawn returns — it is zero until
 * the ConPTY connection completes — so it is read again whenever it is needed rather than
 * captured once. Stopping a session depends on having it.
 */
function refreshPid(entry: ManagedProcess): number {
  if (entry.pid === 0 && entry.pty) entry.pid = entry.pty.pid ?? 0;
  return entry.pid;
}

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

function encodeCursor(entry: ManagedProcess, stdout: number, stderr: number): string {
  return `${entry.id}.${stdout.toString(36)}.${stderr.toString(36)}`;
}

function parseCursor(entry: ManagedProcess, cursor: string): { stdout: number; stderr: number } {
  const match = /^([A-Za-z0-9_-]+)\.([0-9a-z]+)\.([0-9a-z]+)$/.exec(cursor);
  if (!match) throw new ProcessError('Invalid output cursor. Omit cursor to recover.');
  if (match[1] !== entry.id) throw new ProcessError(`Output cursor belongs to ${match[1]}, not ${entry.id}. Omit cursor to recover.`);
  const stdout = Number.parseInt(match[2]!, 36);
  const stderr = Number.parseInt(match[3]!, 36);
  if (!Number.isSafeInteger(stdout) || !Number.isSafeInteger(stderr)) {
    throw new ProcessError('Invalid output cursor. Omit cursor to recover.');
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
    pid: refreshPid(entry),
    command: entry.command,
    running: entry.running,
    stopping: entry.stopping,
    exitCode: entry.exitCode,
    signal: entry.signal,
    startedAt: entry.startedAt,
    durationMs: Math.max(0, ended - entry.startedAt),
    // A console's bytes are stored exactly as they arrived, because the cursor counts them.
    // They are turned into something readable only on the way out; see renderTerminalText.
    stdout: entry.tty ? renderTerminalText(stdout.text) : stdout.text,
    // Same idea as renderTerminalText above: the bytes are kept as they arrived because the
    // cursor counts them, and are made readable only on the way out. Windows PowerShell
    // serializes its error stream as CLIXML when stderr is a pipe, so without this the
    // model gets `#< CLIXML` and `_x000D__x000A_` instead of the one line that matters.
    stderr: cleanPowerShellStderr(stderr.text),
    stdoutTruncated: entry.stdout.truncated,
    stderrTruncated: entry.stderr.truncated,
    // The cursor tracks what was actually decoded, not what arrived, so a character split
    // across two chunks is delivered once and whole on the next call.
    cursor: encodeCursor(entry, stdout.nextOffset, stderr.nextOffset),
    outputMode: cursor === undefined ? 'tail' : 'delta',
    stdoutCursorLost: stdout.cursorLost,
    stderrCursorLost: stderr.cursorLost,
    stdoutLinesPending: stdout.linesPending,
    stderrLinesPending: stderr.linesPending,
    stopMode: entry.stopMode,
    tty: entry.tty,
    cols: entry.cols,
    rows: entry.rows
  };
}

export interface TerminalOptions {
  /** Attach a real console instead of pipes. Falls back to pipes only if node-pty is absent. */
  tty?: boolean;
  cols?: number;
  rows?: number;
}

function newEntry(id: string, displayCommand: string, terminal: TerminalOptions | undefined): ManagedProcess {
  return {
    id,
    child: null,
    pty: null,
    tty: false,
    cols: clampAxis(terminal?.cols, DEFAULT_TTY_COLS),
    rows: clampAxis(terminal?.rows, DEFAULT_TTY_ROWS),
    closers: new Set(),
    pid: 0,
    command: displayCommand,
    startedAt: Date.now(),
    endedAt: null,
    running: true,
    stopping: false,
    exitCode: null,
    signal: null,
    stdout: new ByteTail(),
    stderr: new ByteTail(),
    stopMode: null
  };
}

function clampAxis(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(20, Math.min(500, Math.floor(value)));
}

async function startPreparedManagedProcess(
  prepared: PreparedCommand,
  displayCommand: string,
  cwd: string,
  terminal?: TerminalOptions
): Promise<ManagedProcessStatus> {
  if (runningCount() >= MAX_MANAGED_PROCESSES) {
    throw new ProcessError(`Too many managed processes are running (limit ${MAX_MANAGED_PROCESSES})`);
  }

  const pty = terminal?.tty ? await loadPty() : null;
  const id = `p${nextId++}`;
  const entry = newEntry(id, displayCommand, terminal);

  if (pty) {
    entry.tty = true;
    // A console has one screen, so there is no second stream to separate: what the program
    // writes to stderr is interleaved with stdout exactly where it appeared, which is the
    // whole point of asking for a terminal. `stderr` stays empty rather than being faked.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(prepared.env ?? {})) if (value !== undefined) env[key] = value;
    let terminalProcess: PtyProcess;
    try {
      // node-pty takes either an argument list, which it quotes for Windows itself, or a
      // finished command line as one string. cmd.exe needs the second: its quoting is not
      // the convention any of the quoters apply, so the line is handed over as written.
      const argv = prepared.windowsVerbatimArguments === true ? prepared.args.join(' ') : [...prepared.args];
      terminalProcess = pty.spawn(prepared.file, argv, {
        name: 'xterm-256color',
        cols: entry.cols,
        rows: entry.rows,
        cwd,
        env
      });
    } catch (error) {
      throw new ProcessError(`Failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    entry.pty = terminalProcess;
    terminalProcess.onData((data) => entry.stdout.push(Buffer.from(data, 'utf8')));
    terminalProcess.onExit(({ exitCode }) => markClosed(entry, exitCode ?? null, null));

    // The console's process id arrives a moment after spawn. Waiting briefly for it means
    // the very first reply already carries something `process action=stop` can act on.
    for (let waited = 0; refreshPid(entry) === 0 && entry.running && waited < 250; waited += 25) {
      await delay(25);
    }
    processes.set(id, entry);
    pruneHistory();
    return statusOf(entry, 40);
  }

  const child = spawn(prepared.file, prepared.args, {
    cwd,
    env: prepared.env,
    windowsHide: true,
    shell: false,
    detached: false,
    // Set only for cmd.exe, whose quoting rules are not the ones Node applies. Without it
    // a quoted child command reached cmd mangled, did not run, and still exited 0.
    windowsVerbatimArguments: prepared.windowsVerbatimArguments === true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  entry.child = child;

  child.stdout?.on('data', (chunk: Buffer) => entry.stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => entry.stderr.push(chunk));
  child.on('close', (code, signal) => markClosed(entry, code, signal));

  await new Promise<void>((resolve, reject) => {
    child.once('error', (error) => reject(new ProcessError(`Failed to start: ${error.message}`)));
    child.once('spawn', () => resolve());
  });

  if (child.pid === undefined) throw new ProcessError('Program started without a process id');
  entry.pid = child.pid;
  processes.set(id, entry);
  pruneHistory();
  return statusOf(entry, 40);
}

export async function startManagedProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: CommandEnvironment,
  terminal?: TerminalOptions
): Promise<ManagedProcessStatus> {
  return startPreparedManagedProcess(prepareCommand(command, args, cwd, env), command, cwd, terminal);
}

export async function startManagedShellProcess(
  script: string,
  shell: AgentShell,
  cwd: string,
  env?: CommandEnvironment,
  terminal?: TerminalOptions
): Promise<ManagedProcessStatus> {
  return startPreparedManagedProcess(prepareShellCommand(script, shell, env), script, cwd, terminal);
}

/** Tell a console-attached program its window changed size, the way a real terminal would. */
export function resizeManagedProcess(
  id: string,
  cols: number | undefined,
  rows: number | undefined,
  maxLines = 80,
  cursor?: string
): ManagedProcessStatus {
  const entry = processes.get(id);
  if (!entry) throw new ProcessError(`Unknown managed process id: ${id}`);
  if (!entry.tty || !entry.pty) throw new ProcessError(`Process ${id} is not attached to a console, so it has no size.`);
  if (!entry.running) throw new ProcessError(`Managed process ${id} is not running`);
  if (cursor !== undefined) parseCursor(entry, cursor);
  entry.cols = clampAxis(cols, entry.cols);
  entry.rows = clampAxis(rows, entry.rows);
  entry.pty.resize(entry.cols, entry.rows);
  return statusOf(entry, maxLines, cursor);
}

export function getManagedProcess(id: string, maxLines = 80, cursor?: string): ManagedProcessStatus {
  const entry = processes.get(id);
  if (!entry) throw new ProcessError(`Unknown managed process id: ${id}`);
  return statusOf(entry, maxLines, cursor);
}

/** Wait briefly for a managed process to exit, then return either its final result or live session state. */
export async function waitManagedProcess(
  id: string,
  yieldMs: number,
  maxLines = 80,
  cursor?: string
): Promise<ManagedProcessStatus> {
  const entry = processes.get(id);
  if (!entry) throw new ProcessError(`Unknown managed process id: ${id}`);
  if (cursor !== undefined) parseCursor(entry, cursor);
  const waitMs = Math.min(MAX_EXEC_YIELD_MS, Math.max(0, Math.floor(yieldMs)));
  if (entry.running && waitMs > 0) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      const unsubscribe = onClose(entry, finish);
    });
  }
  return statusOf(entry, maxLines, cursor);
}

export function listManagedProcesses(): ManagedProcessStatus[] {
  return [...processes.values()].map((entry) => statusOf(entry, 0));
}

/** Send input to an already-running managed process without starting a shell. */
export async function writeManagedProcess(
  id: string,
  text: string,
  newline = true,
  close = false,
  maxLines = 80,
  cursor?: string
): Promise<ManagedProcessStatus> {
  const entry = processes.get(id);
  if (!entry) throw new ProcessError(`Unknown managed process id: ${id}`);
  if (!entry.running) throw new ProcessError(`Managed process ${id} is not running`);
  if (cursor !== undefined) parseCursor(entry, cursor);
  if (typeof text !== 'string') throw new ProcessError('Process input must be text');
  if (text.length > MAX_PROCESS_INPUT_CHARS) {
    throw new ProcessError(`Process input is too long (limit ${MAX_PROCESS_INPUT_CHARS} characters)`);
  }
  if (entry.pty) {
    // A terminal sends a bare carriage return for Enter, and the console's line discipline
    // turns it into the newline the program reads. Sending LF instead leaves shells that
    // read a raw console — PowerShell among them — waiting for a key that never comes.
    entry.pty.write(`${text}${newline ? '\r' : ''}`);
    // A console has no closable stdin. Ctrl+D is the key a person would press to say the
    // input is over, so that is what "close" means here.
    if (close) entry.pty.write('\x04');
    return statusOf(entry, maxLines, cursor);
  }

  const stdin = entry.child?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) throw new ProcessError(`Managed process ${id} is not accepting stdin`);
  const payload = `${text}${newline ? '\n' : ''}`;
  await new Promise<void>((resolve, reject) => {
    stdin.write(payload, 'utf8', (error) => {
      if (error) reject(new ProcessError(`Could not write to ${id}: ${error.message}`));
      else resolve();
    });
  });
  if (close) stdin.end();
  return statusOf(entry, maxLines, cursor);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tears down the pseudoconsole. Throwing here means it was already gone, which is the goal. */
function killConsole(entry: ManagedProcess): void {
  try {
    entry.pty?.kill();
  } catch {
    /* already closed */
  }
}

export async function stopManagedProcess(
  id: string,
  maxLines = 80,
  cursor?: string
): Promise<ManagedProcessStatus> {
  const entry = processes.get(id);
  if (!entry) throw new ProcessError(`Unknown managed process id: ${id}`);
  if (!entry.running) return statusOf(entry, maxLines, cursor);

  // Parse before changing anything, so a bad cursor cannot accidentally stop a job.
  if (cursor !== undefined) parseCursor(entry, cursor);

  entry.stopping = true;
  const closed = new Promise<void>((resolve) => onClose(entry, resolve));

  // taskkill /T without /F is the least-destructive tree-aware primitive Windows
  // gives us without creating a native Job Object bridge. The deadline includes the
  // taskkill helper itself, so an uncooperative helper cannot secretly add seconds.
  const gracefulDeadline = Date.now() + STOP_GRACE_MS;
  const pid = refreshPid(entry);
  if (pid > 0) await terminateProcessTree(pid, false, Math.min(500, STOP_GRACE_MS));
  else killConsole(entry);
  await Promise.race([closed, delay(Math.max(0, gracefulDeadline - Date.now()))]);

  if (entry.running) {
    entry.stopMode = 'forced';
    const forceDeadline = Date.now() + FORCE_WAIT_MS;
    // Closing the console itself as well as the tree: a ConPTY holds the pipe open, and a
    // session whose pseudoconsole survives never reports that it ended.
    if (pid > 0) await terminateProcessTree(pid, true, Math.min(1_000, FORCE_WAIT_MS));
    killConsole(entry);
    await Promise.race([closed, delay(Math.max(0, forceDeadline - Date.now()))]);
  } else {
    entry.stopMode = 'graceful';
  }

  if (entry.running) {
    entry.stopping = false;
    throw new ProcessError(
      `Process ${id} is still running after graceful and forced tree termination. Retry stop or inspect it manually.`
    );
  }
  return statusOf(entry, maxLines, cursor);
}

export async function stopAllManagedProcesses(): Promise<void> {
  const ids = [...processes.values()].filter((entry) => entry.running).map((entry) => entry.id);
  await Promise.all(ids.map((id) => stopManagedProcess(id, 1).then(() => undefined).catch(() => undefined)));
}
