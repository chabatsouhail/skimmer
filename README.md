# Skimmer

Skimmer is a Manifest V3 Chrome extension that summarizes only the page in the
currently focused tab.

Unlike Handover, it does not inspect synced sessions, fetch a URL again, or ask
for access to every website. Clicking the toolbar button gives Skimmer temporary
access to the active tab, where it extracts the live rendered article and sends
only cleaned plain text to the summarizer.

## What it does

- Reads only the tab where you invoked the extension.
- Extracts the live DOM with Mozilla Readability plus a conservative fallback.
- Uses Chrome's on-device Summarizer API first.
- Streams grounded on-device results without repainting character by character.
  Key Insights reveals each completed insight with the shimmer transition;
  Quick Overview, Teaser, and Headline reveal completed words as they arrive.
  The Fast priority uses a balanced 4,800-character
  opening/middle/conclusion sample to reduce prompt-processing latency.
- Lets you configure the on-device summary style, length, speed-versus-quality
  priority, format, output language, and optional focus instructions.
- Can use Gemini 3.1 Flash-Lite as an optional fallback when you save your own
  Gemini Auth key.
- Caches summaries for seven days. Exact page-content matches are preferred,
  with a same-page fallback for small live DOM changes. Source page text is
  never stored in the cache.
- Detects likely PDF URLs before attempting page injection. Chrome's native PDF
  viewer does not expose document text to Skimmer, so those tabs show a clear
  non-retryable PDF state.

## Install locally

1. Run `npm install`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose this folder.
5. Pin Skimmer, open a normal webpage, and click its toolbar icon.

Chrome 138 or later is required for the built-in Summarizer API. If Chrome needs
to download its local model, Skimmer shows the download progress. The optional
Summarizer options and Gemini fallback can be configured from Skimmer's
settings.

## Development

```powershell
npm run verify
```

Run `npm run preview` to open a browser-friendly local preview at
`http://127.0.0.1:4173/`. The preview uses mock page and AI data; it never calls
Gemini. For performance checks, the popup records
`data-summary-first-visible-ms` and `data-summary-complete-ms` on the root HTML
element. `data-summary-native-first-visible-ms` tracks the native model
separately. The popup logs the same timing breakdown in its console.

Run `npm run icons` after changing the extension mark in
`scripts/generate-icons.js`.

## Gemini Auth / BYOK fallback

The optional Gemini fallback is a bring-your-own-key (BYOK) integration. When
it runs, Skimmer sends the page title, URL, and cleaned article text directly to
Google's Gemini API, where Google's Gemini API data terms apply. The source page
text is not added to Skimmer's summary cache.

The pasted key is stored in `chrome.storage.local` on the current Chrome profile
and is not synced by Skimmer. Skimmer does not add application-level encryption
around that local value, so anyone or anything with access to the profile's
extension storage may be able to read it.

Use an authorization (Auth) key created in Google AI Studio. New AI Studio keys
are Auth keys. Google says Gemini will reject standard keys in September 2026,
so replace an older standard key before then.

## Privacy model

Skimmer's default summarizer runs in Chrome on the local device. If a Gemini API
key is saved, Skimmer uses Gemini only when local AI cannot complete the
summary. See the Gemini Auth / BYOK section above for the page-data transmission
and local key-storage caveats.

The seven-day cache stores the page title, URL, content fingerprint, and
generated summary locally. It prefers an exact content match and can reuse the
newest entry for the same URL when live DOM details change. It does not store
the extracted source text, and it is disabled for incognito tabs. Use Refresh
to deliberately bypass and replace a cached summary.
