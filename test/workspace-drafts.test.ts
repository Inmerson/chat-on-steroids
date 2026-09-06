import { beforeEach, describe, expect, it } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { listWorkspaceDrafts, resetWorkspaceDraftsForTests, saveWorkspaceDraft } from '../src/main/workspace-drafts.js';

describe('workspace drafts', () => {
  beforeEach(() => {
    resetDurableForTests();
    resetWorkspaceDraftsForTests();
    initDurableStore(`C:/tmp/cos-workspace-drafts-${Math.random()}`);
  });

  it('keeps local composer text durable without creating a delivery command', async () => {
    await saveWorkspaceDraft('session-123', 'Keep this brief');
    expect(await listWorkspaceDrafts()).toMatchObject([{ sessionId: 'session-123', text: 'Keep this brief' }]);
    await saveWorkspaceDraft('session-123', '');
    expect(await listWorkspaceDrafts()).toEqual([]);
  });
});
