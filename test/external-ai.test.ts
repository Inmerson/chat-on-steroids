import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  AI_CODING_BACKENDS,
  buildCodingBackendInvocation,
  resolveWindowsExternalCommand,
  runCodeRabbitReview,
  runCodingBackend,
  type ExternalCommandExecutor
} from '../src/main/orchestration/external-ai.js';
import { makeTempDir, removeTempDir } from './helpers.js';

describe('external AI coding backends', () => {
  it('keeps Roo-style multi-model routing to a small explicit backend vocabulary', () => {
    expect(AI_CODING_BACKENDS).toEqual(['codex', 'cursor', 'claude', 'copilot', 'gemini', 'opencode']);
    expect(buildCodingBackendInvocation('claude', 'fix the parser')).toEqual({
      file: 'claude',
      args: ['--output-format', 'text', '-p', 'fix the parser']
    });
    expect(buildCodingBackendInvocation('codex', 'fix the parser')).toEqual({
      file: 'codex',
      args: ['exec', 'fix the parser']
    });
    expect(buildCodingBackendInvocation('gemini', 'fix the parser')).toEqual({
      file: 'gemini',
      args: ['-p', 'fix the parser']
    });
    expect(buildCodingBackendInvocation('opencode', 'fix the parser')).toEqual({
      file: 'opencode',
      args: ['run', 'fix the parser']
    });
    expect(buildCodingBackendInvocation('cursor', 'fix the parser')).toEqual({
      file: 'agent',
      args: ['-p', 'fix the parser', '--output-format', 'text', '--trust']
    });
  });

  it('executes npm PowerShell shims directly through PowerShell instead of a command shell on Windows', async () => {
    const dir = await makeTempDir('clf-external-ai-shim-');
    try {
      const shim = path.join(dir, 'codex.ps1');
      await fs.writeFile(shim, 'Write-Output "shim"\n', 'utf8');

      const resolved = resolveWindowsExternalCommand(
        'codex',
        ['exec', 'fix & verify'],
        { PATH: dir },
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      );

      expect(resolved).toEqual({
        file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', shim, 'exec', 'fix & verify']
      });
    } finally {
      await removeTempDir(dir);
    }
  });

  it('finds official per-user Cursor and CodeRabbit install directories even before the parent process PATH reloads', async () => {
    const localAppData = await makeTempDir('clf-external-ai-localappdata-');
    try {
      const cursorDir = path.join(localAppData, 'cursor-agent');
      const codeRabbitDir = path.join(localAppData, 'Programs', 'coderabbit');
      await fs.mkdir(cursorDir, { recursive: true });
      await fs.mkdir(codeRabbitDir, { recursive: true });
      const agentShim = path.join(cursorDir, 'agent.ps1');
      const codeRabbitExe = path.join(codeRabbitDir, 'coderabbit.exe');
      await fs.writeFile(agentShim, 'Write-Output "agent"\n', 'utf8');
      await fs.writeFile(codeRabbitExe, '', 'utf8');

      expect(
        resolveWindowsExternalCommand(
          'agent',
          ['--version'],
          { PATH: '', LOCALAPPDATA: localAppData },
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        )
      ).toEqual({
        file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', agentShim, '--version']
      });
      expect(
        resolveWindowsExternalCommand('coderabbit', ['--version'], { PATH: '', LOCALAPPDATA: localAppData })
      ).toEqual({ file: codeRabbitExe, args: ['--version'] });
    } finally {
      await removeTempDir(localAppData);
    }
  });

  it('runs a selected coding backend without a shell and bounds/redacts returned output', async () => {
    const previous = process.env['EXTERNAL_AI_TEST_TOKEN'];
    process.env['EXTERNAL_AI_TEST_TOKEN'] = 'must-not-reach-agent';
    const executor = vi.fn<ExternalCommandExecutor>(async () => ({
      stdout: `done OPENAI_API_KEY=super-secret\n${'x'.repeat(60_000)}`,
      stderr: ''
    }));

    try {
      const result = await runCodingBackend(
        { backend: 'codex', cwd: 'C:\\repo', prompt: 'implement task 1' },
        executor
      );

      expect(executor).toHaveBeenCalledWith(
        'codex',
        ['exec', 'implement task 1'],
        expect.objectContaining({ cwd: 'C:\\repo', shell: false })
      );
      expect(executor.mock.calls[0]?.[2].env['EXTERNAL_AI_TEST_TOKEN']).toBeUndefined();
      expect(result.output).not.toContain('super-secret');
      expect(result.truncated).toBe(true);
      expect(result.output.length).toBeLessThanOrEqual(40_100);
    } finally {
      if (previous === undefined) delete process.env['EXTERNAL_AI_TEST_TOKEN'];
      else process.env['EXTERNAL_AI_TEST_TOKEN'] = previous;
    }
  });
});

describe('CodeRabbit review adapter', () => {
  it('uses agent-readable review output and the requested diff scope', async () => {
    const executor = vi.fn<ExternalCommandExecutor>(async () => ({ stdout: 'Warning: unsafe edge case', stderr: '' }));

    const result = await runCodeRabbitReview(
      { cwd: 'C:\\repo', scope: 'uncommitted', base: 'main' },
      executor
    );

    expect(executor).toHaveBeenCalledWith(
      'coderabbit',
      ['review', '--agent', '--dir', 'C:\\repo', '--uncommitted', '--base', 'main'],
      expect.objectContaining({ cwd: 'C:\\repo', shell: false })
    );
    expect(result.output).toContain('unsafe edge case');
    expect(result.binary).toBe('coderabbit');
  });

  it('falls back to the official cr alias only when coderabbit is not installed under its long name', async () => {
    const missing = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const executor = vi
      .fn<ExternalCommandExecutor>()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ stdout: 'clean', stderr: '' });

    const result = await runCodeRabbitReview({ cwd: 'C:\\repo', scope: 'all' }, executor);

    expect(executor.mock.calls.map((call) => call[0])).toEqual(['coderabbit', 'cr']);
    expect(result.binary).toBe('cr');
  });
});
