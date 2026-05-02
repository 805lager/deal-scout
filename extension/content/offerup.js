/**
 * offerup.js — Deal Scout Content Script for OfferUp
 * v1.0.0
 *
 * INJECTED INTO: offerup.com/item/detail/*
 * PURPOSE: Scores OfferUp listings via the Deal Scout backend.
 *
 * NOTE: OfferUp is a React SPA. Content is rendered client-side, so we
 * use a MutationObserver to wait for the listing data to appear in the DOM
 * before extracting and scoring.
 *
 * MANIFEST ENTRY NEEDED:
 *   {
 *     "matches": ["https://offerup.com/item/detail/*"],
 *     "js": ["offerup.js"],
 *     "run_at": "document_idle"
 *   }
 */

(function () {
  "use strict";

  const VERSION  = chrome.runtime.getManifest().version;
  const PANEL_ID = "deal-scout-ou-panel";
  const PLATFORM = "offerup";

  if (window.__dsOUInjected) return;
  window.__dsOUInjected = true;

  let API_BASE = "https://deal-scout-805lager.replit.app/api/ds";
  const DS_API_KEY = atob("MDVlZmZjMGQ2NTg2MTJiYzc5N2QwNDM0NWVhYWM4OTBfZXZpbF9zZA==").split('').reverse().join('');
  try {
    chrome.storage.local.get("ds_api_base", (r) => {
      if (r && r.ds_api_base) API_BASE = r.ds_api_base;
    });
  } catch (e) {}

  // ── Detection ──────────────────────────────────────────────────────────────
  function isListingPage() {
    return /(www\.)?offerup\.com\/item\//.test(location.href);
  }

  // ── Extraction (React SPA — wait for DOM to hydrate) ───────────────────────
  function extractListing() {
    // Title: OfferUp renders item title in the first h1 on the detail page
    const h1El = document.querySelector("h1");
    const title = h1El?.textContent?.trim() || document.title.split(" | ")[0].trim();

    // Price: look for $ value near the top of the page
    let price = 0;
    let priceText = "";
    const priceSelectors = [
      "[data-testid='item-price']",
      "[class*='price']",
      "[class*='Price']",
      "h2", "h3",
    ];
    for (const sel of priceSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = el.textContent?.trim() || "";
        const m = text.match(/^\$([0-9,]+(?:\.[0-9]{2})?)$/);
        if (m) {
          const val = parseFloat(m[1].replace(/,/g, ""));
          if (val >= 1) { price = val; priceText = text; break; }
        }
      }
      if (price) break;
    }
    // Broader fallback: scan all text for $ amount
    if (!price) {
      const allText = document.body.innerText || "";
      const m = allText.match(/\$([0-9,]+(?:\.[0-9]{2})?)\s*(?:\n|free|obo|firm)/i);
      if (m) { price = parseFloat(m[1].replace(/,/g, "")); priceText = "$" + m[1]; }
    }

    // Condition
    const bodyText = document.body.innerText || "";
    const condMatch = bodyText.match(/\b(New|Like New|Good|Fair|Used|Excellent|Poor|Refurbished)\b/i);
    const condition = condMatch ? condMatch[1] : "Used";

    // Location: OfferUp shows city-level location
    const locSelectors = ["[data-testid='item-location']", "[class*='location']", "[class*='Location']"];
    let location_ = "";
    for (const sel of locSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) { location_ = el.textContent.trim(); break; }
    }
    if (!location_) {
      const locMatch = bodyText.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?,\s*[A-Z]{2})\b/);
      if (locMatch) location_ = locMatch[1];
    }

    // Description
    const descSelectors = ["[data-testid='item-description']", "[class*='description']", "[class*='Description']", "p"];
    let description = "";
    for (const sel of descSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = el.textContent?.trim() || "";
        if (text.length > 30 && !text.includes("Sign in") && !text.includes("Download")) {
          description = text.slice(0, 800); break;
        }
      }
      if (description) break;
    }

    // Images: grab all reasonable-sized images
    const images = [];
    document.querySelectorAll("img").forEach(img => {
      const src = img.src || img.getAttribute("data-src") || "";
      const { naturalWidth: w, naturalHeight: h } = img;
      if (src && (w === 0 || w >= 200) && !src.includes("icon") && !src.includes("logo") &&
          !src.includes("avatar") && !images.includes(src) && src.startsWith("http")) {
        images.push(src);
      }
    });

    // Seller trust signals — OfferUp shows "Joined Dec 2017" and "(14) offer up reviews"
    // on the listing page. Parse from page text since OfferUp doesn't use stable test IDs.
    const joinedMatch  = bodyText.match(/Joined\s+([A-Za-z]+\.?\s+\d{4})/i);
    const reviewMatch  = bodyText.match(/\((\d+)\)\s*(?:offerup|offer\s*up)?\s*reviews?/i);
    const ratingMatch  = bodyText.match(/([0-9]\.[0-9])\s*(?:out of 5|stars?|\/ ?5)/i);
    const sellerNameEl = document.querySelector("[class*='seller'], [class*='Seller'], [data-testid*='seller']");
    const sellerName   = sellerNameEl?.textContent?.trim().replace(/^Sold by\s*/i, "").slice(0, 60) ||
                         (bodyText.match(/Sold by\s+([^\n]{2,50})/i) || [])[1]?.trim() || "";

    const seller_trust = {
      joined_date:  joinedMatch  ? joinedMatch[1].trim()  : null,
      rating:       ratingMatch  ? parseFloat(ratingMatch[1]) : null,
      rating_count: reviewMatch  ? parseInt(reviewMatch[1])   : 0,
    };

    // Task #59 — derive seller_account_age_days client-side from
    // joined_date so the trust evaluator's "price-too-good + new account"
    // signal can fire even when the server-side fallback parser misses
    // the date format. Backend parser is the safety net.
    const sellerAccountAgeDays = (function () {
      const j = seller_trust.joined_date;
      if (!j) return null;
      const cleaned = j.replace(/^(joined|in|since)\s+/i, '').replace(/\.$/, '');
      const ts = Date.parse(cleaned) || Date.parse('1 ' + cleaned);
      if (!ts) return null;
      const days = Math.floor((Date.now() - ts) / 86400000);
      return days >= 0 ? days : null;
    })();

    // Task #60 — OfferUp shows "Posted N days/weeks ago" in the meta line
    // beneath the title. Extract a raw string for server-side parsing.
    const listedAtRaw = (function () {
      const m = bodyText.match(/posted\s+(\d+\s*(?:hour|day|week|month|year)s?\s+ago)/i)
             || bodyText.match(/posted\s+(today|yesterday|just\s+now)/i);
      return m ? "Posted " + m[1] : null;
    })();

    return {
      title, price, raw_price_text: priceText,
      description, condition,
      location: location_,
      image_urls: images.slice(0, 5),
      platform: PLATFORM,
      seller_name:  sellerName,
      seller_trust: (seller_trust.joined_date || seller_trust.rating || seller_trust.rating_count)
                    ? seller_trust : null,
      seller_account_age_days: sellerAccountAgeDays,
      // Task #60 — leverage input. OfferUp doesn't expose price-history
      // or a strike-through peak in the DOM, so price_history / original_price
      // are omitted; the leverage line still works on time-on-market alone.
      listed_at: listedAtRaw,
    };
  }

  // ── Panel Management ───────────────────────────────────────────────────────
  function removePanel() { document.getElementById(PANEL_ID)?.remove(); }

  function showPanel() {
    removePanel();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = [
      "position:fixed", "top:80px", "right:20px", "width:320px",
      "max-height:calc(100vh - 100px)", "overflow-y:auto",
      "z-index:2147483647",
      "background:#1e1b2e", "border:1px solid #3d3660", "border-radius:10px",
      "box-shadow:0 8px 32px rgba(0,0,0,0.6)",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "font-size:13px", "color:#e0e0e0", "line-height:1.5",
    ].join(";");
    panel._ds_drag = { on: false, ox: 0, oy: 0 };
    const onMove = (e) => {
      if (!panel._ds_drag.on) return;
      const x = Math.max(0, Math.min(e.clientX - panel._ds_drag.ox, window.innerWidth - panel.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - panel._ds_drag.oy, window.innerHeight - panel.offsetHeight));
      panel.style.right = "auto"; panel.style.left = x + "px"; panel.style.top = y + "px";
    };
    const onUp = () => { panel._ds_drag.on = false; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.appendChild(panel);
    return panel;
  }

  function getPanel() { return document.getElementById(PANEL_ID) || showPanel(); }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function priceBucket(p) {
    if (!p) return "0";
    if (p < 50) return "0-50"; if (p < 200) return "50-200";
    if (p < 500) return "200-500"; if (p < 1000) return "500-1000";
    return "1000+";
  }

  // ── Raw Data Extraction ──────────────────────────────────────────────────────

  function extractRaw() {
    // OfferUp images: the main product photo(s) in the listing view
    const imageUrls = Array.from(
      document.querySelectorAll("[class*='ListingPhoto'] img, [class*='listing-photo'] img, [class*='photoWrapper'] img, [class*='carousel'] img")
    )
      .map(img => img.src || img.getAttribute("data-src"))
      .filter(s => s && s.startsWith("http"))
      .slice(0, 5);

    // OfferUp is a React SPA — prefer the main content area
    const mainEl = document.querySelector("main, [role='main'], [class*='listing']")
                || document.body;
    const rawText = (mainEl.innerText || "").slice(0, 4000);

    // Task #60 — leverage input. OfferUp shows "Posted N days/weeks ago"
    // in the meta line. listed_at is parsed server-side; price_history /
    // original_price are omitted (no DOM signal for them on OfferUp).
    const _raw_listedAt = (function () {
      const t = (mainEl.innerText || document.body.innerText || "");
      const m = t.match(/posted\s+(\d+\s*(?:hour|day|week|month|year)s?\s+ago)/i)
             || t.match(/posted\s+(today|yesterday|just\s+now)/i);
      return m ? "Posted " + m[1] : null;
    })();

    return {
      raw_text:    rawText,
      image_urls:  imageUrls,
      platform:    PLATFORM,
      listing_url: location.href,
      // Task #60 — leverage inputs (only listed_at extractable on OfferUp)
      listed_at:   _raw_listedAt,
    };
  }



  // ── Rendering ──────────────────────────────────────────────────────────────
  function _addBarDrag(bar, closeBtn) {
    bar.style.cursor = "move";
    bar.addEventListener("mousedown", function(e) {
      if (e.target === closeBtn) return;
      var p = document.getElementById(PANEL_ID);
      if (p) {
        var rect = p.getBoundingClientRect();
        p._ds_drag = { on: true, ox: e.clientX - rect.left, oy: e.clientY - rect.top };
      }
    });
  }

  function renderNavigating() {
    const panel = getPanel();
    panel.textContent = "";
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:#13111f;border-radius:10px";
    bar.innerHTML = DOMPurify.sanitize('<span style="font-weight:700;font-size:13px;color:#7c8cf8">\ud83d\udcca Deal Scout ' +
      '<span style="font-size:10px;color:#6b7280;font-weight:400">\u27f3 Loading\u2026</span></span>');
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.style.cssText = "background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px";
    closeBtn.onclick = removePanel;
    bar.appendChild(closeBtn);
    _addBarDrag(bar, closeBtn);
    panel.appendChild(bar);
    if (!document.getElementById("ds-spin-style")) {
      const s = document.createElement("style"); s.id = "ds-spin-style";
      s.textContent = "@keyframes ds-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(s);
    }
  }

  function renderLoading(listing) {
    const panel = getPanel();
    panel.textContent = "";
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0";
    const titleText = (listing && listing.title) ? listing.title.slice(0, 30) : "Scoring";
    const priceText = (listing && listing.price) ? " \xb7 $" + Number(listing.price).toLocaleString() : "";
    bar.innerHTML = DOMPurify.sanitize('<span style="font-weight:700;font-size:13px;color:#7c8cf8">\ud83d\udcca ' +
      '<span style="font-size:11px;color:#e0e0e0;font-weight:600">' + escHtml(titleText) + '</span>' +
      '<span style="font-size:11px;color:#7c8cf8;font-weight:700">' + priceText + '</span></span>');
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.style.cssText = "background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px";
    closeBtn.onclick = removePanel;
    bar.appendChild(closeBtn);
    _addBarDrag(bar, closeBtn);
    panel.appendChild(bar);

    const body = document.createElement("div");
    body.style.cssText = "padding:8px 10px;display:flex;align-items:center;gap:8px;color:#6b7280;font-size:12px";
    body.innerHTML = DOMPurify.sanitize('<span style="animation:ds-spin 1s linear infinite;display:inline-block;font-size:16px">\u27f3</span>' +
      '<span id="ds-progress-label">Analyzing deal\u2026</span>');
    panel.appendChild(body);

    if (!document.getElementById("ds-spin-style")) {
      const s = document.createElement("style"); s.id = "ds-spin-style";
      s.textContent = "@keyframes ds-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(s);
    }
  }

  function renderError(msg) {
    const panel = getPanel();
    panel.innerHTML = DOMPurify.sanitize('<div style="padding:14px 12px">' +
      '<div style="font-weight:700;font-size:15px;color:#7c8cf8;margin-bottom:10px">🔍 Deal Scout</div>' +
      '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;color:#fca5a5">' +
      '<div style="font-weight:600;margin-bottom:4px">⚠️ Scoring failed</div>' +
      '<div style="font-size:12px">' + escHtml(msg) + "</div></div></div>");
  }

  function renderScore(r) {
    const panel = getPanel();
    panel.textContent = "";

    // Approach A layout (Task #68) — sticky digest + collapsibles below.
    const digest = window.DealScoutDigest.beginDigest(panel);
    renderHeader(r, digest);
    renderConfidenceBlock(r, digest);
    renderTrustBlock(r, digest);
    renderLeverageBlock(r, digest);

    // ── Leverage Block (Task #60) ────────────────────────────────────────
    // Negotiation leverage digest — up to two lines (price-drop history +
    // time-on-market) with a motivation_level color chip. Color inverted
    // vs trust: high motivation = green for the BUYER. createElement +
    // textContent so model-emitted strings stay inert in the DOM.
    function renderLeverageBlock(r, container) {
      const lev = (r && r.leverage_signals) || {};
      const dropLine = (lev.price_drop_summary  || '').trim();
      const daysLine = (lev.days_listed_summary || '').trim();
      if (!dropLine && !daysLine) return;
      const mot    = (lev.motivation_level || 'low').toLowerCase();
      const colors = { low: '#6b7280', medium: '#fbbf24', high: '#22c55e' };
      const labels = { low: 'low motivation', medium: 'some motivation', high: 'motivated seller' };
      const color  = colors[mot] || colors.low;
      const label  = labels[mot] || mot;

      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin:8px 12px 0;border:1px solid ' + color + '55;'
        + 'border-radius:8px;background:' + color + '14;overflow:hidden';

      const chipRow = document.createElement('div');
      chipRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
        + 'padding:6px 10px;cursor:pointer;font-size:11px;gap:8px';

      const chipLeft = document.createElement('div');
      chipLeft.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';

      const icon = document.createElement('span');
      icon.style.cssText = 'color:' + color + ';font-weight:700;flex-shrink:0';
      icon.textContent = '\uD83D\uDCAA Leverage:';
      chipLeft.appendChild(icon);

      const summary = document.createElement('span');
      summary.style.cssText = 'color:#e5e7eb;font-size:11px;'
        + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      summary.textContent = label;
      chipLeft.appendChild(summary);

      const why = document.createElement('span');
      why.style.cssText = 'color:' + color + ';font-size:10.5px;flex-shrink:0';
      why.textContent = '[Why?]';

      chipRow.appendChild(chipLeft);
      chipRow.appendChild(why);
      wrap.appendChild(chipRow);

      const details = document.createElement('div');
      details.style.cssText = 'display:none;border-top:1px solid ' + color + '33;'
        + 'padding:8px 10px;font-size:11px;color:#d1d5db;line-height:1.5';
      for (const line of [dropLine, daysLine]) {
        if (!line) continue;
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:4px';
        row.textContent = line;
        details.appendChild(row);
      }
      wrap.appendChild(details);

      let open = false;
      chipRow.addEventListener('click', () => {
        open = !open;
        details.style.display = open ? 'block' : 'none';
        why.textContent = open ? '[Hide]' : '[Why?]';
      });

      container.appendChild(wrap);
    }

    // ── Trust Block (Task #59) ───────────────────────────────────────────
    // Composite trust / scam digest line. Renders only when ≥1 signal
    // fires (severity ∈ {info, warn, alert}). Color-coded chip + tap-to-
    // expand "Why?" with one line per fired signal.
    function renderTrustBlock(r, container) {
      const sigs = Array.isArray(r.trust_signals) ? r.trust_signals : [];
      if (!sigs.length) return;
      const sev    = (r.trust_severity || 'info').toLowerCase();
      const colors = { info: '#fbbf24', warn: '#f97316', alert: '#ef4444' };
      const color  = colors[sev] || colors.info;
      const labels = sigs.map(s => s.label || s.id).filter(Boolean);

      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin:8px 12px 0;border:1px solid ' + color + '55;'
        + 'border-radius:8px;background:' + color + '14;overflow:hidden';

      const chipRow = document.createElement('div');
      chipRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
        + 'padding:6px 10px;cursor:pointer;font-size:11px;gap:8px';

      const chipLeft = document.createElement('div');
      chipLeft.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';

      const icon = document.createElement('span');
      icon.style.cssText = 'color:' + color + ';font-weight:700;flex-shrink:0';
      icon.textContent = '\u26A0 Trust check:';
      chipLeft.appendChild(icon);

      const summary = document.createElement('span');
      summary.style.cssText = 'color:#e5e7eb;font-size:11px;'
        + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      summary.textContent = labels.join(' \u00B7 ');
      chipLeft.appendChild(summary);

      const why = document.createElement('span');
      why.style.cssText = 'color:' + color + ';font-size:10.5px;flex-shrink:0';
      why.textContent = '[Why?]';

      chipRow.appendChild(chipLeft);
      chipRow.appendChild(why);
      wrap.appendChild(chipRow);

      const details = document.createElement('div');
      details.style.cssText = 'display:none;border-top:1px solid ' + color + '33;'
        + 'padding:8px 10px;font-size:11px;color:#d1d5db;line-height:1.5';
      for (const s of sigs) {
        const line = document.createElement('div');
        line.style.cssText = 'margin-bottom:4px';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'color:' + color + ';font-weight:600';
        lbl.textContent = (s.label || s.id || 'signal') + ': ';
        const txt = document.createElement('span');
        txt.textContent = s.why || '';
        line.appendChild(lbl);
        line.appendChild(txt);
        details.appendChild(line);
      }
      wrap.appendChild(details);

      let open = false;
      chipRow.addEventListener('click', () => {
        open = !open;
        details.style.display = open ? 'block' : 'none';
        why.textContent = open ? '[Hide]' : '[Why?]';
      });

      container.appendChild(wrap);
    }
    renderSummary(r, digest);

    // ── Collapsible sections (Task #68) ─────────────────────────────────
    const sections = document.createElement('div');
    sections.style.cssText = 'padding-bottom:8px';
    panel.appendChild(sections);

    const _greenN = (r.green_flags && r.green_flags.length) || 0;
    const _redN   = (r.red_flags   && r.red_flags.length)   || 0;
    if (_greenN || _redN) {
      const sec = window.DealScoutDigest.openCollapsible(sections, 'why',
        { title: '\uD83D\uDCDD Why this score' });
      renderFlags(r, sec.body);
      const parts = [];
      if (_greenN) parts.push(_greenN + ' pros');
      if (_redN)   parts.push(_redN + ' cautions');
      sec.setSummary(parts.join(' \u00B7 '), _greenN >= _redN ? '#86efac' : '#fde68a');
    }

    if (r.sold_avg || r.active_avg || r.new_price) {
      const sec = window.DealScoutDigest.openCollapsible(sections, 'market',
        { title: '\uD83D\uDCC8 Market Comparison' });
      renderMarketData(r, sec.body);
      if (r.sold_avg && r.price) {
        const _delta = r.price - r.sold_avg;
        const _pct   = Math.abs(Math.round((_delta / r.sold_avg) * 100));
        const _below = _delta < 0;
        sec.setSummary('$' + Math.abs(_delta).toFixed(0)
          + (_below ? ' below' : ' above')
          + ' (' + (_below ? '-' : '+') + _pct + '%)',
          _below ? '#86efac' : '#fca5a5');
      }
    }

    const _hasCards   = r.affiliate_cards && r.affiliate_cards.length > 0;
    const _hasNew     = r.new_price && r.new_price > 0;
    const _ratio      = _hasNew ? (r.price / r.new_price) : 0;
    const _buyTrigger = r.buy_new_trigger || _ratio >= 0.72;
    if (_hasCards || _buyTrigger) {
      const sec = window.DealScoutDigest.openCollapsible(sections, 'compare',
        { title: '\uD83D\uDD0D Compare Prices' });
      renderBuyNewSection(r, sec.body);
      let _best = 0;
      if (_hasCards) {
        for (const _c of r.affiliate_cards) {
          const _items = _c.items || [];
          for (const _it of _items) {
            if (_it.price > 0 && (_best === 0 || _it.price < _best)) _best = _it.price;
          }
          if (!_items.length && _c.product_price > 0
              && (_best === 0 || _c.product_price < _best)) {
            _best = _c.product_price;
          }
        }
      }
      if (_best > 0) {
        const _save = r.price - _best;
        sec.setSummary('$' + _best.toFixed(0)
          + (_save > 0 ? ' \u00B7 $' + _save.toFixed(0) + ' less' : ''),
          _save > 0 ? '#86efac' : '#9ca3af');
      } else {
        sec.setSummary('Compare alternatives');
      }
    }

    if (r.security_score) {
      const sec = window.DealScoutDigest.openCollapsible(sections, 'security',
        { title: '\uD83D\uDD12 Security Check' });
      renderSecurityScore(r, sec.body);
      const _sc = r.security_score;
      const _color = _sc.risk_level === 'low'    ? '#86efac'
                   : _sc.risk_level === 'medium' ? '#fde68a'
                   :                               '#fca5a5';
      sec.setSummary((_sc.score || '?') + '/10 \u00B7 ' + (_sc.risk_level || ''), _color);
    }

    if (r.product_evaluation) {
      const sec = window.DealScoutDigest.openCollapsible(sections, 'reputation',
        { title: '\u2B50 Product Reputation' });
      const _pe = r.product_evaluation;
      // Inline minimal renderer — offerup.js doesn't ship its own.
      const _row = (txt, color) => {
        if (!txt) return;
        const el = document.createElement('div');
        el.style.cssText = 'font-size:12px;color:' + (color || '#d1d5db')
          + ';margin:4px 12px;line-height:1.4';
        el.textContent = txt;
        sec.body.appendChild(el);
      };
      _row(_pe.brand_reputation);
      _row(_pe.model_reputation);
      (_pe.known_issues || []).slice(0, 3).forEach(i => _row('\u26A0 ' + i, '#fde68a'));
      if (_pe.expected_lifespan) _row('\u23F3 Expected lifespan: ' + _pe.expected_lifespan, '#9ca3af');
      const _tier = _pe.reliability_tier || '';
      const _color = _tier === 'excellent' ? '#86efac'
                   : _tier === 'good'      ? '#93c5fd'
                   : _tier === 'average'   ? '#fde68a'
                   :                         '#fca5a5';
      sec.setSummary(_tier, _color);
    }

    if (r.bundle_breakdown && r.bundle_breakdown.items && r.bundle_breakdown.items.length) {
      const sec = window.DealScoutDigest.openCollapsible(sections, 'bundle',
        { title: '\uD83D\uDCE6 Bundle Breakdown' });
      renderBundleBreakdown(r, sec.body);
      sec.setSummary(r.bundle_breakdown.items.length + ' items');
    }

    renderNegotiationMessage(r, panel);
    renderFooter(r, panel);
  }

  // Task #58 — Confidence chip + tap-to-expand comp summary. createElement +
  // textContent so any model-emitted strings stay inert in the page DOM.
  function renderConfidenceBlock(r, container) {
    const conf = (r.confidence || '').toLowerCase();
    if (!conf) return;
    const colors = { high: '#22c55e', medium: '#fbbf24', low: '#ef4444', none: '#6b7280' };
    const labels = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW', none: "CAN'T PRICE" };
    const color  = colors[conf] || colors.none;
    const label  = labels[conf] || conf.toUpperCase();
    const cs     = r.comp_summary || {};
    const cnt    = cs.count || 0;
    const canPrice = r.can_price !== false;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:8px 12px 0;border:1px solid ' + color + '44;'
      + 'border-radius:8px;background:' + color + '12;overflow:hidden';

    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
      + 'padding:6px 10px;cursor:pointer;font-size:11px';

    const chipLeft = document.createElement('div');
    chipLeft.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';

    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;'
      + 'background:' + color + '33;border:1px solid ' + color + '99;color:' + color + ';'
      + 'font-weight:700;border-radius:4px;padding:1px 7px;font-size:10px;letter-spacing:0.3px;flex-shrink:0';
    chip.textContent = '\u25CF ' + label;
    chipLeft.appendChild(chip);

    const compSum = document.createElement('span');
    compSum.style.cssText = 'color:#9ca3af;font-size:11px;'
      + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    if (canPrice && cnt > 0 && cs.low > 0 && cs.high > 0) {
      compSum.textContent = 'Based on ' + cnt + ' comps · $'
        + Math.round(cs.low) + '\u2013$' + Math.round(cs.high);
    } else if (cnt > 0) {
      compSum.textContent = 'Based on ' + cnt + ' comps';
    } else {
      compSum.textContent = 'No comparable sales found';
    }
    chipLeft.appendChild(compSum);

    const arrow = document.createElement('span');
    arrow.style.cssText = 'color:#9ca3af;font-size:10px;flex-shrink:0;margin-left:8px';
    arrow.textContent = '\u25BE';

    chipRow.appendChild(chipLeft);
    chipRow.appendChild(arrow);
    wrap.appendChild(chipRow);

    // Task #58 — when can_price === false, show the verdict copy as a
    // PRIMARY always-visible banner (not hidden in the expand). It is
    // what replaces the score number's role for the user.
    if (!canPrice && r.cant_price_message) {
      const banner = document.createElement('div');
      banner.style.cssText = 'border-top:1px solid ' + color + '22;'
        + 'padding:8px 10px;font-size:12px;font-weight:600;color:#fca5a5;line-height:1.4';
      banner.textContent = r.cant_price_message;
      wrap.appendChild(banner);
    }

    const details = document.createElement('div');
    details.style.cssText = 'display:none;border-top:1px solid ' + color + '22;'
      + 'padding:8px 10px;font-size:11px;color:#d1d5db;line-height:1.5';

    const lines = [];
    if (cs.count > 0)              lines.push('Comps after cleaning: ' + cs.count);
    if (cs.median > 0)             lines.push('Median: $' + Math.round(cs.median));
    if (cs.low > 0 && cs.high > 0) lines.push('Range: $' + Math.round(cs.low) + ' \u2013 $' + Math.round(cs.high));
    if (cs.outliers_removed > 0)   lines.push('Outliers dropped: ' + cs.outliers_removed);
    if (cs.condition_mismatches_removed > 0)
      lines.push('Condition mismatches dropped: ' + cs.condition_mismatches_removed);
    if (cs.recency_window)         lines.push('Window: ' + cs.recency_window);
    if (r.confidence_signals && r.confidence_signals.winning_signal) {
      lines.push('Weakest signal: ' + r.confidence_signals.winning_signal);
    }
    for (const ln of lines) {
      const lineEl = document.createElement('div');
      lineEl.textContent = ln;
      details.appendChild(lineEl);
    }

    if (Array.isArray(r.queries_attempted) && r.queries_attempted.length > 0) {
      const qHeader = document.createElement('div');
      qHeader.style.cssText = 'margin-top:6px;padding-top:6px;'
        + 'border-top:1px dashed ' + color + '22;font-weight:600;color:#9ca3af';
      qHeader.textContent = 'What we tried:';
      details.appendChild(qHeader);
      for (const q of r.queries_attempted) {
        const qLine = document.createElement('div');
        qLine.style.cssText = 'color:#9ca3af;font-size:10.5px;margin-top:2px';
        qLine.textContent = '\u00B7 "' + (q.query || '') + '" \u2192 '
          + (q.count || 0) + ' results' + (q.source ? ' (' + q.source + ')' : '');
        details.appendChild(qLine);
      }
    }

    if (!details.children.length) return;

    wrap.appendChild(details);
    let open = false;
    chipRow.addEventListener('click', () => {
      open = !open;
      details.style.display = open ? 'block' : 'none';
      arrow.textContent = open ? '\u25B4' : '\u25BE';
    });

    container.appendChild(wrap);
  }

  function renderHeader(r, container) {
    const score = r.score || 0;
    const scoreColor = score >= 7 ? "#22c55e" : score >= 5 ? "#fbbf24" : "#ef4444";
    const verdict = r.verdict || (score >= 7 ? "Good Deal" : score >= 5 ? "Fair Deal" : "Overpriced");
    const hdr = document.createElement("div");
    hdr.style.cssText = "background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0;padding:10px 12px;cursor:move";

    const topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px";
    const brandSpan = document.createElement("span");
    brandSpan.style.cssText = "font-weight:700;font-size:13px;color:#7c8cf8";
    brandSpan.textContent = "📊 Deal Scout";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px";
    closeBtn.addEventListener("click", removePanel);
    topRow.appendChild(brandSpan);
    topRow.appendChild(closeBtn);

    const scoreRow = document.createElement("div");
    scoreRow.style.cssText = "display:flex;align-items:center;gap:10px";
    // Task #58 — when comp data is too thin to price honestly, show '?' in
    // a muted ring. Detail copy lives in renderConfidenceBlock below.
    const _cantPrice = (r.can_price === false);
    const _ringColor = _cantPrice ? '#6b7280' : scoreColor;
    const ring = document.createElement("div");
    ring.style.cssText = "width:52px;height:52px;border-radius:50%;border:3px solid " + _ringColor + ";display:flex;align-items:center;justify-content:center;flex-shrink:0";
    const scoreNum = document.createElement("span");
    scoreNum.style.cssText = "font-size:22px;font-weight:900;color:" + _ringColor;
    scoreNum.textContent = _cantPrice ? '?' : score;
    ring.appendChild(scoreNum);
    const meta = document.createElement("div");
    meta.style.cssText = "flex:1;min-width:0";
    // Optional rationale row — server already truncates ≤140 chars.
    const ratHtml = r.score_rationale
      ? '<div style="font-size:11px;color:#9ca3af;margin-top:4px;line-height:1.4;font-style:italic">' + escHtml(r.score_rationale) + '</div>'
      : '';
    meta.innerHTML = DOMPurify.sanitize('<div style="font-size:14px;font-weight:800;color:#e2e8f0">' + escHtml(verdict) + "</div>" +
      '<div style="font-size:11px;color:#94a3b8;margin-top:2px">' + (r.should_buy === false ? "⛔ Skip" : r.should_buy ? "✅ Worth buying" : "") + "</div>" +
      '<div style="font-size:10px;color:#6b7280;margin-top:1px">🏷 OfferUp · $' + (r.price || 0).toFixed(0) + "</div>" +
      ratHtml);
    scoreRow.appendChild(ring);
    scoreRow.appendChild(meta);

    hdr.addEventListener("mousedown", (e) => {
      if (e.target === closeBtn) return;
      const p = getPanel();
      const rect = p.getBoundingClientRect();
      p._ds_drag = { on: true, ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    });
    hdr.appendChild(topRow);
    hdr.appendChild(scoreRow);
    container.appendChild(hdr);
  }

  function renderSummary(r, container) {
    if (!r.summary) return;
    const s = document.createElement("div");
    s.style.cssText = "margin:10px 12px 0;font-size:12px;color:#c4b5fd;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);border-radius:8px;padding:9px 10px;line-height:1.5";
    s.textContent = r.summary;
    container.appendChild(s);
  }

  function renderMarketData(r, container) {
    const section = document.createElement("div");
    section.style.cssText = "background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:8px 12px";
    section.innerHTML = DOMPurify.sanitize('<div style="font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#9ca3af;margin-bottom:8px">📈 Market Comparison</div>');
    const ps = "$";
    const rows = [];
    if (r.sold_avg)   rows.push({ label:"Est. sold avg",   val: ps + r.sold_avg.toFixed(0),   bold:true });
    if (r.active_avg) rows.push({ label:"Active listings", val: ps + r.active_avg.toFixed(0) });
    if (r.new_price)  rows.push({ label:"New retail",      val: ps + r.new_price.toFixed(0) });
    if (r.craigslist_asking_avg > 0) rows.push({ label:"CL asking avg", val: ps + r.craigslist_asking_avg.toFixed(0), note:"(" + (r.craigslist_count||0) + " local)" });
    rows.push({ label:"Listed price", val: ps + (r.price||0).toFixed(0) });
    const _thinCompsForRows = (r.market_confidence === "low") && ((r.sold_count || 0) <= 2) && r.sold_avg;
    if (_thinCompsForRows) {
      for (const rw of rows) {
        if (/sold avg|mid-point avg|ai market avg/i.test(rw.label)) {
          rw.dim = true;
          rw.bold = false;
        }
      }
    }
    for (const row of rows) {
      const el = document.createElement("div");
      el.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)";
      const valStyle = 'font-weight:' + (row.bold?"700":"500") + ';font-size:' + (row.bold?"14px":"13px") + (row.dim ? ';color:#6b7280' : '');
      el.innerHTML = DOMPurify.sanitize('<span style="color:#9ca3af;font-size:12px">' + escHtml(row.label) + (row.note ? ' <span style="color:#6b7280;font-size:10px">' + escHtml(row.note) + "</span>" : "") + "</span>" +
        '<span style="' + valStyle + '">' + escHtml(row.val) + "</span>");
      section.appendChild(el);
    }
    if (r.sold_avg && r.price) {
      const thinComps = (r.market_confidence === "low") && ((r.sold_count || 0) <= 2);
      if (thinComps) {
        const el = document.createElement("div");
        el.style.cssText = "margin-top:6px;font-size:12px;font-style:italic;color:#9ca3af";
        el.textContent = "○ Comps limited — comparison unreliable";
        section.appendChild(el);
      } else {
        const delta = r.price - r.sold_avg;
        const pct = Math.abs(Math.round((delta / r.sold_avg) * 100));
        const el = document.createElement("div");
        el.style.cssText = "margin-top:6px;font-size:12px;font-weight:600;color:" + (delta < 0 ? "#22c55e" : "#ef4444");
        el.textContent = "● $" + Math.abs(delta).toFixed(0) + (delta < 0 ? " below" : " above") + " market (" + (delta < 0 ? "-" : "+") + pct + "%)";
        section.appendChild(el);
      }
    }
    if (r.ai_notes) {
      const n = document.createElement("div");
      n.style.cssText = "font-size:11px;color:#9ca3af;font-style:italic;margin-top:6px";
      n.textContent = r.ai_notes;
      section.appendChild(n);
    }
    container.appendChild(section);
  }

  function renderFlags(r, container) {
    const red = r.red_flags || [], green = r.green_flags || [];
    if (!red.length && !green.length) return;
    const section = document.createElement("div");
    section.style.cssText = "margin:0 12px 8px";
    for (const f of green.slice(0,3)) { const el = document.createElement("div"); el.style.cssText = "font-size:11.5px;color:#6ee7b7;padding:2px 0"; el.textContent = "✓ " + f; section.appendChild(el); }
    for (const f of red.slice(0,3))   { const el = document.createElement("div"); el.style.cssText = "font-size:11.5px;color:#fca5a5;padding:2px 0"; el.textContent = "⚠ " + f; section.appendChild(el); }
    container.appendChild(section);
  }

  function renderBuyNewSection(r, container) {
    const hasCards = r.affiliate_cards && r.affiliate_cards.length > 0;
    const hasNew = r.new_price && r.new_price > 0;
    const trigger = r.buy_new_trigger || (hasNew && r.price / r.new_price >= 0.72);
    const score = r.score || 0;
    if (!hasCards && !trigger) return;

    const hasBetterDeal = hasCards && r.affiliate_cards.some(c => c.deal_tier === "better_deal");
    const hasSimilar = hasCards && r.affiliate_cards.some(c => c.deal_tier === "similar_price");
    const hasCompare = hasCards && r.affiliate_cards.some(c => c.deal_tier === "compare");

    if (!document.getElementById("ds-aff-glow-anim")) {
      const styleEl = document.createElement("style");
      styleEl.id = "ds-aff-glow-anim";
      styleEl.textContent = "@keyframes ds-glow-green{0%{box-shadow:0 0 4px rgba(34,197,94,0.0)}50%{box-shadow:0 0 12px rgba(34,197,94,0.35)}100%{box-shadow:0 0 4px rgba(34,197,94,0.0)}}@keyframes ds-glow-blue{0%{box-shadow:0 0 4px rgba(96,165,250,0.0)}50%{box-shadow:0 0 10px rgba(96,165,250,0.3)}100%{box-shadow:0 0 4px rgba(96,165,250,0.0)}}";
      document.head.appendChild(styleEl);
    }

    const section = document.createElement("div");
    section.style.cssText = "margin:4px 10px 12px;background:linear-gradient(160deg,rgba(99,102,241,0.12) 0%,rgba(15,23,42,0) 60%);border:1.5px solid rgba(139,92,246,0.35);border-radius:14px;padding:13px 13px 10px;position:relative;overflow:hidden";
    const glow = document.createElement("div");
    glow.style.cssText = "position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#6366f1,#a855f7,#06b6d4);border-radius:14px 14px 0 0";
    section.appendChild(glow);

    let hdrIcon, hdrText, hdrSub;
    if (hasBetterDeal)     { hdrIcon = "\uD83D\uDCA1"; hdrText = "Better Deals Found"; hdrSub = "We found lower prices available now."; }
    else if (hasSimilar)   { hdrIcon = "\u2705"; hdrText = "Available Elsewhere"; hdrSub = "Similar prices with buyer protection."; }
    else if (hasCompare)   { hdrIcon = "\uD83D\uDD0D"; hdrText = "Compare Prices"; hdrSub = "Check similar listings before buying."; }
    else if (!hasCards)    { hdrIcon = "\uD83D\uDCA1"; hdrText = "Buy New Instead?"; hdrSub = "Asking price is close to retail."; }
    else if (score <= 3)   { hdrIcon = "\u26A0\uFE0F"; hdrText = "Better Options Available"; hdrSub = "This OfferUp price is high \u2014 compare below."; }
    else if (score <= 5)   { hdrIcon = "\uD83D\uDCA1"; hdrText = "Compare Before Buying"; hdrSub = "Check these alternatives first."; }
    else if (score <= 7)   { hdrIcon = "\u2705"; hdrText = "Solid Deal \u2014 Verify Price"; hdrSub = "Double-check before committing."; }
    else                   { hdrIcon = "\uD83D\uDD25"; hdrText = "Great Deal \u2014 Compare Here"; hdrSub = "Confirm it's the best price."; }

    const hdrWrap = document.createElement("div");
    hdrWrap.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:11px;margin-top:2px";
    const hdrLeft = document.createElement("div");
    hdrLeft.innerHTML = DOMPurify.sanitize('<div style="font-size:13px;font-weight:800;color:#e2e8f0">' + hdrIcon + " " + escHtml(hdrText) + '</div><div style="font-size:11px;color:#94a3b8;margin-top:2px">' + escHtml(hdrSub) + "</div>");
    const disc = document.createElement("div");
    disc.style.cssText = "font-size:9px;color:#475569;background:rgba(71,85,105,0.18);border:1px solid rgba(71,85,105,0.3);border-radius:4px;padding:2px 6px;white-space:nowrap";
    disc.textContent = "Affiliate";
    hdrWrap.appendChild(hdrLeft); hdrWrap.appendChild(disc);
    section.appendChild(hdrWrap);

    if (trigger && hasNew) {
      const premium = r.new_price - r.price;
      const alertEl = document.createElement("div");
      alertEl.style.cssText = "display:flex;align-items:center;gap:8px;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:8px 10px;margin-bottom:10px";
      alertEl.innerHTML = DOMPurify.sanitize('<span style="font-size:15px;flex-shrink:0">\uD83C\uDFF7\uFE0F</span><div><div style="font-size:11.5px;font-weight:700;color:#6ee7b7">' + (premium > 0 ? "Only $" + premium.toFixed(0) + " more gets you:" : "Used asking \u2265 new retail:") + '</div><div style="font-size:10.5px;color:#a7f3d0;margin-top:2px">Full warranty \u2022 Easy returns \u2022 Buyer protection</div></div>');
      section.appendChild(alertEl);
    }

    if (!hasCards) { container.appendChild(section); return; }

    const COLORS = {amazon:"#f97316",ebay:"#22c55e",best_buy:"#0046be",target:"#ef4444",walmart:"#0071ce",home_depot:"#f96302",lowes:"#004990",back_market:"#16a34a",newegg:"#ff6600",autotrader:"#e8412c",cargurus:"#00968a",carmax:"#003087",wayfair:"#7b2d8b",dicks:"#1e3a5f",chewy:"#0c6bb1"};
    const ICONS = {amazon:"\uD83D\uDCE6",ebay:"\uD83C\uDFEA",best_buy:"\uD83D\uDCBB",target:"\uD83C\uDFAF",walmart:"\uD83D\uDED2",home_depot:"\uD83C\uDFE0",lowes:"\uD83D\uDD28",back_market:"\u267B\uFE0F",newegg:"\uD83D\uDCBB",autotrader:"\uD83D\uDE97",cargurus:"\uD83D\uDD0D",carmax:"\uD83C\uDFE2"};
    const TRUST = {amazon:"Prime eligible \u2022 Free returns",ebay:"Money-back guarantee \u2022 Buyer protection",best_buy:"Geek Squad warranty",back_market:"Certified refurb \u2022 1-yr warranty",autotrader:"Dealer-verified",cargurus:"Price analysis",carmax:"5-day return"};

    for (const [idx, card] of r.affiliate_cards.slice(0, 3).entries()) {
      const key = card.program_key || card.program || "";
      const color = COLORS[key] || "#7c8cf8";
      const icon = card.icon || ICONS[key] || "\uD83D\uDED2";
      const trust = TRUST[key] || "Trusted retailer";
      const name = card.badge_label || key;
      const tier = card.deal_tier || "compare";
      const hasItems = card.items && card.items.length > 0;
      let cardPrice = card.product_price || 0;
      if (!cardPrice && card.price_hint) { const m = String(card.price_hint).match(/([0-9,]+(?:\.[0-9]+)?)/); if (m) cardPrice = parseFloat(m[1].replace(/,/g,"")); }
      const saving = cardPrice > 0 ? r.price - cardPrice : 0;
      const tierBorder = tier === "better_deal" ? "rgba(34,197,94,0.5)" : tier === "similar_price" ? "rgba(96,165,250,0.4)" : "rgba(255,255,255,0.08)";
      const tierGlow = tier === "better_deal" ? "ds-glow-green 1.5s ease-in-out 3" : tier === "similar_price" ? "ds-glow-blue 1.5s ease-in-out 3" : "none";

      const cardEl = document.createElement("a");
      cardEl.href = card.url || "#"; cardEl.target = "_blank"; cardEl.rel = "noopener noreferrer";
      cardEl.style.cssText = "display:block;text-decoration:none;background:rgba(15,23,42,0.55);border:1.5px solid " + tierBorder + ";border-left:4px solid " + color + ";border-radius:10px;padding:11px 12px 10px;margin-bottom:8px;cursor:pointer;animation:" + tierGlow;
      cardEl.onmouseenter = function(){ this.style.background = "rgba(255,255,255,0.07)"; };
      cardEl.onmouseleave = function(){ this.style.background = "rgba(15,23,42,0.55)"; };

      if (tier === "better_deal" || tier === "similar_price" || tier === "compare") {
        const badge = document.createElement("div");
        if (tier === "better_deal") {
          badge.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;color:#22c55e;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.35);border-radius:5px;padding:2px 8px;margin-bottom:8px";
          badge.textContent = "\u2B06 Better Deal Found";
        } else if (tier === "similar_price") {
          badge.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;color:#60a5fa;background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.35);border-radius:5px;padding:2px 8px;margin-bottom:8px";
          badge.textContent = "\u2194 Similar Price \u2022 Buy with Protection";
        } else {
          badge.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;color:#94a3b8;background:rgba(148,163,184,0.10);border:1px solid rgba(148,163,184,0.25);border-radius:5px;padding:2px 8px;margin-bottom:8px";
          badge.textContent = "\uD83D\uDD0D Compare Prices";
        }
        cardEl.appendChild(badge);
      }

      if (hasItems) {
        for (const item of card.items.slice(0, 2)) {
          const itemRow = document.createElement("div");
          itemRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:8px;cursor:pointer";
          if (item.url) { itemRow.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); window.open(item.url, "_blank"); }); }
          if (item.image_url) {
            const thumb = document.createElement("img");
            thumb.src = item.image_url;
            thumb.style.cssText = "width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0;background:#1e293b;border:1px solid rgba(255,255,255,0.1)";
            thumb.onerror = function(){ this.style.display = "none"; };
            itemRow.appendChild(thumb);
          }
          const itemInfo = document.createElement("div");
          itemInfo.style.cssText = "flex:1;min-width:0";
          const itemTitle = document.createElement("div");
          itemTitle.style.cssText = "font-size:12px;font-weight:600;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
          itemTitle.textContent = item.title || "";
          itemInfo.appendChild(itemTitle);
          const itemMeta = document.createElement("div");
          itemMeta.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:3px";
          if (item.price > 0) { const ip = document.createElement("span"); ip.style.cssText = "font-size:14px;font-weight:900;color:#f1f5f9"; ip.textContent = "$" + item.price.toFixed(0); itemMeta.appendChild(ip); }
          if (item.condition) { const ic = document.createElement("span"); ic.style.cssText = "font-size:10px;color:#94a3b8;background:rgba(148,163,184,0.15);border-radius:4px;padding:1px 5px"; ic.textContent = item.condition; itemMeta.appendChild(ic); }
          itemInfo.appendChild(itemMeta);
          itemRow.appendChild(itemInfo);
          if (item.price > 0 && r.price > item.price) {
            const saveBadge = document.createElement("div");
            saveBadge.style.cssText = "font-size:10px;font-weight:700;color:#6ee7b7;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);border-radius:5px;padding:2px 7px;flex-shrink:0;white-space:nowrap";
            saveBadge.textContent = "$" + (r.price - item.price).toFixed(0) + " less";
            itemRow.appendChild(saveBadge);
          }
          cardEl.appendChild(itemRow);
        }
      } else {
        const topRow = document.createElement("div");
        topRow.style.cssText = "display:flex;align-items:center;gap:9px;margin-bottom:7px";
        topRow.innerHTML = DOMPurify.sanitize('<div style="width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;background:' + color + '1a;border:1.5px solid ' + color + '55">' + icon + '</div><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800;color:' + color + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(name) + '</div><div style="font-size:10.5px;color:#64748b;margin-top:2px">' + escHtml(trust) + '</div></div>' + (cardPrice > 0 ? '<div style="display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;gap:2px"><div style="font-size:18px;font-weight:900;color:#f1f5f9">$' + cardPrice.toFixed(0) + '</div>' + (saving > 2 ? '<div style="font-size:10px;font-weight:700;color:#6ee7b7;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);border-radius:5px;padding:1px 7px">$' + saving.toFixed(0) + ' less</div>' : '') + '</div>' : ''));
        cardEl.appendChild(topRow);
      }
      if (card.subtitle) { const sub = document.createElement("div"); sub.style.cssText = "font-size:11px;color:#94a3b8;margin-bottom:8px"; sub.textContent = card.subtitle; cardEl.appendChild(sub); }
      const cta = document.createElement("div");
      cta.style.cssText = "display:flex;align-items:center;justify-content:center;background:" + color + ";color:#fff;font-size:12px;font-weight:800;border-radius:7px;padding:8px 0;text-align:center";
      cta.textContent = (hasItems ? "View on " : cardPrice > 0 ? "Shop " : "Compare on ") + name + " \u2192";
      cardEl.appendChild(cta);
      cardEl.addEventListener("click", function() {
        try { chrome.runtime.sendMessage({type:"AFFILIATE_CLICK",program:key,category:r.category_detected||"",price_bucket:priceBucket(r.price),deal_score:score,position:idx+1,card_type:card.card_type||"",selection_reason:card.reason||"",commission_live:!!card.commission_live,deal_tier:tier}); } catch(e) {}
      });
      section.appendChild(cardEl);
    }
    container.appendChild(section);
  }

  function renderSecurityScore(r, container) {
    const sec = r.security_score;
    if (!sec) return;
    if (sec.risk_level === "unknown" && (!sec.flags || !sec.flags.length)) return;

    const riskConfig = {
      low:      { color: "#22c55e", bg: "rgba(34,197,94,0.1)",   border: "rgba(34,197,94,0.3)",  shield: "🛡️", label: "LOW RISK" },
      medium:   { color: "#f59e0b", bg: "rgba(245,158,11,0.1)",  border: "rgba(245,158,11,0.3)", shield: "⚠️", label: "CAUTION" },
      high:     { color: "#f97316", bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.4)", shield: "⚠️", label: "HIGH RISK" },
      critical: { color: "#ef4444", bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.5)",  shield: "❌", label: "LIKELY SCAM" },
    };
    const cfg = riskConfig[sec.risk_level] || riskConfig.medium;

    const section = document.createElement("div");
    section.style.cssText = "background:" + cfg.bg + ";border:1px solid " + cfg.border + ";border-radius:10px;padding:10px 12px;margin:4px 12px 8px";
    section.innerHTML = DOMPurify.sanitize(
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' +
        '<span style="font-size:16px">' + cfg.shield + "</span>" +
        '<span style="font-weight:700;font-size:13px;color:' + cfg.color + '">' + cfg.label + "</span>" +
        '<span style="margin-left:auto;font-size:11px;color:#6b7280">Security</span>' +
      "</div>" +
      (sec.recommendation ? '<div style="font-size:12px;color:#d1d5db;margin-bottom:6px">' + escHtml(sec.recommendation) + "</div>" : ""));

    const allFlags = [...new Set([...(sec.flags || []), ...(sec.layer1_flags || [])])];
    allFlags.slice(0, 5).forEach(flag => {
      const f = document.createElement("div");
      f.style.cssText = "font-size:12px;color:" + cfg.color + ";margin-bottom:2px";
      f.textContent = "• " + flag;
      section.appendChild(f);
    });
    container.appendChild(section);
  }

  function renderNegotiationMessage(r, container) {
    const msg = (r.negotiation_message || "").trim();
    if (!msg) return;
    const section = document.createElement("div");
    section.style.cssText = "background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.22);border-radius:10px;padding:10px 12px;margin:4px 12px 8px";
    const hdr = document.createElement("div");
    hdr.style.cssText = "font-size:11px;font-weight:700;color:#22c55e;margin-bottom:6px;letter-spacing:.04em";
    hdr.textContent = "💬 NEGOTIATION MESSAGE";
    const txt = document.createElement("div");
    txt.style.cssText = "font-size:12px;color:#cbd5e1;line-height:1.55;margin-bottom:8px";
    txt.textContent = msg;
    const btn = document.createElement("button");
    btn.style.cssText = "width:100%;padding:5px 0;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.35);border-radius:7px;color:#22c55e;font-size:11px;font-weight:600;cursor:pointer;letter-spacing:.03em";
    btn.textContent = "Copy Message";
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(msg).then(() => {
        btn.textContent = "✓ Copied!";
        setTimeout(() => { btn.textContent = "Copy Message"; }, 2000);
      }).catch(() => {
        btn.textContent = "Copy failed";
        setTimeout(() => { btn.textContent = "Copy Message"; }, 2000);
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
    const section = document.createElement("div");
    section.style.cssText = "background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:4px 12px 8px";
    const hdr = document.createElement("div");
    hdr.style.cssText = "font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:8px;letter-spacing:.04em";
    hdr.textContent = "📦 BUNDLE BREAKDOWN";
    section.appendChild(hdr);
    let total = 0;
    items.forEach(item => {
      const val = parseFloat(item.value) || 0;
      total += val;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04)";
      const name = document.createElement("span");
      name.style.color = "#cbd5e1";
      name.textContent = item.item || "";
      const price = document.createElement("span");
      price.style.cssText = "color:#7c8cf8;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0;margin-left:8px";
      price.textContent = "$" + val.toFixed(0);
      row.appendChild(name);
      row.appendChild(price);
      section.appendChild(row);
    });
    if (total > 0) {
      const totalRow = document.createElement("div");
      totalRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:5px 0 0;margin-top:2px";
      const tLabel = document.createElement("span");
      tLabel.style.cssText = "color:#94a3b8;font-weight:700";
      tLabel.textContent = "Total individual value";
      const tPrice = document.createElement("span");
      tPrice.style.cssText = "color:#22c55e;font-weight:700;font-variant-numeric:tabular-nums";
      tPrice.textContent = "$" + total.toFixed(0);
      totalRow.appendChild(tLabel);
      totalRow.appendChild(tPrice);
      section.appendChild(totalRow);
    }
    container.appendChild(section);
  }

  function renderFooter(r, container) {
    const footer = document.createElement("div");
    footer.style.cssText = "border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;padding:10px 12px";

    if (r && r.score_id) {
      const thumbSection = document.createElement("div");
      thumbSection.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px";
      const prompt = document.createElement("div");
      prompt.style.cssText = "font-size:11px;color:#9ca3af";
      prompt.textContent = "Was this score accurate?";
      const thumbWrap = document.createElement("div");
      thumbWrap.id = "ds-thumb-wrap-" + r.score_id;
      thumbWrap.style.cssText = "display:flex;gap:8px";
      const makeThumb = (emoji, label, val) => {
        const btn = document.createElement("button");
        btn.style.cssText = "display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:14px;color:#d1d5db;transition:background 0.15s";
        btn.innerHTML = DOMPurify.sanitize(emoji + ' <span style="font-size:11px">' + label + "</span>");
        btn.addEventListener("click", () => {
          if (val === 1) {
            fetch(API_BASE + "/thumbs", {
              method: "POST", headers: {"Content-Type": "application/json", "X-DS-Key": DS_API_KEY, "X-DS-Ext-Version": VERSION},
              body: JSON.stringify({score_id: r.score_id, thumbs: 1, reason: ""}),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
            thumbWrap.innerHTML = DOMPurify.sanitize('<span style="font-size:12px;color:#6ee7b7">✓ Thanks!</span>');
          } else {
            thumbWrap.textContent = "";
            const reasonRow = document.createElement("div");
            reasonRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;justify-content:center;max-width:230px";
            [["Score too high","score_too_high"],["Score too low","score_too_low"],
             ["Price wrong","price_wrong"],["Wrong category","wrong_category"],["Missing info","missing_info"]
            ].forEach(([lbl, key]) => {
              const pill = document.createElement("button");
              pill.style.cssText = "font-size:10px;padding:3px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.05);color:#d1d5db;cursor:pointer";
              pill.textContent = lbl;
              pill.addEventListener("click", (e) => {
                e.stopPropagation();
                fetch(API_BASE + "/thumbs", {
                  method: "POST", headers: {"Content-Type": "application/json", "X-DS-Key": DS_API_KEY, "X-DS-Ext-Version": VERSION},
                  body: JSON.stringify({score_id: r.score_id, thumbs: -1, reason: key}),
                  signal: AbortSignal.timeout(5000),
                }).catch(() => {});
                thumbWrap.innerHTML = DOMPurify.sanitize('<span style="font-size:12px;color:#6ee7b7">✓ Got it, thanks!</span>');
              });
              reasonRow.appendChild(pill);
            });
            thumbWrap.appendChild(reasonRow);
          }
        });
        return btn;
      };
      thumbWrap.appendChild(makeThumb("👍", "Yes, accurate", 1));
      thumbWrap.appendChild(makeThumb("👎", "No, off", -1));
      thumbSection.appendChild(prompt);
      thumbSection.appendChild(thumbWrap);
      footer.appendChild(thumbSection);
      const versionEl = document.createElement("div");
      versionEl.style.cssText = "text-align:center;font-size:10px;color:#374151;margin-top:8px";
      versionEl.textContent = "Deal Scout v" + VERSION + " · OfferUp";
      footer.appendChild(versionEl);
    } else {
      const versionEl = document.createElement("div");
      versionEl.style.cssText = "text-align:center;font-size:10px;color:#374151";
      versionEl.textContent = "Deal Scout v" + VERSION + " · OfferUp";
      footer.appendChild(versionEl);
    }
    container.appendChild(footer);
  }

  // ── Auto-Score (with SPA retry logic) ─────────────────────────────────────
  let _scored = false;
  let _observer = null;

  async function autoScore() {
    if (_scored) return;
    _scored = true;
    if (_observer) { _observer.disconnect(); _observer = null; }

    const rawData = extractRaw();
    if (!rawData.raw_text || rawData.raw_text.length < 100) {
      console.debug("[DealScout/OfferUp] No page content — skipping");
      _scored = false;
      return;
    }

    showPanel();
    renderLoading({});

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: "SCORE_LISTING", listing: rawData, listingId: location.href },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (resp && resp.success) {
              resolve(resp.result);
            } else {
              reject(new Error((resp && resp.error) || "Scoring failed"));
            }
          }
        );
      });

      chrome.runtime.sendMessage({ type: "BADGE_UPDATE", score: response.score });
      renderScore(response);
    } catch (err) {
      showPanel();
      renderError(err.message || "Scoring failed");
    }
  }

  function _dsAutoScoreEnabled() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get("ds_auto_score", (result) => {
          resolve(!result || result.ds_auto_score !== false);
        });
      } catch { resolve(true); }
    });
  }
  async function _dsMaybeScore(force) {
    if (force || await _dsAutoScoreEnabled()) {
      autoScore();
    } else {
      try { removePanel(); } catch (_e) {}
    }
  }

  function waitForContent(force = false) {
    // OfferUp React SPA — wait for a NEW title to appear (different from the old listing).
    // window.__dsOUPrevTitle holds the old listing's title (set in onUrlChange).
    // No longer waiting for price — Claude extracts it server-side.
    // `force=true` bypasses the auto-score preference (used by manual RESCORE).
    const prevTitle = window.__dsOUPrevTitle; // undefined on fresh page load
    let attempts = 0;
    const check = () => {
      attempts++;
      const currentTitle = document.querySelector("h1")?.textContent?.trim() || "";
      const titleChanged  = typeof prevTitle !== "string" || (currentTitle && currentTitle !== prevTitle);
      const hasContent    = (document.body.innerText || "").length > 300;
      if (currentTitle && titleChanged && hasContent) {
        window.__dsOUPrevTitle = undefined;
        _dsMaybeScore(force);
        return;
      }
      if (attempts < 30) setTimeout(check, 400);
      else _dsMaybeScore(force); // fallback after 12s
    };
    check();
  }

  // ── Message Listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "RESCORE") {
      _scored = false;
      removePanel();
      setTimeout(() => waitForContent(true), 400);
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── SPA Navigation Detection ───────────────────────────────────────────────
  let _lastUrl = location.href;
  function onUrlChange() {
    const cur = location.href;
    if (cur === _lastUrl) return;
    // Snapshot the current listing title BEFORE the SPA swaps the DOM.
    // waitForContent will poll until this title changes → guaranteed fresh data.
    window.__dsOUPrevTitle = document.querySelector('h1')?.textContent?.trim() ?? '';
    _lastUrl = cur;
    _scored = false;
    if (isListingPage()) {
      _dsAutoScoreEnabled().then(enabled => {
        if (!enabled) { removePanel(); return; }
        // Show spinner immediately — clears stale score before new listing loads.
        renderNavigating();
        setTimeout(() => waitForContent(false), 200);
      });
    } else {
      removePanel();
    }
  }

  window.addEventListener("popstate", onUrlChange);

  const _origPushState = history.pushState.bind(history);
  history.pushState = function (...args) { _origPushState(...args); onUrlChange(); };
  const _origReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) { _origReplaceState(...args); onUrlChange(); };

  // Interval backup — catches navigations that bypass pushState/replaceState
  setInterval(() => {
    if (location.href !== _lastUrl) onUrlChange();
  }, 800);

  // ── Init ───────────────────────────────────────────────────────────────────
  if (isListingPage()) {
    setTimeout(waitForContent, 1500);
  }

})();
