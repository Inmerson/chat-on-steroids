/** Start Electron development with a profile that cannot collide with the installed app. */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const suffix = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
const userData = path.join(tmpdir(), 'chat-on-steroids-dev', suffix);
await mkdir(userData, { recursive: true });

const [command, args] = process.platform === 'win32'
  ? ['cmd.exe', ['/d', '/s', '/c', 'npx electron-vite dev']]
  : ['npx', ['electron-vite', 'dev']];
const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, COS_DEV_USER_DATA: userData }
});

child.once('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
