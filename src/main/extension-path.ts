/**
 * Where the Chrome extension lives on this machine.
 *
 * Chrome loads an unpacked extension from a real folder, so the extension cannot live
 * inside the asar — it ships as an extraResource and is copied out verbatim by the
 * installer. That gives two locations: the repo's own `extension/` when running from a
 * checkout, and `resources/extension` in an installed build. The app has to be able to
 * point the user at whichever one is actually there, because "load unpacked from
 * extension/" is useless advice to someone who installed the .exe.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * The folder to open for chrome://extensions → Load unpacked, or null if it is missing.
 *
 * Packaged first: in an installed build the source tree is not present at all, and in a
 * dev run process.resourcesPath points into Electron's own resources, where there is no
 * extension folder — so the checkout path is what answers there.
 */
export function extensionDir(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'extension')]
    : [
        path.join(app.getAppPath(), 'extension'),
        path.join(process.cwd(), 'extension'),
        path.join(process.resourcesPath, 'extension')
      ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}
