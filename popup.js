(function initSkimmerPopup() {
  "use strict";

  const AI = globalThis.SkimmerAI;
  const Cache = globalThis.SkimmerCache;
  const ON_DEVICE_MODEL_LABEL = AI.ON_DEVICE_MODEL_LABEL;
  const GEMINI_API_KEY_STORAGE_KEY = "skimmerGeminiApiKey";
  const SUMMARIZER_SETTINGS_STORAGE_KEY = "skimmerSummarizerSettingsV1";
  const MIN_READABLE_CHARS = 160;
  const TOAST_DURATION_MS = 2300;

  class SkimmerError extends Error {
    constructor(code, message, cause = null) {
      super(message);
      this.name = "SkimmerError";
      this.code = code;
      if (cause) this.cause = cause;
    }
  }

  function getHostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "");
    } catch (error) {
      return "";
    }
  }

  function isInjectableUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      const host = parsed.hostname.toLocaleLowerCase("en");
      return !(
        host === "chromewebstore.google.com" ||
        (host === "chrome.google.com" && parsed.pathname.startsWith("/webstore"))
      );
    } catch (error) {
      return false;
    }
  }

  function isLikelyNativePdfUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      let pathname = parsed.pathname;
      try {
        pathname = decodeURIComponent(pathname);
      } catch (error) {}
      return /\.pdf(?:$|\/)/i.test(pathname);
    } catch (error) {
      return false;
    }
  }

  function setInert(element, inert) {
    if (!element) return;
    element.inert = inert;
    if (inert) {
      element.setAttribute("inert", "");
    } else {
      element.removeAttribute("inert");
    }
  }

  function isAbortError(error) {
    return Boolean(error && error.name === "AbortError");
  }

  function getProviderDisplayLabel(result, fallback = "AI summary") {
    if (
      result &&
      (
        result.provider === "on-device" ||
        result.model === "chrome-summarizer"
      )
    ) {
      return ON_DEVICE_MODEL_LABEL;
    }
    return result && result.providerLabel || fallback;
  }

  class SkimmerController {
    constructor(documentNode) {
      this.document = documentNode;
      this.el = {
        popup: documentNode.getElementById("popup"),
        header: documentNode.getElementById("header"),
        mainView: documentNode.getElementById("mainView"),
        settingsView: documentNode.getElementById("settingsView"),
        settingsNav: documentNode.getElementById("settingsNav"),
        btnRefresh: documentNode.getElementById("btnRefresh"),
        btnCopy: documentNode.getElementById("btnCopy"),
        btnSettings: documentNode.getElementById("btnSettings"),
        settingsBack: documentNode.getElementById("settingsBack"),
        pageTitle: documentNode.getElementById("pageTitle"),
        pageSite: documentNode.getElementById("pageSite"),
        pageFavicon: documentNode.getElementById("pageFavicon"),
        pageFaviconFallback: documentNode.getElementById("pageFaviconFallback"),
        pageStatusBadge: documentNode.getElementById("pageStatusBadge"),
        pageStatusText: documentNode.getElementById("pageStatusText"),
        providerBadge: documentNode.getElementById("providerBadge"),
        summaryLoading: documentNode.getElementById("summaryLoading"),
        downloadProgress: documentNode.getElementById("downloadProgress"),
        downloadProgressBar: documentNode.getElementById("downloadProgressBar"),
        downloadProgressText: documentNode.getElementById("downloadProgressText"),
        summaryReady: documentNode.getElementById("summaryReady"),
        summaryReadyAnnouncement: documentNode.getElementById(
          "summaryReadyAnnouncement"
        ),
        summaryOverview: documentNode.getElementById("summaryOverview"),
        summaryPoints: documentNode.getElementById("summaryPoints"),
        summaryNextPlaceholder: documentNode.getElementById(
          "summaryNextPlaceholder"
        ),
        summaryError: documentNode.getElementById("summaryError"),
        summaryErrorAnnouncement: documentNode.getElementById(
          "summaryErrorAnnouncement"
        ),
        errorTitle: documentNode.getElementById("errorTitle"),
        errorText: documentNode.getElementById("errorText"),
        btnRetry: documentNode.getElementById("btnRetry"),
        btnErrorSettings: documentNode.getElementById("btnErrorSettings"),
        readingTime: documentNode.getElementById("readingTime"),
        extractionMethod: documentNode.getElementById("extractionMethod"),
        summarizerType: documentNode.getElementById("summarizerType"),
        summarizerLength: documentNode.getElementById("summarizerLength"),
        summarizerPreference: documentNode.getElementById("summarizerPreference"),
        summarizerFormat: documentNode.getElementById("summarizerFormat"),
        summarizerLanguage: documentNode.getElementById("summarizerLanguage"),
        summarizerContext: documentNode.getElementById("summarizerContext"),
        summarizerSettingsStatus: documentNode.getElementById(
          "summarizerSettingsStatus"
        ),
        btnResetSummarizer: documentNode.getElementById("btnResetSummarizer"),
        geminiKeyInput: documentNode.getElementById("geminiKeyInput"),
        btnSaveKey: documentNode.getElementById("btnSaveKey"),
        geminiKeyStatus: documentNode.getElementById("geminiKeyStatus"),
        btnRemoveKey: documentNode.getElementById("btnRemoveKey"),
        btnClearCache: documentNode.getElementById("btnClearCache"),
        cacheStatus: documentNode.getElementById("cacheStatus"),
        toast: documentNode.getElementById("toast"),
        toastText: documentNode.getElementById("toastText")
      };

      this.activeTab = null;
      this.currentArticle = null;
      this.latestResult = null;
      this.requestId = 0;
      this.requestController = null;
      this.localSession = null;
      this.localSessionPromise = null;
      this.localSessionGeneration = 0;
      this.localError = null;
      this.toastTimer = null;
      this.settingsOpen = false;
      this.cacheRevision = 0;
      this.cacheMutationQueue = Promise.resolve();
      this.keySavePromise = null;
      this.summarizerSettingsDirty = false;
      this.summaryTiming = null;
      this.partialSignature = "";
      this.activeStreamMode = null;
      this.summarizerOptions = AI &&
        typeof AI.normalizeSummarizerOptions === "function"
        ? AI.normalizeSummarizerOptions(this.loadSummarizerSettings())
        : null;
    }

    init() {
      if (!AI || !Cache) {
        this.renderError(new SkimmerError(
          "startup-failed",
          "Skimmer's local modules did not load."
        ));
        return;
      }

      this.bindEvents();
      this.renderSummarizerSettings();
      // Keep this call before any await so Chrome can use the toolbar click if
      // creating the session needs to start a model download.
      this.ensureLocalSession();
      void this.refreshSettings();
      void this.runSummary({ force: false });
    }

    bindEvents() {
      this.el.btnRefresh.addEventListener("click", () => {
        this.ensureLocalSession();
        void this.runSummary({ force: true });
      });
      this.el.btnRetry.addEventListener("click", () => {
        this.ensureLocalSession();
        void this.runSummary({ force: true });
      });
      this.el.btnCopy.addEventListener("click", () => {
        void this.copySummary();
      });
      this.el.btnSettings.addEventListener("click", () => {
        this.openSettings();
      });
      this.el.settingsBack.addEventListener("click", () => {
        this.closeSettings();
      });
      this.el.btnErrorSettings.addEventListener("click", () => {
        this.openSettings();
      });
      for (const control of [
        this.el.summarizerType,
        this.el.summarizerLength,
        this.el.summarizerPreference,
        this.el.summarizerFormat,
        this.el.summarizerLanguage,
        this.el.summarizerContext
      ]) {
        control.addEventListener("change", () => {
          this.updateSummarizerSettingsFromControls();
        });
      }
      this.el.btnResetSummarizer.addEventListener("click", () => {
        this.resetSummarizerSettings();
      });
      this.el.btnSaveKey.addEventListener("click", () => {
        void this.saveGeminiKey();
      });
      this.el.geminiKeyInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.saveGeminiKey();
        }
      });
      this.el.geminiKeyInput.addEventListener("input", () => {
        if (this.el.geminiKeyInput.getAttribute("aria-invalid") === "true") {
          this.el.geminiKeyInput.setAttribute("aria-invalid", "false");
        }
      });
      this.el.btnRemoveKey.addEventListener("click", () => {
        void this.removeGeminiKey();
      });
      this.el.btnClearCache.addEventListener("click", () => {
        void this.clearCache();
      });
      this.document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.settingsOpen) {
          event.preventDefault();
          this.closeSettings();
        }
      });
      globalThis.addEventListener("unload", () => {
        if (this.requestController) this.requestController.abort();
        AI.destroyOnDeviceSummarizer(this.localSession);
      }, { once: true });
    }

    ensureLocalSession() {
      if (this.localSession) return Promise.resolve(this.localSession);
      if (this.localSessionPromise) return this.localSessionPromise;

      const api = AI.getSummarizerApi(globalThis);
      if (!api) {
        this.localError = AI.createAiError(
          "local-unsupported",
          "Chrome's on-device Summarizer API is not supported."
        );
        return null;
      }

      const generation = this.localSessionGeneration;
      this.localError = null;
      let creationPromise = null;
      creationPromise = AI.createOnDeviceSummarizer({
        summarizerOptions: this.summarizerOptions,
        onDownloadProgress: (progress) => {
          if (generation === this.localSessionGeneration) {
            this.renderModelDownload(progress);
          }
        }
      }).then((session) => {
        if (generation !== this.localSessionGeneration) {
          AI.destroyOnDeviceSummarizer(session);
          return null;
        }
        this.localSession = session;
        this.markSummaryTiming("sessionReadyMs");
        this.hideModelDownload();
        return session;
      }).catch((error) => {
        if (generation !== this.localSessionGeneration) return null;
        this.localError = error;
        this.hideModelDownload();
        return null;
      }).finally(() => {
        if (this.localSessionPromise === creationPromise) {
          this.localSessionPromise = null;
        }
      });
      this.localSessionPromise = creationPromise;
      return creationPromise;
    }

    renderModelDownload(progress) {
      const percentage = Math.round(Math.max(0, Math.min(1, progress)) * 100);
      this.el.downloadProgress.hidden = false;
      this.el.downloadProgressBar.style.width = `${percentage}%`;
      this.el.downloadProgressText.textContent = percentage > 0
        ? `Downloading on-device model… ${percentage}%`
        : "Downloading on-device model…";
      if (!this.el.summaryLoading.hidden) {
        this.setSummarizingProviderBadge(ON_DEVICE_MODEL_LABEL);
      }
    }

    hideModelDownload() {
      this.el.downloadProgress.hidden = true;
      this.el.downloadProgressBar.style.width = "0%";
    }

    async captureActiveTab() {
      if (
        typeof chrome === "undefined" ||
        !chrome.tabs ||
        typeof chrome.tabs.query !== "function"
      ) {
        throw new SkimmerError(
          "not-installed",
          "Open Skimmer from Chrome's extension toolbar."
        );
      }
      const tabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
      });
      const tab = Array.isArray(tabs) ? tabs[0] : null;
      if (!tab || !Number.isInteger(tab.id)) {
        throw new SkimmerError("no-active-tab", "No focused browser tab was found.");
      }
      if (!isInjectableUrl(tab.url || "")) {
        throw new SkimmerError(
          "protected-page",
          "Chrome does not allow extensions to read this kind of page."
        );
      }
      return tab;
    }

    async extractActivePage(tab) {
      if (
        !chrome.scripting ||
        typeof chrome.scripting.executeScript !== "function"
      ) {
        throw new SkimmerError(
          "scripting-unavailable",
          "Chrome's page extraction API is unavailable."
        );
      }

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["vendor/readability.js", "page-extractor.js"]
        });
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            try {
              const extractor = globalThis.SkimmerPageExtractor;
              if (!extractor || typeof extractor.extract !== "function") {
                return {
                  ok: false,
                  code: "extractor-unavailable",
                  message: "The page extractor did not initialize."
                };
              }
              return {
                ok: true,
                article: extractor.extract(document)
              };
            } catch (error) {
              return {
                ok: false,
                code: "extractor-failed",
                message: error && error.message
                  ? String(error.message).slice(0, 300)
                  : "The page extractor failed."
              };
            }
          }
        });
        const payload = Array.isArray(results) && results[0]
          ? results[0].result
          : null;
        if (!payload || payload.ok !== true) {
          throw new SkimmerError(
            payload && payload.code || "extractor-failed",
            payload && payload.message || "Skimmer could not read this page."
          );
        }
        return payload.article;
      } catch (error) {
        if (error instanceof SkimmerError) throw error;
        throw new SkimmerError(
          "page-access-failed",
          "The page changed or Chrome blocked access. Open Skimmer again on the page.",
          error
        );
      }
    }

    async runSummary({ force }) {
      const requestId = ++this.requestId;
      this.summaryTiming = {
        requestId,
        startedMs: this.getPopupElapsedMs(),
        firstVisibleMs: null,
        firstVisibleSource: "",
        nativeFirstVisibleMs: null,
        completedMs: null
      };
      this.partialSignature = "";
      this.clearPerformanceDataset();
      const cacheRevision = this.cacheRevision;
      if (this.requestController) this.requestController.abort();
      const controller = new AbortController();
      this.requestController = controller;
      this.currentArticle = null;
      this.latestResult = null;
      this.el.btnCopy.disabled = true;
      this.renderLoading(ON_DEVICE_MODEL_LABEL);

      try {
        const tab = await this.captureActiveTab();
        if (requestId !== this.requestId) return;
        this.markSummaryTiming("tabReadyMs");
        this.activeTab = tab;
        this.renderTab(tab);
        if (isLikelyNativePdfUrl(tab.url || "")) {
          throw new SkimmerError(
            "native-pdf-viewer",
            "Chrome's native PDF viewer does not expose document text to Skimmer."
          );
        }

        const article = await this.extractActivePage(tab);
        if (requestId !== this.requestId) return;
        this.markSummaryTiming("contentReadyMs");
        if (
          !article ||
          typeof article.content !== "string" ||
          article.content.trim().length < MIN_READABLE_CHARS
        ) {
          throw new SkimmerError(
            "no-readable-content",
            "Skimmer could not find enough readable text on this page."
          );
        }
        article.url = article.url || tab.url || "";
        article.title = article.title || tab.title || "Untitled page";
        article.cacheVariant = AI.createSummarizerCacheVariant(
          this.summarizerOptions
        );
        this.currentArticle = article;
        this.renderArticleMeta(article);

        if (!force && !tab.incognito) {
          const cached = await Cache.read(chrome.storage.local, article);
          if (requestId !== this.requestId) return;
          this.markSummaryTiming("cacheCheckedMs");
          const cachedIsIncomplete = Boolean(
            cached &&
            cached.provider === "on-device" &&
            AI.isLikelyIncompleteSummary(
              cached.overview,
              this.summarizerOptions.type
            )
          );
          if (
            cached &&
            !cachedIsIncomplete &&
            cacheRevision === this.cacheRevision
          ) {
            this.renderReady(cached);
            return;
          }
        }

        const result = await this.generateSummary(
          article,
          controller.signal,
          requestId
        );
        if (requestId !== this.requestId) return;
        if (!tab.incognito && result.cacheable !== false) {
          try {
            await this.writeCacheIfCurrent(
              article,
              result,
              cacheRevision,
              requestId
            );
          } catch (error) {
            // A storage failure must not hide a valid generated summary.
          }
          if (requestId !== this.requestId) return;
        }
        this.renderReady(result);
      } catch (error) {
        if (requestId !== this.requestId || isAbortError(error)) return;
        this.renderError(error);
      }
    }

    async generateSummary(article, signal, requestId) {
      let session = this.localSession;
      if (!session && this.localSessionPromise) {
        if (!this.hasVisibleSummary()) {
          this.renderLoading(ON_DEVICE_MODEL_LABEL);
        }
        session = await this.localSessionPromise;
      }

      if (session) {
        this.markSummaryTiming("sessionReadyMs");
        this.markSummaryTiming("generationStartedMs");
        if (!this.hasVisibleSummary()) {
          this.renderLoading(ON_DEVICE_MODEL_LABEL);
        }
        try {
          const result = await AI.summarizeWithOnDevice(session, article, {
            signal,
            summarizerOptions: this.summarizerOptions,
            onPartial: (partialResult) => {
              if (
                requestId !== this.requestId ||
                (signal && signal.aborted)
              ) {
                return false;
              }
              return this.renderPartial(partialResult);
            },
            onRecovery: () => {
              if (
                requestId === this.requestId &&
                !(signal && signal.aborted)
              ) {
                this.setSummarizingProviderBadge(ON_DEVICE_MODEL_LABEL);
                this.el.summaryReadyAnnouncement.textContent =
                  "Finishing the summary.";
              }
            }
          });
          if (
            result &&
            result.streamRecovery === "verified-partial"
          ) {
            const compatibleResult =
              await this.generateCompatibleOnDeviceSummary(
                article,
                signal,
                requestId
              );
            if (compatibleResult) return compatibleResult;
          }
          return result;
        } catch (error) {
          if (isAbortError(error)) throw error;
          this.localError = error;
        }
      }

      const key = await this.loadGeminiKey();
      if (key) {
        const allowed = await this.hasGeminiPermission();
        if (!allowed) {
          throw new SkimmerError(
            "gemini-permission-missing",
            "Open Settings and save the Gemini key again to approve fallback access."
          );
        }
        if (!this.hasVisibleSummary()) {
          this.renderLoading(AI.GEMINI_MODEL_LABEL);
        }
        return AI.summarizeWithGemini(article, key, signal);
      }

      if (
        this.localError &&
        this.localError.code === "local-activation-required"
      ) {
        throw this.localError;
      }
      if (
        this.localError &&
        this.localError.code === "ungrounded-response"
      ) {
        throw this.localError;
      }
      throw new SkimmerError(
        "ai-setup-required",
        "On-device AI is unavailable and no Gemini fallback key is saved.",
        this.localError
      );
    }

    async generateCompatibleOnDeviceSummary(article, signal, requestId) {
      const compatibleOptions = AI.createStableFallbackSummarizerOptions(
        this.summarizerOptions
      );
      if (
        AI.createSummarizerCacheVariant(compatibleOptions) ===
        AI.createSummarizerCacheVariant(this.summarizerOptions)
      ) {
        return null;
      }

      let compatibleSession = null;
      try {
        this.setSummarizingProviderBadge(ON_DEVICE_MODEL_LABEL);
        this.el.summaryReadyAnnouncement.textContent =
          "Retrying with compatible settings.";
        compatibleSession = await AI.createOnDeviceSummarizer({
          summarizerOptions: compatibleOptions
        });
        if (
          requestId !== this.requestId ||
          (signal && signal.aborted)
        ) {
          return null;
        }
        const result = await AI.summarizeWithOnDevice(
          compatibleSession,
          article,
          {
            signal,
            summarizerOptions: compatibleOptions
          }
        );
        if (
          requestId !== this.requestId ||
          (signal && signal.aborted) ||
          result.streamRecovery === "verified-partial"
        ) {
          return null;
        }
        return {
          ...result,
          recoveredWithCompatibleOptions: true
        };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return null;
      } finally {
        AI.destroyOnDeviceSummarizer(compatibleSession);
      }
    }

    renderTab(tab) {
      this.el.pageTitle.textContent = tab.title || "Untitled page";
      this.el.pageSite.textContent = getHostname(tab.url) || "Current page";
      this.setPageStatus("Active", "active");

      const favicon = typeof tab.favIconUrl === "string" ? tab.favIconUrl : "";
      if (!favicon) {
        this.el.pageFavicon.hidden = true;
        this.el.pageFaviconFallback.hidden = false;
        return;
      }

      this.el.pageFavicon.onload = () => {
        this.el.pageFavicon.hidden = false;
        this.el.pageFaviconFallback.hidden = true;
      };
      this.el.pageFavicon.onerror = () => {
        this.el.pageFavicon.hidden = true;
        this.el.pageFaviconFallback.hidden = false;
      };
      this.el.pageFavicon.src = favicon;
    }

    setPageStatus(label, state = "active") {
      this.el.pageStatusText.textContent = label;
      this.el.pageStatusBadge.dataset.state = state;
    }

    renderArticleMeta(article) {
      const readingTime = Number(article.readingMinutes) || 0;
      this.el.readingTime.textContent = readingTime > 0
        ? `${readingTime} min read`
        : "Live page";
      const labels = {
        "json-ld": "Structured article",
        "structured-data": "Structured article",
        "mozilla-readability": "Reader view",
        "dom-fallback": "Rendered page",
        metadata: "Page description"
      };
      this.el.extractionMethod.textContent = labels[article.parser] ||
        "Live content";
    }

    setProviderBadge(label) {
      this.el.providerBadge.replaceChildren(String(label));
      this.el.providerBadge.removeAttribute("aria-label");
    }

    setSummarizingProviderBadge(label) {
      const text = `${label} · Summarizing`;
      const summarizingLabel = this.document.createElement("span");
      summarizingLabel.className = "provider-badge-summarizing";
      const dots = this.document.createElement("span");
      dots.className = "provider-badge-dots";
      dots.setAttribute("aria-hidden", "true");
      for (let index = 0; index < 3; index += 1) {
        const dot = this.document.createElement("span");
        dot.textContent = ".";
        dots.append(dot);
      }
      summarizingLabel.replaceChildren(
        this.document.createTextNode(text),
        dots
      );
      this.el.providerBadge.replaceChildren(summarizingLabel);
      this.el.providerBadge.setAttribute("aria-label", text);
    }

    renderLoading(provider) {
      this.el.summaryReadyAnnouncement.textContent = "";
      this.el.summaryErrorAnnouncement.textContent = "";
      this.el.summaryLoading.hidden = false;
      this.el.summaryReady.hidden = true;
      this.el.summaryError.hidden = true;
      this.el.summaryOverview.replaceChildren();
      this.el.summaryOverview.hidden = true;
      this.el.summaryPoints.replaceChildren();
      this.el.summaryNextPlaceholder.hidden = true;
      this.activeStreamMode = null;
      this.setSummarizingProviderBadge(provider);
      this.el.providerBadge.removeAttribute("title");
    }

    getPopupElapsedMs() {
      return typeof performance !== "undefined" &&
        typeof performance.now === "function"
        ? Math.max(0, performance.now())
        : 0;
    }

    hasVisibleSummary() {
      return Boolean(
        this.summaryTiming &&
        this.summaryTiming.requestId === this.requestId &&
        this.summaryTiming.firstVisibleMs != null
      );
    }

    clearPerformanceDataset() {
      const root = this.document.documentElement;
      delete root.dataset.summaryFirstVisibleMs;
      delete root.dataset.summaryNativeFirstVisibleMs;
      delete root.dataset.summaryCompleteMs;
      delete root.dataset.summarySource;
      delete root.dataset.summaryFinalSource;
    }

    markSummaryTiming(name) {
      if (!this.summaryTiming || this.summaryTiming.requestId !== this.requestId) {
        return null;
      }
      const elapsed = Math.round(this.getPopupElapsedMs());
      if (this.summaryTiming[name] == null) this.summaryTiming[name] = elapsed;
      return this.summaryTiming[name];
    }

    markSummaryVisible(source) {
      const isFirst = this.summaryTiming &&
        this.summaryTiming.firstVisibleMs == null;
      const elapsed = this.markSummaryTiming("firstVisibleMs");
      if (elapsed == null) return null;
      if (isFirst) {
        this.summaryTiming.firstVisibleSource = source;
        const root = this.document.documentElement;
        root.dataset.summaryFirstVisibleMs = String(elapsed);
        root.dataset.summarySource = source;
      }
      return elapsed;
    }

    markNativeSummaryVisible() {
      const elapsed = this.markSummaryTiming("nativeFirstVisibleMs");
      if (elapsed == null) return null;
      this.document.documentElement.dataset.summaryNativeFirstVisibleMs =
        String(elapsed);
      return elapsed;
    }

    markSummaryComplete(source) {
      const elapsed = this.markSummaryTiming("completedMs");
      if (elapsed == null) return;
      const root = this.document.documentElement;
      root.dataset.summaryCompleteMs = String(elapsed);
      root.dataset.summaryFinalSource = source;
      const firstVisible = this.summaryTiming.firstVisibleMs;
      const nativeFirstVisible = this.summaryTiming.nativeFirstVisibleMs;
      const timingParts = firstVisible == null
        ? []
        : [`First summary text: ${firstVisible} ms`];
      if (
        nativeFirstVisible != null &&
        (
          firstVisible == null ||
          Math.abs(nativeFirstVisible - firstVisible) > 2
        )
      ) {
        timingParts.push(`native AI: ${nativeFirstVisible} ms`);
      }
      timingParts.push(`complete: ${elapsed} ms`);
      this.el.providerBadge.title =
        `${timingParts.join("; ")} after the popup opened.`;
      if (typeof console !== "undefined" && typeof console.info === "function") {
        console.info("[Skimmer timing]", {
          ...this.summaryTiming,
          source
        });
      }
    }

    syncSummaryBlocks(container, values, tagName, animateNew) {
      const existing = Array.from(container.children);
      let commonLength = 0;
      while (
        commonLength < existing.length &&
        commonLength < values.length &&
        existing[commonLength].textContent === values[commonLength]
      ) {
        commonLength += 1;
      }
      for (let index = existing.length - 1; index >= commonLength; index -= 1) {
        existing[index].remove();
      }
      for (let index = commonLength; index < values.length; index += 1) {
        const block = this.document.createElement(tagName);
        block.textContent = values[index];
        if (animateNew) block.classList.add("summary-block-reveal");
        container.append(block);
      }
    }

    renderSummaryContent(overview, points, { animateNew }) {
      const paragraphs = overview
        ? overview.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
        : [];
      this.syncSummaryBlocks(
        this.el.summaryOverview,
        paragraphs,
        "p",
        animateNew
      );
      this.el.summaryOverview.hidden = paragraphs.length === 0;
      this.syncSummaryBlocks(
        this.el.summaryPoints,
        points,
        "li",
        animateNew
      );
    }

    appendSummaryWords(paragraph, targetText) {
      let renderedText = paragraph.hasAttribute("data-stream-text")
        ? paragraph.dataset.streamText || ""
        : paragraph.textContent || "";

      if (!targetText.startsWith(renderedText)) {
        paragraph.replaceChildren();
        renderedText = "";
      }
      paragraph.dataset.streamText = renderedText;
      if (targetText === renderedText) return;

      const newWords = targetText
        .slice(renderedText.length)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (let index = 0; index < newWords.length; index += 1) {
        if (paragraph.textContent) {
          paragraph.append(this.document.createTextNode(" "));
        }
        const word = this.document.createElement("span");
        word.className = "summary-word-enter";
        word.style.animationDelay = `${Math.min(index * 30, 210)}ms`;
        word.textContent = newWords[index];
        paragraph.append(word);
      }
      paragraph.dataset.streamText = targetText;
    }

    renderWordStream(overview) {
      const paragraphs = overview
        ? overview.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
        : [];
      const existing = Array.from(this.el.summaryOverview.children);
      for (let index = 0; index < paragraphs.length; index += 1) {
        let block = existing[index];
        if (!block) {
          block = this.document.createElement("p");
          this.el.summaryOverview.append(block);
        }
        block.classList.remove("summary-block-reveal");
        this.appendSummaryWords(block, paragraphs[index]);
      }
      for (let index = existing.length - 1; index >= paragraphs.length; index -= 1) {
        existing[index].remove();
      }
      this.el.summaryOverview.hidden = paragraphs.length === 0;
      this.el.summaryPoints.replaceChildren();
    }

    showNextBlockPlaceholder(kind) {
      this.el.summaryNextPlaceholder.dataset.kind =
        kind === "paragraph" ? "paragraph" : "point";
      this.el.summaryNextPlaceholder.hidden = false;
    }

    renderPartial(result) {
      const overview = typeof result.overview === "string"
        ? result.overview.trim()
        : "";
      const points = Array.isArray(result.points)
        ? result.points.filter((point) => typeof point === "string" && point.trim())
        : [];
      if (!overview && points.length === 0) return false;

      const streamMode = (
        result.streamMode === "word" &&
        overview &&
        points.length === 0
      ) ? "word" : "block";
      const isNative = result.provider === "on-device";
      const signature = JSON.stringify([streamMode, overview, points]);
      const signatureWithProvider = JSON.stringify([
        result.provider || "",
        signature
      ]);
      if (signatureWithProvider === this.partialSignature) return true;
      this.partialSignature = signatureWithProvider;
      const firstVisible = this.summaryTiming &&
        this.summaryTiming.firstVisibleMs == null;

      this.latestResult = null;
      this.el.summaryLoading.hidden = true;
      this.el.summaryError.hidden = true;
      this.el.summaryReady.hidden = false;
      this.activeStreamMode = streamMode;
      if (streamMode === "word") {
        this.renderWordStream(overview);
        this.el.summaryNextPlaceholder.hidden = true;
      } else {
        this.renderSummaryContent(overview, points, { animateNew: true });
        this.showNextBlockPlaceholder(
          points.length > 0 ? "point" : "paragraph"
        );
      }
      this.setSummarizingProviderBadge(
        getProviderDisplayLabel(result, ON_DEVICE_MODEL_LABEL)
      );
      this.el.btnCopy.disabled = true;
      if (firstVisible) {
        this.markSummaryVisible("on-device-stream");
        this.el.summaryReadyAnnouncement.textContent = "Summary is appearing.";
      }
      if (isNative) this.markNativeSummaryVisible();
      return true;
    }

    renderReady(result) {
      const overview = typeof result.overview === "string"
        ? result.overview.trim()
        : "";
      const points = Array.isArray(result.points)
        ? result.points.filter((point) => typeof point === "string" && point.trim())
        : [];

      this.latestResult = {
        ...result,
        overview,
        points
      };
      this.el.summaryLoading.hidden = true;
      this.el.summaryError.hidden = true;
      this.el.summaryReady.hidden = false;
      const shouldFinishWordStream = (
        !result.cached &&
        overview &&
        points.length === 0 &&
        (
          result.streamMode === "word" ||
          this.activeStreamMode === "word"
        )
      );
      if (shouldFinishWordStream) {
        this.renderWordStream(overview);
      } else {
        this.renderSummaryContent(overview, points, {
          animateNew: !result.cached
        });
      }
      this.el.summaryNextPlaceholder.hidden = true;
      this.activeStreamMode = null;

      const label = getProviderDisplayLabel(result);
      this.setProviderBadge(result.cached
        ? `Cached · ${label}`
        : label);
      this.markSummaryVisible(result.cached ? "cache" : result.provider || "ai");
      if (!result.cached && result.provider === "on-device") {
        this.markNativeSummaryVisible();
      }
      this.markSummaryComplete(result.cached ? "cache" : result.provider || "ai");
      this.el.btnCopy.disabled = !overview && points.length === 0;
      this.el.summaryErrorAnnouncement.textContent = "";
      this.el.summaryReadyAnnouncement.textContent = "Summary ready.";
    }

    renderError(error) {
      const view = this.getErrorView(error);
      if (error && error.code === "protected-page") {
        this.el.pageTitle.textContent = "Protected browser page";
        this.el.pageSite.textContent = "Chrome does not expose this tab";
        this.el.readingTime.textContent = "Current tab";
        this.el.extractionMethod.textContent = "Protected page";
        this.setPageStatus("Protected", "neutral");
      } else if (error && error.code === "native-pdf-viewer") {
        this.el.readingTime.textContent = "Current tab";
        this.el.extractionMethod.textContent = "Native PDF viewer";
        this.setPageStatus("PDF", "neutral");
      }
      this.el.summaryLoading.hidden = true;
      this.el.summaryReady.hidden = true;
      this.el.summaryError.hidden = false;
      this.el.summaryNextPlaceholder.hidden = true;
      this.activeStreamMode = null;
      this.setProviderBadge(view.badge);
      this.el.errorTitle.textContent = view.title;
      this.el.errorText.textContent = view.text;
      this.el.btnRetry.textContent = view.retryLabel || "Try again";
      this.el.btnRetry.hidden = view.showRetry === false;
      this.el.btnErrorSettings.hidden = view.showSettings !== true;
      this.el.btnCopy.disabled = true;
      this.el.summaryReadyAnnouncement.textContent = "";
      this.el.summaryErrorAnnouncement.textContent =
        `${view.title}. ${view.text}`;
    }

    getErrorView(error) {
      const code = error && error.code || "";
      const fallbackText = error && error.message
        ? error.message
        : "Skimmer could not finish this summary.";
      const views = {
        "not-installed": {
          title: "Open the installed extension",
          text: fallbackText,
          badge: "Preview unavailable",
          showRetry: false
        },
        "protected-page": {
          title: "Chrome protects this page",
          text: "Open a normal website, then click Skimmer in the toolbar.",
          badge: "Page unavailable",
          showRetry: false
        },
        "native-pdf-viewer": {
          title: "Chrome's PDF viewer is not readable",
          text: "Open an HTML version of this document or copy its text into a normal webpage.",
          badge: "PDF unavailable",
          showRetry: false
        },
        "no-readable-content": {
          title: "Not enough readable text",
          text: "This page may be mostly controls, media, or an unfinished document.",
          badge: "No article found",
          retryLabel: "Read again"
        },
        "page-access-failed": {
          title: "The page changed",
          text: fallbackText,
          badge: "Access ended",
          retryLabel: "Try again"
        },
        "local-activation-required": {
          title: "Ready to skim",
          text: "Chrome needs one direct click to start or download its on-device summarizer.",
          badge: ON_DEVICE_MODEL_LABEL,
          retryLabel: "Skim now"
        },
        "ai-setup-required": {
          title: "Choose a summarizer",
          text: "Try on-device AI again, or add an optional Gemini fallback key in Settings.",
          badge: "AI unavailable",
          retryLabel: "Try on-device AI",
          showSettings: true
        },
        "gemini-permission-missing": {
          title: "Gemini access needs approval",
          text: fallbackText,
          badge: "Fallback paused",
          retryLabel: "Try on-device AI",
          showSettings: true
        },
        "gemini-key-invalid": {
          title: "Gemini rejected the saved key",
          text: "Replace the key in Settings, or retry with on-device AI.",
          badge: "Gemini error",
          retryLabel: "Try on-device AI",
          showSettings: true
        },
        "gemini-rate-limit": {
          title: "Gemini is rate-limited",
          text: fallbackText,
          badge: "Gemini busy",
          retryLabel: "Try again"
        },
        "gemini-timeout": {
          title: "Gemini took too long",
          text: fallbackText,
          badge: "Timed out",
          retryLabel: "Try again"
        },
        "gemini-network": {
          title: "Could not reach Gemini",
          text: "Check the connection, or retry with on-device AI.",
          badge: "Network error",
          retryLabel: "Try again",
          showSettings: true
        },
        "ungrounded-response": {
          title: "Could not verify this summary",
          text: "The AI response was not supported closely enough by the page. Try skimming again.",
          badge: "Grounding failed",
          retryLabel: "Skim again"
        }
      };
      return views[code] || {
        title: "This page could not be skimmed",
        text: fallbackText,
        badge: "Summary failed",
        retryLabel: "Try again"
      };
    }

    enqueueCacheMutation(mutation) {
      const nextMutation = this.cacheMutationQueue.then(mutation, mutation);
      this.cacheMutationQueue = nextMutation.catch(() => {});
      return nextMutation;
    }

    async writeCacheIfCurrent(article, result, revision, requestId) {
      const wrote = await this.enqueueCacheMutation(async () => {
        if (
          revision !== this.cacheRevision ||
          requestId !== this.requestId
        ) {
          return false;
        }
        const saved = await Cache.write(chrome.storage.local, article, result);
        return (
          revision === this.cacheRevision &&
          requestId === this.requestId &&
          saved
        );
      });
      if (
        wrote &&
        revision === this.cacheRevision &&
        requestId === this.requestId
      ) {
        void this.refreshCacheStatus(revision);
      }
      return wrote;
    }

    async copySummary() {
      if (!this.latestResult) return;
      const title = this.currentArticle && this.currentArticle.title
        ? this.currentArticle.title
        : this.activeTab && this.activeTab.title
          ? this.activeTab.title
          : "Page summary";
      const output = [
        title,
        "",
        this.latestResult.overview,
        this.latestResult.points
          .map((point) => `• ${point}`)
          .join("\n")
      ].filter((part, index, parts) => (
        part || (index === 1 && parts.some(Boolean))
      )).join("\n").trim();

      try {
        await navigator.clipboard.writeText(output);
        this.showToast("Summary copied");
      } catch (error) {
        this.showToast("Could not copy summary");
      }
    }

    loadSummarizerSettings() {
      try {
        const storage = globalThis.localStorage;
        if (!storage || typeof storage.getItem !== "function") return {};
        const raw = storage.getItem(SUMMARIZER_SETTINGS_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (error) {
        return {};
      }
    }

    saveSummarizerSettings(options) {
      try {
        const storage = globalThis.localStorage;
        if (!storage || typeof storage.setItem !== "function") return false;
        const value = {
          type: options.type,
          format: options.format,
          length: options.length,
          preference: options.preference,
          outputLanguage: options.outputLanguage,
          sharedContext: options.sharedContext || ""
        };
        storage.setItem(
          SUMMARIZER_SETTINGS_STORAGE_KEY,
          JSON.stringify(value)
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    readSummarizerSettingsControls() {
      return AI.normalizeSummarizerOptions({
        type: this.el.summarizerType.value,
        length: this.el.summarizerLength.value,
        preference: this.el.summarizerPreference.value,
        format: this.el.summarizerFormat.value,
        outputLanguage: this.el.summarizerLanguage.value,
        sharedContext: this.el.summarizerContext.value
      });
    }

    renderSummarizerSettings(options = this.summarizerOptions) {
      if (!options) return;
      this.el.summarizerType.value = options.type;
      this.el.summarizerLength.value = options.length;
      this.el.summarizerPreference.value = options.preference;
      this.el.summarizerFormat.value = options.format;
      this.el.summarizerLanguage.value = options.outputLanguage;
      this.el.summarizerContext.value = options.sharedContext || "";
      const isDefault = AI.createSummarizerCacheVariant(options) === "";
      this.setSummarizerSettingsStatus(
        isDefault
          ? "Using the recommended defaults."
          : "Custom summary settings are active.",
        isDefault ? "" : "success"
      );
    }

    setSummarizerSettingsStatus(message, state = "") {
      this.el.summarizerSettingsStatus.textContent = message;
      this.el.summarizerSettingsStatus.classList.toggle(
        "is-success",
        state === "success"
      );
      this.el.summarizerSettingsStatus.classList.toggle(
        "is-error",
        state === "error"
      );
    }

    replaceLocalSession() {
      this.localSessionGeneration += 1;
      AI.destroyOnDeviceSummarizer(this.localSession);
      this.localSession = null;
      this.localSessionPromise = null;
      this.localError = null;
      this.hideModelDownload();
    }

    applySummarizerSettings(options) {
      const normalized = AI.normalizeSummarizerOptions(options);
      const previousVariant = AI.createSummarizerCacheVariant(
        this.summarizerOptions
      );
      const nextVariant = AI.createSummarizerCacheVariant(normalized);
      this.summarizerOptions = normalized;
      if (!this.saveSummarizerSettings(normalized)) {
        this.setSummarizerSettingsStatus(
          "Could not save the summary settings.",
          "error"
        );
        return false;
      }
      if (previousVariant === nextVariant) {
        this.renderSummarizerSettings(normalized);
        return true;
      }

      this.summarizerSettingsDirty = true;
      this.requestId += 1;
      if (this.requestController) this.requestController.abort();
      this.replaceLocalSession();
      this.ensureLocalSession();
      this.setSummarizerSettingsStatus(
        "Saved. The next summary will use these choices.",
        "success"
      );
      return true;
    }

    updateSummarizerSettingsFromControls() {
      this.applySummarizerSettings(this.readSummarizerSettingsControls());
    }

    resetSummarizerSettings() {
      const defaults = AI.normalizeSummarizerOptions();
      this.renderSummarizerSettings(defaults);
      this.applySummarizerSettings(defaults);
      this.setSummarizerSettingsStatus(
        "Recommended defaults restored.",
        "success"
      );
    }

    openSettings() {
      if (this.settingsOpen) return;
      this.settingsOpen = true;
      this.el.header.classList.add("settings-open");
      this.el.btnSettings.setAttribute("aria-expanded", "true");
      this.el.settingsNav.setAttribute("aria-hidden", "false");
      setInert(this.el.mainView, true);
      this.el.mainView.hidden = true;
      this.el.settingsView.hidden = false;
      setInert(this.el.settingsView, false);
      void this.refreshSettings();
      this.el.settingsBack.focus();
    }

    closeSettings() {
      if (!this.settingsOpen) return;
      this.settingsOpen = false;
      this.el.header.classList.remove("settings-open");
      this.el.btnSettings.setAttribute("aria-expanded", "false");
      this.el.settingsNav.setAttribute("aria-hidden", "true");
      setInert(this.el.settingsView, true);
      this.el.settingsView.hidden = true;
      this.el.mainView.hidden = false;
      setInert(this.el.mainView, false);
      this.el.btnSettings.focus();
      if (this.summarizerSettingsDirty) {
        this.summarizerSettingsDirty = false;
        this.ensureLocalSession();
        void this.runSummary({ force: false });
      }
    }

    async loadGeminiKey() {
      if (!chrome.storage || !chrome.storage.local) return "";
      const stored = await chrome.storage.local.get([GEMINI_API_KEY_STORAGE_KEY]);
      const value = stored && stored[GEMINI_API_KEY_STORAGE_KEY];
      return typeof value === "string" ? value.trim() : "";
    }

    async hasGeminiPermission() {
      if (
        !chrome.permissions ||
        typeof chrome.permissions.contains !== "function"
      ) {
        return false;
      }
      return chrome.permissions.contains({
        origins: [AI.GEMINI_ORIGIN_PATTERN]
      });
    }

    async saveGeminiKey() {
      if (this.keySavePromise) return this.keySavePromise;

      const key = this.el.geminiKeyInput.value.trim();
      if (key.length < 20) {
        this.setGeminiStatus(
          "Enter a complete Gemini API key.",
          "error",
          { invalid: true }
        );
        this.el.geminiKeyInput.focus();
        return false;
      }

      this.el.btnSaveKey.disabled = true;
      this.el.geminiKeyInput.setAttribute("aria-invalid", "false");
      const saveOperation = (async () => {
        this.setGeminiStatus("Requesting direct Gemini access…");
        try {
          const permissionPromise = chrome.permissions.request({
            origins: [AI.GEMINI_ORIGIN_PATTERN]
          });
          const allowed = await permissionPromise;
          if (!allowed) {
            this.setGeminiStatus(
              "Gemini fallback access was not approved.",
              "error"
            );
            return false;
          }
          await chrome.storage.local.set({
            [GEMINI_API_KEY_STORAGE_KEY]: key
          });
          this.el.geminiKeyInput.value = "";
          this.setGeminiStatus("Fallback key saved locally.", "success");
          this.el.btnRemoveKey.hidden = false;
          this.showToast("Gemini fallback saved");
          return true;
        } catch (error) {
          this.setGeminiStatus("Could not save the fallback key.", "error");
          return false;
        }
      })();
      this.keySavePromise = saveOperation;
      try {
        return await saveOperation;
      } finally {
        if (this.keySavePromise === saveOperation) {
          this.keySavePromise = null;
        }
        this.el.btnSaveKey.disabled = false;
      }
    }

    async removeGeminiKey() {
      this.el.btnRemoveKey.disabled = true;
      try {
        await chrome.storage.local.remove(GEMINI_API_KEY_STORAGE_KEY);
        if (
          chrome.permissions &&
          typeof chrome.permissions.remove === "function"
        ) {
          await chrome.permissions.remove({
            origins: [AI.GEMINI_ORIGIN_PATTERN]
          }).catch(() => false);
        }
        this.setGeminiStatus("No fallback key saved.");
        this.el.btnRemoveKey.hidden = true;
        this.showToast("Gemini fallback removed");
      } catch (error) {
        this.setGeminiStatus("Could not remove the fallback key.", "error");
      } finally {
        this.el.btnRemoveKey.disabled = false;
      }
    }

    setGeminiStatus(message, state = "", { invalid = false } = {}) {
      this.el.geminiKeyStatus.textContent = message;
      this.el.geminiKeyStatus.classList.toggle("is-success", state === "success");
      this.el.geminiKeyStatus.classList.toggle("is-error", state === "error");
      this.el.geminiKeyInput.setAttribute(
        "aria-invalid",
        invalid ? "true" : "false"
      );
    }

    async clearCache() {
      const revision = ++this.cacheRevision;
      this.el.btnClearCache.disabled = true;
      this.el.cacheStatus.classList.remove("is-error");
      this.el.cacheStatus.textContent = "Clearing cached summaries…";
      try {
        await this.enqueueCacheMutation(() => Cache.clear(chrome.storage.local));
        if (revision === this.cacheRevision) {
          this.el.cacheStatus.textContent = "No cached summaries.";
          this.showToast("Cached summaries cleared");
        }
      } catch (error) {
        if (revision === this.cacheRevision) {
          this.el.cacheStatus.textContent = "Could not clear cached summaries.";
          this.el.cacheStatus.classList.add("is-error");
        }
      } finally {
        this.el.btnClearCache.disabled = false;
      }
    }

    async refreshSettings() {
      await Promise.all([
        this.refreshGeminiStatus(),
        this.refreshCacheStatus()
      ]);
    }

    async refreshGeminiStatus() {
      try {
        const key = await this.loadGeminiKey();
        this.setGeminiStatus(
          key ? "Fallback key saved locally." : "No fallback key saved.",
          key ? "success" : ""
        );
        this.el.btnRemoveKey.hidden = !key;
      } catch (error) {
        this.setGeminiStatus("Could not read the fallback setting.", "error");
      }
    }

    async refreshCacheStatus(revision = this.cacheRevision) {
      try {
        const total = await Cache.count(chrome.storage.local);
        if (revision !== this.cacheRevision) return;
        this.el.cacheStatus.classList.remove("is-error");
        this.el.cacheStatus.textContent = total === 0
          ? "No cached summaries."
          : `${total} cached ${total === 1 ? "summary" : "summaries"}.`;
      } catch (error) {
        if (revision !== this.cacheRevision) return;
        this.el.cacheStatus.textContent = "Cached summaries are unavailable.";
        this.el.cacheStatus.classList.add("is-error");
      }
    }

    showToast(message) {
      clearTimeout(this.toastTimer);
      this.el.toastText.textContent = message;
      this.el.toast.hidden = false;
      this.toastTimer = setTimeout(() => {
        this.el.toast.hidden = true;
      }, TOAST_DURATION_MS);
    }
  }

  const controller = new SkimmerController(document);
  controller.init();

  if (typeof module === "object" && module.exports) {
    module.exports = {
      SkimmerController,
      SkimmerError,
      getHostname,
      isInjectableUrl,
      isLikelyNativePdfUrl
    };
  }
})();
