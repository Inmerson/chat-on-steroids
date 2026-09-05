export interface CoreProbeHealthy {
  healthy: true;
  pid: number;
  startedAt?: number;
}

export interface CoreProbeUnhealthy {
  healthy: false;
}

export type CoreProbeResult = CoreProbeHealthy | CoreProbeUnhealthy;

export interface CoreSpawnResult {
  pid: number;
  startedAt?: number;
}

export interface CoreProcessAdapter {
  /** A PID alone is not health. This probe must traverse the local Core IPC handshake. */
  probe(): Promise<CoreProbeResult>;
  spawn(): Promise<CoreSpawnResult>;
  stop(): Promise<void>;
}

export interface CoreSupervisorOptions {
  adapter: CoreProcessAdapter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  healthyResetMs?: number;
  startupGraceMs?: number;
}

export interface EnsureHostResult {
  state: 'attached' | 'spawned';
  pid: number;
}

export const CORE_RESTART_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 180_000] as const;
const MAX_CORE_RESTART_BACKOFF_MS = CORE_RESTART_BACKOFF_MS[CORE_RESTART_BACKOFF_MS.length - 1]!;

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Process supervisor above the Core Host.
 *
 * All reasons (UI attach, process exit, watchdog failure) converge on `ensureHost()`. The
 * single-flight promise is the ownership boundary: five observers may notice one dead host, but
 * only one of them is allowed to spawn its replacement.
 */
export class CoreSupervisor {
  private readonly adapter: CoreProcessAdapter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly healthyResetMs: number;
  private readonly startupGraceMs: number;
  private recovery: Promise<EnsureHostResult> | null = null;
  private restartFailures = 0;
  private stalePid: number | null = null;
  private lastSpawnPid: number | null = null;
  private lastSpawnAt: number | null = null;

  constructor(options: CoreSupervisorOptions) {
    this.adapter = options.adapter;
    this.sleep = options.sleep ?? sleepDefault;
    this.now = options.now ?? Date.now;
    this.healthyResetMs = options.healthyResetMs ?? 300_000;
    this.startupGraceMs = options.startupGraceMs ?? 5_000;
  }

  async ensureHost(_reason: string): Promise<EnsureHostResult> {
    if (this.recovery) return this.recovery;

    const recovery = this.ensureHostOnce();
    this.recovery = recovery;
    try {
      return await recovery;
    } finally {
      if (this.recovery === recovery) this.recovery = null;
    }
  }

  private recordRapidDeath(now: number): void {
    if (this.lastSpawnAt === null) return;
    const age = now - this.lastSpawnAt;
    if (age < this.startupGraceMs) return;
    if (age < this.healthyResetMs) {
      this.restartFailures = Math.min(this.restartFailures + 1, CORE_RESTART_BACKOFF_MS.length - 1);
    } else {
      this.restartFailures = 0;
    }
    this.lastSpawnAt = null;
    this.lastSpawnPid = null;
  }

  private async ensureHostOnce(): Promise<EnsureHostResult> {
    const now = this.now();
    const existing = await this.adapter.probe();
    if (existing.healthy) {
      if (existing.startedAt !== undefined && now - existing.startedAt >= this.healthyResetMs) {
        this.restartFailures = 0;
        this.lastSpawnAt = null;
        this.lastSpawnPid = null;
      }
      this.stalePid = null;
      return { state: 'attached', pid: existing.pid };
    }

    if (this.lastSpawnAt !== null && now - this.lastSpawnAt < this.startupGraceMs && this.lastSpawnPid !== null) {
      return { state: 'spawned', pid: this.lastSpawnPid };
    }
    this.recordRapidDeath(now);

    const delay =
      CORE_RESTART_BACKOFF_MS[Math.min(this.restartFailures, CORE_RESTART_BACKOFF_MS.length - 1)] ??
      MAX_CORE_RESTART_BACKOFF_MS;
    await this.sleep(delay);

    const afterBackoff = await this.adapter.probe();
    if (afterBackoff.healthy) {
      this.stalePid = null;
      return { state: 'attached', pid: afterBackoff.pid };
    }

    try {
      const child = await this.adapter.spawn();
      this.stalePid = null;
      this.lastSpawnPid = child.pid;
      this.lastSpawnAt = child.startedAt ?? this.now();
      return { state: 'spawned', pid: child.pid };
    } catch (error) {
      this.restartFailures = Math.min(this.restartFailures + 1, CORE_RESTART_BACKOFF_MS.length - 1);
      this.lastSpawnAt = null;
      this.lastSpawnPid = null;
      throw error;
    }
  }

  /** UI lifetime is deliberately not a Core lifetime signal. */
  async uiDetached(): Promise<void> {
    return;
  }

  /**
   * Explicit supervisor/system/update shutdown. If a restart is currently in flight, let that
   * single flight settle first and then stop the resulting host, so an update cannot race a late
   * spawn that reopens the installed executable after quiesce began.
   */
  async stopHost(): Promise<void> {
    const inFlight = this.recovery;
    if (inFlight) await inFlight.catch(() => undefined);
    await this.adapter.stop();
    this.lastSpawnAt = null;
    this.lastSpawnPid = null;
    this.stalePid = null;
  }

  async noteStalePid(pid: number): Promise<void> {
    this.stalePid = pid;
  }

  stalePidForDiagnostics(): number | null {
    return this.stalePid;
  }
}
