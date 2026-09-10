/** Presentation only. The stored result and any overflow asset remain unchanged. */
export function toolResultText(text: string, truncated: boolean, hasImages: boolean): string {
  try {
    const value = JSON.parse(text) as { content?: unknown; structuredContent?: unknown };
    if (value && Array.isArray(value.content)) {
      const readable = value.content.flatMap((block: unknown) => {
        if (!block || typeof block !== 'object') return [];
        const row = block as { type?: unknown; text?: unknown; resource?: { text?: unknown } };
        if (row.type === 'text' && typeof row.text === 'string') return [row.text];
        if (row.type === 'resource' && typeof row.resource?.text === 'string') return [row.resource.text];
        return [];
      });
      if (readable.length) return readable.join('\n\n');
      if (value.structuredContent !== undefined) return JSON.stringify(value.structuredContent, null, 2);
      if (hasImages) return '';
    }
  } catch { /* Overflow prefixes may end inside a binary field; never paint that payload. */ }
  if (hasImages && truncated) return 'Image result. Full response retained in the recording.';
  return text;
}
