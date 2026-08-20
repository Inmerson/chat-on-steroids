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
import { RESERVED_ROOT_NAMES } from './sandbox.js';

/**
 * Defaults for the newer sections, in one place so the schema and defaultConfig()
 * cannot drift apart.
 *
 * Recording starts ON. Everything the app is actually for — the readable timeline, Compact
 * & resume, and agent attribution — reads the recorded history, so an install that starts
 * with it off is an install where the main features silently do nothing. It writes only to
 * this app's own data folder and uploads nothing. Note this changes the default for *new*
 * configs only: an existing config already carries an explicit `record`, and a user who
 * turned it off keeps it off.
 *
 * Multi-agent still starts off — it opens browser tabs and drives several chats at the
 * same files, which nobody should get without asking for it.
 */
/**
 * Where the pressure meter turns amber and red.
 *
 * These are measured in *this app's* units — `estimateTokens`, four characters to a token,
 * over the events it kept — and not in whatever ChatGPT counts. The two are not the same
 * number and never will be: the app cannot see the system prompt, the memory, the file
 * attachments or the model's own reasoning, and ChatGPT's counter is private.
 *
 * So the thresholds are calibrated against observed behaviour rather than a published
 * context window. The first pair (180k/200k) was set from the published figure, and a real
 * session then ran past 400k of these units before ChatGPT would take no more — meaning the
 * meter had been demanding a compaction since roughly the halfway mark, for hours, on a
 * chat that was fine. A warning that cries wolf at half the real capacity is a warning
 * people learn to click past, which costs more than having no warning at all.
 *
 * 300k/400k puts the amber line where there is still comfortable room to compact and the
 * red line at the point that has actually been seen to fail. Both remain settings, because
 * the real ceiling moves with the account, the model and the size of what is attached.
 */
const DEFAULT_SESSIONS: SessionSettings = {
  record: true,
  retainDays: 30,
  advisoryTokens: 300_000,
  limitTokens: 400_000
};

/**
 * The 1.7.1 recalibration, applied once to configs that never chose their own numbers.
 *
 * Raising a default only helps a fresh install: every existing config was written with the
 * old figures spelled out, so it would keep the too-early warning forever. A stored pair
 * that is *exactly* the old defaults was never a decision — it is what the app wrote for
 * itself — so it moves. Anything else the user typed, and it stays put.
 */
const OLD_TOKEN_DEFAULTS = { advisoryTokens: 180_000, limitTokens: 200_000 };
const DEFAULT_COMPACTION: CompactionSettings = {
  // On, at the advisory line.
  //
  // Automatic compaction is edge-triggered since 1.8: an old chat that merely opens above
  // this number does nothing. That makes the advisory line the useful default again — there
  // is still room to finish the turn and write the handoff, instead of waiting until the
  // observed failure ceiling and risking a context failure in the turn that should save it.
  auto: true,
  autoTokens: DEFAULT_SESSIONS.advisoryTokens
};
// Two workers, not three: three concurrent workers reproducibly trips ChatGPT's rate limit
// ("too many requests"), which strands the run rather than making it faster.
const DEFAULT_MULTI_AGENT: MultiAgentSettings = { enabled: false, maxWorkers: 2 };

const rootSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Root names are lowercase letters, digits, dot, dash, underscore'),
  path: z.string().min(2).max(4096)
});

/**
 * Migrates configs written before the tools were consolidated.
 *
 * `powershell` and `command` used to be one tool each and are now the single
 * `exec_command`, so a user who had granted only PowerShell keeps the ability they
 * chose. `deleteFolder` is dropped rather than folded into `deleteFile`: they were never
 * the same permission, and quietly turning one into the other would widen what the user
 * approved. Both keys are removed afterwards so the file stops carrying dead permissions.
 */
function migrateCapabilities(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const caps = { ...(value as Record<string, unknown>) };
  if (caps['powershell'] === true) caps['command'] = true;
  delete caps['powershell'];
  delete caps['deleteFolder'];
  return caps;
}

// Missing capability keys are filled from safe defaults so adding a new optional
// permission in an update never resets an existing user's folders/tunnel settings.
const capabilitiesSchema = z
  .preprocess(
    migrateCapabilities,
    z.object(
      Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean().optional()])) as Record<
        (typeof CAPABILITIES)[number],
        z.ZodOptional<z.ZodBoolean>
      >
    )
  )
  .transform((caps) => ({ ...DEFAULT_CAPABILITIES, ...caps }) as Capabilities);

const configSchema = z.object({
  // A config written by hand — or by a build before `/skills` was reserved — must not be
  // able to claim a reserved virtual root. Renamed rather than rejected: a single bad root
  // name is not a reason to throw away the whole config and every other approved folder.
  roots: z
    .array(rootSchema)
    .max(32)
    .transform((roots) =>
      roots.map((root) => (RESERVED_ROOT_NAMES.has(root.name) ? { ...root, name: `${root.name}-folder` } : root))
    ),
  capabilities: capabilitiesSchema,
  readOnly: z.boolean(),
  tunnel: z.object({
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z.string().max(128),
    // Optional with an empty default, so a config written before the connector split
    // loads unchanged and simply has no Desktop tunnel yet — which is also the correct
    // state for it, since the user has not created that connector in ChatGPT either.
    desktopTunnelId: z.string().max(128).optional().default(''),
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
      auto: z.boolean().optional().default(DEFAULT_COMPACTION.auto),
      // The floor is high enough that the threshold cannot be set somewhere a fresh chat
      // is already past, which would compact every conversation the moment it started.
      autoTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_COMPACTION.autoTokens)
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
    tunnel: { kind: 'openai', tunnelId: '', desktopTunnelId: '', binaryPath: '' },
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
      current = adoptEdgeAutoCompaction(adoptAutoCompaction(recalibrateTokens(parsed.data)));
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

/** Applies OLD_TOKEN_DEFAULTS → DEFAULT_SESSIONS, but only to an untouched pair. */
function recalibrateTokens(config: Config): Config {
  const { advisoryTokens, limitTokens } = config.sessions;
  if (advisoryTokens !== OLD_TOKEN_DEFAULTS.advisoryTokens || limitTokens !== OLD_TOKEN_DEFAULTS.limitTokens) {
    return config;
  }
  return {
    ...config,
    sessions: {
      ...config.sessions,
      advisoryTokens: DEFAULT_SESSIONS.advisoryTokens,
      limitTokens: DEFAULT_SESSIONS.limitTokens
    }
  };
}

/**
 * What automatic compaction used to default to, for the same one-time move as above.
 *
 * A config written before 1.7.5 spells the old answer out, so raising the default alone
 * would only ever reach a fresh install. A stored pair that is *exactly* the old default
 * was never a decision — it is what the app wrote for itself — so it moves. Anything the
 * user actually chose is left alone, including switching it off on purpose, which is why
 * `auto: true` with the old threshold is not touched: that is somebody's own setting.
 */
const OLD_AUTO_DEFAULTS = { auto: false, autoTokens: 300_000 };

function adoptAutoCompaction(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== OLD_AUTO_DEFAULTS.auto || autoTokens !== OLD_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, auto: DEFAULT_COMPACTION.auto, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

/** The 1.7.x automatic default, before 1.8 made the trigger edge-based and moved it to 300k. */
const PRE_EDGE_AUTO_DEFAULTS = { auto: true, autoTokens: 400_000 };

function adoptEdgeAutoCompaction(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== PRE_EDGE_AUTO_DEFAULTS.auto || autoTokens !== PRE_EDGE_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
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
