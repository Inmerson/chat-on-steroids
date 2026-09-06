/**
 * Secret storage backed by the OS.
 *
 * Electron safeStorage delegates to the host OS: DPAPI on Windows, Keychain on macOS,
 * and a desktop secret store such as libsecret/KWallet on Linux. The plaintext key exists
 * only inside the main process: it is never sent over renderer IPC, never written to config.json,
 * and never logged. Linux's `basic_text` fallback is deliberately rejected below because
 * presenting obfuscation as credential encryption would weaken the app on the new port.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { SecureStorageInfo } from '../shared/types.js';
import { logError, logWarn } from './logger.js';

const FILE_NAME = 'secrets.bin';
const LINUX_BASIC_TEXT_PREFIX = Buffer.from('v10', 'ascii');
const LINUX_STORAGE_PROBE = 'chat-on-steroids-safe-storage-probe';
const UI_CLIENT_MODE = process.env.COS_CORE_UI_CLIENT === '1';

let secretsPath = '';
let cache: Record<string, string> | null = null;
/** A successful decrypt asked us to reseal the blob with the current async key. */
let rotationPending = false;
/** Invalidates a decrypt that started before an explicit store reset/delete boundary. */
let loadGeneration = 0;
/**
 * Coalesces concurrent cache misses into one disk/keyring read.
 *
 * Async safeStorage makes a load genuinely long-lived: without a single-flight promise, a
 * read-only getSecret() and a queued setSecret() can both decrypt the old blob, the mutation
 * can commit a new blob, and then the slower read can publish its old snapshot back into cache.
 * The next mutation would then compose from stale credentials and could erase the just-written
 * value. One authoritative load shared by all callers closes that race at its source.
 */
let loadInFlight: Promise<Record<string, string>> | null = null;
/**
 * Every mutation is a read-modify-write of one small encrypted blob. Saving the OpenAI key
 * while the bridge token is being minted would otherwise have both calls clone the same
 * snapshot, and the later write would erase the other's key — as well as racing on
 * secrets.bin.tmp. Same shape as config.ts's queue, for the same reason.
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
/**
 * `bridgeToken` is not a user credential either way; `openRouterApiKey` is one, and is the
 * only credential in here that a *model* can cause to be spent, so it lives under the same
 * OS-backed encrypted blob as the rest and never leaves the main process.
 */
export type SecretKey = 'openaiApiKey' | 'bridgeToken' | 'openRouterApiKey';
type UserApiSecretKey = Exclude<SecretKey, 'bridgeToken'>;

function isUserApiSecretKey(key: SecretKey): key is UserApiSecretKey {
  return key === 'openaiApiKey' || key === 'openRouterApiKey';
}

export function initSecretsPath(userDataDir: string): void {
  secretsPath = path.join(userDataDir, FILE_NAME);
}

/**
 * Electron 43's Linux async safeStorage stack always includes Chromium's PosixKeyProvider as
 * its last-resort provider. That provider is deliberately sync-compatible `v10` encryption and
 * uses Chromium's public hard-coded "peanuts" key. `getSelectedStorageBackend()` describes the
 * legacy/selected desktop backend, not which async provider actually supplied a key, so a GNOME
 * session whose Secret Service is down can still report `gnome_libsecret` while async encryption
 * silently falls back to `v10`. The bytes are the authority.
 */
export function secureStorageCiphertextIsProtected(
  encrypted: Buffer,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'linux' || !encrypted.subarray(0, LINUX_BASIC_TEXT_PREFIX.length).equals(LINUX_BASIC_TEXT_PREFIX);
}

export async function secureStorageStatus(platform: NodeJS.Platform = process.platform): Promise<SecureStorageInfo> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return {
        available: false,
        detail:
          platform === 'linux'
            ? 'Secure credential storage is unavailable. Start or unlock a Linux desktop keyring/Secret Service (for example GNOME Keyring or KWallet), then try again.'
            : platform === 'darwin'
              ? 'macOS Keychain credential storage is unavailable. Unlock the login keychain, then try again.'
              : 'Secure operating-system credential storage is unavailable on this machine.'
      };
    }
    if (platform === 'linux') {
      // Probe the provider Electron actually chose, not only the desktop/backend label above.
      // The probe contains no credential and is never persisted.
      const probe = await safeStorage.encryptStringAsync(LINUX_STORAGE_PROBE);
      if (!secureStorageCiphertextIsProtected(probe, platform)) {
        return {
          available: false,
          detail:
            'Linux secure storage fell back to Electron’s insecure hard-coded-key provider. Start or unlock a desktop keyring/Secret Service (for example GNOME Keyring or KWallet), then restart Chat On Steroids.'
        };
      }
    }
    return { available: true, detail: null };
  } catch {
    return { available: false, detail: 'Secure operating-system credential storage could not be initialized.' };
  }
}

export async function isEncryptionAvailable(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return (await secureStorageStatus(platform)).available;
}

