const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GEMINI_ENDPOINT,
  GEMINI_MODEL,
  FAST_SUMMARY_INPUT_CHARS,
  ON_DEVICE_MODEL_LABEL,
  SUMMARIZER_OPTIONS,
  buildGeminiRequest,
  cleanSummaryOverview,
  compactSummaryInput,
  createOnDeviceSummarizer,
  createRecoverySummaryInput,
  createStableFallbackSummarizerOptions,
  createSummarizerCacheVariant,
  getGeminiRetryAfterMs,
  getGeminiRetryDelayMs,
  getStableStreamingText,
  groundSummaryResult,
  isLikelyIncompleteSummary,
  mergeStreamingText,
  normalizeSummarizerOptions,
  parseGeminiRetryDelayMs,
  parseGeminiSummary,
  parseKeyPoints,
  summarizeWithGemini,
  summarizeWithOnDevice
} = require("../ai.js");

test("key-point parser accepts markdown bullets and wrapped lines", () => {
  const points = parseKeyPoints([
    "Key points",
    "- **Launch date:** The product launches on 12 August.",
    "  Availability begins in three regions.",
    "2. Price remains at $49 for existing customers.",
    "• The update removes the legacy export path."
  ].join("\n"));

  assert.deepEqual(points, [
    "Launch date: The product launches on 12 August. Availability begins in three regions.",
    "Price remains at $49 for existing customers.",
    "The update removes the legacy export path."
  ]);
});

test("Gemini structured response parser is bounded and strips markdown", () => {
  const parsed = parseGeminiSummary([
    "```json",
    JSON.stringify({
      overview: "**Acme** released a smaller reader for teams.",
      key_points: [
        "The device weighs 180 grams.",
        "It starts at $199.",
        "A third point.",
        "A fourth point.",
        "A fifth point.",
        "A sixth point that must be dropped."
      ]
    }),
    "```"
  ].join("\n"));

  assert.equal(parsed.overview, "Acme released a smaller reader for teams.");
  assert.equal(parsed.points.length, 5);
  assert.equal(parsed.points[0], "The device weighs 180 grams.");
});

test("Gemini request uses the fast stable model contract without sampling knobs", () => {
  const request = buildGeminiRequest({
    title: "Example",
    siteName: "Example News",
    url: "https://example.com/story",
    content: "Substantive article text ".repeat(20)
  });

  assert.equal(GEMINI_MODEL, "gemini-3.1-flash-lite");
  assert.match(
    GEMINI_ENDPOINT,
    /\/v1\/models\/gemini-3\.1-flash-lite:generateContent$/
  );
  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.equal(request.generationConfig.responseJsonSchema.type, "object");
  assert.equal(request.generationConfig.responseJsonSchema.properties.key_points.type, "array");
  assert.equal(Object.hasOwn(request.generationConfig, "responseSchema"), false);
  assert.equal(Object.hasOwn(request.generationConfig, "temperature"), false);
  assert.match(request.systemInstruction.parts[0].text, /untrusted quoted data/i);
  assert.match(
    request.contents[0].parts[0].text,
    /untrusted quoted source material/i
  );
  assert.deepEqual(SUMMARIZER_OPTIONS.expectedInputLanguages, [
    "en",
    "de",
    "es",
    "fr",
    "ja"
  ]);
});

test("on-device summarizer returns cleaned key points", async () => {
  let receivedContent = "";
  const summarizer = {
    async summarize(content, options) {
      receivedContent = content;
      assert.match(options.context, /active webpage/i);
      return "- First concrete result.\n- Second concrete result.";
    }
  };

  const result = await summarizeWithOnDevice(summarizer, {
    title: "Test",
    content: (
      "The page presents a first concrete result and a second concrete result. "
    ).repeat(30)
  });

  assert.match(receivedContent, /first concrete result/);
  assert.equal(result.provider, "on-device");
  assert.equal(result.providerLabel, ON_DEVICE_MODEL_LABEL);
  assert.equal(ON_DEVICE_MODEL_LABEL, "Gemini Nano");
  assert.deepEqual(result.points, [
    "First concrete result.",
    "Second concrete result."
  ]);
});

