export type WindowsInstallMode = 'assisted-upgrade' | 'fresh-install' | 'silent-upgrade' | 'none';

export interface WindowsInstallPlanInput {
  explicit: boolean;
  ownsInstallation: boolean;
}

export interface WindowsInstallPlan {
  launch: boolean;
  args: string[];
  windowsHide: boolean;
  mode: WindowsInstallMode;
}

/**
 * Keep product policy in one pure function so preview-vs-install and explicit-vs-quit cannot drift.
 *
 * A true installed upgrade is forced into electron-builder's current-user mode. That preserves the
 * per-user NSIS ownership/ACL contract even when a machine previously had an all-users install.
 * win-unpacked remains a fresh-install preview and therefore must not inherit update-only flags.
 */
export function windowsInstallPlan(input: WindowsInstallPlanInput): WindowsInstallPlan {
  if (input.explicit) {
    return input.ownsInstallation
      ? {
          launch: true,
          args: ['/currentuser', '--updated'],
          windowsHide: false,
          mode: 'assisted-upgrade'
        }
      : { launch: true, args: [], windowsHide: false, mode: 'fresh-install' };
  }

  if (input.ownsInstallation) {
    return {
      launch: true,
      args: ['/S', '/currentuser', '--updated'],
      windowsHide: true,
      mode: 'silent-upgrade'
    };
  }

  return { launch: false, args: [], windowsHide: true, mode: 'none' };
}
