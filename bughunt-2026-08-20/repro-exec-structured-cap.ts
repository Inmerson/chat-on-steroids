import { execCommandResponseText, execCommandStructuredOutput, type ExecCommandToolOutput } from '../src/main/codex/unified-exec.js';

const raw = Buffer.from('x'.repeat(240_000), 'utf8');
const base: ExecCommandToolOutput = {
  chunkId: 'proof',
  wallTimeMs: 0,
  rawOutput: raw,
  truncationPolicy: { kind: 'tokens', tokens: 10_000 },
  maxOutputTokens: undefined,
  processId: null,
  exitCode: 0,
  originalTokenCount: 60_000,
  outputOmittedBytes: null
};

const text = execCommandResponseText(base);
const structuredDefault = String(execCommandStructuredOutput(base).output);
const structuredExplicitHuge = String(execCommandStructuredOutput({ ...base, maxOutputTokens: 100_000 }).output);

console.log(
  JSON.stringify({
    rawChars: raw.length,
    modelTextChars: text.length,
    structuredDefaultChars: structuredDefault.length,
    structuredExplicitHugeChars: structuredExplicitHuge.length,
    modelTextWarnsTruncated: text.includes('Warning: truncated output'),
    structuredDefaultWarnsTruncated: structuredDefault.includes('Warning: truncated output')
  })
);