test("on-device streaming exposes a grounded point before completion", async () => {
  let releaseStream = null;
  const streamGate = new Promise((resolve) => {
    releaseStream = resolve;
  });
  const partials = [];
  const summarizer = {
    summarizeStreaming() {
      return new ReadableStream({
        async start(controller) {
          controller.enqueue("- First concrete result is available.");
          await streamGate;
          controller.enqueue(
            "- First concrete result is available.\n" +
            "- Second concrete result is available."
          );
          controller.close();
        }
      });
    }
  };

  const pending = summarizeWithOnDevice(summarizer, {
    title: "Streaming test",
    content: (
      "The first concrete result is available. " +
      "The second concrete result is available. "
    ).repeat(40)
  }, {
    onPartial(result) {
      partials.push(result);
      return true;
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(partials.length, 0);

  releaseStream();
  const result = await pending;
  assert.equal(partials.length, 1);
  assert.deepEqual(partials[0].points, [
    "First concrete result is available."
  ]);
  assert.equal(partials[0].streamMode, "block");
  assert.deepEqual(result.points, [
    "First concrete result is available.",
    "Second concrete result is available."
  ]);
  assert.equal(result.streamMode, "block");
});

test("streaming text exposes only complete bullets or words", () => {
  assert.equal(
    getStableStreamingText("- First point is still being written", "key-points"),
    ""
  );
  assert.equal(
    getStableStreamingText(
      "- First point is complete.\n- Second point is still being written",
      "key-points"
    ),
    "- First point is complete."
  );
  assert.equal(
    getStableStreamingText(
      "The first overview paragraph is comp",
      "tldr"
    ),
    "The first overview paragraph is"
  );
  assert.equal(
    getStableStreamingText("A headline is still being writ", "headline"),
    "A headline is still being"
  );
  assert.equal(
    getStableStreamingText("A complete teaser ", "teaser"),
    "A complete teaser"
  );
  assert.equal(
    cleanSummaryOverview("First finished paragraph.\n\nSecond finished paragraph."),
    "First finished paragraph.\n\nSecond finished paragraph."
  );
});

test("stream merging preserves repeated letters split across delta chunks", () => {
  const chunks = [
    "OpenAI CEO Sam Altman believes we have reached the singularity. " +
      "This claim follows an incident where an OpenAI AI agent hacked into",
    " Hug",
    "ging",
    " Face",
    " to",
    " solve",
    " a",
    " hacking",
    " challenge."
  ];
  const merged = chunks.reduce(
    (current, chunk) => mergeStreamingText(current, chunk),
    ""
  );

  assert.equal(
    merged,
    "OpenAI CEO Sam Altman believes we have reached the singularity. " +
      "This claim follows an incident where an OpenAI AI agent hacked into " +
      "Hugging Face to solve a hacking challenge."
  );
  assert.equal(
    mergeStreamingText(
      "OpenAI CEO Sam Altman",
      "OpenAI CEO Sam Altman described the singularity."
    ),
    "OpenAI CEO Sam Altman described the singularity."
  );
});

test("prose summaries ending mid-sentence are treated as incomplete", () => {
  assert.equal(
    isLikelyIncompleteSummary(
      "The AI agent hacked into",
      "tldr"
    ),
    true
  );
  assert.equal(
    isLikelyIncompleteSummary(
      "The AI agent hacked into another company's datasets.",
      "tldr"
    ),
    false
  );
  assert.equal(
    isLikelyIncompleteSummary("AI agent hacks rival datasets", "headline"),
    false
  );
  assert.equal(
    isLikelyIncompleteSummary("- AI agent hacked into datasets", "key-points"),
    false
  );
});

test("on-device overview streaming marks partial and final results as word mode", async () => {
  const partials = [];
  const full = "Live DOM extraction avoids a second network request.";
  const summarizer = {
    type: "tldr",
    summarizeStreaming() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue("Live DOM extr");
          controller.enqueue("Live DOM extraction avoids a second net");
          controller.enqueue(full);
          controller.close();
        }
      });
    }
  };

  const result = await summarizeWithOnDevice(summarizer, {
    title: "Live DOM extraction",
    content: `${full} ${full} ${full}`
  }, {
    summarizerOptions: { type: "tldr" },
    onPartial(partial) {
      partials.push(partial);
      return true;
    }
  });

  assert.ok(partials.length >= 1);
  assert.ok(partials.every((partial) => partial.streamMode === "word"));
  assert.equal(partials[0].overview, "Live DOM");
  assert.equal(result.overview, full);
  assert.equal(result.streamMode, "word");
});

