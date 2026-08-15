import { describe, expect, it } from 'vitest';
import { buildCompletionBody, parseOpenRouterModel } from '../src/main/openrouter.js';

describe('OpenRouter model metadata', () => {
  it('uses modern provider limits and exact reasoning metadata', () => {
    const model = parseOpenRouterModel({
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      context_length: 1_048_576,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['reasoning', 'max_tokens'],
      top_provider: { context_length: 1_024_000, max_completion_tokens: 384_000 },
      reasoning: {
        supported_efforts: ['xhigh', 'high'],
        default_effort: 'high',
        default_enabled: true,
        mandatory: false
      },
      pricing: { prompt: '0.00000009', completion: '0.00000018' }
    });

    expect(model).not.toBeNull();
    expect(model).toMatchObject({
      id: 'deepseek/deepseek-v4-flash',
      contextLength: 1_048_576,
      providerContextLength: 1_024_000,
      maxCompletionTokens: 384_000,
      reasoning: true,
      reasoningLevels: ['xhigh', 'high'],
      reasoningMandatory: false,
      reasoningDefault: 'high'
    });
  });
});

describe('OpenRouter completion request', () => {
  it('really disables optional reasoning and uses the non-deprecated completion limit', () => {
    const body = buildCompletionBody({
      model: 'deepseek/deepseek-v4-flash',
      system: 'system',
      user: 'history',
      reasoning: 'off',
      reasoningLevels: ['xhigh', 'high'],
      reasoningMandatory: false,
      maxCompletionTokens: 64_000
    });

    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.max_completion_tokens).toBe(64_000);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('can disable a reasoning model even when it exposes no selectable effort levels', () => {
    const body = buildCompletionBody({
      model: 'reasoner/no-effort-selector',
      system: 'system',
      user: 'history',
      reasoning: 'off',
      reasoningSupported: true,
      reasoningLevels: [],
      reasoningMandatory: false,
      maxCompletionTokens: 8_000
    });
    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  it('does not send an impossible Off setting to a mandatory-reasoning model', () => {
    const body = buildCompletionBody({
      model: 'mandatory/reasoner',
      system: 'system',
      user: 'history',
      reasoning: 'off',
      reasoningLevels: ['high'],
      reasoningMandatory: true,
      maxCompletionTokens: 8_000
    });
    expect(body).not.toHaveProperty('reasoning');
  });
});
