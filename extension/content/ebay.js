/**
 * ebay.js — Deal Scout Content Script for eBay Listings
 * v0.42.0 — Auction Mode: detects auction listings and shows bid range guidance
 *           instead of misleading "current bid = price" deal scoring.
 *
 * INJECTED INTO: www.ebay.com/itm/*  (listing detail pages)
 * PURPOSE: Scores eBay used/refurb listings against market comps,
 *          helping buyers know if the Buy-It-Now price is fair.
 *
 * MANIFEST ENTRY NEEDED:
 *   {
 *     "matches": ["https://www.ebay.com/itm/*"],
 *     "js": ["ebay.js"],
 *     "run_at": "document_idle"
 *   }
 */

(function () {
  "use strict";

  const VERSION  = chrome.runtime.getManifest().version;
  const PANEL_ID = "deal-scout-ebay-panel";
  const PLATFORM = "ebay";

  if (window.__dsEbayInjected) return;
  window.__dsEbayInjected = true;

  let API_BASE = "https://deal-scout-805lager.replit.app/api/ds";
  const DS_API_KEY = atob("MDVlZmZjMGQ2NTg2MTJiYzc5N2QwNDM0NWVhYWM4OTBfZXZpbF9zZA==").split('').reverse().join('');
  try {
    chrome.storage.local.get("ds_api_base", (r) => {
      if (r && r.ds_api_base) API_BASE = r.ds_api_base;
    });
  } catch (e) {}

  // ── Detection ──────────────────────────────────────────────────────────────
  function isListingPage() {
    return /ebay\.(com|co\.uk|ca|com\.au|de|fr|it|es)\/(itm|p)\//.test(location.href);
  }

  // ── Extraction ─────────────────────────────────────────────────────────────
  function extractListing() {
    const title =
      document.querySelector(".x-item-title__mainTitle .ux-textspans--BOLD")?.textContent?.trim() ||
      document.querySelector(".x-item-title__mainTitle .ux-textspans")?.textContent?.trim() ||
      document.querySelector("#itemTitle")?.textContent?.replace("Details about", "").trim() ||
      document.title.split("|")[0].trim();

    const priceEl =
      document.querySelector(".x-price-primary .ux-textspans--BOLD") ||
      document.querySelector(".x-price-primary .ux-textspans") ||
      document.querySelector("#prcIsum") ||
      document.querySelector("[itemprop='price']");
    const priceText = priceEl?.textContent?.trim() || priceEl?.getAttribute("content") || "";
    const price = parseFloat(priceText.replace(/[^0-9.]/g, "")) || 0;

    const conditionEl =
      document.querySelector(".x-item-condition-text .ux-textspans") ||
      document.querySelector("#vi-itm-cond") ||
      document.querySelector("[itemprop='itemCondition']");
    const conditionText = conditionEl?.textContent?.trim() || "";
    const condition = normalizeCondition(conditionText);

    const locationEl =
      document.querySelector(".ux-seller-section__item--seller .ux-textspans") ||
      document.querySelector(".x-sellercard-atf__info__about-seller .ux-textspans");
    const locationText = document.querySelector("[itemprop='itemLocation']")?.textContent?.trim()
      || locationEl?.textContent?.trim() || "";

    const description =
      document.querySelector("[itemprop='description']")?.textContent?.slice(0, 800).trim() ||
      document.querySelector(".x-item-description")?.textContent?.slice(0, 800).trim() || "";

    const images = [];
    document.querySelectorAll(".ux-image-carousel-item.image img, .vi-image-enhance img").forEach(img => {
      const src = img.src || img.getAttribute("data-zoom-src") || "";
      if (src && !images.includes(src) && !src.includes("placeholder")) images.push(src);
    });

    const shippingEl = document.querySelector(".x-bin-price__ship .ux-textspans") ||
                       document.querySelector(".vi-acc-del-range");
    const shippingText = shippingEl?.textContent || "";
    const shippingFree = /free\s+ship/i.test(shippingText);
    const shippingMatch = shippingText.match(/\$([0-9]+(?:\.[0-9]{2})?)/);
    const shipping_cost = shippingFree ? 0 : (shippingMatch ? parseFloat(shippingMatch[1]) : 0);

    return {
      title, price,
      raw_price_text: priceText,
      description,
      condition,
      location: locationText,
      image_urls: images.slice(0, 5),
      shipping_cost,
      listing_url: location.href,
      platform: PLATFORM,
    };
  }

  function normalizeCondition(text) {
    const t = text.toLowerCase();
    if (/brand new|new with tags|new in box/i.test(t)) return "New";
    if (/like new|open box|manufacturer refurbished/i.test(t)) return "Like New";
    if (/seller refurbished|certified refurb/i.test(t)) return "Like New";
    if (/very good/i.test(t)) return "Good";
    if (/good/i.test(t)) return "Good";
    if (/acceptable|fair|for parts|not working/i.test(t)) return "Fair";
    if (/used/i.test(t)) return "Used";
    return text || "Used";
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
    if (p < 50)   return "0-50";
    if (p < 200)  return "50-200";
    if (p < 500)  return "200-500";
    if (p < 1000) return "500-1000";
    return "1000+";
  }

  // ── Raw Data Extraction ──────────────────────────────────────────────────────

  // Detect auction-mode signals from the eBay DOM.
  // WHY: eBay shows "Current bid" instead of asking price for auctions, which
  // tricks the backend into thinking a $87 bid on a $400 MacBook is an
  // "exceptional value / likely scam". Detecting auction mode lets the backend
  // suppress the false scam flag and return bid guidance instead.
  function extractAuctionData(mainEl) {
    const text = (mainEl.innerText || "");
    const lower = text.toLowerCase();

    // Look for unambiguous auction signals:
    //   "Current bid" / "Starting bid" labels (always present on auctions)
    //   "Place bid" button text
    //   "X bids" or "(X bids)" near the price
    //   "Time left:" countdown
    const hasCurrentBidLabel = /current\s+bid\s*:?/i.test(text) || /starting\s+bid\s*:?/i.test(text);
    const hasPlaceBidBtn     = /place\s+bid\b/i.test(text) || /\bbid\s+now\b/i.test(text);
    // Bid count: eBay sometimes renders concatenated text like "8 bidsEnds in 3d"
    // (no whitespace), so we cannot require a trailing word boundary. Accept
    // either the "(N bids)" parenthetical form or "N bid(s)" followed by ANY
    // non-digit character (or end of string).
    const bidCountMatch      = text.match(/\((\d+)\s+bids?\)/i) ||
                               text.match(/(\d+)\s+bids?(?:[^a-z0-9]|$)/i) ||
                               text.match(/(\d+)\s+bids?([A-Z])/);
    // Time left: modern eBay shows "Ends in 3d 22h" or "Ends Mon, Apr 21" or
    // "3d 22h left" instead of literal "Time left:". Accept several variants.
    const timeLeftMatch =
        text.match(/time\s+left\s*:?\s*([^\n\r]{1,60})/i) ||
        text.match(/ends\s+in\s+([^\n\r]{1,40}?)(?:[A-Z][a-z]{2}day|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\n|$)/i) ||
        text.match(/\b(\d+d\s*\d+h(?:\s*\d+m)?)\s+left\b/i) ||
        text.match(/ends\s+in\s+(\d+d\s*\d+h)/i);
    const hasTimeLeft        = !!timeLeftMatch;

    // Buy It Now signals (may co-exist with auction on hybrid listings)
    const hasBuyItNow = /buy\s+it\s+now/i.test(text);
    let buyItNowPrice = 0;
    if (hasBuyItNow) {
      // Find a price near "Buy It Now" — search a 200-char window around the match
      const idx = lower.indexOf("buy it now");
      if (idx >= 0) {
        const windowText = text.slice(Math.max(0, idx - 50), idx + 200);
        const priceMatch = windowText.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
        if (priceMatch) buyItNowPrice = parseFloat(priceMatch[1].replace(/,/g, "")) || 0;
      }
    }

    // Current bid amount — try several anchors in order of reliability:
    //  1. First $ price near "Current bid" / "Starting bid" label
    //  2. First $ price within ~150 chars BEFORE "X bids" text (modern eBay
    //     shows "$152.50\n8 bids" with no explicit label)
    //  3. First $ price within ~250 chars BEFORE the "Place bid" button
    let currentBid = 0;
    const cbIdx = lower.indexOf("current bid");
    const sbIdx = lower.indexOf("starting bid");
    const bidLabelIdx = cbIdx >= 0 ? cbIdx : sbIdx;
    if (bidLabelIdx >= 0) {
      const windowText = text.slice(bidLabelIdx, bidLabelIdx + 200);
      const priceMatch = windowText.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      if (priceMatch) currentBid = parseFloat(priceMatch[1].replace(/,/g, "")) || 0;
    }
    if (!currentBid && bidCountMatch && bidCountMatch.index !== undefined) {
      const bcIdx = bidCountMatch.index;
      const windowText = text.slice(Math.max(0, bcIdx - 150), bcIdx);
      const prices = windowText.match(/\$\s*[\d,]+(?:\.\d{2})?/g);
      if (prices && prices.length) {
        // Take the price closest to the "X bids" text (last in the slice)
        const last = prices[prices.length - 1];
        currentBid = parseFloat(last.replace(/[^\d.]/g, "")) || 0;
      }
    }
    if (!currentBid && hasPlaceBidBtn) {
      const pbIdx = lower.search(/place\s+bid|bid\s+now/);
      if (pbIdx >= 0) {
        const windowText = text.slice(Math.max(0, pbIdx - 250), pbIdx);
        const prices = windowText.match(/\$\s*[\d,]+(?:\.\d{2})?/g);
        if (prices && prices.length) {
          const last = prices[prices.length - 1];
          currentBid = parseFloat(last.replace(/[^\d.]/g, "")) || 0;
        }
      }
    }

    const isAuction = hasCurrentBidLabel || hasPlaceBidBtn || hasTimeLeft;

    return {
      is_auction:        !!isAuction,
      current_bid:       currentBid,
      bid_count:         bidCountMatch ? parseInt(bidCountMatch[1] || bidCountMatch[2], 10) || 0 : 0,
      time_left_text:    timeLeftMatch ? timeLeftMatch[1].trim().slice(0, 60) : "",
      has_buy_it_now:    !!hasBuyItNow,
      buy_it_now_price:  buyItNowPrice,
    };
  }

  function extractRaw() {
    // eBay images: the main product image carousel
    const imageUrls = Array.from(
      document.querySelectorAll(".ux-image-carousel-item img, #icImg, [class*='image-treatment'] img")
    )
      .map(img => img.src || img.getAttribute("data-src"))
      .filter(s => s && s.startsWith("http"))
      .slice(0, 5);

    // eBay pages are multi-page — prefer the main content area
    const mainEl = document.querySelector("#LeftSummaryPanel, #vi-content, main, [role='main']")
                || document.body;
    const rawText = (mainEl.innerText || "").slice(0, 4000);

    const auction = extractAuctionData(mainEl);

    return {
      raw_text:         rawText,
      image_urls:       imageUrls,
      platform:         PLATFORM,
      listing_url:      location.href,
      is_auction:       auction.is_auction,
      current_bid:      auction.current_bid,
      bid_count:        auction.bid_count,
      time_left_text:   auction.time_left_text,
      has_buy_it_now:   auction.has_buy_it_now,
      buy_it_now_price: auction.buy_it_now_price,
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
    const auctionAdv = r.auction_advice || {};
    const isAuction = !!auctionAdv.is_auction;
    // mode === "primary" → pure auction, replace score with auction panel
    // mode === "secondary" → hybrid (auction + BIN), normal score + auction info below
    const isPrimaryAuction = isAuction && auctionAdv.mode !== "secondary";

    if (isPrimaryAuction) {
      renderAuctionHeader(r, panel);
      renderAuctionAdvice(r, panel);
    } else {
      renderHeader(r, panel);
    }
    renderSummary(r, panel);
    renderMarketData(r, panel);
    if (!isPrimaryAuction) renderBuyNewSection(r, panel);
    // Hybrid auctions: show auction info as secondary panel below market data
    if (isAuction && !isPrimaryAuction) renderAuctionAdvice(r, panel);
    renderFlags(r, panel);
    renderSecurityScore(r, panel);
    renderBundleBreakdown(r, panel);
    if (!isPrimaryAuction) renderNegotiationMessage(r, panel);
    renderFooter(r, panel);
  }

  function renderHeader(r, container) {
    const score = r.score || 0;
    const scoreColor = score >= 7 ? "#22c55e" : score >= 5 ? "#fbbf24" : "#ef4444";
    const verdict = r.verdict || (score >= 7 ? "Good Deal" : score >= 5 ? "Fair Deal" : "Overpriced");

    const hdr = document.createElement("div");
    hdr.style.cssText = "background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0;padding:10px 12px;cursor:move";

    const topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px";
    topRow.innerHTML = DOMPurify.sanitize('<span style="font-weight:700;font-size:13px;color:#7c8cf8">📊 Deal Scout</span>');
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

    const scoreRow = document.createElement("div");
    scoreRow.style.cssText = "display:flex;align-items:center;gap:10px";
    scoreRow.innerHTML = DOMPurify.sanitize('<div style="width:52px;height:52px;border-radius:50%;border:3px solid ' + scoreColor + ';display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
      '<span style="font-size:22px;font-weight:900;color:' + scoreColor + '">' + score + "</span></div>" +
      '<div><div style="font-size:14px;font-weight:800;color:#e2e8f0">' + escHtml(verdict) + "</div>" +
      '<div style="font-size:11px;color:#94a3b8;margin-top:2px">' + (r.should_buy === false ? "⛔ Skip" : r.should_buy ? "✅ Worth buying" : "") + "</div>" +
      '<div style="font-size:10px;color:#6b7280;margin-top:1px">🏷 eBay listing · $' + (r.price || 0).toFixed(0) + "</div></div>");
    hdr.appendChild(scoreRow);
    container.appendChild(hdr);
  }

  // Auction Mode header — replaces the score circle with an "AUCTION" badge
  // showing current bid + bid count + time left. The deal-score number is
  // misleading for auctions (the price will rise), so we emphasize bid
  // strategy instead.
  function renderAuctionHeader(r, container) {
    const a = r.auction_advice || {};
    // IMPORTANT: do NOT fall back to r.price — for pure auctions r.price has
    // been overridden to suggested_max_bid by the backend, so falling back
    // would display the bid ceiling as if it were the current bid.
    const curBid = a.current_bid || 0;
    const bids = a.bid_count || 0;
    const timeLeft = a.time_left || "";

    const hdr = document.createElement("div");
    hdr.style.cssText = "background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0;padding:10px 12px;cursor:move";

    const topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px";
    topRow.innerHTML = DOMPurify.sanitize('<span style="font-weight:700;font-size:13px;color:#7c8cf8">📊 Deal Scout</span>');
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

    const auctionRow = document.createElement("div");
    auctionRow.style.cssText = "display:flex;align-items:center;gap:10px";
    auctionRow.innerHTML = DOMPurify.sanitize(
      '<div style="background:linear-gradient(135deg,#7c3aed 0%,#a855f7 100%);color:#fff;padding:8px 10px;border-radius:8px;font-weight:800;font-size:11px;letter-spacing:0.5px;flex-shrink:0;text-align:center;min-width:62px">' +
        '<div style="font-size:14px;line-height:1">🔨</div>' +
        '<div style="margin-top:2px">AUCTION</div>' +
      '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:14px;font-weight:800;color:#e2e8f0">Current bid: $' + (curBid || 0).toFixed(0) + '</div>' +
        '<div style="font-size:11px;color:#94a3b8;margin-top:2px">' +
          (bids ? (bids + ' bid' + (bids === 1 ? '' : 's')) : 'No bids yet') +
          (timeLeft ? ' · ⏱ ' + escHtml(timeLeft) : '') +
        '</div>' +
        '<div style="font-size:10px;color:#6b7280;margin-top:1px">🏷 eBay auction listing</div>' +
      '</div>'
    );
    hdr.appendChild(auctionRow);
    container.appendChild(hdr);
  }

  // Bid Strategy panel — the headline output for auction mode.
  // Shows: walk-away ceiling, suggested max bid, current bid, market avg.
  // This is what replaces the "Better Deal / Fair Deal / Overpriced" verdict
  // for auction listings.
  function renderAuctionAdvice(r, container) {
    const a = r.auction_advice || {};
    const maxBid = a.suggested_max_bid || 0;
    const walkAway = a.walk_away_price || 0;
    const market = a.market_avg || r.sold_avg || 0;
    // Do NOT fall back to r.price — for pure auctions r.price is the
    // suggested_max_bid override, which would mis-paint "current bid" green
    // even when we have no real current_bid value.
    const curBid = a.current_bid || 0;

    const section = document.createElement("div");
    section.style.cssText = "background:linear-gradient(135deg,rgba(124,58,237,0.10),rgba(34,197,94,0.05));border:1px solid rgba(124,58,237,0.28);border-radius:10px;padding:11px 12px;margin:10px 12px 0";

    const hdr = document.createElement("div");
    hdr.style.cssText = "font-weight:700;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#c4b5fd;margin-bottom:8px;display:flex;align-items:center;gap:6px";
    hdr.innerHTML = DOMPurify.sanitize('<span>🎯 Bid Strategy</span>');
    section.appendChild(hdr);

    if (maxBid > 0 && walkAway > 0) {
      // Bid range visualization
      const range = document.createElement("div");
      range.style.cssText = "display:flex;flex-direction:column;gap:8px";
      range.innerHTML = DOMPurify.sanitize(
        '<div style="display:flex;justify-content:space-between;align-items:baseline">' +
          '<span style="font-size:11px;color:#9ca3af">Bid up to (great deal)</span>' +
          '<span style="font-size:18px;font-weight:800;color:#22c55e">$' + maxBid.toFixed(0) + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline">' +
          '<span style="font-size:11px;color:#9ca3af">Walk away above</span>' +
          '<span style="font-size:14px;font-weight:700;color:#ef4444">$' + walkAway.toFixed(0) + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;margin-top:2px">' +
          '<span style="font-size:11px;color:#6b7280">Market avg (sold)</span>' +
          '<span style="font-size:12px;font-weight:600;color:#94a3b8">$' + market.toFixed(0) + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline">' +
          '<span style="font-size:11px;color:#6b7280">Current bid</span>' +
          '<span style="font-size:12px;font-weight:600;color:' + (curBid <= maxBid ? '#22c55e' : (curBid <= walkAway ? '#fbbf24' : '#ef4444')) + '">$' + curBid.toFixed(0) + '</span>' +
        '</div>'
      );
      section.appendChild(range);

      // Status callout based on where current bid sits
      const status = document.createElement("div");
      let statusText = "", statusColor = "";
      if (curBid <= maxBid) {
        statusText = "✅ Still room to bid for a great deal";
        statusColor = "#22c55e";
      } else if (curBid <= walkAway) {
        statusText = "⚠️ Approaching market value — bid carefully";
        statusColor = "#fbbf24";
      } else {
        statusText = "⛔ Already above market — let it go";
        statusColor = "#ef4444";
      }
      status.style.cssText = "margin-top:9px;padding:7px 9px;background:rgba(0,0,0,0.18);border-radius:6px;font-size:12px;font-weight:600;color:" + statusColor;
      status.textContent = statusText;
      section.appendChild(status);
    }

    if (a.reasoning) {
      const note = document.createElement("div");
      note.style.cssText = "margin-top:8px;font-size:11px;color:#c4b5fd;line-height:1.45;font-style:italic";
      note.textContent = a.reasoning;
      section.appendChild(note);
    }

    container.appendChild(section);
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
    const hdr = document.createElement("div");
    hdr.style.cssText = "font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#9ca3af;margin-bottom:8px";
    hdr.textContent = "📈 Market Comparison";
    section.appendChild(hdr);

    // For pure auctions r.price is the suggested_max_bid override, not what
    // the user is actually paying. Substitute the real current_bid (or the
    // BIN price for hybrid listings) and label it appropriately.
    const aa = r.auction_advice || {};
    const isPureAuction = aa.is_auction && aa.mode !== "secondary";
    const isHybrid = aa.is_auction && aa.mode === "secondary";
    let priceRowLabel = "Listed price";
    let priceRowValue = r.price || 0;
    let comparePrice = r.price || 0;  // used for the "X below/above market" delta
    if (isPureAuction) {
      priceRowLabel = "Current bid";
      priceRowValue = aa.current_bid || 0;
      comparePrice = aa.current_bid || 0;
    } else if (isHybrid) {
      priceRowLabel = "Buy It Now price";
      // r.price is already the BIN price for hybrids — keep it
    }

    const ps = "$";
    const rows = [];
    if (r.sold_avg)   rows.push({ label: "eBay sold avg",   value: ps + r.sold_avg.toFixed(0),   bold: true });
    if (r.active_avg) rows.push({ label: "Active listings", value: ps + r.active_avg.toFixed(0) });
    if (r.new_price)  rows.push({ label: "New retail",      value: ps + r.new_price.toFixed(0) });
    if (r.craigslist_asking_avg > 0) rows.push({ label: "CL asking avg", value: ps + r.craigslist_asking_avg.toFixed(0), note: "(" + (r.craigslist_count || 0) + " local)" });
    rows.push({ label: priceRowLabel, value: ps + priceRowValue.toFixed(0) });

    for (const row of rows) {
      const el = document.createElement("div");
      el.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)";
      el.innerHTML = DOMPurify.sanitize('<span style="color:#9ca3af;font-size:12px">' + escHtml(row.label) + (row.note ? ' <span style="color:#6b7280;font-size:10px">' + escHtml(row.note) + "</span>" : "") + "</span>" +
        '<span style="font-weight:' + (row.bold ? "700" : "500") + ';font-size:' + (row.bold ? "14px" : "13px") + '">' + escHtml(row.value) + "</span>");
      section.appendChild(el);
    }

    // Suppress the misleading "X below market" delta for pure auctions when
    // we don't have a real current_bid — otherwise it would show "$0 below
    // market". For pure auctions WITH a current bid, label it as "vs market"
    // (not "below") since the price will rise.
    if (r.sold_avg && comparePrice > 0) {
      const delta = comparePrice - r.sold_avg;
      const pct = Math.abs(Math.round((delta / r.sold_avg) * 100));
      const isBelow = delta < 0;
      const deltaEl = document.createElement("div");
      deltaEl.style.cssText = "margin-top:6px;font-size:12px;font-weight:600;color:" + (isPureAuction ? "#9ca3af" : (isBelow ? "#22c55e" : "#ef4444"));
      const verb = isPureAuction ? (isBelow ? "below" : "above") + " market (current bid)" : (isBelow ? "below" : "above") + " market";
      deltaEl.textContent = "● $" + Math.abs(delta).toFixed(0) + " " + verb + " (" + (isBelow ? "-" : "+") + pct + "%)";
      section.appendChild(deltaEl);
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
    const red = r.red_flags || [];
    const green = r.green_flags || [];
    if (!red.length && !green.length) return;
    const section = document.createElement("div");
    section.style.cssText = "margin:0 12px 8px";
    for (const f of green.slice(0, 3)) {
      const el = document.createElement("div");
      el.style.cssText = "font-size:11.5px;color:#6ee7b7;padding:2px 0";
      el.textContent = "✓ " + f;
      section.appendChild(el);
    }
    for (const f of red.slice(0, 3)) {
      const el = document.createElement("div");
      el.style.cssText = "font-size:11.5px;color:#fca5a5;padding:2px 0";
      el.textContent = "⚠ " + f;
      section.appendChild(el);
    }
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
    else if (score <= 3)   { hdrIcon = "\u26A0\uFE0F"; hdrText = "Better Options Available"; hdrSub = "This eBay price is high \u2014 compare below."; }
    else if (score <= 5)   { hdrIcon = "\uD83D\uDCA1"; hdrText = "Compare Before Bidding"; hdrSub = "Check these alternatives first."; }
    else if (score <= 7)   { hdrIcon = "\u2705"; hdrText = "Solid Deal \u2014 Verify Price"; hdrSub = "Double-check before buying."; }
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

    const COLORS = {amazon:"#f97316",ebay:"#22c55e",best_buy:"#0046be",target:"#ef4444",walmart:"#0071ce",home_depot:"#f96302",lowes:"#004990",back_market:"#16a34a",newegg:"#ff6600",rei:"#3d6b4f",sweetwater:"#e67e22",autotrader:"#e8412c",cargurus:"#00968a",carmax:"#003087",advance_auto:"#e2001a",carparts_com:"#f59e0b",wayfair:"#7b2d8b",dicks:"#1e3a5f",chewy:"#0c6bb1"};
    const ICONS = {amazon:"\uD83D\uDCE6",ebay:"\uD83C\uDFEA",best_buy:"\uD83D\uDCBB",target:"\uD83C\uDFAF",walmart:"\uD83D\uDED2",home_depot:"\uD83C\uDFE0",lowes:"\uD83D\uDD28",back_market:"\u267B\uFE0F",newegg:"\uD83D\uDCBB",rei:"\u26FA",sweetwater:"\uD83C\uDFB8",autotrader:"\uD83D\uDE97",cargurus:"\uD83D\uDD0D",carmax:"\uD83C\uDFE2",advance_auto:"\uD83D\uDD27",carparts_com:"\u2699\uFE0F"};
    const TRUST = {amazon:"Prime eligible \u2022 Free returns",ebay:"Money-back guarantee \u2022 Buyer protection",best_buy:"Geek Squad warranty",back_market:"Certified refurb \u2022 1-yr warranty",newegg:"Tech deals \u2022 Flash sales",autotrader:"Dealer-verified",cargurus:"Price analysis",carmax:"5-day return",advance_auto:"Free pickup",carparts_com:"Fast shipping"};

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
      thumbWrap.style.cssText = "display:flex;gap:8px";
      const makeThumb = (emoji, label, val) => {
        const btn = document.createElement("button");
        btn.style.cssText = "display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:14px;color:#d1d5db";
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
    }
    const versionEl = document.createElement("div");
    versionEl.style.cssText = "text-align:center;font-size:10px;color:#374151;margin-top:" + (r && r.score_id ? "8px" : "0");
    versionEl.textContent = "Deal Scout v" + VERSION + " · eBay";
    footer.appendChild(versionEl);
    container.appendChild(footer);
  }

  // ── Auto-Score ─────────────────────────────────────────────────────────────
  async function autoScore() {
    if (!isListingPage()) return;

    let waited = 0;
    while ((document.body.innerText || "").length < 200 && waited < 15) {
      await new Promise(r => setTimeout(r, 200));
      waited++;
    }

    const rawData = extractRaw();
    if (!rawData.raw_text || rawData.raw_text.length < 100) return;

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

  // ── Message Listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "RESCORE") { removePanel(); setTimeout(autoScore, 400); sendResponse({ ok: true }); }
    return true;
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  if (isListingPage()) setTimeout(autoScore, 1500);

})();
