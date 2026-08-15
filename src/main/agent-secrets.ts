/**
 * The registry of live agent credentials, and the scrubber that keeps them out of
 * everything durable.
 *
 * Multi-agent identity rests on secrets the model is told and then repeats back, which
 * means those secrets travel through exactly the channels this app is built to record:
 * tool arguments, tool results, the bootstrap message a worker's chat is opened with,
 * the diagnostics log, and the activity feed the browser extension is sent. Any one of
 * those would turn a capability into a published fact — and a published worker key is
 * how a worker becomes the prime.
 *
 * So every credential is registered here the moment it is minted, and every path that
 * writes text to disk, to the renderer or to the extension scrubs through this module
 * first. It deliberately does not lean on logger.redact: these keys are shorter than
 * that function's generic opaque-token threshold and would sail straight through it.
 *
 * Kept dependency-free so the logger, the recorder, the bridge and the broker can all
 * import it without a cycle.
 */

/** Below this, a "secret" is too short to replace without mangling ordinary text. */
const MIN_SECRET_CHARS = 12;

const secrets = new Set<string>();

/**
 * Registers a credential to be scrubbed from now on.
 *
 * Retired keys are never removed individually: a spent join key still sits in the
 * ChatGPT message that opened the worker's chat, and the extension re-reports that
 * message every time the tab is reloaded. They are dropped only when the whole run is.
 */
export function registerAgentSecret(value: string): void {
  if (value.length >= MIN_SECRET_CHARS) secrets.add(value);
}

/** Drops the registry. Called when a swarm is reset, i.e. when the run is over. */
export function forgetAgentSecrets(): void {
  secrets.clear();
}

export function agentSecretCount(): number {
  return secrets.size;
}

/** Replaces every registered credential in a string. Free when none are registered. */
export function scrubAgentSecrets(text: string): string {
  if (secrets.size === 0 || !text) return text;
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('<agent key removed>');
  }
  return out;
}

/**
 * Scrubs a whole value, structure intact.
 *
 * Used on tool arguments, where a credential arrives as one field of an object and the
 * rest of the object is exactly what the recording is for. Depth is bounded because
 * this runs on model-supplied input.
 */
export function scrubAgentSecretsDeep(value: unknown, depth = 0): unknown {
  if (secrets.size === 0 || depth > 6) return value;
  if (typeof value === 'string') return scrubAgentSecrets(value);
  if (Array.isArray(value)) return value.map((item) => scrubAgentSecretsDeep(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        scrubAgentSecretsDeep(item, depth + 1)
      ])
    );
  }
  return value;
}
