import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Real operating-system filesystem semantics for user-approved paths.
 *
 * Electron patches node:fs so any *.asar file looks like a virtual directory. That
 * behaviour is useful for loading the app itself but wrong for a general-purpose
 * filesystem connector: listing or stat'ing a user's archive must describe the real
 * file and must not open it as an Electron package. Electron exposes `original-fs`
 * specifically for the unpatched behaviour.
 *
 * Tests run under ordinary Node, where `original-fs` does not exist, so they use the
 * normal node:fs implementation. The runtime require is intentionally dynamic so the
 * build does not try to resolve Electron's special module at bundle time.
 */
const rawFs: typeof nodeFs = (() => {
  if (!process.versions.electron) return nodeFs;
  const runtimeRequire = createRequire(path.join(process.cwd(), '__clf_runtime__.cjs'));
  return runtimeRequire('original-fs') as typeof nodeFs;
})();

export const rawPromises = rawFs.promises;
export const rawCreateReadStream = rawFs.createReadStream;
