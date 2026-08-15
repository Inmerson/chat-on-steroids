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

export type SecretKey = 'openaiApiKey';

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
  cache = values;
  const blob = safeStorage.encryptString(JSON.stringify(values));
  const tmp = `${secretsPath}.tmp`;
  await fs.mkdir(path.dirname(secretsPath), { recursive: true });
  await fs.writeFile(tmp, blob, { mode: 0o600 });
  await fs.rename(tmp, secretsPath);
}

export async function getSecret(key: SecretKey): Promise<string | null> {
  const all = await readAll();
  const value = all[key];
  return value && value.length > 0 ? value : null;
}

export async function hasSecret(key: SecretKey): Promise<boolean> {
  return (await getSecret(key)) !== null;
}

export async function setSecret(key: SecretKey, value: string): Promise<void> {
  const all = { ...(await readAll()) };
  const trimmed = value.trim();
  if (trimmed === '') {
    delete all[key];
  } else {
    all[key] = trimmed;
  }
  await writeAll(all);
}

export async function clearSecret(key: SecretKey): Promise<void> {
  await setSecret(key, '');
}

export async function deleteAllSecrets(): Promise<void> {
  cache = {};
  try {
    await fs.rm(secretsPath, { force: true });
  } catch (err) {
    logError(`Could not remove stored credentials: ${(err as Error).message}`);
  }
}
