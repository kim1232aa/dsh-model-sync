/**
 * lib/core.js — Core model matching, candidate generation, and capability arbitration.
 * Shared pure logic ported and hardened from pi-model-sync for DeepSeek Harness (DSH).
 */

const BRACKET_TAG_RE = /\[[^\]]*\]/g;
const TAG_SUFFIX_RE = /(?::(?:free|thinking|preview|default)|@[^/]+)$/i;
const ROUTING_SUFFIX_RE = /-(?:openai-compact|compact|review|fast|wm|free)$/i;
const VARIANT_SUFFIX_RE = /-(?:high|low|medium|tiered|extra-low|extra|thinking|agent)$/i;
const ECO_PREFIX_RE = /^eco-/i;

const COMMON_VISION_RE =
  /(?:^|[-_/])(vision|vl|multimodal|omni|gpt-4o|gpt-5|gpt-6|gemini|claude|qwen.*(?:vl|omni)|doubao.*(?:vl|vision)|mimo)(?:$|[-_/])/i;

const REASONING_ID_PATTERNS = [
  /(?:^|[-_/])(?:o1|o3|o4)(?:$|[-_/])/i,
  /(?:^|[-_/])r1(?:$|[-_/])/i,
  /(?:^|[-_/])(?:deepseek-r1|deepseek-v4|deepseek-v5)/i,
  /(?:^|[-_/])(?:gpt-5|gpt-6|gpt-5\.\d+|gpt-6\.\d+)/i,
  /(?:^|[-_/])gemini-(?:2\.5|3|3\.\d+)(?:$|[-_/])/i,
  /(?:^|[-_/])(?:claude-3-7|claude-3\.7|claude-4)/i,
  /(?:^|[-_/])(?:glm-5|glm-4\.7|glm-4\.6)/i,
  /(?:^|[-_/])(?:kimi-k2|kimi-k3)/i,
  /(?:^|[-_/])(?:grok-3|grok-4)/i,
  /(?:^|[-_/])thinking(?:$|[-_/])/i,
  /(?:^|[-_/])reasoning(?:$|[-_/])/i,
];

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

    const noVariant = noRouting.replace(VARIANT_SUFFIX_RE, "");
    add(noVariant);

    const noEco = noVariant.replace(ECO_PREFIX_RE, "");
    add(noEco);
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
        if (mId.toLowerCase() === lowerCand) {
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

export function inferReasoningFromId(id) {
  return REASONING_ID_PATTERNS.some((pat) => pat.test(id));
}

export function inferVisionFromId(id) {
  return COMMON_VISION_RE.test(id);
}

export function thinkingLevelMapFromDev(dev) {
  if (!dev?.reasoning_options || !Array.isArray(dev.reasoning_options)) return undefined;
  const effortOption = dev.reasoning_options.find((opt) => opt?.type === "effort");
  if (!effortOption || !Array.isArray(effortOption.values)) return undefined;

  const map = {};
  for (const v of effortOption.values) {
    if (typeof v === "string" && v) {
      const key = v === "none" ? "off" : v;
      map[key] = key === "off" ? null : key;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export function defaultGptThinkingLevelMap(id) {
  if (/gpt-5\.6/i.test(id)) {
    return {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      max: "max",
    };
  }
  if (/gpt-[56]/i.test(id)) {
    return {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
    };
  }
  return undefined;
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

  // Vision resolution: override > raw=true > dev=true > raw=false > heuristic
  let vision = false;
  if (override?.vision !== undefined) {
    vision = Boolean(override.vision);
  } else if (caps.vision === true) {
    vision = true;
  } else if (devEntry?.modalities?.input?.includes("image")) {
    vision = true;
  } else if (caps.vision === false) {
    vision = false;
  } else {
    vision = inferVisionFromId(id);
  }

  // Reasoning resolution
  let reasoning = false;
  if (override?.reasoning !== undefined) {
    reasoning = Boolean(override.reasoning);
  } else if (
    caps.reasoning === true ||
    devEntry?.reasoning === true ||
    inferReasoningFromId(id) === true
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
  if (reasoning && Object.keys(thinkingLevelMap).length === 0) {
    const defaultMap = defaultGptThinkingLevelMap(id);
    if (defaultMap) Object.assign(thinkingLevelMap, defaultMap);
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

  const modelRow = {
    id,
    name: rawModel.name || id,
    contextWindow,
    maxTokens: maxOutput,
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
  };

  if (reasoning && Object.keys(thinkingLevelMap).length > 0) {
    modelRow.thinkingLevelMap = thinkingLevelMap;
    modelRow.thinkingFormat = "effort";
  }

  return modelRow;
}