test("on-device delta streaming keeps Hugging Face grounded across chunks", async () => {
  const expected = [
    "OpenAI CEO Sam Altman believes we have reached the singularity, a point",
    "where AI surpasses human intelligence and advances rapidly. This claim",
    "follows an incident where an OpenAI AI agent hacked into Hugging Face to",
    "solve a hacking challenge."
  ].join(" ");
  const chunks = [
    expected.slice(0, expected.indexOf(" Hugging")),
    " Hug",
    "ging",
    " Face",
    " to",
    " solve",
    " a",
    " hacking",
    " challenge."
  ];
  const summarizer = {
    type: "tldr",
    summarizeStreaming() {
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      });
    }
  };

  const result = await summarizeWithOnDevice(summarizer, {
    title: "OpenAI CEO Sam Altman says the singularity has arrived",
    siteName: "Business Insider",
    content: [
      "OpenAI CEO Sam Altman believes we have reached the singularity, a point",
      "where AI surpasses human intelligence and advances rapidly.",
      "An OpenAI AI agent hacked into Hugging Face to solve a hacking challenge."
    ].join(" ")
  }, {
    summarizerOptions: { type: "tldr" }
  });

  assert.equal(result.overview, expected);
  assert.equal(result.recoveredFromGroundedPartial, undefined);
});

test("final grounding rejection keeps the last verified streamed result", async () => {
  const partials = [];
  const supported = "The page confirms a supported concrete result.";
  const summarizer = {
    type: "tldr",
    summarizeStreaming() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(`${supported} Fab`);
          controller.enqueue(
            `${supported} FabricatedCorp announced 999 launches.`
          );
          controller.close();
        }
      });
    }
  };

  const result = await summarizeWithOnDevice(summarizer, {
    title: "Supported result",
    content: `${supported} ${supported} ${supported}`
  }, {
    summarizerOptions: { type: "tldr" },
    onPartial(partial) {
      partials.push(partial);
      return true;
    }
  });

  assert.equal(partials.length, 1);
  assert.equal(partials[0].overview, supported);
  assert.equal(result.overview, supported);
  assert.equal(result.streamMode, "word");
  assert.equal(result.recoveredFromGroundedPartial, true);
});

test("stalled Detailed stream finalizes the last verified text", async () => {
  const partials = [];
  let streamCancelled = false;
  const supported =
    "OpenAI CEO Sam Altman believes the article describes a singularity.";
  const summarizer = {
    type: "tldr",
    length: "long",
    summarizeStreaming() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(`${supported} Unfinished`);
        },
        cancel() {
          streamCancelled = true;
        }
      });
    }
  };

  const result = await summarizeWithOnDevice(summarizer, {
    title: "Sam Altman and the singularity",
    content: `${supported} ${supported} ${supported}`
  }, {
    summarizerOptions: {
      type: "tldr",
      length: "long"
    },
    streamIdleTimeoutMs: 20,
    onPartial(partial) {
      partials.push(partial);
      return true;
    }
  });

  assert.equal(streamCancelled, true);
  assert.equal(partials.length, 1);
  assert.equal(result.overview, supported);
  assert.equal(result.streamMode, "word");
  assert.equal(result.recoveredFromStalledStream, true);
  assert.equal(result.streamRecovery, "verified-partial");
  assert.equal(result.cacheable, false);
});

test("stalled Detailed stream retries once with batch summarization", async () => {
  const partials = [];
  let batchCalls = 0;
  const supported =
    "OpenAI CEO Sam Altman believes the article describes a singularity.";
  const completed = [
    supported,
    "The article also describes supported AI agent behavior."
  ].join(" ");
  const summarizer = {
    type: "tldr",
    length: "long",
    summarizeStreaming() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(`${supported} Unfinished`);
        }
      });
    },
    async summarize() {
      batchCalls += 1;
      return completed;
    }
  };

  const result = await summarizeWithOnDevice(summarizer, {
    title: "Sam Altman and the singularity",
    content: `${completed} ${completed} ${completed}`
  }, {
    summarizerOptions: {
      type: "tldr",
      length: "long"
    },
    streamIdleTimeoutMs: 20,
    batchRecoveryTimeoutMs: 100,
    onPartial(partial) {
      partials.push(partial);
      return true;
    }
  });

  assert.equal(partials.length, 1);
  assert.equal(batchCalls, 1);
  assert.equal(result.overview, completed);
  assert.equal(result.recoveredFromStalledStream, true);
  assert.equal(result.streamRecovery, "batch");
});

