/**
 * lib/core.js — Core model matching, candidate generation, and capability arbitration.
 * Shared pure logic ported and hardened from pi-model-sync for DeepSeek Harness (DSH).
 */

const BRACKET_TAG_RE = /\[[^\]]*\]/g;
const TAG_SUFFIX_RE = /(?::(?:free|thinking|preview|default)|@[^/]+)$/i;
const ROUTING_SUFFIX_RE = /-(?:openai-compact|compact|review|fast|wm|free)$/i;
const VARIANT_SUFFIX_RE = /-(?:high|low|medium|tiered|extra-low|extra|thinking|agent)$/i;
const ECO_PREFIX_RE = /^eco-/i;
// trailing date snapshot: -250415, -20250415, -2025-04-15, -0613 (MMDD)
const DATE_SNAPSHOT_RE = /-(?:(?:\d{2}|\d{4})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|\d{4}-\d{2}-\d{2}|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/;

/**
 * Generate fuzzy match candidates from a model identifier.
 * Strips gateway prefixes (e.g., cx/, Agent-Plan/), bracket tags (e.g., [1m]),
 * routing suffixes (e.g., -review), and variant tiers (e.g., -high, -low).
 */
export function generateLookupCandidates(id) {
  const forms = new Set([id]);

  if (id.includes("[")) {
    forms.add(id.replace(BRACKET_TAG_RE, ""));
  }

  if (id.includes("/")) {
    const parts = id.split("/");
    forms.add(parts[parts.length - 1]);
    if (parts.length > 2) {
      forms.add(parts.slice(1).join("/"));
    }
  }

  const result = [];
  const add = (c) => {
    if (!c) return;
    const clean = c.trim();
    if (clean && !result.includes(clean)) result.push(clean);
  };

  for (const form of forms) {
    add(form);
    const noBracket = form.replace(BRACKET_TAG_RE, "");
    add(noBracket);

    const noTag = noBracket.replace(TAG_SUFFIX_RE, "");
    add(noTag);

    const noRouting = noTag.replace(ROUTING_SUFFIX_RE, "");
    add(noRouting);

    // strip variants repeatedly ("-extra-low" -> "-extra" -> base)
    let noVariant = noRouting;
    for (let i = 0; i < 3; i++) {
      const next = noVariant.replace(VARIANT_SUFFIX_RE, "");
      if (next === noVariant) break;
      noVariant = next;
      add(noVariant);
    }
    add(noVariant);

    const noEco = noVariant.replace(ECO_PREFIX_RE, "");
    add(noEco);
  }

  for (const c of [...result]) {
    add(c.replace(DATE_SNAPSHOT_RE, ""));
  }

  for (const c of [...result]) {
    const hyphenated = c.replace(/(\d+)\.(\d+)/g, "$1-$2");
    add(hyphenated);
    const dotted = c.replace(/(\d+)-(\d+)/g, "$1.$2");
    add(dotted);
  }

  for (const c of [...result]) {
    if (c.endsWith("-preview")) add(c.slice(0, -"-preview".length));
    else add(`${c}-preview`);
    if (c.endsWith("-latest")) add(c.slice(0, -"-latest".length));
  }

  return result;
}

/**
 * Pick the best representative entry from multiple models.dev candidates.
 * Prefers first-party authoritative lab definitions, then falls back to fuller specifications.
 */
export function pickDevRepresentative(candidates) {
  if (!candidates || candidates.length === 0) return undefined;
  const firstParty = candidates.find(({ providerId, model }) => {
    const canonical = model.canonical_model_id;
    return typeof canonical === "string" && canonical.split("/")[0] === providerId;
  });
  if (firstParty) return firstParty.model;
  if (candidates.length === 1) return candidates[0].model;

  const sorted = [...candidates].sort((a, b) => {
    const ctxA = Number(a.model.limit?.context) || 0;
    const ctxB = Number(b.model.limit?.context) || 0;
    return ctxB - ctxA;
  });
  return sorted[0].model;
}

/**
 * Look up a model definition in the models.dev catalog.
 */
export function lookupModelsDev(catalog, modelId) {
  if (!catalog) return undefined;
  const candidates = generateLookupCandidates(modelId);

  for (const cand of candidates) {
    const lowerCand = cand.toLowerCase();
    const hits = [];
    for (const [providerId, providerBlock] of Object.entries(catalog)) {
      const models = providerBlock?.models;
      if (!models || typeof models !== "object") continue;
      for (const [mId, mEntry] of Object.entries(models)) {
        const lowerId = mId.toLowerCase();
        if (lowerId === lowerCand || lowerId.slice(lowerId.lastIndexOf("/") + 1) === lowerCand) {
          hits.push({ providerId, model: mEntry });
        }
      }
    }
    const chosen = pickDevRepresentative(hits);
    if (chosen) return chosen;
  }
  return undefined;
}

function parsePositiveNumber(v) {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * Thinking levels a DSH profile may declare (`dsh-llm-pi-ai` THINKING_LEVELS), in escalation order.
 * Source: packages/llm/llm-pi-ai/src/catalog.ts (deepseek-ai/deepseek-harness).
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Request modalities a DSH model entry may declare. */
export const MODALITIES = ['text', 'image'];

/**
 * Reasoning-dispatch wire formats a DSH `compat.thinkingFormat` may name
 * (union of the released rc.1 set and the current master set).
 */
export const SUPPORTED_THINKING_FORMATS = [
  'openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen',
  'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
];

/** Fields written by dsh-model-sync 1.0.x that are not part of a DSH model profile. */
const LEGACY_ROW_KEYS = ['reasoning', 'thinkingLevelMap', 'thinkingFormat'];

export function thinkingLevelMapFromDev(dev) {
  if (!dev?.reasoning_options || !Array.isArray(dev.reasoning_options)) return undefined;
  const effortOption = dev.reasoning_options.find((opt) => opt?.type === "effort");
  if (!effortOption || !Array.isArray(effortOption.values)) return undefined;

  const map = {};
  for (const v of effortOption.values) {
    if (typeof v !== "string" || !v) continue;
    const key = v === "none" ? "off" : v;
    // models.dev also lists values such as "default" that are not DSH levels.
    if (!THINKING_LEVELS.includes(key)) continue;
    map[key] = key === "off" ? null : key;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

const NON_CHAT_ID_PATTERNS = [
  /(?:^|[-_/])(?:embed|embedding|rerank|reranker)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:tts|whisper|speech|audio|voice|transcribe|transcription|realtime)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:dall-e|midjourney|flux|stable-diffusion|sdxl|imagen|gpt-image|seedream|seededit|seedance|grok-imagine)(?:$|[-_/])/i,
  // generation models: dedicated vendors/families, or an id that ENDS in image/video
  // (keeps chat models such as qwen3-vl-image-understanding / kimi-k2-video-chat)
  /(?:^|[-_/])(?:kling|sora|veo|i2v|t2v|flf2v|r2v)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:image|video)(?:-(?:preview|generation|gen|exp|\d[\w.]*))?$/i,
  /(?:^|[-_/])(?:moderation|guardrail|safety)(?:$|[-_/])/i,
];

export function isNonChatModel(id) {
  return NON_CHAT_ID_PATTERNS.some((pat) => pat.test(id));
}

/**
 * Arbitrate model attributes combining raw gateway payload, models.dev specifications, and overrides.
 */
export function buildNormalizedModel(id, rawModel = {}, devEntry, override) {
  const caps = rawModel.capabilities || {};

  // Context window & max output: use Math.max to avoid gateway cutoff (e.g. 272k / 128k)
  const rawContext = parsePositiveNumber(caps.contextWindow || rawModel.context_window || rawModel.contextWindow);
  const devContext = parsePositiveNumber(devEntry?.limit?.context);
  let contextWindow = Math.max(rawContext ?? 0, devContext ?? 0);
  if (contextWindow === 0) contextWindow = 128000;

  const rawMaxOutput = parsePositiveNumber(caps.maxOutput || rawModel.max_output_tokens || rawModel.maxOutput);
  const devMaxOutput = parsePositiveNumber(devEntry?.limit?.output);
  let maxOutput = Math.max(rawMaxOutput ?? 0, devMaxOutput ?? 0);
  if (maxOutput === 0) maxOutput = 16384;

  // Vision resolution: override > raw=true > dev=true > raw=false > false (never guessed from the id)
  let vision = false;
  if (override?.vision !== undefined) {
    vision = Boolean(override.vision);
  } else if (caps.vision === true) {
    vision = true;
  } else if (devEntry?.modalities?.input?.includes("image")) {
    vision = true;
  } else if (caps.vision === false) {
    vision = false;
  }

  // Reasoning resolution
  let reasoning = false;
  if (override?.reasoning !== undefined) {
    reasoning = Boolean(override.reasoning);
  } else if (
    caps.reasoning === true ||
    devEntry?.reasoning === true
  ) {
    reasoning = true;
  } else if (caps.reasoning === false) {
    reasoning = false;
  } else if (devEntry?.reasoning === false) {
    reasoning = false;
  }

  // Thinking level mapping
  const devThinkingMap = thinkingLevelMapFromDev(devEntry);
  const thinkingLevelMap = { ...(devThinkingMap ?? {}) };
  if (override?.thinkingLevelMap) {
    Object.assign(thinkingLevelMap, override.thinkingLevelMap);
  }
  // Strong UI consistency invariant:
  const hasActiveThinking = Object.entries(thinkingLevelMap).some(([k, v]) => k !== "off" && v !== null);
  if (override?.reasoning === undefined && hasActiveThinking) {
    reasoning = true;
  }

  if (!reasoning) {
    for (const k of Object.keys(thinkingLevelMap)) {
      delete thinkingLevelMap[k];
    }
  }

  // DSH model profile (packages/llm/llm-pi-ai catalog.ts): reasoningEfforts is
  // `false` for a non-reasoning model, or a dict of levels with at least one
  // non-"off" level. A reasoning model whose levels cannot be determined keeps
  // the field absent rather than inventing wire values.
  const modelRow = {
    id,
    name: rawModel.name || id,
    contextWindow,
    maxTokens: maxOutput,
    input: vision ? ["text", "image"] : ["text"],
  };

  if (!reasoning) {
    modelRow.reasoningEfforts = false;
  } else if (hasActiveThinking) {
    modelRow.reasoningEfforts = orderLevels(thinkingLevelMap);
  }

  return modelRow;
}

function orderLevels(map) {
  const out = {};
  for (const level of THINKING_LEVELS) {
    if (Object.prototype.hasOwnProperty.call(map, level)) out[level] = map[level];
  }
  return out;
}

export const BUILT_IN_PROVIDERS = new Set([
  'deepseek',
  'openai',
  'anthropic',
  'google',
  'google-genai',
  'vertexai',
  'kimi',
  'moonshot',
  'groq',
  'cerebras',
  'mistral',
  'cohere',
  'github-copilot',
  'azure',
]);

export const DEFAULT_BUILTIN_DOMAINS = [
  'api.deepseek.com',
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'googleapis.com',
  'api.kimi.com',
  'api.kimi.ai',
  'api.moonshot.cn',
  'api.moonshot.ai',
  'api.mistral.ai',
  'api.groq.com',
  'api.cerebras.ai',
  'openai.azure.com',
];

/**
 * Determine candidate URLs for fetching models from a gateway.
 * Automatically tests /v1/models and falls back to /models for endpoints lacking /v1.
 */
export function getCandidateModelUrls(baseUrl) {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  const candidates = [];

  if (/\/v\d+(?:beta)?$/i.test(clean)) {
    candidates.push(`${clean}/models`);
  } else {
    candidates.push(`${clean}/v1/models`);
    candidates.push(`${clean}/models`);
  }
  return candidates;
}

/**
 * Determine whether a provider is an eligible custom/relay gateway provider in DSH,
 * strictly skipping built-in providers, OAuth accounts, and official endpoints.
 */
export function isCustomProvider(providerId, providerConfig) {
  if (!providerConfig || typeof providerConfig !== 'object') return false;

  // Explicit user override
  if (providerConfig.sync === true) return true;
  if (providerConfig.sync === false) return false;

  // Must have a valid baseUrl
  const baseUrl = (providerConfig.baseUrl || providerConfig.baseURL || '').trim();
  if (!baseUrl) return false;

  const idLower = String(providerId).toLowerCase().trim();

  // Exclude OAuth accounts
  if (providerConfig.oauth !== undefined || providerConfig.auth === 'oauth') return false;

  // Check built-in provider names against default official domains
  const isBuiltIn = BUILT_IN_PROVIDERS.has(idLower);
  if (isBuiltIn) {
    const urlLower = baseUrl.toLowerCase();
    const isOfficialEndpoint = DEFAULT_BUILTIN_DOMAINS.some((domain) => urlLower.includes(domain));
    if (isOfficialEndpoint) {
      return false;
    }
  }

  return true;
}

/**
 * Remove fields dsh-model-sync 1.0.x wrote that DSH does not understand, and
 * the invalid `compat` it wrote (`thinkingFormat: "effort"`).
 */
export function healLegacyRow(row) {
  if (!row || typeof row !== 'object') return row;
  const healed = { ...row };
  for (const key of LEGACY_ROW_KEYS) delete healed[key];
  const compat = healed.compat;
  if (compat && typeof compat === 'object' && compat.thinkingFormat === 'effort') {
    const { thinkingFormat: _drop, ...rest } = compat;
    const onlyLegacy = Object.keys(rest).every((k) => k === 'supportsReasoningEffort' && rest[k] === true);
    if (onlyLegacy) delete healed.compat;
    else healed.compat = rest;
  }
  return healed;
}

function sanitizeEfforts(efforts) {
  if (!efforts || typeof efforts !== 'object' || Array.isArray(efforts)) return undefined;
  const out = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(efforts, level)) continue;
    const wire = efforts[level];
    if (wire === null && level === 'off') out[level] = null;
    else if (typeof wire === 'string' && wire.length > 0) out[level] = wire;
  }
  return out;
}

