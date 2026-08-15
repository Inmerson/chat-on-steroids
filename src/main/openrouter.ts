/**
 * OpenRouter client: the model list, and one streaming chat completion.
 *
 * Deliberately small. Compaction needs exactly two things — which models exist, and a
 * completion whose text arrives while it is being generated so the app can show real
 * progress instead of a spinner. No SDK is pulled in for that.
 *
 * The API key stays in the main process. It is read from encrypted storage at call
 * time, never cached in a module variable, never logged, and never sent to the
 * renderer or the browser extension.
 */

import type { OpenRouterModel, ReasoningEffort } from '../shared/session.js';
import { getSecret } from './secrets.js';
import { logInfo, logWarn } from './logger.js';

const BASE = 'https://openrouter.ai/api/v1';
/** Identifies this app to OpenRouter; both headers are optional but polite. */
const HEADERS = {
  'HTTP-Referer': 'https://github.com/chatgpt-local-files',
  'X-Title': 'ChatGPT Local Files'
};
const MODEL_CACHE_MS = 30 * 60 * 1000;

export class OpenRouterError extends Error {}

interface RawModel {
  id?: unknown;
  name?: unknown;
  created?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown; modality?: unknown };
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
}

let cache: { at: number; models: OpenRouterModel[] } | null = null;

async function apiKey(): Promise<string> {
  const key = await getSecret('openrouterApiKey');
  if (!key) throw new OpenRouterError('No OpenRouter API key is saved. Add one in the Chat tab.');
  return key;
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isTextModel(raw: RawModel): boolean {
  const architecture = raw.architecture ?? {};
  const input = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : null;
  const output = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : null;
  if (input && output) return input.includes('text') && output.includes('text');
  // Older entries only carry a "text->text" style modality string.
  return typeof architecture.modality !== 'string' || architecture.modality.includes('text');
}

/**
 * Which reasoning efforts a model will actually accept.
 *
 * OpenRouter's catalogue says whether a model takes a `reasoning` parameter, not which
 * efforts it honours, so the standard three are assumed for a model that takes one and
 * nothing is assumed for a model that does not. `xhigh` is added only when the entry
 * itself mentions it — the alternative, offering it everywhere, means the app sends a
 * setting the provider rejects and blames the compaction.
 */
function reasoningLevelsOf(raw: RawModel, supported: boolean): ReasoningEffort[] {
  if (!supported) return [];
  const levels: ReasoningEffort[] = ['low', 'medium', 'high'];
  try {
    if (JSON.stringify(raw).toLowerCase().includes('xhigh')) levels.push('xhigh');
  } catch {
    // A model entry that will not serialise is not worth failing the whole list over.
  }
  return levels;
}

/** The catalogue, cached for half an hour. Force a refresh with `refresh`. */
export async function listModels(refresh = false): Promise<OpenRouterModel[]> {
  if (!refresh && cache && Date.now() - cache.at < MODEL_CACHE_MS) return cache.models;
  const response = await fetch(`${BASE}/models`, {
    headers: { ...HEADERS, authorization: `Bearer ${await apiKey()}` }
  });
  if (!response.ok) {
    throw new OpenRouterError(`OpenRouter refused the model list (HTTP ${response.status})`);
  }
  const body = (await response.json()) as { data?: RawModel[] };
  const models: OpenRouterModel[] = [];
  for (const raw of body.data ?? []) {
    if (typeof raw.id !== 'string' || !isTextModel(raw)) continue;
    const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
    const reasoning = parameters.includes('reasoning') || parameters.includes('include_reasoning');
    models.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : raw.id,
      contextLength: toNumber(raw.context_length),
      reasoning,
      reasoningLevels: reasoningLevelsOf(raw, reasoning),
      created: toNumber(raw.created),
      promptPrice: toNumber(raw.pricing?.prompt),
      completionPrice: toNumber(raw.pricing?.completion)
    });
  }
  // Newest first: someone choosing a compaction model wants this month's models at the
  // top, not whichever vendor's name sorts earliest. Entries with no listing date fall
  // to the end rather than jumping the queue, and ties break by name so the order is
  // stable between refreshes.
  models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.name.localeCompare(b.name));
  cache = { at: Date.now(), models };
  logInfo(`openrouter: ${models.length} text models available`);
  return models;
}

/**
 * Picks the default model from what OpenRouter actually offers today.
 *
 * DeepSeek's small fast model is the intended default, but its exact id changes with
 * each release, so it is matched by shape against the live catalogue rather than
 * hard-coded — a stale id would fail at the worst possible moment, mid-compaction.
 * If nothing matches, the fallback is the cheapest model with a large context, since
 * compaction is a long-input job.
 */
