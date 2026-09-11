import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('background model catalog forwarding', () => {
  it('forwards only a live pending catalog request to the exact current document', () => {
    const source = readFileSync(path.join(process.cwd(), 'extension', 'background.js'), 'utf8');

    expect(source).toContain('function forwardPendingModelCatalog(source)');
    expect(source).toContain('let pendingModelCatalogWork = null;');
    expect(source).toContain('if (pendingModelCatalogWork) return pendingModelCatalogWork;');
    expect(source).toContain("const status = await call('/status');");
    expect(source).toContain("type: 'clf-model-catalog'");
    expect(source).toContain('documentId: source.documentId');
    expect(source.match(/if \(!ownsDocument\(source\)\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('void forwardPendingModelCatalog(source).catch(() => undefined);');
  });
});

describe('background durable loop snapshots', () => {
  it('preserves managed autonomous_swarm and ralph execution modes across rollover recovery', () => {
    const source = readFileSync(path.join(process.cwd(), 'extension', 'background.js'), 'utf8');

    expect(source).toContain("['standard', 'infinite', 'autonomous_swarm', 'ralph'].includes(value.mode)");
  });
});
