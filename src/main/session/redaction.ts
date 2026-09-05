/** Values under these argument keys must never become durable session history. */
const CREDENTIAL_FIELDS = new Set([
  'authorization',
  'token',
  'access_token',
  'refresh_token',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'secret',
  'cookie',
  'set-cookie',
  'client_secret'
]);

const REDACTED = '[redacted]';

/**
 * Recursively removes credential-valued fields while preserving the surrounding diagnostic
 * structure. MCP arguments are JSON values, so redact by property authority rather than guessing
 * whether arbitrary prose merely looks like a token.
 */
export function sanitizeRecordedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeRecordedValue(entry));
  if (!value || typeof value !== 'object') return value;

  const sanitized: Record<string, unknown> = {};
  for (const [field, child] of Object.entries(value as Record<string, unknown>)) {
    sanitized[field] = CREDENTIAL_FIELDS.has(field.toLowerCase())
      ? REDACTED
      : sanitizeRecordedValue(child);
  }
  return sanitized;
}

/** Clipboard text is user-owned input and is intentionally never retained in session history. */
export function sanitizeComputerActions(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((action) => {
    if (!action || typeof action !== 'object') return action;
    const step = action as Record<string, unknown>;
    if (step['type'] !== 'write_clipboard' || typeof step['text'] !== 'string') return action;
    return { ...step, text: `<${step['text'].length} characters not stored>` };
  });
}

/** Applies the generic credential policy plus the recorder's argument-specific privacy rules. */
export function sanitizeRecordedArgs(tool: string, args: unknown): unknown {
  const sanitized = sanitizeRecordedValue(args);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return sanitized;

  const copy: Record<string, unknown> = { ...(sanitized as Record<string, unknown>) };
  if (copy['env'] && typeof copy['env'] === 'object' && !Array.isArray(copy['env'])) {
    copy['env'] = Object.fromEntries(Object.keys(copy['env'] as object).map((key) => [key, '***']));
  }
  if (typeof copy['dataBase64'] === 'string') {
    copy['dataBase64'] = `<${copy['dataBase64'].length} base64 characters not stored>`;
  }
  if (tool === 'computer') copy['actions'] = sanitizeComputerActions(copy['actions']);
  return copy;
}
