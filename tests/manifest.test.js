const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

test("manifest is active-tab-only and has no sync or broad page permissions", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8")
  );

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "138");
  assert.deepEqual(manifest.permissions, [
    "activeTab",
    "scripting",
    "storage",
    "clipboardWrite"
  ]);
  assert.deepEqual(manifest.optional_host_permissions, [
    "https://generativelanguage.googleapis.com/*"
  ]);
  assert.equal(Object.hasOwn(manifest, "host_permissions"), false);
  assert.equal(Object.hasOwn(manifest, "background"), false);
  assert.equal(Object.hasOwn(manifest, "content_scripts"), false);
  for (const forbidden of ["tabs", "sessions", "alarms", "offscreen"]) {
    assert.equal(manifest.permissions.includes(forbidden), false);
  }
});

test("popup keeps MV3 scripts packaged and exposes the required UI states", () => {
  const html = fs.readFileSync(path.join(projectRoot, "popup.html"), "utf8");

  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  for (const id of [
    "mainView",
    "settingsView",
    "pageStatusBadge",
    "summaryLoading",
    "summaryReady",
    "summaryReadyAnnouncement",
    "summaryError",
    "summaryErrorAnnouncement",
    "btnRetry",
    "geminiKeyInput",
    "summarizerType",
    "summarizerLength",
    "summarizerPreference",
    "summarizerFormat",
    "summarizerLanguage",
    "summarizerContext",
    "summarizerSettingsStatus"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /src="cache\.js"/);
  assert.match(html, /src="ai\.js"/);
  assert.match(html, /src="popup\.js"/);
  assert.match(
    html,
    /id="summaryReadyAnnouncement"[^>]*role="status"[^>]*aria-live="polite"/
  );
  assert.match(
    html,
    /id="summaryErrorAnnouncement"[^>]*role="alert"[^>]*aria-live="assertive"/
  );
  assert.match(
    html,
    /id="geminiKeyInput"[^>]*aria-describedby="geminiKeyStatus geminiAuthNotice"[^>]*aria-invalid="false"/
  );
  assert.match(
    html,
    /id="geminiKeyStatus"[^>]*role="status"[^>]*aria-live="polite"/
  );
  assert.match(
    html,
    /id="cacheStatus"[^>]*role="status"[^>]*aria-live="polite"/
  );
  assert.match(
    html,
    /<option value="key-points">Key insights<\/option>/
  );
  assert.doesNotMatch(html, />key-points</);
});

test("popup guards native PDFs, cache clears, and duplicate key saves", () => {
  const popupSource = fs.readFileSync(
    path.join(projectRoot, "popup.js"),
    "utf8"
  );
  const pdfCheckIndex = popupSource.indexOf(
    "if (isLikelyNativePdfUrl(tab.url || \"\"))"
  );
  const extractionIndex = popupSource.indexOf(
    "const article = await this.extractActivePage(tab)"
  );

  assert.ok(pdfCheckIndex > 0);
  assert.ok(extractionIndex > pdfCheckIndex);
  assert.match(
    popupSource,
    /"native-pdf-viewer":\s*\{[\s\S]*?showRetry:\s*false/
  );
  assert.match(
    popupSource,
    /"ungrounded-response":\s*\{[\s\S]*?Grounding failed/
  );
  assert.match(popupSource, /const revision = \+\+this\.cacheRevision/);
  assert.match(popupSource, /revision !== this\.cacheRevision/);
  assert.match(
    popupSource,
    /if \(this\.keySavePromise\) return this\.keySavePromise/
  );
  assert.match(
    popupSource,
    /await this\.writeCacheIfCurrent\([\s\S]*?this\.renderReady\(result\)/
  );
  assert.match(popupSource, /result\.cacheable !== false/);
  assert.match(popupSource, /cachedIsIncomplete/);
  assert.match(popupSource, /isLikelyIncompleteSummary\(/);
  assert.match(popupSource, /generateCompatibleOnDeviceSummary\(/);
  assert.match(popupSource, /createStableFallbackSummarizerOptions\(/);
  assert.match(popupSource, /setSummarizingProviderBadge\(/);
  assert.doesNotMatch(popupSource, /ON_DEVICE_MODEL_LABEL.*(?:Finishing|Retrying)/);
  assert.match(
    popupSource,
    /result\.provider === "on-device"[\s\S]*?result\.model === "chrome-summarizer"/
  );
  assert.doesNotMatch(popupSource, /void this\.writeCacheIfCurrent/);
});

test("settings shield keeps its centering layout", () => {
  const css = fs.readFileSync(path.join(projectRoot, "popup.css"), "utf8");

  assert.match(css, /--popup-max-h:\s*600px;/);
  assert.doesNotMatch(css, /--popup-h:/);
  assert.match(
    css,
    /html,\s*body\s*\{[\s\S]*?height:\s*auto;[\s\S]*?max-height:\s*var\(--popup-max-h\);/
  );
  assert.match(
    css,
    /\.popup\s*\{[\s\S]*?height:\s*auto;[\s\S]*?max-height:\s*var\(--popup-max-h\);/
  );
  assert.match(
    css,
    /\.settings-intro-icon\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;/
  );
  assert.doesNotMatch(css, /\.settings-intro\s+span\s*\{\s*display:\s*block;/);
  assert.match(css, /\.settings-intro\s*>\s*div\s*>\s*span\s*\{/);
});

test("completed summary content keeps balanced card padding", () => {
  const css = fs.readFileSync(path.join(projectRoot, "popup.css"), "utf8");

  assert.match(
    css,
    /\.summary-ready\s*\{[\s\S]*?padding:\s*14px;/
  );
  assert.match(
    css,
    /\.summary-overview\s*\{[\s\S]*?margin:\s*0;/
  );
  assert.match(
    css,
    /\.summary-overview:not\(\[hidden\]\)\s*\+\s*\.summary-points:not\(:empty\)\s*\{[\s\S]*?margin-top:\s*13px;/
  );
});

test("popup attempts the local summarizer immediately without pre-gating activation", () => {
  const popupSource = fs.readFileSync(
    path.join(projectRoot, "popup.js"),
    "utf8"
  );
  const sessionIndex = popupSource.indexOf("this.ensureLocalSession();");
  const summaryIndex = popupSource.indexOf(
    "void this.runSummary({ force: false });"
  );

  assert.ok(sessionIndex > 0);
  assert.ok(summaryIndex > sessionIndex);
  assert.doesNotMatch(popupSource, /navigator\.userActivation/);
});

test("popup streams native output and records first-visible performance", () => {
  const popupSource = fs.readFileSync(
    path.join(projectRoot, "popup.js"),
    "utf8"
  );
  const popupHtml = fs.readFileSync(
    path.join(projectRoot, "popup.html"),
    "utf8"
  );
  const popupCss = fs.readFileSync(
    path.join(projectRoot, "popup.css"),
    "utf8"
  );

  assert.match(popupSource, /onPartial:\s*\(partialResult\)/);
  assert.match(popupSource, /renderPartial\(partialResult\)/);
  assert.match(popupSource, /dataset\.summaryFirstVisibleMs/);
  assert.match(popupSource, /dataset\.summaryNativeFirstVisibleMs/);
  assert.match(popupSource, /dataset\.summaryCompleteMs/);
  assert.match(popupSource, /firstVisibleMs == null/);
  assert.doesNotMatch(popupSource, /Instant preview|createInstantPreview/);
  assert.doesNotMatch(popupSource, /page-capture\.js|injectImmediately/);
  assert.match(
    popupHtml,
    /id="providerBadge"[^>]*>Gemini Nano · Summarizing\.\.\.<\/span>/
  );
  assert.doesNotMatch(popupHtml, /loadingText|loading-label|class="spinner"/);
  assert.match(popupHtml, /id="summaryNextPlaceholder"[^>]*hidden/);
  assert.match(popupSource, /showNextBlockPlaceholder\(/);
  assert.match(popupSource, /classList\.add\("summary-block-reveal"\)/);
  assert.match(popupSource, /renderWordStream\(overview\)/);
  assert.match(popupSource, /result\.streamMode === "word"/);
  assert.match(popupCss, /\.summary-word-enter/);
  assert.match(popupCss, /\.provider-badge-summarizing/);
  assert.match(
    popupCss,
    /\.provider-badge-summarizing\s*\{[\s\S]*?animation:\s*shimmer/
  );
  assert.doesNotMatch(popupCss, /\.loading-label|\.spinner|@keyframes spin/);
  assert.match(popupCss, /\.provider-badge-dots\s*>\s*span/);
  assert.match(popupCss, /@keyframes provider-badge-dot/);
  assert.match(popupCss, /@keyframes summary-word-enter/);
  assert.match(popupCss, /@keyframes summary-resolve-wipe/);
  assert.match(
    popupCss,
    /\.summary-next-placeholder-lines\s*>\s*span[\s\S]*?animation:\s*shimmer/
  );
});
