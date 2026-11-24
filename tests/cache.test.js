const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CACHE_MAX_ENTRIES,
  CACHE_STORAGE_KEY,
  CACHE_TTL_MS,
  clear,
  count,
  createCacheKey,
  createContentFingerprint,
  read,
  write
} = require("../cache.js");

function createStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => Object.hasOwn(data, key))
          .map((key) => [key, data[key]])
      );
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(key) {
      delete data[key];
    }
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createYieldingStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      const snapshot = Object.fromEntries(
        requested
          .filter((key) => Object.hasOwn(data, key))
          .map((key) => [key, data[key]])
      );
      await nextTurn();
      return snapshot;
    },
    async set(values) {
      await nextTurn();
      Object.assign(data, values);
    },
    async remove(key) {
      await nextTurn();
      delete data[key];
    }
  };
}

function createBlockedReadStorage() {
  const storage = createStorage();
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const readReleased = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const originalGet = storage.get;
  storage.get = async (keys) => {
    const snapshot = await originalGet(keys);
    markReadStarted();
    await readReleased;
    return snapshot;
  };
  return {
    ...storage,
    readStarted,
    releaseRead
  };
}

function article(content, suffix = "") {
  return {
    title: `Article ${suffix}`,
    url: `https://example.com/${suffix}`,
    parser: "mozilla-readability",
    content
  };
}

