import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLookupCandidates,
  pickDevRepresentative,
  buildNormalizedModel,
  isCustomProvider,
  isNonChatModel,
  getCandidateModelUrls,
  mergeModelEntry,
  thinkingLevelMapFromDev,
  healLegacyRow,
  validateModelRow,
  validateModelList,
  stableStringify,
  readSettingsNamespace,
} from '../lib/core.js';

test('candidate generation: bracket tags and routing suffixes', () => {
  const cands = generateLookupCandidates('cx/gpt-6-astra[1m]-review');
  assert.ok(cands.includes('gpt-6-astra-review'));
  assert.ok(cands.includes('gpt-6-astra'));
});

test('candidate generation: dot and hyphen normalization', () => {
  const cands = generateLookupCandidates('claude-3.7-sonnet');
  assert.ok(cands.includes('claude-3-7-sonnet'));
});

test('candidate generation: variant suffixes stripped', () => {
  const cands = generateLookupCandidates('gemini-3.1-pro-high');
  assert.ok(cands.includes('gemini-3.1-pro'));
});

test('dev representative arbitration: first-party preferred', () => {
  const candidates = [
    { providerId: 'openrouter', model: { canonical_model_id: 'openai/o3-mini', limit: { context: 200000 } } },
    { providerId: 'openai', model: { canonical_model_id: 'openai/o3-mini', limit: { context: 200000 } } },
  ];
  const chosen = pickDevRepresentative(candidates);
  assert.equal(chosen?.canonical_model_id, 'openai/o3-mini');
});

test('contextWindow restoration: avoids gateway pricing cutoff truncation', () => {
  const devEntry = {
    canonical_model_id: 'openai/gpt-6-astra',
    reasoning: true,
    limit: { context: 1050000, output: 128000 },
  };
  const rawModel = {
    id: 'cx/gpt-6-astra',
    capabilities: {
      contextWindow: 272000, // Gateway squashed to cutoff
      maxOutput: 128000,
      reasoning: true,
      vision: true,
    },
  };

  const model = buildNormalizedModel('cx/gpt-6-astra', rawModel, devEntry, undefined);
  assert.equal(model.contextWindow, 1050000);
  assert.equal(model.maxTokens, 128000);
  // reasoning model, but models.dev lists no effort levels: none are invented
  assert.equal(model.reasoningEfforts, undefined);
  assert.deepEqual(model.input, ['text', 'image']);
});

test('thinking levels are never invented from the id', () => {
  // gateway says reasoning but models.dev has no effort data: no wire values are written
  const row = buildNormalizedModel('gpt-5.6-luna', { capabilities: { reasoning: true, vision: true } }, undefined, undefined);
  assert.equal(row.reasoningEfforts, undefined);
  assert.deepEqual(validateModelRow(row), []);
  // gateway says non-reasoning: honoured, not overridden by an id pattern
  const off = buildNormalizedModel('gpt-5.6-luna', { capabilities: { reasoning: false } }, undefined, undefined);
  assert.equal(off.reasoningEfforts, false);
});

test('capabilities are never guessed from the id', () => {
  for (const id of ['gpt-6-codex', 'relay/eco-gpt-6', 'relay/openai/gpt-5-2025-08-07', 'claude-4-x', 'gemini-9']) {
    const row = buildNormalizedModel(id, {}, undefined, undefined);
    assert.deepEqual(row.input, ['text'], id);
    assert.equal(row.reasoningEfforts, false, id); // no reasoning signal => DSH non-reasoning form
    assert.equal(row.contextWindow, 128000, id);
    assert.equal(row.maxTokens, 16384, id);
  }
});

test('non-chat filter covers image / video generation ids', () => {
  for (const id of ['relay/kling/kling-video-o1', 'relay/kling/kling-v3', 'relay/gemini-3-pro-image', 'gemini-3.1-flash-image', 'text-embedding-3-small']) {
    assert.equal(isNonChatModel(id), true, id);
  }
  assert.equal(isNonChatModel('gpt-5.6-luna'), false);
  assert.equal(isNonChatModel('claude-sonnet-5-5'), false);
});

test('reasoning UI consistency: non-reasoning model strips thinkingLevelMap', () => {
  const rawModel = {
    id: 'gpt-4o-mini',
    capabilities: {
      reasoning: false,
      vision: true,
      contextWindow: 128000,
      maxOutput: 16384,
    },
  };

  const model = buildNormalizedModel('gpt-4o-mini', rawModel, undefined, undefined);
  assert.equal(model.reasoningEfforts, false);
  assert.equal(model.thinkingLevelMap, undefined);
});

