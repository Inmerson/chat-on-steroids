import { existsSync } from 'node:fs';
import path from 'node:path';

export type Exists = (candidate: string) => boolean;

/**
 * `app.isPackaged` means Electron is running bundled output; it does not mean NSIS owns the
 * executable. electron-builder places this uninstaller beside the installed executable even when
 * the user chooses a custom installation directory, while `win-unpacked` has no such owner.
 */
export function ownsWindowsInstallation(execPath: string, exists: Exists = existsSync): boolean {
  if (!execPath) return false;
  const directory = path.win32.dirname(execPath);
  return exists(path.win32.join(directory, 'Uninstall Chat On Steroids.exe'));
}
