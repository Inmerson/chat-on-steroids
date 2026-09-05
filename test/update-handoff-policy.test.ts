import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ownsWindowsInstallation } from '../src/main/update/windows-installation.js';
import { windowsInstallPlan } from '../src/main/update/handoff-policy.js';
import { runInstallerHandoff } from '../src/main/update/handoff.js';

describe('Windows installation ownership', () => {
  it('recognizes an installed NSIS app by its adjacent electron-builder uninstaller', () => {
    const execPath = 'C:\\Users\\ibrahim\\AppData\\Local\\Programs\\Chat On Steroids\\Chat On Steroids.exe';
    const uninstaller = path.win32.join(path.win32.dirname(execPath), 'Uninstall Chat On Steroids.exe');
    const exists = vi.fn((candidate: string) => candidate === uninstaller);
    expect(ownsWindowsInstallation(execPath, exists)).toBe(true);
  });

  it('does not mistake win-unpacked for an installed application', () => {
    const execPath = 'C:\\work\\chat-on-steroids\\release\\win-unpacked\\Chat On Steroids.exe';
    expect(ownsWindowsInstallation(execPath, vi.fn(() => false))).toBe(false);
  });
});

describe('Windows installer policy', () => {
  it('uses a visible assisted upgrade for explicit install on a true NSIS installation', () => {
    expect(windowsInstallPlan({ explicit: true, ownsInstallation: true })).toEqual({
      launch: true,
      args: ['--updated'],
      windowsHide: false,
      mode: 'assisted-upgrade'
    });
  });

  it('uses a visible fresh-install wizard for explicit install from win-unpacked', () => {
    expect(windowsInstallPlan({ explicit: true, ownsInstallation: false })).toEqual({
      launch: true,
      args: [],
      windowsHide: false,
      mode: 'fresh-install'
    });
  });

  it('retains silent ordinary-quit upgrades only for a true installation', () => {
    expect(windowsInstallPlan({ explicit: false, ownsInstallation: true })).toEqual({
      launch: true,
      args: ['/S', '--updated'],
      windowsHide: true,
      mode: 'silent-upgrade'
    });
    expect(windowsInstallPlan({ explicit: false, ownsInstallation: false })).toEqual({
      launch: false,
      args: [],
      windowsHide: true,
      mode: 'none'
    });
  });
});

describe('PID-wait installer handoff', () => {
  it('waits for UI, Core Host and supervisor processes before launching visible NSIS', async () => {
    const remaining = new Map<number, number>([[1234, 2], [2222, 1], [3333, 3]]);
    const checked: number[] = [];
    const launch = vi.fn(async () => undefined);
    const sleeps: number[] = [];

    await runInstallerHandoff(
      {
        parentPid: 1234,
        waitPids: [2222, 3333],
        installerPath: 'C:\\updates\\Chat-On-Steroids-Setup-x64.exe',
        args: ['--updated'],
        windowsHide: false
      },
      {
        processExists: async (pid) => {
          checked.push(pid);
          const left = remaining.get(pid) ?? 0;
          remaining.set(pid, Math.max(0, left - 1));
          return left > 0;
        },
        sleep: async (ms) => { sleeps.push(ms); },
        launch
      }
    );

    expect(new Set(checked)).toEqual(new Set([1234, 2222, 3333]));
    expect(sleeps.length).toBeGreaterThan(0);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      'C:\\updates\\Chat-On-Steroids-Setup-x64.exe',
      ['--updated'],
      { windowsHide: false }
    );
  });

  it('refuses to launch if a process never exits before the bounded handoff deadline', async () => {
    let now = 0;
    const launch = vi.fn(async () => undefined);

    await expect(runInstallerHandoff(
      {
        parentPid: 1,
        waitPids: [2],
        installerPath: 'C:\\updates\\Setup.exe',
        args: [],
        windowsHide: false,
        pollIntervalMs: 100,
        maxWaitMs: 250
      },
      {
        processExists: async () => true,
        sleep: async (ms) => { now += ms; },
        now: () => now,
        launch
      }
    )).rejects.toThrow(/did not exit/i);
    expect(launch).not.toHaveBeenCalled();
  });

  it('permits the helper itself to be hidden without hiding an explicit installer', async () => {
    const launch = vi.fn(async () => undefined);
    await runInstallerHandoff(
      {
        parentPid: 1,
        installerPath: 'C:\\updates\\Setup.exe',
        args: [],
        windowsHide: false
      },
      { processExists: async () => false, sleep: async () => undefined, launch }
    );
    expect(launch).toHaveBeenCalledWith('C:\\updates\\Setup.exe', [], { windowsHide: false });
  });
});