test("content fingerprints are deterministic SHA-256 values and track live SPA changes", async () => {
  const first = article("First live page state", "dashboard");
  const second = article("Second live page state", "dashboard");
  const [firstFingerprint, repeatedFingerprint, secondFingerprint] =
    await Promise.all([
      createContentFingerprint(first),
      createContentFingerprint(first),
      createContentFingerprint(second)
    ]);
  const [firstKey, secondKey] = await Promise.all([
    createCacheKey(first),
    createCacheKey(second)
  ]);

  assert.match(firstFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(firstFingerprint, repeatedFingerprint);
  assert.notEqual(firstFingerprint, secondFingerprint);
  assert.notEqual(firstKey, secondKey);
  assert.match(firstKey, /:[0-9a-f]{64}$/);
});

test("cache stores only the result, not extracted source text", async () => {
  const storage = createStorage();
  const source = article("PRIVATE-SOURCE-TEXT ".repeat(20), "private");
  const now = Date.now();
  await write(storage, source, {
    overview: "A safe summary.",
    points: ["One supported point."],
    provider: "on-device",
    providerLabel: "On-device AI",
    model: "chrome-summarizer"
  }, now);

  const serialized = JSON.stringify(storage.data[CACHE_STORAGE_KEY]);
  assert.doesNotMatch(serialized, /PRIVATE-SOURCE-TEXT/);
  const cached = await read(storage, source, now + 1);
  assert.equal(cached.cached, true);
  assert.equal(cached.cacheMatch, "content");
  assert.equal(cached.overview, "A safe summary.");
});

test("cache reuses the newest summary when the same live page changes slightly", async () => {
  const storage = createStorage();
  const now = Date.now();
  const first = article(
    "Stable article body with a live counter showing 41 readers.",
    "changing-page"
  );
  const changed = article(
    "Stable article body with a live counter showing 42 readers.",
    "changing-page"
  );
  await write(storage, first, {
    overview: "Cached page summary.",
    points: ["The stable page point."],
    provider: "on-device"
  }, now);

  const cached = await read(storage, changed, now + 1);
  assert.equal(cached.cacheMatch, "page");
  assert.equal(cached.overview, "Cached page summary.");
});

test("same-page cache fallback does not cross to another URL", async () => {
  const storage = createStorage();
  const now = Date.now();
  await write(storage, article("First page content.", "first-page"), {
    overview: "First page summary.",
    points: [],
    provider: "on-device"
  }, now);

  assert.equal(
    await read(storage, article("First page content.", "second-page"), now + 1),
    null
  );
});

test("same-page cache fallback does not cross summary configurations", async () => {
  const storage = createStorage();
  const now = Date.now();
  const concise = {
    ...article("Stable page content.", "configured-page"),
    cacheVariant: "{\"type\":\"tldr\"}"
  };
  const insights = {
    ...article("Stable page content.", "configured-page"),
    cacheVariant: "{\"type\":\"key-points\"}"
  };
  await write(storage, concise, {
    overview: "Concise configuration summary.",
    points: [],
    provider: "on-device"
  }, now);

  assert.equal(await read(storage, insights, now + 1), null);
});

test("a refreshed summary replaces older cache entries for the same page", async () => {
  const storage = createStorage();
  const now = Date.now();
  const first = article("Earlier live page content.", "refresh-page");
  const refreshed = article("Refreshed live page content.", "refresh-page");
  await write(storage, first, {
    overview: "Earlier summary.",
    points: [],
    provider: "on-device"
  }, now);
  await write(storage, refreshed, {
    overview: "Refreshed summary.",
    points: [],
    provider: "on-device"
  }, now + 1);

  assert.equal(await count(storage), 1);
  assert.equal(
    (await read(storage, first, now + 2)).overview,
    "Refreshed summary."
  );
});

test("expired summaries are not returned", async () => {
  const storage = createStorage();
  const source = article("Enough content for a cache identity.", "old");
  const now = Date.now();
  await write(storage, source, {
    overview: "Old summary.",
    points: [],
    provider: "on-device",
    providerLabel: "On-device AI",
    model: "chrome-summarizer"
  }, now);

  assert.equal(await read(storage, source, now + CACHE_TTL_MS + 1), null);
});

test("cache remains bounded to the newest entries", async () => {
  const storage = createStorage();
  const now = Date.now();
  for (let index = 0; index < CACHE_MAX_ENTRIES + 5; index += 1) {
    await write(storage, article(`Content ${index}`, String(index)), {
      overview: `Summary ${index}`,
      points: [],
      provider: "on-device",
      providerLabel: "On-device AI",
      model: "chrome-summarizer"
    }, now + index);
  }

  assert.equal(await count(storage), CACHE_MAX_ENTRIES);
  assert.equal(
    await read(storage, article("Content 0", "0"), now + 100),
    null
  );
  assert.equal(
    (await read(
      storage,
      article(`Content ${CACHE_MAX_ENTRIES + 4}`, String(CACHE_MAX_ENTRIES + 4)),
      now + 100
    )).overview,
    `Summary ${CACHE_MAX_ENTRIES + 4}`
  );
});

test("concurrent writes are serialized without losing either summary", async () => {
  const storage = createYieldingStorage();
  const now = Date.now();
  const first = article("First concurrent source.", "concurrent-first");
  const second = article("Second concurrent source.", "concurrent-second");

  await Promise.all([
    write(storage, first, {
      overview: "First concurrent summary.",
      points: [],
      provider: "on-device"
    }, now),
    write(storage, second, {
      overview: "Second concurrent summary.",
      points: [],
      provider: "on-device"
    }, now + 1)
  ]);

  assert.equal(await count(storage), 2);
  assert.equal((await read(storage, first, now + 2)).overview, "First concurrent summary.");
  assert.equal((await read(storage, second, now + 2)).overview, "Second concurrent summary.");
});

test("clear runs after an already-enqueued write and cannot be overtaken by it", async () => {
  const storage = createBlockedReadStorage();
  const source = article("Sensitive source that must stay cleared.", "clear-race");
  const pendingWrite = write(storage, source, {
    overview: "Summary scheduled before clear.",
    points: [],
    provider: "on-device"
  }, Date.now());

  await storage.readStarted;
  const pendingClear = clear(storage);
  storage.releaseRead();
  await Promise.all([pendingWrite, pendingClear]);

  assert.equal(await count(storage), 0);
  assert.equal(storage.data[CACHE_STORAGE_KEY], undefined);
});
