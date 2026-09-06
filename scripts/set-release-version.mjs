import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function assertReleaseVersion(value) {
  if (typeof value !== 'string' || !STABLE_RELEASE_VERSION.test(value)) {
    throw new Error(`Invalid release version: ${JSON.stringify(value)}`);
  }
  return value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function applyReleaseVersion(root, versionInput) {
  const version = assertReleaseVersion(versionInput);
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const manifestPath = path.join(root, 'extension', 'manifest.json');
  const appVersionPath = path.join(root, 'src', 'main', 'version.ts');

  const [pkg, lock, manifest, versionSource] = await Promise.all([
    readJson(packagePath),
    readJson(lockPath),
    readJson(manifestPath),
    readFile(appVersionPath, 'utf8')
  ]);

  if (!lock.packages || typeof lock.packages[''] !== 'object' || lock.packages[''] === null) {
    throw new Error('package-lock root package is missing');
  }

  const appVersionPattern = /export const APP_VERSION = '[^']+';/;
  if (!appVersionPattern.test(versionSource)) {
    throw new Error('src/main/version.ts has no APP_VERSION declaration');
  }

  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  manifest.version = version;
  const nextVersionSource = versionSource.replace(
    appVersionPattern,
    `export const APP_VERSION = '${version}';`
  );

  await Promise.all([
    writeJson(packagePath, pkg),
    writeJson(lockPath, lock),
    writeJson(manifestPath, manifest),
    writeFile(appVersionPath, nextVersionSource)
  ]);

  return version;
}

async function main() {
  const version = process.argv[2];
  if (!version) throw new Error('Usage: node scripts/set-release-version.mjs X.Y.Z');
  const applied = await applyReleaseVersion(process.cwd(), version);
  process.stdout.write(`Release version set to ${applied}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
