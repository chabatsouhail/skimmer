(function initSkimmerPageExtractor(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.SkimmerPageExtractor = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPageExtractor() {
  "use strict";

  const MAX_ARTICLE_TEXT_CHARS = 12000;
  const MIN_ARTICLE_TEXT_CHARS = 160;
  const MAX_DOCUMENT_ELEMENTS = 25000;
  const MAX_STRUCTURED_SCRIPT_CHARS = 2 * 1024 * 1024;
  const MAX_STRUCTURED_SCRIPTS = 60;
  const MAX_STRUCTURED_NODES = 8000;
  const MAX_STRUCTURED_DEPTH = 14;

  function normalizeBlockText(value, maxLength = MAX_ARTICLE_TEXT_CHARS) {
    if (typeof value !== "string") return "";
    const limit = Math.max(0, Number(maxLength) || 0);
    return value
      .replace(/\u0000/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, limit);
  }

  function getMetaContent(documentNode, selectors) {
    if (!documentNode || typeof documentNode.querySelector !== "function") {
      return "";
    }

    for (const selector of selectors) {
      const node = documentNode.querySelector(selector);
      const value = node && node.getAttribute && node.getAttribute("content");
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function extractMetadata(documentNode) {
    const title = normalizeBlockText(
      getMetaContent(documentNode, [
        'meta[property="og:title"]',
        'meta[name="twitter:title"]'
      ]) || (documentNode && documentNode.title) || "",
      500
    );
    const description = normalizeBlockText(
      getMetaContent(documentNode, [
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
        'meta[name="description"]'
      ]),
      1200
    );
    const byline = normalizeBlockText(
      getMetaContent(documentNode, [
        'meta[name="author"]',
        'meta[property="article:author"]',
        'meta[name="byl"]'
      ]),
      300
    );
    const siteName = normalizeBlockText(
      getMetaContent(documentNode, ['meta[property="og:site_name"]']),
      300
    );
    const canonicalNode = documentNode &&
      typeof documentNode.querySelector === "function"
      ? documentNode.querySelector('link[rel="canonical"]')
      : null;
    const canonicalUrl = normalizeBlockText(
      canonicalNode && canonicalNode.getAttribute
        ? canonicalNode.getAttribute("href") || ""
        : "",
      4096
    );

    return { title, description, byline, siteName, canonicalUrl };
  }

  function getStructuredTypes(value) {
    return (Array.isArray(value) ? value : [value])
      .filter((item) => typeof item === "string")
      .map((item) => item.toLocaleLowerCase("en"));
  }

  function isArticleType(value) {
    return getStructuredTypes(value).some((type) => (
      type === "article" ||
      type.endsWith("article") ||
      type === "blogposting" ||
      type === "reportagenewsarticle"
    ));
  }

  function getStructuredName(value, maxLength = 300) {
    if (typeof value === "string") return normalizeBlockText(value, maxLength);
    if (Array.isArray(value)) {
      return normalizeBlockText(
        value.map((item) => getStructuredName(item, maxLength)).filter(Boolean).join(", "),
        maxLength
      );
    }
    if (!value || typeof value !== "object") return "";
    return normalizeBlockText(value.name || value.headline || value.title || "", maxLength);
  }

  function normalizeStructuredBody(value) {
    if (typeof value !== "string") return "";
    return normalizeBlockText(
      value
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\s*\/\s*(?:p|div|li|h[1-6])\s*>/gi, "\n\n")
        .replace(/<[^>]{0,2000}>/g, " "),
      MAX_ARTICLE_TEXT_CHARS * 3
    );
  }

  function extractStructuredArticle(documentNode, metadata = {}) {
    if (!documentNode || typeof documentNode.querySelectorAll !== "function") {
      return null;
    }

    const scripts = [];
    const seen = new Set();
    for (const selector of [
      'script[type="application/ld+json"]',
      'script[type="application/json"]',
      "script#__NEXT_DATA__"
    ]) {
      for (const script of Array.from(documentNode.querySelectorAll(selector) || [])) {
        if (!script || seen.has(script)) continue;
        seen.add(script);
        scripts.push(script);
        if (scripts.length >= MAX_STRUCTURED_SCRIPTS) break;
      }
      if (scripts.length >= MAX_STRUCTURED_SCRIPTS) break;
    }

    let best = null;
    let visited = 0;
    const consider = (value, scriptType) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const textContent = normalizeStructuredBody(value.articleBody);
      if (textContent.length < MIN_ARTICLE_TEXT_CHARS) return;
      const explicitArticle = isArticleType(value["@type"] || value.type);
      const candidate = {
        title: normalizeBlockText(
          value.headline || value.name || metadata.title || "",
          500
        ),
        byline: getStructuredName(value.author) || metadata.byline || "",
        description: normalizeBlockText(
          value.description || metadata.description || "",
          1200
        ),
        siteName: getStructuredName(value.publisher) || metadata.siteName || "",
        textContent,
        parser: scriptType === "application/ld+json"
          ? "json-ld"
          : "structured-data",
        score: textContent.length + (explicitArticle ? 100000 : 0)
      };
      if (!best || candidate.score > best.score) best = candidate;
    };

    const visit = (value, depth, scriptType) => {
      if (
        value == null ||
        depth > MAX_STRUCTURED_DEPTH ||
        visited >= MAX_STRUCTURED_NODES
      ) {
        return;
      }
      visited += 1;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1, scriptType);
        return;
      }
      if (typeof value !== "object") return;
      consider(value, scriptType);
      for (const nested of Object.values(value)) {
        visit(nested, depth + 1, scriptType);
      }
    };

    for (const script of scripts) {
      const raw = typeof script.textContent === "string"
        ? script.textContent.trim()
        : "";
      if (!raw || raw.length > MAX_STRUCTURED_SCRIPT_CHARS) continue;
      const scriptType = script.getAttribute
        ? String(script.getAttribute("type") || "").toLocaleLowerCase("en")
        : "";
      try {
        visit(JSON.parse(raw), 0, scriptType);
      } catch (error) {
        // Invalid publisher JSON must not prevent the other extraction paths.
      }
    }

    if (!best) return null;
    const { score, ...article } = best;
    return article;
  }

  function removeNonContentNodes(rootNode) {
    if (!rootNode || typeof rootNode.querySelectorAll !== "function") return;
    rootNode
      .querySelectorAll(
        "script, style, noscript, template, svg, canvas, iframe, nav, form, " +
        "button, input, select, textarea, aside, footer, dialog, " +
        '[aria-hidden="true"], [hidden], [role="navigation"], ' +
        '[role="complementary"], [role="dialog"]'
      )
      .forEach((node) => node.remove());
  }

  function getFallbackArticle(documentNode) {
    if (!documentNode || typeof documentNode.querySelectorAll !== "function") {
      return null;
    }

    const elementCount = documentNode.querySelectorAll("*").length;
    if (elementCount > MAX_DOCUMENT_ELEMENTS) return null;

    const candidates = Array.from(documentNode.querySelectorAll(
      "article, main, [role=\"main\"], .article, .post, .entry-content, " +
      ".article-content, .post-content, #article, #content"
    )).slice(0, 40);
    if (documentNode.body) candidates.push(documentNode.body);

    let best = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.cloneNode !== "function") continue;
      const clone = candidate.cloneNode(true);
      removeNonContentNodes(clone);
      const textContent = normalizeBlockText(
        clone.textContent || "",
        MAX_ARTICLE_TEXT_CHARS * 3
      );
      if (textContent.length < MIN_ARTICLE_TEXT_CHARS) continue;
      const paragraphs = typeof clone.querySelectorAll === "function"
        ? clone.querySelectorAll("p").length
        : 0;
      const headings = typeof clone.querySelectorAll === "function"
        ? clone.querySelectorAll("h1, h2, h3").length
        : 0;
      const links = typeof clone.querySelectorAll === "function"
        ? clone.querySelectorAll("a").length
        : 0;
      const score = textContent.length + paragraphs * 150 + headings * 70 - links * 8;
      if (score <= bestScore) continue;
      bestScore = score;
      best = textContent;
    }

    return best;
  }

  function packArticleText(value, maxChars = MAX_ARTICLE_TEXT_CHARS) {
    const limit = Math.max(1000, Number(maxChars) || MAX_ARTICLE_TEXT_CHARS);
    const text = normalizeBlockText(value, MAX_ARTICLE_TEXT_CHARS * 3);
    if (!text || text.length <= limit) return text;

    const paragraphs = text
      .split(/\n{2,}/)
      .map((paragraph) => normalizeBlockText(paragraph, limit))
      .filter(Boolean);

    if (paragraphs.length === 1) {
      const headLength = Math.floor(limit * 0.68);
      const tailLength = limit - headLength - 2;
      return `${text.slice(0, headLength).trim()}\n\n${text.slice(-tailLength).trim()}`
        .slice(0, limit);
    }

    if (paragraphs.length === 2) {
      const headLength = Math.floor(limit * 0.68);
      const tailLength = limit - headLength - 2;
      const head = paragraphs[0].slice(0, headLength).trim();
      const tailSource = paragraphs[1];
      const tail = tailSource.length <= tailLength
        ? tailSource
        : [
            tailSource.slice(0, Math.floor(tailLength * 0.64)).trim(),
            tailSource.slice(-Math.floor(tailLength * 0.34)).trim()
          ].filter(Boolean).join("\n");
      return `${head}\n\n${tail}`.slice(0, limit);
    }

    const chosen = new Set();
    let used = 0;
    const add = (index) => {
      if (chosen.has(index)) return false;
      const separator = chosen.size > 0 ? 2 : 0;
      const next = paragraphs[index];
      if (!next || used + separator + next.length > limit) return false;
      chosen.add(index);
      used += separator + next.length;
      return true;
    };

    const headBudget = Math.floor(limit * 0.55);
    for (let index = 0; index < paragraphs.length && used < headBudget; index += 1) {
      if (!add(index)) break;
    }

    const tailStart = used;
    const tailBudget = Math.floor(limit * 0.25);
    for (let index = paragraphs.length - 1; index >= 0 && used - tailStart < tailBudget; index -= 1) {
      add(index);
    }

    const remaining = limit - used;
    const middle = [];
    for (let index = 0; index < paragraphs.length; index += 1) {
      if (!chosen.has(index)) middle.push(index);
    }
    const stride = Math.max(1, Math.floor(middle.length / 6));
    for (let offset = 0; offset < middle.length && limit - used > 80; offset += stride) {
      if (limit - used > remaining || !add(middle[offset])) continue;
    }

    return Array.from(chosen)
      .sort((a, b) => a - b)
      .map((index) => paragraphs[index])
      .join("\n\n")
      .slice(0, limit);
  }

  function countWords(value) {
    const matches = normalizeBlockText(value, MAX_ARTICLE_TEXT_CHARS)
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
    return matches ? matches.length : 0;
  }

  function extract(documentNode, {
    ReadabilityCtor = typeof Readability === "function" ? Readability : null
  } = {}) {
    if (!documentNode || typeof documentNode.cloneNode !== "function") {
      return null;
    }

    const metadata = extractMetadata(documentNode);
    const structured = extractStructuredArticle(documentNode, metadata);
    let article = structured;

    if (!article && typeof ReadabilityCtor === "function") {
      try {
        const parsed = new ReadabilityCtor(documentNode.cloneNode(true), {
          charThreshold: MIN_ARTICLE_TEXT_CHARS,
          keepClasses: false,
          maxElemsToParse: MAX_DOCUMENT_ELEMENTS,
          disableJSONLD: false
        }).parse();
        const textContent = normalizeBlockText(
          parsed && parsed.textContent,
          MAX_ARTICLE_TEXT_CHARS * 3
        );
        if (textContent.length >= MIN_ARTICLE_TEXT_CHARS) {
          article = {
            title: normalizeBlockText(parsed.title, 500) || metadata.title,
            byline: normalizeBlockText(parsed.byline, 300) || metadata.byline,
            description: normalizeBlockText(parsed.excerpt, 1200) ||
              metadata.description,
            siteName: normalizeBlockText(parsed.siteName, 300) ||
              metadata.siteName,
            textContent,
            parser: "mozilla-readability"
          };
        }
      } catch (error) {
        // Readability can reject very large or unusual documents; fall through.
      }
    }

    if (!article) {
      const fallbackText = getFallbackArticle(documentNode);
      article = fallbackText
        ? {
            ...metadata,
            textContent: fallbackText,
            parser: "dom-fallback"
          }
        : metadata.description
          ? {
              ...metadata,
              textContent: metadata.description,
              parser: "metadata"
            }
          : null;
    }

    if (!article) return null;
    const content = packArticleText(article.textContent);
    const wordCount = countWords(content);
    const documentUrl = normalizeBlockText(
      documentNode.location && documentNode.location.href
        ? documentNode.location.href
        : "",
      4096
    );
    const language = normalizeBlockText(
      documentNode.documentElement && documentNode.documentElement.lang
        ? documentNode.documentElement.lang
        : "",
      40
    );

    return {
      title: normalizeBlockText(article.title || metadata.title, 500),
      byline: normalizeBlockText(article.byline || metadata.byline, 300),
      description: normalizeBlockText(
        article.description || metadata.description,
        1200
      ),
      siteName: normalizeBlockText(article.siteName || metadata.siteName, 300),
      url: documentUrl,
      canonicalUrl: metadata.canonicalUrl,
      language,
      content,
      contentLength: content.length,
      wordCount,
      readingMinutes: wordCount > 0 ? Math.max(1, Math.round(wordCount / 220)) : 0,
      parser: article.parser || "metadata",
      documentReadyState: normalizeBlockText(documentNode.readyState || "", 30),
      extractedAt: Date.now()
    };
  }

  return Object.freeze({
    MAX_ARTICLE_TEXT_CHARS,
    MIN_ARTICLE_TEXT_CHARS,
    MAX_DOCUMENT_ELEMENTS,
    countWords,
    extract,
    extractMetadata,
    extractStructuredArticle,
    getFallbackArticle,
    normalizeBlockText,
    packArticleText,
    removeNonContentNodes
  });
});
