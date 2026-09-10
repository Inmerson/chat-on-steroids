import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

describe('correctness paths that promise to inspect every retained session', () => {
  it('use the uncapped session catalogue rather than the bounded UI list', () => {
    const store = source('src/main/session/store.ts');
    const search = source('src/main/mcp/session-tool.ts');
    const correlation = source('src/main/session/correlation.ts');
    const recorder = source('src/main/session/recorder.ts');

    expect(store).toMatch(/export async function readEverySummary\(/);
    expect(search).toMatch(/readEverySummary\(\)/);
    expect(correlation).toMatch(/readEverySummary\(\)/);
    expect(recorder).toMatch(/for \(const summary of await readEverySummary\(\)\)/);
  });
});
