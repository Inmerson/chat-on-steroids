import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { extractBundle, resolveGithub, installSource } from '../src/main/plugins/installer.js';
import { makeTempDir, removeTempDir } from './helpers.js';
let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('plugin-bundle-');
});
afterEach(async () => {
  await removeTempDir(dir);
});
const manifest = {
  manifest_version: '0.3',
  name: 'fixture',
  version: '1.0.0',
  description: 'MCP fixture',
  author: { name: 'CoS' },
  license: 'MIT',
  server: { type: 'node', entry_point: 'server.js', mcp_config: { command: 'node', args: ['${__dirname}/server.js'] } },
};
function zipEntries(bytes: Uint8Array) {
  const zip = Buffer.from(bytes);
  let end = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('test ZIP has no EOCD');
  const count = zip.readUInt16LE(end + 10);
  let central = zip.readUInt32LE(end + 16);
  const entries = new Map<string, { central: number; local: number; compressedSize: number; size: number }>();
  for (let index = 0; index < count; index++) {
    const nameLength = zip.readUInt16LE(central + 28);
    const extraLength = zip.readUInt16LE(central + 30);
    const commentLength = zip.readUInt16LE(central + 32);
    const name = zip.subarray(central + 46, central + 46 + nameLength).toString('utf8');
    entries.set(name, {
      central,
      local: zip.readUInt32LE(central + 42),
      compressedSize: zip.readUInt32LE(central + 20),
      size: zip.readUInt32LE(central + 24),
    });
    central += 46 + nameLength + extraLength + commentLength;
  }
  return { zip, entries };
}
it('imports and validates a real MCPB ZIP with upstream schema tooling', async () => {
  const file = path.join(dir, 'fixture.mcpb');
  await fs.writeFile(
    file,
    zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'server.js': strToU8('console.log(1)') }),
  );
  expect(await extractBundle(file, path.join(dir, 'extracted'))).toMatchObject({ name: 'fixture', version: '1.0.0' });
  expect(await fs.readFile(path.join(dir, 'extracted', 'server.js'), 'utf8')).toBe('console.log(1)');
});
it.each(['../escape', '/absolute', 'C:/drive', 'a\\escape', 'NUL.txt', 'trailing.'])(
  'rejects unsafe archive name %s before writing',
  async (name) => {
    const file = path.join(dir, 'bad.mcpb');
    await fs.writeFile(
      file,
      zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [name]: strToU8('unsafe') }),
    );
    await expect(extractBundle(file, path.join(dir, 'extracted'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'extracted'))).rejects.toThrow();
  },
);
it('rejects file/directory collisions and malformed manifests', async () => {
  const file = path.join(dir, 'bad.mcpb');
  await fs.writeFile(file, zipSync({ 'manifest.json': strToU8('{}'), a: strToU8('file'), 'a/b': strToU8('nested') }));
  await expect(extractBundle(file, path.join(dir, 'extracted'))).rejects.toThrow('collision');
});
it('rejects central-directory entries that alias another local compressed range', async () => {
  const file = path.join(dir, 'aliased-range.mcpb');
  const { zip, entries } = zipEntries(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'a.txt': strToU8('A'),
    'b.txt': strToU8('B'),
  }, { level: 0 }));
  const a = entries.get('a.txt')!, b = entries.get('b.txt')!;
  expect(a.compressedSize).toBe(b.compressedSize);
  expect(a.size).toBe(b.size);
  zip.writeUInt32LE(a.local, b.central + 42);
  await fs.writeFile(file, zip);
  await expect(extractBundle(file, path.join(dir, 'extracted'))).rejects.toThrow(/local|range|overlap/i);
  await expect(fs.stat(path.join(dir, 'extracted'))).rejects.toThrow();
});
it('rejects a local header whose compressed size disagrees with the central directory', async () => {
  const file = path.join(dir, 'local-size-mismatch.mcpb');
  const { zip, entries } = zipEntries(zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'a.txt': strToU8('A'),
  }, { level: 0 }));
  const a = entries.get('a.txt')!;
  zip.writeUInt32LE(a.compressedSize + 1, a.local + 18);
  await fs.writeFile(file, zip);
  await expect(extractBundle(file, path.join(dir, 'extracted'))).rejects.toThrow(/local|size|header/i);
  await expect(fs.stat(path.join(dir, 'extracted'))).rejects.toThrow();
});
it('resolves known GitHub recipes and explains unknown repositories', () => {
  expect(resolveGithub({ kind: 'github', url: 'https://github.com/ahujasid/blender-mcp' }).package).toBe('blender-mcp');
  expect(() => resolveGithub({ kind: 'github', url: 'https://github.com/example/unknown' })).toThrow(
    'no reviewed recipe',
  );
});
it('refuses installation package flags, URLs and floating versions', async () => {
  await expect(
    installSource({ kind: 'npm', package: '--prefix', version: 'latest' }, path.join(dir, 'install')),
  ).rejects.toThrow('package name');
  await expect(
    installSource({ kind: 'python', package: 'https://example.com', version: '1' }, path.join(dir, 'install')),
  ).rejects.toThrow('package name');
});
it.each([
  { package: '--index-url', version: '1.0.0' },
  { package: 'https://example.com/sdk', version: '1.0.0' },
  { package: 'mcp', version: '>=1,<2' },
  { package: 'mcp', version: 'latest' },
])('refuses unsafe or floating Python dependency pin %j before installation', async dependency => {
  await expect(installSource({ kind: 'python', package: 'mcp-server-fetch', version: '2025.4.7', dependencies: [dependency] }, path.join(dir, 'install'))).rejects.toThrow('Dependency pins need');
  await expect(fs.stat(path.join(dir, 'install'))).rejects.toThrow();
});
it('rejects ambiguous Python pins and pins attached to a different source kind', async () => {
  for (const dependencies of [
    [{ package: 'MCP.Server.Fetch', version: '2025.4.7' }],
    [{ package: 'some-sdk', version: '1.0.0' }, { package: 'Some_Sdk', version: '2.0.0' }],
  ]) await expect(installSource({ kind: 'python', package: 'mcp-server-fetch', version: '2025.4.7', dependencies }, path.join(dir, 'install'))).rejects.toThrow('repeat or replace');
  await expect(installSource({ kind: 'npm', package: 'fixture', version: '1.0.0', dependencies: [{ package: 'mcp', version: '1.30.0' }] }, path.join(dir, 'install'))).rejects.toThrow('Python source');
});
