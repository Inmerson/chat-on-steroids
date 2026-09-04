import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendOrchestrationEvent,
  initOrchestrationStore,
  readOrchestrationEvents,
  readOrchestrationSnapshot,
  resetOrchestrationStoreForTests,
  writeOrchestrationSnapshot
} from '../src/main/orchestration/store.js';

const cleanup: string[] = [];

afterEach(async () => {
  resetOrchestrationStoreForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-orchestration-'));
  cleanup.push(dir);
  initOrchestrationStore(dir);
  return dir;
}

function event(type: 'RUN_CREATED' | 'TASK_CREATED', entityId: string) {
  return {
    eventId: `${type}-${entityId}`,
    runId: 'run-1',
    time: 1_700_000_000_000,
    type,
    actor: 'kernel',
    entityId,
    payload: {}
  } as const;
}

describe('V3 orchestration durable store', () => {
  it('assigns strictly increasing sequence numbers and replays them after re-init', async () => {
    const dir = await tempStore();

    const first = await appendOrchestrationEvent(event('RUN_CREATED', 'run-1'));
    const second = await appendOrchestrationEvent(event('TASK_CREATED', 'T1'));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    resetOrchestrationStoreForTests();
    initOrchestrationStore(dir);

    const all = await readOrchestrationEvents();
    expect(all.map((entry) => [entry.seq, entry.type])).toEqual([
      [1, 'RUN_CREATED'],
      [2, 'TASK_CREATED']
    ]);
    await expect(readOrchestrationEvents(1)).resolves.toEqual([second]);
  });

  it('writes and restores an atomic orchestration snapshot', async () => {
    const dir = await tempStore();
    const snapshot = { version: 1 as const, lastSeq: 2, state: { runId: 'run-1', tasks: [] } };

    await writeOrchestrationSnapshot(snapshot);

    resetOrchestrationStoreForTests();
    initOrchestrationStore(dir);

    await expect(readOrchestrationSnapshot()).resolves.toEqual(snapshot);
  });

  it('recovers the valid prefix of a torn final journal record and repairs it before the next append', async () => {
    const dir = await tempStore();
    const first = await appendOrchestrationEvent(event('RUN_CREATED', 'run-1'));
    const journal = path.join(dir, 'state', 'orchestration', 'journal.jsonl');
    await fs.appendFile(journal, '{"seq":2,"eventId":"torn', 'utf8');

    resetOrchestrationStoreForTests();
    initOrchestrationStore(dir);

    await expect(readOrchestrationEvents()).resolves.toEqual([first]);
    const second = await appendOrchestrationEvent(event('TASK_CREATED', 'T1'));
    expect(second.seq).toBe(2);

    resetOrchestrationStoreForTests();
    initOrchestrationStore(dir);
    await expect(readOrchestrationEvents()).resolves.toEqual([first, second]);
    expect(await fs.readFile(journal, 'utf8')).not.toContain('"eventId":"torn');
  });
});
