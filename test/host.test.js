import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config, REFRESH_PATH, inject, localizeUserError, preferZh } from '../index.js';

const catalog = { google: { models: { 'gemini-9-pro': { limit: { context: 2000000, output: 64000 }, modalities: { input: ['text', 'image'] }, reasoning: false } } } };

function gateway(models, status = 200) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url !== '/v1/models') { res.writeHead(404); return res.end(); }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function harness(providers, cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dms-'));
  const cachePath = join(dir, 'c.json');
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), data: catalog }));
  const state = { providers: structuredClone(providers) };
  const writes = [];
  const effects = [];
  let route;
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: structuredClone(state) }],
    async mutate(ns, ops) { writes.push({ ns, ops }); for (const op of ops) state.providers[op.path[1]].models = op.value; },
  };
  const webServer = { register(r) { route = r; return () => { route = undefined; }; } };
  const ctx = {
    settings,
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    effect(fn) { effects.push(fn()); },
    inject(_deps, cb) { cb({ webServer, effect: ctx.effect }); },
  };
  apply(ctx, Config({ cachePath, backupDir: join(dir, 'bk'), autoSync: false, ...cfg }));
  const call = (body, headers = {}) => new Promise((resolve) => {
    const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { 'content-type': 'application/json', host: '127.0.0.1:3080', ...headers },
      on(ev, fn) { if (ev === 'data' && body) fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') queueMicrotask(fn); } };
    const res = { setHeader() {}, writeHead(s) { this.status = s; }, end(t) { resolve({ status: this.status, body: JSON.parse(t) }); } };
    route.handler(req, res);
  });
  return { state, writes, call, dispose: () => effects.forEach((d) => d?.()), get route() { return route; } };
}

test('manifest exports', () => {
  assert.deepEqual(inject, ['settings']);
  assert.equal(Config({}).settingsNamespace, 'llm-pi-ai');
});

test('end-to-end: pulls full /models, enriches via models.dev, skips non-chat only', async () => {
  const srv = await gateway(['gemini-9-pro', 'mystery-model', 'text-embedding-3']);
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const h = harness({ relay: { baseURL: base, api: 'openai-completions', models: [{ id: 'keep-me', name: 'Keep' }] } });
  assert.equal(h.route.path, REFRESH_PATH);
  const r = await h.call({});
  assert.equal(r.status, 200);
  const res = r.body.results[0];
  // gateway listed 3; embedding skipped; mystery-model kept even without models.dev
  assert.equal(res.fetched, 3);
  assert.equal(res.added, 2); assert.equal(res.skipped, 1); assert.equal(res.wrote, true);
  const ids = h.state.providers.relay.models.map((m) => m.id);
  assert.deepEqual(ids.sort(), ['gemini-9-pro', 'keep-me', 'mystery-model']);
  const g = h.state.providers.relay.models.find((m) => m.id === 'gemini-9-pro');
  assert.equal(g.contextWindow, 2000000); assert.deepEqual(g.input, ['text', 'image']); assert.equal(g.reasoningEfforts, false);
  const mystery = h.state.providers.relay.models.find((m) => m.id === 'mystery-model');
  assert.equal(mystery.contextWindow, 128000); // default when models.dev has no match
  // second run: nothing changes, nothing written
  const r2 = await h.call({});
  assert.equal(r2.body.results[0].wrote, false);
  assert.equal(h.writes.length, 1);
  h.dispose(); assert.equal(h.route, undefined);
  srv.close();
});

test('dryRun and addNewModels=false never add rows', async () => {
  const srv = await gateway(['gemini-9-pro']);
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const h = harness({ relay: { baseURL: base, models: [{ id: 'x' }] } }, { addNewModels: false });
  const r = await h.call({ dryRun: true });
  assert.equal(r.body.results[0].added, 0);
  assert.equal(h.writes.length, 0);
  srv.close();
});

test('gateway failure is reported, catalog untouched', async () => {
  const srv = await gateway([], 401);
  const h = harness({ relay: { baseURL: `http://127.0.0.1:${srv.address().port}/v1`, models: [{ id: 'x' }] } });
  const r = await h.call({});
  assert.match(r.body.results[0].error, /401/);
  assert.equal(h.writes.length, 0);
  srv.close();
});

