/**
 * index.js — DeepSeek Harness (DSH) Host Plugin for dsh-model-sync.
 *
 * Discovers models from online gateways, matches them against models.dev,
 * and handles UI-triggered one-click refreshes via loopback HTTP.
 */

import {
  buildNormalizedModel,
  lookupModelsDev,
  isCustomProvider,
  getListingCandidates,
  listingAuthHeaders,
  parseListingBody,
  LISTABLE_APIS,
  mergeModelEntry,
  isNonChatModel,
  validateModelRow,
  validateModelList,
  stableStringify,
  readSettingsNamespace,
  pruneMaterialized,
  isValidModelId,
} from './lib/core.js';
import { ModelsDevService } from './lib/models-dev.js';
import Schema from '@deepseek-ai/schemastery';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-model-sync';
// settings is the only hard dependency; webServer (UI route) and credentials
// are picked up when present via ctx.inject / ctx.get.
export const inject = ['settings'];

export const REFRESH_PATH = '/api/dsh-model-sync/refresh';
const VERSION = '1.5.1';

export const Config = Schema.object({
  settingsNamespace: Schema.string().default('llm-pi-ai')
    .description('Settings namespace (Loader row id) that owns the LLM providers.'),
  modelsDevUrl: Schema.string().default('https://models.dev/api.json').description('models.dev catalog URL.'),
  cachePath: Schema.string().description('models.dev cache file (default: OS temp dir, per user).'),
  refreshHours: Schema.number().min(0.5).default(24).description('models.dev cache TTL and background sync period, in hours.'),
  autoSync: Schema.boolean().default(true).description('Run a background sync every refreshHours.'),
  addNewModels: Schema.boolean().default(true)
    .description('Add gateway models that are new to the catalog. When false only existing rows are refreshed.'),
  providers: Schema.array(Schema.string()).default([])
    .description('Only sync these provider ids (empty = every custom/relay provider).'),
  backupDir: Schema.string().description('Where to save a provider models snapshot before each write (default: OS temp dir/dsh-model-sync-backups).'),
  timeoutMs: Schema.natural().min(1000).default(25000).description('Per-provider gateway request timeout.'),
}).i18n({
  'zh-CN': {
    $description: '从自定义/中转网关拉取模型列表，按 models.dev 补全能力，并在模型设置页提供一键刷新。',
    settingsNamespace: '拥有 LLM 供应商的设置命名空间（Loader 行 id）。',
    modelsDevUrl: 'models.dev 目录地址。',
    cachePath: 'models.dev 缓存文件路径（默认：系统临时目录，按用户区分）。',
    refreshHours: 'models.dev 缓存有效期与后台同步周期（小时）。',
    autoSync: '按 refreshHours 周期在后台自动同步。',
    addNewModels: '是否把网关上尚未录入的模型写入目录；关闭时只刷新已有条目。',
    providers: '仅同步这些供应商 id（留空表示所有自定义/中转供应商）。',
    backupDir: '每次写入前备份该供应商 models 的目录（默认：系统临时目录/dsh-model-sync-backups）。',
    timeoutMs: '每个供应商网关请求的超时时间（毫秒）。',
  },
  zh: {
    $description: '从自定义/中转网关拉取模型列表，按 models.dev 补全能力，并在模型设置页提供一键刷新。',
    settingsNamespace: '拥有 LLM 供应商的设置命名空间（Loader 行 id）。',
    modelsDevUrl: 'models.dev 目录地址。',
    cachePath: 'models.dev 缓存文件路径（默认：系统临时目录，按用户区分）。',
    refreshHours: 'models.dev 缓存有效期与后台同步周期（小时）。',
    autoSync: '按 refreshHours 周期在后台自动同步。',
    addNewModels: '是否把网关上尚未录入的模型写入目录；关闭时只刷新已有条目。',
    providers: '仅同步这些供应商 id（留空表示所有自定义/中转供应商）。',
    backupDir: '每次写入前备份该供应商 models 的目录（默认：系统临时目录/dsh-model-sync-backups）。',
    timeoutMs: '每个供应商网关请求的超时时间（毫秒）。',
  },
});


