import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { logInfo, logWarn } from './logger.js';

/**
 * Ensures the desktop shortcut points to the currently running executable with the proper icon.
 * This heals any stale shortcut paths on Windows automatically when the app starts up.
 */
export function ensureDesktopShortcut(isPackaged: boolean, execPath: string): void {
  if (process.platform !== 'win32' || !isPackaged) return;

  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (!userProfile) return;
  const desktopPath = path.join(userProfile, 'Desktop');
  if (!fs.existsSync(desktopPath)) return;

  const shortcutPath = path.join(desktopPath, 'Chat On Steroids.lnk');
  const appDir = path.dirname(execPath);
  const iconPath = path.join(appDir, 'app.ico');

  // If app.ico doesn't exist in the app directory, try copying from resources
  if (!fs.existsSync(iconPath)) {
    const candidateIcons = [
      path.join(appDir, 'resources', 'icon.ico'),
      path.join(appDir, 'resources', 'app.ico')
    ];
    for (const cand of candidateIcons) {
      if (fs.existsSync(cand)) {
        try {
          fs.copyFileSync(cand, iconPath);
          break;
        } catch {}
      }
    }
  }

  const targetIcon = fs.existsSync(iconPath) ? `${iconPath},0` : `${execPath},0`;

  const vbsEscape = (str: string) => str.replace(/"/g, '""');

  const vbsScript = [
    'Set oWS = WScript.CreateObject("WScript.Shell")',
    `sLinkFile = "${vbsEscape(shortcutPath)}"`,
    'Set oLink = oWS.CreateShortcut(sLinkFile)',
    `oLink.TargetPath = "${vbsEscape(execPath)}"`,
    `oLink.WorkingDirectory = "${vbsEscape(appDir)}"`,
    `oLink.IconLocation = "${vbsEscape(targetIcon)}"`,
    'oLink.Save'
  ].join('\r\n');

  const tmpVbs = path.join(appDir, 'update_shortcut_startup.vbs');
  try {
    fs.writeFileSync(tmpVbs, vbsScript);
    execFile('cscript', ['//nologo', tmpVbs], () => {
      try {
        if (fs.existsSync(tmpVbs)) fs.unlinkSync(tmpVbs);
      } catch {}
      logInfo('desktop shortcut verified and refreshed at startup');
    });
  } catch (err) {
    logWarn(`failed to verify desktop shortcut: ${(err as Error).message}`);
  }
}
