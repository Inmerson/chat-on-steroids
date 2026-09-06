import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

if (process.platform !== 'win32') {
  throw new Error(`Windows Core lifecycle smoke must run on Windows, got ${process.platform}`);
}

function argValue(name, fallback = null) {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const repository = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(repository, 'release');
const explicitRoot = argValue('root');
const packageRoot = explicitRoot
  ? path.resolve(explicitRoot)
  : [path.join(releaseDir, 'win-unpacked'), path.join(releaseDir, 'win-x64-unpacked')].find((candidate) => existsSync(candidate));
if (!packageRoot) throw new Error('Could not find packaged Windows x64 application root');
const executable = path.join(packageRoot, 'Chat On Steroids.exe');
if (!existsSync(executable)) throw new Error(`Packaged executable is missing: ${executable}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, probe, timeoutMs = 30_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await sleep(100);
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

async function findTokenFile(root) {
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && entry.name === 'ipc.token' && path.basename(path.dirname(target)) === 'core') return target;
    }
  }
  return null;
}

function coreEndpoint(userDataDir) {
  const digest = createHash('sha256').update(path.resolve(userDataDir)).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\chat-on-steroids-core-${digest}`;
}

function supervisorEndpoint(userDataDir) {
  const digest = createHash('sha256').update(path.resolve(userDataDir)).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\chat-on-steroids-core-supervisor-${digest}`;
}

async function lineRequest(endpoint, line, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`IPC timeout for ${endpoint}`)));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline !== -1) finish(null, buffer.slice(0, newline).trim());
    });
  });
}

async function coreRequest(userDataDir, token, command) {
  const id = randomUUID();
  const line = await lineRequest(
    coreEndpoint(userDataDir),
    JSON.stringify({ id, token, command })
  );
  const response = JSON.parse(line);
  if (response.id !== id) throw new Error(`Core response id mismatch for ${command}`);
  if (!response.ok) throw new Error(response.error || `Core ${command} failed`);
  return response.data;
}

async function supervisorPid(userDataDir) {
  try {
    const reply = await lineRequest(supervisorEndpoint(userDataDir), 'ping', 1_500);
    if (!reply.startsWith('ok:')) return null;
    const pid = Number(reply.slice(3));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function stopSupervisor(userDataDir) {
  try {
    const reply = await lineRequest(supervisorEndpoint(userDataDir), 'shutdown', 2_000);
    if (!reply.startsWith('stopping:')) return null;
    const pid = Number(reply.slice('stopping:'.length));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function captureChild(child, label) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return {
    child,
    output: () => `${label} stdout:\n${stdout}\n${label} stderr:\n${stderr}`
  };
}

function launchUi(env, label) {
  const child = spawn(executable, [], {
    cwd: packageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  if (!child.pid) throw new Error(`${label} did not report a PID`);
  return captureChild(child, label);
}

async function terminateChild(record) {
  const pid = record?.child?.pid;
  if (!pid || !processExists(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  await waitForExit(pid).catch(() => undefined);
}

const smokeRoot = await fs.mkdtemp(path.join(tmpdir(), 'cos-core-lifecycle-'));
const roaming = path.join(smokeRoot, 'AppData', 'Roaming');
const local = path.join(smokeRoot, 'AppData', 'Local');
const home = path.join(smokeRoot, 'Home');
await Promise.all([
  fs.mkdir(roaming, { recursive: true }),
  fs.mkdir(local, { recursive: true }),
  fs.mkdir(home, { recursive: true })
]);
const env = {
  ...process.env,
  APPDATA: roaming,
  LOCALAPPDATA: local,
  USERPROFILE: home,
  HOME: home,
  ELECTRON_ENABLE_LOGGING: '1'
};

let ui1 = null;
let ui2 = null;
let userDataDir = null;
let token = null;
let lastCorePid = null;
let lastSupervisorPid = null;

try {
  ui1 = launchUi(env, 'first UI');
  const tokenPath = await waitFor('Core IPC token', async () => findTokenFile(roaming), 35_000);
  userDataDir = path.dirname(path.dirname(tokenPath));
  token = (await fs.readFile(tokenPath, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/i.test(token)) throw new Error(`Invalid Core IPC token in ${tokenPath}`);

  const hello1 = await waitFor('initial Core hello', async () => {
    try {
      return await coreRequest(userDataDir, token, 'hello');
    } catch {
      return null;
    }
  }, 35_000);
  if (!Number.isSafeInteger(hello1.corePid) || hello1.corePid <= 0) throw new Error('Initial Core hello has no valid PID');
  if (!Number.isSafeInteger(hello1.protocolVersion) || hello1.protocolVersion < 1) throw new Error('Initial Core hello has no protocol version');
  lastCorePid = hello1.corePid;
  lastSupervisorPid = await waitFor('Core supervisor', () => supervisorPid(userDataDir), 15_000);
  if (!processExists(lastSupervisorPid)) throw new Error('Core supervisor PID is not alive');

  // Abrupt UI loss is stronger than a graceful quit: the Core and supervisor must remain alive
  // even when Electron gets no teardown callback at all.
  const firstUiPid = ui1.child.pid;
  process.kill(firstUiPid, 'SIGKILL');
  await waitForExit(firstUiPid);
  const helloAfterUiExit = await waitFor('Core after UI exit', async () => {
    try {
      return await coreRequest(userDataDir, token, 'hello');
    } catch {
      return null;
    }
  }, 8_000);
  if (helloAfterUiExit.corePid !== lastCorePid) {
    throw new Error(`UI exit replaced Core ${lastCorePid} with ${helloAfterUiExit.corePid}`);
  }
  if ((await supervisorPid(userDataDir)) !== lastSupervisorPid) throw new Error('UI exit replaced the Core supervisor');

  // Kill the execution plane itself. The independent supervisor must recreate a fresh Core
  // generation without any Electron UI process being alive.
  process.kill(lastCorePid, 'SIGKILL');
  await waitForExit(lastCorePid);
  const hello2 = await waitFor('Core supervisor restart', async () => {
    try {
      const hello = await coreRequest(userDataDir, token, 'hello');
      return hello.corePid !== lastCorePid ? hello : null;
    } catch {
      return null;
    }
  }, 35_000);
  const restartedCorePid = hello2.corePid;
  if (!Number.isSafeInteger(restartedCorePid) || restartedCorePid <= 0) throw new Error('Restarted Core has no valid PID');
  lastCorePid = restartedCorePid;

  // Relaunch the UI against the still-running Core. It must attach rather than replace it.
  ui2 = launchUi(env, 'second UI');
  await sleep(2_500);
  if (!processExists(ui2.child.pid)) throw new Error(`Second UI exited early.\n${ui2.output()}`);
  const hello3 = await coreRequest(userDataDir, token, 'hello');
  if (hello3.corePid !== restartedCorePid) {
    throw new Error(`UI relaunch replaced existing Core ${restartedCorePid} with ${hello3.corePid}`);
  }

  process.stdout.write(
    `Windows persistent Core lifecycle verified: UI ${firstUiPid} exited while Core ${hello1.corePid} survived; ` +
    `Core crash restarted as ${restartedCorePid}; UI ${ui2.child.pid} reattached without replacement.\n`
  );
} catch (error) {
  const detail = [ui1?.output(), ui2?.output()].filter(Boolean).join('\n');
  throw new Error(`${error instanceof Error ? error.stack || error.message : String(error)}${detail ? `\n${detail}` : ''}`);
} finally {
  await terminateChild(ui1);
  await terminateChild(ui2);

  if (userDataDir) {
    const supervisor = await stopSupervisor(userDataDir);
    if (supervisor) await waitForExit(supervisor, 20_000).catch(() => undefined);
    if (token) {
      try {
        const hello = await coreRequest(userDataDir, token, 'hello');
        if (hello?.corePid && processExists(hello.corePid)) {
          await coreRequest(userDataDir, token, 'shutdown-core').catch(() => undefined);
          await waitForExit(hello.corePid, 15_000).catch(() => {
            try { process.kill(hello.corePid, 'SIGKILL'); } catch { /* already gone */ }
          });
        }
      } catch {
        // Supervisor shutdown normally stops Core before this cleanup probe can connect.
      }
    }
  }

  if (lastSupervisorPid && processExists(lastSupervisorPid)) {
    try { process.kill(lastSupervisorPid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (lastCorePid && processExists(lastCorePid)) {
    try { process.kill(lastCorePid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await fs.rm(smokeRoot, { recursive: true, force: true }).catch(() => undefined);
}
