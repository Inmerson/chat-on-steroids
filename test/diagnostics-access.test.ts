import { describe, expect, it } from 'vitest';
import { developerModeCheck } from '../src/main/diagnostics.js';

describe('connector access diagnostics', () => {
  it('flags a fresh connector request that arrives well after the last successful tool call', () => {
    const now = 1_000_000;
    const check = developerModeCheck(now - 5_000, now - 60_000, now);

    expect(check.status).toBe('not-run');
    expect(check.ok).toBeNull();
    expect(check.detail).toContain('after the last successful tool call');
    expect(check.detail).toContain('select or @mention');
    expect(check.detail).toContain('Developer mode');
  });

  it('still reports healthy when a tool call is current with the latest connector traffic', () => {
    const now = 1_000_000;
    const check = developerModeCheck(now - 5_000, now - 7_000, now);

    expect(check.status).toBe('pass');
    expect(check.ok).toBe(true);
  });
});
