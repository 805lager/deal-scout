/**
 * fbm.js — Deal Scout Content Script for Facebook Marketplace
 * v0.31.0
 *
 * INJECTED INTO: facebook.com/marketplace/*
 * PURPOSE: Extracts listing data, sends to background.js for scoring,
 *          renders the Deal Scout panel inside the FBM sidebar.
 *
 * ARCHITECTURE (v0.29.0 — background-first scoring):
 *   Content script extracts data from the DOM, sends SCORE_LISTING to
 *   background.js service worker (which survives FBM context teardowns),
 *   then renders the result when background.js responds.
 *
 *   On re-injection after a context teardown, sends GET_CACHED_SCORE
 *   to background.js first — if the listing was already scored, renders
 *   instantly without a new API call.
 *
 * BOT DETECTION NOTES:
 *   - We read existing DOM — no Playwright, minimal user-like clicks
 *   - Only click: "See more" button to expand truncated descriptions
 *   - No form submissions, no navigation, no scrolling automation
 *   - Sidebar injection uses a div, never modifies FBM's own DOM tree
 */

(function () {
  "use strict";

  const VERSION  = '0.33.0';
  const PANEL_ID  = "deal-scout-panel";
  let API_BASE = "https://deal-scout-805lager.replit.app/api/ds";
  const DS_API_KEY = "ds_live_098caae54340d797cb216856d0cffe50";
  const _GENERIC_TITLES = new Set([
    '', 'marketplace', 'facebook marketplace', 'facebook',
    'notifications', 'inbox', 'chats', 'friends', 'watch',
    'gaming', 'groups', 'home', 'news feed', 'search', 'sponsored',
    'menu', 'messages',
  ]);

  // ── Navigation log (navLog) ──────────────────────────────────────────────────
  const _NAV_LOG_CAP = 20;
  if (!window.__dealScoutNavLog) {
    try {
      const stored = sessionStorage.getItem('ds_navLog');
      const parsed = stored ? JSON.parse(stored) : [];
      window.__dealScoutNavLog = Array.isArray(parsed) ? parsed : [];
    } catch (_e) { window.__dealScoutNavLog = []; }
  }
  function _dsNavLog(event, data) {
    const entry = { t: new Date().toISOString(), e: event, ...data };
    window.__dealScoutNavLog.push(entry);
    if (window.__dealScoutNavLog.length > _NAV_LOG_CAP) {
      window.__dealScoutNavLog.splice(0, window.__dealScoutNavLog.length - _NAV_LOG_CAP);
    }
  }
  if (!window.__dealScoutNavLogUnloadBound) {
    window.__dealScoutNavLogUnloadBound = true;
    window.addEventListener('beforeunload', () => {
      try { sessionStorage.setItem('ds_navLog', JSON.stringify(window.__dealScoutNavLog || [])); } catch (_e) {}
    });
  }

  // ── Real-time debug event stream ────────────────────────────────────────────
  if (window.__dealScoutDebugEnabled === undefined) {
    window.__dealScoutDebugEnabled = false;
    try {
      const _cached = sessionStorage.getItem('ds_debug');
      if (_cached === '1') window.__dealScoutDebugEnabled = true;
    } catch (_e) {}
  }
  if (!window.__dealScoutDebugChecked) {
    window.__dealScoutDebugChecked = true;
    try {
      chrome.storage.local.get('ds_debug', (r) => {
        window.__dealScoutDebugEnabled = !!(r && r.ds_debug);
        try { sessionStorage.setItem('ds_debug', window.__dealScoutDebugEnabled ? '1' : '0'); } catch (_e2) {}
      });
    } catch (_e) {}
  }
  let _dsDebugSeq = 0;
  function _dsDebugPost(event, data) {
    if (!window.__dealScoutDebugEnabled) return;
    const payload = {
      ts: Date.now(),
      seq: ++_dsDebugSeq,
      v: VERSION,
      event,
      url: location.href.slice(0, 150),
      urlId: _listingIdFromUrl(location.href),
      lastScoredId: window.__dealScoutLastScoredId || '',
      injected: !!window.__dealScoutInjected,
      bgReinj: !!window.__dealScoutBgReinjected,
      running: !!window.__dealScoutRunning,
      nonce: window.__dealScoutNonce || 0,
      ...data,
    };
    try {
      fetch(`${API_BASE}/nav-debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DS-Ext-Version': VERSION },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch (_e) {}
  }

  // ── Navigation nonce ─────────────────────────────────────────────────────────
  if (!window.__dealScoutLastScoredId) {
    try {
      const _ss = sessionStorage.getItem('ds_lastScored');
      if (_ss) {
        const _p = JSON.parse(_ss);
        if (_p && _p.id && _p.title) {
          window.__dealScoutLastScoredId = _p.id;
          window.__dealScoutLastScoredTitle = _p.title;
        }
      }
    } catch (_e) {}
  }
  if (window.__dealScoutPrevTitle === undefined) {
    try {
      const _ssPt = sessionStorage.getItem('ds_prevTitle');
      if (_ssPt) window.__dealScoutPrevTitle = _ssPt;
    } catch (_e) {}
  }

  if (window.__dealScoutNonce === undefined) window.__dealScoutNonce = 0;
  if (window.__dealScoutRunning === undefined) window.__dealScoutRunning = false;

  // ── Guard: prevent double-injection on SPA navigation ───────────────────────
  if (window.__dealScoutInjected) {
    if (isListingPage()) {
      const _currListingId = _listingIdFromUrl(location.href);
      if (_currListingId && window.__dealScoutLastScoredId === _currListingId) {
        _dsNavLog('bgReinjectionSkip', { reason: 'already-scored', id: _currListingId });
        _dsDebugPost('inject-bg-skip', { reason: 'already-scored', id: _currListingId });
        return;
      }
      window.__dealScoutNonce = (window.__dealScoutNonce || 0) + 1;
      window.__dealScoutRunning = false;
      window.__dealScoutBgReinjected = true;
      _dsNavLog('bgReinjection', { url: location.href.slice(0, 120), isListing: true });
      _dsDebugPost('inject-bg', { currListingId: _currListingId });
      renderNavigating();
      clearTimeout(window.__dealScoutRescanTimer);
      window.__dealScoutRescanTimer = setTimeout(autoScore, 100);
    }
    return;
  }
  window.__dealScoutInjected = true;
  window.__dealScoutBgReinjected = false;
  _dsDebugPost('inject-fresh', {});

  try {
    chrome.storage.local.get("ds_api_base", (result) => {
      if (result && result.ds_api_base) API_BASE = result.ds_api_base;
    });
  } catch (e) {}

  // ── Page Detection ────────────────────────────────────────────────────────────

  function isListingPage() {
    return /facebook\.com\/marketplace\/(item\/|[^/]+\/item\/)/.test(location.href);
  }

  // ── Auto-score on listing pages ───────────────────────────────────────────────

  if (isListingPage()) {
    autoScore();
  }

  // ── Message Handler (from background.js / popup) ──────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "RESCORE") {
      window.__dealScoutNonce = (window.__dealScoutNonce || 0) + 1;
      window.__dealScoutRunning = false;
      window.__dealScoutLastScoredId = '';
      window.__dealScoutLastScoredTitle = '';
      window.__dealScoutLastRawFingerprint = '';
      window.__dealScoutPrevTitle = undefined;
      if (window.__dealScoutAbort) {
        try { window.__dealScoutAbort.abort(); } catch (_e) {}
      }
      _persistState();
      removePanel();
      try {
        chrome.runtime.sendMessage({ type: 'CLEAR_SCORE_CACHE' }).catch(() => {});
      } catch (_e) {}
      clearTimeout(window.__dealScoutRescanTimer);
      window.__dealScoutRescanTimer = setTimeout(autoScore, 400);
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── Price Extraction ──────────────────────────────────────────────────────────

  function findPrices() {
    const _inSidebarCard = el =>
      !!el.closest('a[href*="/marketplace/item/"]') ||
      !!el.closest('div[data-testid="marketplace-search-item"]') ||
      !!el.closest('[role="listitem"] a');

    let price = 0;
    let original = 0;

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

    if (!price) {
      const ariaEls = document.querySelectorAll('[aria-label]');
      for (const el of ariaEls) {
        if (_inSidebarCard(el)) continue;
        const label = el.getAttribute('aria-label') || '';
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
    const bodyText = document.body.innerText || '';
    const joinedIdx = bodyText.search(/joined\s+(?:facebook\s+)?in\s+\d{4}/i);
    const text = joinedIdx >= 0
      ? bodyText.slice(Math.max(0, joinedIdx - 400), joinedIdx + 200)
      : bodyText.slice(0, 1500);

    const joinedMatch = text.match(/joined\s+(?:facebook\s+)?in\s+(\w+\s+\d{4}|\d{4})/i);
    let rating = null, ratingCount = 0;
    const ratingCombined = text.match(/([0-9]\.[0-9])\s*\((\d+)\s*ratings?\)/i);
    if (ratingCombined) {
      rating = parseFloat(ratingCombined[1]);
      ratingCount = parseInt(ratingCombined[2]);
    } else {
      const ratingVal = text.match(/\b([1-5]\.[0-9])\s*(?:stars?|ratings?|out\s+of\s+5)[\u2605\u2606]*/i);
      if (ratingVal) rating = parseFloat(ratingVal[1]);
      const countMatch = text.match(/\((\d+)\)\s*\n/) ||
                         text.match(/(\d+)\s*ratings?\b/i) ||
                         text.match(/(\d+)\s*reviews?\b/i);
      if (countMatch) ratingCount = parseInt(countMatch[1]);
    }
    const highlyRated = /highly\s+rated\s+on\s+marketplace/i.test(text);
    if (highlyRated && rating === null) rating = 4.5;
    const responseMatch = text.match(/(?:responds?|response)\s+(?:within\s+)?([^.\n,]{3,40})/i);
    const verified = /identity\s+verified/i.test(text);
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

    let title = (() => {
      for (const el of document.querySelectorAll('h1[dir="auto"]')) {
        const t = el.textContent.trim();
        if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
      }
      return '';
    })() ||
    (() => {
      for (const el of document.querySelectorAll('h1')) {
        const t = el.textContent.trim();
        if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
      }
      return '';
    })() ||
    (() => {
      const parts = document.title.split(/\s*[|]\s*/);
      return parts.find(p => !_GENERIC_TITLES.has(p.trim().toLowerCase())) || '';
    })() ||
    document.querySelector('meta[property="og:title"]')?.content?.trim() ||
    document.title;

    let description = '';
    const descEl = document.querySelector('[data-testid="marketplace-pdp-description"]')
                || document.querySelector('[class*="xz9dl007"]')
                || document.querySelector('div[dir="auto"][style*="white-space"]');
    if (descEl) {
      description = descEl.textContent.trim().slice(0, 4000);
    }

    const conditionMatch = (document.body.innerText || '').match(
      /\b(New|Used\s*[–\-]\s*Like New|Used\s*[–\-]\s*Good|Used\s*[–\-]\s*Fair|Good|Like New|Fair|Poor|Refurbished|For Parts)\b/i
    );
    const condition = conditionMatch ? conditionMatch[1].trim() : 'Used';

    const locationMatch = (document.body.innerText || '').match(
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?,\s*[A-Z]{2})\b/
    );
    const location = locationMatch ? locationMatch[1] : '';

    const sellerEl = document.querySelector('[href*="/marketplace/profile/"]');
    const sellerName = sellerEl ? sellerEl.textContent.trim().slice(0, 60) : '';

    const _allScontent = Array.from(document.querySelectorAll('img[src*="scontent"]'));
    const _videoPosterUrls = Array.from(document.querySelectorAll('video[poster*="scontent"]'))
      .map(v => v.poster).filter(Boolean);
    const _isCardImage = img =>
      !!img.closest('a[href*="/marketplace/item/"]') ||
      !!img.closest('div[data-testid="marketplace-search-item"]') ||
      !!img.closest('[role="listitem"] a') ||
      !!img.closest('aside') ||
      !!img.closest('[data-testid*="sponsored"]') ||
      !!img.closest('[aria-label*="Sponsored"]');
    const _absTop = img => img.getBoundingClientRect().top + window.scrollY;
    const _pickImages = (minW, maxTop = 900) => _allScontent
      .filter(img => {
        if (_isCardImage(img)) return false;
        const w = img.clientWidth || img.offsetWidth || 0;
        if (w < minW) return false;
        return _absTop(img) < maxTop;
      })
      .map(img => img.src)
      .filter(src => src && src.length > 10)
      .slice(0, 3);

    let imageUrls =
      _pickImages(200).length       ? _pickImages(200)       :
      _pickImages(100).length       ? _pickImages(100)       :
      _pickImages(100, 1800).length ? _pickImages(100, 1800) :
      _allScontent.map(i => i.src).filter(s => s).slice(0, 3);
    if (imageUrls.length === 0 && _videoPosterUrls.length > 0) {
      imageUrls = _videoPosterUrls.slice(0, 3);
    }

    const vehicleText = title + ' ' + description.slice(0, 300);
    const isVehicle =
      /\b(20\d\d|19\d\d)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(title) ||
      /\b(odometer|vin\b|title\s+status|sedan|suv\b|pickup\s+truck|hatchback|minivan|motorcycle|atv\b|dirt\s*bike|sur.?ron|electric\s+bike|convertible\s+top|carfax|clean\s+title|salvage\s+title|lien\b)\b/i.test(vehicleText);

    const isMultiItem = /\b(bundle|lot\b|set\b|pack\b|pair\b|\d+\s*pcs|pieces|assorted|collection)\b/i.test(title + ' ' + description.slice(0, 200));

    const shippingCost = findShippingCost();
    const sellerTrust = extractSellerTrust();
    const listingUrl = location.href;

    const _imgCount = _allScontent.filter(img =>
      !_isCardImage(img) && _absTop(img) < 900
    ).length;
    const _vidCount = _videoPosterUrls.length;
    const photoCount = (_imgCount + _vidCount) || imageUrls.length;

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

  // ── Raw Data Extraction ───────────────────────────────────────────────────────

  async function _expandSeeMore() {
    try {
      const { el: container } = _getListingContainer();
      const descContainer = container.querySelector('[data-testid="marketplace-pdp-description"]')
                         || container.querySelector('[class*="xz9dl007"]')
                         || container;
      const selectors = [
        'div[role="button"]',
        'span[role="button"]',
        'a[role="button"]',
        'div[tabindex="0"]',
        'span',
      ];
      let clicked = false;
      for (const sel of selectors) {
        const els = descContainer.querySelectorAll(sel);
        for (const el of els) {
          const txt = (el.textContent || '').trim().toLowerCase();
          if (txt === 'see more' || txt === 'see more…' || txt === 'see more...') {
            el.click();
            clicked = true;
            break;
          }
        }
        if (clicked) break;
      }
      if (!clicked) {
        const allBtns = container.querySelectorAll('div[role="button"], span[role="button"]');
        for (const el of allBtns) {
          const txt = (el.textContent || '').trim().toLowerCase();
          if (txt === 'see more' || txt === 'see more…' || txt === 'see more...') {
            el.click();
            clicked = true;
            break;
          }
        }
      }
      if (clicked) {
        await new Promise(r => setTimeout(r, 400));
      }
      return clicked;
    } catch (_e) {
      return false;
    }
  }

  function extractRaw() {
    const { el: container, source: containerSource, diag: containerDiag } = _getListingContainer();
    window.__dealScoutLastContainerSource = containerSource;
    window.__dealScoutLastContainerDiag = containerDiag;

    const _raw_all = Array.from(container.querySelectorAll('img[src*="scontent"]'));
    if (_raw_all.length === 0 && container !== document.body) {
      const fallback = Array.from(document.querySelectorAll('img[src*="scontent"]'));
      _raw_all.push(...fallback);
    }
    const _raw_vidPosters = Array.from((container || document).querySelectorAll('video[poster*="scontent"]'))
      .map(v => v.poster).filter(Boolean);
    const _raw_absTop = img => img.getBoundingClientRect().top + window.scrollY;
    const _raw_isCard = img =>
      !!img.closest('a[href*="/marketplace/item/"]') ||
      !!img.closest('div[data-testid="marketplace-search-item"]') ||
      !!img.closest('[role="listitem"] a') ||
      !!img.closest('aside') ||
      !!img.closest('[data-testid*="sponsored"]') ||
      !!img.closest('[aria-label*="Sponsored"]');
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
    let imageUrls =
      _raw_pick(200).length       ? _raw_pick(200)       :
      _raw_pick(100).length       ? _raw_pick(100)       :
      _raw_pick(100, 1800).length ? _raw_pick(100, 1800) :
      _raw_all.map(i => i.src).filter(s => s).slice(0, 3);
    if (imageUrls.length === 0 && _raw_vidPosters.length > 0) {
      imageUrls = _raw_vidPosters.slice(0, 3);
    }

    const _rh1 = (() => {
      const allH1 = Array.from(container.querySelectorAll('h1[dir="auto"]'));
      return allH1.find(el => {
        const t = el.textContent.trim().toLowerCase();
        return t && !_GENERIC_TITLES.has(t);
      }) || allH1[0] || container.querySelector('h1');
    })();
    let _rpre = '', _rpost = '', _rpast = false, _rnode;
    const _rtw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
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
      : (container.innerText || '').slice(0, 4000);

    const _raw_imgCount = _raw_all.filter(img =>
      !_raw_isCard(img) && _raw_absTop(img) < 900
    ).length;
    const _raw_photoCount = (_raw_imgCount + _raw_vidPosters.length) || imageUrls.length;

    return {
      raw_text:    rawText,
      image_urls:  imageUrls,
      photo_count: _raw_photoCount,
      platform:    'facebook_marketplace',
      listing_url: location.href,
      _containerSource: containerSource,
    };
  }

  // ── DOM Helpers ──────────────────────────────────────────────────────────────

  function _getListingContainer() {
    const currentId = _listingIdFromUrl(location.href);
    const diag = {
      hasRoleDialog: false,
      hasAriaModal: false,
      hasFullscreenOverlay: false,
      hasCloseBtn: false,
      overlayTextSnippet: '',
      overlayListingIds: [],
      pageListingId: currentId,
    };

    const roleDialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const ariaModals = Array.from(document.querySelectorAll('[aria-modal="true"]'));
    diag.hasRoleDialog = roleDialogs.length > 0;
    diag.hasAriaModal = ariaModals.length > 0;

    const allDialogs = [...new Set([...roleDialogs, ...ariaModals])];
    for (let i = allDialogs.length - 1; i >= 0; i--) {
      const d = allDialogs[i];
      const dText = (d.innerText || '').slice(0, 200);
      diag.overlayTextSnippet = dText;

      const links = d.querySelectorAll('a[href*="/marketplace/item/"]');
      const linkIds = [];
      for (const link of links) {
        const linkId = _listingIdFromUrl(link.href);
        if (linkId) linkIds.push(linkId);
      }
      diag.overlayListingIds = linkIds.slice(0, 5);

      if (currentId && linkIds.includes(currentId)) {
        return { el: d, source: 'dialog-link-match', diag };
      }

      const h1 = d.querySelector('h1');
      const hasListingContent = h1 && h1.textContent.trim().length > 3 &&
        d.querySelector('img[src*="scontent"]') && (d.innerText || '').length > 100;
      if (hasListingContent) {
        return { el: d, source: 'dialog-h1-content', diag };
      }
    }

    const fullscreenDivs = document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]');
    for (const div of fullscreenDivs) {
      if (div === document.body) continue;
      const rect = div.getBoundingClientRect();
      if (rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.8) {
        const h1 = div.querySelector('h1');
        if (h1 && h1.textContent.trim().length > 3 && div.querySelector('img[src*="scontent"]')) {
          diag.hasFullscreenOverlay = true;
          diag.overlayTextSnippet = (div.innerText || '').slice(0, 200);
          return { el: div, source: 'fullscreen-overlay', diag };
        }
      }
    }

    const closeButtons = document.querySelectorAll('[aria-label="Close"], [aria-label="close"]');
    diag.hasCloseBtn = closeButtons.length > 0;
    for (const btn of closeButtons) {
      let overlay = btn.parentElement;
      for (let depth = 0; depth < 8 && overlay && overlay !== document.body; depth++) {
        const h1 = overlay.querySelector('h1');
        if (h1 && h1.textContent.trim().length > 3 && overlay.querySelector('img[src*="scontent"]') && (overlay.innerText || '').length > 200) {
          diag.overlayTextSnippet = (overlay.innerText || '').slice(0, 200);
          return { el: overlay, source: 'close-btn-overlay', diag };
        }
        overlay = overlay.parentElement;
      }
    }

    const mainEl = document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
    return { el: mainEl, source: 'main', diag };
  }

  function _getCurrentH1Title() {
    const { el: container } = _getListingContainer();
    for (const el of container.querySelectorAll('h1[dir="auto"]')) {
      const t = el.textContent.trim();
      if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
    }
    for (const el of container.querySelectorAll('h1')) {
      const t = el.textContent.trim();
      if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
    }
    if (container !== document.body) {
      for (const el of document.querySelectorAll('h1[dir="auto"]')) {
        const t = el.textContent.trim();
        if (t && !_GENERIC_TITLES.has(t.toLowerCase())) return t;
      }
    }
    return '';
  }

  function _getMainImageUrl() {
    const { el: container } = _getListingContainer();
    const imgs = container.querySelectorAll('img[src*="scontent"]');
    for (const img of imgs) {
      if (img.closest('a[href*="/marketplace/item/"]')) continue;
      if (img.closest('aside')) continue;
      if (img.closest('[role="listitem"] a')) continue;
      const w = img.clientWidth || img.offsetWidth || 0;
      if (w >= 200 && img.getBoundingClientRect().top + window.scrollY < 900) {
        return img.src || '';
      }
    }
    if (container !== document.body) {
      const allImgs = document.querySelectorAll('img[src*="scontent"]');
      for (const img of allImgs) {
        if (img.closest('a[href*="/marketplace/item/"]')) continue;
        if (img.closest('aside')) continue;
        if (img.closest('[role="listitem"] a')) continue;
        const w = img.clientWidth || img.offsetWidth || 0;
        if (w >= 200 && img.getBoundingClientRect().top + window.scrollY < 900) {
          return img.src || '';
        }
      }
    }
    return '';
  }

  function _rawFingerprint(text) {
    if (!text) return '';
    const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
    return norm.slice(0, 300);
  }

  if (!window.__dealScoutLastRawFingerprint) {
    try {
      const _ssFp = sessionStorage.getItem('ds_lastRawFp');
      if (_ssFp) window.__dealScoutLastRawFingerprint = _ssFp;
    } catch (_e) {}
  }
  if (!window.__dealScoutLastRawFingerprint) window.__dealScoutLastRawFingerprint = '';

  function _persistState() {
    try { sessionStorage.setItem('ds_lastRawFp', window.__dealScoutLastRawFingerprint || ''); } catch (_e) {}
    try {
      if (typeof window.__dealScoutPrevTitle === 'string') {
        sessionStorage.setItem('ds_prevTitle', window.__dealScoutPrevTitle);
      } else {
        sessionStorage.removeItem('ds_prevTitle');
      }
    } catch (_e) {}
  }

  // ── Auto-score ─────────────────────────────────────────────────────────────────

  async function autoScore(attempt = 0) {
    if (!isListingPage()) return;

    if (attempt === 0) {
      if (window.__dealScoutRunning) {
        console.debug('[DealScout] autoScore skipped — already running');
        return;
      }
      window.__dealScoutRunning = true;
    }

    const myNonce = window.__dealScoutNonce;
    const snapUrl = location.href;
    const listingId = _listingIdFromUrl(snapUrl);
    const _diagStart = Date.now();

    if (attempt === 0) {
      _dsNavLog('autoScore', { listingId, nonce: myNonce });
      _dsDebugPost('scoring-start', { urlId: listingId });

      try {
        const cached = await new Promise((resolve, reject) => {
          try {
            chrome.runtime.sendMessage(
              { type: 'GET_CACHED_SCORE', listingId },
              (response) => {
                if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                resolve(response);
              }
            );
          } catch (e) { reject(e); }
        });

        if (cached && cached.success && cached.result) {
          if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) {
            window.__dealScoutRunning = false;
            return;
          }
          console.debug('[DealScout] Cache hit from background.js — rendering instantly');
          _dsDebugPost('bg-cache-hit', { urlId: listingId, score: cached.result.score });
          window.__dealScoutLastScoredId = listingId;
          window.__dealScoutLastScoredTitle = cached.result.title || '';
          _persistState();
          try { sessionStorage.setItem('ds_lastScored', JSON.stringify({ id: listingId, title: cached.result.title || '' })); } catch (_e) {}
          renderScore(cached.result);
          _postDiag({ listingId, cacheHit: true, score: cached.result.score, title: cached.result.title, transitionMs: 0, retries: 0 });
          window.__dealScoutRunning = false;
          return;
        }
      } catch (_e) {
        console.debug('[DealScout] Cache check failed (expected on first load):', _e.message);
      }

      if (window.__dealScoutNonce !== myNonce) { window.__dealScoutRunning = false; return; }
      showPanel();
      renderLoading({});
    }

    const prevTitle = window.__dealScoutPrevTitle;
    const currentTitle = _getCurrentH1Title();

    const titleIsStale = typeof prevTitle === 'string' &&
                         (currentTitle === prevTitle || _GENERIC_TITLES.has(currentTitle.toLowerCase()));
    const titleMissing = !currentTitle || _GENERIC_TITLES.has(currentTitle.toLowerCase());

    const { el: _readyEl } = _getListingContainer();
    const hasContent = (_readyEl.innerText || '').length > 100;

    const notReady = titleIsStale || (titleMissing && typeof prevTitle === 'string') || !hasContent;

    if (notReady && attempt < 30) {
      await new Promise(r => setTimeout(r, 300));
      if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) {
        window.__dealScoutRunning = false;
        return;
      }
      return autoScore(attempt + 1);
    }

    const _titleWaitMs = attempt * 300;
    const _titleAfterWait = _getCurrentH1Title();
    _dsDebugPost('title-settled', { urlId: listingId, attempt, waitMs: _titleWaitMs, title: _titleAfterWait.slice(0, 80), prevTitle: (prevTitle || '').slice(0, 80), timedOut: notReady });

    const _mutStart = Date.now();
    const _MUTATION_QUIET_MS = 1000;
    const _MUTATION_MAX_MS = 8000;
    let _mutationSettleMs = 0;
    try {
      await new Promise((resolve) => {
        let resolved = false;
        const done = () => { if (resolved) return; resolved = true; obs.disconnect(); clearTimeout(quietTimer); clearTimeout(maxTimer); resolve(); };
        let quietTimer = null;
        const targetEl = document.body;
        const obs = new MutationObserver(() => {
          clearTimeout(quietTimer);
          if (Date.now() - _mutStart > _MUTATION_MAX_MS) { done(); return; }
          quietTimer = setTimeout(done, _MUTATION_QUIET_MS);
        });
        obs.observe(targetEl, { childList: true, subtree: true, characterData: true });
        quietTimer = setTimeout(done, _MUTATION_QUIET_MS);
        const maxTimer = setTimeout(done, _MUTATION_MAX_MS);
      });
      _mutationSettleMs = Date.now() - _mutStart;
    } catch (_e) {
      await new Promise(r => setTimeout(r, 3000));
      _mutationSettleMs = 3000;
    }

    if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) {
      window.__dealScoutRunning = false;
      return;
    }

    _dsDebugPost('mutation-settled', { urlId: listingId, mutationSettleMs: _mutationSettleMs });

    window.__dealScoutPrevTitle = undefined;
    try { sessionStorage.removeItem('ds_prevTitle'); } catch (_e) {}

    const _seeMoreClicked = await _expandSeeMore();

    const _maxContentRetries = 8;
    const _contentRetryDelays = [500, 800, 1000, 1500, 2000, 2000, 2000, 2000];
    let rawData = null;
    let _fpRetries = 0;
    let _titleCheckRetries = 0;
    let _contentTitleMatch = false;

    for (let cAttempt = 0; cAttempt < _maxContentRetries; cAttempt++) {
      if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) {
        window.__dealScoutRunning = false;
        return;
      }

      rawData = extractRaw();
      const h1Now = _getCurrentH1Title();

      if (!rawData.raw_text || rawData.raw_text.length < 100) {
        console.debug(`[DealScout] Insufficient content (${(rawData.raw_text || '').length} chars) — retry ${cAttempt + 1}/${_maxContentRetries}`);
        _dsDebugPost('content-retry', { urlId: listingId, attempt: cAttempt + 1, rawLen: (rawData.raw_text || '').length, reason: 'insufficient' });
        await new Promise(r => setTimeout(r, _contentRetryDelays[cAttempt] || 2000));
        continue;
      }

      const fp = _rawFingerprint(rawData.raw_text);
      const prevFp = window.__dealScoutLastRawFingerprint || '';
      const fpMatch = prevFp && fp === prevFp && listingId && listingId !== window.__dealScoutLastScoredId;

      if (fpMatch) {
        _fpRetries++;
        console.debug(`[DealScout] Stale content (fingerprint match) — retry ${cAttempt + 1}/${_maxContentRetries}`);
        _dsDebugPost('fp-stale-retry', { urlId: listingId, attempt: cAttempt + 1, prevScoredId: window.__dealScoutLastScoredId });
        await new Promise(r => setTimeout(r, _contentRetryDelays[cAttempt] || 2000));
        continue;
      }

      if (h1Now && h1Now.length > 3 && !_GENERIC_TITLES.has(h1Now.toLowerCase())) {
        const h1Lower = h1Now.toLowerCase();
        const rawLower = rawData.raw_text.toLowerCase();
        const h1Words = h1Lower.split(/\s+/).filter(w => w.length > 2);
        const matchCount = h1Words.filter(w => rawLower.includes(w)).length;
        _contentTitleMatch = h1Words.length === 0 || (matchCount / h1Words.length) >= 0.5;

        if (!_contentTitleMatch) {
          _titleCheckRetries++;
          console.debug(`[DealScout] Content-title mismatch: H1="${h1Now.slice(0,40)}" not found in raw_text — retry ${cAttempt + 1}/${_maxContentRetries}`);
          _dsDebugPost('content-title-mismatch', { urlId: listingId, attempt: cAttempt + 1, h1: h1Now.slice(0, 80), rawSnippet: rawData.raw_text.slice(0, 80) });
          await new Promise(r => setTimeout(r, _contentRetryDelays[cAttempt] || 2000));
          continue;
        }
      } else {
        _contentTitleMatch = true;
      }

      break;
    }

    if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) {
      window.__dealScoutRunning = false;
      return;
    }

    if (!rawData || !rawData.raw_text || rawData.raw_text.length < 100) {
      console.debug('[DealScout] Insufficient page content after all retries — skipping');
      _dsDebugPost('content-exhausted', { urlId: listingId });
      renderError('Could not read listing — try RESCORE');
      window.__dealScoutRunning = false;
      return;
    }

    const _fpStillStale = _fpRetries > 0 && _rawFingerprint(rawData.raw_text) === (window.__dealScoutLastRawFingerprint || '') && listingId !== window.__dealScoutLastScoredId;
    if (_fpStillStale || (!_contentTitleMatch && _titleCheckRetries > 0)) {
      console.debug('[DealScout] Content still stale after all retries — aborting', { fpStale: _fpStillStale, titleMatch: _contentTitleMatch });
      _dsDebugPost('stale-abort', { urlId: listingId, fpStale: _fpStillStale, titleMatch: _contentTitleMatch, fpRetries: _fpRetries, titleCheckRetries: _titleCheckRetries });
      renderError('Listing still loading — tap RESCORE');
      window.__dealScoutRunning = false;
      return;
    }

    window.__dealScoutLastRawFingerprint = _rawFingerprint(rawData.raw_text);
    _persistState();

    const _fpMatched = _fpRetries > 0;
    const _h1AtExtract = _getCurrentH1Title();
    _dsDebugPost('extraction-done', { urlId: listingId, rawLen: rawData.raw_text.length, h1: _h1AtExtract.slice(0, 80), rawSnippet: rawData.raw_text.slice(0, 80), fpRetries: _fpRetries, fpMatched: _fpMatched, titleCheckRetries: _titleCheckRetries, contentTitleMatch: _contentTitleMatch, mutationSettleMs: _mutationSettleMs, titleWaitMs: _titleWaitMs, seeMoreClicked: _seeMoreClicked });

    const abort = new AbortController();
    window.__dealScoutAbort = abort;

    try {
      const result = await new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage(
            { type: 'SCORE_LISTING', listing: rawData, listingId },
            (response) => {
              if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
              if (!response || !response.success) { reject(new Error(response?.error || 'No response from background')); return; }
              resolve(response.result);
            }
          );
        } catch (e) { reject(e); }
      });

      if (abort.signal.aborted) return;
      if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) {
        window.__dealScoutRunning = false;
        return;
      }

      window.__dealScoutLastScoredId = listingId;
      window.__dealScoutLastScoredTitle = result.title || '';
      window.__dealScoutLastRawFingerprint = _rawFingerprint(rawData.raw_text);
      _persistState();
      try { sessionStorage.setItem('ds_lastScored', JSON.stringify({ id: listingId, title: result.title || '' })); } catch (_e) {}

      _dsDebugPost('score-complete', { scoredId: listingId, score: result.score, title: (result.title || '').slice(0, 60) });
      renderScore(result);

      const _cDiag = window.__dealScoutLastContainerDiag || {};
      _postDiag({
        listingId,
        cacheHit: false,
        score: result.score,
        title: result.title,
        verdict: result.verdict,
        price: result.price,
        condition: result.condition,
        dataSource: result.data_source,
        prevTitle: (prevTitle || '').slice(0, 80),
        currentTitle: currentTitle.slice(0, 80),
        containerSource: rawData._containerSource || window.__dealScoutLastContainerSource || 'unknown',
        dialogDetected: (rawData._containerSource || '') !== 'main',
        hasRoleDialog: !!_cDiag.hasRoleDialog,
        hasAriaModal: !!_cDiag.hasAriaModal,
        hasFullscreenOverlay: !!_cDiag.hasFullscreenOverlay,
        hasCloseBtn: !!_cDiag.hasCloseBtn,
        overlayTextSnippet: (_cDiag.overlayTextSnippet || '').slice(0, 200),
        overlayListingIds: (_cDiag.overlayListingIds || []).slice(0, 5),
        pageListingId: _cDiag.pageListingId || listingId,
        titleWaitMs: _titleWaitMs,
        mutationSettleMs: _mutationSettleMs,
        fpRetries: _fpRetries,
        fpMatched: _fpMatched,
        titleCheckRetries: _titleCheckRetries,
        contentTitleMatch: _contentTitleMatch,
        h1AtExtract: _h1AtExtract.slice(0, 80),
        rawSnippet: (rawData && rawData.raw_text ? rawData.raw_text.slice(0, 80) : ''),
        totalMs: Date.now() - _diagStart,
      });

    } catch (err) {
      if (abort.signal.aborted) return;
      if (window.__dealScoutNonce !== myNonce || location.href !== snapUrl) {
        window.__dealScoutRunning = false;
        return;
      }
      const errMsg = typeof err.message === 'string' ? err.message : String(err.message || 'Scoring failed');
      console.error('[DealScout] Scoring failed:', errMsg);
      renderError(errMsg);
    } finally {
      if (window.__dealScoutNonce === myNonce) {
        window.__dealScoutRunning = false;
      }
    }
  }

  function _postDiag(data) {
    const diag = {
      v: VERSION,
      nav: new Date().toLocaleTimeString(),
      ...data,
      navLog: (window.__dealScoutNavLog || []).slice(-10),
    };
    fetch(`${API_BASE}/diag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DS-Ext-Version': VERSION },
      body: JSON.stringify(diag),
      keepalive: true,
    }).catch(() => {});
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
      <div id="ds-progress-label" style="font-size:12px">Scoring deal&hellip;</div>
      <div style="font-size:11px;margin-top:4px;color:#4b5563">eBay comps &middot; AI scoring &middot; market data</div>
    `;
    lBody.appendChild(spinner);

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
    panel.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <span style="font-weight:700;font-size:15px;color:#7c8cf8">&#x1F50D; Deal Scout</span>
      </div>
      <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;color:#fca5a5">
        <div style="font-weight:600;margin-bottom:4px">&#x26A0;&#xFE0F; Scoring failed</div>
        <div style="font-size:12px">${escHtml(msg)}</div>
      </div>
    `;
    panel.appendChild(wrap);

    const btn = document.createElement('button');
    btn.textContent = 'RESCORE';
    btn.style.cssText = 'display:block;width:100%;margin-top:10px;padding:10px;background:#7c8cf8;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;letter-spacing:0.5px';
    btn.addEventListener('click', () => {
      window.__dealScoutNonce = (window.__dealScoutNonce || 0) + 1;
      window.__dealScoutRunning = false;
      window.__dealScoutLastScoredId = '';
      window.__dealScoutLastScoredTitle = '';
      window.__dealScoutLastRawFingerprint = '';
      window.__dealScoutPrevTitle = undefined;
      if (window.__dealScoutAbort) {
        try { window.__dealScoutAbort.abort(); } catch (_e) {}
      }
      _persistState();
      try { chrome.runtime.sendMessage({ type: 'CLEAR_SCORE_CACHE' }).catch(() => {}); } catch (_e) {}
      renderLoading({});
      clearTimeout(window.__dealScoutRescanTimer);
      window.__dealScoutRescanTimer = setTimeout(autoScore, 200);
    });
    panel.appendChild(btn);
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

    const body = document.createElement('div');
    body.id = PANEL_ID + '-body';
    body.style.cssText = 'padding:12px 12px 10px';
    container.appendChild(body);

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

    const metaRow = document.createElement('div');
    metaRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin-bottom:4px';
    if (r.condition) metaRow.appendChild(makeBadge(r.condition, 'rgba(255,255,255,0.07)', '#9ca3af'));
    if (r.location)  metaRow.appendChild(makeBadge('\uD83D\uDCCD ' + r.location, 'rgba(99,102,241,0.15)', '#93c5fd'));
    if (r.shipping_cost > 0)
      metaRow.appendChild(makeBadge('\uD83D\uDE9A +' + ps + r.shipping_cost + ' ship', 'rgba(234,179,8,0.12)', '#fde68a'));
    body.appendChild(metaRow);
  }

  // ── AI Summary ────────────────────────────────────────────────────────────────

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
      if (r.sold_avg)                rows.push({ label: 'Est. sold avg',       value: ps + r.sold_avg.toFixed(0), bold: true });
      if (r.active_avg)              rows.push({ label: 'Est. active avg',     value: ps + r.active_avg.toFixed(0) });
      if (r.new_price)               rows.push({ label: 'New retail',          value: ps + r.new_price.toFixed(0) });
      if (r.sold_low && r.sold_high) rows.push({ label: 'Sold range',          value: ps + r.sold_low.toFixed(0) + ' \u2013 ' + ps + r.sold_high.toFixed(0) });
      if (r.craigslist_asking_avg > 0) rows.push({
        label: 'CL asking avg',
        value: ps + r.craigslist_asking_avg.toFixed(0),
        sub:   '(' + (r.craigslist_count || 0) + '\u00a0local listings)',
        color: '#67e8f9',
      });
      rows.push({ label: 'Listed price', value: ps + r.price.toFixed(0) });
    }
    if (r.market_confidence) rows.push({ label: 'Confidence', value: r.market_confidence });

    const hasRealData = rows.some(rw => !['Confidence','Listed price'].includes(rw.label));
    if (!hasRealData && (r.data_source === 'ebay_mock' || !r.data_source)) {
      return;
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

    if (r.sold_avg && r.price) {
      const delta = r.price - r.sold_avg;
      const pct   = Math.abs(Math.round((delta / r.sold_avg) * 100));
      const isBelow = delta < 0;
      const dc  = isBelow ? '#22c55e' : '#ef4444';
      const dot = '\u25CF';
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
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DS-Key': DS_API_KEY, 'X-DS-Ext-Version': VERSION },
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

  // ── AI Flags ──────────────────────────────────────────────────────────────────

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

  // ── AI Deal Analysis (kept for compatibility) ─────────────────────────────────

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

  function renderBuyNewSection(r, container) {
    const ps       = '$';
    const hasCards = r.affiliate_cards && r.affiliate_cards.length > 0;
    const hasNew   = r.new_price && r.new_price > 0;
    const ratio    = hasNew ? (r.price / r.new_price) : 0;
    const isClose  = ratio >= 0.72;
    const trigger  = r.buy_new_trigger || isClose;
    const score    = r.score || 0;

    if (!hasCards && !trigger) return;

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

    if (trigger && hasNew) {
      const premium    = r.new_price - r.price;
      const premiumPct = Math.round(Math.abs(premium / r.new_price) * 100);
      const alertEl    = document.createElement('div');
      alertEl.style.cssText = 'font-size:12px;color:#fcd34d;margin-bottom:10px';
      if (premium > 0) {
        alertEl.textContent = '\uD83D\uDCA1 Only ' + ps + premium.toFixed(0) + ' (' + premiumPct + '%) more to buy new with warranty';
      } else {
        alertEl.textContent = '\u26A0\uFE0F Listed ' + ps + Math.abs(premium).toFixed(0) + ' ABOVE new retail (' + ps + r.new_price.toFixed(0) + ')';
      }
      section.appendChild(alertEl);
    }

    if (hasCards) {
      r.affiliate_cards.slice(0, 6).forEach(card => {
        const cardEl = document.createElement('div');
        cardEl.style.cssText = [
          'display:flex',
          'align-items:center',
          'gap:10px',
          'padding:9px 10px',
          'margin-bottom:6px',
          'background:rgba(255,255,255,0.04)',
          'border:1px solid rgba(255,255,255,0.08)',
          'border-radius:10px',
          'cursor:pointer',
          'transition:background 0.15s',
        ].join(';');
        cardEl.onmouseenter = () => { cardEl.style.background = 'rgba(99,102,241,0.12)'; cardEl.style.borderColor = 'rgba(99,102,241,0.35)'; };
        cardEl.onmouseleave = () => { cardEl.style.background = 'rgba(255,255,255,0.04)'; cardEl.style.borderColor = 'rgba(255,255,255,0.08)'; };

        const iconEl = document.createElement('div');
        iconEl.style.cssText = 'font-size:20px;flex-shrink:0;width:28px;text-align:center';
        const prog = (card.program_key || card.program || '').toLowerCase();
        iconEl.textContent = prog.includes('amazon') ? '\uD83D\uDCE6'
          : prog.includes('ebay') ? '\uD83D\uDED2'
          : prog.includes('walmart') ? '\uD83C\uDFEA'
          : '\uD83D\uDD17';
        cardEl.appendChild(iconEl);

        const textCol = document.createElement('div');
        textCol.style.cssText = 'flex:1;min-width:0';
        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size:12px;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        titleEl.textContent = card.title || 'View on ' + (card.program_key || card.program || 'retailer');
        textCol.appendChild(titleEl);

        const metaRow = document.createElement('div');
        metaRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:2px';
        if (card.price_hint) {
          const ph = document.createElement('span');
          ph.style.cssText = 'font-size:12px;font-weight:700;color:#7c8cf8';
          ph.textContent = card.price_hint;
          metaRow.appendChild(ph);
        }
        const progBadge = document.createElement('span');
        progBadge.style.cssText = 'font-size:10px;color:#6b7280';
        progBadge.textContent = card.program_key || card.program || '';
        metaRow.appendChild(progBadge);
        textCol.appendChild(metaRow);
        cardEl.appendChild(textCol);

        const arrow = document.createElement('div');
        arrow.style.cssText = 'font-size:14px;color:#6b7280;flex-shrink:0';
        arrow.textContent = '\u203A';
        cardEl.appendChild(arrow);

        cardEl.addEventListener('click', () => {
          if (card.url) window.open(card.url, '_blank');
          try {
            chrome.runtime.sendMessage({
              type: 'AFFILIATE_CLICK',
              program: card.program_key || card.program || '',
              category: card.category || '',
              price_bucket: priceBucket(r.price),
              card_type: card.card_type || 'affiliate',
              deal_score: r.score,
            }).catch(() => {});
          } catch (_e) {}
        });
        section.appendChild(cardEl);
      });
    }

    if (!hasCards && r.affiliateLinks) {
      const links = r.affiliateLinks;
      Object.keys(links).forEach(key => {
        const link = links[key];
        const linkEl = document.createElement('a');
        linkEl.href = link.url;
        linkEl.target = '_blank';
        linkEl.style.cssText = 'display:block;padding:6px 8px;margin-bottom:4px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#93c5fd;font-size:12px;text-decoration:none;cursor:pointer';
        linkEl.textContent = link.label;
        linkEl.onmouseenter = () => { linkEl.style.background = 'rgba(99,102,241,0.12)'; };
        linkEl.onmouseleave = () => { linkEl.style.background = 'rgba(255,255,255,0.04)'; };
        linkEl.addEventListener('click', () => {
          try {
            chrome.runtime.sendMessage({
              type: 'AFFILIATE_CLICK',
              program: key,
              category: '',
              price_bucket: priceBucket(r.price),
              card_type: 'fallback_link',
              deal_score: r.score,
            }).catch(() => {});
          } catch (_e) {}
        });
        section.appendChild(linkEl);
      });
    }

    container.appendChild(section);
  }

  // ── Security Score ────────────────────────────────────────────────────────────

  function renderSecurityScore(r, container) {
    const sec = r.security_score;
    if (!sec) return;
    const riskColor = sec.risk_level === 'low' ? '#22c55e'
                    : sec.risk_level === 'medium' ? '#fbbf24'
                    : '#ef4444';
    const section = document.createElement('div');
    section.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:8px 12px';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    hdr.innerHTML = `
      <span style="font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#9ca3af">\uD83D\uDD12 Security Check <span style="color:${riskColor};font-weight:700">${sec.score || ''}/10</span></span>
      <span style="font-size:11px;font-weight:600;color:${riskColor};background:${riskColor}22;border-radius:6px;padding:2px 7px">${sec.risk_level} risk</span>
    `;
    section.appendChild(hdr);

    if (sec.recommendation) {
      const rec = document.createElement('div');
      rec.style.cssText = 'font-size:12px;color:#d1d5db;margin-bottom:6px';
      rec.textContent = sec.recommendation;
      section.appendChild(rec);
    }

    const warnings = sec.warnings || sec.flags || [];
    if (warnings.length) {
      warnings.slice(0, 4).forEach(w => {
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:#fde68a;margin-bottom:3px;padding-left:2px';
        el.textContent = '\u26A0 ' + w;
        section.appendChild(el);
      });
    }

    if (sec.positives && sec.positives.length) {
      sec.positives.slice(0, 4).forEach(p => {
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:#86efac;margin-bottom:3px;padding-left:2px';
        el.textContent = '\u2705 ' + p;
        section.appendChild(el);
      });
    }

    if (sec.checks_run && sec.checks_run.length) {
      const checksDiv = document.createElement('div');
      checksDiv.style.cssText = 'margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)';
      const checksLabel = document.createElement('div');
      checksLabel.style.cssText = 'font-size:10px;color:#6b7280;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.3px';
      checksLabel.textContent = 'Checks performed';
      checksDiv.appendChild(checksLabel);
      sec.checks_run.forEach(c => {
        const el = document.createElement('div');
        el.style.cssText = 'font-size:10px;color:#9ca3af;margin-bottom:1px';
        el.textContent = '\u2022 ' + c;
        checksDiv.appendChild(el);
      });
      section.appendChild(checksDiv);
    }

    container.appendChild(section);
  }

  // ── Product Reputation ────────────────────────────────────────────────────────

  function renderProductReputation(r, container) {
    const pe = r.product_evaluation;
    if (!pe) return;
    const tierColor = pe.reliability_tier === 'excellent' ? '#22c55e'
                    : pe.reliability_tier === 'good' ? '#3b82f6'
                    : pe.reliability_tier === 'average' ? '#fbbf24'
                    : '#ef4444';
    const section = document.createElement('div');
    section.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:8px 12px';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    hdr.innerHTML = `
      <span style="font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#9ca3af">\u2B50 Product Reputation</span>
      <span style="font-size:11px;font-weight:600;color:${tierColor};background:${tierColor}22;border-radius:6px;padding:2px 7px">${pe.reliability_tier}</span>
    `;
    section.appendChild(hdr);

    if (pe.brand_reputation) {
      const br = document.createElement('div');
      br.style.cssText = 'font-size:12px;color:#d1d5db;margin-bottom:4px';
      br.textContent = pe.brand_reputation;
      section.appendChild(br);
    }
    if (pe.model_reputation) {
      const mr = document.createElement('div');
      mr.style.cssText = 'font-size:12px;color:#d1d5db;margin-bottom:4px';
      mr.textContent = pe.model_reputation;
      section.appendChild(mr);
    }
    if (pe.known_issues && pe.known_issues.length) {
      pe.known_issues.slice(0, 3).forEach(issue => {
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:#fde68a;margin-bottom:3px';
        el.textContent = '\u26A0 ' + issue;
        section.appendChild(el);
      });
    }
    if (pe.expected_lifespan) {
      const ls = document.createElement('div');
      ls.style.cssText = 'font-size:11px;color:#9ca3af;margin-top:4px';
      ls.textContent = '\u23F3 Expected lifespan: ' + pe.expected_lifespan;
      section.appendChild(ls);
    }

    container.appendChild(section);
  }

  // ── Bundle Breakdown ──────────────────────────────────────────────────────────

  function renderBundleBreakdown(r, container) {
    if (!r.bundle_breakdown || !r.bundle_breakdown.items || !r.bundle_breakdown.items.length) return;
    const ps = '$';
    const bb = r.bundle_breakdown;
    const section = document.createElement('div');
    section.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:8px 12px';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#9ca3af;margin-bottom:8px';
    hdr.textContent = '\uD83D\uDCE6 Bundle Breakdown';
    section.appendChild(hdr);

    bb.items.forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:12px';
      row.innerHTML = `
        <span style="color:#d1d5db">${escHtml(item.name)}</span>
        <span style="color:#7c8cf8;font-weight:600">${item.estimated_value ? ps + item.estimated_value.toFixed(0) : '?'}</span>
      `;
      section.appendChild(row);
    });

    if (bb.total_estimated_value) {
      const totalRow = document.createElement('div');
      totalRow.style.cssText = 'display:flex;justify-content:space-between;padding:5px 0;margin-top:4px;font-size:13px;font-weight:700';
      totalRow.innerHTML = `
        <span style="color:#e0e0e0">Total separate value</span>
        <span style="color:#22c55e">${ps}${bb.total_estimated_value.toFixed(0)}</span>
      `;
      section.appendChild(totalRow);

      if (r.price && bb.total_estimated_value > r.price) {
        const savings = bb.total_estimated_value - r.price;
        const savEl = document.createElement('div');
        savEl.style.cssText = 'font-size:12px;color:#22c55e;font-weight:600;margin-top:4px';
        savEl.textContent = '\u2705 Bundle saves ' + ps + savings.toFixed(0) + ' vs buying separately';
        section.appendChild(savEl);
      }
    }

    if (bb.assessment) {
      const assEl = document.createElement('div');
      assEl.style.cssText = 'font-size:11px;color:#9ca3af;font-style:italic;margin-top:6px';
      assEl.textContent = bb.assessment;
      section.appendChild(assEl);
    }

    container.appendChild(section);
  }

  // ── Negotiation Message ────────────────────────────────────────────────────────

  function renderNegotiationMessage(r, container) {
    if (!r.negotiation_message) return;
    const section = document.createElement('div');
    section.style.cssText = 'margin:4px 12px 8px';

    const toggleBtn = document.createElement('button');
    toggleBtn.style.cssText = 'width:100%;padding:7px 10px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:8px;color:#818cf8;font-size:12px;cursor:pointer;text-align:left';
    toggleBtn.textContent = '\uD83D\uDCAC Copy negotiation message';
    section.appendChild(toggleBtn);

    const msgBox = document.createElement('div');
    msgBox.style.cssText = 'display:none;margin-top:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px';

    const msgText = document.createElement('div');
    msgText.style.cssText = 'font-size:12px;color:#d1d5db;line-height:1.5;white-space:pre-wrap;margin-bottom:8px';
    msgText.textContent = r.negotiation_message;
    msgBox.appendChild(msgText);

    const copyBtn = document.createElement('button');
    copyBtn.style.cssText = 'width:100%;padding:6px;background:#6366f1;border:none;border-radius:4px;color:white;font-size:12px;cursor:pointer';
    copyBtn.textContent = 'Copy to clipboard';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(r.negotiation_message);
        copyBtn.textContent = '\u2705 Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 2000);
      } catch (_e) {
        copyBtn.textContent = '\u274C Failed';
        setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 2000);
      }
    });
    msgBox.appendChild(copyBtn);
    section.appendChild(msgBox);

    toggleBtn.addEventListener('click', () => {
      msgBox.style.display = msgBox.style.display === 'none' ? 'block' : 'none';
    });

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
          if (val === 1) {
            fetch(API_BASE + '/thumbs', {
              method: 'POST', headers: {'Content-Type': 'application/json', 'X-DS-Key': DS_API_KEY, 'X-DS-Ext-Version': VERSION},
              body: JSON.stringify({score_id: r.score_id, thumbs: 1, reason: ''}),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
            thumbWrap.innerHTML = '<span style="font-size:12px;color:#6ee7b7">\u2713 Thanks!</span>';
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
                  method: 'POST', headers: {'Content-Type': 'application/json', 'X-DS-Key': DS_API_KEY, 'X-DS-Ext-Version': VERSION},
                  body: JSON.stringify({score_id: r.score_id, thumbs: -1, reason: key}),
                  signal: AbortSignal.timeout(5000),
                }).catch(() => {});
                thumbWrap.innerHTML = '<span style="font-size:12px;color:#6ee7b7">\u2713 Got it, thanks!</span>';
              });
              reasonRow.appendChild(pill);
            });
            thumbWrap.appendChild(reasonRow);
          }
        });
        return btn;
      };
      thumbWrap.appendChild(makeThumb('\uD83D\uDC4D', 'Yes, accurate', 1));
      thumbWrap.appendChild(makeThumb('\uD83D\uDC4E', 'No, off', -1));
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

  const _fbmOrigPush    = history.pushState.bind(history);
  const _fbmOrigReplace = history.replaceState.bind(history);

  function _listingIdFromUrl(href) {
    try {
      const full = new URL(String(href || ''), location.href).pathname;
      const m = full.match(/\/marketplace\/(?:[^/]+\/)?item\/(\d+)/);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function _onFbmNav(newUrl, isPopstate = false) {
    const newHref = newUrl ? (() => {
      try { return new URL(String(newUrl), location.href).href; } catch (_) { return String(newUrl); }
    })() : '';

    const oldId = _listingIdFromUrl(location.href);
    const newId = newHref ? _listingIdFromUrl(newHref) : '';

    if (!isPopstate) {
      if (!newId || newId === oldId) {
        return;
      }
    }

    if (isListingPage() || (newHref && /\/marketplace\/(?:[^/]+\/)?item\/\d+/.test(newHref))) {
      window.__dealScoutPrevTitle = _getCurrentH1Title();
      try { sessionStorage.setItem('ds_prevTitle', window.__dealScoutPrevTitle || ''); } catch (_e) {}

      if (window.__dealScoutAbort) {
        try { window.__dealScoutAbort.abort(); } catch (_e) {}
      }

      window.__dealScoutNonce = (window.__dealScoutNonce || 0) + 1;
      window.__dealScoutRunning = false;

      const snapTitle = window.__dealScoutPrevTitle || '';
      _dsNavLog('pushStateNav', { from: oldId, to: newId, prevTitle: snapTitle.slice(0, 50) });
      _dsDebugPost('pushstate-nav', { from: oldId, to: newId, prevTitle: snapTitle.slice(0, 50) });

      const panel = document.getElementById(PANEL_ID);
      if (panel) renderNavigating();
    }
  }

  history.pushState    = function(state, title, url) { _onFbmNav(url, false); _fbmOrigPush(state, title, url);    };
  history.replaceState = function(state, title, url) { _onFbmNav(url, false); _fbmOrigReplace(state, title, url); };
  window.addEventListener('popstate', () => _onFbmNav('', true));

})();