/**
 * A decrypt succeeding proves only that the host key was usable, not that the plaintext is a
 * secret-store snapshot this version can safely rewrite. Treat malformed shapes/values like any
 * other non-authoritative read: callers may degrade to "no credential", but a later mutation
 * must not compose from `{}` and destroy ciphertext whose contents we did not understand.
 *
 * Unknown string-valued fields are deliberately preserved for forward compatibility. The store
 * is a tiny string map, so a future release can add a key without an older build deleting it.
 */
function parseSecretStore(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored credential payload is not an object');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`Stored credential field ${key} is not a string`);
  }
  return parsed as Record<string, string>;
}

async function loadAll(): Promise<Record<string, string>> {
  const generation = loadGeneration;
  if (!(await isEncryptionAvailable())) return {};
  try {
    const blob = await fs.readFile(secretsPath);
    if (!secureStorageCiphertextIsProtected(blob)) {
      logWarn('Stored Linux credentials use Electron’s insecure hard-coded-key fallback; the file was left untouched');
      rotationPending = false;
      return {};
    }
    const decrypted = await safeStorage.decryptStringAsync(blob);
    const parsed = parseSecretStore(decrypted.result);
    if (generation !== loadGeneration) return cache ?? {};
    cache = parsed;
    rotationPending = decrypted.shouldReEncrypt;
  } catch (err) {
    if (generation !== loadGeneration) return cache ?? {};
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      cache = {};
      rotationPending = false;
    } else {
      const available = await isEncryptionAvailable();
      logWarn(
        available
          ? 'Stored credentials could not be decrypted; the encrypted file was left untouched'
          : 'Stored credentials are temporarily unavailable because secure storage could not decrypt them'
      );
      rotationPending = false;
      return {};
    }
  }
  return cache;
}

async function readAll(): Promise<Record<string, string>> {
  if (cache) return cache;
  if (loadInFlight) return loadInFlight;
  const load = loadAll();
  loadInFlight = load;
  try {
    return await load;
  } finally {
    if (loadInFlight === load) loadInFlight = null;
  }
}

async function writeAll(values: Record<string, string>): Promise<void> {
  if (!(await isEncryptionAvailable())) {
    throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
  }
  const blob = await safeStorage.encryptStringAsync(JSON.stringify(values));
  if (!secureStorageCiphertextIsProtected(blob)) {
    throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
  }
  const tmp = `${secretsPath}.tmp`;
  await fs.mkdir(path.dirname(secretsPath), { recursive: true });
  await fs.writeFile(tmp, blob, { mode: 0o600 });
  await fs.rename(tmp, secretsPath);
  cache = values;
  rotationPending = false;
}

async function rotateIfNeeded(): Promise<void> {
  if (!rotationPending || cache === null) return;
  await enqueue(async () => {
    if (!rotationPending || cache === null) return;
    try {
      await writeAll({ ...cache });
    } catch (err) {
      logWarn(`Stored credentials could not be re-encrypted with the current secure-storage key: ${(err as Error).message}`);
    }
  });
}

export async function getSecret(key: SecretKey): Promise<string | null> {
  const all = await readAll();
  const value = all[key];
  await rotateIfNeeded();
  return value && value.length > 0 ? value : null;
}

export async function hasSecret(key: SecretKey): Promise<boolean> {
  if (UI_CLIENT_MODE && isUserApiSecretKey(key)) {
    const { uiConnectionFacade } = await import('./core/ui-connection.js');
    const status = await uiConnectionFacade().secretStatus();
    return key === 'openaiApiKey' ? status.hasApiKey : status.hasGoalKey;
  }
  return (await getSecret(key)) !== null;
}

export function setSecret(key: SecretKey, value: string): Promise<void> {
  if (UI_CLIENT_MODE && isUserApiSecretKey(key)) {
    return import('./core/ui-connection.js').then(async ({ uiConnectionFacade }) => {
      await uiConnectionFacade().setSecret(key, value);
      // UI readers such as the OpenRouter model catalogue still decrypt locally today. Forget any
      // old snapshot so their next read observes the Core-owned write instead of stale plaintext.
      loadGeneration += 1;
      cache = null;
      rotationPending = false;
      loadInFlight = null;
    });
  }
  return enqueue(async () => {
    if (!(await isEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
    }
    const current = await readAll();
    if (cache === null) {
      throw new Error('Secure OS credential storage is unavailable, so the key was not saved');
    }
    const all = { ...current };
    const trimmed = value.trim();
    if (trimmed === '') delete all[key];
    else all[key] = trimmed;
    await writeAll(all);
  });
}

export function clearSecret(key: SecretKey): Promise<void> {
  return setSecret(key, '');
}

export function deleteAllSecrets(): Promise<void> {
  return enqueue(async () => {
    loadGeneration += 1;
    rotationPending = false;
    cache = null;
    try {
      await fs.rm(secretsPath, { force: true });
      cache = {};
    } catch (err) {
      logError(`Could not remove stored credentials: ${(err as Error).message}`);
      throw err;
    }
  });
}

/** Test seam: forgets the decrypted blob so the next read comes from disk. */
export function resetSecretsCacheForTests(): void {
  loadGeneration += 1;
  cache = null;
  rotationPending = false;
  loadInFlight = null;
}
