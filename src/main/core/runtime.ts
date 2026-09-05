import path from 'node:path';
import { shell } from 'electron';
import type { ConnectionStatus } from '../../shared/types.js';
import type { CoreStatusEnvelope } from '../../shared/core-protocol.js';
import { agentConversation, bindConversation, onRetiredWorkersPersist, onRetiredWorkersPersistNow, onSwarmPersist, onSwarmPersistNow, pauseSwarmForDisable, repairPrimeConversationAfterRecovery, restoreRetiredWorkers, restoreSwarm, snapshotRetiredWorkers, snapshotSwarm, type RetiredWorkersSnapshot, type SwarmSnapshot } from '../agents.js';
import { setBrowserOpener, shutdownBridge, startBridge } from '../bridge.js';
import { openInPreferredBrowser } from '../browser.js';
import { unifiedExecManager } from '../codex/manager.js';
import { connect, disconnect, getStatus, isServerRunning, shutdownConnection } from '../connection.js';
import { getConfig, initConfigPath, loadConfig } from '../config.js';
import { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } from '../durable.js';
import { EXECUTION_STATE, restoreExecutions, type ExecutionSnapshot } from '../execution.js';
import { GOAL_OBJECTIVES_STATE, restoreGoalObjectives, type GoalObjectivesSnapshot } from '../goal.js';
import { initLogFile, logError, logInfo, logWarn } from '../logger.js';
import { selfTestHeaders } from '../mcp/server.js';
import { stopComputerHelper } from '../computer/index.js';
import { initSecretsPath } from '../secrets.js';
import { CONTINUATIONS_STATE, restoreContinuations, setContinuationRecoveryHooks, type ContinuationSnapshot } from '../session/continuation.js';
import { restoreRequestCorrelations } from '../session/correlation.js';
import { flushRecorder, queueDeterministicAttributionRepair, setAgentBinder, setAgentConversationLookup } from '../session/recorder.js';
import { startSessionRetentionMaintenance } from '../session/retention.js';
import { flushSessions, initSessionStore, pruneSessions } from '../session/store.js';
import { CoreHealthController } from './health-controller.js';
import { probeLocalMcp } from './probe.js';
import { setConnectionGenerationProvider } from './request-lifecycle.js';

const SWARM_STATE = 'swarm';
const RETIRED_WORKERS_STATE = 'retired-workers';
const WATCHDOG_INTERVAL_MS = 10_000;

export interface CoreRuntime {
  health: CoreHealthController;
  statusEnvelope(): CoreStatusEnvelope;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reloadSettings(): Promise<void>;
  shutdown(): Promise<void>;
}

function projectedStatus(legacy: ConnectionStatus, health: ReturnType<CoreHealthController['snapshot']>): ConnectionStatus {
  if (health.overall === 'CONNECTED') return { ...legacy, state: 'connected' };
  if (health.overall === 'AUTH_REQUIRED') {
    return { ...legacy, state: 'auth-failed', detail: legacy.detail || 'Authentication is required.' };
  }
  if (health.overall === 'RECONNECTING') {
    return { ...legacy, state: 'connecting-tunnel', detail: 'Reconnecting Core execution…' };
  }
  if (health.overall === 'DEGRADED') {
    return {
      ...legacy,
      state: 'connecting-tunnel',
      detail: 'Remote transport is available, but local tool execution is unavailable. Recovering…'
    };
  }
  if (legacy.state === 'connected') {
    // Transport-only green is never allowed through the Core IPC boundary.
    return { ...legacy, state: 'offline', detail: 'Connection transport is up, but end-to-end execution is not verified.' };
  }
  return legacy;
}

