/**
 * Downloads the current tunnel-client release into resources/tunnel/ so the
 * installer can ship it.
 *
 * Bundling it is what makes the app work the moment it is installed, instead of
 * sending the user to a GitHub releases page in the middle of setup. Nothing is
 * vendored into the repository: the release is fetched at build time, its SHA-256 is
 * checked against the SHA256SUMS.txt published alongside it, and the download is
 * cached so repeat builds do not re-fetch 26 MB.
 *
 * tunnel-client is Apache-2.0, so its LICENSE is copied next to the binaries.
 *
 *   node scripts/fetch-tunnel-client.mjs           latest release
 *   node scripts/fetch-tunnel-client.mjs v0.0.11   a specific one
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'resources', 'tunnel');
const cacheDir = path.join(root, 'node_modules', '.cache', 'tunnel-client');
const PLATFORM = 'windows-amd64';

const say = (message) => process.stdout.write(`${message}\n`);

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'chatgpt-local-files-build' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const wanted = process.argv[2];
  const release = await json(
    wanted
      ? `https://api.github.com/repos/openai/tunnel-client/releases/tags/${wanted}`
      : 'https://api.github.com/repos/openai/tunnel-client/releases/latest'
  );
  const tag = release.tag_name;
  const assetName = `tunnel-client-${tag}-${PLATFORM}.zip`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) throw new Error(`Release ${tag} has no ${assetName}`);

  const stamp = path.join(outDir, 'VERSION');
  if (existsSync(stamp) && (await readFile(stamp, 'utf8')).trim() === tag) {
    say(`tunnel-client ${tag} already in resources/tunnel — nothing to do`);
    return;
  }

  await mkdir(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, assetName);

  if (!existsSync(zipPath)) {
    say(`downloading ${assetName} (${(asset.size / 1e6).toFixed(1)} MB)…`);
    const res = await fetch(asset.browser_download_url, {
      headers: { 'user-agent': 'chatgpt-local-files-build' }
    });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
  }

  // The publisher's own checksum file is the only thing that makes an unsigned
  // download safe to ship inside our installer.
  const sumsAsset = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
  if (!sumsAsset) throw new Error(`Release ${tag} publishes no SHA256SUMS.txt`);
  const sums = await fetch(sumsAsset.browser_download_url, {
    headers: { 'user-agent': 'chatgpt-local-files-build' }
  }).then((r) => r.text());
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, '') === assetName)?.[0];
  if (!expected) throw new Error(`SHA256SUMS.txt does not list ${assetName}`);

  const actual = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  if (actual !== expected) {
    await rm(zipPath, { force: true });
    throw new Error(`Checksum mismatch for ${assetName}\n  expected ${expected}\n  got      ${actual}`);
  }
  say(`checksum ok (${actual.slice(0, 16)}…)`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  // Expand-Archive ships with Windows, so the build needs no unzip dependency.
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`],
    { stdio: 'inherit' }
  );

  // Some releases wrap everything in a single folder; flatten it if so.
  const entries = await readdir(outDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(outDir, entries[0].name);
    for (const name of await readdir(inner)) {
      await execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Move-Item -LiteralPath '${path.join(inner, name)}' -Destination '${path.join(outDir, name)}' -Force`
      ]);
    }
    await rm(inner, { recursive: true, force: true });
  }

  if (!existsSync(path.join(outDir, 'tunnel-client.exe'))) {
    throw new Error('tunnel-client.exe was not in the archive');
  }
  await writeFile(stamp, `${tag}\n`, 'utf8');
  say(`tunnel-client ${tag} ready in resources/tunnel`);
}

main().catch((err) => {
  process.stderr.write(`\nCould not bundle tunnel-client: ${err.message}\n`);
  process.exit(1);
});