test('request guards: method, content-type, origin, unknown provider', async () => {
  const h = harness({});
  assert.equal((await h.call({}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await h.call({}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await h.call({}, { origin: 'http://127.0.0.1:3080' })).status, 200);
  const r = await h.call({ route: 'nope' });
  assert.equal(r.body.results[0].error, 'unknown provider');
  assert.equal(r.body.stack, undefined);
});

test('list action, single-provider and multi-route refresh, backup before write', async () => {
  const srv = await gateway(['gemini-9-pro']);
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const h = harness({
    a: { baseURL: base, models: [{ id: 'old', name: 'Mine', compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} } }] },
    b: { baseURL: base, models: [{ id: 'x' }] },
    deepseek: { baseURL: 'https://api.deepseek.com', models: [{ id: 'deepseek-chat' }] },
  });
  const l = await h.call({ action: 'list' });
  assert.deepEqual(l.body.providers.map((p) => p.id), ['a', 'b']);
  const one = await h.call({ route: 'a' });
  assert.deepEqual(one.body.results.map((r) => r.provider), ['a']);
  assert.equal(h.writes.length, 1);
  const { readFileSync } = await import('node:fs');
  const bk = JSON.parse(readFileSync(one.body.results[0].backup, 'utf8'));
  assert.deepEqual(bk.value, [{ id: 'old', name: 'Mine' }]);
  const old = h.state.providers.a.models.find((m) => m.id === 'old');
  assert.equal(old.compat, undefined); assert.equal(old.name, 'Mine');
  const many = await h.call({ routes: ['b'] });
  assert.deepEqual(many.body.results.map((r) => r.provider), ['b']);
  srv.close();
});

test('anthropic-messages listing uses x-api-key and /v1/models', async () => {
  const seen = [];
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers['authorization'], xKey: req.headers['x-api-key'], ver: req.headers['anthropic-version'] });
      if (!req.url.startsWith('/v1/models')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Sonnet' }] }));
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const h = harness({ anth: { baseURL: base, api: 'anthropic-messages', apiKey: 'sk-test', models: [] } });
  const r = await h.call({ route: 'anth' });
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].added, 1);
  assert.equal(r.body.results[0].fetched, 1);
  assert.ok(seen.some((s) => s.url.startsWith('/v1/models') && s.xKey === 'sk-test' && s.ver === '2023-06-01' && !s.auth));
  const row = h.state.providers.anth.models[0];
  assert.equal(row.id, 'claude-sonnet-4-5');
  srv.close();
});

test('openai-compat parses enriched models{} map', async () => {
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: { 'gpt-4o': { name: 'GPT-4o', context_window: 128000 }, 'flux-pro': { name: 'Flux' } } }));
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const h = harness({ relay: { baseURL: base, api: 'openai-completions', models: [] } });
  const r = await h.call({ route: 'relay' });
  assert.equal(r.body.results[0].fetched, 2);
  assert.equal(r.body.results[0].added, 1); // flux-pro filtered as non-chat
  assert.deepEqual(h.state.providers.relay.models.map((m) => m.id), ['gpt-4o']);
  srv.close();
});

test('localizeUserError and preferZh honor Chinese Accept-Language', () => {
  assert.equal(preferZh({ headers: { 'accept-language': 'zh-CN,zh;q=0.9' } }), true);
  assert.equal(preferZh({ headers: { 'accept-language': 'en-US,en;q=0.8' } }), false);
  assert.equal(localizeUserError('unknown provider', true), '未知供应商');
  assert.equal(localizeUserError('unknown provider', false), 'unknown provider');
});

test('refresh API returns Chinese errors when Accept-Language is zh', async () => {
  const h = harness({});
  const r = await h.call({ route: 'nope' }, { 'accept-language': 'zh-CN,zh;q=0.9' });
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].error, '未知供应商');
  const en = await h.call({ route: 'nope' }, { 'accept-language': 'en' });
  assert.equal(en.body.results[0].error, 'unknown provider');
  h.dispose();
});
