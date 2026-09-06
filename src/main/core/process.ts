import { spawn as nodeSpawn } from 'node:child_process';
import {
  CORE_CAPABILITIES,
  CORE_PROTOCOL_VERSION,
  isCoreCompatible,
  type CoreHello
} from '../../shared/core-protocol.js';
import { CoreIpcClient, coreEndpointForUserData } from './ipc.js';
import type { CoreProcessAdapter, CoreProbeResult, CoreSpawnResult } from './supervisor.js';

export interface SpawnedProcessLike {
  pid?: number;
  unref(): void;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type SpawnLike = (
  file: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: 'ignore';
    windowsHide: boolean;
    shell: false;
  }
) => SpawnedProcessLike;

export interface CoreClientLike {
  hello(): Promise<CoreHello>;
  shutdownCore(): Promise<boolean>;
}

export interface CoreProcessAdapterOptions {
  execPath: string;
  userDataDir: string;
  token: string;
  spawn?: SpawnLike;
  clientFactory?: () => CoreClientLike;
  now?: () => number;
}

const REQUIRED_CORE_CAPABILITIES = [...CORE_CAPABILITIES];

function defaultClientFactory(userDataDir: string, token: string): () => CoreClientLike {
  return () => new CoreIpcClient(coreEndpointForUserData(userDataDir), token);
}

function detachedOptions(): {
  detached: true;
  stdio: 'ignore';
  windowsHide: true;
  shell: false;
} {
  return { detached: true, stdio: 'ignore', windowsHide: true, shell: false };
}

/**
 * The supervisor judges a Core by its authenticated/versioned IPC hello. A stale PID, process
 * handle or executable name is never accepted as health because none proves the MCP runtime is
 * actually serving requests.
 */
export function createCoreProcessAdapter(options: CoreProcessAdapterOptions): CoreProcessAdapter {
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const clientFactory = options.clientFactory ?? defaultClientFactory(options.userDataDir, options.token);
  const now = options.now ?? Date.now;
  let firstHealthyPid: number | null = null;
  let firstHealthyAt: number | null = null;

  return {
    probe: async (): Promise<CoreProbeResult> => {
      try {
        const hello = await clientFactory().hello();
        const compatible = isCoreCompatible(
          { protocolVersion: CORE_PROTOCOL_VERSION, requiredCapabilities: REQUIRED_CORE_CAPABILITIES },
          hello
        );
        if (!compatible || !Number.isSafeInteger(hello.corePid) || hello.corePid <= 0) return { healthy: false };
        if (hello.corePid !== firstHealthyPid) {
          firstHealthyPid = hello.corePid;
          firstHealthyAt = now();
        }
        return { healthy: true, pid: hello.corePid, startedAt: firstHealthyAt ?? now() };
      } catch {
        firstHealthyPid = null;
        firstHealthyAt = null;
        return { healthy: false };
      }
    },
    spawn: async (): Promise<CoreSpawnResult> => {
      const child = spawn(
        options.execPath,
        ['--core-host', '--core-user-data', options.userDataDir],
        detachedOptions()
      );
      if (!child.pid) throw new Error('Core Host process did not report a PID');
      child.once('error', () => undefined);
      child.unref();
      return { pid: child.pid, startedAt: now() };
    },
    stop: async (): Promise<void> => {
      try {
        await clientFactory().shutdownCore();
      } catch {
        // A dead/unreachable Core is already stopped from the supervisor's point of view.
      }
    }
  };
}

export interface StartCoreSupervisorOptions {
  execPath: string;
  userDataDir: string;
  spawn?: SpawnLike;
}

/** UI fire-and-forgets this daemon; the daemon, not Electron UI, owns Core crash recovery. */
export function startCoreSupervisorDetached(options: StartCoreSupervisorOptions): number {
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const child = spawn(
    options.execPath,
    ['--core-supervisor', '--core-user-data', options.userDataDir],
    detachedOptions()
  );
  if (!child.pid) throw new Error('Core supervisor process did not report a PID');
  child.once('error', () => undefined);
  child.unref();
  return child.pid;
}
