import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

function run(command, args) {
  if (process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    args = ['/d', '/s', '/c', command, ...args];
    command = 'cmd.exe';
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code ?? 1}`)));
  });
}

await run(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build']);
await mkdir(resolve('release'), { recursive: true });
const pkgBin = resolve('node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
await run(process.execPath, [pkgBin, 'out/main/node-agent/main.js', '--targets', 'node22-win-x64', '--output', 'release/Chat-On-Steroids-Node-Agent.exe']);
console.log('Node Agent EXE written to release/Chat-On-Steroids-Node-Agent.exe');