test("normally closed but truncated stream enters recovery", async () => {
  const partials = [];
  const supported =
    "OpenAI CEO Sam Altman believes the article describes a singularity.";
  const completed = [
    supported,
    "The article says an AI agent hacked into another company's datasets."
  ].join(" ");
  let batchCalls = 0;
  const summarizer = {
    type: "tldr",
    length: "medium",
    summarizeStreaming() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(`${supported} The AI agent hacked into `);
          controller.close();
        }
      });
    },
    async summarize() {
      batchCalls += 1;
      return completed;
    }
  };

  const result = await summarizeWithOnDevice(summarizer, {
    title: "Sam Altman and the singularity",
    content: `${completed} ${completed} ${completed}`
  }, {
    summarizerOptions: {
      type: "tldr",
      length: "medium"
    },
    onPartial(partial) {
      partials.push(partial);
      return true;
    }
  });

  assert.ok(partials.length >= 1);
  assert.equal(batchCalls, 1);
  assert.equal(result.overview, completed);
  assert.equal(result.streamRecovery, "batch");
  assert.equal(result.streamRecoveryReason, "incomplete-output");
});

test("page-specific cutoff retries from a complete source-fact outline", async () => {
  const cutoff = [
    "OpenAI CEO Sam Altman believes we have reached the singularity, a point",
    "where AI surpasses human intelligence and advances rapidly. This claim",
    "follows an incident where an OpenAI AI agent hacked into "
  ].join(" ");
  const articleContent = [
    "OpenAI's CEO says we've reached a point in the AI race that is the stuff of science fiction novels.",
    "\"We are now, like, in the singularity,\" Sam Altman said on the Relentless podcast.",
    "The singularity is often regarded as the point at which artificial intelligence surpasses human intelligence and begins advancing at a pace that is difficult for people to predict or control.",
    "That felt like the case last week when an AI agent powered by OpenAI's latest models went rogue and broke out of its digital sandbox and hacked into datasets at Hugging Face, another AI company, all to solve a benchmark designed to test hacking ability.",
    "Altman said he has been waiting for this moment his whole life and thinks it will be incredible, hugely positive, and awesome for the world.",
    "Later in the podcast, Altman criticized alternative visions painted by other AI companies as terrifying."
  ].join(" ");
  const completed = [
    "OpenAI's CEO says we've reached a point in the AI race that is the stuff",
    "of science fiction novels. Altman said he has been waiting for this",
    "moment his whole life and thinks it will be incredible, hugely positive,",
    "and awesome for the world."
  ].join(" ");
  let recoveryInput = "";
  let recoveryContext = "";
  const summarizer = {
    type: "tldr",
    length: "long",
    summarizeStreaming() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(cutoff);
        }
      });
    },
    async summarize(input, options) {
      recoveryInput = input;
      recoveryContext = options.context;
      return input === articleContent ? cutoff : completed;
    }
  };

  const result = await summarizeWithOnDevice(summarizer, {
    title: "OpenAI CEO Sam Altman says the singularity has arrived",
    siteName: "Business Insider",
    content: articleContent
  }, {
    summarizerOptions: {
      type: "tldr",
      format: "markdown",
      length: "long"
    },
    streamIdleTimeoutMs: 20,
    batchRecoveryTimeoutMs: 100
  });

  const outline = createRecoverySummaryInput(articleContent);
  assert.equal(recoveryInput, outline);
  assert.notEqual(recoveryInput, articleContent);
  assert.match(recoveryInput, /^-\s/m);
  assert.match(
    recoveryInput,
    /hacked into datasets at Hugging Face, another AI company, all to solve a benchmark designed to test hacking ability\./
  );
  assert.match(recoveryContext, /Start over from the source-fact outline/);
  assert.match(recoveryContext, /finish every sentence/);
  assert.equal(result.overview, completed);
  assert.equal(result.streamRecovery, "batch");
});