test('custom provider guard: safely skips built-in and official endpoints', () => {
  // Official DeepSeek without baseUrl (default built-in)
  assert.equal(isCustomProvider('deepseek', { apiKey: 'mock' }), false);

  // Official DeepSeek pointing to official endpoint
  assert.equal(
    isCustomProvider('deepseek', { baseUrl: 'https://api.deepseek.com', apiKey: 'mock' }),
    false,
  );

  // Official OpenAI pointing to official endpoint
  assert.equal(
    isCustomProvider('openai', { baseUrl: 'https://api.openai.com/v1', apiKey: 'mock' }),
    false,
  );

  // Built-in ID redirected to custom relay
  assert.equal(
    isCustomProvider('deepseek', { baseUrl: 'https://relay.custom.io/v1', apiKey: 'mock' }),
    true,
  );

  // Generic custom provider
  assert.equal(
    isCustomProvider('custom-relay', { baseUrl: 'https://relay.custom.io/v1', apiKey: 'mock' }),
    true,
  );

  // Explicit sync controls
  assert.equal(
    isCustomProvider('deepseek', { baseUrl: 'https://api.deepseek.com', sync: true }),
    true,
  );
  assert.equal(
    isCustomProvider('custom-relay', { baseUrl: 'https://relay.custom.io/v1', sync: false }),
    false,
  );
});

test('candidate URL builder: correctly tests /v1/models and falls back', () => {
  const withoutV1 = getCandidateModelUrls('https://relay.example.com');
  assert.deepEqual(withoutV1, [
    'https://relay.example.com/v1/models',
    'https://relay.example.com/models',
  ]);

  const withV1 = getCandidateModelUrls('https://relay.example.com/v1');
  assert.deepEqual(withV1, ['https://relay.example.com/v1/models']);
});

test('mergeModelEntry: preserves user custom fields and drops modalities DSH rejects', () => {
  const existing = {
    id: 'custom-model',
    contextWindow: 100000,
    input: ['text', 'video'],
    customParam: true,
  };
  const generated = {
    id: 'custom-model',
    contextWindow: 1050000,
    input: ['text', 'image'],
  };
  const merged = mergeModelEntry(existing, generated);
  assert.equal(merged.contextWindow, 1050000);
  // DSH only accepts text/image modalities; "video" would make the whole route unserviceable.
  assert.equal(merged.input.includes('video'), false);
  assert.ok(merged.input.includes('image'));
  assert.equal(merged.customParam, true);
});

test('DSH profile shape: no legacy or invalid fields are emitted', () => {
  const model = buildNormalizedModel('gpt-5.6-luna', { capabilities: { reasoning: true } }, undefined, undefined);
  for (const key of ['reasoning', 'thinkingLevelMap', 'thinkingFormat', 'compat']) {
    assert.equal(key in model, false, `${key} must not be emitted`);
  }
  assert.deepEqual(validateModelRow(model), []);
});

test('thinkingLevelMapFromDev: drops values that are not DSH levels', () => {
  const map = thinkingLevelMapFromDev({
    reasoning_options: [{ type: 'effort', values: ['none', 'default', 'low', 'bogus', 'high', ''] }],
  });
  assert.deepEqual(map, { off: null, low: 'low', high: 'high' });
});

test('reasoningEfforts never contains only "off" (DSH would reject the route)', () => {
  const dev = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none'] }] };
  const model = buildNormalizedModel('ling-3.0-flash', { capabilities: { reasoning: true } }, dev, undefined);
  assert.deepEqual(validateModelRow(model), []);
  assert.notDeepEqual(model.reasoningEfforts, { off: null });
});

test('toggle/budget-only reasoning models do not get invented levels', () => {
  const dev = { reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }] };
  const model = buildNormalizedModel('some-thinking-model', {}, dev, undefined);
  assert.equal(model.reasoningEfforts, undefined);
  assert.deepEqual(validateModelRow(model), []);
});

