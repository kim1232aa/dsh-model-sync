/**
 * index.js — DeepSeek Harness (DSH) Host Plugin for dsh-model-sync.
 *
 * Discovers models from online gateways, matches them against models.dev,
 * and handles UI-triggered one-click refreshes via loopback HTTP.
 */

import { buildNormalizedModel, lookupModelsDev } from './lib/core.js';
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
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers = { 'User-Agent': 'dsh-model-sync/1.0.0' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new Error(`Upstream ${url} returned ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const list = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(list)) {
    throw new Error(`Expected array of models from ${url}, got ${typeof list}`);
  }
  return list;
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const modelsDev = new ModelsDevService({
    url: config.modelsDevUrl,
    cachePath: config.cachePath,
    ttlMs: (config.refreshHours ?? 24) * 60 * 60 * 1000,
    logger,
  });

  async function syncProviderModels(providerId, providerConfig, catalog, signal) {
    const baseUrl = providerConfig.baseUrl || providerConfig.baseURL;
    const apiKey = providerConfig.apiKey;
    const existingModels = Array.isArray(providerConfig.models) ? providerConfig.models : [];

    let fetchedList = [];
    if (baseUrl) {
      try {
        fetchedList = await fetchRemoteModels(baseUrl, apiKey, signal);
      } catch (err) {
        logger?.warn?.(`[dsh-model-sync] Failed to fetch /models for ${providerId}: ${err.message}. Enriching existing models.`);
        fetchedList = existingModels;
      }
    } else {
      fetchedList = existingModels;
    }

    const existingMap = new Map(existingModels.map((m) => [m.id, m]));
    const nextModels = [];
    let added = 0;
    let updated = 0;

    for (const raw of fetchedList) {
      const id = typeof raw === 'string' ? raw : raw?.id;
      if (!id || typeof id !== 'string') continue;

      const devEntry = lookupModelsDev(catalog, id);
      const normalized = buildNormalizedModel(id, raw, devEntry, undefined);

      if (!existingMap.has(id)) {
        added += 1;
      } else {
        const old = existingMap.get(id);
        if (
          old.contextWindow !== normalized.contextWindow ||
          old.maxTokens !== normalized.maxTokens ||
          old.reasoning !== normalized.reasoning ||
          JSON.stringify(old.input) !== JSON.stringify(normalized.input)
        ) {
          updated += 1;
        }
      }
      nextModels.push(normalized);
    }

    return { provider: providerId, models: nextModels, added, updated };
  }

  async function executeSync(targetRoutes) {
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
      ? targetRoutes.filter((r) => providers[r])
      : Object.keys(providers).filter((p) => providers[p]?.baseUrl || providers[p]?.baseURL);

    const results = [];
    const ops = [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      for (const route of routes) {
        const pConfig = providers[route];
        if (!pConfig) continue;

        try {
          const res = await syncProviderModels(route, pConfig, catalog, controller.signal);
          ops.push({
            op: 'set',
            path: ['providers', route, 'models'],
            value: res.models,
          });
          results.push({
            provider: route,
            added: res.added,
            updated: res.updated,
          });
        } catch (err) {
          logger?.error?.(`[dsh-model-sync] Error syncing provider ${route}: ${err.message}`);
          results.push({
            provider: route,
            error: err.message,
          });
        }
      }

      if (ops.length > 0) {
        await settings.mutate(NS_SETTINGS, ops);
        logger?.info?.(`[dsh-model-sync] Successfully synchronized ${ops.length} provider(s)`);
      }
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
          const results = await executeSync(target);
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
