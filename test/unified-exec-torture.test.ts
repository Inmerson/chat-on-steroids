import { afterEach, describe, expect, it } from 'vitest';
import {
  UnifiedExecProcessManager,
  applyUnifiedExecEnv,
  execCommandResponseText,
  execCommandStructuredOutput,
  type ExecCommandToolOutput
} from '../src/main/codex/unified-exec.js';
import {
  DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
  UNIFIED_EXEC_OUTPUT_MAX_BYTES
} from '../src/main/codex/unified-exec-constants.js';

const truncationPolicy = { kind: 'tokens' as const, tokens: 30_000 };

describe('unified exec torture regressions', () => {
  const managers: UnifiedExecProcessManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.terminateAllProcesses()));
  });

  const run = async (script: string, yieldTimeMs = 5_000): Promise<ExecCommandToolOutput> => {
    const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
    managers.push(manager);
    const processId = manager.allocateProcessId();
    return manager.execCommand({
      command: [process.execPath, '-e', script],
      shellType: process.platform === 'win32' ? 'powershell' : 'bash',
      hookCommand: 'desktopcommander regression probe',
      processId,
      yieldTimeMs,
      maxOutputTokens: 30_000,
      truncationPolicy,
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });
  };

  it('bounds a multi-megabyte single logical stdout line at the collection ceiling', async () => {
    const output = await run(`process.stdout.write('x'.repeat(${UNIFIED_EXEC_OUTPUT_MAX_BYTES * 3}));`);

    expect(output.exitCode).toBe(0);
    expect(output.outputOmittedBytes).not.toBeNull();
    expect(output.outputOmittedBytes).toBeGreaterThan(UNIFIED_EXEC_OUTPUT_MAX_BYTES);
    expect(output.rawOutput.length).toBeLessThan(UNIFIED_EXEC_OUTPUT_MAX_BYTES + 100);

    const text = execCommandResponseText(output);
    expect(text).toContain('bytes omitted');
    expect(text).toContain('Warning: truncated output');
  }, 20_000);

  it('retains a final stderr sentinel and non-zero exit after concurrent stdout/stderr flood', async () => {
    const chunkBytes = 8 * 1024;
    const loops = 96;
    const script = [
      `const chunk='z'.repeat(${chunkBytes});`,
      `for(let i=0;i<${loops};i++){process.stdout.write('out-'+i+':'+chunk);process.stderr.write('err-'+i+':'+chunk);}`,
      `process.stderr.write('FINAL-STDERR-SENTINEL\\n',()=>process.exit(7));`
    ].join('');

    const output = await run(script);
    expect(output.exitCode).toBe(7);
    expect(output.outputOmittedBytes).not.toBeNull();
    expect(output.rawOutput.toString('utf8')).toContain('FINAL-STDERR-SENTINEL');
  }, 20_000);

  it('does not monopolize the event loop while collecting output beyond the cap', async () => {
    let timerRan = false;
    const pending = run(
      `let n=0;const chunk='q'.repeat(32768);const pump=()=>{for(let i=0;i<8;i++)process.stdout.write(chunk);if(++n<16)setImmediate(pump);else process.stdout.write('DONE\\n');};pump();`
    );
    setTimeout(() => {
      timerRan = true;
    }, 0);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(timerRan).toBe(true);

    const output = await pending;
    expect(output.exitCode).toBe(0);
    expect(output.outputOmittedBytes).not.toBeNull();
    expect(output.rawOutput.length).toBeLessThan(UNIFIED_EXEC_OUTPUT_MAX_BYTES + 100);
  }, 20_000);

  it('keeps text and structuredContent on the same omission/truncation evidence', async () => {
    const output = await run(`process.stdout.write('p'.repeat(${UNIFIED_EXEC_OUTPUT_MAX_BYTES * 2}));`);
    const text = execCommandResponseText(output);
    const structured = execCommandStructuredOutput(output);
    const visibleOutput = text.slice(text.indexOf('Output:\n') + 'Output:\n'.length);

    expect(output.exitCode).toBe(0);
    expect(structured.exit_code).toBe(0);
    expect(structured.output).toBe(visibleOutput);
    expect(String(structured.output)).toContain('bytes omitted');
    expect(String(structured.output)).toContain('Warning: truncated output');
  }, 20_000);
});
