(function initSkimmerCache(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.SkimmerCache = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createSkimmerCache() {
  "use strict";

  const CACHE_STORAGE_KEY = "skimmerSummaryCacheV1";
  const CACHE_SCHEMA_VERSION = 2;
  const CACHE_PIPELINE_VERSION = "active-dom-key-points-sha256-v2";
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 24;
  let mutationQueue = Promise.resolve();

  async function sha256(value, cryptoApi = globalThis.crypto) {
    const input = typeof value === "string" ? value : String(value || "");
    if (
      !cryptoApi ||
      !cryptoApi.subtle ||
      typeof cryptoApi.subtle.digest !== "function"
    ) {
      throw new Error("SHA-256 is unavailable in this browser.");
    }
    const digest = await cryptoApi.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input)
    );
    return Array.from(new Uint8Array(digest), (byte) => (
      byte.toString(16).padStart(2, "0")
    )).join("");
  }

  async function createContentFingerprint(article, cryptoApi = globalThis.crypto) {
    const source = article && typeof article === "object" ? article : {};
    return sha256([
      CACHE_PIPELINE_VERSION,
      source.url || "",
      source.title || "",
      source.parser || "",
      source.cacheVariant || "",
      source.content || ""
    ].join("\n"), cryptoApi);
  }

  async function createCacheKey(article, cryptoApi = globalThis.crypto) {
    const fingerprint = await createContentFingerprint(article, cryptoApi);
    return `${CACHE_PIPELINE_VERSION}:${fingerprint}`;
  }

  function normalizePageUrl(value, baseUrl = "") {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const parsed = new URL(value.trim(), baseUrl || undefined);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "";
      }
      parsed.hostname = parsed.hostname.toLocaleLowerCase("en");
      return parsed.href;
    } catch (error) {
      return "";
    }
  }

  function getPageIdentities(article) {
    const source = article && typeof article === "object" ? article : {};
    const rawUrl = normalizePageUrl(source.url || "");
    const canonicalUrl = normalizePageUrl(
      source.canonicalUrl || "",
      rawUrl
    );
    return new Set([canonicalUrl, rawUrl].filter(Boolean));
  }

  function isSamePage(entry, article) {
    if (!entry || typeof entry !== "object") return false;
    const requestedVariant = sanitizeString(
      article && article.cacheVariant,
      3000
    );
    if (sanitizeString(entry.cacheVariant, 3000) !== requestedVariant) {
      return false;
    }
    const requestedIdentities = getPageIdentities(article);
    if (requestedIdentities.size === 0) return false;
    const entryUrl = normalizePageUrl(entry.url || "");
    return Boolean(entryUrl && requestedIdentities.has(entryUrl));
  }

  function enqueueMutation(mutation) {
    const next = mutationQueue.then(mutation, mutation);
    mutationQueue = next.catch(() => {});
    return next;
  }

  async function waitForPendingMutations() {
    await mutationQueue;
  }

  function sanitizeString(value, maxLength) {
    return typeof value === "string"
      ? value.replace(/\u0000/g, "").trim().slice(0, maxLength)
      : "";
  }

  function sanitizeSummary(result) {
    if (!result || typeof result !== "object") return null;
    const overview = sanitizeString(result.overview, 1800);
    const points = Array.isArray(result.points)
      ? result.points
          .map((point) => sanitizeString(point, 700))
          .filter(Boolean)
          .slice(0, 7)
      : [];
    if (!overview && points.length === 0) return null;

    return {
      overview,
      points,
      provider: sanitizeString(result.provider, 60),
      providerLabel: sanitizeString(result.providerLabel, 100),
      model: sanitizeString(result.model, 120)
    };
  }

  function normalizeCache(raw, now = Date.now()) {
    const cache = raw && typeof raw === "object" ? raw : {};
    const entries = cache.version === CACHE_SCHEMA_VERSION &&
      cache.entries &&
      typeof cache.entries === "object"
      ? cache.entries
      : {};
    const validEntries = {};

    for (const [key, entry] of Object.entries(entries)) {
      if (
        typeof key !== "string" ||
        !entry ||
        typeof entry !== "object" ||
        !Number.isFinite(entry.createdAt) ||
        now - entry.createdAt > CACHE_TTL_MS
      ) {
        continue;
      }
      const summary = sanitizeSummary(entry.summary);
      if (!summary) continue;
      validEntries[key] = {
        createdAt: entry.createdAt,
        title: sanitizeString(entry.title, 500),
        url: sanitizeString(entry.url, 4096),
        cacheVariant: sanitizeString(entry.cacheVariant, 3000),
        summary
      };
    }

    const sorted = Object.entries(validEntries)
      .sort((left, right) => right[1].createdAt - left[1].createdAt)
      .slice(0, CACHE_MAX_ENTRIES);

    return {
      version: CACHE_SCHEMA_VERSION,
      entries: Object.fromEntries(sorted)
    };
  }

  async function readStorage(storageArea, now = Date.now()) {
    if (!storageArea || typeof storageArea.get !== "function") {
      return normalizeCache(null, now);
    }
    const stored = await storageArea.get([CACHE_STORAGE_KEY]);
    return normalizeCache(stored && stored[CACHE_STORAGE_KEY], now);
  }

  async function read(storageArea, article, now = Date.now()) {
    await waitForPendingMutations();
    const cache = await readStorage(storageArea, now);
    const key = await createCacheKey(article);
    let entry = cache.entries[key];
    let cacheMatch = "content";
    if (!entry) {
      const currentPipelinePrefix = `${CACHE_PIPELINE_VERSION}:`;
      const samePageEntry = Object.entries(cache.entries)
        .filter(([entryKey, candidate]) => (
          entryKey.startsWith(currentPipelinePrefix) &&
          isSamePage(candidate, article)
        ))
        .sort((left, right) => right[1].createdAt - left[1].createdAt)[0];
      entry = samePageEntry && samePageEntry[1];
      cacheMatch = "page";
    }
    if (!entry || now - entry.createdAt > CACHE_TTL_MS) return null;
    return {
      ...entry.summary,
      cached: true,
      cachedAt: entry.createdAt,
      cacheMatch
    };
  }

  async function write(storageArea, article, result, now = Date.now()) {
    if (!storageArea || typeof storageArea.set !== "function") return false;
    const summary = sanitizeSummary(result);
    if (!summary) return false;
    return enqueueMutation(async () => {
      const cache = await readStorage(storageArea, now);
      const key = await createCacheKey(article);
      const currentPipelinePrefix = `${CACHE_PIPELINE_VERSION}:`;
      for (const [entryKey, entry] of Object.entries(cache.entries)) {
        if (
          entryKey !== key &&
          entryKey.startsWith(currentPipelinePrefix) &&
          isSamePage(entry, article)
        ) {
          delete cache.entries[entryKey];
        }
      }
      const pageIdentities = Array.from(getPageIdentities(article));
      cache.entries[key] = {
        createdAt: now,
        title: sanitizeString(article && article.title, 500),
        url: sanitizeString(pageIdentities[0] || "", 4096),
        cacheVariant: sanitizeString(article && article.cacheVariant, 3000),
        summary
      };
      const normalized = normalizeCache(cache, now);
      await storageArea.set({ [CACHE_STORAGE_KEY]: normalized });
      return true;
    });
  }

  async function clear(storageArea) {
    if (!storageArea) return;
    return enqueueMutation(async () => {
      if (typeof storageArea.remove === "function") {
        await storageArea.remove(CACHE_STORAGE_KEY);
        return;
      }
      if (typeof storageArea.set === "function") {
        await storageArea.set({
          [CACHE_STORAGE_KEY]: normalizeCache(null)
        });
      }
    });
  }

  async function count(storageArea) {
    await waitForPendingMutations();
    const cache = await readStorage(storageArea);
    return Object.keys(cache.entries).length;
  }

  return Object.freeze({
    CACHE_MAX_ENTRIES,
    CACHE_PIPELINE_VERSION,
    CACHE_SCHEMA_VERSION,
    CACHE_STORAGE_KEY,
    CACHE_TTL_MS,
    clear,
    count,
    createCacheKey,
    createContentFingerprint,
    getPageIdentities,
    isSamePage,
    normalizeCache,
    normalizePageUrl,
    read,
    sanitizeSummary,
    sha256,
    write
  });
});
