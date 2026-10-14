/**
 * lib/models-dev.js — Fetch and cache models.dev catalog for DeepSeek Harness (DSH).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_TIMEOUT_MS = 30_000;

export class ModelsDevService {
  constructor({ url = DEFAULT_URL, cachePath, ttlMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
    this.url = url;
    this.cachePath = cachePath || join(tmpdir(), `dsh-model-sync-models-dev-${process.getuid?.() ?? 'u'}.json`);
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.memoryCache = undefined;
  }

  readCache(ignoreTtl = false) {
    try {
      if (this.memoryCache && (ignoreTtl || Date.now() - this.memoryCache.fetchedAt < this.ttlMs)) {
        return this.memoryCache.data;
      }
      if (existsSync(this.cachePath)) {
        const raw = JSON.parse(readFileSync(this.cachePath, 'utf8'));
        if (raw && typeof raw.data === 'object' && raw.data
          && (ignoreTtl || Date.now() - Number(raw.fetchedAt || 0) < this.ttlMs)) {
          this.memoryCache = raw;
          return raw.data;
        }
      }
    } catch {
      // cache miss or corrupt
    }
    return undefined;
  }

  writeCache(data) {
    try {
      const entry = { fetchedAt: Date.now(), data };
      this.memoryCache = entry;
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.tmp-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, this.cachePath);
    } catch (err) {
      this.logger?.warn?.(`[dsh-model-sync] writeCache error: ${err.message}`);
    }
  }

  async getCatalog(force = false) {
    if (!force) {
      const cached = this.readCache();
      if (cached) return cached;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'dsh-model-sync/1.2.1' },
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch models.dev (${res.status} ${res.statusText})`);
      }

      const json = await res.json();
      if (json && typeof json === 'object') {
        this.writeCache(json);
        return json;
      }
      throw new Error('Invalid JSON received from models.dev');
    } catch (error) {
      this.logger?.warn?.(`[dsh-model-sync] Network fetch failed, using cached if available: ${error.message}`);
      // Stale data beats no data when models.dev is unreachable.
      const fallback = this.readCache(true);
      if (fallback) return fallback;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