/** True when the UI asked for Chinese (Accept-Language). */
function preferZh(req) {
  const raw = String(req?.headers?.['accept-language'] || '');
  if (!raw) return false;
  const parts = raw.split(',').map((p) => {
    const [tag, ...params] = p.trim().split(';');
    let q = 1;
    for (const param of params) {
      const m = param.trim().match(/^q=([0-9.]+)$/i);
      if (m) q = Number(m[1]) || 0;
    }
    return { tag: tag.toLowerCase(), q };
  }).sort((a, b) => b.q - a.q);
  for (const { tag } of parts) {
    if (tag === '*' ) continue;
    if (tag.startsWith('zh')) return true;
    if (tag.startsWith('en')) return false;
  }
  return false;
}

/** Localize user-facing API / sync errors for toast display. Logs stay English. */
function localizeUserError(message, zh) {
  const raw = String(message || '');
  if (!zh || !raw) return raw;
  const rules = [
    [/^unknown provider$/i, '未知供应商'],
    [/^provider has no baseURL$/i, '供应商未配置 baseURL'],
    [/^Access denied: loopback only$/i, '拒绝访问：仅本机回环'],
    [/^Method not allowed$/i, '不允许的方法'],
    [/^Content-Type must be application\/json$/i, 'Content-Type 必须为 application/json'],
    [/^Cross-origin request rejected$/i, '已拒绝跨域请求'],
    [/^DSH settings service is not yet available$/i, 'DSH settings 服务尚未就绪'],
    [/^Request payload too large$/i, '请求体过大'],
    [/^Malformed JSON body: (.+)$/i, 'JSON 请求体无效：$1'],
    [/^gateway timed out after (\d+) ms$/i, '网关超时（$1 ms）'],
    [/^settings rejected the update: (.+)$/i, '设置拒绝写入：$1'],
    [/^protocol "([^"]+)" has no model listing this plugin can read \(supported: (.+)\)$/i, '协议 "$1" 不支持拉取模型列表（支持：$2）'],
    [/^Refusing to write ([^:]+): (.+)$/i, '拒绝写入 $1：$2'],
    [/^Upstream (.+) returned (\d+)(.*)$/i, '上游 $1 返回 $2$3'],
    [/^Upstream (.+) did not return JSON$/i, '上游 $1 未返回 JSON'],
    [/^Endpoint (.+) returned (\d+)$/i, '端点 $1 返回 $2'],
    [/^Expected a model listing from (.+) \(data\[\] or models\{\}\), got (.+)$/i, '期望 $1 返回模型列表（data[] 或 models{}），实际为 $2'],
    [/^Failed to fetch models from candidate endpoints: (.+)$/i, '无法从候选端点拉取模型：$1'],
  ];
  for (const [re, tpl] of rules) {
    const m = raw.match(re);
    if (m) {
      let out = tpl;
      for (let i = 1; i < m.length; i += 1) out = out.replace(`$${i}`, m[i] ?? '');
      return out;
    }
  }
  return raw;
}

