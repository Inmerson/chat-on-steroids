import type { ChatModelCatalog } from '../shared/chat-models.js';
import { $, el } from './dom.js';

let catalog: ChatModelCatalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
let generation = 0;
let discovery: Promise<void> | null = null;

function paint(): void {
  const status = $('chatModelStatus');
  const list = $('chatModelList');
  const refresh = $<HTMLButtonElement>('refreshChatModels');
  refresh.disabled = false;
  status.textContent = catalog.state === 'pending'
    ? 'Reading the model choices available in your ChatGPT account?'
    : catalog.state === 'ready'
      ? `Confirmed by ChatGPT${catalog.observedAt ? ` ? checked ${new Date(catalog.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
      : catalog.error ?? 'Connect the browser extension, then load the models available to this ChatGPT account.';
  list.replaceChildren(...catalog.models.map((model) => {
    const row = el('div', 'model-catalog-row');
    row.append(el('strong', '', model.label), el('span', 'muted', model.efforts.join(' ? ')));
    row.dataset.modelId = model.id;
    return row;
  }));
  list.toggleAttribute('hidden', catalog.models.length === 0);
}

async function discover(): Promise<void> {
  if (discovery) return discovery;
  const requested = ++generation;
  catalog = { ...catalog, state: 'pending', requestedAt: Date.now(), error: undefined };
  paint();
  const work = (async () => {
    try {
      const response = await window.api.requestChatModels();
      if (requested !== generation) return;
      catalog = response.ok
        ? response.data
        : { ...catalog, state: 'unavailable', error: response.error };
      paint();
    } catch {
      if (requested !== generation) return;
      catalog = { ...catalog, state: 'unavailable', error: 'Model discovery could not start.' };
      paint();
    }
  })();
  discovery = work.finally(() => { discovery = null; });
  return discovery;
}

/** Model discovery is observational. This module never edits Goal/OpenRouter settings. */
export function initChatModels(): void {
  $('refreshChatModels').addEventListener('click', () => void discover());
  window.api.onChatModelsChanged((value) => {
    ++generation;
    catalog = value;
    paint();
  });
  const requested = ++generation;
  void window.api.getChatModels().then((response) => {
    if (requested !== generation || !response.ok) return;
    catalog = response.data;
    paint();
  }).catch(() => undefined);
  paint();
}
