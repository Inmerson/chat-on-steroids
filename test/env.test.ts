/**
 * The child environment.
 *
 * These are regressions for a live incident, not hygiene. The installed 1.7 build spawned
 * every child with a `Path` of exactly
 * `C:\Users\…\ChatGPT Local Files\resources\rg;` — one directory, no System32, no Git, no
 * Node — while the machine's own registry path was healthy. `npm` was "not recognized",
 * `git` and `where.exe` and `powershell.exe` all failed ENOENT, and the visible Claude Code
 * process inherited the same crippled path.
 *
 * The cause was two characters of case. Windows environment names are case-insensitive and
 * the inherited path is spelled `Path`; `{ ...process.env }` produces a case-*sensitive*
 * object, so `env.PATH ?? ''` read as empty and the assignment created a second key. The
 * block handed to CreateProcess then contained `Path=<everything>` and `PATH=<rg only>`,
 * and the wrong one won.
 */

import { describe, expect, it } from 'vitest';
import {
  applyEnvOverrides,
  deleteEnvValue,
  ensureUsablePath,
  envValue,
  normalizeEnvironment,
  pathEntries,
  prependPath,
  setEnvValue
} from '../src/main/env.js';

/** A Windows environment as Windows actually spells it. */
const windowsEnv = (): Record<string, string> => ({
  Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
  SystemRoot: 'C:\\Windows',
  USERNAME: 'totec'
});

const pathKeys = (env: Record<string, string | undefined>): string[] =>
  Object.keys(env).filter((key) => key.toLowerCase() === 'path');

describe('the child environment', () => {
  it('reads the inherited path whatever Windows spelled it', () => {
    expect(envValue(windowsEnv(), 'PATH')).toBe('C:\\Windows\\System32;C:\\Program Files\\nodejs');
    expect(envValue({ PATH: '/usr/bin' }, 'Path')).toBe('/usr/bin');
    expect(envValue(windowsEnv(), 'systemroot')).toBe('C:\\Windows');
  });

  it('prepends the bundled tool directory without losing a single inherited entry', () => {
    // The live failure, exactly: this is the only thing the crippled child had left.
    const env = normalizeEnvironment(windowsEnv());
    prependPath(env, 'C:\\Program Files\\ChatGPT Local Files\\resources\\rg');

    expect(pathKeys(env)).toEqual(['Path']);
    expect(pathEntries(env)).toEqual([
      'C:\\Program Files\\ChatGPT Local Files\\resources\\rg',
      'C:\\Windows\\System32',
      'C:\\Program Files\\nodejs'
    ]);
  });

  it('never leaves two spellings of one variable behind', () => {
    const env = normalizeEnvironment(windowsEnv());
    setEnvValue(env, 'PATH', 'C:\\one');
    setEnvValue(env, 'path', 'C:\\two');

    expect(pathKeys(env)).toEqual(['Path']);
    expect(envValue(env, 'PATH')).toBe('C:\\two');
  });

  it('collapses a source that already holds both spellings, keeping the first with a value', () => {
    const env = normalizeEnvironment({ Path: 'C:\\real', PATH: 'C:\\rg-only' });
    expect(pathKeys(env)).toEqual(['Path']);
    expect(envValue(env, 'PATH')).toBe('C:\\real');

    const empty = normalizeEnvironment({ Path: '', PATH: 'C:\\rg-only' });
    expect(pathKeys(empty)).toEqual(['Path']);
    expect(envValue(empty, 'PATH')).toBe('C:\\rg-only');
  });

  it('applies a caller override onto the inherited spelling rather than beside it', () => {
    const env = normalizeEnvironment(windowsEnv());
    applyEnvOverrides(env, { PATH: 'C:\\only-this', Username: 'someone' });

    expect(pathKeys(env)).toEqual(['Path']);
    expect(envValue(env, 'path')).toBe('C:\\only-this');
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'username')).toEqual(['USERNAME']);
    expect(envValue(env, 'USERNAME')).toBe('someone');
  });

  it('removes every spelling of a secret, not just the one we happened to write', () => {
    const env = normalizeEnvironment({ Path: 'C:\\Windows\\System32', openai_api_key: 'sk-live' });
    deleteEnvValue(env, 'OPENAI_API_KEY');
    expect(envValue(env, 'openai_api_key')).toBeUndefined();
    expect(Object.keys(env)).toEqual(['Path']);
  });

  it('prepending twice does not grow the path', () => {
    const env = normalizeEnvironment(windowsEnv());
    prependPath(env, 'C:\\rg');
    prependPath(env, 'C:\\rg');
    expect(pathEntries(env).filter((entry) => entry === 'C:\\rg')).toHaveLength(1);
  });

  it('drops variables the parent had unset instead of writing them as "undefined"', () => {
    const env = normalizeEnvironment({ Path: 'C:\\Windows\\System32', GONE: undefined });
    expect('GONE' in env).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('a parent whose own path is unusable', () => {
  it('gives the child enough to find powershell and say what went wrong', () => {
    const env = normalizeEnvironment({ Path: 'C:\\rg;', SystemRoot: 'C:\\Windows' });
    ensureUsablePath(env);

    const entries = pathEntries(env).map((entry) => entry.toLowerCase());
    expect(entries[0]).toBe('c:\\rg');
    expect(entries).toContain('c:\\windows\\system32');
    expect(entries).toContain('c:\\windows\\system32\\windowspowershell\\v1.0');
    expect(pathKeys(env)).toEqual(['Path']);
  });

  it('leaves a fully equipped inherited path exactly as it found it', () => {
    const equipped =
      'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;' +
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\nodejs';
    const env = normalizeEnvironment({ ...windowsEnv(), Path: equipped });
    ensureUsablePath(env);
    expect(envValue(env, 'PATH')).toBe(equipped);
    expect(pathKeys(env)).toEqual(['Path']);
  });

  it('adds the rest of the Windows directories to a path that only has System32', () => {
    // System32 alone used to satisfy the check and return early, which is not the same
    // question. `where.exe` lives there, but `taskkill` needs nothing else while WMIC lives
    // in Wbem and powershell.exe in WindowsPowerShell\v1.0 — so a path this thin still
    // failed to start the very helpers the repair exists to guarantee.
    const env = normalizeEnvironment({ Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' });
    ensureUsablePath(env);

    const entries = pathEntries(env).map((entry) => entry.toLowerCase());
    // What the parent had stays where the parent put it; the repair only appends.
    expect(entries[0]).toBe('c:\\windows\\system32');
    expect(entries).toContain('c:\\windows');
    expect(entries).toContain('c:\\windows\\system32\\wbem');
    expect(entries).toContain('c:\\windows\\system32\\windowspowershell\\v1.0');
    expect(new Set(entries).size).toBe(entries.length);
    expect(pathKeys(env)).toEqual(['Path']);
  });
});
