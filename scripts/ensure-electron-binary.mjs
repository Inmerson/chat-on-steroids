import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Electron's package resolves the platform executable lazily. Multiple Vitest workers can import
// Electron-dependent modules at the same time after a clean install and race while populating
// node_modules/electron/dist. Resolve it once in this parent process before parallel tests start.
const executable = require('electron');
if (typeof executable !== 'string' || executable.length === 0) {
  throw new Error('Electron package did not resolve an executable path');
}

await access(executable);
process.stdout.write(`Electron binary ready: ${executable}\n`);