function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error('Request payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error(`Malformed JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Pull the full model catalog from a gateway, protocol-aware (DSH discovery shape).
 * `api` is the provider's `api` field: openai-completions | openai-responses | anthropic-messages.
 */
async function fetchRemoteModels(baseUrl, apiKey, api, signal) {
  const protocol = LISTABLE_APIS.has(api) ? api : (api ? api : 'openai-completions');
  if (api && !LISTABLE_APIS.has(api)) {
    throw new Error(`protocol "${api}" has no model listing this plugin can read (supported: ${[...LISTABLE_APIS].join(', ')})`);
  }
  const candidates = getListingCandidates(baseUrl, protocol || 'openai-completions');
  const headers = {
    'User-Agent': `dsh-model-sync/${VERSION}`,
    ...listingAuthHeaders(protocol || 'openai-completions', apiKey),
  };

  let lastError = null;

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers, signal });
      if (res.status === 404 || res.status === 405) {
        lastError = new Error(`Endpoint ${url} returned ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`Upstream ${url} returned ${res.status} ${res.statusText}`);
        err.fatal = res.status === 401 || res.status === 403;
        throw err;
      }
      let json;
      try {
        json = await res.json();
      } catch {
        throw new Error(`Upstream ${url} did not return JSON`);
      }
      const list = parseListingBody(json);
      if (list.length === 0 && json && typeof json === 'object' && !Array.isArray(json) && !Array.isArray(json.data) && !(json.models && typeof json.models === 'object')) {
        throw new Error(`Expected a model listing from ${url} (data[] or models{}), got ${typeof json}`);
      }
      return list;
    } catch (err) {
      lastError = err;
      if (signal?.aborted || err.fatal) throw err;
    }
  }

  throw lastError || new Error(`Failed to fetch models from candidate endpoints: ${candidates.join(', ')}`);
}

export function apply(ctx, config = {}) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-model-sync') : ctx.logger;
  const NS_SETTINGS = config.settingsNamespace || 'llm-pi-ai';
  const timeoutMs = config.timeoutMs ?? 25_000;
  const addNewModels = config.addNewModels !== false;
  let running = null;
  const modelsDev = new ModelsDevService({
    url: config.modelsDevUrl,
    cachePath: config.cachePath,
    ttlMs: (config.refreshHours ?? 24) * 60 * 60 * 1000,
    logger,
  });

  /**
   * Resolve the provider API key the way DSH does: `apiKeyEnv` is a credential
   * reference resolved through the credentials service (fallback: process env).
   * A literal `apiKey` field is still honoured for hand-written configs.
   */
  async function resolveApiKey(providerConfig) {
    const ref = providerConfig.apiKeyEnv;
    if (typeof ref === 'string' && ref) {
      const credentials = ctx.get('credentials', false);
      if (credentials?.resolve) {
        const hit = await credentials.resolve(ref);
        if (hit?.value) return hit.value;
      }
      if (process.env[ref]) return process.env[ref];
    }
    return providerConfig.apiKey || undefined;
  }

  async function syncProviderModels(providerId, providerConfig, catalog, signal) {
    const baseUrl = providerConfig.baseURL || providerConfig.baseUrl;
    if (!baseUrl) throw new Error('provider has no baseURL');
    const apiKey = await resolveApiKey(providerConfig);
    // Rows come back from settings.get schema-materialized; strip that before
    // comparing or writing so only user-authored fields reach cordis.patch.yml.
    const existingModels = (Array.isArray(providerConfig.models) ? providerConfig.models : [])
      .map((m) => pruneMaterialized(m));

    // Pull the gateway's FULL /models list (not the already-configured subset).
    // Protocol comes from the DSH provider `api` field.
    const fetchedList = await fetchRemoteModels(baseUrl, apiKey, providerConfig.api, signal);

    const existingMap = new Map(existingModels.map((m) => [m.id, m]));
    const nextModels = [];
    const skipped = [];
    const seen = new Set();
    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const raw of fetchedList) {
      const id = typeof raw === 'string' ? raw : raw?.id;
      if (!id || typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);

      // Skip non-concrete or wildcard model patterns (e.g. claude-*, gpt-*)
      if (!isValidModelId(id)) {
        skipped.push({ id, reason: 'contains wildcard or non-concrete pattern' });
        continue;
      }

      const existing = existingMap.get(id);
      // Embedding/TTS/image/moderation ids are not chat models; DSH only dispatches chat.
      if (!existing && isNonChatModel(id)) {
        skipped.push({ id, reason: 'not a chat model' });
        continue;
      }

      // models.dev enriches capabilities; it does NOT gate which chat models are kept.
      // Author intent: every chat model the gateway advertises is written, with
      // defaults when models.dev has no match.
      if (!existing && !addNewModels) {
        skipped.push({ id, reason: 'new model (addNewModels is off)' });
        continue;
      }

      const devEntry = lookupModelsDev(catalog, id);
      const normalized = mergeModelEntry(
        existing,
        buildNormalizedModel(id, typeof raw === 'string' ? {} : raw, devEntry, undefined),
      );

      const problems = validateModelRow(normalized);
      if (problems.length > 0) {
        skipped.push({ id, reason: problems.join('; ') });
        continue;
      }

      if (!existing) added += 1;
      else if (stableStringify(existing) !== stableStringify(normalized)) updated += 1;
      else unchanged += 1;
      nextModels.push(normalized);
    }

    // Crucial: preserve existing configured models that weren't returned by the gateway
    for (const existing of existingModels) {
      if (existing?.id && !seen.has(existing.id)) {
        nextModels.push(existing);
        unchanged += 1;
      }
    }

    const removed = 0;
    const listErrors = validateModelList(nextModels);
    if (listErrors.length > 0) {
      throw new Error(`Refusing to write ${providerId}: ${listErrors.slice(0, 3).join('; ')}`);
    }
    const changed = added + updated > 0;

    return { provider: providerId, models: nextModels, fetched: fetchedList.length, added, updated, removed, unchanged, skipped, changed };
  }

  // Serialize syncs: a UI click during a background run joins that run.
  function executeSync(targetRoutes, options) {
    if (running) return running;
    running = doSync(targetRoutes, options).finally(() => { running = null; });
    return running;
  }

  async function doSync(targetRoutes, { dryRun = false } = {}) {
    const settings = ctx.settings ?? ctx.get?.('settings', false);
    if (!settings) {
      throw new Error('DSH settings service is not yet available');
    }

    const catalog = await modelsDev.getCatalog();
    const section = readSettingsNamespace(settings, NS_SETTINGS);
    const providers = section?.providers;
    if (!providers || typeof providers !== 'object') {
      return [];
    }

    const allow = Array.isArray(config.providers) && config.providers.length > 0 ? new Set(config.providers) : null;
    const requested = targetRoutes && targetRoutes.length > 0 ? targetRoutes : Object.keys(providers);
    const results = [];
    for (const r of requested) {
      if (!providers[r]) results.push({ provider: r, error: 'unknown provider' });
    }
    const routes = requested.filter((r) => providers[r] && isCustomProvider(r, providers[r]) && (!allow || allow.has(r)));
    const ops = [];
    const opRoutes = [];

    if (routes.length > 0) {
      for (const route of routes) {
        const pConfig = providers[route];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await syncProviderModels(route, pConfig, catalog, controller.signal);
          if (res.changed && !dryRun) {
            ops.push({ op: 'set', path: ['providers', route, 'models'], value: res.models });
            opRoutes.push(route);
          }
          results.push({
            provider: route,
            fetched: res.fetched,
            added: res.added,
            updated: res.updated,
            removed: res.removed,
            unchanged: res.unchanged,
            skipped: res.skipped.length,
            skippedModels: res.skipped.slice(0, 20),
            wrote: false,
            dryRun,
          });
        } catch (err) {
          const message = err?.name === 'AbortError' ? `gateway timed out after ${timeoutMs} ms` : err.message;
          logger?.error?.(`[dsh-model-sync] Error syncing provider ${route}: ${message}`);
          results.push({ provider: route, error: message });
        } finally {
          clearTimeout(timer);
        }
      }

      // One mutate per provider so a rejected route does not block the others.
      for (let i = 0; i < ops.length; i += 1) {
        const result = results.find((r) => r.provider === opRoutes[i]);
        try {
          result.backup = backupModels(opRoutes[i], providers[opRoutes[i]].models);
          await settings.mutate(NS_SETTINGS, [ops[i]]);
          result.wrote = true;
        } catch (err) {
          result.error = `settings rejected the update: ${err.message}`;
          logger?.error?.(`[dsh-model-sync] ${opRoutes[i]}: ${result.error}`);
        }
      }
      const wrote = results.filter((r) => r.wrote).length;
      if (wrote > 0) logger?.info?.(`[dsh-model-sync] Synchronized ${wrote} provider(s)`);
    }

    return results;
  }

  function backupModels(route, models) {
    try {
      const dir = config.backupDir || join(tmpdir(), 'dsh-model-sync-backups');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${route.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`);
      const rows = (Array.isArray(models) ? models : []).map((m) => pruneMaterialized(m));
      writeFileSync(file, JSON.stringify({ ns: NS_SETTINGS, path: ['providers', route, 'models'], value: rows }, null, 2));
      return file;
    } catch (err) {
      logger?.warn?.(`[dsh-model-sync] backup failed for ${route}: ${err.message}`);
      return undefined;
    }
  }

  /** Providers the plugin would sync (for the UI picker). */
  function listProviders() {
    const settings = ctx.settings ?? ctx.get?.('settings', false);
    const providers = readSettingsNamespace(settings, NS_SETTINGS)?.providers || {};
    const allow = Array.isArray(config.providers) && config.providers.length > 0 ? new Set(config.providers) : null;
    return Object.keys(providers)
      .filter((r) => isCustomProvider(r, providers[r]) && (!allow || allow.has(r)))
      .map((r) => ({ id: r, models: Array.isArray(providers[r].models) ? providers[r].models.length : 0 }));
  }

  // Register the UI refresh route; the disposer is an effect so HMR reloads
  // never hit "duplicate route".
  const registerEndpoint = (server) => server.register({
    kind: 'exact',
    path: REFRESH_PATH,
    handler: async (req, res) => {
      const zh = preferZh(req);
      if (!isLoopback(req)) {
        return writeJson(res, 403, { ok: false, error: localizeUserError('Access denied: loopback only', zh) });
      }
      if (req.method !== 'POST') {
        res.setHeader?.('Allow', 'POST');
        return writeJson(res, 405, { ok: false, error: localizeUserError('Method not allowed', zh) });
      }
      // CSRF guard: require JSON (forces a CORS preflight) and a same-host Origin.
      const type = String(req.headers?.['content-type'] || '');
      if (!type.toLowerCase().startsWith('application/json')) {
        return writeJson(res, 415, { ok: false, error: localizeUserError('Content-Type must be application/json', zh) });
      }
      const origin = req.headers?.origin;
      if (origin) {
        let host;
        try { host = new URL(origin).host; } catch { host = undefined; }
        if (host !== req.headers?.host) {
          return writeJson(res, 403, { ok: false, error: localizeUserError('Cross-origin request rejected', zh) });
        }
      }
      try {
        const body = await readJsonBody(req);
        if (body.action === 'list') return writeJson(res, 200, { ok: true, providers: listProviders() });
        let target = typeof body.route === 'string' && body.route ? [body.route] : undefined;
        if (Array.isArray(body.routes)) target = body.routes.filter((r) => typeof r === 'string' && r);
        const results = await executeSync(target, { dryRun: body.dryRun === true });
        const localized = results.map((r) => (
          r.error ? { ...r, error: localizeUserError(r.error, zh) } : r
        ));
        writeJson(res, 200, { ok: true, results: localized });
      } catch (err) {
        logger?.error?.(`[dsh-model-sync] refresh failed: ${err.stack || err.message}`);
        writeJson(res, 500, { ok: false, error: localizeUserError(err.message, zh) });
      }
    },
  });

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => {
      if (!sub.webServer?.register) return;
      sub.effect(() => registerEndpoint(sub.webServer));
      logger?.info?.(`[dsh-model-sync] Registered UI refresh endpoint: ${REFRESH_PATH}`);
    });
  }

  if (config.autoSync !== false) {
    const periodMs = Math.max(0.5, config.refreshHours ?? 24) * 60 * 60 * 1000;
    ctx.effect(() => {
      const interval = setInterval(() => {
        executeSync().catch((err) => logger?.warn?.(`[dsh-model-sync] Background sync failed: ${err.message}`));
      }, periodMs);
      interval.unref?.();
      return () => clearInterval(interval);
    });
  }


}

export { preferZh, localizeUserError, VERSION };
