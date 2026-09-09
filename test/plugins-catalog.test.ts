import { expect, it } from 'vitest';

import { pluginCatalog, reviewedPluginLicense } from '../src/main/plugins/catalog.js';

it('uses reviewed transitional licenses only for the exact installed distribution', () => {
  const memory = pluginCatalog.find((recipe) => recipe.id === 'memory')!;
  expect(reviewedPluginLicense(memory.source, 'MIT')).toBe(memory.license);
  expect(reviewedPluginLicense({ ...memory.source, version: '2099.1.0' }, 'New upstream terms')).toBe('New upstream terms');
  expect(reviewedPluginLicense({ ...memory.source, kind: 'python' }, 'Python terms')).toBe('Python terms');

  const fetch = pluginCatalog.find((recipe) => recipe.id === 'fetch')!;
  expect(reviewedPluginLicense({ ...fetch.source, version: '2099.1.0' }, 'See installed dist-info licenses')).toBe(
    'See installed dist-info licenses'
  );
});

it('keeps bundled plugin ids unique and exposes only declared metadata', () => {
  const ids = pluginCatalog.map((plugin) => plugin.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(['blender', 'memory', 'playwright', 'fetch', 'heygen', 'recraft', 'unity']);
  expect(pluginCatalog.find((plugin) => plugin.id === 'playwright')).toMatchObject({
    id: 'playwright',
    name: 'Playwright Browser',
    source: expect.objectContaining({ kind: 'npm' })
  });
});

it('keeps catalog recipes pinned, bounded and free of embedded credentials', () => {
  for (const recipe of pluginCatalog) {
    expect(recipe.description.length).toBeGreaterThan(0);
    expect(recipe.description.length).toBeLessThanOrEqual(200);
    expect(recipe.instructions.length).toBeGreaterThan(0);
    expect(recipe.instructions.length).toBeLessThanOrEqual(4);
    expect(recipe.tools?.length).toBeGreaterThan(0);
    expect(new Set(recipe.tools).size).toBe(recipe.tools?.length);

    if (recipe.source.kind === 'remote') {
      expect(recipe.source.auth).toBe('oauth');
      expect(recipe.source.url).toMatch(/^https:\/\//);
      expect(recipe.source.version).toBeUndefined();
    } else {
      expect(recipe.source.version).toMatch(/^\d+(\.\d+)+([a-z0-9.+_-]*)$/i);
    }

    for (const field of recipe.fields) expect(field.secret).toBe(true);
    expect(recipe.source.args?.join(' ') ?? '').not.toMatch(/api.?key|token|secret/i);
  }
});
