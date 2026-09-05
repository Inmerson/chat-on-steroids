import { describe, expect, it } from 'vitest';
import { parseRuntimeMode } from '../src/main/core/mode.js';

describe('Core helper runtime mode', () => {
  it('keeps ordinary launches in UI mode', () => {
    expect(parseRuntimeMode(['Chat On Steroids.exe'])).toEqual({ kind: 'ui' });
  });

  it('parses Core Host mode with its explicit user-data profile', () => {
    expect(parseRuntimeMode(['Chat On Steroids.exe', '--core-host', '--core-user-data', 'C:\\profile'])).toEqual({
      kind: 'core-host',
      userDataDir: 'C:\\profile'
    });
  });

  it('parses supervisor mode with the same profile', () => {
    expect(parseRuntimeMode(['Chat On Steroids.exe', '--core-supervisor', '--core-user-data', '/tmp/profile'])).toEqual({
      kind: 'core-supervisor',
      userDataDir: '/tmp/profile'
    });
  });

  it('fails closed when helper mode has no profile or two helper modes are requested', () => {
    expect(() => parseRuntimeMode(['cos.exe', '--core-host'])).toThrow(/user-data/i);
    expect(() => parseRuntimeMode(['cos.exe', '--core-host', '--core-supervisor', '--core-user-data', 'x'])).toThrow(/mode/i);
  });
});