export function pickDefaultModel(models: readonly OpenRouterModel[]): string | null {
  if (models.length === 0) return null;
  const deepseek = models.filter((model) => model.id.startsWith('deepseek/'));
  const preferred =
    deepseek.find((model) => /v4/i.test(model.id) && /flash/i.test(model.id)) ??
    deepseek.find((model) => /v4/i.test(model.id) && /flash/i.test(model.name)) ??
    deepseek.find((model) => /flash/i.test(model.id)) ??
    deepseek.find((model) => /v4/i.test(model.id));
  if (preferred) return preferred.id;

  const roomy = models
    .filter((model) => (model.contextLength ?? 0) >= 100_000 && model.promptPrice !== null)
    .sort((a, b) => (a.promptPrice ?? 0) - (b.promptPrice ?? 0));
  return roomy[0]?.id ?? models[0]?.id ?? null;
}

// ------------------------------------------------------------- completions

export interface CompletionRequest {
  model: string;
  system: string;
  user: string;
  reasoning: ReasoningEffort;
  /**
   * Efforts this model accepts, from its live catalogue entry.
   *
   * Omit only when the catalogue could not be read. An effort outside this list is not
   * sent at all: telling the user an unsupported setting "will be ignored" while still
   * putting it in the request body is how a compaction fails with a provider error
   * instead of being quietly downgraded.
   */
  reasoningLevels?: readonly ReasoningEffort[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionHandlers {
  onText: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
}

export interface CompletionResult {
  text: string;
  reasoning: string;
  /** Why generation stopped, as reported by the provider, or null. */
  finishReason: string | null;
  /** Set when the provider stopped for a reason that means the answer is incomplete. */
  truncated: boolean;
}

/**
 * Streams one completion.
 *
 * Server-sent events are parsed by hand: the payload is a sequence of `data:` lines,
 * a final `data: [DONE]`, and occasional `: comment` keepalives. Anything unparseable
 * is skipped rather than aborting a compaction that is otherwise going fine.
 */
export async function complete(
  request: CompletionRequest,
  handlers: CompletionHandlers
): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user }
    ]
  };
  if (request.maxTokens) body['max_tokens'] = request.maxTokens;
  const levels = request.reasoningLevels;
  const supportsReasoning = levels === undefined || levels.length > 0;
  if (!supportsReasoning) {
    // The model takes no reasoning parameter at all; sending one is an error, not a
    // no-op, so nothing about reasoning goes in the body.
  } else if (request.reasoning === 'off') {
    body['reasoning'] = { exclude: true };
  } else if (levels === undefined || levels.includes(request.reasoning)) {
    body['reasoning'] = { effort: request.reasoning };
  } else {
    logWarn(
      `openrouter: ${request.model} does not advertise "${request.reasoning}" reasoning; sending the request without a reasoning setting`
    );
  }

  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      ...HEADERS,
      authorization: `Bearer ${await apiKey()}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: request.signal
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new OpenRouterError(explainHttp(response.status, detail));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let finishReason: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: unknown; reasoning?: unknown };
            finish_reason?: unknown;
          }>;
          error?: { message?: unknown };
        };
        if (parsed.error?.message) throw new OpenRouterError(String(parsed.error.message));
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
        const content = choice.delta?.content;
        if (typeof content === 'string' && content) {
          text += content;
          handlers.onText(content);
        }
        const thought = choice.delta?.reasoning;
        if (typeof thought === 'string' && thought) {
          reasoning += thought;
          handlers.onReasoning?.(thought);
        }
      } catch (err) {
        if (err instanceof OpenRouterError) throw err;
        // One malformed frame is not worth losing everything received so far.
      }
    }
  }

  return {
    text,
    reasoning,
    finishReason,
    truncated: finishReason === 'length' || finishReason === 'content_filter'
  };
}

function explainHttp(status: number, detail: string): string {
  const trimmed = detail.slice(0, 300).replace(/\s+/g, ' ').trim();
  if (status === 401) return 'OpenRouter rejected the API key.';
  if (status === 402) return 'The OpenRouter account has no credit left for this model.';
  if (status === 404) return 'OpenRouter does not know that model id. Pick another model.';
  if (status === 429) return 'OpenRouter is rate limiting this key. Wait and try again.';
  if (status >= 500) return `OpenRouter had a server error (HTTP ${status}).`;
  return `OpenRouter refused the request (HTTP ${status})${trimmed ? `: ${trimmed}` : ''}`;
}

/** Verifies a key without spending anything, for the Save button in the UI. */
export async function checkKey(): Promise<boolean> {
  try {
    await listModels(true);
    return true;
  } catch (err) {
    logWarn(`openrouter: key check failed — ${(err as Error).message}`);
    return false;
  }
}
