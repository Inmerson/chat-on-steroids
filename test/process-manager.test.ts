import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getManagedProcess,
  listManagedProcesses,
  ptyAvailable,
  renderTerminalText,
  resizeManagedProcess,
  startManagedProcess,
  startManagedShellProcess,
  stopAllManagedProcesses,
  stopManagedProcess,
  waitManagedProcess,
  writeManagedProcess
} from '../src/main/process-manager.js';
import { IS_WINDOWS, makeTempDir, removeTempDir } from './helpers.js';

let cwd: string;
const node = process.execPath;

async function waitForOutput(
  id: string,
  needle: string,
  stream: 'stdout' | 'stderr' = 'stdout',
  timeoutMs = 3000
): Promise<ReturnType<typeof getManagedProcess>> {
  const deadline = Date.now() + timeoutMs;
  let status = getManagedProcess(id, 80);
  while (!status[stream].includes(needle) && status.running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = getManagedProcess(id, 80);
  }
  return status;
}

beforeAll(async () => {
  cwd = await makeTempDir('clf-process-');
});

afterAll(async () => {
  await stopAllManagedProcesses();
  await removeTempDir(cwd);
});

describe('managed processes', () => {
  it('starts, captures output, reports status and stops the process tree', async () => {
    const started = await startManagedProcess(
      node,
      ['-e', 'console.log("ready"); console.error("warn"); setInterval(() => {}, 1000)'],
      cwd
    );
    expect(started.id).toMatch(/^p\d+$/);
    expect(started.pid).toBeGreaterThan(0);
    expect(started.running).toBe(true);

    const ready = await waitForOutput(started.id, 'ready');
    expect(ready.stdout).toContain('ready');
    const status = await waitForOutput(started.id, 'warn', 'stderr');
    expect(status.stdout).toContain('ready');
    expect(status.stderr).toContain('warn');
    expect(status.running).toBe(true);

    const stopped = await stopManagedProcess(started.id, 20);
    expect(stopped.running).toBe(false);
  });

  it('writes stdin and applies explicit environment overrides', async () => {
    const started = await startManagedProcess(
      node,
      [
        '-e',
        'process.stdin.setEncoding("utf8"); console.log("env="+(process.env.TEST_PROCESS_ENV ?? "missing")); process.stdin.once("data", d => { console.log("input="+d.trim()); process.exit(0); });'
      ],
      cwd,
      { TEST_PROCESS_ENV: 'process-ok' }
    );
    const before = await waitForOutput(started.id, 'env=process-ok');
    expect(before.stdout).toContain('env=process-ok');
    await writeManagedProcess(started.id, 'hello-process');
    const deadline = Date.now() + 3000;
    while (getManagedProcess(started.id).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const after = getManagedProcess(started.id, 20);
    expect(after.running).toBe(false);
    expect(after.stdout).toContain('input=hello-process');
  });

  it.runIf(IS_WINDOWS)(
    'keeps stop bounded when graceful taskkill waits on a stubborn cmd loop',
    async () => {
      const started = await startManagedProcess(
        'cmd.exe',
        ['/d', '/s', '/c', 'for /L %i in (1,1,60) do @echo tick%i & @ping 127.0.0.1 -n 2 >nul'],
        cwd
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const before = Date.now();
      const stopped = await stopManagedProcess(started.id, 10);
      const elapsed = Date.now() - before;
      expect(stopped.running).toBe(false);
      expect(elapsed).toBeLessThan(5_500);
    },
    8_000
  );

  it('keeps exited processes inspectable with their exit code', async () => {
    const started = await startManagedProcess(
      node,
      ['-e', 'console.log("done"); process.exit(7)'],
      cwd
    );
    const deadline = Date.now() + 3000;
    while (getManagedProcess(started.id).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = getManagedProcess(started.id, 20);
    expect(status.running).toBe(false);
    expect(status.exitCode).toBe(7);
    expect(status.stdout).toContain('done');
    expect(listManagedProcesses().some((entry) => entry.id === started.id)).toBe(true);
  });

  it('bounds noisy output instead of growing with the child process', async () => {
    const started = await startManagedProcess(
      node,
      ['-e', 'process.stdout.write("x".repeat(250000))'],
      cwd
    );
    const deadline = Date.now() + 3000;
    while (getManagedProcess(started.id).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = getManagedProcess(started.id, 20);
    expect(status.running).toBe(false);
    expect(status.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(status.stdout, 'utf8')).toBeLessThanOrEqual(100_000);
  });

  it('stops a real descendant process as part of the managed process tree', async () => {
    const started = await startManagedProcess(
      node,
      [
        '-e',
        'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log("child="+child.pid); setInterval(()=>{},1000)'
      ],
      cwd
    );
    const status = await waitForOutput(started.id, 'child=');
    const childPid = Number(status.stdout.match(/child=(\d+)/)?.[1]);
    expect(childPid).toBeGreaterThan(0);

    await stopManagedProcess(started.id, 20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('returns only output produced after an opaque cursor', async () => {
    const started = await startManagedProcess(
      node,
      [
        '-e',
        'console.log("first"); setTimeout(() => console.log("second"), 250); setInterval(() => {}, 1000)'
      ],
      cwd
    );
    const first = await waitForOutput(started.id, 'first');
    expect(first.stdout).toContain('first');
    expect(first.cursor).toMatch(new RegExp(`^${first.id}\\.`));

    await new Promise((resolve) => setTimeout(resolve, 300));
    const delta = getManagedProcess(started.id, 20, first.cursor);
    expect(delta.outputMode).toBe('delta');
    expect(delta.stdout).toContain('second');
    expect(delta.stdout).not.toContain('first');

    const emptyDelta = getManagedProcess(started.id, 20, delta.cursor);
    expect(emptyDelta.stdout).toBe('');
    await stopManagedProcess(started.id, 1, emptyDelta.cursor);
  });

  it('reports when a cursor falls behind the bounded noisy-output buffer', async () => {
    const started = await startManagedProcess(
      node,
      ['-e', 'setTimeout(() => process.stdout.write("x".repeat(250000)), 100)'],
      cwd
    );
    const cursor = started.cursor;
    const deadline = Date.now() + 3000;
    while (getManagedProcess(started.id).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const delta = getManagedProcess(started.id, 20, cursor);
    expect(delta.stdoutCursorLost).toBe(true);
    expect(Buffer.byteLength(delta.stdout, 'utf8')).toBeLessThanOrEqual(100_000);
  });

  it('rejects a cursor from another process without stopping either process', async () => {
    const one = await startManagedProcess(node, ['-e', 'setInterval(() => {}, 1000)'], cwd);
    const two = await startManagedProcess(node, ['-e', 'setInterval(() => {}, 1000)'], cwd);
    await expect(stopManagedProcess(two.id, 10, one.cursor)).rejects.toThrow(/belongs to/);
    expect(getManagedProcess(one.id).running).toBe(true);
    expect(getManagedProcess(two.id).running).toBe(true);
    await stopManagedProcess(one.id, 1);
    await stopManagedProcess(two.id, 1);
  });

  it('delivers every line of an over-cap delta exactly once, in order', async () => {
    // The cursor must never acknowledge a line that was not returned. With a delta longer
    // than the line cap, the caller has to be able to walk the whole delta by feeding each
    // returned cursor back in — no line skipped, none repeated, order preserved.
    const started = await startManagedProcess(
      node,
      ['-e', 'setTimeout(() => { for (let i = 1; i <= 25; i++) console.log("line" + i); }, 60); setInterval(() => {}, 1000)'],
      cwd
    );
    const base = started.cursor;
    await waitForOutput(started.id, 'line25');

    const collected: string[] = [];
    let cursor = base;
    for (let round = 0; round < 20; round++) {
      const status = getManagedProcess(started.id, 4, cursor);
      cursor = status.cursor;
      const lines = status.stdout.split('\n').filter((line) => line !== '');
      collected.push(...lines);
      if (lines.length === 0) break;
      expect(lines.length).toBeLessThanOrEqual(4);
    }

    expect(collected).toEqual(Array.from({ length: 25 }, (_, i) => `line${i + 1}`));
    // Draining is complete: the final cursor has nothing left behind it.
    const drained = getManagedProcess(started.id, 4, cursor);
    expect(drained.stdout).toBe('');
    expect(drained.stdoutLinesPending).toBe(0);
    await stopManagedProcess(started.id, 1);
  });

  it('says how much of an over-cap delta is still waiting', async () => {
    const started = await startManagedProcess(
      node,
      ['-e', 'setTimeout(() => { for (let i = 0; i < 10; i++) console.log("row" + i); }, 60); setInterval(() => {}, 1000)'],
      cwd
    );
    const base = started.cursor;
    await waitForOutput(started.id, 'row9');
    const first = getManagedProcess(started.id, 3, base);
    expect(first.stdout.split('\n').filter(Boolean)).toEqual(['row0', 'row1', 'row2']);
    expect(first.stdoutLinesPending).toBe(7);
    await stopManagedProcess(started.id, 1);
  });

  it('never splits a multi-byte character across two reads', async () => {
    // The child writes one byte at a time, so a read almost certainly lands inside a
    // multi-byte character. Nothing may decode as U+FFFD, and the text must reassemble.
    const started = await startManagedProcess(
      node,
      [
        '-e',
        'const b = Buffer.from("héllo wörld — ✅ 日本語\\n", "utf8"); let i = 0; const t = setInterval(() => { if (i >= b.length) { clearInterval(t); return; } process.stdout.write(b.subarray(i, i + 1)); i++; }, 2); setInterval(() => {}, 1000)'
      ],
      cwd
    );

    let cursor = started.cursor;
    let text = '';
    const deadline = Date.now() + 5000;
    while (!text.includes('日本語') && Date.now() < deadline) {
      const status = getManagedProcess(started.id, 80, cursor);
      cursor = status.cursor;
      expect(status.stdout).not.toContain('�');
      text += status.stdout;
      if (!status.stdout) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(text.replace(/\n/g, '')).toBe('héllo wörld — ✅ 日本語');
    await stopManagedProcess(started.id, 1);
  });

  it('rejects unknown process ids', () => {
    expect(() => getManagedProcess('p-does-not-exist')).toThrow(/Unknown managed process id/);
  });
});

describe('turning console bytes into something worth reading', () => {
  it('keeps the text and drops the control traffic', () => {
    // Captured verbatim from a ConPTY running `cmd /c echo`: private mode sets, erase,
    // cursor home, the text, then a window-title OSC.
    const raw =
      '\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[Hhello-from-pty\r\n' +
      '\u001b]0;C:\\WINDOWS\\SYSTEM32\\cmd.exe\u0007\u001b[?25h';
    expect(renderTerminalText(raw)).toBe('hello-from-pty\n');
  });

  it('shows a progress bar as the line it ended on, not forty times', () => {
    // A bare carriage return means the program went back to overwrite the line.
    expect(renderTerminalText('  1% |=         |\r 50% |=====    |\r100% |=========|\ndone\n')).toBe(
      '100% |=========|\ndone\n'
    );
  });

  it('does not mistake the carriage return of a CRLF line ending for an overwrite', () => {
    expect(renderTerminalText('first\r\nsecond\r\n')).toBe('first\nsecond\n');
  });
});

describe.runIf(IS_WINDOWS)('a real console', () => {
  it('is available in this build', async () => {
    // If this fails, the ConPTY binaries did not ship. Everything below would silently
    // fall back to pipes and prove nothing, so it is asserted rather than skipped around.
    expect(await ptyAvailable()).toBe(true);
  });

  it('gives the program a terminal, merges its streams, and resizes on request', async () => {
    // A piped PowerShell has no window to measure. Reporting exactly the size that was
    // asked for is the proof that a real console was attached rather than a pipe.
    const script = [
      '[Console]::Error.WriteLine("stderr-line")',
      'Write-Output ("width=" + $Host.UI.RawUI.WindowSize.Width)'
    ].join('; ');
    const started = await startManagedProcess(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NoExit', '-Command', script],
      cwd,
      undefined,
      { tty: true, cols: 100, rows: 30 }
    );

    expect(started.tty).toBe(true);
    expect(started.cols).toBe(100);
    expect(started.pid).toBeGreaterThan(0);

    // A console has one screen, so what the program wrote to stderr arrives on the same
    // stream, in the place it happened. There is no second stream to read.
    //
    // Waited on the *second* line, not the first: both are written back to back, and
    // returning as soon as `stderr-line` appeared raced the console into handing back a
    // buffer that legitimately did not have the width in it yet.
    const seen = await waitForOutput(started.id, 'width=', 'stdout', 8000);
    expect(seen.stderr).toBe('');
    expect(seen.stdout).toContain('stderr-line');
    expect(seen.stdout).toContain('width=100');
    // The escape sequences a console emits are stripped before the text is handed back.
    expect(seen.stdout).not.toContain('\u001b');

    const resized = resizeManagedProcess(started.id, 133, 41);
    expect(resized.cols).toBe(133);
    expect(resized.rows).toBe(41);
    await writeManagedProcess(started.id, '$Host.UI.RawUI.WindowSize.Width', true);
    // The program itself reports the new size, which is the only proof the resize reached it.
    const after = await waitForOutput(started.id, '133', 'stdout', 8000);
    expect(after.stdout).toContain('133');

    const stopped = await stopManagedProcess(started.id, 20);
    expect(stopped.running).toBe(false);
  });

  it('refuses to resize a process that has no console', async () => {
    const started = await startManagedProcess(node, ['-e', 'setInterval(() => {}, 1000)'], cwd);
    expect(started.tty).toBe(false);
    expect(() => resizeManagedProcess(started.id, 90, 30)).toThrow(/not attached to a console/);
    await stopManagedProcess(started.id, 1);
  });
});

/**
 * A quoted child command has to actually run, in a pipe and at a console alike.
 *
 * `node -e "console.log(123)"` produced nothing through `shell: 'cmd'`, and cmd exited 0
 * while doing it — so the call was reported as a success that had silently done nothing.
 * Two separate causes with one shape: Node escapes an inner `"` as `\"` when it builds a
 * Windows command line, and node-pty quotes an argument list its own way, and cmd.exe
 * reads neither convention. Both paths now hand it the line as written.
 */
describe.runIf(IS_WINDOWS)('a quoted command run through cmd', () => {
  const outputOf = async (script: string, tty: boolean): Promise<string> => {
    const started = await startManagedShellProcess(script, 'cmd', cwd, undefined, tty ? { tty: true } : undefined);
    const done = await waitManagedProcess(started.id, 8000);
    await stopManagedProcess(started.id, 20).catch(() => undefined);
    return done.stdout;
  };

  it('runs and reports its output through a pipe', async () => {
    expect(await outputOf('node -e "console.log(123)"', false)).toContain('123');
  });

  it('runs and reports its output at a console', async () => {
    if (!(await ptyAvailable())) return;
    expect(await outputOf('node -e "console.log(123)"', true)).toContain('123');
  });

  it('performs the side effect the call claimed to have performed', async () => {
    // How this was found: not by missing output, but by a file that was never written
    // behind an exit code of zero.
    const target = path.join(cwd, 'cmd-side-effect.txt');
    await outputOf(`node -e "require('fs').writeFileSync(process.argv[1], 'written')" ${JSON.stringify(target)}`, false);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('written');
  });

  it('performs the side effect at a console too', async () => {
    // The console path is a separate spawn with a separate quoter. node-pty takes either an
    // argument list, which it quotes for Windows itself, or a finished command line as one
    // string; cmd reads neither of the quoting conventions the list form produces, so this
    // path hands it the single-string form. Asserting output alone would not catch a
    // regression here: the failure mode is a clean exit that did nothing.
    if (!(await ptyAvailable())) return;
    const target = path.join(cwd, 'cmd-side-effect-tty.txt');
    await outputOf(`node -e "require('fs').writeFileSync(process.argv[1], 'written')" ${JSON.stringify(target)}`, true);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('written');
  });

  it('keeps quotes nested inside the child command intact at a console', async () => {
    if (!(await ptyAvailable())) return;
    expect(await outputOf(`node -e "console.log('a b')"`, true)).toContain('a b');
  });

  it('keeps quotes nested inside the child command intact', async () => {
    expect(await outputOf(`node -e "console.log('a b')"`, false)).toContain('a b');
  });

  it('still lets cmd read its own metacharacters', async () => {
    // The wrapping quotes are stripped by `/s` before cmd parses what is inside them, so
    // passing the line verbatim must not quietly demote the shell to a program launcher.
    expect(await outputOf('echo one| findstr one', false)).toContain('one');
    expect(await outputOf('echo %OS%', false)).toContain('Windows_NT');
  });
});
