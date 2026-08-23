import { describe, expect, it } from 'vitest';
import { htmlToCleanMarkdown, runSystemProcess } from '../src/main/mcp/tools-power-agent.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';

describe('Power Agent tools', () => {
  it('converts HTML to clean readable markdown', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Page</title><style>.cls { color: red; }</style></head>
        <body>
          <script>console.log('secret');</script>
          <h1>Main Title</h1>
          <p>This is a paragraph with a <a href="https://example.com">link here</a>.</p>
          <ul>
            <li>Item 1</li>
            <li>Item 2</li>
          </ul>
        </body>
      </html>
    `;
    const md = htmlToCleanMarkdown(html);
    expect(md).toContain('## Main Title');
    expect(md).toContain('This is a paragraph with a [link here](https://example.com).');
    expect(md).toContain('- Item 1');
    expect(md).toContain('- Item 2');
    expect(md).not.toContain('console.log');
    expect(md).not.toContain('color: red');
  });

  it('runs system process with stdout output capture', async () => {
    const result = await runSystemProcess('powershell.exe', ['-NoProfile', '-Command', '"Hello from System PowerShell"'], process.cwd(), 10_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Hello from System PowerShell');
  });

  it('reads, writes, and lists files across system temp paths', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-power-test-'));
    const testFile = path.join(tempDir, 'subfolder', 'test.txt');
    
    await fs.mkdir(path.dirname(testFile), { recursive: true });
    await fs.writeFile(testFile, 'System wide test content', 'utf8');

    const readBack = await fs.readFile(testFile, 'utf8');
    expect(readBack).toBe('System wide test content');

    const entries = await fs.readdir(tempDir);
    expect(entries).toContain('subfolder');

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
