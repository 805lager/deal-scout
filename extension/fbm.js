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
  const VERSION   = "0.26.26";
  const PANEL_ID  = "deal-scout-panel";
  // API_BASE must live here (before guard) — autoScore → renderError uses it.
  let API_BASE = "https://74e2628f-3f35-45e7-a256-28e515813eca-00-1g6ldqrar1bea.spock.replit.dev/api/ds";
  // _GENERIC_TITLES must also be before the guard — autoScore references it and
  // autoScore is scheduled from the guard path on SPA re-injection. Any const/let
  // declared after the early return is in TDZ when autoScore runs. (See TDZ note above.)
  const _GENERIC_TITLES = new Set(['marketplace', 'facebook marketplace', 'facebook', '']);

  // ── Guard: prevent double-injection on SPA navigation ───────────────────────
  // background.js re-injects fbm.js on every pushState. Without this guard,
  // multiple instances would race and create duplicate sidebars.
  if (window.__dealScoutInjected) {
    // Already running — just trigger a rescore if we're on a new listing page
    if (isListingPage()) {
      // Snapshot the CURRENT title before the SPA swaps the DOM.
      // autoScore will wait until this title changes → guaranteed fresh data.
      window.__dealScoutPrevTitle = document.querySelector('h1[dir="auto"]')?.textContent?.trim() ?? '';
      clearTimeout(window.__dealScoutRescanTimer);
      window.__dealScoutRescanTimer = setTimeout(autoScore, 500);
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

  // ── Auto-score on listing pages ───────────────────────────────────────────────

  if (isListingPage()) {
    clearTimeout(window.__dealScoutRescanTimer);
    window.__dealScoutRescanTimer = setTimeout(autoScore, 1500);
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
    // v0.26.1 — Strategy 0 added for FBM concatenated price pattern "$250$300"
    // FBM renders reduced listings as a single text node with both prices jammed
    // together: "$250$300". None of the original strategies match this because they
    // all expect a single clean "$NNN" value. Strategy 0 catches it first.
    let price = 0;
    let original = 0;

    // Strategy 0: concatenated dual-price span — "$CURRENT$ORIGINAL"
    // Seen on reduced listings: textContent = "$250$300" in a single span/h2.
    // The smaller of the two values is the current asking price.
    {
      const allEls = document.querySelectorAll('span, h2, h3');
      for (const el of allEls) {
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

    // Strategy 1: aria-label exact match
    // FBM stamps the listing price as aria-label="$150" on the h2/span near the title
    if (!price) {
      const ariaEls = document.querySelectorAll('[aria-label]');
      for (const el of ariaEls) {
        const label = el.getAttribute('aria-label') || '';
        const m = label.match(/^\$([0-9,]+(?:\.[0-9]{2})?)$/);
        if (m) {
          const val = parseFloat(m[1].replace(/,/g, ''));
          if (val >= 2) {
            price = val;
            break;
          }
        }
      }
    }

    // Strategy 2: line-through (reduced price) container
    // FBM wraps reduced listings as: <s>$200</s> $150
    if (!price) {
      const strikeEls = document.querySelectorAll('s, [style*="line-through"]');
      for (const s of strikeEls) {
        const oldText = s.textContent.trim();
        const mOld = oldText.match(/\$([0-9,]+)/);
        if (!mOld) continue;
        const oldVal = parseFloat(mOld[1].replace(/,/g, ''));
        if (oldVal < 2) continue;
        // The new price should be in a sibling/parent nearby
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

    // Strategy 3: collect all $ candidates, filter noise, pick best
    // Fallback for single-price listings like "$250" with no reduction.
    if (!price) {
      const allSpans = document.querySelectorAll('span, h2, h3, div[role]');
      const candidates = [];
      for (const el of allSpans) {
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
    const text = document.body.innerText || '';

    // Joined date
    const joinedMatch = text.match(/joined\s+(?:facebook\s+)?in\s+(\w+\s+\d{4}|\d{4})/i);

    // Seller rating — "4.8 (12 ratings)"
    const ratingMatch = text.match(/([0-9]\.[0-9])\s*\((\d+)\s*ratings?\)/i);

    // Response rate — "Responds within an hour" or "Usually responds within a day"
    const responseMatch = text.match(/(?:responds?|response)\s+(?:within\s+)?([^.\n,]{3,40})/i);

    // Identity verified
    const verified = /identity\s+verified/i.test(text);

    // Items sold count
    const soldMatch = text.match(/(\d+)\s+items?\s+sold/i);

    return {
      joined_date:    joinedMatch  ? joinedMatch[1]                    : null,
      rating:         ratingMatch  ? parseFloat(ratingMatch[1])        : null,
      rating_count:   ratingMatch  ? parseInt(ratingMatch[2])          : 0,
      response_time:  responseMatch ? responseMatch[1].trim()          : null,
      identity_verified: verified,
      items_sold:     soldMatch    ? parseInt(soldMatch[1])            : 0,
    };
  }

  // ── Listing Data Extraction ───────────────────────────────────────────────────

  function extractListing() {
    const { price, original } = findPrices();

    // Title — try selectors from most to least specific.
    // FBM marks user-generated content (listing title) with dir="auto" on h1.
    // The nav heading "Marketplace" does NOT have dir="auto".
    let title =
      document.querySelector('h1[dir="auto"]')?.textContent?.trim() ||
      (() => {
        for (const el of document.querySelectorAll('h1')) {
          const t = el.textContent.trim();
          if (t && !/^(marketplace|facebook marketplace|facebook)$/i.test(t)) return t;
        }
        return '';
      })() ||
      (() => {
        // document.title on listing pages: "Item title | Facebook"
        const parts = document.title.split(/\s*[|]\s*/);
        return parts.find(p => !/^(facebook|marketplace|facebook marketplace)$/i.test(p.trim())) || '';
      })() ||
      document.querySelector('meta[property="og:title"]')?.content?.trim() ||
      document.title;

    // Description — the long text block after the price
    let description = '';
    const descEl = document.querySelector('[data-testid="marketplace-pdp-description"]')
                || document.querySelector('[class*="description"]');
    if (descEl) {
      description = descEl.textContent.trim().slice(0, 800);
    } else {
      // Fallback: grab a block of text after the price region
      const allText = document.body.innerText;
      const idx = allText.indexOf(title);
      if (idx !== -1) {
        description = allText.slice(idx + title.length, idx + title.length + 600).trim();
      }
    }

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

    // Image URLs — first few listing images
    const imageEls = document.querySelectorAll('img[src*="scontent"]');
    const imageUrls = Array.from(imageEls)
      .map(img => img.src)
      .filter(src => src && src.length > 10)
      .slice(0, 3);

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
    };
  }

  // ── Auto-score ─────────────────────────────────────────────────────────────────

  async function autoScore(attempt = 0) {
    if (!isListingPage()) return;

    const snapUrl  = location.href;
    const prevTitle = window.__dealScoutPrevTitle; // set by guard on SPA re-injection

    // ── Wait for the DOM to show the NEW listing ─────────────────────────────
    // On SPA navigation FBM changes the URL but swaps DOM content 500-2000ms
    // later. We saved the OLD title at injection time (window.__dealScoutPrevTitle).
    // Poll until h1[dir="auto"] differs from that saved value → DOM is fresh.
    // On a hard page load prevTitle is undefined → skip the wait entirely.
    if (typeof prevTitle === 'string' && attempt < 10) {
      const currentTitle = document.querySelector('h1[dir="auto"]')?.textContent?.trim() ?? '';
      const isStillOld   = currentTitle === prevTitle;
      const isGeneric    = _GENERIC_TITLES.has(currentTitle.toLowerCase());

      if (isStillOld || isGeneric) {
        await new Promise(r => setTimeout(r, 400));
        if (location.href !== snapUrl) return; // user navigated away
        return autoScore(attempt + 1);
      }

      // h1 has changed to a real new title — clear the sentinel and proceed
      window.__dealScoutPrevTitle = undefined;
    }

    const listing = extractListing();
    if (!listing.price) {
      console.debug('[DealScout] No price found — skipping auto-score');
      return;
    }

    showPanel();
    renderLoading(listing);
    try {
      const result = await sendToBackground(listing);
      renderScore(result);
    } catch (err) {
      const msg = err.message || 'Scoring failed';
      renderError(msg.includes('listing title') ? '⏳ Page still loading — try the Score button' : msg);
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
      titleEl.style.cssText = 'font-size:12px;color:#9ca3af;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      titleEl.textContent = listing.title;
      lBody.appendChild(titleEl);
    }

    const spinner = document.createElement('div');
    spinner.style.cssText = 'text-align:center;padding:20px;color:#6b7280';
    spinner.innerHTML = `
      <div style="font-size:24px;margin-bottom:8px;animation:ds-spin 1s linear infinite;display:inline-block">&#x27F3;</div>
      <div style="font-size:12px">Analyzing deal&hellip;</div>
      <div style="font-size:11px;margin-top:4px;color:#4b5563">eBay comps &middot; AI scoring &middot; Reddit sentiment</div>
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
          method: 'POST', headers: { 'Content-Type': 'application/json' },
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
            type:         'AFFILIATE_CLICK',
            program:      progKey,
            category:     r.category_detected || '',
            price_bucket: priceBucket(r.price),
            deal_score:   score,
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
          fetch(API_BASE + '/thumbs', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({score_id: r.score_id, thumbs: val}),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
          thumbWrap.innerHTML = '<span style="font-size:12px;color:#6ee7b7">✓ Thanks for the feedback!</span>';
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

})();
