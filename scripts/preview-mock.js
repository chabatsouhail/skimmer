(function installSkimmerPreviewMocks() {
  "use strict";

  if (location.protocol === "chrome-extension:") return;

  const previewState = new URLSearchParams(location.search).get("state") || "ready";
  const previewStore = {};
  const article = {
    title: "Why focused-tab summaries feel instant",
    siteName: "Example Research",
    url: "https://example.com/research/skimmer",
    canonicalUrl: "",
    byline: "Maya Chen",
    description: "A performance study of live-page summarization.",
    language: "en",
    content: [
      "Live DOM extraction avoids a second network request and preserves text rendered by client-side applications.",
      "It can summarize authenticated content that background fetching cannot see.",
      "Temporary active-tab access narrows the permission surface to the page the user explicitly invoked.",
      "A content fingerprint lets repeat visits reuse a summary without storing the source article.",
      "The study found that direct extraction reduced acquisition latency and improved article completeness across dynamic news and documentation sites."
    ].join(" "),
    contentLength: 526,
    wordCount: 74,
    readingMinutes: 1,
    parser: "mozilla-readability",
    documentReadyState: "complete",
    extractedAt: Date.now()
  };
  const keyPointSummary = [
    "- Live DOM extraction removes the second network fetch and keeps client-rendered or signed-in article text.",
    "- Temporary active-tab access limits reading permission to the page the user explicitly selected.",
    "- Content fingerprints make repeat summaries instant without caching the original page text."
  ].join("\n");
  const wordSummary =
    "Live DOM extraction avoids a second network request and preserves text rendered by client-side applications.";
  const wordStreamChunks = [
    "Live DOM extr",
    "Live DOM extraction avoids a sec",
    "Live DOM extraction avoids a second network req",
    "Live DOM extraction avoids a second network request and pres",
    "Live DOM extraction avoids a second network request and preserves text rendered by cli",
    wordSummary
  ];

  try {
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive: true, hasBeenActive: true }
    });
  } catch (error) {}

  globalThis.chrome = {
    tabs: {
      async query() {
        return [{
          id: 42,
          active: true,
          title: article.title,
          url: previewState === "error"
            ? "chrome://settings/"
            : article.url,
          favIconUrl: "",
          incognito: false
        }];
      }
    },
    scripting: {
      async executeScript(options) {
        if (options.files) return [];
        return [{ result: { ok: true, article } }];
      }
    },
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key) => Object.hasOwn(previewStore, key))
              .map((key) => [key, previewStore[key]])
          );
        },
        async set(values) {
          Object.assign(previewStore, values);
        },
        async remove(key) {
          delete previewStore[key];
        }
      }
    },
    permissions: {
      async contains() {
        return false;
      },
      async request() {
        return true;
      },
      async remove() {
        return true;
      }
    }
  };

  globalThis.Summarizer = {
    async availability() {
      return "available";
    },
    create(options = {}) {
      if (typeof options.monitor === "function") {
        options.monitor({
          addEventListener(type, callback) {
            if (type !== "downloadprogress") return;
            setTimeout(() => callback({ loaded: 0.4 }), 80);
            setTimeout(() => callback({ loaded: 1 }), 180);
          }
        });
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          type: previewState === "words" ? "tldr" : options.type,
          length: options.length,
          summarizeStreaming() {
            const pointChunks = [
              keyPointSummary.split("\n")[0],
              keyPointSummary.split("\n").slice(0, 2).join("\n"),
              keyPointSummary
            ];
            const chunks = previewState === "words"
              ? wordStreamChunks
              : pointChunks;
            return new ReadableStream({
              async start(controller) {
                const firstDelay = previewState === "loading" ? 10000 : 110;
                const stepDelay = previewState === "streaming"
                  ? 700
                  : previewState === "words"
                    ? 360
                    : 80;
                await new Promise((done) => setTimeout(done, firstDelay));
                for (let index = 0; index < chunks.length; index += 1) {
                  controller.enqueue(chunks[index]);
                  if (index < chunks.length - 1) {
                    await new Promise((done) => setTimeout(done, stepDelay));
                  }
                }
                controller.close();
              }
            });
          },
          async summarize() {
            const delay = previewState === "loading" ? 10000 : 260;
            await new Promise((done) => setTimeout(done, delay));
            return previewState === "words"
              ? wordSummary
              : keyPointSummary;
          },
          destroy() {}
        }), 210);
      });
    }
  };

  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          previewStore.previewClipboard = String(value);
        }
      }
    });
  } catch (error) {}
})();
