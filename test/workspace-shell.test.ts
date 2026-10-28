import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { initWorkspaceShell, renderWorkspacePulse, workspacePulseMetrics } from '../src/renderer/workspace-shell.js';

describe('workspace shell', () => {
  it('opens the existing Control Center from the workspace without changing the selected session', () => {
    const dom = new JSDOM('<button id="workspaceOpenControl" type="button">Open Control Center</button>');
    const openControl = vi.fn();

    initWorkspaceShell(dom.window.document, { openControl, getStatus: async () => null });
    (dom.window.document.getElementById('workspaceOpenControl') as HTMLButtonElement).click();

    expect(openControl).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the optional workspace action is absent', () => {
    const dom = new JSDOM('<main></main>');
    const openControl = vi.fn();

    expect(() => initWorkspaceShell(dom.window.document, { openControl, getStatus: async () => null })).not.toThrow();
    expect(openControl).not.toHaveBeenCalled();
  });

  it('projects only the compact run facts needed beside the session timeline', () => {
    expect(workspacePulseMetrics({
      run: { health: 'blocked', activeAgents: 2, progress: { verified: 1, total: 4 } },
      blockers: [{ id: 'blocker-a' }],
      needsAttention: [{ id: 'attention-a' }]
    })).toEqual({ label: 'Needs attention', detail: '1 blocker · 1 needs you', tone: 'is-bad' });

    expect(workspacePulseMetrics({
      run: { health: 'running', activeAgents: 3, progress: { verified: 2, total: 5 } },
      blockers: [],
      needsAttention: []
    })).toEqual({ label: '3 agents active', detail: '2 of 5 tasks verified', tone: 'is-active' });
  });

  it('renders a status projection without rebuilding the session view', () => {
    const dom = new JSDOM('<span id="workspacePulse"></span><span id="workspacePulseDetail"></span>');
    renderWorkspacePulse(dom.window.document, {
      run: { health: 'verified', activeAgents: 0, progress: { verified: 2, total: 2 } }, blockers: [], needsAttention: []
    });

    expect(dom.window.document.getElementById('workspacePulse')!.textContent).toBe('Run verified');
    expect(dom.window.document.getElementById('workspacePulse')!.className).toContain('is-good');
    expect(dom.window.document.getElementById('workspacePulseDetail')!.textContent).toBe('2 of 2 tasks verified');
  });
});
