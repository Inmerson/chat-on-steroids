import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function updateDesktopShortcut() {
  if (process.platform !== 'win32') return;

  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (!userProfile) return;
  const desktop = path.join(userProfile, 'Desktop');
  if (!fs.existsSync(desktop)) return;

  const shortcutPath = path.join(desktop, 'Chat On Steroids.lnk');
  const releaseDir = path.join(root, 'release', 'win-unpacked');
  const exePath = path.join(releaseDir, 'Chat On Steroids.exe');
  const iconSource = path.join(root, 'build', 'icon.ico');
  const iconDest = path.join(releaseDir, 'app.ico');

  if (!fs.existsSync(exePath)) return;

  if (fs.existsSync(iconSource)) {
    try {
      fs.copyFileSync(iconSource, iconDest);
    } catch {}
  }

  const iconTarget = fs.existsSync(iconDest) ? `${iconDest},0` : `${exePath},0`;

  const vbsEscape = (str) => str.replace(/"/g, '""');

  const vbs = [
    'Set oWS = WScript.CreateObject("WScript.Shell")',
    `sLinkFile = "${vbsEscape(shortcutPath)}"`,
    'Set oLink = oWS.CreateShortcut(sLinkFile)',
    `oLink.TargetPath = "${vbsEscape(exePath)}"`,
    `oLink.WorkingDirectory = "${vbsEscape(releaseDir)}"`,
    `oLink.IconLocation = "${vbsEscape(iconTarget)}"`,
    'oLink.Save'
  ].join('\r\n');

  const vbsPath = path.join(releaseDir, 'update_shortcut.vbs');
  try {
    fs.writeFileSync(vbsPath, vbs);
    execFileSync('cscript', ['//nologo', vbsPath], { stdio: 'inherit' });
    fs.unlinkSync(vbsPath);
    console.log('Updated desktop shortcut to:', exePath);
  } catch (err) {
    console.error('Could not update desktop shortcut:', err.message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateDesktopShortcut();
}
