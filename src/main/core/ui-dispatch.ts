import { z } from 'zod';
import type { CoreUiOperation } from '../../shared/core-protocol.js';
import {
  CAPABILITIES,
  GOAL_REASONING_LEVELS,
  type Config
} from '../../shared/types.js';
import { MAX_GOAL_SYSTEM_PROMPT_CHARS } from '../../shared/goal.js';
import { tokenPressure } from '../../shared/session.js';
import { bridgeStatus, cancelWorkerCommands, unpair } from '../bridge.js';
import { getConfig, updateConfig } from '../config.js';
import { runDiagnostics } from '../diagnostics.js';
import { listGoalModels, MODEL_PAGE_SIZE } from '../goal.js';
import { logInfo } from '../logger.js';
import { controlCenterStatus } from '../orchestration/control-center.js';
import {
  RESERVED_ROOT_NAMES,
  defaultRootNameForPath,
  detectSystemDrives,
  validateNewRoot,
  SandboxError
} from '../sandbox.js';
import { TUNNEL_ID_PATTERN } from '../tunnel/index.js';
import {
  clearAgent,
  persistAgentAuthorityNow,
  resetSwarm,
  swarmState
} from '../agents.js';
import { activeSessionId, forgetSession } from '../session/recorder.js';
import {
  deleteSession,
  getSession,
  listSessionPage,
  readEvents,
  readHandoff,
  readRecentEvents
} from '../session/store.js';
import { applyCoreSettingsTransition } from './settings-runtime.js';

const idSchema = z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i);
const agentIdSchema = z.string().min(1).max(64).regex(/^[0-9a-z-]+$/i);

const capabilityPatch = z.object(
  Object.fromEntries(CAPABILITIES.map((capability) => [capability, z.boolean()])) as Record<
    (typeof CAPABILITIES)[number],
    z.ZodBoolean
  >
);

