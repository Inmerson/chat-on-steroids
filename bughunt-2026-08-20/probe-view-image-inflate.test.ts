import path from 'node:path';
import { expect, it } from 'vitest';
import { viewImage } from '../src/main/codex/view-image.js';
it('probe: tiny compressed PNG expands unbounded during synchronous validation', async()=>{
  const file=path.join(process.cwd(),'bughunt-2026-08-20','png-inflate-probe.png');
  const before=process.memoryUsage();
  const started=performance.now();
  const result=await viewImage(file,null,undefined,'/probe.png');
  const elapsed=performance.now()-started;
  const after=process.memoryUsage();
  console.log(JSON.stringify({inputBytes:result.bytes,elapsedMs:Math.round(elapsed),rssDeltaMiB:+((after.rss-before.rss)/1048576).toFixed(1),externalDeltaMiB:+((after.external-before.external)/1048576).toFixed(1),base64Chars:result.base64.length}));
  expect(result.bytes).toBeLessThan(100_000);
  expect(result.mimeType).toBe('image/png');
});
