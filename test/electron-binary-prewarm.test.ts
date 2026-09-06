import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Electron binary bootstrap', () => {
  it('warms the Electron binary in one process before parallel verification starts', () => {
    const warm = spawnSync(process.execPath, ['scripts/ensure-electron-binary.mjs'], {
      cwd: root,
      encoding: 'utf8'
    });

    expect(warm.status, `${warm.stdout}\n${warm.stderr}`).toBe(0);
    expect(warm.stdout).toMatch(/Electron binary ready/);

    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['verify:ci']).toMatch(
      /^node scripts\/ensure-electron-binary\.mjs && npm run rg &&/
    );
  });
});
