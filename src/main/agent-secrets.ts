/**
 * The registry of live agent credentials, and the scrubber that keeps them out of
 * everything durable.
 *
 * There is exactly one credential left in this app: the one-time key that recovers a worker
 * slot whose binding was lost. Everything else about agent identity is a conversation id,
 * which is not a secret and is recorded on purpose.
 *
 * That key never goes to a model — it is written where the *user* can find it — but it still
 * passes through channels this app is built to record if it is ever used: the arguments of the
 * `agents` call that spends it, the diagnostics log, the activity feed the extension is sent.
 * So it is registered here as a value and substituted out of every string that goes to disk,
 * to the renderer or to the extension. This deliberately does not lean on logger.redact: keys
 * can be shorter than that function's generic opaque-token threshold and would sail straight
 * through it.
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
