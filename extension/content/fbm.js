/**
 * fbm.js — Deal Scout Content Script for Facebook Marketplace
 * v0.26.6
 *
 * INJECTED INTO: facebook.com/marketplace/*
 * PURPOSE: Extracts listing data, sends to backend for scoring, renders the
 *          Deal Scout panel inside the FBM sidebar.
 *
 * ARCHITECTURE:
 *   This file runs inside the FBM page context (not isolated world).
 *   It extracts data from the DOM, sends a SCORE_LISTING message to
 *   background.js, which calls the FastAPI backend, then renders the result.
 *
 * BOT DETECTION NOTES:
 *   - We read existing DOM — no Playwright, no synthetic clicks
 *   - All extraction is passive (no form submissions, no navigation)
 *   - No polling loops — event-driven only
 *   - Sidebar injection uses a div, never modifies FBM's own DOM tree
 */

(function () {
  "use strict";

  // ── Constants — declared FIRST to avoid TDZ crash in guard path ──────────────
  // CRITICAL: background.js injects this script AND the manifest content_scripts
  // also injects it. The second injection hits the guard below and returns early.
  // Any `const`/`let` declared after that early `return` is in temporal dead zone
  // (TDZ). If a hoisted function (like autoScore) is scheduled via setTimeout in
  // the guard path and later references those vars → TDZ crash.
  // Fix: declare ALL vars used by hoisted functions BEFORE the guard.
  const VERSION  = '0.28.15';
  const PANEL_ID  = "deal-scout-panel";
  // API_BASE must live here (before guard) — autoScore → renderError uses it.
  let API_BASE = "https://74e2628f-3f35-45e7-a256-28e515813eca-00-1g6ldqrar1bea.spock.replit.dev/api/ds";
  const DS_API_KEY = "ds_live_098caae54340d797cb216856d0cffe50";
  // _GENERIC_TITLES must also be before the guard — autoScore references it and
  // autoScore is scheduled from the guard path on SPA re-injection. Any const/let
  // declared after the early return is in TDZ when autoScore runs. (See TDZ note above.)
  // FBM nav UI terms that appear as h1[dir="auto"] elements before listing content loads.
  // "Notifications", "Inbox" etc. are FBM tab headings — never valid listing titles.
  // Adding them here causes the readiness poller to keep waiting until the real
  // listing title appears, preventing bad extractions on hard page loads and SPA nav.
  const _GENERIC_TITLES = new Set([
    '', 'marketplace', 'facebook marketplace', 'facebook',
    'notifications', 'inbox', 'chats', 'friends', 'watch',
    'gaming', 'groups', 'home', 'news feed', 'search', 'sponsored',
    'menu', 'messages',
  ]);

  // ── Navigation nonce ─────────────────────────────────────────────────────────
  // Stored on window so it persists across re-injections of fbm.js. Every time
  // _onFbmNav fires (user clicks a new listing), the nonce increments.
  // autoScore captures the nonce at the START of each scoring run and checks it
  // again before rendering. If they differ, the user navigated away mid-flight
  // and we discard the result — even if location.href happens to look the same
  // (FBM sometimes calls replaceState after navigation, resetting the URL briefly).
  if (window.__dealScoutNonce === undefined) window.__dealScoutNonce = 0;

  // Mutex flag: true while an autoScore is running. Prevents multiple concurrent
  // autoScores caused by FBM firing 3-4 pushStates per navigation. Each pushState
  // re-injects fbm.js; only the first autoScore past the flag proceeds. Navigation
  // (_onFbmNav) resets this flag so the next autoScore for the new listing can run.
  if (window.__dealScoutRunning === undefined) window.__dealScoutRunning = false;

  // ── Guard: prevent double-injection on SPA navigation ───────────────────────
  // background.js re-injects fbm.js on every pushState. Without this guard,
  // multiple instances would race and create duplicate sidebars.
  if (window.__dealScoutInjected) {
    // Already running — re-injection from background.js on SPA navigation.
    // prevTitle was already saved by the pushState intercept at t=0 (see bottom
    // of this file). Don't overwrite it here — by now the DOM may already show
    // the new listing, which would make prevTitle useless.
    if (isListingPage()) {
      // Abort any in-flight stream and reset the mutex so the new autoScore
      // can start cleanly. Increment nonce first so the old autoScore's
      // finally block won't reclaim the mutex after we reset it.
      window.__dealScoutNonce = (window.__dealScoutNonce || 0) + 1;
      if (window.__dealScoutAbort) {
        window.__dealScoutAbort.abort();
        window.__dealScoutAbort = null;
      }
      window.__dealScoutRunning = false;
      renderNavigating();
      clearTimeout(window.__dealScoutRescanTimer);
      window.__dealScoutRescanTimer = setTimeout(autoScore, 100);
    }
    return;
  }
  window.__dealScoutInjected = true;

  // Load stored API base override (set via popup Settings panel)
  try {
    chrome.storage.local.get("ds_api_base", (result) => {
      if (result && result.ds_api_base) API_BASE = result.ds_api_base;
    });
  } catch (e) {
    // Extension context may be invalidated on reload — keep default
  }

  // ── Page Detection ────────────────────────────────────────────────────────────

  function isListingPage() {
    return /facebook\.com\/marketplace\/(item\/|[^/]+\/item\/)/.test(location.href);
  }

  function isSearchOrCategory() {
    return /facebook\.com\/marketplace\/(search|category|[^/]+\/)/.test(location.href)
        && !isListingPage();
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────────

  // Returns up to 450 chars of text content that comes AFTER the listing-title
  // h1 inside `containerEl`, using a DOM TreeWalker (not string search).
  //
  // WHY NOT querySelector('h1[dir="auto"]')?
  // FBM renders MULTIPLE h1[dir="auto"] elements in [role="main"] — navigation
  // headings, breadcrumb labels, etc. — BEFORE the real listing title h1.
  // querySelector returns the first match, which is usually a nav heading.
  // The TreeWalker would then pivot from that wrong element and return nav text
  // that changes slightly across pages, causing bodyChanged false positives.
  //
  // FIX: mirror the skip-generic logic used by __dealScoutPrevTitle — iterate
  // all h1[dir="auto"] elements and pick the first one whose text is not a
  // known nav label. If `hint` is provided (the current listing title from the
  // reliable prevTitle detection), prefer any h1 whose text starts with it.
  function _textAfterH1(containerEl, hint) {
    const allH1 = Array.from(containerEl.querySelectorAll('h1[dir="auto"]'));
    let h1 = null;
    if (hint) {
      const hl = hint.toLowerCase().slice(0, 20);
      h1 = allH1.find(el => el.textContent.trim().toLowerCase().startsWith(hl));
    }
    if (!h1) {
      h1 = allH1.find(el => {
        const t = el.textContent.trim().toLowerCase();
        return t && !_GENERIC_TITLES.has(t);
      });
    }
    h1 = h1 || allH1[0] || containerEl.querySelector('h1');
    if (!h1) return (containerEl.innerText || '').slice(200, 650).trim();
    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT, null);
    let buf = '', past = false, node;
    while ((node = walker.nextNode())) {
      if (!past) {
        if (h1.contains(node)) past = true;
        continue;
      }
      buf += node.textContent;
      if (buf.length >= 500) break;
    }
    return buf.slice(0, 450).trim();
  }

  // ── Auto-score on listing pages ───────────────────────────────────────────────
  // All waiting logic is inside autoScore itself — see that function's comments.

  if (isListingPage()) {
    autoScore();
  }

  // ── Message Handler (from background.js / popup) ──────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "RESCORE") {
      removePanel();
      clearTimeout(window.__dealScoutRescanTimer);
      window.__dealScoutRescanTimer = setTimeout(autoScore, 400);
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── Price Extraction ──────────────────────────────────────────────────────────
  // v0.19.9 — three-strategy approach to avoid $1 FBM badge/rating fragments
  //
  // FBM renders offer-count badges ("1 person watching") and star-rating
  // fragments as $-prefixed spans at shallow DOM depth near the listing h1.
  // A naive "find first $XX span" grabs $1 before the real price.
  //
  // Strategy priority:
  //   0. Concatenated dual-price span "$250$300" (v0.26.1 — most common reduced pattern)
  //   1. aria-label exact match (most reliable — FBM uses aria-label="$150")
  //   2. Line-through dual-price container (seller-reduced listings)
  //   3. Collect-all-candidates, filter below $2, pick shallowest/largest

  function findPrices() {
    // v0.26.39 — All strategies now exclude elements inside "similar listing" card
    // links (a[href*="/marketplace/item/"] or div[role="link"]).
    //
    // Root cause of price bleed: during SPA navigation, FBM's "Similar items"
    // sidebar stays mounted. Its listing cards each have an aria-label="$475" price
    // element. Our extractor was picking that up before the new listing's own price
    // element rendered — producing a stale price from an unrelated listing.
    //
    // Fix: _inSidebarCard(el) returns true if the element is inside another listing's
    // card. All four strategies skip such elements.
    const _inSidebarCard = el =>
      !!el.closest('a[href*="/marketplace/item/"]') ||
      !!el.closest('div[data-testid="marketplace-search-item"]') ||
      !!el.closest('[role="listitem"] a');

    let price = 0;
    let original = 0;

    // Strategy 0: concatenated dual-price span — "$CURRENT$ORIGINAL"
    // Seen on reduced listings: textContent = "$250$300" in a single span/h2.
    // The smaller of the two values is the current asking price.
    {
      const allEls = document.querySelectorAll('span, h2, h3');
      for (const el of allEls) {
        if (_inSidebarCard(el)) continue;
        const text = (el.textContent || '').trim();
        const m = text.match(/^\$([0-9,]+(?:\.[0-9]{2})?)\$([0-9,]+(?:\.[0-9]{2})?)$/);
        if (!m) continue;
        const v1 = parseFloat(m[1].replace(/,/g, ''));
        const v2 = parseFloat(m[2].replace(/,/g, ''));
        if (v1 < 2 || v2 < 2) continue;
        price    = Math.min(v1, v2);
        original = Math.max(v1, v2);
        break;
      }
    }

    // Strategy 1: aria-label match (exact, then "· In stock" shop-listing variant)
    // FBM stamps the listing price as aria-label="$150" on the h2/span near the title.
    // FBM shop/"In stock" listings use aria-label="$145 · In stock" instead.
    // Similar-listing cards also have aria-label prices — skip those.
    if (!price) {
      const ariaEls = document.querySelectorAll('[aria-label]');
      for (const el of ariaEls) {
        if (_inSidebarCard(el)) continue;
        const label = el.getAttribute('aria-label') || '';
        // Exact match OR "· In stock" / "· Available" shop listing suffix
        const m = label.match(/^\$([0-9,]+(?:\.[0-9]{2})?)(?:\s*[·•]\s*(?:In\s+stock|Available|In Stock))?$/i);
        if (m) {
          const val = parseFloat(m[1].replace(/,/g, ''));
          if (val >= 2) {
            price = val;
            break;
          }
        }
      }
    }

    // Strategy 1b: text content with "· In stock" suffix (shop listings where
    // aria-label isn't set but the price + availability appear as combined text).
    // Scans h1/h2/span/div for patterns like "$145 · In stock".
    if (!price) {
      const shopEls = document.querySelectorAll('h1, h2, h3, span, div[role="heading"]');
      for (const el of shopEls) {
        if (_inSidebarCard(el)) continue;
        const text = (el.textContent || '').trim();
        const m = text.match(/^\$([0-9,]+(?:\.[0-9]{2})?)\s*[·•·]\s*(?:In\s+stock|Available)/i);
        if (m) {
          const val = parseFloat(m[1].replace(/,/g, ''));
          if (val >= 2) { price = val; break; }
        }
      }
    }

    // Strategy 2: line-through (reduced price) container
    // FBM wraps reduced listings as: <s>$200</s> $150
    if (!price) {
      const strikeEls = document.querySelectorAll('s, [style*="line-through"]');
      for (const s of strikeEls) {
        if (_inSidebarCard(s)) continue;
        const oldText = s.textContent.trim();
        const mOld = oldText.match(/\$([0-9,]+)/);
        if (!mOld) continue;
        const oldVal = parseFloat(mOld[1].replace(/,/g, ''));
        if (oldVal < 2) continue;
        const container = s.parentElement;
        if (!container) continue;
        const sibs = Array.from(container.querySelectorAll('span, div'))
          .filter(el => el !== s && !el.contains(s));
        for (const sib of sibs) {
          const mNew = (sib.textContent || '').match(/\$([0-9,]+)/);
          if (mNew) {
            const newVal = parseFloat(mNew[1].replace(/,/g, ''));
            if (newVal >= 2 && newVal < oldVal) {
              price    = newVal;
              original = oldVal;
              break;
            }
          }
        }
        if (price) break;
      }
    }

    // Strategy 3: collect all $ candidates, filter noise, pick shallowest/largest.
    // Fallback for single-price listings like "$250" with no reduction.
    if (!price) {
      const allSpans = document.querySelectorAll('span, h2, h3, div[role]');
      const candidates = [];
      for (const el of allSpans) {
        if (_inSidebarCard(el)) continue;
        const text = (el.textContent || '').trim();
        const m = text.match(/^\$([0-9,]+(?:\.[0-9]{2})?)$/);
        if (!m) continue;
        const val = parseFloat(m[1].replace(/,/g, ''));
        if (val < 2) continue;
        let depth = 0;
        let node = el;
        while (node.parentElement) { depth++; node = node.parentElement; }
        candidates.push({ val, depth, el });
      }
      if (candidates.length) {
        candidates.sort((a, b) => a.depth - b.depth || b.val - a.val);
        price = candidates[0].val;
      }
    }

    return { price, original };
  }

  // ── Shipping Cost Extraction ───────────────────────────────────────────────────

  function findShippingCost() {
    const text = document.body.innerText || '';
    // "Shipping: $12.99" or "+$8 shipping" or "Free shipping"
    const freeMatch = /free\s+ship/i.test(text);
    if (freeMatch) return 0;
    const m = text.match(/(?:shipping|delivery)[:\s+]*\$([0-9]+(?:\.[0-9]{2})?)/i);
    if (m) return parseFloat(m[1]);
    const m2 = text.match(/\+\s*\$([0-9]+(?:\.[0-9]{2})?)\s*(?:ship|deliver)/i);
    if (m2) return parseFloat(m2[1]);
    return 0;
  }

  // ── Seller Trust Extraction ───────────────────────────────────────────────────

  function extractSellerTrust() {
    // Scope extraction to the seller information section of the page only.
    //
    // WHY: using the full document.body.innerText sweeps up the entire page —
    // sponsored sidebar cards and recommendation carousels contribute stale
    // ratings from other listings (e.g. a sidebar card with "1.1 (46 ratings)"
    // bleeds into the next listing's seller score).
    //
    // Approach: text-slice strategy — get the full body text once (O(1)),
    // locate the "Joined Facebook in" anchor (always near the seller's rating),
    // then extract a ±400 char window around it. This is both fast (no DOM
    // traversal) and precise (ratings from other listings are >400 chars away).

    const bodyText = document.body.innerText || '';

    // Find where the seller's joined-date appears in the page text
    const joinedIdx = bodyText.search(/joined\s+(?:facebook\s+)?in\s+\d{4}/i);

    // Extract a window: 400 chars before the joined date (seller name + rating
    // appear just above it) and 200 chars after (response time, badges).
    // Fallback to the first 1500 chars if joined date not found yet.
    const text = joinedIdx >= 0
      ? bodyText.slice(Math.max(0, joinedIdx - 400), joinedIdx + 200)
      : bodyText.slice(0, 1500);

    // Joined date
    const joinedMatch = text.match(/joined\s+(?:facebook\s+)?in\s+(\w+\s+\d{4}|\d{4})/i);

    // Seller rating — FBM shows these in two formats:
    //   Format A (old): "4.8 (12 ratings)" — combined
    //   Format B (new): seller name followed by "(34)" and "4.5" / "4.5 stars" separately
    let rating = null, ratingCount = 0;

    // Try combined format first
    const ratingCombined = text.match(/([0-9]\.[0-9])\s*\((\d+)\s*ratings?\)/i);
    if (ratingCombined) {
      rating = parseFloat(ratingCombined[1]);
      ratingCount = parseInt(ratingCombined[2]);
    } else {
      // Separate format: look for a decimal rating near an explicit stars/ratings label only.
      // Require the word "stars" or "ratings" to be adjacent — this prevents the regex
      // from matching decimals in prices ("$1.99"), model numbers ("11in"), or
      // nearby sponsored listing data.
      const ratingVal = text.match(/\b([1-5]\.[0-9])\s*(?:stars?|ratings?|out\s+of\s+5)[\u2605\u2606]*/i);
      if (ratingVal) rating = parseFloat(ratingVal[1]);

      // Standalone review count — "(34)" or "34 ratings" or "34 reviews"
      const countMatch = text.match(/\((\d+)\)\s*\n/) ||
                         text.match(/(\d+)\s*ratings?\b/i) ||
                         text.match(/(\d+)\s*reviews?\b/i);
      if (countMatch) ratingCount = parseInt(countMatch[1]);
    }

    // "Highly rated on Marketplace" — explicit FBM trust badge
    const highlyRated = /highly\s+rated\s+on\s+marketplace/i.test(text);
    // Treat this as a 4.5 default if we have no other rating signal
    if (highlyRated && rating === null) rating = 4.5;

    // Response rate — "Responds within an hour" or "Usually responds within a day"
    const responseMatch = text.match(/(?:responds?|response)\s+(?:within\s+)?([^.\n,]{3,40})/i);

    // Identity verified
    const verified = /identity\s+verified/i.test(text);

    // Items sold count
    const soldMatch = text.match(/(\d+)\s+items?\s+sold/i);

    return {
      joined_date:      joinedMatch  ? joinedMatch[1]        : null,
      rating:           rating,
      rating_count:     ratingCount,
      highly_rated:     highlyRated,
      response_time:    responseMatch ? responseMatch[1].trim() : null,
      identity_verified: verified,
      items_sold:       soldMatch ? parseInt(soldMatch[1]) : 0,
    };
  }

  // ── Listing Data Extraction ───────────────────────────────────────────────────

  function extractListing() {
    const { price, original } = findPrices();

    // Title — try selectors from most to least specific.
    // FBM renders multiple h1[dir="auto"] elements — nav headings like "Notifications"
    // and "Inbox" appear BEFORE the listing title in DOM order. Grabbing querySelector's
    // first match returns the wrong element. Instead, iterate ALL h1[dir="auto"] elements
    // and pick the first one that is NOT a known FBM nav/UI term.
    let title = (() => {
      for (const el of document.querySelectorAll('h1[dir="auto"]')) {
        const t = el.textContent.trim();
        if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
      }
      return '';
    })() ||
    (() => {
      // Any h1 that isn't a nav term
      for (const el of document.querySelectorAll('h1')) {
        const t = el.textContent.trim();
        if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
      }
      return '';
    })() ||
    (() => {
      // document.title on listing pages: "Item title | Facebook Marketplace, City | Facebook"
      // Reliable on hard page loads (server-rendered). Pipe-split to isolate listing name.
      const parts = document.title.split(/\s*[|]\s*/);
      return parts.find(p => !_GENERIC_TITLES.has(p.trim().toLowerCase())) || '';
    })() ||
    document.querySelector('meta[property="og:title"]')?.content?.trim() ||
    document.title;

    // Description — the long text block below the listing details.
    // IMPORTANT: Never fall back to document.body.innerText.
    // FBM's navigation always contains "Notifications" / "Inbox" / "Marketplace"
    // which Claude incorrectly flags as suspicious listing content and contaminates
    // the score verdict (e.g. "title says Notifications — low transparency").
    let description = '';
    const descEl = document.querySelector('[data-testid="marketplace-pdp-description"]')
                || document.querySelector('[class*="xz9dl007"]')  // FBM internal class
                || document.querySelector('div[dir="auto"][style*="white-space"]');
    if (descEl) {
      description = descEl.textContent.trim().slice(0, 800);
    }
    // If the description element hasn't mounted yet, leave description empty.
    // The polling in autoScore waits up to ~4.5s for the element to appear,
    // so reaching here with an empty description means the listing has no text.

    // Condition — FBM shows "Used - Like New", "New", etc.
    const conditionMatch = (document.body.innerText || '').match(
      /\b(New|Used\s*[–\-]\s*Like New|Used\s*[–\-]\s*Good|Used\s*[–\-]\s*Fair|Good|Like New|Fair|Poor|Refurbished|For Parts)\b/i
    );
    const condition = conditionMatch ? conditionMatch[1].trim() : 'Used';

    // Location
    const locationMatch = (document.body.innerText || '').match(
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?,\s*[A-Z]{2})\b/
    );
    const location = locationMatch ? locationMatch[1] : '';

    // Seller name — rough heuristic
    const sellerEl = document.querySelector('[href*="/marketplace/profile/"]');
    const sellerName = sellerEl ? sellerEl.textContent.trim().slice(0, 60) : '';

    // Image URLs — listing product photos only.
    //
    // Problem: document.querySelectorAll('img[src*="scontent"]') returns EVERY
    // Facebook CDN image on the page — product photos, seller profile avatar,
    // "similar listings" thumbnails, navbar icons. Passing a profile portrait to
    // Claude Vision causes it to analyze the wrong item and produce garbage scores.
    //
    // Fix: filter by clientWidth (the rendered layout size).
    //   • Profile avatars are displayed at ~40-80px.
    //   • Listing product photos are displayed at 300-600px.
    // We only keep images whose displayed width is ≥ 200px — these are always
    // the main product photos, never avatars or icons.
    //
    // Fallback tiers: if nothing survives the strict filter, lower the threshold
    // progressively so we always send *something* rather than an empty list.
    const _allScontent = Array.from(document.querySelectorAll('img[src*="scontent"]'));

    // Mirrors the _inSidebarCard check from findPrices() — skip images that live
    // inside another listing's card/link. FBM's "Similar items" grid renders cards
    // at ~250-300px so they pass the minW filter; we must also exclude them by DOM
    // ancestry, not just by size.
    const _isCardImage = img =>
      !!img.closest('a[href*="/marketplace/item/"]') ||
      !!img.closest('div[data-testid="marketplace-search-item"]') ||
      !!img.closest('[role="listitem"] a') ||
      !!img.closest('aside') ||
      !!img.closest('[data-testid*="sponsored"]') ||
      !!img.closest('[aria-label*="Sponsored"]');

    // Position-based filter: the listing's main photo carousel is always rendered
    // in the top portion of the page. "Similar items", "Recently viewed", and
    // sponsored recommendation carousels appear well below the fold.
    // Using absolute page position (getBoundingClientRect().top + scrollY)
    // means this is scroll-invariant — it measures from the document top, not the
    // viewport top. 900px is well above where similar-item grids appear (~1000px+)
    // while reliably capturing the main photo gallery.
    const _absTop = img => img.getBoundingClientRect().top + window.scrollY;

    const _pickImages = (minW, maxTop = 900) => _allScontent
      .filter(img => {
        if (_isCardImage(img)) return false;
        const w = img.clientWidth || img.offsetWidth || 0;
        if (w < minW) return false;
        return _absTop(img) < maxTop;             // must be in top of page
      })
      .map(img => img.src)
      .filter(src => src && src.length > 10)
      .slice(0, 3);

    const imageUrls =
      _pickImages(200).length       ? _pickImages(200)       :  // strict: large + top of page
      _pickImages(100).length       ? _pickImages(100)       :  // relaxed width, still top
      _pickImages(100, 1800).length ? _pickImages(100, 1800) :  // wider position window
      _allScontent.map(i => i.src).filter(s => s).slice(0, 3);  // last resort

    // Vehicle detection — strong signals only to avoid false positives on electronics/audio/etc.
    // "miles", "transmission", "cylinders" are excluded — too common in non-vehicle contexts.
    const vehicleText = title + ' ' + description.slice(0, 300);
    const isVehicle =
      // Year + Make + Model pattern (e.g. "2019 Honda Civic")
      /\b(20\d\d|19\d\d)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(title) ||
      // Unambiguous vehicle-only keywords
      /\b(odometer|vin\b|title\s+status|sedan|suv\b|pickup\s+truck|hatchback|minivan|motorcycle|atv\b|dirt\s*bike|sur.?ron|electric\s+bike|convertible\s+top|carfax|clean\s+title|salvage\s+title|lien\b)\b/i.test(vehicleText);

    // Multi-item / bundle detection
    const isMultiItem = /\b(bundle|lot\b|set\b|pack\b|pair\b|\d+\s*pcs|pieces|assorted|collection)\b/i.test(title + ' ' + description.slice(0, 200));

    // Shipping
    const shippingCost = findShippingCost();

    // Seller trust signals
    const sellerTrust = extractSellerTrust();

    // Listing URL
    const listingUrl = location.href;

    // True photo count — count only images in the top portion of the page.
    // The listing carousel is always in the top ~900px; sidebar/recommendation
    // images further down the page must not inflate this count.
    // We only send up to 3 URLs to the API for Vision, but the security scorer
    // needs the real carousel count so it can reason about photo quantity correctly.
    const photoCount = _allScontent.filter(img =>
      !_isCardImage(img) && _absTop(img) < 900
    ).length || imageUrls.length;

    return {
      title,
      price,
      raw_price_text: price ? '$' + price : '',
      description,
      location,
      condition,
      seller_name:    sellerName,
      listing_url:    listingUrl,
      is_multi_item:  isMultiItem,
      is_vehicle:     isVehicle,
      vehicle_details: null,
      seller_trust:   sellerTrust,
      original_price: original,
      shipping_cost:  shippingCost,
      image_urls:     imageUrls,
      photo_count:    photoCount,
    };
  }

  // ── Auto-score ─────────────────────────────────────────────────────────────────

  async function autoScore(attempt = 0) {
    if (!isListingPage()) return;

    // Mutex: if another autoScore is already running (from a concurrent pushState
    // re-injection), skip this one entirely. _onFbmNav resets this flag on every
    // navigation so the next listing always gets a fresh run.
    if (attempt === 0) {
      if (window.__dealScoutRunning) {
        console.debug('[DealScout] autoScore skipped — already running');
        return;
      }
      window.__dealScoutRunning = true;
    }

    const snapUrl = location.href;
    const myNonce = window.__dealScoutNonce;

    // ── Readiness check ───────────────────────────────────────────────────────
    // Claude handles all extraction server-side, so we only need two signals:
    //   A. Title is not stale from the previous listing (SPA nav guard).
    //   B. Page has enough text to send (>100 chars).
    //   C. For SPA navs: body content has changed from the saved fingerprint,
    //      settled (stable across two polls), and shows a price. See below.
    //
    // Max wait: 20 × 200 ms = 4 s.

    const prevTitle = window.__dealScoutPrevTitle;
    const currentTitle = (() => {
      for (const el of document.querySelectorAll('h1[dir="auto"]')) {
        const t = el.textContent.trim();
        if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
      }
      return '';
    })();

    // Stale = title still matches the listing we just LEFT (SPA, DOM not swapped yet)
    const titleIsStale = typeof prevTitle === 'string' && prevTitle !== '' &&
                         (currentTitle === prevTitle || _GENERIC_TITLES.has(currentTitle.toLowerCase()) || currentTitle === '');

    const mainEl = document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
    const mainText = mainEl.innerText || '';
    const hasContent = mainText.length > 100;

    // SPA-navigation body-render gap:
    // FBM keeps the OLD listing's body content rendered (description, price, seller)
    // while fetching the new listing — sometimes for 1–3+ seconds. Time-based waits
    // (1.2 s, 2.4 s) are unreliable because render time varies by listing and network.
    //
    // Content-fingerprint approach (only for SPA navs):
    //   1. bodyChanged — At navigation time (_onFbmNav) we saved a 450-char snippet
    //      of [role="main"].innerText. We wait until the current body text is
    //      DIFFERENT from that snapshot — meaning FBM has replaced the old content.
    //   2. bodyStable  — We then wait for the body to be IDENTICAL across two
    //      consecutive 200ms polls. This ensures React has finished its render
    //      cycle and we're not mid-update.
    //   3. hasPriceInText — The new listing's price ($N) must be visible. Skeleton
    //      loading states don't show a price, so this guards against scoring before
    //      actual content renders.
    //
    // Combined: bodyChanged + bodyStable + hasPriceInText = body has settled on
    // NEW listing content, ready to extract. Max wait: 20 × 200ms = 4s.
    const isSpaNav = typeof prevTitle === 'string' && prevTitle !== '';
    let notReady;
    // Tracks whether the body text has changed from the previous listing's fingerprint.
    // Set inside the isSpaNav block and read by the attempt-20 bleed guard below.
    let _spaBodyChanged = true;

    if (isSpaNav) {
      const prevSnippet    = window.__dealScoutPrevBodySnippet || '';
      const lastSnapshot   = window.__dealScoutLastBodySnapshot  || '';
      const lastSnapshot2  = window.__dealScoutLastBodySnapshot2 || '';

      // Compute bodySnippet using prevTitle as the h1 search hint — the SAME anchor
      // used to compute prevBodySnippet at nav time.
      //
      // WHY prevTitle, not currentTitle:
      //   prevBodySnippet was saved at nav time with _textAfterH1(mainEl, prevTitle).
      //   It anchors to the OLD listing's h1 element. If we use currentTitle here,
      //   the pivot shifts the moment the new h1 appears in the DOM — the new h1 is
      //   at a different DOM position so "_textAfterH1(mainEl, newTitle)" captures
      //   different text than "_textAfterH1(mainEl, oldTitle)", even when the old
      //   body content is still below the old h1. This causes bodyChanged=true while
      //   the old listing's content is still fully visible — the bleed.
      //
      // With prevTitle as hint:
      //   - Old h1 still in DOM → _textAfterH1 finds it → returns old body text
      //     → bodyChanged=false → keep waiting ✓
      //   - Old h1 removed from DOM → _textAfterH1 falls back to first non-generic
      //     h1 (new listing's h1) → returns new body text → bodyChanged=true ✓
      //   - Both h1s in DOM simultaneously → finds old h1 first (hint matches) →
      //     returns old body text → bodyChanged=false → keep waiting ✓
      const bodySnippet = _textAfterH1(mainEl, prevTitle);
      // Rotate the two-slot snapshot ring: slot2 ← slot1, slot1 ← current.
      window.__dealScoutLastBodySnapshot2 = lastSnapshot;
      window.__dealScoutLastBodySnapshot  = bodySnippet;

      const bodyChanged = !prevSnippet || bodySnippet !== prevSnippet;
      _spaBodyChanged = bodyChanged;

      // ── 3-poll body stability ───────────────────────────────────────────────
      // Require the body-after-h1 text to be IDENTICAL across THREE consecutive
      // 200 ms polls (600 ms window) before we trust it as settled content.
      // Root cause this fixes: FBM React renders the new listing's h1 first and
      // briefly stabilises with old body content below it (~400 ms). The old
      // 2-poll check (400 ms) was fooled by that intermediate state — bodyStable
      // fired true while the body text was still the previous listing's content,
      // causing extraction to run against stale DOM. 600 ms outlasts this window.
      const bodyStable = bodySnippet !== ''
                      && bodySnippet === lastSnapshot
                      && lastSnapshot === lastSnapshot2;

      // ── Minimum body length ─────────────────────────────────────────────────
      // If the text after the new h1 is very short (< 80 chars), only the h1
      // skeleton has rendered — the listing body content hasn't arrived yet.
      // Prevents false-positive bodyChanged when the new h1 renders alone before
      // any body content is present below it.
      const bodySnippetMinLen = bodySnippet.length >= 80;

      // Require price to be visible in the body text that sits AFTER the h1.
      // This replaces the old bodyLong (>=80) gate: it's specific (a rendered
      // price means real listing content is present) and works for short
      // listings like "Duck decoys $50" that have <80 chars after the h1.
      // Falls back to searching the full mainText if bodySnippet has no price —
      // handles edge-cases where FBM places the price above the h1 element.
      const hasPriceInBody = /(\$\s*\d|\bfree\b)/i.test(bodySnippet);
      // FBM shows "FREE" (not "$0") for free listings — match both forms.
      const hasPriceInText = /(\$\s*\d|\bfree\b)/i.test(mainText);

      // Image fingerprint: wait for the first main listing image to differ from
      // the one we had at nav time. If the old listing had no image, skip check.
      // Only enforce for the first 15 attempts (~3s) so it can't spin forever.
      const prevImgSrc  = window.__dealScoutPrevImgSrc || '';
      const curImg      = mainEl.querySelector('img[src*="scontent"]');
      const curImgSrc   = curImg ? curImg.src.split('?')[0] : '';
      const imgChanged  = !prevImgSrc || attempt >= 15 || curImgSrc !== prevImgSrc;

      // hasPriceInBody is the primary price gate (price after h1 = real content).
      // hasPriceInText is a fallback for edge-cases where price precedes the h1.
      const priceReady = hasPriceInBody || hasPriceInText;
      notReady = titleIsStale || !hasContent ||
                 !bodyChanged || !bodyStable || !bodySnippetMinLen || !priceReady || !imgChanged;

      if (attempt % 5 === 0 || (notReady && attempt > 0 && attempt % 2 === 0)) {
        console.debug('[DealScout] Readiness check', {
          attempt, titleIsStale, hasContent, bodyChanged, bodyStable,
          bodySnippetMinLen, bodyLen: bodySnippet.length,
          hasPriceInBody, hasPriceInText, priceReady, imgChanged,
        });
      }
    } else {
      // Hard page load — title and content checks are enough.
      notReady = !currentTitle || !hasContent;
    }

    if (notReady && attempt < 20) {
      await new Promise(r => setTimeout(r, 200));
      // Bail if the user navigated away — both URL and nonce must still match.
      if (location.href !== snapUrl || window.__dealScoutNonce !== myNonce) return;
      return autoScore(attempt + 1);
    }

    // ── Attempt-20 bleed guard ────────────────────────────────────────────────
    // If we timed out (notReady=true at attempt 20) on a SPA nav where the body
    // text hasn't changed from the previous listing's fingerprint, the DOM still
    // contains the OLD listing's content. Extracting now guarantees bleed.
    //
    // Root cause this fixes: clearing sentinels here → next autoScore run has
    // isSpaNav=false → no bodyChanged check → immediately extracts stale DOM.
    //
    // Fix: preserve sentinels so any subsequent autoScore (from a late background
    // re-injection or _onFbmNav pushState) still treats this as a SPA nav and
    // waits for bodyChanged=true. When the new listing's body eventually renders,
    // bodyChanged fires correctly and extraction runs cleanly.
    if (notReady && isSpaNav && !_spaBodyChanged) {
      console.debug('[DealScout] Attempt-20 timeout: body still matches previous listing — preserving sentinels to prevent bleed');
      if (window.__dealScoutNonce === myNonce) window.__dealScoutRunning = false;
      return;
    }

    console.debug('[DealScout] Page ready at attempt', attempt,
      isSpaNav ? '(SPA nav)' : '(hard load)');

    // Clear the SPA sentinels — only reached when content has actually changed
    // (bodyChanged=true) or on hard page loads (isSpaNav=false). The attempt-20
    // timeout path with an unchanged body exits above, keeping sentinels intact.
    window.__dealScoutPrevTitle          = undefined;
    window.__dealScoutPrevBodySnippet    = undefined;
    window.__dealScoutLastBodySnapshot   = undefined;
    window.__dealScoutLastBodySnapshot2  = undefined;
    window.__dealScoutPrevImgSrc         = undefined;

    // Gather raw data for server-side extraction
    const rawData = extractRaw();

    if (!rawData.raw_text || rawData.raw_text.length < 100) {
      console.debug('[DealScout] Insufficient page content — skipping');
      if (window.__dealScoutNonce === myNonce) window.__dealScoutRunning = false;
      return;
    }

    // AbortController: _onFbmNav calls abort() on navigation, cancelling the
    // in-flight stream immediately — the most reliable bleed prevention.
    const abort = new AbortController();
    window.__dealScoutAbort = abort;
    try {
      await callStreamingAPI(rawData, abort, myNonce, snapUrl);
    } catch (err) {
      if (abort.signal.aborted) return;
      if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) return;
      // "Page still loading" error from server: page content wasn't ready when we
      // extracted. Wait 2s, re-extract with a fresh DOM snapshot, and retry once.
      if (err.retryable && !rawData._retried) {
        setTimeout(async () => {
          if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) return;
          const freshData = { ...extractRaw(), _retried: true };
          if (!freshData.raw_text || freshData.raw_text.length < 100) {
            renderError('Could not read listing — please refresh the page');
            if (window.__dealScoutNonce === myNonce) window.__dealScoutRunning = false;
            return;
          }
          const abort2 = new AbortController();
          window.__dealScoutAbort = abort2;
          try {
            await callStreamingAPI(freshData, abort2, myNonce, snapUrl);
          } catch (err2) {
            if (!abort2.signal.aborted &&
                window.__dealScoutNonce === myNonce &&
                location.href === snapUrl) {
              renderError(err2.message || 'Scoring failed');
            }
          } finally {
            if (window.__dealScoutNonce === myNonce) window.__dealScoutRunning = false;
          }
        }, 2000);
        return; // finally block below releases mutex; retry re-acquires it
      }
      renderError(err.message || 'Scoring failed');
    } finally {
      // Only release the mutex if WE still own it.
      // If _onFbmNav fired during our run, it already reset __dealScoutRunning = false
      // and a newer autoScore may have set it back to true — don't evict that lock.
      if (window.__dealScoutNonce === myNonce) {
        window.__dealScoutRunning = false;
      }
    }
  }

  // ── Raw Data Extraction ───────────────────────────────────────────────────────
  // Replaces the old extractListing(). Gathers raw page text + DOM image URLs.
  // Claude Haiku on the server extracts all structured fields from the text,
  // eliminating all the fragile DOM selectors that break on FBM updates.
  //
  // Images are still DOM-extracted because:
  //   1. Claude can't see images — it only reads URLs from text, which FBM
  //      doesn't embed in page text.
  //   2. The position filter (_absTop < 900) is critical to exclude sidebar
  //      images from unrelated listings — this logic must run client-side.

  function extractRaw() {
    // Images: DOM-based, position-filtered, sidebar-excluded.
    // Self-contained so it works independently of extractListing() locals.
    const _raw_all = Array.from(document.querySelectorAll('img[src*="scontent"]'));
    const _raw_absTop = img => img.getBoundingClientRect().top + window.scrollY;
    const _raw_isCard = img =>
      !!img.closest('a[href*="/marketplace/item/"]') ||
      !!img.closest('div[data-testid="marketplace-search-item"]') ||
      !!img.closest('[role="listitem"] a') ||
      !!img.closest('aside') ||
      !!img.closest('[data-testid*="sponsored"]') ||
      !!img.closest('[aria-label*="Sponsored"]');
    // Exclude images that are invisible (hidden by CSS, zero-size, or
    // detached from the visible render tree). FBM's React renderer keeps
    // previous-listing image elements in the DOM after SPA navigation —
    // they are hidden via display:none or have zero clientWidth. Without
    // this check those stale images bleed into the next listing's score.
    const _raw_isVisible = img => {
      if (!img.offsetParent && img.tagName !== 'BODY') return false;
      const st = window.getComputedStyle(img);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = img.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const _raw_pick = (minW, maxTop = 900) => _raw_all
      .filter(img => {
        if (!_raw_isVisible(img)) return false;
        if (_raw_isCard(img)) return false;
        const w = img.clientWidth || img.offsetWidth || 0;
        if (minW && w < minW) return false;
        return _raw_absTop(img) < maxTop;
      })
      .map(img => img.src)
      .filter(src => src && src.length > 10)
      .slice(0, 3);
    const imageUrls =
      _raw_pick(200).length       ? _raw_pick(200)       :
      _raw_pick(100).length       ? _raw_pick(100)       :
      _raw_pick(100, 1800).length ? _raw_pick(100, 1800) :
      _raw_all.map(i => i.src).filter(s => s).slice(0, 3);

    // Raw text: prefer [role="main"] over full body — excludes left nav with
    // "Notifications" / "Inbox" that pollute the text sent to Claude.
    const mainEl = document.querySelector('[role="main"]')
                || document.querySelector('main')
                || document.body;

    // Build listing-focused text: include up to 200 chars before the h1 for
    // context (breadcrumbs, page-level price) then up to 3800 chars after the h1
    // (price, description, seller). Using DOM TreeWalker avoids the indexOf
    // false-match bug where a breadcrumb echoes the title above the main content.
    // Falls back to full innerText slice if no h1 found.
    // Use the same skip-generic logic as the readiness check's currentTitle
    // detection — find the first h1[dir="auto"] whose text is not a known nav
    // label (Marketplace, Messages, etc.) so we pivot the TreeWalker from the
    // actual listing-title h1, not a navigation heading.
    const _rh1 = (() => {
      const allH1 = Array.from(mainEl.querySelectorAll('h1[dir="auto"]'));
      return allH1.find(el => {
        const t = el.textContent.trim().toLowerCase();
        return t && !_GENERIC_TITLES.has(t);
      }) || allH1[0] || mainEl.querySelector('h1');
    })();
    let _rpre = '', _rpost = '', _rpast = false, _rnode;
    const _rtw = document.createTreeWalker(mainEl, NodeFilter.SHOW_TEXT, null);
    while ((_rnode = _rtw.nextNode())) {
      if (!_rpast) {
        if (_rh1 && _rh1.contains(_rnode)) { _rpast = true; _rpost += _rnode.textContent; }
        else { _rpre += _rnode.textContent; }
      } else {
        _rpost += _rnode.textContent;
        if (_rpost.length >= 3800) break;
      }
    }
    const rawText = _rh1
      ? (_rpre.slice(-200) + _rpost).slice(0, 4000)
      : (mainEl.innerText || '').slice(0, 4000);

    // True photo count for security scorer — count ALL non-card scontent images
    // within the top 900px of the page (absolute page position, scroll-invariant),
    // regardless of CSS visibility. This catches carousel frames that FBM keeps in
    // the DOM but positions off-screen horizontally (display is NOT none — they pass
    // getComputedStyle checks — but they're outside the visible carousel window).
    // We send up to 3 image URLs for Claude Vision, but the full count lets the
    // security scorer correctly assess "only N photos" risk without false positives.
    const _raw_photoCount = _raw_all.filter(img =>
      !_raw_isCard(img) && _raw_absTop(img) < 900
    ).length || imageUrls.length;

    return {
      raw_text:    rawText,
      image_urls:  imageUrls,
      photo_count: _raw_photoCount,
      platform:    'facebook_marketplace',
      listing_url: location.href,
    };
  }

  // ── Streaming API Client ─────────────────────────────────────────────────────
  // Replaces the old callScoringAPI(). Calls /score/stream and reads SSE events.
  //
  // SSE event types from the server:
  //   extracted — Claude extracted listing fields (t≈1s); panel shows title+price
  //   progress  — pipeline step label; updates spinner text
  //   score     — full DealScoreResponse; final render
  //   error     — something went wrong; shows error state
  //
  // WHY SSE INSTEAD OF POLLED FETCH:
  //   SSE is a single long-lived HTTP connection. The browser keeps reading chunks
  //   as they arrive — no polling, no WebSocket upgrade, no CORS complexity.
  //   AbortController cancels the stream at the network layer on navigation.

  async function callStreamingAPI(rawData, abort, myNonce, snapUrl) {
    // Show panel immediately with initial spinner (no title yet)
    showPanel();
    renderLoading({});

    const response = await fetch(`${API_BASE}/score/stream`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-DS-Key': DS_API_KEY },
      body:    JSON.stringify(rawData),
      signal:  abort.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `API error ${response.status}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let extractedTitle = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Navigation guards — abort the stream if user moved away
      if (abort.signal.aborted) { reader.cancel(); return; }
      if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) {
        reader.cancel();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by double newlines
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || ''; // last part may be an incomplete chunk

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));

          if (evt.type === 'progress') {
            // Re-check nonce before mutating the panel — navigation may have
            // happened between when reader.read() resolved and now. The top-of-
            // loop check guards against cross-chunk navigation, but a single
            // chunk can contain multiple events and navigation can interleave
            // between the top-of-loop check and individual event handlers.
            if (window.__dealScoutNonce !== myNonce) { reader.cancel(); return; }
            renderProgress(evt.label);

          } else if (evt.type === 'extracted') {
            if (window.__dealScoutNonce !== myNonce) { reader.cancel(); return; }
            // Title+price appear immediately (~1s into the score)
            extractedTitle = evt.data.title;
            renderLoading(evt.data);

          } else if (evt.type === 'score') {
            // Hard nonce guard — catches the race where the user navigated WHILE
            // the final score chunk was being processed. renderNavigating() clears
            // the panel, then renderResult() would overwrite it with old data.
            // Checking the nonce here (after any await points inside reader.read)
            // is the only reliable way to prevent that stale render.
            if (window.__dealScoutNonce !== myNonce) { reader.cancel(); return; }

            // Guard: title mismatch — catches the case where the DOM swapped
            // listings while streaming (text bleed passed readiness checks).
            if (extractedTitle) {
              const _words = s =>
                s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
              const scoredSet = new Set(_words(extractedTitle));
              const domTitleNow = (() => {
                for (const el of document.querySelectorAll('h1[dir="auto"]')) {
                  const t = el.textContent.trim();
                  if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
                }
                return '';
              })();
              // If the page has a non-generic title and it shares ZERO words
              // with what we scored, this is definitely stale — discard.
              if (domTitleNow && scoredSet.size > 0) {
                const overlap = _words(domTitleNow).filter(w => scoredSet.has(w)).length;
                if (overlap === 0) {
                  console.debug('[DealScout] Title mismatch — discarding stale score:',
                    extractedTitle, '→', domTitleNow);
                  return;
                }
              }
              // If domTitleNow is EMPTY (page still loading), we already passed
              // the nonce check above — safe to render.
            }

            const result = evt.data;
            // Affiliate links (fire-and-forget background message — non-critical)
            try {
              const afResp = await new Promise((res, rej) => {
                chrome.runtime.sendMessage(
                  { type: 'GET_AFFILIATE_LINKS', query: result.title, price: result.price },
                  r => chrome.runtime.lastError
                    ? rej(new Error(chrome.runtime.lastError.message))
                    : res(r)
                );
              });
              if (afResp?.success) result.affiliateLinks = afResp.links;
            } catch (_) { /* non-critical */ }

            renderScore(result);
            chrome.runtime.sendMessage({ type: 'BADGE_UPDATE', score: result.score })
              .catch(() => {});

          } else if (evt.type === 'error') {
            if (window.__dealScoutNonce !== myNonce) { reader.cancel(); return; }
            // "Page not ready" is retryable — throw so autoScore can re-extract
            // and retry rather than immediately showing an error to the user.
            if (evt.message && evt.message.includes('page may still be loading')) {
              const e = new Error(evt.message);
              e.retryable = true;
              throw e;
            }
            renderError(evt.message || 'Scoring failed');
          }

        } catch (_parseErr) {
          // Let retryable errors (e.g. "page may still be loading") bubble up to autoScore.
          // Swallow all other parse errors (malformed SSE lines).
          if (_parseErr && _parseErr.retryable) throw _parseErr;
        }
      }
    }
  }

  // ── Background Communication ──────────────────────────────────────────────────

  function sendToBackground(listing) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'SCORE_LISTING', listing },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!response || !response.success) {
              reject(new Error(response?.error || 'No response from background'));
              return;
            }
            resolve(response.result);
          }
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  // ── Panel Management ──────────────────────────────────────────────────────────

  function removePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  function showPanel() {
    removePanel();
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed',
      'top:80px',
      'right:20px',
      'width:320px',
      'max-height:calc(100vh - 100px)',
      'overflow-y:auto',
      'z-index:2147483647',
      'background:#1e1b2e',
      'border:1px solid #3d3660',
      'border-radius:10px',
      'padding:0',
      'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'font-size:13px',
      'color:#e0e0e0',
      'line-height:1.5',
    ].join(';');
    // Drag state — bound in renderHeader
    panel._ds_drag = { on: false, ox: 0, oy: 0 };
    const _onMove = (e) => {
      if (!panel._ds_drag.on) return;
      const x = Math.max(0, Math.min(e.clientX - panel._ds_drag.ox, window.innerWidth  - panel.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - panel._ds_drag.oy, window.innerHeight - panel.offsetHeight));
      panel.style.right = 'auto'; panel.style.left = x+'px'; panel.style.top = y+'px';
    };
    const _onUp = () => { panel._ds_drag.on = false; };
    document.addEventListener('mousemove', _onMove);
    document.addEventListener('mouseup',   _onUp);
    new MutationObserver(() => {
      if (!document.getElementById(PANEL_ID)) {
        document.removeEventListener('mousemove', _onMove);
        document.removeEventListener('mouseup',   _onUp);
      }
    }).observe(document.body, { childList: true });
    document.body.appendChild(panel);
    return panel;
  }

  function getPanel() {
    return document.getElementById(PANEL_ID) || showPanel();
  }

  // ── Navigation Transition State ───────────────────────────────────────────────
  // Called immediately when SPA navigation is detected, before the new DOM loads.
  // Clears the old score instantly so the user never reads a stale result.

  function renderNavigating() {
    const panel = getPanel();
    panel.innerHTML = '';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
      + 'padding:7px 10px;background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0';
    bar.innerHTML = '<span style="font-weight:700;font-size:13px;color:#7c8cf8">📊 Deal Scout '
      + '<span style="font-size:10px;color:#6b7280;font-weight:400">v' + VERSION + '</span></span>';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px';
    closeBtn.onclick = () => removePanel();
    bar.appendChild(closeBtn);
    panel.appendChild(bar);

    const body = document.createElement('div');
    body.style.cssText = 'padding:24px 12px;text-align:center;color:#6b7280';
    body.innerHTML = `
      <div style="font-size:24px;margin-bottom:8px;animation:ds-spin 1s linear infinite;display:inline-block">⟳</div>
      <div style="font-size:12px">Loading next listing…</div>
    `;
    panel.appendChild(body);

    if (!document.getElementById('ds-spin-style')) {
      const style = document.createElement('style');
      style.id = 'ds-spin-style';
      style.textContent = '@keyframes ds-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }
  }

  // ── Loading State ─────────────────────────────────────────────────────────────

  function renderLoading(listing) {
    const panel = getPanel();
    panel.innerHTML = '';

    const loadBar = document.createElement('div');
    loadBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
      + 'padding:7px 10px;background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0';
    loadBar.innerHTML = '<span style="font-weight:700;font-size:13px;color:#7c8cf8">\uD83D\uDCCA Deal Scout '
      + '<span style="font-size:10px;color:#6b7280;font-weight:400">v' + VERSION + '</span></span>';
    const lClose = document.createElement('button');
    lClose.textContent = '\u2715';
    lClose.style.cssText = 'background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px';
    lClose.onclick = () => removePanel();
    lClose.onmouseenter = () => lClose.style.color='#e0e0e0';
    lClose.onmouseleave = () => lClose.style.color='#6b7280';
    loadBar.appendChild(lClose);
    panel.appendChild(loadBar);
    const lBody = document.createElement('div');
    lBody.style.cssText = 'padding:12px';
    panel.appendChild(lBody);

    if (listing && listing.title) {
      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-weight:600;color:#e0e0e0;font-size:13px;margin-bottom:4px;line-height:1.35';
      titleEl.textContent = listing.title;
      lBody.appendChild(titleEl);

      if (listing.price) {
        const priceEl = document.createElement('div');
        priceEl.style.cssText = 'color:#7c8cf8;font-size:18px;font-weight:700;margin-bottom:10px';
        priceEl.textContent = '$' + Number(listing.price).toLocaleString();
        lBody.appendChild(priceEl);
      }
    }

    const spinner = document.createElement('div');
    spinner.style.cssText = 'text-align:center;padding:16px 0;color:#6b7280';
    spinner.innerHTML = `
      <div style="font-size:24px;margin-bottom:8px;animation:ds-spin 1s linear infinite;display:inline-block">&#x27F3;</div>
      <div id="ds-progress-label" style="font-size:12px">Analyzing deal&hellip;</div>
      <div style="font-size:11px;margin-top:4px;color:#4b5563">eBay comps &middot; AI scoring &middot; market data</div>
    `;
    lBody.appendChild(spinner);

    // Inject spinner animation if not already present
    if (!document.getElementById('ds-spin-style')) {
      const style = document.createElement('style');
      style.id = 'ds-spin-style';
      style.textContent = '@keyframes ds-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }
  }

  // Updates the spinner label while title/price are already visible.
  // Called when the API sends progress events mid-pipeline.
  function renderProgress(label) {
    const el = document.getElementById('ds-progress-label');
    if (el) el.textContent = label;
  }

  // ── Error State ───────────────────────────────────────────────────────────────

  function renderError(msg) {
    const panel = getPanel();
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <span style="font-weight:700;font-size:15px;color:#7c8cf8">&#x1F50D; Deal Scout</span>
      </div>
      <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;color:#fca5a5">
        <div style="font-weight:600;margin-bottom:4px">&#x26A0;&#xFE0F; Scoring failed</div>
        <div style="font-size:12px">${escHtml(msg)}</div>
        <div style="font-size:11px;margin-top:8px;color:#9ca3af">Check API is running at ${API_BASE}</div>
      </div>
    `;
  }

  // ── Main Score Renderer ───────────────────────────────────────────────────────

  function renderScore(r) {
    const panel = getPanel();
    panel.innerHTML = '';

    renderHeader(r, panel);
    renderAISummary(r, panel);
    renderMarketComparison(r, panel);
    renderQueryFeedback(r, panel);
    renderAIFlags(r, panel);
    renderBuyNewSection(r, panel);
    renderSecurityScore(r, panel);
    renderProductReputation(r, panel);
    renderBundleBreakdown(r, panel);
    renderNegotiationMessage(r, panel);
    renderFooter(r, panel);
  }

  // ── Header ────────────────────────────────────────────────────────────────────

  function renderHeader(r, container) {
    const scoreColor = r.score >= 8 ? '#22c55e'
                     : r.score >= 6 ? '#e6a817'
                     : r.score >= 4 ? '#f59e0b'
                     : '#ef4444';
    const ps = '$';

    // Top bar: drag handle + logo + close button
    const topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
      + 'padding:7px 10px;background:#13111f;border-bottom:1px solid #3d3660;'
      + 'border-radius:10px 10px 0 0;cursor:grab;user-select:none';

    const titleSpan = document.createElement('span');
    titleSpan.style.cssText = 'font-weight:700;font-size:13px;color:#7c8cf8;display:flex;align-items:center;gap:5px';
    titleSpan.innerHTML = '&#x1F4CA; Deal Scout '
      + '<span style="font-size:10px;color:#6b7280;font-weight:400">v' + VERSION + '</span>';
    topBar.appendChild(titleSpan);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'background:none;border:none;color:#6b7280;font-size:15px;'
      + 'line-height:1;cursor:pointer;padding:1px 4px;border-radius:3px;flex-shrink:0';
    closeBtn.onmouseenter = () => closeBtn.style.color = '#e0e0e0';
    closeBtn.onmouseleave = () => closeBtn.style.color = '#6b7280';
    closeBtn.onclick = (e) => { e.stopPropagation(); removePanel(); };
    topBar.appendChild(closeBtn);

    // Drag: mousedown on topBar starts drag
    topBar.addEventListener('mousedown', (e) => {
      if (e.target === closeBtn) return;
      const panel = document.getElementById(PANEL_ID);
      if (!panel || !panel._ds_drag) return;
      const rect = panel.getBoundingClientRect();
      panel._ds_drag.on = true;
      panel._ds_drag.ox = e.clientX - rect.left;
      panel._ds_drag.oy = e.clientY - rect.top;
      panel.style.right = 'auto';
      panel.style.left  = rect.left + 'px';
      panel.style.top   = rect.top  + 'px';
      topBar.style.cursor = 'grabbing';
      document.addEventListener('mouseup', () => { topBar.style.cursor = 'grab'; }, { once: true });
      e.preventDefault();
    });
    container.appendChild(topBar);

    // Body padding wrapper
    const body = document.createElement('div');
    body.id = PANEL_ID + '-body';
    body.style.cssText = 'padding:12px 12px 10px';
    container.appendChild(body);

    // Score circle + severity badge + verdict
    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:flex-start;gap:11px;margin-bottom:10px';

    const circle = document.createElement('div');
    circle.style.cssText = 'min-width:52px;height:52px;border-radius:50%;border:3px solid '
      + scoreColor + ';display:flex;align-items:center;justify-content:center;'
      + 'font-size:22px;font-weight:800;color:' + scoreColor + ';flex-shrink:0';
    circle.textContent = r.score;
    topRow.appendChild(circle);

    const rightCol = document.createElement('div');
    rightCol.style.cssText = 'flex:1;min-width:0;padding-top:1px';

    const sevLabel = r.score >= 8 ? 'GREAT DEAL' : r.score >= 6 ? 'FAIR DEAL' : r.score >= 4 ? 'CAUTION' : 'AVOID';
    const sevIcon  = r.score >= 6 ? '\u2705' : '\u26a0';
    const sev = document.createElement('div');
    sev.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:' + scoreColor
      + '22;border:1px solid ' + scoreColor + '66;border-radius:5px;padding:2px 8px;'
      + 'font-size:11px;font-weight:700;color:' + scoreColor + ';margin-bottom:4px';
    sev.textContent = sevIcon + ' ' + sevLabel;
    rightCol.appendChild(sev);

    const verdictEl = document.createElement('div');
    verdictEl.style.cssText = 'font-size:12px;color:#c9c9d9;line-height:1.4';
    verdictEl.textContent = r.verdict;
    rightCol.appendChild(verdictEl);

    const confEl = document.createElement('div');
    confEl.style.cssText = 'font-size:11px;color:#6b7280;margin-top:3px';
    confEl.textContent = r.ai_confidence + ' confidence \u00b7 '
      + r.model_used.replace('claude-','').replace(/-\d{8}.*$/,'');
    rightCol.appendChild(confEl);

    topRow.appendChild(rightCol);
    body.appendChild(topRow);

    // Price row
    const priceRow = document.createElement('div');
    priceRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;'
      + 'background:rgba(255,255,255,0.05);border-radius:8px;padding:8px 10px;margin-bottom:8px';
    const priceHtml = r.original_price && r.original_price > r.price
      ? '<span style="text-decoration:line-through;color:#6b7280;font-size:12px">'
        + ps + r.original_price.toFixed(0) + '</span> '
        + '<span style="font-weight:700;font-size:16px">' + ps + r.price.toFixed(0) + '</span>'
      : '<span style="font-weight:700;font-size:16px">' + ps + r.price.toFixed(0) + '</span>';
    priceRow.innerHTML = '<div><span style="color:#9ca3af;font-size:12px">Asking price </span>'
      + priceHtml + '</div>'
      + '<div><span style="color:#9ca3af;font-size:12px">Rec. offer </span>'
      + '<span style="font-weight:600;color:#7c8cf8">' + ps + r.recommended_offer.toFixed(0) + '</span></div>';
    body.appendChild(priceRow);

    // Condition / location / shipping badges
    const metaRow = document.createElement('div');
    metaRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin-bottom:4px';
    if (r.condition) metaRow.appendChild(makeBadge(r.condition, 'rgba(255,255,255,0.07)', '#9ca3af'));
    if (r.location)  metaRow.appendChild(makeBadge('\uD83D\uDCCD ' + r.location, 'rgba(99,102,241,0.15)', '#93c5fd'));
    if (r.shipping_cost > 0)
      metaRow.appendChild(makeBadge('\uD83D\uDE9A +' + ps + r.shipping_cost + ' ship', 'rgba(234,179,8,0.12)', '#fde68a'));
    body.appendChild(metaRow);
  }

  // ── AI Summary — shown above market comparison ────────────────────────────────

  function renderAISummary(r, container) {
    if (!r.summary) return;
    const body = document.getElementById(PANEL_ID + '-body');
    const wrap = body || container;
    const el = document.createElement('div');
    el.style.cssText = 'font-size:12px;color:#c9c9d9;line-height:1.6;padding:6px 0 4px';
    el.textContent = r.summary;
    wrap.appendChild(el);
  }

  // ── Market Comparison ─────────────────────────────────────────────────────────

  function renderMarketComparison(r, container) {
    const ps = '$';
    const sourceConfig = {
      gemini_search:    { color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', label: '\u2728 AI \u00b7 Live search' },
      gemini_knowledge: { color: '#c084fc', bg: 'rgba(192,132,252,0.15)', label: '\uD83E\uDDE0 AI estimate' },
      claude_knowledge: { color: '#c084fc', bg: 'rgba(192,132,252,0.15)', label: '\uD83E\uDDE0 AI estimate' },
      ebay:             { color: '#22c55e', bg: 'rgba(34,197,94,0.15)',   label: '\uD83D\uDCCA Live eBay' },
      ebay_mock:        { color: '#94a3b8', bg: 'rgba(148,163,184,0.15)', label: '\uD83D\uDCCA Est. prices' },
      correction_range: { color: '#67e8f9', bg: 'rgba(103,232,249,0.15)', label: '\uD83D\uDCCC Pinned range' },
    };
    const sc = sourceConfig[r.data_source] || sourceConfig['ebay_mock'];

    const section = document.createElement('div');
    section.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:8px 12px';

    const sectionHdr = document.createElement('div');
    sectionHdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px';
    sectionHdr.innerHTML = `
      <span style="font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#9ca3af">\uD83D\uDCC8 Market Comparison</span>
      <span style="font-size:11px;font-weight:600;color:${sc.color};background:${sc.bg};border-radius:6px;padding:2px 7px">${sc.label}</span>
    `;
    section.appendChild(sectionHdr);

    const isGemini     = r.data_source === 'gemini_search' || r.data_source === 'gemini_knowledge' || r.data_source === 'claude_knowledge';
    const isCorrection = r.data_source === 'correction_range';
    const rows = [];

    if (isGemini) {
      if (r.sold_avg) {
        const srcLabel = r.data_source === 'gemini_search' ? 'AI market avg (live)' : 'AI market avg (est.)';
        rows.push({ label: srcLabel, value: ps + r.sold_avg.toFixed(0), bold: true });
      }
      if (r.sold_low && r.sold_high) rows.push({ label: 'AI price range', value: ps + r.sold_low.toFixed(0) + ' \u2013 ' + ps + r.sold_high.toFixed(0) });
      if (r.new_price)               rows.push({ label: 'New retail',      value: ps + r.new_price.toFixed(0) });
      if (r.ai_item_id)              rows.push({ label: '\uD83D\uDCCC',    value: r.ai_item_id, mono: true });
    } else if (isCorrection) {
      if (r.sold_low && r.sold_high) rows.push({ label: 'Pinned range',  value: ps + r.sold_low.toFixed(0) + ' \u2013 ' + ps + r.sold_high.toFixed(0), bold: true });
      if (r.sold_avg)                rows.push({ label: 'Mid-point avg', value: ps + r.sold_avg.toFixed(0) });
    } else {
      // eBay or ebay_mock — show what we have
      if (r.sold_avg)                rows.push({ label: 'Est. sold avg',       value: ps + r.sold_avg.toFixed(0), bold: true });
      if (r.active_avg)              rows.push({ label: 'Est. active avg',     value: ps + r.active_avg.toFixed(0) });
      if (r.new_price)               rows.push({ label: 'New retail',          value: ps + r.new_price.toFixed(0) });
      if (r.sold_low && r.sold_high) rows.push({ label: 'Sold range',          value: ps + r.sold_low.toFixed(0) + ' \u2013 ' + ps + r.sold_high.toFixed(0) });
      // Craigslist asking prices (supplementary — city-level data, no fees/shipping)
      if (r.craigslist_asking_avg > 0) rows.push({
        label: 'CL asking avg',
        value: ps + r.craigslist_asking_avg.toFixed(0),
        sub:   '(' + (r.craigslist_count || 0) + '\u00a0local listings)',
        color: '#67e8f9',
      });
      // Always show listed price for context
      rows.push({ label: 'Listed price', value: ps + r.price.toFixed(0) });
    }
    if (r.market_confidence) rows.push({ label: 'Confidence', value: r.market_confidence });

    // Empty state — hide section entirely for ebay_mock with no real comp data.
    // An empty "No comp data" box just wastes space; the query feedback Fix button
    // already appears below to let the user correct it.
    const hasRealData = rows.some(rw => !['Confidence','Listed price'].includes(rw.label));
    if (!hasRealData && (r.data_source === 'ebay_mock' || !r.data_source)) {
      return; // Skip rendering this section — query feedback box handles UX
    }
    if (!hasRealData) {
      const noData = document.createElement('div');
      noData.style.cssText = 'font-size:12px;color:#6b7280;font-style:italic;padding:3px 0 5px';
      noData.textContent = 'No comp data \u2014 AI estimate used for scoring';
      section.appendChild(noData);
    }

    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)';
      rowEl.innerHTML = `
        <span style="color:#9ca3af;font-size:12px">${escHtml(row.label)}${row.sub ? '<span style="color:#4b5563;font-size:10px;margin-left:4px">' + escHtml(row.sub) + '</span>' : ''}</span>
        <span style="font-weight:${row.bold ? '700' : '500'};font-size:${row.bold ? '14px' : '13px'};${row.color ? 'color:' + row.color + ';' : ''}${row.mono ? 'font-family:monospace;font-size:11px;color:#a78bfa' : ''}">${escHtml(row.value)}</span>
      `;
      section.appendChild(rowEl);
    }

    // Below-market / above-market delta row
    if (r.sold_avg && r.price) {
      const delta = r.price - r.sold_avg;
      const pct   = Math.abs(Math.round((delta / r.sold_avg) * 100));
      const isBelow = delta < 0;
      const dc  = isBelow ? '#22c55e' : '#ef4444';
      const dot = isBelow ? '\u25CF' : '\u25CF';
      const deltaEl = document.createElement('div');
      deltaEl.style.cssText = 'margin-top:6px;font-size:12px;font-weight:600;color:' + dc;
      deltaEl.textContent = dot + ' ' + ps + Math.abs(delta).toFixed(0)
        + (isBelow ? ' below' : ' above') + ' market ('
        + (isBelow ? '-' : '+') + pct + '%)';
      section.appendChild(deltaEl);
    }

    if (r.ai_notes) {
      const notesEl = document.createElement('div');
      notesEl.style.cssText = 'font-size:11px;color:#9ca3af;font-style:italic;margin-top:6px';
      notesEl.textContent = r.ai_notes;
      section.appendChild(notesEl);
    }
    if (r.query_used) {
      const queryEl = document.createElement('div');
      queryEl.style.cssText = 'font-size:11px;color:#4b5563;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      queryEl.title = r.query_used;
      queryEl.textContent = '\uD83D\uDD0D ' + r.query_used;
      section.appendChild(queryEl);
    }
    if (r.sold_count) {
      const cntEl = document.createElement('div');
      cntEl.style.cssText = 'font-size:11px;color:#6b7280;margin-top:4px';
      cntEl.textContent = r.ai_confidence + ' confidence \u00b7 ' + r.sold_count + ' estimated comps';
      section.appendChild(cntEl);
    }

    container.appendChild(section);
  }

  // ── Query Feedback ────────────────────────────────────────────────────────────

  function renderQueryFeedback(r, container) {
    const isMockData = r.data_source === 'ebay_mock' || r.data_source === 'suspect';
    if (!isMockData) return;

    const ps = '$';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:4px 12px 8px';

    const fixBtn = document.createElement('button');
    fixBtn.style.cssText = 'width:100%;padding:7px 10px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.4);border-radius:8px;color:#fbbf24;font-size:12px;cursor:pointer;text-align:left';
    fixBtn.textContent = '\u26A0\uFE0F Fix estimated comps \u2014 click to correct';
    wrap.appendChild(fixBtn);

    const form = document.createElement('div');
    form.style.cssText = 'display:none;margin-top:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px';
    form.innerHTML = `
      <div style="font-size:12px;color:#9ca3af;margin-bottom:6px">Correct the search query:</div>
      <input id="ds-fix-query" type="text" placeholder="e.g. Gibson Les Paul Standard guitar"
        value="${escHtml(r.query_used || r.title || '')}"
        style="width:100%;background:#111827;border:1px solid #374151;border-radius:4px;padding:6px 8px;color:#e0e0e0;font-size:12px;box-sizing:border-box;margin-bottom:6px">
      <div style="display:flex;gap:6px">
        <input id="ds-fix-low"  type="number" placeholder="${ps}Low"  style="width:50%;background:#111827;border:1px solid #374151;border-radius:4px;padding:6px 8px;color:#e0e0e0;font-size:12px;box-sizing:border-box">
        <input id="ds-fix-high" type="number" placeholder="${ps}High" style="width:50%;background:#111827;border:1px solid #374151;border-radius:4px;padding:6px 8px;color:#e0e0e0;font-size:12px;box-sizing:border-box">
      </div>
      <button id="ds-fix-save" style="margin-top:8px;width:100%;padding:6px;background:#6366f1;border:none;border-radius:4px;color:white;font-size:12px;cursor:pointer">Save correction</button>
      <div id="ds-fix-status" style="font-size:11px;margin-top:6px;color:#9ca3af"></div>
    `;
    wrap.appendChild(form);

    fixBtn.addEventListener('click', () => {
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });

    form.querySelector('#ds-fix-save').addEventListener('click', async () => {
      const saveBtn   = form.querySelector('#ds-fix-save');
      const statusEl  = form.querySelector('#ds-fix-status');
      const query     = form.querySelector('#ds-fix-query').value.trim();
      const priceLow  = parseFloat(form.querySelector('#ds-fix-low').value)  || 0;
      const priceHigh = parseFloat(form.querySelector('#ds-fix-high').value) || 0;
      if (!query) { statusEl.textContent = 'Enter a query.'; statusEl.style.color = '#ef4444'; return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving\u2026';
      try {
        const resp = await fetch(`${API_BASE}/feedback`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DS-Key': DS_API_KEY },
          body: JSON.stringify({ listing_title: r.title, bad_query: r.query_used || '', good_query: query, correct_price_low: priceLow, correct_price_high: priceHigh, notes: `data_source=${r.data_source}` }),
        });
        if (resp.ok) {
          statusEl.style.color = '#22c55e';
          statusEl.textContent = '\u2705 Saved!';
          saveBtn.textContent = '\u2713 Saved';
          setTimeout(() => { form.style.display = 'none'; fixBtn.textContent = '\u2705 Comp fixed'; fixBtn.style.color = 'rgba(34,197,94,0.6)'; }, 2000);
        } else { throw new Error(`HTTP ${resp.status}`); }
      } catch (err) {
        statusEl.style.color = '#ef4444'; statusEl.textContent = `\u274C ${err.message}`;
        saveBtn.disabled = false; saveBtn.textContent = 'Save correction';
      }
    });

    container.appendChild(wrap);
  }

  // ── AI Flags — shown below market comparison ──────────────────────────────────

  function renderAIFlags(r, container) {
    const hasFlags = (r.green_flags && r.green_flags.length) || (r.red_flags && r.red_flags.length);
    if (!hasFlags && !r.value_assessment && !r.condition_notes) return;
    const section = document.createElement('div');
    section.style.cssText = 'padding:8px 12px 4px';
    if (r.green_flags && r.green_flags.length) {
      r.green_flags.slice(0, 4).forEach(flag => {
        const f = document.createElement('div');
        f.style.cssText = 'font-size:12px;color:#86efac;margin-bottom:5px';
        f.textContent = '\u2705 ' + flag;
        section.appendChild(f);
      });
    }
    if (r.red_flags && r.red_flags.length) {
      r.red_flags.slice(0, 4).forEach(flag => {
        const f = document.createElement('div');
        f.style.cssText = 'font-size:12px;color:#fde68a;margin-bottom:5px';
        f.textContent = '\u26A0 ' + flag;
        section.appendChild(f);
      });
    }
    if (r.value_assessment) {
      const v = document.createElement('div');
      v.style.cssText = 'font-size:11px;color:#9ca3af;margin-top:4px;font-style:italic';
      v.textContent = r.value_assessment;
      section.appendChild(v);
    }
    container.appendChild(section);
  }

  // ── AI Deal Analysis (kept for compatibility, not called from renderScore) ─────

  function renderAIAnalysis(r, container) {
    const section = document.createElement('div');
    section.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin-bottom:8px';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:8px';
    hdr.textContent = '\uD83E\uDD16 AI Deal Analysis';
    section.appendChild(hdr);
    if (r.summary) {
      const el = document.createElement('div');
      el.style.cssText = 'font-size:12px;color:#d1d5db;margin-bottom:8px;line-height:1.5';
      el.textContent = r.summary;
      section.appendChild(el);
    }
    container.appendChild(section);
  }

  // ── Buy-New Section ────────────────────────────────────────────────────────────
  // PRIMARY REVENUE DRIVER. Merged banner + affiliate cards.
  //
  // FIELD NOTE: backend sends card.program_key (not card.program) and
  //   card.price_hint (string "From ~$299", not a number). Both fixed here.
  //
  // Trigger conditions (OR):
  //   a) backend buy_new_trigger=true   (used price >= 65% of new retail)
  //   b) frontend isClose: price/new_price >= 0.72  (catches ebay_mock suppression)
  //   c) affiliate_cards present → always show shop section regardless of banner

  function renderBuyNewSection(r, container) {
    const ps       = '$';
    const hasCards = r.affiliate_cards && r.affiliate_cards.length > 0;
    const hasNew   = r.new_price && r.new_price > 0;
    const ratio    = hasNew ? (r.price / r.new_price) : 0;
    const isClose  = ratio >= 0.72;
    const trigger  = r.buy_new_trigger || isClose;
    const score    = r.score || 0;

    if (!hasCards && !trigger) return;

    // ── Outer section wrapper ─────────────────────────────────────────────────
    const section = document.createElement('div');
    section.style.cssText = [
      'margin:4px 10px 12px',
      'background:linear-gradient(160deg,rgba(99,102,241,0.12) 0%,rgba(15,23,42,0.0) 60%)',
      'border:1.5px solid rgba(139,92,246,0.35)',
      'border-radius:14px',
      'padding:13px 13px 10px',
      'position:relative',
      'overflow:hidden',
    ].join(';');

    // Subtle glow strip at top-left
    const glowStrip = document.createElement('div');
    glowStrip.style.cssText = [
      'position:absolute',
      'top:0',
      'left:0',
      'right:0',
      'height:3px',
      'background:linear-gradient(90deg,#6366f1,#a855f7,#06b6d4)',
      'border-radius:14px 14px 0 0',
    ].join(';');
    section.appendChild(glowStrip);

    // ── Score-aware section header ─────────────────────────────────────────────
    // Headline + subtext varies by how good the deal is, to motivate action.
    const hdrWrap = document.createElement('div');
    hdrWrap.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:11px;margin-top:2px';

    let hdrIcon, hdrText, hdrSub;
    if (!hasCards) {
      hdrIcon = '\uD83D\uDCA1';
      hdrText = 'Buy New Instead?';
      hdrSub  = 'Asking price is close to retail.';
    } else if (score <= 3) {
      hdrIcon = '\u26A0\uFE0F';
      hdrText = 'Better Options Below';
      hdrSub  = 'This deal is overpriced. Skip it.';
    } else if (score <= 5) {
      hdrIcon = '\uD83D\uDCA1';
      hdrText = 'You Could Do Better';
      hdrSub  = 'Checkout these alternatives first.';
    } else if (score <= 7) {
      hdrIcon = '\u2705';
      hdrText = 'Solid Deal — Confirm Price';
      hdrSub  = 'Double-check before you commit.';
    } else {
      hdrIcon = '\uD83D\uDD25';
      hdrText = 'Great Deal — Verify Here';
      hdrSub  = 'Compare to make sure it\'s the best price.';
    }

    const hdrLeft = document.createElement('div');
    const hdrTitle = document.createElement('div');
    hdrTitle.style.cssText = 'font-size:13px;font-weight:800;color:#e2e8f0;letter-spacing:0.1px';
    hdrTitle.textContent = hdrIcon + ' ' + hdrText;
    const hdrSubEl = document.createElement('div');
    hdrSubEl.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:2px';
    hdrSubEl.textContent = hdrSub;
    hdrLeft.appendChild(hdrTitle);
    hdrLeft.appendChild(hdrSubEl);
    hdrWrap.appendChild(hdrLeft);

    const discTag = document.createElement('div');
    discTag.style.cssText = [
      'font-size:9px',
      'color:#475569',
      'background:rgba(71,85,105,0.18)',
      'border:1px solid rgba(71,85,105,0.3)',
      'border-radius:4px',
      'padding:2px 6px',
      'white-space:nowrap',
      'align-self:flex-start',
      'margin-top:1px',
    ].join(';');
    discTag.textContent = 'Affiliate';
    hdrWrap.appendChild(discTag);
    section.appendChild(hdrWrap);

    // ── Price-parity alert (inline, compact) ──────────────────────────────────
    if (trigger && hasNew) {
      const premium    = r.new_price - r.price;
      const premiumPct = Math.round(Math.abs(premium / r.new_price) * 100);
      const alertEl    = document.createElement('div');
      alertEl.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'background:rgba(16,185,129,0.10)',
        'border:1px solid rgba(16,185,129,0.35)',
        'border-radius:8px',
        'padding:8px 10px',
        'margin-bottom:10px',
      ].join(';');
      const alertIcon = document.createElement('span');
      alertIcon.style.cssText = 'font-size:15px;flex-shrink:0';
      alertIcon.textContent = '\uD83C\uDFF7\uFE0F';
      const alertBody = document.createElement('div');
      alertBody.style.cssText = 'flex:1;min-width:0';
      const alertLine1 = document.createElement('div');
      alertLine1.style.cssText = 'font-size:11.5px;font-weight:700;color:#6ee7b7';
      if (premium > 0) {
        alertLine1.textContent = 'Only ' + ps + premium.toFixed(0) + ' more (' + premiumPct + '% over used asking) gets you:';
      } else {
        alertLine1.textContent = 'Used asking \u2265 new retail price \u2014 buying used has no advantage:';
      }
      const alertLine2 = document.createElement('div');
      alertLine2.style.cssText = 'font-size:10.5px;color:#a7f3d0;margin-top:2px';
      alertLine2.textContent = 'Full warranty \u2022 Easy returns \u2022 Buyer protection';
      alertBody.appendChild(alertLine1);
      alertBody.appendChild(alertLine2);
      alertEl.appendChild(alertIcon);
      alertEl.appendChild(alertBody);
      section.appendChild(alertEl);
    }

    // ── Affiliate cards ────────────────────────────────────────────────────────
    if (!hasCards) { container.appendChild(section); return; }

    const STORE_COLORS = {
      amazon:       '#f97316',
      ebay:         '#22c55e',
      best_buy:     '#0046be',
      target:       '#ef4444',
      walmart:      '#0071ce',
      home_depot:   '#f96302',
      lowes:        '#004990',
      back_market:  '#16a34a',
      newegg:       '#ff6600',
      rei:          '#3d6b4f',
      sweetwater:   '#e67e22',
      autotrader:   '#e8412c',
      cargurus:     '#00968a',
      carmax:       '#003087',
      advance_auto: '#e2001a',
      carparts_com: '#f59e0b',
      guitar_center:'#c0392b',
      wayfair:      '#7b2d8b',
      dicks:        '#1e3a5f',
      chewy:        '#0c6bb1',
    };
    const STORE_ICONS = {
      amazon:       '\uD83D\uDCE6',
      ebay:         '\uD83C\uDFEA',
      best_buy:     '\uD83D\uDCBB',
      target:       '\uD83C\uDFAF',
      walmart:      '\uD83D\uDED2',
      home_depot:   '\uD83C\uDFE0',
      lowes:        '\uD83D\uDD28',
      back_market:  '\u267B\uFE0F',
      newegg:       '\uD83D\uDCBB',
      rei:          '\u26FA',
      sweetwater:   '\uD83C\uDFB8',
      autotrader:   '\uD83D\uDE97',
      cargurus:     '\uD83D\uDD0D',
      carmax:       '\uD83C\uDFE2',
      advance_auto: '\uD83D\uDD27',
      carparts_com: '\u2699\uFE0F',
      guitar_center:'\uD83C\uDFB8',
      wayfair:      '\uD83D\uDECB\uFE0F',
      dicks:        '\uD83C\uDFCB\uFE0F',
      chewy:        '\uD43E\uDC3E',
    };
    const STORE_TRUST = {
      amazon:       'Prime eligible \u2022 Free returns',
      ebay:         'Money-back guarantee \u2022 Buyer protection',
      best_buy:     'Geek Squad warranty available',
      target:       'Free drive-up pickup available',
      walmart:      'Free pickup \u2022 Easy returns',
      home_depot:   'In-store pickup \u2022 Pro discounts',
      lowes:        'In-store pickup \u2022 Military discount',
      back_market:  'Certified refurb \u2022 1-yr warranty',
      newegg:       'Tech-focused \u2022 Flash deals',
      rei:          'Member dividend \u2022 Expert staff',
      sweetwater:   'No-hassle returns \u2022 Free tech support',
      autotrader:   '$50-150 lead value \u2022 Dealer-verified',
      cargurus:     'Market price analysis \u2022 Price drop alerts',
      carmax:       'Certified inspection \u2022 5-day return',
      advance_auto: 'Free store pickup \u2022 Free battery test',
      carparts_com: 'Fast shipping \u2022 Easy returns',
      guitar_center:'45-day returns \u2022 Price match',
      wayfair:      'Free shipping over $35 \u2022 Easy returns',
      dicks:        'In-store pickup \u2022 Price match',
      chewy:        'Auto-ship savings \u2022 Vet chat',
    };

    for (const [idx, card] of r.affiliate_cards.slice(0, 3).entries()) {
      const progKey   = card.program_key || card.program || '';
      const progColor = STORE_COLORS[progKey] || '#7c8cf8';
      const progIcon  = card.icon || STORE_ICONS[progKey] || '\uD83D\uDED2';
      const trustLine = STORE_TRUST[progKey] || 'Trusted retailer';
      const storeName = card.badge_label || card.title || progKey;

      // Parse price_hint ("From ~$299") → number
      let cardPrice = 0;
      if (card.price_hint) {
        const pm = String(card.price_hint).match(/([0-9,]+(?:\.[0-9]+)?)/);
        if (pm) cardPrice = parseFloat(pm[1].replace(/,/g, ''));
      } else if (card.price) {
        cardPrice = parseFloat(card.price) || 0;
      }
      const saving = cardPrice > 0 ? (r.price - cardPrice) : 0;

      // ── Card shell ──
      const cardEl = document.createElement('a');
      cardEl.href   = card.url || '#';
      cardEl.target = '_blank';
      cardEl.rel    = 'noopener noreferrer';
      cardEl.style.cssText = [
        'display:block',
        'text-decoration:none',
        'background:rgba(15,23,42,0.55)',
        'border:1.5px solid rgba(255,255,255,0.08)',
        'border-left:4px solid ' + progColor,
        'border-radius:10px',
        'padding:11px 12px 10px',
        'margin-bottom:8px',
        'cursor:pointer',
        'transition:background 0.15s,border-color 0.15s',
        'position:relative',
      ].join(';');
      cardEl.onmouseenter = () => {
        cardEl.style.background   = 'rgba(255,255,255,0.07)';
        cardEl.style.borderColor  = progColor;
        cardEl.style.borderLeftColor = progColor;
      };
      cardEl.onmouseleave = () => {
        cardEl.style.background   = 'rgba(15,23,42,0.55)';
        cardEl.style.borderColor  = 'rgba(255,255,255,0.08)';
        cardEl.style.borderLeftColor = progColor;
      };

      // ── Top row: icon + name + price ──
      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;align-items:center;gap:9px;margin-bottom:7px';

      const iconBubble = document.createElement('div');
      iconBubble.style.cssText = [
        'width:38px',
        'height:38px',
        'border-radius:9px',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'font-size:20px',
        'flex-shrink:0',
        'background:' + progColor + '1a',
        'border:1.5px solid ' + progColor + '55',
      ].join(';');
      iconBubble.textContent = progIcon;
      topRow.appendChild(iconBubble);

      const nameStack = document.createElement('div');
      nameStack.style.cssText = 'flex:1;min-width:0';
      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-size:14px;font-weight:800;color:' + progColor +
        ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:0.1px';
      nameEl.textContent = storeName;
      const trustEl = document.createElement('div');
      trustEl.style.cssText = 'font-size:10.5px;color:#64748b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      trustEl.textContent = trustLine;
      nameStack.appendChild(nameEl);
      nameStack.appendChild(trustEl);
      topRow.appendChild(nameStack);

      // Price block (right-aligned in top row)
      if (cardPrice > 0) {
        const priceStack = document.createElement('div');
        priceStack.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;gap:2px';
        const priceEl = document.createElement('div');
        priceEl.style.cssText = 'font-size:18px;font-weight:900;color:#f1f5f9;letter-spacing:-0.5px';
        priceEl.textContent = ps + cardPrice.toFixed(0);
        priceStack.appendChild(priceEl);
        if (saving > 2) {
          const savBadge = document.createElement('div');
          savBadge.style.cssText = [
            'font-size:10px',
            'font-weight:700',
            'color:#6ee7b7',
            'background:rgba(16,185,129,0.15)',
            'border:1px solid rgba(16,185,129,0.4)',
            'border-radius:5px',
            'padding:1px 7px',
            'white-space:nowrap',
          ].join(';');
          savBadge.textContent = ps + saving.toFixed(0) + ' less than asking';
          priceStack.appendChild(savBadge);
        } else if (saving < -2) {
          const ovBadge = document.createElement('div');
          ovBadge.style.cssText = [
            'font-size:10px',
            'font-weight:700',
            'color:#fcd34d',
            'background:rgba(251,191,36,0.10)',
            'border:1px solid rgba(251,191,36,0.3)',
            'border-radius:5px',
            'padding:1px 7px',
            'white-space:nowrap',
          ].join(';');
          ovBadge.textContent = ps + Math.abs(saving).toFixed(0) + ' pricier new';
          priceStack.appendChild(ovBadge);
        }
        topRow.appendChild(priceStack);
      }
      cardEl.appendChild(topRow);

      // ── Subtitle (card.subtitle from backend) ──
      if (card.subtitle) {
        const subEl = document.createElement('div');
        subEl.style.cssText = 'font-size:11px;color:#94a3b8;margin-bottom:8px;line-height:1.45';
        subEl.textContent = card.subtitle;
        cardEl.appendChild(subEl);
      }

      // ── Full-width CTA button ──
      const ctaBtn = document.createElement('div');
      ctaBtn.style.cssText = [
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'gap:6px',
        'background:' + progColor,
        'color:#fff',
        'font-size:12px',
        'font-weight:800',
        'letter-spacing:0.3px',
        'border-radius:7px',
        'padding:8px 0',
        'text-align:center',
      ].join(';');
      ctaBtn.textContent = cardPrice > 0
        ? 'Shop ' + storeName + ' \u2192'
        : 'Compare on ' + storeName + ' \u2192';
      cardEl.appendChild(ctaBtn);

      // ── Analytics click tracking ──
      cardEl.addEventListener('click', () => {
        try {
          chrome.runtime.sendMessage({
            type:             'AFFILIATE_CLICK',
            program:          progKey,
            category:         r.category_detected || '',
            price_bucket:     priceBucket(r.price),
            deal_score:       score,
            position:         idx + 1,
            card_type:        card.card_type        || '',
            selection_reason: card.reason           || '',
            commission_live:  !!card.commission_live,
          });
        } catch(e) {}
      });

      section.appendChild(cardEl);
    }

    container.appendChild(section);
  }

  // ── Security Score ────────────────────────────────────────────────────────────

  function renderSecurityScore(r, container) {
    const sec = r.security_score;
    if (!sec) return;
    if (sec.risk_level === 'unknown' && (!sec.flags || !sec.flags.length)) return;

    const riskConfig = {
      low:      { color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.3)',  shield: '\uD83D\uDEE1\uFE0F', label: 'LOW RISK' },
      medium:   { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.3)', shield: '\u26A0\uFE0F', label: 'CAUTION' },
      high:     { color: '#f97316', bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.4)', shield: '\u26A0\uFE0F', label: 'HIGH RISK' },
      critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.5)',  shield: '\u274C',  label: 'LIKELY SCAM' },
    };
    const cfg = riskConfig[sec.risk_level] || riskConfig.medium;

    const section = document.createElement('div');
    section.style.cssText = `background:${cfg.bg};border:1px solid ${cfg.border};border-radius:10px;padding:10px 12px;margin:4px 12px 8px`;
    section.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="font-size:16px">${cfg.shield}</span>
        <span style="font-weight:700;font-size:13px;color:${cfg.color}">${cfg.label}</span>
        <span style="margin-left:auto;font-size:11px;color:#6b7280">Security</span>
      </div>
      ${sec.recommendation ? `<div style="font-size:12px;color:#d1d5db;margin-bottom:6px">${escHtml(sec.recommendation)}</div>` : ''}
    `;
    const allFlags = [...new Set([...(sec.flags || []), ...(sec.layer1_flags || [])])];
    allFlags.slice(0, 5).forEach(flag => {
      const f = document.createElement('div');
      f.style.cssText = `font-size:12px;color:${cfg.color};margin-bottom:2px`;
      f.textContent = '\u2022 ' + flag;
      section.appendChild(f);
    });
    container.appendChild(section);
  }

  // ── Product Reputation (moved to bottom — supplementary context, not primary signal) ──

  function renderProductReputation(r, container) {
    const pe = r.product_evaluation;
    if (!pe || pe.reliability_tier === 'unknown') return;

    const tierConfig = {
      excellent: { color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   label: '\u2B50 Excellent reliability' },
      good:      { color: '#84cc16', bg: 'rgba(132,204,22,0.1)',  label: '\uD83D\uDC4D Good reliability' },
      mixed:     { color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  label: '\u26A0\uFE0F Mixed reviews' },
      poor:      { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',   label: '\uD83D\uDC4E Poor reliability' },
      unknown:   { color: '#9ca3af', bg: 'rgba(156,163,175,0.1)', label: '\u2753 Unknown reliability' },
    };
    const tc = tierConfig[pe.reliability_tier] || tierConfig.unknown;

    const section = document.createElement('div');
    section.style.cssText = `background:${tc.bg};border:1px solid ${tc.color}33;border-radius:10px;padding:10px 12px;margin:4px 12px 8px`;

    const sHdr = document.createElement('div');
    sHdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const titleSpan = document.createElement('span');
    titleSpan.style.cssText = `font-weight:600;font-size:13px;color:${tc.color}`;
    titleSpan.textContent = tc.label;
    sHdr.appendChild(titleSpan);
    if (pe.ai_powered) {
      sHdr.appendChild(makeBadge('\uD83E\uDD16 Google AI', 'rgba(167,139,250,0.15)', '#a78bfa'));
    } else if (pe.sources_used && pe.sources_used.includes('reddit')) {
      sHdr.appendChild(makeBadge('Reddit', 'rgba(148,163,184,0.15)', '#94a3b8'));
    }
    section.appendChild(sHdr);

    if (pe.product_name) {
      const el = document.createElement('div');
      el.style.cssText = 'font-size:12px;color:#9ca3af;margin-bottom:6px';
      el.textContent = pe.product_name;
      section.appendChild(el);
    }
    if (pe.strengths && pe.strengths.length) {
      pe.strengths.slice(0, 3).forEach(s => {
        const d = document.createElement('div');
        d.style.cssText = 'font-size:12px;color:#86efac;margin-bottom:2px';
        d.textContent = '\u2713 ' + s;
        section.appendChild(d);
      });
    }
    if (pe.known_issues && pe.known_issues.length) {
      pe.known_issues.slice(0, 3).forEach(issue => {
        const d = document.createElement('div');
        d.style.cssText = 'font-size:12px;color:#fde68a;margin-bottom:2px';
        d.textContent = '\u26A0 ' + issue;
        section.appendChild(d);
      });
    }
    if (pe.reddit_sentiment) {
      const el = document.createElement('div');
      el.style.cssText = 'font-size:11px;color:#9ca3af;margin-top:6px;font-style:italic';
      el.textContent = pe.reddit_sentiment;
      section.appendChild(el);
    }
    if (pe.overall_rating && pe.review_count >= 10) {
      const el = document.createElement('div');
      el.style.cssText = 'font-size:11px;color:#9ca3af;margin-top:4px';
      el.textContent = pe.overall_rating.toFixed(1) + '/5 stars \u00b7 ' + pe.review_count.toLocaleString() + ' reviews';
      section.appendChild(el);
    }
    container.appendChild(section);
  }

  // ── Footer ────────────────────────────────────────────────────────────────────

  function renderNegotiationMessage(r, container) {
    const msg = (r.negotiation_message || '').trim();
    if (!msg) return;
    const section = document.createElement('div');
    section.style.cssText = 'background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.22);border-radius:10px;padding:10px 12px;margin:4px 12px 8px';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:11px;font-weight:700;color:#22c55e;margin-bottom:6px;letter-spacing:.04em';
    hdr.textContent = '💬 NEGOTIATION MESSAGE';
    const txt = document.createElement('div');
    txt.style.cssText = 'font-size:12px;color:#cbd5e1;line-height:1.55;margin-bottom:8px';
    txt.textContent = msg;
    const btn = document.createElement('button');
    btn.style.cssText = 'width:100%;padding:5px 0;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.35);border-radius:7px;color:#22c55e;font-size:11px;font-weight:600;cursor:pointer;letter-spacing:.03em';
    btn.textContent = 'Copy Message';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(msg).then(() => {
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = 'Copy Message'; }, 2000);
      }).catch(() => {
        btn.textContent = 'Copy failed';
        setTimeout(() => { btn.textContent = 'Copy Message'; }, 2000);
      });
    });
    section.appendChild(hdr);
    section.appendChild(txt);
    section.appendChild(btn);
    container.appendChild(section);
  }

  function renderBundleBreakdown(r, container) {
    const items = Array.isArray(r.bundle_items) ? r.bundle_items : [];
    if (!items.length) return;
    const section = document.createElement('div');
    section.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:4px 12px 8px';
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:8px;letter-spacing:.04em';
    hdr.textContent = '📦 BUNDLE BREAKDOWN';
    section.appendChild(hdr);
    let total = 0;
    items.forEach(item => {
      const val = parseFloat(item.value) || 0;
      total += val;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04)';
      const name = document.createElement('span');
      name.style.color = '#cbd5e1';
      name.textContent = item.item || '';
      const price = document.createElement('span');
      price.style.cssText = 'color:#7c8cf8;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0;margin-left:8px';
      price.textContent = '$' + val.toFixed(0);
      row.appendChild(name);
      row.appendChild(price);
      section.appendChild(row);
    });
    if (total > 0) {
      const totalRow = document.createElement('div');
      totalRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:5px 0 0;margin-top:2px';
      const tLabel = document.createElement('span');
      tLabel.style.cssText = 'color:#94a3b8;font-weight:700';
      tLabel.textContent = 'Total individual value';
      const tPrice = document.createElement('span');
      tPrice.style.cssText = 'color:#22c55e;font-weight:700;font-variant-numeric:tabular-nums';
      tPrice.textContent = '$' + total.toFixed(0);
      totalRow.appendChild(tLabel);
      totalRow.appendChild(tPrice);
      section.appendChild(totalRow);
    }
    container.appendChild(section);
  }

  function renderFooter(r, container) {
    const footer = document.createElement('div');
    footer.style.cssText = 'border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;padding:10px 12px';

    if (r && r.score_id) {
      const thumbSection = document.createElement('div');
      thumbSection.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px';
      const prompt = document.createElement('div');
      prompt.style.cssText = 'font-size:11px;color:#9ca3af';
      prompt.textContent = 'Was this score accurate?';
      const thumbWrap = document.createElement('div');
      thumbWrap.style.cssText = 'display:flex;gap:8px';
      const makeThumb = (emoji, label, val) => {
        const btn = document.createElement('button');
        btn.style.cssText = 'display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:14px;color:#d1d5db';
        btn.innerHTML = emoji + ' <span style="font-size:11px">' + label + '</span>';
        btn.addEventListener('click', () => {
          if (val === 1) {
            fetch(API_BASE + '/thumbs', {
              method: 'POST', headers: {'Content-Type': 'application/json', 'X-DS-Key': DS_API_KEY},
              body: JSON.stringify({score_id: r.score_id, thumbs: 1, reason: ''}),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
            thumbWrap.innerHTML = '<span style="font-size:12px;color:#6ee7b7">✓ Thanks!</span>';
          } else {
            thumbWrap.innerHTML = '';
            const reasonRow = document.createElement('div');
            reasonRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;justify-content:center;max-width:230px';
            [['Score too high','score_too_high'],['Score too low','score_too_low'],
             ['Price wrong','price_wrong'],['Wrong category','wrong_category'],['Missing info','missing_info']
            ].forEach(([lbl, key]) => {
              const pill = document.createElement('button');
              pill.style.cssText = 'font-size:10px;padding:3px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.05);color:#d1d5db;cursor:pointer';
              pill.textContent = lbl;
              pill.addEventListener('click', (e) => {
                e.stopPropagation();
                fetch(API_BASE + '/thumbs', {
                  method: 'POST', headers: {'Content-Type': 'application/json', 'X-DS-Key': DS_API_KEY},
                  body: JSON.stringify({score_id: r.score_id, thumbs: -1, reason: key}),
                  signal: AbortSignal.timeout(5000),
                }).catch(() => {});
                thumbWrap.innerHTML = '<span style="font-size:12px;color:#6ee7b7">✓ Got it, thanks!</span>';
              });
              reasonRow.appendChild(pill);
            });
            thumbWrap.appendChild(reasonRow);
          }
        });
        return btn;
      };
      thumbWrap.appendChild(makeThumb('👍', 'Yes, accurate', 1));
      thumbWrap.appendChild(makeThumb('👎', 'No, off', -1));
      thumbSection.appendChild(prompt);
      thumbSection.appendChild(thumbWrap);
      footer.appendChild(thumbSection);
    }
    const versionEl = document.createElement('div');
    versionEl.style.cssText = 'text-align:center;font-size:10px;color:#374151;margin-top:' + (r && r.score_id ? '8px' : '0');
    versionEl.textContent = `Deal Scout v${VERSION}`;
    footer.appendChild(versionEl);
    container.appendChild(footer);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  function makeBadge(text, bg, color) {
    const span = document.createElement('span');
    span.style.cssText = `background:${bg};color:${color};border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600`;
    span.textContent = text;
    return span;
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function priceBucket(price) {
    if (!price) return 'unknown';
    if (price < 25)   return 'under_25';
    if (price < 100)  return '25_100';
    if (price < 500)  return '100_500';
    if (price < 1000) return '500_1000';
    return 'over_1000';
  }

  // ── SPA Navigation — capture prevTitle at t=0 ────────────────────────────────
  // background.js re-injects fbm.js 800ms after the LAST pushState. By then FBM
  // may have already swapped the DOM to the new listing. If we save prevTitle in
  // the guard (at 800ms) we capture the NEW title, not the old one — useless.
  //
  // Fix: intercept pushState HERE (set up once, on first injection) so we save
  // the OLD listing's title at the exact moment the user navigates (t=0), before
  // React has a chance to touch the DOM.
  //
  // Only runs in the first fbm.js instance (guard prevents re-setup on re-injection).

  const _fbmOrigPush    = history.pushState.bind(history);
  const _fbmOrigReplace = history.replaceState.bind(history);

  // Extract the numeric listing ID from a FBM marketplace URL.
  // /marketplace/item/123456789/ → "123456789"
  // /marketplace/san-diego/item/123456789/ → "123456789"
  // Returns empty string for non-listing URLs.
  function _listingIdFromUrl(href) {
    try {
      const full = new URL(String(href || ''), location.href).pathname;
      const m = full.match(/\/marketplace\/(?:[^/]+\/)?item\/(\d+)/);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  // isPopstate=true means the user pressed Back/Forward — always a real navigation.
  // pushState/replaceState pass isPopstate=false (default).
  function _onFbmNav(newUrl, isPopstate = false) {
    // Resolve the destination URL before the history mutation happens.
    const newHref = newUrl ? (() => {
      try { return new URL(String(newUrl), location.href).href; } catch (_) { return String(newUrl); }
    })() : '';

    // KEY FIX: FBM fires replaceState constantly for intra-page state updates
    // (analytics pings, chat thread IDs, scroll-position tokens, etc.) — often
    // with NO URL argument at all (replaceState(state, title) with no 3rd param).
    // Those produce newHref="" → newId="" which used to slip past the old guard
    // (which required BOTH IDs to be non-empty), causing three bugs every time:
    //   1. In-flight scoring fetch aborted → score never renders
    //   2. renderNavigating() flashes "Loading next listing…" on the same item
    //   3. Nonce increments → readiness-poller bails mid-wait
    //
    // New rule: for pushState/replaceState (not popstate), only treat as a REAL
    // navigation if the destination URL contains a DIFFERENT listing ID.
    // Anything else — same ID, no ID, or unresolvable URL — is noise: skip it.
    const oldId = _listingIdFromUrl(location.href);
    const newId = newHref ? _listingIdFromUrl(newHref) : '';

    if (!isPopstate) {
      // Not a popstate → only proceed if going to a clearly different listing.
      if (!newId || newId === oldId) {
        console.debug('[DealScout] Ignoring intra-page state update:', newHref || '(no url)');
        return;
      }
    }

    if (isListingPage() || (newHref && /\/marketplace\/(?:[^/]+\/)?item\/\d+/.test(newHref))) {
      // Abort any in-flight scoring fetch IMMEDIATELY.
      // AbortController.abort() cancels the HTTP request at the network level —
      // the fetch promise rejects with AbortError before any score data arrives.
      // This is the hardest guarantee: a cancelled request cannot bleed.
      if (window.__dealScoutAbort) {
        window.__dealScoutAbort.abort();
        window.__dealScoutAbort = null;
      }

      // Release the autoScore mutex so the new listing's autoScore can proceed.
      // Must happen BEFORE the nonce increment because the new autoScore reads
      // both flags. Clearing here means: at most one autoScore runs per listing
      // even when FBM fires multiple pushStates for a single navigation.
      window.__dealScoutRunning = false;

      // Increment the navigation nonce FIRST — this immediately invalidates any
      // in-flight autoScore call, preventing a stale score from rendering on the
      // new listing's page even if the URL guard somehow passes.
      window.__dealScoutNonce = (window.__dealScoutNonce || 0) + 1;

      // Save the title RIGHT NOW — DOM still shows the listing we're leaving.
      // Iterate all h1[dir="auto"] elements and skip known FBM nav terms so we
      // never save "Notifications" or "Inbox" as the previous listing's title.
      window.__dealScoutPrevTitle = (() => {
        for (const el of document.querySelectorAll('h1[dir="auto"]')) {
          const t = el.textContent.trim();
          if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
        }
        return '';
      })();

      // Save a body fingerprint AND first-image fingerprint of the CURRENT listing
      // at t=0. FBM keeps old content rendered while the new listing loads —
      // sometimes for 1–3+ seconds. We wait until BOTH have changed AND the body
      // has stabilised before extracting.
      const _mainNow = document.querySelector('[role="main"]') || document.body;
      // Fingerprint the text that appears AFTER the h1 element in the DOM.
      // Using DOM traversal (not indexOf) means breadcrumbs/headers that echo
      // the title above the main content area can never cause a false match.
      window.__dealScoutPrevBodySnippet  = _textAfterH1(_mainNow, window.__dealScoutPrevTitle);
      window.__dealScoutLastBodySnapshot  = '';
      window.__dealScoutLastBodySnapshot2 = '';
      // Image fingerprint — first scontent img inside [role="main"], stripped of
      // query params (CDN tokens change per-request; the path is stable per image).
      const _prevImg = _mainNow.querySelector('img[src*="scontent"]');
      window.__dealScoutPrevImgSrc = _prevImg ? _prevImg.src.split('?')[0] : '';

      console.debug('[DealScout] Nav detected (old:', oldId, '→ new:', newId || 'unknown', ') prevTitle:', window.__dealScoutPrevTitle);
      // Clear the panel IMMEDIATELY at t=0 — don't wait 800ms for bg re-injection.
      // Without this the old listing's score (including "Better Options" cards) is
      // visible for almost a second after the user clicks to navigate.
      const panel = document.getElementById(PANEL_ID);
      if (panel) renderNavigating();
    }
  }

  history.pushState    = function(state, title, url) { _onFbmNav(url, false); _fbmOrigPush(state, title, url);    };
  history.replaceState = function(state, title, url) { _onFbmNav(url, false); _fbmOrigReplace(state, title, url); };
  window.addEventListener('popstate', () => _onFbmNav('', true));

})();