const settingsPatch = z.object({
  capabilities: capabilityPatch,
  readOnly: z.boolean(),
  tunnel: z.object({
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z.string().max(128).refine((value) => value === '' || TUNNEL_ID_PATTERN.test(value)),
    desktopTunnelId: z.string().max(128).refine((value) => value === '' || TUNNEL_ID_PATTERN.test(value)),
    binaryPath: z.string().max(4096)
  }),
  ui: z.object({
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    privacyScreenshots: z.boolean(),
    theme: z.enum(['light', 'dark'])
  }),
  sessions: z.object({
    record: z.boolean(),
    retainDays: z.number().int().min(0).max(3650),
    advisoryTokens: z.number().int().min(10_000).max(4_000_000),
    limitTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  compaction: z.object({
    auto: z.boolean(),
    autoTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  multiAgent: z.object({ enabled: z.boolean(), maxWorkers: z.number().int().min(1).max(8) }),
  goal: z.object({
    enabled: z.boolean(),
    model: z.string().min(1).max(160).regex(/^~?[a-z0-9._\-]+\/[a-z0-9._\-]+(:[a-z0-9._\-]+)?$/i),
    reasoning: z.enum(GOAL_REASONING_LEVELS),
    prompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    objectivePrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
  })
});
const settingsSave = z.object({ base: settingsPatch, patch: settingsPatch }).strict();
type SettingsSnapshot = z.infer<typeof settingsPatch>;

function mergeSettings(current: Config, base: SettingsSnapshot, wanted: SettingsSnapshot): SettingsSnapshot {
  const pick = <T>(live: T, before: T, next: T): T => (Object.is(before, next) ? live : next);
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      pick(current.capabilities[capability], base.capabilities[capability], wanted.capabilities[capability])
    ])
  ) as Config['capabilities'];
  return {
    capabilities,
    readOnly: pick(current.readOnly, base.readOnly, wanted.readOnly),
    tunnel: {
      kind: pick(current.tunnel.kind, base.tunnel.kind, wanted.tunnel.kind),
      tunnelId: pick(current.tunnel.tunnelId, base.tunnel.tunnelId, wanted.tunnel.tunnelId),
      desktopTunnelId: pick(current.tunnel.desktopTunnelId, base.tunnel.desktopTunnelId, wanted.tunnel.desktopTunnelId),
      binaryPath: pick(current.tunnel.binaryPath, base.tunnel.binaryPath, wanted.tunnel.binaryPath)
    },
    ui: {
      minimizeToTray: pick(current.ui.minimizeToTray, base.ui.minimizeToTray, wanted.ui.minimizeToTray),
      autoConnect: pick(current.ui.autoConnect, base.ui.autoConnect, wanted.ui.autoConnect),
      privacyScreenshots: pick(current.ui.privacyScreenshots, base.ui.privacyScreenshots, wanted.ui.privacyScreenshots),
      theme: pick(current.ui.theme, base.ui.theme, wanted.ui.theme)
    },
    sessions: {
      record: pick(current.sessions.record, base.sessions.record, wanted.sessions.record),
      retainDays: pick(current.sessions.retainDays, base.sessions.retainDays, wanted.sessions.retainDays),
      advisoryTokens: pick(current.sessions.advisoryTokens, base.sessions.advisoryTokens, wanted.sessions.advisoryTokens),
      limitTokens: pick(current.sessions.limitTokens, base.sessions.limitTokens, wanted.sessions.limitTokens)
    },
    compaction: {
      auto: pick(current.compaction.auto, base.compaction.auto, wanted.compaction.auto),
      autoTokens: pick(current.compaction.autoTokens, base.compaction.autoTokens, wanted.compaction.autoTokens)
    },
    multiAgent: {
      enabled: pick(current.multiAgent.enabled, base.multiAgent.enabled, wanted.multiAgent.enabled),
      maxWorkers: pick(current.multiAgent.maxWorkers, base.multiAgent.maxWorkers, wanted.multiAgent.maxWorkers)
    },
    goal: {
      enabled: pick(current.goal.enabled, base.goal.enabled, wanted.goal.enabled),
      model: pick(current.goal.model, base.goal.model, wanted.goal.model),
      reasoning: pick(current.goal.reasoning, base.goal.reasoning, wanted.goal.reasoning),
      prompt: pick(current.goal.prompt, base.goal.prompt, wanted.goal.prompt),
      objectivePrompt: pick(current.goal.objectivePrompt, base.goal.objectivePrompt, wanted.goal.objectivePrompt)
    }
  };
}

async function mutateConfig(mutator: (current: Config) => Config | Promise<Config>): Promise<Config> {
  const before = structuredClone(getConfig());
  const after = await updateConfig(mutator);
  await applyCoreSettingsTransition(before, after);
  return structuredClone(after);
}

export interface CoreUiDispatcherDeps {
  configGet: () => Promise<unknown> | unknown;
  settingsSave: (payload: unknown) => Promise<unknown>;
  addRootPath: (path: string) => Promise<unknown>;
  toggleAllComputer: () => Promise<unknown>;
  removeRoot: (name: string) => Promise<unknown>;
  renameRoot: (name: string, newName: string) => Promise<unknown>;
  setBinaryPath: (path: string) => Promise<unknown>;
  bridgeStatus: () => Promise<unknown>;
  unpair: () => Promise<void>;
  listSessions: (payload: { cursor?: { updatedAt: number; id: string }; limit?: number }) => Promise<unknown>;
  sessionEvents: (payload: { id: string; from?: number; limit?: number }) => Promise<unknown>;
  deleteSession: (id: string) => Promise<boolean>;
  handoff: (payload: { id: string; handoffId?: string }) => Promise<unknown>;
  swarm: () => unknown;
  resetSwarm: () => Promise<unknown>;
  clearAgent: (id: string) => Promise<unknown>;
  controlCenter: () => Promise<unknown> | unknown;
  goalModels: (offset: number) => Promise<unknown>;
  diagnostics: () => Promise<unknown>;
}

export type CoreUiDispatcher = (operation: CoreUiOperation, payload: unknown) => Promise<unknown>;

export function createCoreUiDispatcher(deps: CoreUiDispatcherDeps): CoreUiDispatcher {
  return async (operation, payload) => {
    switch (operation) {
      case 'config-get':
        z.null().parse(payload);
        return deps.configGet();
      case 'settings-save':
        settingsSave.parse(payload);
        return deps.settingsSave(payload);
      case 'root-add-path': {
        const { path: approvedPath } = z.object({ path: z.string().min(1).max(4096) }).parse(payload);
        return deps.addRootPath(approvedPath);
      }
      case 'roots-all-computer-toggle':
        z.null().parse(payload);
        return deps.toggleAllComputer();
      case 'root-remove': {
        const { name } = z.object({ name: z.string().min(1).max(32) }).parse(payload);
        return deps.removeRoot(name);
      }
      case 'root-rename': {
        const value = z.object({
          name: z.string().min(1).max(32),
          newName: z.string().min(1).max(32).regex(/^[a-z0-9][a-z0-9._-]*$/)
        }).parse(payload);
        return deps.renameRoot(value.name, value.newName);
      }
      case 'tunnel-binary-path': {
        const { path: binaryPath } = z.object({ path: z.string().min(1).max(4096) }).parse(payload);
        return deps.setBinaryPath(binaryPath);
      }
      case 'bridge-status':
        z.null().parse(payload);
        return deps.bridgeStatus();
      case 'bridge-unpair':
        z.null().parse(payload);
        await deps.unpair();
        return true;
      case 'session-list': {
        const value = z.object({
          cursor: z.object({ updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id: idSchema }).optional(),
          limit: z.number().int().min(1).max(60).optional()
        }).parse(payload ?? {});
        return deps.listSessions(value);
      }
      case 'session-events': {
        const value = z.object({
          id: idSchema,
          from: z.number().int().min(0).max(10_000_000).optional(),
          limit: z.number().int().min(1).max(1000).optional()
        }).parse(payload);
        return deps.sessionEvents(value);
      }
      case 'session-delete': {
        const { id } = z.object({ id: idSchema }).parse(payload);
        return deps.deleteSession(id);
      }
      case 'handoff-get': {
        const value = z.object({ id: idSchema, handoffId: idSchema.optional() }).parse(payload);
        return deps.handoff(value);
      }
      case 'swarm-get':
        z.null().parse(payload);
        return deps.swarm();
      case 'swarm-reset':
        z.null().parse(payload);
        return deps.resetSwarm();
      case 'swarm-clear-agent': {
        const { id } = z.object({ id: agentIdSchema }).parse(payload);
        return deps.clearAgent(id);
      }
      case 'control-center-status':
        z.null().parse(payload);
        return deps.controlCenter();
      case 'goal-models': {
        const { offset } = z.object({ offset: z.number().int().min(0).max(2000).default(0) }).parse(payload ?? {});
        return deps.goalModels(offset);
      }
      case 'diagnostics-run':
        z.null().parse(payload);
        return deps.diagnostics();
    }
  };
}

const defaultDeps: CoreUiDispatcherDeps = {
  configGet: () => structuredClone(getConfig()),
  settingsSave: async (payload) => {
    const request = settingsSave.parse(payload);
    return mutateConfig((current) => ({ ...current, ...mergeSettings(current, request.base, request.patch) }));
  },
  addRootPath: async (approvedPath) => mutateConfig(async (config) => {
    const overlapRoots = config.allComputer === true ? [] : config.roots;
    const real = await validateNewRoot(approvedPath, overlapRoots, { allowDrive: true });
    const name = defaultRootNameForPath(real, config.roots);
    const roots = [...config.roots, { name, path: real }];
    logInfo(`approved folder /${name}`);
    return config.allComputer === true
      ? { ...config, roots, allComputer: false, previousRoots: [] }
      : { ...config, roots };
  }),
  toggleAllComputer: async () => mutateConfig(async (config) => {
    if (config.allComputer === true) {
      return { ...config, allComputer: false, previousRoots: [], roots: config.previousRoots ?? [] };
    }
    const drives = await detectSystemDrives();
    const roots = drives.map((drive) => ({ name: defaultRootNameForPath(drive, []), path: drive }));
    return { ...config, allComputer: true, previousRoots: config.roots, roots };
  }),
  removeRoot: async (name) => mutateConfig((config) => {
    if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
    return {
      ...config,
      allComputer: false,
      ...(config.allComputer === true ? { previousRoots: [] } : {}),
      roots: config.roots.filter((root) => root.name !== name)
    };
  }),
  renameRoot: async (name, newName) => {
    if (RESERVED_ROOT_NAMES.has(newName)) {
      throw new SandboxError(`/${newName} is reserved by Chat On Steroids and cannot be used as a folder name`);
    }
    return mutateConfig((config) => {
      if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
      if (config.roots.some((root) => root.name !== name && root.name === newName)) {
        throw new Error(`/${newName} is already used`);
      }
      return { ...config, roots: config.roots.map((root) => root.name === name ? { ...root, name: newName } : root) };
    });
  },
  setBinaryPath: async (binaryPath) => mutateConfig((config) => ({
    ...config,
    tunnel: { ...config.tunnel, binaryPath }
  })),
  bridgeStatus,
  unpair,
  listSessions: async ({ cursor, limit }) => {
    const config = getConfig();
    const page = await listSessionPage({ cursor, limit: limit ?? 60 });
    return {
      sessions: page.sessions,
      total: page.total,
      nextCursor: page.nextCursor,
      activeId: activeSessionId(),
      pressure: page.sessions.map((summary) => ({
        id: summary.id,
        ...tokenPressure(summary.estimatedTokens, config.sessions.advisoryTokens, config.sessions.limitTokens)
      }))
    };
  },
  sessionEvents: async ({ id, from, limit }) => {
    const summary = await getSession(id);
    if (!summary) throw new Error('Session not found');
    const cap = limit ?? 160;
    if (from === undefined) {
      const events = await readRecentEvents(id, cap);
      const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
      return { summary, events, total: summary.events, nextFrom };
    }
    const events = await readEvents(id, { from, limit: cap });
    const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), from);
    return { summary, events, total: summary.events, nextFrom };
  },
  deleteSession: async (id) => {
    forgetSession(id);
    await deleteSession(id);
    return true;
  },
  handoff: async ({ id, handoffId }) => {
    if (handoffId) return readHandoff(id, handoffId);
    const summary = await getSession(id);
    return summary?.lastHandoffId ? readHandoff(id, summary.lastHandoffId) : null;
  },
  swarm: swarmState,
  resetSwarm: async () => {
    resetSwarm();
    if (!(await persistAgentAuthorityNow())) throw new Error('The cleared run could not be made durable. Retry clearing the swarm.');
    return swarmState();
  },
  clearAgent: async (id) => {
    const outcome = clearAgent(id);
    if (outcome.cleared !== 'none') {
      if (!(await persistAgentAuthorityNow())) throw new Error('The agent clear could not be made durable. Retry the clear action.');
      if (outcome.cleared === 'worker') cancelWorkerCommands(outcome.reason, id);
    }
    return { cleared: outcome.cleared, reason: outcome.reason, swarm: swarmState() };
  },
  controlCenter: controlCenterStatus,
  goalModels: (offset) => listGoalModels(offset, MODEL_PAGE_SIZE),
  diagnostics: runDiagnostics
};

export const coreUiDispatcher = createCoreUiDispatcher(defaultDeps);
