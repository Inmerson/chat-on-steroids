/**
 * Bundle a verified Windows ripgrep release for coding/search tools.
 *
 * Codex ships rg instead of depending on the user's PATH. We do the same: fetch the
 * official BurntSushi/ripgrep x86_64 MSVC zip, verify it against the release's own
 * .sha256 sidecar, flatten the archive and keep the upstream licenses beside rg.exe.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'resources', 'rg');
const cacheDir = path.join(root, 'node_modules', '.cache', 'ripgrep');
const say = (message) => process.stdout.write(`${message}\n`);

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'chatgpt-local-files-build' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function download(url, target) {
  if (existsSync(target)) return;
  const res = await fetch(url, { headers: { 'user-agent': 'chatgpt-local-files-build' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  const wanted = process.argv[2];
  const release = await json(
    wanted
      ? `https://api.github.com/repos/BurntSushi/ripgrep/releases/tags/${wanted}`
      : 'https://api.github.com/repos/BurntSushi/ripgrep/releases/latest'
  );
  const tag = String(release.tag_name).replace(/^v/, '');
  const assetName = `ripgrep-${tag}-x86_64-pc-windows-msvc.zip`;
  const asset = release.assets.find((item) => item.name === assetName);
  const checksumAsset = release.assets.find((item) => item.name === `${assetName}.sha256`);
  if (!asset || !checksumAsset) throw new Error(`Release ${tag} is missing ${assetName} or its .sha256 sidecar`);

  const stamp = path.join(outDir, 'VERSION');
  if (existsSync(stamp) && existsSync(path.join(outDir, 'rg.exe')) && (await readFile(stamp, 'utf8')).trim() === tag) {
    say(`ripgrep ${tag} already in resources/rg - nothing to do`);
    return;
  }

  await mkdir(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, assetName);
  const checksumPath = path.join(cacheDir, `${assetName}.sha256`);
  await download(asset.browser_download_url, zipPath);
  await download(checksumAsset.browser_download_url, checksumPath);

  const checksumText = await readFile(checksumPath, 'utf8');
  const expected = checksumText.match(/\b[0-9a-fA-F]{64}\b/)?.[0]?.toLowerCase();
  if (!expected) throw new Error(`Invalid checksum sidecar for ${assetName}`);
  const actual = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  if (actual !== expected) {
    await rm(zipPath, { force: true });
    throw new Error(`Checksum mismatch for ${assetName}\n  expected ${expected}\n  got      ${actual}`);
  }
  say(`ripgrep ${tag} checksum ok (${actual.slice(0, 16)}...)`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`],
    { stdio: 'inherit' }
  );

  const entries = await readdir(outDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(outDir, entries[0].name);
    for (const name of await readdir(inner)) {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Move-Item -LiteralPath '${path.join(inner, name)}' -Destination '${path.join(outDir, name)}' -Force`
      ]);
    }
    await rm(inner, { recursive: true, force: true });
  }

  if (!existsSync(path.join(outDir, 'rg.exe'))) throw new Error('rg.exe was not in the release archive');
  await writeFile(stamp, `${tag}\n`, 'utf8');
  say(`ripgrep ${tag} ready in resources/rg`);
}

main().catch((error) => {
  process.stderr.write(`\nCould not bundle ripgrep: ${error.message}\n`);
  process.exit(1);
});
