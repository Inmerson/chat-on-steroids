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
  MAX_UNIFIED_EXEC_PROCESSES,
  UNIFIED_EXEC_OUTPUT_MAX_BYTES
} from '../src/main/codex/unified-exec-constants.js';

const request = (manager: UnifiedExecProcessManager, script: string, yieldTimeMs = 5_000) => {
  const processId = manager.allocateProcessId();
  return manager.execCommand({
    command: [process.execPath, '-e', script],
    shellType: process.platform === 'win32' ? 'powershell' : 'bash',
    hookCommand: 'desktopcommander regression probe',
    processId,
    yieldTimeMs,
    maxOutputTokens: 30_000,
    truncationPolicy: { kind: 'tokens', tokens: 30_000 },
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env),
    tty: false
  });
};

describe('unified exec torture regressions', () => {
  const managers: UnifiedExecProcessManager[] = [];

  const manager = (): UnifiedExecProcessManager => {
    const instance = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
    managers.push(instance);
    return instance;
  };

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((instance) => instance.terminateAllProcesses()));
  });

  it('bounds a multi-megabyte single logical stdout line at the collection ceiling', async () => {
    const output = await request(
      manager(),
      `process.stdout.write('x'.repeat(${UNIFIED_EXEC_OUTPUT_MAX_BYTES * 3}));`
    );
    const text = execCommandResponseText(output);

    expect(output.exitCode).toBe(0);
    expect(output.outputOmittedBytes).not.toBeNull();
    expect(output.outputOmittedBytes).toBeGreaterThan(UNIFIED_EXEC_OUTPUT_MAX_BYTES);
    expect(output.rawOutput.length).toBeLessThanOrEqual(UNIFIED_EXEC_OUTPUT_MAX_BYTES + 128);
    expect(text).toContain('Warning: truncated output');
    expect(text).toMatch(/\.\.\. \d+ bytes omitted \.\.\./);
  }, 20_000);

  it('retains a final stderr sentinel and non-zero exit after concurrent stdout/stderr flood', async () => {
    const loops = MAX_UNIFIED_EXEC_PROCESSES * 4;
    const sentinel = 'FINAL-STDERR-SENTINEL';
    const script = [
      `for(let i=0;i<${loops};i++){process.stdout.write('out-'+i+'\\n');process.stderr.write('err-'+i+'\\n');}`,
      `process.stderr.write('${sentinel}\\n',()=>process.exit(23));`
    ].join('');

    const output = await request(manager(), script);

    expect(output.exitCode).toBe(23);
    expect(output.processId).toBeNull();
    expect(output.rawOutput.toString('utf8')).toContain(sentinel);
  }, 20_000);

  it('does not monopolize the event loop while collecting output beyond the cap', async () => {
    let floodComplete = false;
    const pending = request(
      manager(),
      `const chunk='q'.repeat(32768);const until=Date.now()+800;function pump(){if(Date.now()>=until){process.stdout.write('DONE\\n',()=>process.exit(0));return;}for(let i=0;i<8;i++){if(!process.stdout.write(chunk)){process.stdout.once('drain',pump);return;}}setImmediate(pump);}pump();`
    ).finally(() => {
      floodComplete = true;
    });

    const probeSawPendingFlood = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(!floodComplete), 350);
    });
    const output = await pending;

    expect(probeSawPendingFlood).toBe(true);
    expect(output.exitCode).toBe(0);
    expect(output.outputOmittedBytes).not.toBeNull();
    expect(output.rawOutput.length).toBeLessThanOrEqual(UNIFIED_EXEC_OUTPUT_MAX_BYTES + 128);
  }, 20_000);

  it('keeps text and structuredContent on the same omission/truncation evidence and exit state', () => {
    const output: ExecCommandToolOutput = {
      chunkId: 'torture-parity',
      wallTimeMs: 17,
      rawOutput: Buffer.from(`head\n${'p'.repeat(200_000)}\ntail`, 'utf8'),
      truncationPolicy: { kind: 'tokens', tokens: 30_000 },
      maxOutputTokens: 30_000,
      processId: null,
      exitCode: 29,
      originalTokenCount: 52_000,
      outputOmittedBytes: 8_192
    };
    const text = execCommandResponseText(output);
    const structured = execCommandStructuredOutput(output);
    const structuredOutput = String(structured.output);
    const omissionMarker = '... 8192 bytes omitted ...';

    expect(text).toContain('Process exited with code 29');
    expect(structured.exit_code).toBe(29);
    expect(text).toContain(structuredOutput);
    expect(text).toContain('Warning: truncated output');
    expect(structuredOutput).toContain('Warning: truncated output');
    expect(text).toContain(omissionMarker);
    expect(structuredOutput).toContain(omissionMarker);
  });
});
