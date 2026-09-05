import type { ConnectionStatus } from '../../shared/types.js';
import type { CoreHealthStatus } from '../../shared/core-protocol.js';
import { initialCoreHealth, reduceCoreHealth } from './health.js';
import type { LocalMcpProbeResult } from './probe.js';

export interface CoreHealthControllerOptions {
  getStatus: () => ConnectionStatus;
  isServerRunning: () => boolean;
  probe: (url: string) => Promise<LocalMcpProbeResult>;
  /** Must tear down the stale transport and create a fresh one. */
  recover: (reason: string) => Promise<void>;
  now?: () => number;
  corePid?: number;
  heartbeatStaleMs?: number;
  joiningStaleMs?: number;
  requiresRemoteHeartbeat?: (status: ConnectionStatus) => boolean;
  onChange?: (health: CoreHealthStatus) => void;
}

const DEFAULT_HEARTBEAT_STALE_MS = 75_000;
const DEFAULT_JOINING_STALE_MS = 30_000;

/**
 * Converts several independent health planes into the one answer the UI and Core IPC consume.
 * Transport reports are evidence, not authority: CONNECTED is impossible until a real MCP
 * initialize + tools/list probe has crossed the local execution path successfully.
 */
export class CoreHealthController {
  private health: CoreHealthStatus;
  private readonly now: () => number;
  private joiningSince: number | null = null;
  private connectedWithoutHeartbeatSince: number | null = null;
  private recovery: Promise<void> | null = null;
  private recoveryAttempt = 0;

  constructor(private readonly options: CoreHealthControllerOptions) {
    this.now = options.now ?? Date.now;
    this.health = reduceCoreHealth(initialCoreHealth(), {
      type: 'CORE_STARTED',
      pid: options.corePid ?? process.pid
    });
  }

  snapshot(): CoreHealthStatus {
    return { ...this.health };
  }

  recoveryPromise(): Promise<void> {
    return this.recovery ?? Promise.resolve();
  }

  noteToolSuccess(at = this.now()): void {
    this.apply({ type: 'TOOL_SUCCEEDED', at });
  }

  private apply(event: Parameters<typeof reduceCoreHealth>[1]): void {
    this.health = reduceCoreHealth(this.health, event);
    this.options.onChange?.(this.snapshot());
  }

  private clearRemote(): void {
    this.apply({ type: 'REMOTE_DISCONNECTED' });
  }

  private beginRecovery(reason: string): void {
    if (this.recovery || this.health.authRequired) return;
    this.recoveryAttempt += 1;
    this.apply({ type: 'RECOVERY_STARTED', attempt: this.recoveryAttempt });
    this.apply({ type: 'REMOTE_RECREATED' });

    let run: Promise<void>;
    try {
      run = Promise.resolve(this.options.recover(reason));
    } catch (error) {
      run = Promise.reject(error);
    }
    const tracked = run
      .catch(() => undefined)
      .finally(() => {
        if (this.recovery !== tracked) return;
        this.recovery = null;
        this.apply({ type: 'RECOVERY_FINISHED' });
      });
    this.recovery = tracked;
  }

  private updateTransport(status: ConnectionStatus, now: number): void {
    if (status.state === 'auth-failed') {
      this.joiningSince = null;
      this.connectedWithoutHeartbeatSince = null;
      this.clearRemote();
      this.apply({ type: 'AUTH_REQUIRED' });
      return;
    }

    if (status.state === 'connected') {
      this.apply({ type: 'AUTH_VALID' });
      this.apply({ type: 'REMOTE_CONNECTED' });
      this.apply({ type: 'REMOTE_SUBSCRIBED' });
      this.joiningSince = null;

      if (status.handshakeAt !== null) {
        this.connectedWithoutHeartbeatSince = null;
        this.apply({ type: 'REMOTE_HEARTBEAT_OK', at: status.handshakeAt });
      } else if (this.connectedWithoutHeartbeatSince === null) {
        this.connectedWithoutHeartbeatSince = now;
      }
      return;
    }

    this.connectedWithoutHeartbeatSince = null;
    if (status.state === 'connecting-tunnel') {
      this.apply({ type: 'AUTH_VALID' });
      this.clearRemote();
      if (this.joiningSince === null) this.joiningSince = now;
      return;
    }

    this.joiningSince = null;
    if (status.state === 'offline') {
      // The local tunnel child may still be alive, but the remote data plane is not.
      this.apply({ type: 'AUTH_VALID' });
      this.clearRemote();
      return;
    }

    if (status.state === 'starting-server') {
      this.apply({ type: 'AUTH_VALID' });
      this.clearRemote();
      return;
    }

    // `disconnected` and non-auth tunnel failures carry no current remote proof.
    this.clearRemote();
  }

  private heartbeatIsStale(status: ConnectionStatus, now: number): boolean {
    if (status.state !== 'connected' || !(this.options.requiresRemoteHeartbeat?.(status) ?? true)) return false;
    const threshold = this.options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
    if (status.handshakeAt !== null) return now - status.handshakeAt > threshold;
    return this.connectedWithoutHeartbeatSince !== null && now - this.connectedWithoutHeartbeatSince > threshold;
  }

  private joiningIsStale(status: ConnectionStatus, now: number): boolean {
    if (status.state !== 'connecting-tunnel' || this.joiningSince === null) return false;
    return now - this.joiningSince > (this.options.joiningStaleMs ?? DEFAULT_JOINING_STALE_MS);
  }

  /** One watchdog pass. Safe to call concurrently; recovery itself is single-flight. */
  async tick(): Promise<CoreHealthStatus> {
    const status = this.options.getStatus();
    const now = this.now();
    this.updateTransport(status, now);

    const serverRunning = this.options.isServerRunning();
    if (serverRunning && status.localUrl) {
      this.apply({ type: 'LOCAL_MCP_CONNECTED' });
      const result = await this.options.probe(status.localUrl);
      if (result.healthy) this.apply({ type: 'TOOL_PROBE_SUCCEEDED', at: now });
      else {
        this.apply({ type: 'TOOL_PROBE_FAILED', at: now });
        this.beginRecovery(`local MCP execution probe failed: ${result.detail}`);
      }
    } else {
      this.apply({ type: 'LOCAL_MCP_DISCONNECTED' });
      if (status.state === 'connected') this.beginRecovery('remote transport is connected but the local MCP endpoint is unavailable');
    }

    if (!this.health.authRequired && this.heartbeatIsStale(status, now)) {
      this.beginRecovery('remote heartbeat is stale; replacing the half-open transport');
    } else if (!this.health.authRequired && this.joiningIsStale(status, now)) {
      this.beginRecovery('remote transport is stuck connecting; recreating it');
    }

    return this.snapshot();
  }
}
