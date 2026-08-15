/**
 * Non-secret settings, stored as one small JSON file in the app's userData folder.
 * No database: there are at most a handful of roots and a dozen booleans.
 *
 * Everything read from disk is re-validated, because a hand-edited or corrupted file
 * must not be able to widen permissions or smuggle in a root that was never approved.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  WRITE_CAPABILITIES,
  type Capabilities,
  type CompactionSettings,
  type Config,
  type MultiAgentSettings,
  type SessionSettings
} from '../shared/types.js';
import { logError } from './logger.js';

/**
 * Defaults for the newer sections, in one place so the schema and defaultConfig()
 * cannot drift apart. Recording, compaction and multi-agent all start switched off or
 * unconfigured: none of them should begin writing to disk or opening tabs uninvited.
 */
const DEFAULT_SESSIONS: SessionSettings = {
  record: false,
  retainDays: 30,
  advisoryTokens: 180_000,
  limitTokens: 200_000
};
const DEFAULT_COMPACTION: CompactionSettings = { model: '', reasoning: 'medium', showReasoning: true };
const DEFAULT_MULTI_AGENT: MultiAgentSettings = { enabled: false, maxWorkers: 3 };

const rootSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Root names are lowercase letters, digits, dot, dash, underscore'),
  path: z.string().min(2).max(4096)
});

// Missing capability keys are filled from safe defaults so adding a new optional
// permission in an update never resets an existing user's folders/tunnel settings.
const capabilitiesSchema = z
  .object(
    Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean().optional()])) as Record<
      (typeof CAPABILITIES)[number],
      z.ZodOptional<z.ZodBoolean>
    >
  )
  .transform((caps) => ({ ...DEFAULT_CAPABILITIES, ...caps }) as Capabilities);

const configSchema = z.object({
  roots: z.array(rootSchema).max(32),
  capabilities: capabilitiesSchema,
  readOnly: z.boolean(),
  tunnel: z.object({
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z.string().max(128),
    binaryPath: z.string().max(4096)
  }),
  ui: z.object({
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    privacyScreenshots: z.boolean().optional().default(false),
    theme: z.enum(['light', 'dark']).optional().default('light')
  }),
  // Whole sections are optional, so a config written by an older build keeps working
  // and simply gains the new features switched off. The default object is spelled out
  // rather than left as {} because zod 4 returns a default as-is instead of parsing it.
  sessions: z
    .object({
      record: z.boolean().optional().default(DEFAULT_SESSIONS.record),
      retainDays: z.number().int().min(0).max(3650).optional().default(DEFAULT_SESSIONS.retainDays),
      advisoryTokens: z
        .number()
        .int()
        .min(10_000)
        .max(2_000_000)
        .optional()
        .default(DEFAULT_SESSIONS.advisoryTokens),
      limitTokens: z.number().int().min(10_000).max(4_000_000).optional().default(DEFAULT_SESSIONS.limitTokens)
    })
    .optional()
    .default({ ...DEFAULT_SESSIONS }),
  compaction: z
    .object({
      model: z.string().max(200).optional().default(DEFAULT_COMPACTION.model),
      reasoning: z
        .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        .optional()
        .default(DEFAULT_COMPACTION.reasoning),
      showReasoning: z.boolean().optional().default(DEFAULT_COMPACTION.showReasoning)
    })
    .optional()
    .default({ ...DEFAULT_COMPACTION }),
  multiAgent: z
    .object({
      enabled: z.boolean().optional().default(DEFAULT_MULTI_AGENT.enabled),
      maxWorkers: z.number().int().min(1).max(8).optional().default(DEFAULT_MULTI_AGENT.maxWorkers)
    })
    .optional()
    .default({ ...DEFAULT_MULTI_AGENT })
});

export function defaultConfig(): Config {
  return {
    roots: [],
    capabilities: { ...DEFAULT_CAPABILITIES },
    readOnly: true,
    tunnel: { kind: 'openai', tunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' },
    sessions: { ...DEFAULT_SESSIONS },
    compaction: { ...DEFAULT_COMPACTION },
    multiAgent: { ...DEFAULT_MULTI_AGENT }
  };
}

let configPath = '';
let current: Config = defaultConfig();
// Every UI mutation ultimately lands in the same tiny JSON file. Keep those
// read-modify-write transactions strictly ordered so two fast checkbox/root changes
// cannot race on config.json.tmp or overwrite each other's newer state.
let mutationQueue: Promise<void> = Promise.resolve();

export function initConfigPath(userDataDir: string): void {
  configPath = path.join(userDataDir, 'config.json');
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logError('Settings file was invalid and has been reset to defaults');
      current = defaultConfig();
    } else {
      current = parsed.data;
      // Duplicate root names would make a virtual path ambiguous.
      const seen = new Set<string>();
      current.roots = current.roots.filter((r) => {
        const key = r.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(`Could not read settings: ${(err as Error).message}`);
    }
    current = defaultConfig();
  }
  return current;
}

export function getConfig(): Config {
  return current;
}

/**
 * Read-only mode is enforced here as well as at the tool layer, so the effective
 * capability set can never disagree with what the UI shows.
 */
export function effectiveCapabilities(config: Config): Capabilities {
  if (!config.readOnly) return config.capabilities;
  // Derived from WRITE_CAPABILITIES rather than listed again here, so adding a new
  // writing capability cannot accidentally leave it enabled in read-only mode.
  const capped = { ...config.capabilities };
  for (const capability of WRITE_CAPABILITIES) capped[capability] = false;
  return capped;
}

async function persistConfig(next: Config): Promise<Config> {
  const parsed = configSchema.parse(next);
  const tmp = `${configPath}.tmp`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8');
  await fs.rename(tmp, configPath);
  // Only publish the new in-memory state after the durable write succeeded. A disk
  // error must not leave the UI believing settings were saved when they were not.
  current = parsed;
  return current;
}

/**
 * Atomically updates settings from the latest committed state.
 *
 * The callback itself runs inside the queue. This matters more than merely queuing the
 * final file write: a root change and a permission change that start at the same time
 * must each see the result of the one ahead of it instead of composing two stale full
 * Config objects and letting the later write silently erase the earlier change.
 */
export function updateConfig(
  update: (latest: Config) => Config | Promise<Config>
): Promise<Config> {
  const operation = mutationQueue.then(async () => persistConfig(await update(current)));
  mutationQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

/** Replaces the complete config. Prefer updateConfig for read-modify-write changes. */
export function saveConfig(next: Config): Promise<Config> {
  return updateConfig(() => next);
}
