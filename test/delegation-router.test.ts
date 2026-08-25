import { describe, expect, it } from 'vitest';
import { routeAntigravityInvestigation } from '../src/main/delegation-router.js';

describe('Antigravity delegation router', () => {
  it('delegates broad root-cause reconnaissance', () => {
    const decision = routeAntigravityInvestigation('Trace why MCP state becomes stale across multiple files.');
    expect(decision.delegated).toBe(true);
    expect(decision.score).toBeGreaterThanOrEqual(3);
    expect(decision.hardBlocked).toBe(false);
  });

  it('keeps trivial exact lookups with Prime', () => {
    const decision = routeAntigravityInvestigation('Read the npm package name from package.json.');
    expect(decision.delegated).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/directly|lookup/i);
  });

  it('hard-blocks mutation and final verification', () => {
    expect(routeAntigravityInvestigation('Implement the fix across src/main.').hardBlocked).toBe(true);
    expect(routeAntigravityInvestigation('Run final verification and deploy it.').hardBlocked).toBe(true);
  });

  it('still delegates read-only investigation of a release-build failure', () => {
    const decision = routeAntigravityInvestigation(
      'Investigate why the release build fails across the execution path; read-only root-cause analysis.'
    );
    expect(decision.delegated).toBe(true);
    expect(decision.hardBlocked).toBe(false);
  });

  it('allows security root-cause reconnaissance when no mutation is requested', () => {
    const decision = routeAntigravityInvestigation(
      'Investigate the root cause of the auth race across request correlation and session lifecycle; read-only.'
    );
    expect(decision.delegated).toBe(true);
    expect(decision.hardBlocked).toBe(false);
  });
});
