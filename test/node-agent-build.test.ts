import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Node Agent production entrypoint', () => {
  it('is emitted by the normal build and help has no runtime side effects', () => {
    if (process.platform === 'win32') execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm run build'], { stdio: 'pipe' });
    else execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
    expect(existsSync('out/main/node-agent/main.js')).toBe(true);
    const help = execFileSync(process.execPath, ['out/main/node-agent/main.js', '--help'], { encoding: 'utf8' });
    expect(help).toContain('node-agent --config');
  }, 120_000);
});
