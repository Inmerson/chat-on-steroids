import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  appendOrchestrationEvent,
  readOrchestrationEvents,
  resetOrchestrationStoreForTests
} from '../src/main/orchestration/store.js';

const cleanup: string[] = [];

afterEach(async () => {
  resetDurableForTests();
  resetOrchestrationStoreForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('V3 orchestration production bootstrap', () => {
  it('initializes the orchestration journal when the normal durable store is initialized', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-orchestration-bootstrap-'));
    cleanup.push(dir);

    // Production startup already calls this before it starts serving the MCP runtime.
    // V3 must not require a second hidden initializer that tests remember but the app forgets.
    initDurableStore(dir);

    const appended = await appendOrchestrationEvent({
      eventId: 'bootstrap-run-created',
      runId: 'bootstrap-run',
      time: 1_700_000_000_000,
      type: 'RUN_CREATED',
      actor: 'kernel',
      entityId: 'bootstrap-run',
      payload: {}
    });

    expect(appended.seq).toBe(1);
    await expect(readOrchestrationEvents()).resolves.toEqual([appended]);
  });
});
