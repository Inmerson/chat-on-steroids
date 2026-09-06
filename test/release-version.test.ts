import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyReleaseVersion, assertReleaseVersion } from '../scripts/set-release-version.mjs';

describe('release version preparation', () => {
  it('accepts only exact stable semver release versions', () => {
    expect(assertReleaseVersion('2.1.3')).toBe('2.1.3');
    for (const invalid of ['v2.1.3', '2.1', '2.1.3-beta.1', '../2.1.3', ' 2.1.3 ']) {
      expect(() => assertReleaseVersion(invalid)).toThrow(/release version/i);
    }
  });

  it('updates every authoritative version source without changing unrelated metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cos-release-version-'));
    await mkdir(path.join(root, 'extension'), { recursive: true });
    await mkdir(path.join(root, 'src', 'main'), { recursive: true });

    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'chat-on-steroids', version: '2.1.2', keep: true }, null, 2) + '\n');
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '2.1.2', lockfileVersion: 3, packages: { '': { name: 'chat-on-steroids', version: '2.1.2', keep: 'lock' } } }, null, 2) + '\n');
    await writeFile(path.join(root, 'extension', 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '2.1.2', name: 'companion' }, null, 2) + '\n');
    await writeFile(path.join(root, 'src', 'main', 'version.ts'), "export const APP_VERSION = '2.1.2';\nexport const BRIDGE_PROTOCOL = 10;\n");

    await applyReleaseVersion(root, '2.1.3');

    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
    const versionSource = await readFile(path.join(root, 'src', 'main', 'version.ts'), 'utf8');

    expect(pkg).toEqual({ name: 'chat-on-steroids', version: '2.1.3', keep: true });
    expect(lock.version).toBe('2.1.3');
    expect(lock.packages['']).toEqual({ name: 'chat-on-steroids', version: '2.1.3', keep: 'lock' });
    expect(manifest).toEqual({ manifest_version: 3, version: '2.1.3', name: 'companion' });
    expect(versionSource).toContain("APP_VERSION = '2.1.3'");
    expect(versionSource).toContain('BRIDGE_PROTOCOL = 10');
  });
});
