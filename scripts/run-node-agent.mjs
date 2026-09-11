import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const entry = resolve('out/main/node-agent/main.js');
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
child.on('error', (error) => { console.error(`node-agent launcher failed: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
