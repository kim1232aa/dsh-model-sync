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
  getCandidateModelUrls,
  mergeModelEntry,
  isNonChatModel,
  validateModelRow,
  validateModelList,
  stableStringify,
} from './lib/core.js';
import { ModelsDevService } from './lib/models-dev.js';

export const name = 'dsh-model-sync';
export const inject = ['llm'];

const NS_SETTINGS = 'llm-pi-ai';
const REFRESH_PATH = '/api/dsh-model-sync/refresh';
const DEFAULT_TIMEOUT_MS = 25_000;

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

async function fetchRemoteModels(baseUrl, apiKey, signal) {
  const candidates = getCandidateModelUrls(baseUrl);
  const headers = { 'User-Agent': 'dsh-model-sync/1.1.1' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let lastError = null;

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers, signal });
      if (res.status === 404 || res.status === 405) {
        lastError = new Error(`Endpoint ${url} returned ${res.status}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`Upstream ${url} returned ${res.status} ${res.statusText}`);
      }
      const json = await res.json();
      const list = Array.isArray(json) ? json : json?.data;
      if (!Array.isArray(list)) {
        throw new Error(`Expected array of models from ${url}, got ${typeof list}`);
      }
      return list;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
    }
  }

  throw lastError || new Error(`Failed to fetch models from candidate endpoints: ${candidates.join(', ')}`);
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger;
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
    const existingModels = Array.isArray(providerConfig.models) ? providerConfig.models : [];

    // A failed fetch is an error: never rewrite the catalog from stale data.
    const fetchedList = await fetchRemoteModels(baseUrl, apiKey, signal);

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

      const existing = existingMap.get(id);
      // Embedding/TTS/image/moderation ids are not chat models; DSH only dispatches chat.
      if (!existing && isNonChatModel(id)) {
        skipped.push({ id, reason: 'not a chat model' });
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

    const removed = existingModels.filter((m) => m?.id && !seen.has(m.id)).length;
    const listErrors = validateModelList(nextModels);
    if (listErrors.length > 0) {
      throw new Error(`Refusing to write ${providerId}: ${listErrors.slice(0, 3).join('; ')}`);
    }
    const changed = added + updated + removed > 0
      || existingModels.length !== nextModels.length;

    return { provider: providerId, models: nextModels, added, updated, removed, unchanged, skipped, changed };
  }

  async function executeSync(targetRoutes, { dryRun = false } = {}) {
    const settings = ctx.get('settings', false);
    if (!settings) {
      throw new Error('DSH settings service is not yet available');
    }

    const catalog = await modelsDev.getCatalog();
    const section = settings.get(NS_SETTINGS);
    const providers = section?.providers;
    if (!providers || typeof providers !== 'object') {
      return [];
    }

    const routes = targetRoutes && targetRoutes.length > 0
      ? targetRoutes.filter((r) => isCustomProvider(r, providers[r]))
      : Object.keys(providers).filter((r) => isCustomProvider(r, providers[r]));

    const results = [];
    const ops = [];
    const opRoutes = [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      for (const route of routes) {
        const pConfig = providers[route];
        if (!pConfig) continue;

        try {
          const res = await syncProviderModels(route, pConfig, catalog, controller.signal);
          if (res.changed && !dryRun) {
            ops.push({ op: 'set', path: ['providers', route, 'models'], value: res.models });
            opRoutes.push(route);
          }
          results.push({
            provider: route,
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
          logger?.error?.(`[dsh-model-sync] Error syncing provider ${route}: ${err.message}`);
          results.push({ provider: route, error: err.message });
        }
      }

      // One mutate per provider so a rejected route does not block the others.
      for (let i = 0; i < ops.length; i += 1) {
        const result = results.find((r) => r.provider === opRoutes[i]);
        try {
          await settings.mutate(NS_SETTINGS, [ops[i]]);
          result.wrote = true;
        } catch (err) {
          result.error = `settings rejected the update: ${err.message}`;
          logger?.error?.(`[dsh-model-sync] ${opRoutes[i]}: ${result.error}`);
        }
      }
      const wrote = results.filter((r) => r.wrote).length;
      if (wrote > 0) logger?.info?.(`[dsh-model-sync] Synchronized ${wrote} provider(s)`);
    } finally {
      clearTimeout(timer);
    }

    return results;
  }

  // Register HTTP endpoint on webServer
  const registerEndpoint = (server) => {
    if (!server?.register) return;
    server.register({
      kind: 'exact',
      path: REFRESH_PATH,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          return writeJson(res, 403, { ok: false, error: 'Access denied: loopback only' });
        }
        if (req.method !== 'POST') {
          return writeJson(res, 405, { ok: false, error: 'Method not allowed' });
        }

        try {
          const body = await readJsonBody(req);
          const target = typeof body.route === 'string' && body.route ? [body.route] : undefined;
          const results = await executeSync(target, { dryRun: body.dryRun === true });
          writeJson(res, 200, { ok: true, results });
        } catch (err) {
          writeJson(res, 500, {
            ok: false,
            error: err.message,
            stack: err.stack,
          });
        }
      },
    });
    logger?.info?.(`[dsh-model-sync] Registered UI refresh endpoint: ${REFRESH_PATH}`);
  };

  const webServer = ctx.get('webServer', false);
  if (webServer) {
    registerEndpoint(webServer);
  } else {
    ctx.inject(['webServer'], (subCtx) => {
      registerEndpoint(subCtx.webServer);
    });
  }

  // Periodic background sync if enabled
  const autoSyncHours = Math.max(0.5, config.refreshHours ?? 24);
  const interval = setInterval(() => {
    executeSync().catch((err) => logger?.warn?.(`[dsh-model-sync] Background sync failed: ${err.message}`));
  }, autoSyncHours * 60 * 60 * 1000);

  if (interval.unref) interval.unref();

  return () => {
    clearInterval(interval);
  };
}
