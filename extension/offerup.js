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

  const VERSION  = "1.0.1";
  const PANEL_ID = "deal-scout-ou-panel";
  const PLATFORM = "offerup";

  if (window.__dsOUInjected) return;
  window.__dsOUInjected = true;

  let API_BASE = "https://74e2628f-3f35-45e7-a256-28e515813eca-00-1g6ldqrar1bea.spock.replit.dev/api/ds";
  try {
    chrome.storage.local.get("ds_api_base", (r) => {
      if (r && r.ds_api_base) API_BASE = r.ds_api_base;
    });
  } catch (e) {}

  // ── Detection ──────────────────────────────────────────────────────────────
  function isListingPage() {
    return /offerup\.com\/item\/detail\//.test(location.href);
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

    return {
      title, price, raw_price_text: priceText,
      description, condition,
      location: location_,
      image_urls: images.slice(0, 5),
      platform: PLATFORM,
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

  // ── Background Communication ───────────────────────────────────────────────
  function sendToBackground(listing) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "SCORE_LISTING", listing }, (response) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (!response || !response.success) { reject(new Error(response?.error || "No response")); return; }
          resolve(response.result);
        });
      } catch (e) { reject(e); }
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function renderLoading(listing) {
    const panel = getPanel();
    panel.innerHTML = "";
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0";
    bar.innerHTML = '<span style="font-weight:700;font-size:13px;color:#7c8cf8">📊 Deal Scout <span style="font-size:10px;color:#6b7280;font-weight:400">v' + VERSION + " · OfferUp</span></span>";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px";
    closeBtn.onclick = removePanel;
    bar.appendChild(closeBtn);
    panel.appendChild(bar);
    const body = document.createElement("div");
    body.style.cssText = "padding:14px 12px";
    body.innerHTML = '<div style="font-size:12px;color:#9ca3af;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      escHtml(listing?.title || "Loading…") + "</div>" +
      '<div style="text-align:center;padding:20px;color:#6b7280">' +
      '<div style="font-size:24px;animation:ds-spin 1s linear infinite;display:inline-block">⟳</div>' +
      '<div style="font-size:12px;margin-top:8px">Analyzing deal…</div>' +
      '<div style="font-size:11px;margin-top:4px;color:#4b5563">eBay comps · AI scoring · Price check</div></div>';
    panel.appendChild(body);
    if (!document.getElementById("ds-spin-style")) {
      const s = document.createElement("style"); s.id = "ds-spin-style";
      s.textContent = "@keyframes ds-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(s);
    }
  }

  function renderError(msg) {
    const panel = getPanel();
    panel.innerHTML = '<div style="padding:14px 12px">' +
      '<div style="font-weight:700;font-size:15px;color:#7c8cf8;margin-bottom:10px">🔍 Deal Scout</div>' +
      '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;color:#fca5a5">' +
      '<div style="font-weight:600;margin-bottom:4px">⚠️ Scoring failed</div>' +
      '<div style="font-size:12px">' + escHtml(msg) + "</div></div></div>";
  }

  function renderScore(r) {
    const panel = getPanel();
    panel.innerHTML = "";
    renderHeader(r, panel);
    renderSummary(r, panel);
    renderMarketData(r, panel);
    renderBuyNewSection(r, panel);
    renderFlags(r, panel);
    renderFooter(panel);
  }

  function renderHeader(r, container) {
    const score = r.score || 0;
    const scoreColor = score >= 7 ? "#22c55e" : score >= 5 ? "#fbbf24" : "#ef4444";
    const verdict = r.verdict || (score >= 7 ? "Good Deal" : score >= 5 ? "Fair Deal" : "Overpriced");
    const hdr = document.createElement("div");
    hdr.style.cssText = "background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0;padding:10px 12px;cursor:move";
    const topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px";
    topRow.innerHTML = '<span style="font-weight:700;font-size:13px;color:#7c8cf8">📊 Deal Scout</span>';
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px";
    closeBtn.onclick = removePanel;
    topRow.appendChild(closeBtn);
    hdr.addEventListener("mousedown", (e) => {
      if (e.target === closeBtn) return;
      const p = getPanel();
      const rect = p.getBoundingClientRect();
      p._ds_drag = { on: true, ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    });
    hdr.appendChild(topRow);
    hdr.innerHTML += '<div style="display:flex;align-items:center;gap:10px">' +
      '<div style="width:52px;height:52px;border-radius:50%;border:3px solid ' + scoreColor + ';display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
      '<span style="font-size:22px;font-weight:900;color:' + scoreColor + '">' + score + "</span></div>" +
      '<div><div style="font-size:14px;font-weight:800;color:#e2e8f0">' + escHtml(verdict) + "</div>" +
      '<div style="font-size:11px;color:#94a3b8;margin-top:2px">' + (r.should_buy === false ? "⛔ Skip" : r.should_buy ? "✅ Worth buying" : "") + "</div>" +
      '<div style="font-size:10px;color:#6b7280;margin-top:1px">🏷 OfferUp · $' + (r.price || 0).toFixed(0) + "</div></div></div>";
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
    section.innerHTML = '<div style="font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#9ca3af;margin-bottom:8px">📈 Market Comparison</div>';
    const ps = "$";
    const rows = [];
    if (r.sold_avg)   rows.push({ label:"Est. sold avg",   val: ps + r.sold_avg.toFixed(0),   bold:true });
    if (r.active_avg) rows.push({ label:"Active listings", val: ps + r.active_avg.toFixed(0) });
    if (r.new_price)  rows.push({ label:"New retail",      val: ps + r.new_price.toFixed(0) });
    if (r.craigslist_asking_avg > 0) rows.push({ label:"CL asking avg", val: ps + r.craigslist_asking_avg.toFixed(0), note:"(" + (r.craigslist_count||0) + " local)" });
    rows.push({ label:"Listed price", val: ps + (r.price||0).toFixed(0) });
    for (const row of rows) {
      const el = document.createElement("div");
      el.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)";
      el.innerHTML = '<span style="color:#9ca3af;font-size:12px">' + escHtml(row.label) + (row.note ? ' <span style="color:#6b7280;font-size:10px">' + escHtml(row.note) + "</span>" : "") + "</span>" +
        '<span style="font-weight:' + (row.bold?"700":"500") + ';font-size:' + (row.bold?"14px":"13px") + '">' + escHtml(row.val) + "</span>";
      section.appendChild(el);
    }
    if (r.sold_avg && r.price) {
      const delta = r.price - r.sold_avg;
      const pct = Math.abs(Math.round((delta / r.sold_avg) * 100));
      const el = document.createElement("div");
      el.style.cssText = "margin-top:6px;font-size:12px;font-weight:600;color:" + (delta < 0 ? "#22c55e" : "#ef4444");
      el.textContent = "● $" + Math.abs(delta).toFixed(0) + (delta < 0 ? " below" : " above") + " market (" + (delta < 0 ? "-" : "+") + pct + "%)";
      section.appendChild(el);
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

    const section = document.createElement("div");
    section.style.cssText = "margin:4px 10px 12px;background:linear-gradient(160deg,rgba(99,102,241,0.12) 0%,rgba(15,23,42,0) 60%);border:1.5px solid rgba(139,92,246,0.35);border-radius:14px;padding:13px 13px 10px;position:relative;overflow:hidden";
    const glow = document.createElement("div");
    glow.style.cssText = "position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#6366f1,#a855f7,#06b6d4);border-radius:14px 14px 0 0";
    section.appendChild(glow);

    let hdrIcon = "💡", hdrText = "Compare Prices", hdrSub = "Check alternatives.";
    if (score <= 3)      { hdrIcon = "⚠️"; hdrText = "Skip — Better Options Here"; hdrSub = "This OfferUp price is high."; }
    else if (score <= 5) { hdrIcon = "💡"; hdrText = "You Could Do Better"; hdrSub = "Compare before buying."; }
    else if (score <= 7) { hdrIcon = "✅"; hdrText = "Solid — Confirm Price"; hdrSub = "Double-check before committing."; }
    else                 { hdrIcon = "🔥"; hdrText = "Great Deal — Verify"; hdrSub = "Make sure it's the best price."; }

    const hdrWrap = document.createElement("div");
    hdrWrap.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:11px;margin-top:2px";
    hdrWrap.innerHTML = '<div><div style="font-size:13px;font-weight:800;color:#e2e8f0">' + hdrIcon + " " + escHtml(hdrText) + "</div>" +
      '<div style="font-size:11px;color:#94a3b8;margin-top:2px">' + escHtml(hdrSub) + "</div></div>" +
      '<div style="font-size:9px;color:#475569;background:rgba(71,85,105,0.18);border:1px solid rgba(71,85,105,0.3);border-radius:4px;padding:2px 6px;white-space:nowrap">Affiliate</div>';
    section.appendChild(hdrWrap);

    if (trigger && hasNew) {
      const premium = r.new_price - r.price;
      const alertEl = document.createElement("div");
      alertEl.style.cssText = "display:flex;align-items:center;gap:8px;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:8px 10px;margin-bottom:10px";
      alertEl.innerHTML = '<span style="font-size:15px">🏷️</span><div><div style="font-size:11.5px;font-weight:700;color:#6ee7b7">' +
        (premium > 0 ? "Only $" + premium.toFixed(0) + " more gets you:" : "Used asking ≥ new retail:") +
        '</div><div style="font-size:10.5px;color:#a7f3d0;margin-top:2px">Full warranty • Easy returns</div></div>';
      section.appendChild(alertEl);
    }

    if (!hasCards) { container.appendChild(section); return; }

    const COLORS = { amazon:"#f97316",ebay:"#22c55e",best_buy:"#0046be",target:"#ef4444",walmart:"#0071ce",home_depot:"#f96302",back_market:"#16a34a",autotrader:"#e8412c",cargurus:"#00968a" };
    const ICONS  = { amazon:"📦",ebay:"🏪",best_buy:"💻",target:"🎯",walmart:"🛒",home_depot:"🏠",back_market:"♻️",autotrader:"🚗",cargurus:"🔍" };
    const TRUST  = { amazon:"Prime eligible • Free returns",ebay:"Money-back guarantee",best_buy:"Geek Squad warranty",back_market:"Certified refurb • 1-yr warranty",autotrader:"Dealer-verified",cargurus:"Price analysis" };

    for (const card of r.affiliate_cards.slice(0, 3)) {
      const key   = card.program_key || card.program || "";
      const color = COLORS[key] || "#7c8cf8";
      const icon  = card.icon || ICONS[key] || "🛒";
      const trust = TRUST[key] || "Trusted retailer";
      const name  = card.badge_label || key;
      let cardPrice = 0;
      if (card.price_hint) { const m = String(card.price_hint).match(/([0-9,]+(?:\.[0-9]+)?)/); if (m) cardPrice = parseFloat(m[1].replace(/,/g,"")); }
      else if (card.price) cardPrice = parseFloat(card.price) || 0;
      const saving = cardPrice > 0 ? r.price - cardPrice : 0;

      const cardEl = document.createElement("a");
      cardEl.href = card.url || "#"; cardEl.target = "_blank"; cardEl.rel = "noopener noreferrer";
      cardEl.style.cssText = "display:block;text-decoration:none;background:rgba(15,23,42,0.55);border:1.5px solid rgba(255,255,255,0.08);border-left:4px solid " + color + ";border-radius:10px;padding:11px 12px 10px;margin-bottom:8px;cursor:pointer";
      cardEl.onmouseenter = () => { cardEl.style.background = "rgba(255,255,255,0.07)"; };
      cardEl.onmouseleave = () => { cardEl.style.background = "rgba(15,23,42,0.55)"; };
      cardEl.innerHTML = '<div style="display:flex;align-items:center;gap:9px;margin-bottom:7px">' +
        '<div style="width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;background:' + color + '1a;border:1.5px solid ' + color + '55">' + icon + "</div>" +
        '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800;color:' + color + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(name) + "</div>" +
        '<div style="font-size:10.5px;color:#64748b;margin-top:2px">' + escHtml(trust) + "</div></div>" +
        (cardPrice > 0 ? '<div style="display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0"><div style="font-size:18px;font-weight:900;color:#f1f5f9">$' + cardPrice.toFixed(0) + "</div>" +
        (saving > 2 ? '<div style="font-size:10px;font-weight:700;color:#6ee7b7;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);border-radius:5px;padding:1px 7px">$' + saving.toFixed(0) + " less</div>" : "") + "</div>" : "") + "</div>" +
        (card.subtitle ? '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">' + escHtml(card.subtitle) + "</div>" : "") +
        '<div style="display:flex;align-items:center;justify-content:center;background:' + color + ';color:#fff;font-size:12px;font-weight:800;border-radius:7px;padding:8px 0">' + (cardPrice > 0 ? "Shop " : "Compare on ") + escHtml(name) + " →</div>";
      cardEl.addEventListener("click", () => {
        try { chrome.runtime.sendMessage({ type:"AFFILIATE_CLICK", program:key, category:r.category_detected||"", price_bucket:priceBucket(r.price), deal_score:score }); } catch(e) {}
      });
      section.appendChild(cardEl);
    }
    container.appendChild(section);
  }

  function renderFooter(container) {
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;align-items:center;justify-content:center;padding:8px 12px;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px";
    footer.innerHTML = '<span style="font-size:10px;color:#4b5563">Deal Scout v' + VERSION + ' · OfferUp</span>';
    container.appendChild(footer);
  }

  // ── Auto-Score (with SPA retry logic) ─────────────────────────────────────
  let _scored = false;
  let _observer = null;

  async function autoScore() {
    if (_scored) return;
    const listing = extractListing();
    if (!listing.price || !listing.title) return;
    _scored = true;
    if (_observer) { _observer.disconnect(); _observer = null; }
    showPanel();
    renderLoading(listing);
    try {
      const result = await sendToBackground(listing);
      renderScore(result);
    } catch (err) {
      renderError(err.message || "Scoring failed");
    }
  }

  function waitForContent() {
    // OfferUp React app — wait for the price to appear in the DOM
    let attempts = 0;
    const check = () => {
      attempts++;
      const listing = extractListing();
      if (listing.price && listing.title) {
        autoScore();
        return;
      }
      if (attempts < 20) setTimeout(check, 500);
    };
    check();
  }

  // ── Message Listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "RESCORE") {
      _scored = false;
      removePanel();
      setTimeout(waitForContent, 400);
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── SPA Navigation Detection ───────────────────────────────────────────────
  let _lastUrl = location.href;
  function onUrlChange() {
    const cur = location.href;
    if (cur === _lastUrl) return;
    _lastUrl = cur;
    if (isListingPage()) {
      _scored = false;
      removePanel();
      setTimeout(waitForContent, 1500);
    }
  }

  window.addEventListener("popstate", onUrlChange);

  const _origPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _origPushState(...args);
    onUrlChange();
  };
  const _origReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _origReplaceState(...args);
    onUrlChange();
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  if (isListingPage()) {
    setTimeout(waitForContent, 1500);
  }

})();
