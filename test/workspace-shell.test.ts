import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { initWorkspaceShell } from '../src/renderer/workspace-shell.js';

describe('workspace shell', () => {
  it('opens the existing Control Center from the workspace without changing the selected session', () => {
    const dom = new JSDOM('<button id="workspaceOpenControl" type="button">Open Control Center</button>');
    const openControl = vi.fn();

    initWorkspaceShell(dom.window.document, { openControl });
    (dom.window.document.getElementById('workspaceOpenControl') as HTMLButtonElement).click();

    expect(openControl).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the optional workspace action is absent', () => {
    const dom = new JSDOM('<main></main>');
    const openControl = vi.fn();

    expect(() => initWorkspaceShell(dom.window.document, { openControl })).not.toThrow();
    expect(openControl).not.toHaveBeenCalled();
  });
});
