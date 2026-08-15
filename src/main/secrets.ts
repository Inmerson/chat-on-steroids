/**
 * Secret storage backed by the OS.
 *
 * On Windows, Electron's safeStorage encrypts with DPAPI under the logged-in user's
 * credentials, so the ciphertext is useless to another account on the machine. The
 * plaintext key exists only inside the main process: it is never sent over IPC, never
 * written to config.json, and never logged. The renderer can only ask whether a key
 * is present.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { logError, logWarn } from './logger.js';

const FILE_NAME = 'secrets.bin';

let secretsPath = '';
let cache: Record<string, string> | null = null;
/**
 * Every mutation is a read-modify-write of one small encrypted blob. Saving the
 * OpenRouter key while the bridge token is being minted would otherwise have both calls
 * clone the same snapshot, and the later write would erase the other's key — as well as
 * racing on secrets.bin.tmp. Same shape as config.ts's queue, for the same reason.
 */
let mutationQueue: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation);
  mutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * `bridgeToken` is not a user credential: it is the bearer token the paired browser
 * extension presents. It lives here anyway so it is encrypted at rest and stays out of
 * config.json, the log and the renderer.
 */
export type SecretKey = 'openaiApiKey' | 'openrouterApiKey' | 'bridgeToken';

export function initSecretsPath(userDataDir: string): void {
  secretsPath = path.join(userDataDir, FILE_NAME);
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function readAll(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    const blob = await fs.readFile(secretsPath);
    const json = safeStorage.decryptString(blob);
    const parsed: unknown = JSON.parse(json);
    cache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // A decrypt failure usually means the file was copied from another machine
      // or another user account. Starting clean is the only safe recovery.
      logWarn('Stored credentials could not be decrypted and will be ignored');
    }
    cache = {};
  }
  return cache;
}

async function writeAll(values: Record<string, string>): Promise<void> {
  if (!isEncryptionAvailable()) {
    throw new Error('Windows credential encryption is unavailable, so the key was not saved');
  }
  const blob = safeStorage.encryptString(JSON.stringify(values));
  const tmp = `${secretsPath}.tmp`;
  await fs.mkdir(path.dirname(secretsPath), { recursive: true });
  await fs.writeFile(tmp, blob, { mode: 0o600 });
  await fs.rename(tmp, secretsPath);
  // Published only once the rename succeeded. A failed disk write must leave the
  // process believing the old state, not a credential it never actually saved.
  cache = values;
}

export async function getSecret(key: SecretKey): Promise<string | null> {
  const all = await readAll();
  const value = all[key];
  return value && value.length > 0 ? value : null;
}

export async function hasSecret(key: SecretKey): Promise<boolean> {
  return (await getSecret(key)) !== null;
}

export function setSecret(key: SecretKey, value: string): Promise<void> {
  return enqueue(async () => {
    // Read inside the queue, so this composes from the latest committed state rather
    // than from a snapshot taken before the call ahead of it finished.
    const all = { ...(await readAll()) };
    const trimmed = value.trim();
    if (trimmed === '') {
      delete all[key];
    } else {
      all[key] = trimmed;
    }
    await writeAll(all);
  });
}

export function clearSecret(key: SecretKey): Promise<void> {
  return setSecret(key, '');
}

export function deleteAllSecrets(): Promise<void> {
  return enqueue(async () => {
    try {
      await fs.rm(secretsPath, { force: true });
      cache = {};
    } catch (err) {
      logError(`Could not remove stored credentials: ${(err as Error).message}`);
    }
  });
}

/** Test seam: forgets the decrypted blob so the next read comes from disk. */
export function resetSecretsCacheForTests(): void {
  cache = null;
}
