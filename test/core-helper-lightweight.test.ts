import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('disables hardware acceleration before Electron readiness in backend-only helper modes', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'bootstrap.ts'), 'utf8');
  const helperBoundary = source.indexOf("if (mode.kind === 'ui')");
  const disable = source.indexOf('app.disableHardwareAcceleration()', helperBoundary);
  const ready = source.indexOf('await app.whenReady()', helperBoundary);

  expect(disable).toBeGreaterThan(helperBoundary);
  expect(ready).toBeGreaterThan(disable);
});
