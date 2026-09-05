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

/** Keep product policy in one pure function so preview-vs-install and explicit-vs-quit cannot drift. */
export function windowsInstallPlan(input: WindowsInstallPlanInput): WindowsInstallPlan {
  if (input.explicit) {
    return input.ownsInstallation
      ? { launch: true, args: ['--updated'], windowsHide: false, mode: 'assisted-upgrade' }
      : { launch: true, args: [], windowsHide: false, mode: 'fresh-install' };
  }

  if (input.ownsInstallation) {
    return { launch: true, args: ['/S', '--updated'], windowsHide: true, mode: 'silent-upgrade' };
  }

  return { launch: false, args: [], windowsHide: true, mode: 'none' };
}
