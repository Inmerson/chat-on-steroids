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
    const exists = vi.fn(() => false);

    expect(ownsWindowsInstallation(execPath, exists)).toBe(false);
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
  it('does not launch the visible installer until the old Electron PID is gone', async () => {
    let checks = 0;
    const launch = vi.fn(async () => undefined);
    const sleeps: number[] = [];

    await runInstallerHandoff(
      {
        parentPid: 1234,
        installerPath: 'C:\\updates\\Chat-On-Steroids-Setup-x64.exe',
        args: ['--updated'],
        windowsHide: false
      },
      {
        processExists: async () => ++checks < 3,
        sleep: async (ms) => { sleeps.push(ms); },
        launch
      }
    );

    expect(checks).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      'C:\\updates\\Chat-On-Steroids-Setup-x64.exe',
      ['--updated'],
      { windowsHide: false }
    );
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
      {
        processExists: async () => false,
        sleep: async () => undefined,
        launch
      }
    );

    expect(launch).toHaveBeenCalledWith('C:\\updates\\Setup.exe', [], { windowsHide: false });
  });
});