/** Initializes every backend singleton a model-facing Core tool can reach. */
async function restoreCoreState(userDataDir: string): Promise<() => void> {
  initConfigPath(userDataDir);
  initSecretsPath(userDataDir);
  initSessionStore(userDataDir);
  initDurableStore(userDataDir);
  initLogFile(path.join(userDataDir, 'core.log'));
  await loadConfig();

  restoreGoalObjectives(await readDurable<GoalObjectivesSnapshot>(GOAL_OBJECTIVES_STATE));
  restoreExecutions(await readDurable<ExecutionSnapshot>(EXECUTION_STATE));
  await restoreRequestCorrelations();
  setAgentConversationLookup(agentConversation);
  setAgentBinder(bindConversation);
  setBrowserOpener(async (url) => {
    try {
      const browser = await openInPreferredBrowser(url);
      if (browser) return;
    } catch (error) {
      logWarn(`core could not open ChatGPT in the preferred browser: ${(error as Error).message}`);
    }
    await shell.openExternal(url);
  });

  onSwarmPersist(() => writeDurableSoon(SWARM_STATE, snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot));
  onRetiredWorkersPersist(() => writeDurableSoon(RETIRED_WORKERS_STATE, snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow(RETIRED_WORKERS_STATE, snapshot));
  restoreRetiredWorkers(await readDurable<RetiredWorkersSnapshot>(RETIRED_WORKERS_STATE));
  restoreSwarm(await readDurable<SwarmSnapshot>(SWARM_STATE));
  if (!getConfig().multiAgent.enabled) {
    pauseSwarmForDisable('multi-agent mode is disabled');
    await writeDurableNow(SWARM_STATE, snapshotSwarm());
  }

  setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
  await restoreContinuations(await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE));
  queueDeterministicAttributionRepair();

  if (getConfig().sessions.record || getConfig().multiAgent.enabled) await startBridge();
  return startSessionRetentionMaintenance({
    retainDays: () => getConfig().sessions.retainDays,
    prune: pruneSessions,
    onRemoved: (removed) => logInfo(`core removed ${removed} session(s) past the retention window`),
    onError: (error) => logError(`core session pruning failed: ${error.message}`)
  });
}

export async function startCoreRuntime(userDataDir: string): Promise<CoreRuntime> {
  const stopRetention = await restoreCoreState(userDataDir);
  let watchdog: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const health = new CoreHealthController({
    getStatus,
    isServerRunning,
    probe: (url) => probeLocalMcp(url, { selfTestHeaders: selfTestHeaders(), timeoutMs: 3_000 }),
    recover: async (reason) => {
      if (shuttingDown) return;
      logWarn(`[core][gen=${health.snapshot().connectionGeneration}] recovery: ${reason}`);
      await disconnect();
      if (!shuttingDown) await connect();
    },
    requiresRemoteHeartbeat: () => getConfig().tunnel.kind === 'openai',
    onChange: (snapshot) => {
      logInfo(
        `[core][gen=${snapshot.connectionGeneration}] overall=${snapshot.overall} remote=${snapshot.remoteTransportHealthy}/${snapshot.remoteSubscriptionHealthy} local=${snapshot.localMcpHealthy} probe=${snapshot.toolProbeHealthy} auth=${snapshot.authHealthy}`
      );
    }
  });
  // Request lifecycle records must carry the same generation that status/recovery uses. This
  // provider is read at the actual HTTP request-start boundary, so an in-flight request keeps the
  // generation it entered under even if recovery increments the controller before its response.
  setConnectionGenerationProvider(() => health.snapshot().connectionGeneration);

  const tick = async (): Promise<void> => {
    if (shuttingDown) return;
    try {
      await health.tick();
    } catch (error) {
      logWarn(`core health watchdog failed: ${(error as Error).message}`);
    }
  };

  watchdog = setInterval(() => void tick(), WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();

  const runtime: CoreRuntime = {
    health,
    statusEnvelope: () => {
      const healthSnapshot = health.snapshot();
      return {
        generation: healthSnapshot.connectionGeneration,
        status: projectedStatus(getStatus(), healthSnapshot),
        health: healthSnapshot
      };
    },
    connect: async () => {
      await connect();
      await tick();
    },
    disconnect: async () => {
      await disconnect();
      await tick();
    },
    reloadSettings: async () => {
      await loadConfig();
      // connection.ts reads config live for tools; a transport-changing setting is reconciled
      // through the existing serialized applySettings path by the host entry.
      const { applySettings } = await import('../connection.js');
      await applySettings();
      await tick();
    },
    shutdown: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      stopRetention();
      await Promise.allSettled([shutdownConnection(), shutdownBridge()]);
      await Promise.allSettled([unifiedExecManager.terminateAllProcesses(), stopComputerHelper()]);
      await Promise.allSettled([flushRecorder()]);
      await Promise.allSettled([flushSessions(), flushDurable()]);
      logInfo('core runtime stopped');
    }
  };

  if (getConfig().ui.autoConnect) await runtime.connect();
  else await tick();
  return runtime;
}