/**
 * Merge newly computed model specifications with the existing DSH model profile,
 * preserving user-defined fields and per-level reasoning wire values the user set.
 * Legacy 1.0.x fields are healed away first.
 */
export function mergeModelEntry(existingModel, generatedModel) {
  if (!existingModel || typeof existingModel !== 'object') {
    return generatedModel;
  }

  const existing = healLegacyRow(existingModel);
  const merged = { ...existing, ...generatedModel };

  // DSH accepts only text/image modalities; keep the union of what is valid.
  const inputSet = new Set([
    ...(Array.isArray(existing.input) ? existing.input : []),
    ...(Array.isArray(generatedModel.input) ? generatedModel.input : []),
  ].filter((m) => MODALITIES.includes(m)));
  merged.input = MODALITIES.filter((m) => inputSet.has(m));

  // A generated non-reasoning declaration (`false`) or absent levels: keep user's dict if usable.
  const userEfforts = sanitizeEfforts(existing.reasoningEfforts);
  if (userEfforts && Object.keys(userEfforts).length > 0) {
    const generatedDict = generatedModel.reasoningEfforts && typeof generatedModel.reasoningEfforts === 'object'
      ? generatedModel.reasoningEfforts : {};
    merged.reasoningEfforts = orderLevels({ ...generatedDict, ...userEfforts });
  } else if (generatedModel.reasoningEfforts === undefined && existing.reasoningEfforts === undefined) {
    delete merged.reasoningEfforts;
  }

  return merged;
}

