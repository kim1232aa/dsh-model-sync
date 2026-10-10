import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLookupCandidates,
  pickDevRepresentative,
  buildNormalizedModel,
  inferReasoningFromId,
  inferVisionFromId,
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
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ['text', 'image']);
});

test('reasoning UI consistency: reasoning true enforced if active thinking map exists', () => {
  const rawModel = {
    id: 'gpt-5.6-luna',
    capabilities: {
      reasoning: false, // Misreported by gateway
      vision: true,
      contextWindow: 1000000,
      maxOutput: 100000,
    },
  };

  const model = buildNormalizedModel('gpt-5.6-luna', rawModel, undefined, undefined);
  assert.equal(model.reasoning, true);
  assert.ok(model.thinkingLevelMap);
  assert.equal(model.thinkingLevelMap.max, 'max');
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
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
});
