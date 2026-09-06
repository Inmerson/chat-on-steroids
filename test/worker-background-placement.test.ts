import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Focused regression coverage for the fresh-worker placement path.
 *
 * The broader extension suite already proves that a live Prime can place a worker as an
 * inactive tab in its own Chrome window. This pins the remaining Chrome lifecycle guarantee:
 * an app-created tab that is intentionally never activated must be protected from automatic
 * discard before it has had a chance to redeem its command marker.
 */
describe('background worker placement', () => {
  it('protects the newly created inactive worker tab from Chrome auto-discard', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'extension', 'background.js'), 'utf8');
    const start = source.indexOf('async function placeBackgroundWorker');
    expect(start).toBeGreaterThanOrEqual(0);

    const end = source.indexOf('\n}\n\n/**', start);
    expect(end).toBeGreaterThan(start);
    const placement = source.slice(start, end + 2);

    expect(placement).toContain('const created = await chrome.tabs.create(create);');
    expect(placement).toContain('await chrome.tabs.update(created.id, { autoDiscardable: false });');
  });
});