/**
 * Check one model row against the DSH model profile rules
 * (packages/llm/llm-pi-ai catalog.ts / config.ts, deepseek-ai/deepseek-harness).
 * @returns list of human-readable problems; empty when the row is serviceable.
 */
export function validateModelRow(row) {
  const errors = [];
  if (!row || typeof row !== 'object') return ['model entry is not an object'];
  const id = row.id;
  if (typeof id !== 'string' || id.length === 0) errors.push('id must be a non-empty string');
  const label = typeof id === 'string' && id ? `model "${id}"` : 'model';
  if (row.name !== undefined && typeof row.name !== 'string') errors.push(`${label} name must be a string`);
  for (const field of ['contextWindow', 'maxTokens']) {
    if (row[field] !== undefined && (!Number.isInteger(row[field]) || row[field] <= 0)) {
      errors.push(`${label} ${field} must be a positive integer`);
    }
  }
  if (row.input !== undefined) {
    if (!Array.isArray(row.input) || row.input.some((m) => !MODALITIES.includes(m))) {
      errors.push(`${label} input must only contain ${MODALITIES.join(', ')}`);
    }
  }
  const efforts = row.reasoningEfforts;
  if (efforts !== undefined && efforts !== false) {
    if (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts) || Object.keys(efforts).length === 0) {
      errors.push(`${label} reasoningEfforts must be false or a non-empty level dict`);
    } else {
      let hasActive = false;
      for (const [level, wire] of Object.entries(efforts)) {
        if (!THINKING_LEVELS.includes(level)) {
          errors.push(`${label} reasoningEfforts has unknown level "${level}"`);
          continue;
        }
        if (wire === null) {
          if (level !== 'off') errors.push(`${label} reasoningEfforts.${level} needs a wire value; only "off" may be empty`);
        } else if (typeof wire !== 'string' || wire.length === 0) {
          errors.push(`${label} reasoningEfforts.${level} must be a non-empty string`);
        } else if (level !== 'off') {
          hasActive = true;
        }
      }
      if (!hasActive) errors.push(`${label} reasoningEfforts offers no level beyond "off"`);
    }
  }
  if (row.compat !== undefined) {
    if (!row.compat || typeof row.compat !== 'object' || Array.isArray(row.compat)) {
      errors.push(`${label} compat must be an object`);
    } else if (row.compat.thinkingFormat !== undefined && !SUPPORTED_THINKING_FORMATS.includes(row.compat.thinkingFormat)) {
      errors.push(`${label} compat.thinkingFormat "${row.compat.thinkingFormat}" is not a supported format`);
    }
  }
  return errors;
}

/** Validate a provider's full model list (row rules + unique ids + non-empty). */
export function validateModelList(models) {
  if (!Array.isArray(models) || models.length === 0) return ['model list is empty'];
  const errors = [];
  const seen = new Set();
  for (const row of models) {
    errors.push(...validateModelRow(row));
    if (row && typeof row.id === 'string') {
      if (seen.has(row.id)) errors.push(`model "${row.id}" is listed more than once`);
      seen.add(row.id);
    }
  }
  return errors;
}

/** Deterministic JSON (sorted keys) used to compare model rows. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Read a settings namespace, supporting both legacy get() and DSH SettingsForms.describe(). */
export function readSettingsNamespace(settings, ns) {
  if (!settings) return undefined;
  if (typeof settings.get === 'function') {
    return settings.get(ns);
  }
  if (typeof settings.describe === 'function') {
    const descriptors = settings.describe();
    if (Array.isArray(descriptors)) {
      const hit = descriptors.find((d) => d && d.ns === ns);
      return hit?.value ?? hit?.user ?? hit?.base;
    }
  }
  return undefined;
}