test('validateModelRow: mirrors DSH resolution rules', () => {
  assert.deepEqual(validateModelRow({ id: 'a', contextWindow: 10, maxTokens: 5, reasoningEfforts: { low: 'low' } }), []);
  assert.ok(validateModelRow({ id: 'a', reasoningEfforts: { off: null } }).some((e) => /no level beyond/.test(e)));
  assert.ok(validateModelRow({ id: 'a', reasoningEfforts: { high: null } }).some((e) => /needs a wire value/.test(e)));
  assert.ok(validateModelRow({ id: 'a', reasoningEfforts: { high: '' } }).length > 0);
  assert.ok(validateModelRow({ id: 'a', reasoningEfforts: { turbo: 'x' } }).some((e) => /unknown level/.test(e)));
  assert.ok(validateModelRow({ id: 'a', contextWindow: 0 }).length > 0);
  assert.ok(validateModelRow({ id: 'a', contextWindow: 1.5 }).length > 0);
  assert.ok(validateModelRow({ id: 'a', input: ['text', 'video'] }).length > 0);
  assert.ok(validateModelRow({ id: 'a', compat: { thinkingFormat: 'effort' } }).some((e) => /not a supported format/.test(e)));
  assert.deepEqual(validateModelRow({ id: 'a', compat: { thinkingFormat: 'deepseek' } }), []);
  assert.ok(validateModelList([{ id: 'a' }, { id: 'a' }]).some((e) => /more than once/.test(e)));
  assert.ok(validateModelList([]).length > 0);
});

test('healLegacyRow: strips 1.0.x fields and invalid compat', () => {
  const healed = healLegacyRow({
    id: 'x', reasoning: true, thinkingLevelMap: { low: 'low' }, thinkingFormat: 'effort',
    compat: { thinkingFormat: 'effort', supportsReasoningEffort: true },
    reasoningEfforts: { low: 'low' },
  });
  assert.deepEqual(healed, { id: 'x', reasoningEfforts: { low: 'low' } });
  const custom = healLegacyRow({ id: 'y', compat: { thinkingFormat: 'effort', maxTokensField: 'max_tokens' } });
  assert.deepEqual(custom.compat, { maxTokensField: 'max_tokens' });
});

test('mergeModelEntry: heals legacy rows, keeps user wire values, keeps only text/image', () => {
  const existing = {
    id: 'm', reasoning: true, thinkingFormat: 'effort',
    compat: { thinkingFormat: 'effort', supportsReasoningEffort: true },
    input: ['text', 'video'],
    reasoningEfforts: { off: null, high: 'ultra' },
    customParam: 1,
  };
  const generated = { id: 'm', contextWindow: 1000, maxTokens: 100, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high' } };
  const merged = mergeModelEntry(existing, generated);
  assert.equal(merged.reasoning, undefined);
  assert.equal(merged.compat, undefined);
  assert.equal(merged.customParam, 1);
  assert.deepEqual(merged.input, ['text', 'image']);
  assert.equal(merged.reasoningEfforts.high, 'ultra');
  assert.equal(merged.reasoningEfforts.low, 'low');
  assert.deepEqual(validateModelRow(merged), []);
});

test('no-op detection: stableStringify ignores key order and undefined', () => {
  assert.equal(
    stableStringify({ a: 1, b: { y: 2, x: 1 }, c: undefined }),
    stableStringify({ b: { x: 1, y: 2 }, a: 1 }),
  );
  const row = buildNormalizedModel('gpt-5.6-luna', { capabilities: { reasoning: true } }, undefined, undefined);
  const again = mergeModelEntry(row, buildNormalizedModel('gpt-5.6-luna', { capabilities: { reasoning: true } }, undefined, undefined));
  assert.equal(stableStringify(row), stableStringify(again));
});

test('generateLookupCandidates strips trailing date snapshots', () => {
  const c = generateLookupCandidates('Relay-Plan/doubao-1-5-thinking-pro-250415');
  assert.ok(c.includes('doubao-1-5-thinking-pro'));
  assert.ok(c.includes('doubao-1.5-thinking-pro'));
  assert.ok(generateLookupCandidates('gpt-5.4-2026-03-05').includes('gpt-5.4'));
  assert.equal(generateLookupCandidates('qwen3-235b').includes('qwen3'), false);
});

test('readSettingsNamespace supports both get() and DSH SettingsForms.describe()', () => {
  // Direct get() support
  const legacySettings = {
    get(ns) {
      return ns === 'llm-pi-ai' ? { providers: { p1: {} } } : undefined;
    },
  };
  assert.deepEqual(readSettingsNamespace(legacySettings, 'llm-pi-ai'), { providers: { p1: {} } });

  // DSH SettingsForms.describe() support (no get method)
  const dshSettings = {
    describe() {
      return [
        { ns: 'ui-settings', value: { enabled: true } },
        { ns: 'llm-pi-ai', value: { providers: { a9: {}, avt: {} } } },
      ];
    },
    mutate() {},
  };
  assert.deepEqual(readSettingsNamespace(dshSettings, 'llm-pi-ai'), { providers: { a9: {}, avt: {} } });
  assert.equal(readSettingsNamespace(dshSettings, 'non-existent'), undefined);
  assert.equal(readSettingsNamespace(null, 'llm-pi-ai'), undefined);
});

