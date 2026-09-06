import { CoreIpcClient, coreEndpointForUserData, ensureCoreIpcToken } from './ipc.js';
import { requestCoreSupervisorStop } from './ownership.js';

interface UpdateCoreClient {
  hello(): Promise<{ corePid: number }>;
  shutdownCore(): Promise<boolean>;
}

export interface CoreUpdateQuiesceDependencies {
  token?: (userDataDir: string) => Promise<string>;
  client?: (endpoint: string, token: string) => UpdateCoreClient;
  stopSupervisor?: (userDataDir: string) => Promise<number | null>;
}

export interface CoreUpdateQuiesceResult {
  waitPids: number[];
}

/**
 * Captures the processes that can hold the installed Electron executable open, then requests
 * graceful quiesce. The external updater helper is responsible for the stronger ordering proof:
 * it waits until every returned PID is actually gone before creating NSIS.
 */
export async function prepareInstalledCoreUpdateHandoff(
  userDataDir: string,
  dependencies: CoreUpdateQuiesceDependencies = {}
): Promise<CoreUpdateQuiesceResult> {
  const token = await (dependencies.token ?? ensureCoreIpcToken)(userDataDir);
  const client = (dependencies.client ?? ((endpoint, secret) => new CoreIpcClient(endpoint, secret)))(
    coreEndpointForUserData(userDataDir),
    token
  );

  let corePid: number | null = null;
  try {
    const hello = await client.hello();
    if (Number.isSafeInteger(hello.corePid) && hello.corePid > 0) corePid = hello.corePid;
  } catch {
    // Core can legitimately be absent when the UI never connected in this profile.
  }

  const supervisorPid = await (dependencies.stopSupervisor ?? requestCoreSupervisorStop)(userDataDir);

  if (corePid !== null) {
    // The supervisor has already been told to stop, so a direct Core request cannot be mistaken
    // for an ordinary crash and intentionally restarted forever. Its final stopHost() is a second
    // fence against an in-flight restart that was already underway.
    await client.shutdownCore().catch(() => false);
  }

  return {
    waitPids: [...new Set([corePid, supervisorPid].filter((pid): pid is number => pid !== null))]
  };
}
