/**
 * Updater integration tests: published-file verification, durable staging and the final
 * platform handoff. Windows assertions deliberately stop at the helper boundary; the helper's
 * PID-wait/visibility contract lives in update-handoff-policy.test.ts.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface HandoffCall {
  parentPid: number;
  installerPath: string;
  args: string[];
  windowsHide: boolean;
  userDataDir: string;
}

const handoffs: HandoffCall[] = [];
vi.mock('../src/main/update/handoff.js', () => ({
  startWindowsInstallerHandoff: async (input: HandoffCall) => {
    handoffs.push({ ...input, args: [...input.args] });
  }
}));

let ownsInstallation = true;
vi.mock('../src/main/update/windows-installation.js', () => ({
  ownsWindowsInstallation: () => ownsInstallation
}));

let userData = '';
let packaged = true;
const relaunched: Array<{ execPath?: string }> = [];
vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    get isPackaged() {
      return packaged;
    },
    relaunch: (options: { execPath?: string }) => relaunched.push(options)
  }
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: () => undefined, logWarn: () => undefined }));

const { APP_VERSION } = await import('../src/main/version.js');
const { isNewer } = await import('../src/shared/types.js');
const {
  applyStagedUpdate,
  checkForUpdates,
  markInstallOnQuit,
  releaseVersion,
  resetUpdateForTests,
  stagedArtifact,
  updateStatus
} = await import('../src/main/update.js');

const NEXT = '99.0.0';
const WINDOWS_ASSET = `Chat-On-Steroids-Setup-${process.arch}.exe`;
const APPIMAGE_ASSET = `Chat-On-Steroids-Linux-${process.arch}.AppImage`;

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex');

function github(options: {
  version?: string;
  body?: string;
  checksums?: string;
  fail?: 'release' | 'sums' | 'asset';
} = {}) {
  const version = options.version ?? NEXT;
  const body = options.body ?? 'installer bytes';
  const sums = options.checksums ?? `${sha256(body)}  ${WINDOWS_ASSET}\n${sha256(body)}  ${APPIMAGE_ASSET}\n`;
  const asked: string[] = [];
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const name = url.split('/').pop()!;
    asked.push(name);
    if (url.includes('api.github.com')) {
      if (options.fail === 'release') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify({ tag_name: `v${version}` }), { status: 200 });
    }
    if (name === 'SHA256SUMS.txt') {
      if (options.fail === 'sums') return new Response('nope', { status: 404 });
      return new Response(sums, { status: 200 });
    }
    if (options.fail === 'asset') return new Response('nope', { status: 500 });
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return { asked, fetch, body };
}

async function asPlatform(platform: string, appImage: string | undefined, run: () => Promise<void>): Promise<void> {
  const realPlatform = process.platform;
  const realAppImage = process.env.APPIMAGE;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  if (appImage) process.env.APPIMAGE = appImage;
  else delete process.env.APPIMAGE;
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = realAppImage;
  }
}

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'cos-update-'));
  packaged = true;
  ownsInstallation = true;
  handoffs.length = 0;
  relaunched.length = 0;
  resetUpdateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which installations update themselves', () => {
  it('takes the Windows installer and the Linux AppImage, and nothing else', () => {
    expect(stagedArtifact('win32', 'x64')).toMatchObject({ name: 'Chat-On-Steroids-Setup-x64.exe', kind: 'installer' });
    expect(stagedArtifact('linux', 'arm64', '/opt/cos.AppImage')).toMatchObject({
      name: 'Chat-On-Steroids-Linux-arm64.AppImage',
      kind: 'appimage',
      target: '/opt/cos.AppImage'
    });
  });

  it('leaves a Linux package install and macOS to be updated by hand', async () => {
    expect(stagedArtifact('linux', 'x64', undefined)).toBeNull();
    expect(stagedArtifact('darwin', 'arm64')).toBeNull();
    expect(stagedArtifact('win32', 'ia32')).toBeNull();

    const { asked } = github();
    await asPlatform('linux', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
    expect(asked).toEqual(['latest']);
    await applyStagedUpdate();
    expect(handoffs).toEqual([]);
  });

  it('never stages for an unpackaged run', async () => {
    packaged = false;
    expect(stagedArtifact('win32', 'x64')).toBeNull();

    const { asked } = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
    expect(asked).toEqual(['latest']);
    await applyStagedUpdate();
    expect(handoffs).toEqual([]);
  });
});

describe('finding a newer release', () => {
  it('reads a release tag, and refuses anything that is not one', () => {
    expect(releaseVersion('v2.1.0')).toBe('2.1.0');
    expect(releaseVersion('2.1.0')).toBe('2.1.0');
    expect(releaseVersion('v2.1.0-rc.1')).toBeNull();
    expect(releaseVersion(null)).toBeNull();
  });

  it('compares versions as numbers, not as strings', () => {
    expect(isNewer('2.0.10', '2.0.9')).toBe(true);
    expect(isNewer('2.0.9', '2.0.10')).toBe(false);
    expect(isNewer('2.0.2', '2.0.2')).toBe(false);
    expect(isNewer('1.9.9', '2.0.0')).toBe(false);
  });

  it('reports nothing when the published release is the version already running', async () => {
    const { asked } = github({ version: APP_VERSION });
    expect(updateStatus().checkedAt).toBeNull();
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ current: APP_VERSION, latest: null, stage: 'idle' });
    expect(updateStatus().checkedAt).toBeGreaterThan(0);
    expect(asked).toEqual(['latest']);
    expect(readdirSync(userData)).toEqual([]);
  });
});

describe('staging the new version', () => {
  it('downloads the published artifact and hands an ordinary installed-Windows quit to a silent helper', async () => {
    const { asked, body } = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);

    const staged = path.join(userData, 'updates', NEXT, WINDOWS_ASSET);
    expect(readFileSync(staged, 'utf8')).toBe(body);
    expect(existsSync(`${staged}.part`)).toBe(false);

    await applyStagedUpdate();
    expect(handoffs).toEqual([
      {
        parentPid: process.pid,
        installerPath: staged,
        args: ['/S', '--updated'],
        windowsHide: true,
        userDataDir: userData
      }
    ]);
  });

  it('stages nothing when the artifact is not the file the release published', async () => {
    github({ checksums: `${sha256('a different build')}  ${WINDOWS_ASSET}\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus().stage).toBe('failed');
    expect(updateStatus().error).toContain('not the published file');
    expect(readdirSync(path.join(userData, 'updates', NEXT))).toEqual([]);

    await applyStagedUpdate();
    expect(handoffs).toEqual([]);
  });

  it('stages nothing when the release does not publish an artifact for this installation', async () => {
    github({ checksums: `${sha256('x')}  Chat-On-Steroids-Extension.zip\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('failed');
    expect(updateStatus().error).toContain(`publishes no ${WINDOWS_ASSET}`);
    expect(handoffs).toEqual([]);
  });

  it('replaces the running AppImage with the staged one', async () => {
    const live = path.join(userData, 'Chat-On-Steroids.AppImage');
    writeFileSync(live, 'the old build');
    const { body } = github();

    await asPlatform('linux', live, async () => {
      await checkForUpdates();
      expect(updateStatus().stage).toBe('ready');
      await applyStagedUpdate();
    });

    expect(readFileSync(live, 'utf8')).toBe(body);
    expect(existsSync(`${live}.new`)).toBe(false);
    expect(handoffs).toEqual([]);
  });
});

describe('installed Windows versus win-unpacked', () => {
  it('never silently installs a preview build on ordinary quit', async () => {
    ownsInstallation = false;
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    await applyStagedUpdate();

    expect(handoffs).toEqual([]);
  });

  it('hands an explicit preview install to a visible fresh-install wizard without --updated', async () => {
    ownsInstallation = false;
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();

    expect(handoffs).toEqual([
      {
        parentPid: process.pid,
        installerPath: path.join(userData, 'updates', NEXT, WINDOWS_ASSET),
        args: [],
        windowsHide: false,
        userDataDir: userData
      }
    ]);
  });
});

describe('one pass at a time, and one more next time the app opens', () => {
  it('joins a check that is already running instead of downloading twice', async () => {
    const { asked } = github();
    await asPlatform('win32', undefined, async () => {
      await Promise.all([checkForUpdates(), checkForUpdates(), checkForUpdates()]);
    });
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);
    expect(updateStatus().stage).toBe('ready');
  });

  it('retries the next time the app opens after a check that could not reach GitHub', async () => {
    github({ fail: 'release' });
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed', checkedAt: null });
    expect(updateStatus().error).toContain('503');

    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
  });

  it('retries the next time the app opens after a download that stopped', async () => {
    github({ fail: 'asset' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'failed' });

    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('ready');
  });

  it('does not download a version it has already staged', async () => {
    const first = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(first.asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);

    const second = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(second.asked).toEqual(['latest']);
    expect(updateStatus().stage).toBe('ready');
  });

  it('hands a staged update over exactly once', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    await applyStagedUpdate();
    await applyStagedUpdate();
    expect(handoffs).toHaveLength(1);
  });
});

describe('a download that survives the process that fetched it', () => {
  it('reuses the artifact a previous run already staged instead of fetching it again', async () => {
    const first = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(first.asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);

    resetUpdateForTests();
    const second = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(second.asked).toEqual(['latest', 'SHA256SUMS.txt']);
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });

    await applyStagedUpdate();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      installerPath: path.join(userData, 'updates', NEXT, WINDOWS_ASSET),
      args: ['/S', '--updated'],
      windowsHide: true
    });
  });

  it('fetches again when the artifact on disk is not what the release publishes', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    writeFileSync(path.join(userData, 'updates', NEXT, WINDOWS_ASSET), 'something else entirely');

    resetUpdateForTests();
    const second = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(second.asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);
    expect(updateStatus().stage).toBe('ready');
    expect(readFileSync(path.join(userData, 'updates', NEXT, WINDOWS_ASSET), 'utf8')).toBe(second.body);
  });

  it('keeps one version staged at a time', async () => {
    github({ version: '98.0.0' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(readdirSync(path.join(userData, 'updates'))).toEqual(['98.0.0']);

    resetUpdateForTests();
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(readdirSync(path.join(userData, 'updates'))).toEqual([NEXT]);
  });
});

describe('installing on request', () => {
  it('hands a true installed upgrade to a visible assisted installer only after shutdown', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();
    expect(handoffs).toEqual([
      {
        parentPid: process.pid,
        installerPath: path.join(userData, 'updates', NEXT, WINDOWS_ASSET),
        args: ['--updated'],
        windowsHide: false,
        userDataDir: userData
      }
    ]);
  });

  it('relaunches an AppImage install itself, having no installer to ask', async () => {
    const live = path.join(userData, 'Chat-On-Steroids.AppImage');
    writeFileSync(live, 'the old build');
    const { body } = github();

    await asPlatform('linux', live, async () => {
      await checkForUpdates();
      expect(markInstallOnQuit()).toBe(true);
      await applyStagedUpdate();
    });

    expect(readFileSync(live, 'utf8')).toBe(body);
    expect(relaunched).toEqual([{ execPath: live }]);
  });

  it('refuses when there is nothing downloaded to install', async () => {
    github({ version: APP_VERSION });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(markInstallOnQuit()).toBe(false);
  });

  it('does not carry the explicit request into the next ordinary quit', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();

    resetUpdateForTests();
    handoffs.length = 0;
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    await applyStagedUpdate();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ args: ['/S', '--updated'], windowsHide: true });
  });
});
