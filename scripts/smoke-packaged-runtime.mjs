import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repository = path.resolve(import.meta.dirname, '..');
const packageRoot = path.resolve(process.argv[2] ?? path.join(repository, 'release', 'win-unpacked'));
const electron = path.join(repository, 'node_modules', 'electron', 'dist', 'electron.exe');
const expectedVersion = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8')).version;

const requiredFiles = [
  'resources/app.asar',
  'resources/extension/manifest.json',
  'resources/extension/background.js',
  'resources/extension/content.js',
  'resources/extension/fiber.js',
  'resources/tunnel/tunnel-client.exe',
  'resources/tunnel/cloudflared.exe',
  'resources/tunnel/VERSION',
  'resources/rg/rg.exe',
  'resources/rg/VERSION'
];
for (const relative of requiredFiles) {
  const target = path.join(packageRoot, ...relative.split('/'));
  if (!statSync(target).isFile()) throw new Error(`Packaged runtime is missing ${relative}`);
}
const extensionManifest = JSON.parse(
  readFileSync(path.join(packageRoot, 'resources', 'extension', 'manifest.json'), 'utf8')
);
if (extensionManifest.version !== expectedVersion) {
  throw new Error(`Packaged extension ${extensionManifest.version} does not match app ${expectedVersion}`);
}
const probe = String.raw`
(async () => {
  const sharp = require('./resources/app.asar/node_modules/sharp');
  const pty = require('./resources/app.asar/node_modules/node-pty');
  const manifest = require('./resources/app.asar/package.json');
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } }
  }).png().toBuffer();
  console.log(JSON.stringify({
    version: manifest.version,
    sharp: sharp.versions.sharp,
    libvips: sharp.versions.vips,
    pngBytes: png.length,
    ptySpawn: typeof pty.spawn
  }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`;

const result = spawnSync(electron, ['-e', probe], {
  cwd: packageRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true
});

if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exitCode = result.status ?? 1;
else {
  const runtime = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  if (runtime.version !== expectedVersion) {
    throw new Error(`Packaged app ${runtime.version} does not match expected ${expectedVersion}`);
  }
  if (runtime.ptySpawn !== 'function' || !runtime.sharp || !runtime.libvips || runtime.pngBytes <= 0) {
    throw new Error('Packaged native runtime probe returned incomplete results');
  }
  process.stdout.write(`Packaged resources and native runtimes verified for ${expectedVersion}.\n`);
}
