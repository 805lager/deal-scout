/**
 * hydrate.js — Shared hydration / retry / content-title verification helper.
 * v0.48.20
 *
 * WHY THIS EXISTS:
 *   Facebook Marketplace (fbm.js) has a battle-tested approach for waiting on
 *   slow / partially-hydrated listing pages before scoring:
 *     1. Wait for the listing title to actually appear (and, on SPA nav, to
 *        differ from the previous listing's title).
 *     2. Retry extraction with a backoff schedule while the page is still
 *        thin (insufficient raw_text) or the title hasn't hydrated.
 *     3. Verify the extracted title actually appears in the page text before
 *        sending to the API, so we never score mismatched / garbage content.
 *
 *   eBay, Craigslist and OfferUp historically used short fixed polls and
 *   could surface a premature "Scoring failed" / "Could not read listing"
 *   on slow pages. This module factors FBM's proven discipline into one
 *   place so the other marketplaces can share it.
 *
 *   fbm.js keeps its own orchestration (it has extra SPA-teardown handling)
 *   but delegates the two PURE helpers (titleMatchesContent + rawFingerprint)
 *   here so the logic is genuinely shared, not duplicated, with byte-for-byte
 *   identical behavior.
 *
 * Exposes window.DealScoutHydrate. Idempotent (safe to load twice).
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || window.DealScoutHydrate) return;

  // Titles that are NOT real listing titles — chrome / nav / app-shell text
  // that a marketplace renders before (or instead of) the listing hydrating.
  const DEFAULT_GENERIC_TITLES = new Set([
    "", "marketplace", "facebook marketplace", "facebook",
    "notifications", "inbox", "chats", "friends", "watch",
    "gaming", "groups", "home", "news feed", "search", "sponsored",
    "menu", "messages", "offerup", "ebay", "craigslist",
  ]);

  // Backoff schedule mirrored from fbm.js's content-retry loop — gentle at
  // first (pages usually settle within ~1s) then progressively patient so a
  // genuinely slow / cold page still gets read instead of failing early.
  const DEFAULT_RETRY_DELAYS =
    [500, 800, 1000, 1500, 2000, 2000, 2500, 2500, 3000, 3000, 3000, 3000];

  function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function isGenericTitle(title, generic) {
    const set = generic || DEFAULT_GENERIC_TITLES;
    const t = (title || "").trim().toLowerCase();
    return !t || set.has(t);
  }

  // A title is "ready" if it's present, has some substance, and isn't a
  // generic app-shell string. Mirrors fbm.js's h1Ok gate (length > 3).
  function isReadyTitle(title, generic) {
    const t = (title || "").trim();
    return !!(t && t.length > 3 && !isGenericTitle(t, generic));
  }

  // Content-title verification — does the extracted title actually appear in
  // the page text? Byte-for-byte identical to fbm.js's inline _contentTitleMatch
  // computation: ≥50% of the title's >2-char words must be present in raw_text.
  function titleMatchesContent(title, rawText) {
    if (!title || !rawText) return false;
    const tLower = String(title).toLowerCase();
    const rawLower = String(rawText).toLowerCase();
    const words = tLower.split(/\s+/).filter((w) => w.length > 2);
    if (words.length === 0) return true;
    const matchCount = words.filter((w) => rawLower.includes(w)).length;
    return (matchCount / words.length) >= 0.5;
  }

  // Normalized fingerprint of raw page text — identical to fbm.js's
  // _rawFingerprint. Used to detect a stale React tree still showing the
  // previous listing's content after an SPA navigation.
  function rawFingerprint(text) {
    if (!text) return "";
    return String(text).replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
  }

  /**
   * waitForListing — wait for genuine hydration, then extract with a
   * retry/backoff budget and verify the title against the page text.
   *
   * opts:
   *   getTitle()   -> string  : current listing title from the DOM.
   *   extract()    -> object  : marketplace rawData (must include .raw_text).
   *   isAlive()    -> bool     : guard — return false to abort retries when
   *                             the navigation nonce changed / URL moved on.
   *   genericTitles: Set       : optional override of generic-title set.
   *   maxRetries   : number    : default 12.
   *   retryDelays  : number[]  : default DEFAULT_RETRY_DELAYS.
   *   minRawLen    : number    : minimum acceptable raw_text length (100).
   *   requireTitle : bool      : hard-gate on title hydration (default true).
   *   prevFingerprint: string  : fingerprint of the previously-scored content
   *                             (optional) — used to retry while the page is
   *                             still showing stale content.
   *   onProgress(info)         : optional callback each attempt for UI/diag.
   *
   * Resolves: { ok, rawData, title, reason, attempts, titleEver,
   *             contentTitleMatch }
   *   reason ∈ { "aborted", "insufficient-content", "no-title",
   *             "title-mismatch" } when ok === false.
   */
  async function waitForListing(opts) {
    opts = opts || {};
    const getTitle = opts.getTitle || (() => "");
    const extract = opts.extract;
    const isAlive = opts.isAlive || (() => true);
    const genericTitles = opts.genericTitles || DEFAULT_GENERIC_TITLES;
    const maxRetries = opts.maxRetries || DEFAULT_RETRY_DELAYS.length;
    const retryDelays = opts.retryDelays || DEFAULT_RETRY_DELAYS;
    const minRawLen = typeof opts.minRawLen === "number" ? opts.minRawLen : 100;
    const requireTitle = opts.requireTitle !== false;
    const prevFingerprint = opts.prevFingerprint || "";
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

    if (typeof extract !== "function") {
      return { ok: false, reason: "insufficient-content", rawData: null, attempts: 0 };
    }

    let rawData = null;
    let titleEver = false;
    let contentTitleMatch = false;
    let titleCheckRetries = 0;
    let attempt = 0;

    for (; attempt < maxRetries; attempt++) {
      if (!isAlive()) return { ok: false, reason: "aborted", rawData, attempts: attempt };

      rawData = extract();
      const title = (getTitle() || (rawData && rawData.title) || "").trim();
      const titleOk = isReadyTitle(title, genericTitles);
      if (titleOk) titleEver = true;

      const rawLen = (rawData && rawData.raw_text ? rawData.raw_text.length : 0);
      if (onProgress) {
        try { onProgress({ attempt, title, titleOk, rawLen, reason: "" }); } catch (_e) {}
      }

      // Hard gate: refuse to proceed while the title hasn't hydrated. A page
      // shell can deliver nav/footer text (>100 chars) before the real title
      // renders — submitting then yields a titleless / mismatched score.
      if (requireTitle && !titleOk) {
        await delay(retryDelays[attempt] || 3000);
        continue;
      }

      if (!rawData || !rawData.raw_text || rawData.raw_text.length < minRawLen) {
        if (onProgress) { try { onProgress({ attempt, title, titleOk, rawLen, reason: "insufficient" }); } catch (_e) {} }
        await delay(retryDelays[attempt] || 2000);
        continue;
      }

      // Stale-content guard: identical raw fingerprint to a previously-scored
      // listing means the SPA hasn't swapped in the new content yet.
      if (prevFingerprint) {
        const fp = rawFingerprint(rawData.raw_text);
        if (fp === prevFingerprint) {
          if (onProgress) { try { onProgress({ attempt, title, titleOk, rawLen, reason: "stale" }); } catch (_e) {} }
          await delay(retryDelays[attempt] || 2000);
          continue;
        }
      }

      // Content-title verification before we accept the extraction.
      if (titleOk) {
        contentTitleMatch = titleMatchesContent(title, rawData.raw_text);
        if (!contentTitleMatch) {
          titleCheckRetries++;
          if (onProgress) { try { onProgress({ attempt, title, titleOk, rawLen, reason: "title-mismatch" }); } catch (_e) {} }
          await delay(retryDelays[attempt] || 2000);
          continue;
        }
      } else {
        contentTitleMatch = true;
      }

      break;
    }

    if (!isAlive()) return { ok: false, reason: "aborted", rawData, attempts: attempt };

    if (!rawData || !rawData.raw_text || rawData.raw_text.length < minRawLen) {
      return { ok: false, reason: "insufficient-content", rawData, attempts: attempt, titleEver, contentTitleMatch };
    }
    if (requireTitle && !titleEver) {
      return { ok: false, reason: "no-title", rawData, attempts: attempt, titleEver, contentTitleMatch };
    }
    if (!contentTitleMatch && titleCheckRetries > 0) {
      return { ok: false, reason: "title-mismatch", rawData, attempts: attempt, titleEver, contentTitleMatch };
    }

    return {
      ok: true,
      rawData,
      title: (getTitle() || (rawData && rawData.title) || "").trim(),
      attempts: attempt,
      titleEver,
      contentTitleMatch,
    };
  }

  window.DealScoutHydrate = {
    DEFAULT_GENERIC_TITLES,
    DEFAULT_RETRY_DELAYS,
    delay,
    isGenericTitle,
    isReadyTitle,
    titleMatchesContent,
    rawFingerprint,
    waitForListing,
  };
})();