test("speed preference packs long input without an extra usage pass", async () => {
  const source = [
    `Opening evidence ${"alpha ".repeat(1200)}`,
    `Middle evidence ${"beta ".repeat(1000)}`,
    `Final conclusion ${"omega ".repeat(1000)}`
  ].join("\n\n");
  let measured = 0;
  let receivedContent = "";
  const summarizer = {
    inputQuota: 4096,
    async measureInputUsage() {
      measured += 1;
      return 1000;
    },
    async summarize(content) {
      receivedContent = content;
      return "- Final conclusion uses omega evidence.";
    }
  };

  await summarizeWithOnDevice(summarizer, {
    title: "Fast input",
    content: source
  }, {
    summarizerOptions: {
      preference: "speed"
    }
  });

  assert.equal(measured, 0);
  assert.ok(receivedContent.length <= FAST_SUMMARY_INPUT_CHARS);
  assert.match(receivedContent, /^Opening evidence/);
  assert.match(receivedContent, /beta/);
  assert.match(receivedContent, /Final conclusion/);
});

test("Summarizer settings normalize API values and isolate cache variants", () => {
  const configured = normalizeSummarizerOptions({
    type: "tldr",
    format: "markdown",
    length: "long",
    preference: "capability",
    outputLanguage: "fr",
    sharedContext: " Focus on decisions. "
  });

  assert.equal(configured.type, "tldr");
  assert.equal(configured.format, "markdown");
  assert.equal(configured.length, "long");
  assert.equal(configured.preference, "capability");
  assert.equal(configured.outputLanguage, "fr");
  assert.equal(configured.sharedContext, "Focus on decisions.");
  assert.equal(createSummarizerCacheVariant(SUMMARIZER_OPTIONS), "");
  assert.notEqual(createSummarizerCacheVariant(configured), "");
  assert.deepEqual(
    normalizeSummarizerOptions({ type: "unsupported", length: "huge" }),
    normalizeSummarizerOptions()
  );
  assert.deepEqual(
    createStableFallbackSummarizerOptions({
      type: "tldr",
      format: "markdown",
      length: "medium",
      outputLanguage: "fr"
    }),
    normalizeSummarizerOptions({
      type: "tldr",
      format: "plain-text",
      length: "medium",
      outputLanguage: "fr"
    })
  );
  assert.deepEqual(
    createStableFallbackSummarizerOptions({
      type: "tldr",
      format: "markdown",
      length: "long"
    }),
    normalizeSummarizerOptions({
      type: "tldr",
      format: "plain-text",
      length: "medium"
    })
  );
});

test("on-device non-list styles return a summary overview", async () => {
  const summarizer = {
    type: "tldr",
    length: "short",
    async summarize() {
      return "**Acme** released the supported Atlas reader.";
    }
  };
  const result = await summarizeWithOnDevice(summarizer, {
    title: "Acme releases Atlas",
    language: "en",
    content: "Acme released the supported Atlas reader for customers. ".repeat(20)
  }, {
    summarizerOptions: {
      type: "tldr",
      format: "markdown",
      length: "short"
    }
  });

  assert.equal(result.overview, "Acme released the supported Atlas reader.");
  assert.deepEqual(result.points, []);
});

test("on-device creation receives the selected Summarizer API configuration", async () => {
  let received = null;
  const root = {
    Summarizer: {
      async availability() {
        return "available";
      },
      create(options) {
        received = options;
        return { destroy() {} };
      }
    }
  };

  await createOnDeviceSummarizer({
    root,
    summarizerOptions: {
      type: "headline",
      format: "plain-text",
      length: "long",
      preference: "auto",
      outputLanguage: "ja",
      sharedContext: "Focus on the main decision."
    }
  });

  assert.equal(received.type, "headline");
  assert.equal(received.length, "long");
  assert.equal(received.preference, "auto");
  assert.equal(received.outputLanguage, "ja");
  assert.equal(received.sharedContext, "Focus on the main decision.");
});

