const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_ARTICLE_TEXT_CHARS,
  extract,
  extractStructuredArticle,
  normalizeBlockText,
  packArticleText
} = require("../page-extractor.js");

function createDocumentStub() {
  const documentNode = {
    title: "Fallback title",
    readyState: "complete",
    location: { href: "https://example.com/story" },
    documentElement: { lang: "en" },
    body: null,
    cloneNode() {
      return documentNode;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  return documentNode;
}

test("normalization preserves paragraphs and removes null bytes", () => {
  assert.equal(
    normalizeBlockText(" First\u0000  paragraph.\r\n\r\n Second\tparagraph. "),
    "First paragraph.\n\nSecond paragraph."
  );
});

test("long content packing keeps both the opening and conclusion", () => {
  const source = [
    `Opening evidence ${"a".repeat(15000)}`,
    `Final conclusion ${"z".repeat(5000)}`
  ].join("\n\n");
  const packed = packArticleText(source);

  assert.ok(packed.length <= MAX_ARTICLE_TEXT_CHARS);
  assert.match(packed, /^Opening evidence/);
  assert.match(packed, /Final conclusion/);
});

test("JSON-LD articleBody is preferred from the live document", () => {
  const body = "Supported article evidence ".repeat(20);
  const raw = JSON.stringify({
    "@type": "NewsArticle",
    headline: "Structured headline",
    author: { name: "A. Writer" },
    articleBody: body
  });
  const script = {
    textContent: raw,
    getAttribute(name) {
      return name === "type" ? "application/ld+json" : null;
    }
  };
  const documentNode = createDocumentStub();
  documentNode.querySelectorAll = (selector) => (
    selector.includes("ld+json") ? [script] : []
  );

  const article = extractStructuredArticle(documentNode, {});
  assert.equal(article.parser, "json-ld");
  assert.equal(article.title, "Structured headline");
  assert.equal(article.byline, "A. Writer");
  assert.match(article.textContent, /Supported article evidence/);
});

test("Readability receives a clone and only bounded plaintext is returned", () => {
  const documentNode = createDocumentStub();
  let receivedOptions = null;
  class FakeReadability {
    constructor(document, options) {
      assert.equal(document, documentNode);
      receivedOptions = options;
    }

    parse() {
      return {
        title: "Readable title",
        byline: "Writer",
        excerpt: "Readable description",
        siteName: "Example",
        content: "<p>HTML must not cross the boundary</p>",
        textContent: "Useful live article text. ".repeat(1200)
      };
    }
  }

  const result = extract(documentNode, { ReadabilityCtor: FakeReadability });
  assert.equal(receivedOptions.maxElemsToParse, 25000);
  assert.equal(result.parser, "mozilla-readability");
  assert.ok(result.content.length <= MAX_ARTICLE_TEXT_CHARS);
  assert.equal(Object.hasOwn(result, "textContent"), false);
  assert.doesNotMatch(JSON.stringify(result), /HTML must not cross/);
  assert.ok(result.wordCount > 0);
});
