import { describe, expect, it } from 'vitest';
import {
  htmlToCleanMarkdown,
  htmlToSemanticTree,
  runSystemProcess,
  findSymbolDefinition,
  findSymbolReferences,
  outlineSourceSymbols
} from '../src/main/mcp/tools-power-agent.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { initDurableStore, readDurable, writeDurableNow } from '../src/main/durable.js';

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
  it('bounds system process output before it can flood one model turn', async () => {
    const result = await runSystemProcess(
      'powershell.exe',
      ['-NoProfile', '-Command', "[Console]::Out.Write(('x' * 250000))"],
      process.cwd(),
      10_000
    );
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(100_000);
    expect(result.truncated).toBe(true);
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

  it('persists and recalls agent memory via durable store', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cglf-mem-test-'));
    initDurableStore(tempDir);

    const testMemories = {
      memories: {
        project_goal: {
          key: 'project_goal',
          category: 'project',
          content: 'Autonomous AI bridge on Windows',
          updatedAt: new Date().toISOString()
        }
      }
    };

    await writeDurableNow('agent-memory', testMemories);

    const retrieved = await readDurable<typeof testMemories>('agent-memory');
    expect(retrieved?.memories.project_goal.content).toBe('Autonomous AI bridge on Windows');

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('extracts interactive element map and semantic tree for Codex browsing', () => {
    const html = `
      <html>
        <body>
          <input name="username" placeholder="Enter username" />
          <button id="login-btn">Sign In</button>
          <a href="/help">Documentation Link</a>
        </body>
      </html>
    `;
    const { interactive, markdown } = htmlToSemanticTree(html);
    expect(interactive.length).toBeGreaterThanOrEqual(3);
    expect(interactive.some((i) => i.tag === 'input')).toBe(true);
    expect(interactive.some((i) => i.tag === 'button')).toBe(true);
    expect(interactive.some((i) => i.tag === 'link')).toBe(true);
    expect(markdown).toContain('Documentation Link');
  });

  it('finds symbol definitions, references, and outlines in code files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cglf-code-test-'));
    const sourceFile = path.join(tempDir, 'PlayerController.cs');
    const csharpCode = `
using System;
namespace Game.Core {
  public class PlayerController {
    public int health = 100;
    public void TakeDamage(int amount) {
      health -= amount;
    }
  }
}
`;
    await fs.writeFile(sourceFile, csharpCode, 'utf8');

    const defs = await findSymbolDefinition('PlayerController', tempDir);
    expect(defs.length).toBeGreaterThanOrEqual(1);
    expect(defs[0]?.file).toBe(sourceFile);
    expect(defs[0]?.kind).toContain('class');

    const refs = await findSymbolReferences('health', tempDir);
    expect(refs.length).toBeGreaterThanOrEqual(2);

    const outline = await outlineSourceSymbols(sourceFile);
    expect(outline).toContain('PlayerController');
    expect(outline).toContain('TakeDamage');

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('manages project checkpoints and snapshots via durable store', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cglf-cp-test-'));
    initDurableStore(tempDir);

    const testCheckpoints = {
      checkpoints: {
        cp_1: {
          id: 'cp_1',
          name: 'initial_state',
          timestamp: new Date().toISOString(),
          targetPath: tempDir,
          files: {
            'main.ts': 'console.log("v1");'
          }
        }
      }
    };

    await writeDurableNow('agent-checkpoints', testCheckpoints);

    const retrieved = await readDurable<typeof testCheckpoints>('agent-checkpoints');
    expect(retrieved?.checkpoints.cp_1.name).toBe('initial_state');
    expect(retrieved?.checkpoints.cp_1.files['main.ts']).toBe('console.log("v1");');

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