test("on-device quota compaction retains opening, middle, and conclusion evidence", async () => {
  const source = [
    `Opening evidence ${"alpha ".repeat(900)}`,
    `Middle evidence ${"beta ".repeat(700)}`,
    `Final conclusion ${"omega ".repeat(700)}`
  ].join("\n\n");
  let receivedContent = "";
  const summarizer = {
    inputQuota: 1500,
    async measureInputUsage(content) {
      return content.length;
    },
    async summarize(content) {
      receivedContent = content;
      return "- Final conclusion uses omega evidence.";
    }
  };

  const result = await summarizeWithOnDevice(summarizer, {
    title: "Quota test",
    content: source
  });

  assert.ok(receivedContent.length < source.length);
  assert.match(receivedContent, /^Opening evidence/);
  assert.match(receivedContent, /beta/);
  assert.match(receivedContent, /Final conclusion/);
  assert.deepEqual(result.points, ["Final conclusion uses omega evidence."]);
});

test("balanced compaction never reduces long input to a prefix only", () => {
  const compacted = compactSummaryInput(
    `Opening ${"a".repeat(8000)}\n\nConclusion ${"z".repeat(4000)}`,
    3000
  );
  assert.ok(compacted.length <= 3000);
  assert.match(compacted, /^Opening/);
  assert.match(compacted, /Conclusion/);
});

test("grounding keeps supported claims and removes invented names or numbers", () => {
  const grounded = groundSummaryResult({
    overview: "Acme launched Atlas in Paris for $49.",
    points: [
      "Atlas costs $49 and launched in Paris.",
      "Zephyrix will ship 900 units next week."
    ],
    provider: "gemini"
  }, {
    title: "Acme launches Atlas",
    content: "Acme launched the Atlas reader in Paris. The reader costs $49."
  });

  assert.equal(grounded.overview, "Acme launched Atlas in Paris for $49.");
  assert.deepEqual(grounded.points, [
    "Atlas costs $49 and launched in Paris."
  ]);
});

test("grounding rejects a response when no supported claim survives", () => {
  assert.throws(
    () => groundSummaryResult({
      overview: "Zephyrix shipped 900 spacecraft.",
      points: ["The invented release costs $999."]
    }, {
      title: "Local weather",
      content: "The page reports rain and cool temperatures."
    }),
    (error) => error.code === "ungrounded-response"
  );
});

test("Gemini retry hints parse headers and provider RetryInfo", () => {
  const now = Date.parse("2026-07-26T12:00:00Z");
  assert.equal(parseGeminiRetryDelayMs("2.5s", now), 2500);
  assert.equal(
    parseGeminiRetryDelayMs("Sun, 26 Jul 2026 12:00:04 GMT", now),
    4000
  );
  const delay = getGeminiRetryAfterMs({
    headers: {
      get(name) {
        return name === "retry-after" ? "2" : "";
      }
    }
  }, {
    error: {
      details: [{
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        retryDelay: "3.5s"
      }]
    }
  }, now);
  assert.equal(delay, 3500);
  assert.equal(getGeminiRetryDelayMs(0, 12000, () => 0.5), 12000);
});

test("asynchronous user-activation failures retain an actionable error code", async () => {
  const root = {
    Summarizer: {
      async availability() {
        return "available";
      },
      create() {
        return Promise.reject(new DOMException(
          "User activation is required",
          "NotAllowedError"
        ));
      }
    }
  };

  await assert.rejects(
    createOnDeviceSummarizer({ root }),
    (error) => error.code === "local-activation-required"
  );
});

test("Gemini fallback keeps the key out of the URL and parses JSON output", async () => {
  const calls = [];
  const result = await summarizeWithGemini({
    title: "A page",
    siteName: "Example",
    url: "https://example.com",
    content: (
      "The page explains a useful result. " +
      "The first result is supported. The second result is supported. "
    ).repeat(20)
  }, "AIza-test-key-that-is-long-enough", null, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    overview: "The page explains a useful result.",
                    key_points: [
                      "The first result is supported.",
                      "The second result is supported."
                    ]
                  })
                }]
              }
            }]
          };
        }
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].url, /AIza/);
  assert.equal(
    calls[0].options.headers["x-goog-api-key"],
    "AIza-test-key-that-is-long-enough"
  );
  assert.doesNotMatch(calls[0].options.body, /AIza-test/);
  assert.equal(result.provider, "gemini");
  assert.equal(result.points.length, 2);
});
