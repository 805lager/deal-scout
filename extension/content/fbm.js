/**
 * content/fbm.js — Facebook Marketplace Content Script v0.4.0
 *
 * FEATURES:
 *   1. Collapsible deal scoring sidebar (bottom-right tab, draggable)
 *   2. Auto-scores on page load + SPA re-injection
 *   3. Pro gating — full AI analysis requires Pro toggle
 *   4. Price history tracking (chrome.storage.local, no server)
 *   5. Search results overlay (score badges on listing thumbnails)
 *   6. Seller trust extraction from DOM
 *   7. Shipping cost extraction — adds to total cost for scoring
 *   8. Price reduction detection (strikethrough original price)
 *   9. Image extraction for Claude Vision
 *  10. Like Products (affiliate cards from eBay comps)
 *  11. Better Options (Claude suggestion cards)
 *  12. Product reliability badge
 *
 * ARCHITECTURE NOTE:
 *   All rendering uses DOM creation + addEventListener — NEVER inline onclick.
 *   Facebook's CSP strips inline event handlers from dynamically injected HTML.
 *   Failing to follow this causes silent click failures.
 */

(function () {
  "use strict";

  // Prevent double-injection on SPA re-navigations
  if (window.__dealScoutInjected) {
    // Already injected — just re-score
    window.__dealScoutRescore && window.__dealScoutRescore();
    return;
  }
  window.__dealScoutInjected = true;

  const API_BASE  = "http://localhost:8000";
  const VERSION   = "0.4.0";
  const LOG_PRE   = "[DealScout]";

  // ── Pro Check ───────────────────────────────────────────────────────────────
  // Reads from chrome.storage.local — set by popup toggle
  async function isPro() {
    try {
      const r = await chrome.storage.local.get("ds_pro");
      return r.ds_pro === true;
    } catch { return false; }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 1 — DATA EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find the listing title.
   * FBM renders it as an h1 — but the LEFT NAV also has an h1 ("Notifications").
   * We want the SECOND h1, which is always the listing title in the right panel.
   * WHY NOT data-testid: Facebook removed all data-testid attrs in early 2025.
   */
  function findTitle() {
    const h1s = document.querySelectorAll("h1");
    for (const h1 of h1s) {
      const t = h1.textContent.trim();
      if (t && t !== "Notifications" && t.length > 2) return t;
    }
    return document.title.replace(" | Facebook", "").trim();
  }

  /**
   * Find the current listing price.
   *
   * FBM DOM structure for price-reduced listings:
   *   <span>          ← container
   *     "$200"        ← text node (CURRENT price) — NOT a child element
   *     <span style="text-decoration:line-through">$250</span>  ← original
   *   </span>
   *
   * WHY TEXT NODE: querySelectorAll("span") is blind to raw text nodes.
   * We detect the dual-price container by finding a span whose immediate
   * children include a line-through span, then walk the container's
   * childNodes to extract the text node value.
   *
   * Returns: { price: number, original: number|null }
   */
  function findPrices() {
    // First try: look for dual-price container (reduced listing)
    const allSpans = document.querySelectorAll("span");
    for (const span of allSpans) {
      const children = span.children;
      // Look for a span that has exactly one child with line-through style
      for (const child of children) {
        const deco = window.getComputedStyle(child).textDecoration;
        if (deco.includes("line-through")) {
          // Found the original price span — parent is the dual-price container
          const original = parsePrice(child.textContent);

          // Walk parent's childNodes to find the text node (current price)
          for (const node of span.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              const current = parsePrice(node.textContent);
              if (current > 0 && current < original) {
                return { price: current, original };
              }
            }
          }
        }
      }
    }

    // Fallback: find first price-like span near the listing panel
    // Strategy: find the h1 title, then look for a price in the nearest ancestor
    const h1 = Array.from(document.querySelectorAll("h1")).find(
      h => h.textContent.trim() !== "Notifications" && h.textContent.trim().length > 2
    );

    if (h1) {
      // Walk up to a reasonable ancestor and search downward for a price
      let ancestor = h1.parentElement;
      for (let depth = 0; depth < 8 && ancestor; depth++, ancestor = ancestor.parentElement) {
        const spans = ancestor.querySelectorAll("span");
        for (const span of spans) {
          const txt = span.textContent.trim();
          if (/^\$[\d,]+$/.test(txt)) {
            const price = parsePrice(txt);
            if (price > 0) return { price, original: null };
          }
        }
      }
    }

    return { price: 0, original: null };
  }

  function parsePrice(text) {
    if (!text) return 0;
    // Extract only the FIRST price from a string like "$200$250" or "$200 - $250"
    const match = text.match(/\$?([\d,]+)/);
    return match ? parseFloat(match[1].replace(/,/g, "")) : 0;
  }

  function formatPriceText(price, original) {
    if (!price) return "$0";
    let txt = "$" + price.toLocaleString();
    if (original && original > price) {
      txt += ` (was $${original.toLocaleString()})`;
    }
    return txt;
  }


  /**
   * Find shipping cost.
   * FBM shows "Ships for $46.68" near the price section.
   * Returns a float (0 if free/local pickup).
   *
   * WHY THIS MATTERS: $275 item + $46 shipping = $321 TRUE COST.
   * Without shipping, Claude sees a "bad deal" as borderline.
   * With shipping, Claude correctly identifies it as overpriced.
   */
  function findShippingCost() {
    const patterns = [
      /ships?\s+for\s+\$(\d+(?:\.\d{1,2})?)/i,
      /shipping[:\s]+\$(\d+(?:\.\d{1,2})?)/i,
      /delivery[:\s]+\$(\d+(?:\.\d{1,2})?)/i,
    ];
    const bodyText = document.body.innerText;
    for (const re of patterns) {
      const match = bodyText.match(re);
      if (match) return parseFloat(match[1]);
    }
    return 0;
  }


  /**
   * Find the item condition.
   * FBM renders condition options inline. Strategy: find the word near a
   * "Condition" label. Prefer longer condition strings over short ones
   * (avoids grabbing bare "New" which appears all over the page).
   */
  function findCondition() {
    const conditions = [
      "Used - Like New",
      "Used - Good",
      "Used - Fair",
      "Used - Poor",
      "For Parts",
      "New",
    ];

    // Try to find a label reading "Condition" and extract nearby text
    const allText = document.body.innerText;
    const condBlock = allText.match(/Condition[\s\n:]+(.{3,30})/);
    if (condBlock) {
      const nearby = condBlock[1].trim();
      for (const c of conditions) {
        if (nearby.toLowerCase().startsWith(c.toLowerCase())) return c;
      }
    }

    // Fallback: scan the page for full condition strings
    for (const c of conditions.filter(c => c !== "New")) {
      if (allText.includes(c)) return c;
    }

    // Last resort: look for standalone "New"
    if (/\bNew\b/.test(allText)) return "New";
    return "Unknown";
  }


  /**
   * Find the listing description.
   * FBM renders description in a contenteditable or span[dir=auto] block.
   * We exclude short social-media noise and navigation strings.
   */
  function findDescription() {
    const NOISE = [
      /^marketplace$/i, /^facebook$/i, /^you'll see/i, /^discover/i,
      /^browse/i, /^search/i, /^notifications$/i, /^messaging/i,
    ];

    const candidates = document.querySelectorAll("span[dir=auto]");
    let best = { text: "", len: 0 };

    for (const el of candidates) {
      const text = el.textContent.trim();
      if (text.length <= 20) continue;
      if (NOISE.some(re => re.test(text))) continue;
      // Avoid nav elements
      const role = el.getAttribute("role");
      if (role === "navigation" || role === "banner") continue;
      if (text.length > best.len) {
        best = { text, len: text.length };
      }
    }

    return best.text.slice(0, 800);
  }


  /**
   * Find the listing location (City, ST format).
   * FBM renders this as "Listed in City, State" or just "City, ST".
   */
  function findLocation() {
    const bodyText = document.body.innerText;

    // Explicit label patterns
    const labeled = bodyText.match(/(?:Listed\s+in|Location)[:\s]+([A-Za-z\s]+,\s*[A-Z]{2})/);
    if (labeled) return labeled[1].trim();

    // Generic "City, ST" anywhere in visible text
    const cityState = bodyText.match(/\b([A-Z][a-zA-Z\s]{2,20}),\s+([A-Z]{2})\b/);
    if (cityState) return cityState[0].trim();

    return "";
  }


  /**
   * Find the seller's name.
   */
  function findSellerName() {
    // FBM renders seller name in various locations — try multiple patterns
    const links = document.querySelectorAll("a[href*='/user/'], a[href*='/profile/']");
    for (const link of links) {
      const text = link.textContent.trim();
      if (text && text.length > 1 && text.length < 60 && !text.includes("Facebook")) {
        return text;
      }
    }
    return "";
  }


  /**
   * Find listing images.
   * FBM serves listing photos from fbcdn.net with specific URL patterns.
   * We filter out profile photos (which also use fbcdn.net) by checking
   * the CDN tier in the URL (t45. = Marketplace CDN, not t1. profile tier).
   *
   * Returns array of URLs (first one sent to Claude Vision).
   */
  function findListingImages() {
    const images = [];
    const seen   = new Set();

    const candidates = document.querySelectorAll("img[src*='fbcdn.net']");
    for (const img of candidates) {
      const src = img.src;
      // Marketplace listing photos use _n.jpg AND come from t45. tier CDN
      if (!src.includes("_n.jpg")) continue;
      if (!src.includes("t45.")) continue;

      // Min size check — listing photos are at least 100×100
      const w = img.naturalWidth  || img.width  || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 100 || h < 100) continue;

      if (!seen.has(src)) {
        seen.add(src);
        images.push(src);
      }
      if (images.length >= 3) break;
    }

    return images;
  }


  /**
   * Extract seller trust signals from the DOM.
   * FBM renders:
   *   "Joined Facebook in 2022"
   *   "(5)" — review count in parens near seller name
   *   "Highly rated" — badge text
   *
   * WHY NOT scrape star ratings: FBM renders stars as SVG, not a numeric value.
   * We infer a rating from the presence of "Highly rated" badge.
   */
  function extractSellerTrust() {
    const bodyText = document.body.innerText;
    const trust = {
      member_since:     null,
      review_count:     null,
      seller_rating:    null,
      is_highly_rated:  false,
      response_rate:    null,
      other_listings:   null,
      trust_tier:       "unknown",
    };

    // Join year
    const joined = bodyText.match(/Joined\s+Facebook\s+in\s+(\d{4})/i);
    if (joined) trust.member_since = `Jan ${joined[1]}`;

    // Review count — "(N)" pattern near seller section
    const reviews = bodyText.match(/\((\d+)\)/g);
    if (reviews && reviews.length > 0) {
      // Take the smallest number — most likely the review count (not item IDs)
      const nums = reviews.map(r => parseInt(r.replace(/[()]/g, ""))).filter(n => n < 10000);
      if (nums.length > 0) trust.review_count = Math.min(...nums);
    }

    // Highly rated badge
    if (/highly\s+rated/i.test(bodyText)) {
      trust.is_highly_rated = true;
    }

    // Infer numeric rating for prompt context
    if (trust.is_highly_rated) {
      trust.seller_rating = 4.8;
    } else if (trust.review_count && trust.review_count > 0) {
      trust.seller_rating = 4.0; // assume average if reviews exist but no "highly rated"
    }

    // Compute trust tier
    trust.trust_tier = computeTrustTier(trust);

    return trust;
  }

  function computeTrustTier(trust) {
    let score = 0;

    if (trust.is_highly_rated)             score += 3;
    if (trust.review_count >= 10)          score += 2;
    else if (trust.review_count >= 3)      score += 1;
    if (trust.member_since) {
      const year = parseInt((trust.member_since.match(/\d{4}/) || ["2024"])[0]);
      const age  = new Date().getFullYear() - year;
      if (age >= 3)      score += 2;
      else if (age >= 1) score += 1;
    }

    if (score >= 5) return "high";
    if (score >= 2) return "medium";
    return "unknown";
  }


  /**
   * Detect multi-item / bundle listings.
   * Returns true for listings containing 3+ items ("6-tool set", "lot of 5").
   */
  function detectMultiItem(title, description) {
    const text  = (title + " " + description).toLowerCase();
    const multi = [
      /\b(\d+)\s*[-–]?\s*(?:piece|pack|set|tool|item|pc|pcs)\b/,
      /\blot\s+of\s+\d+\b/,
      /\bcollection\s+of\b/,
      /\bkit\s+includes?\b/,
    ];
    for (const re of multi) {
      const m = text.match(re);
      if (m) {
        const n = parseInt(m[1] || "3");
        if (n >= 3) return true;
      }
    }
    return false;
  }


  /**
   * Detect vehicle listings (motorcycles, e-bikes, ATVs, etc.)
   * Suppresses irrelevant flags like "no accessories" and "no packaging".
   */
  function detectVehicle(title, description) {
    const text = (title + " " + description).toLowerCase();
    const keywords = [
      "motorcycle", "dirt bike", "motocross", "mx bike", "pit bike",
      "atv", "quad", "side by side", "utv", "gokart", "go-kart",
      "moped", "scooter", "vespa",
      "surron", "sur-ron", "talaria", "super73", "super 73",
      "light bee", "storm bee", "ultra bee",
      "x160", "x260", "electric dirt bike", "electric moto",
      "kx", "yz", "cr250", "cr500", "rm", "crf", "wr", "ktm",
      "kawasaki", "yamaha dirtbike", "honda dirt",
      "volt battery", "v battery", "60v", "72v", "48v",
    ];
    return keywords.some(kw => text.includes(kw));
  }


  /**
   * Master listing extraction — calls all the helpers above.
   * Returns a flat object ready to POST to /score.
   */
  function extractListing() {
    const title       = findTitle();
    const { price, original: originalPrice } = findPrices();
    const description = findDescription();
    const condition   = findCondition();
    const location    = findLocation();
    const sellerName  = findSellerName();
    const images      = findListingImages();
    const sellerTrust = extractSellerTrust();
    const shippingCost = findShippingCost();

    const isMulti   = detectMultiItem(title, description);
    const isVehicle = detectVehicle(title, description);

    return {
      title,
      price,
      raw_price_text:  formatPriceText(price, originalPrice),
      description,
      condition,
      location,
      seller_name:     sellerName,
      listing_url:     window.location.href,
      is_multi_item:   isMulti,
      is_vehicle:      isVehicle,
      seller_trust:    sellerTrust,
      original_price:  originalPrice || 0,
      shipping_cost:   shippingCost,
      image_urls:      images,
    };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 2 — PRICE HISTORY (chrome.storage.local)
  // ═══════════════════════════════════════════════════════════════════════════

  const HISTORY_KEY_PREFIX = "ds_ph_";

  async function recordPriceHistory(listingUrl, price) {
    if (!price || !listingUrl) return;
    const key = HISTORY_KEY_PREFIX + btoa(listingUrl).slice(0, 40);
    try {
      const stored = await chrome.storage.local.get(key);
      const history = stored[key] || [];
      const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const last = history[history.length - 1];
      if (!last || last.price !== price || last.date !== today) {
        history.push({ price, date: today });
        if (history.length > 10) history.shift();
        await chrome.storage.local.set({ [key]: history });
      }
    } catch (e) {
      console.debug(LOG_PRE, "Price history write failed:", e);
    }
  }

  async function getPriceHistory(listingUrl) {
    if (!listingUrl) return [];
    const key = HISTORY_KEY_PREFIX + btoa(listingUrl).slice(0, 40);
    try {
      const stored = await chrome.storage.local.get(key);
      return stored[key] || [];
    } catch { return []; }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 3 — SEARCH RESULTS OVERLAY
  //  Shows score badges on listing thumbnails on FBM browse/search pages
  // ═══════════════════════════════════════════════════════════════════════════

  const OVERLAY_SCORES_KEY = "ds_scores";
  const isListingPage = () => /\/marketplace\/(item\/|\w+\/item\/)/.test(window.location.pathname);

  async function getSavedScores() {
    try {
      const r = await chrome.storage.local.get(OVERLAY_SCORES_KEY);
      return r[OVERLAY_SCORES_KEY] || {};
    } catch { return {}; }
  }

  async function saveScore(url, score, shouldBuy) {
    try {
      const scores = await getSavedScores();
      scores[url] = { score, shouldBuy, ts: Date.now() };
      // Prune old entries to keep storage small
      const keys = Object.keys(scores);
      if (keys.length > 200) {
        keys.sort((a, b) => scores[a].ts - scores[b].ts).slice(0, 50).forEach(k => delete scores[k]);
      }
      await chrome.storage.local.set({ [OVERLAY_SCORES_KEY]: scores });
    } catch { /* ok */ }
  }

  async function injectSearchOverlay() {
    if (isListingPage()) return;
    const scores = await getSavedScores();

    // Badge each listing card that has a saved score
    const cards = document.querySelectorAll("a[href*='/marketplace/item/']");
    for (const card of cards) {
      if (card.dataset.dsOverlay) continue;
      card.dataset.dsOverlay = "1";

      const href = card.href.split("?")[0];
      const data = scores[href];

      const badge = document.createElement("div");
      badge.style.cssText = `
        position:absolute;top:6px;left:6px;z-index:9999;
        padding:2px 7px;border-radius:12px;font-size:11px;
        font-weight:700;color:#fff;pointer-events:none;
        font-family:system-ui,sans-serif;line-height:1.4;
      `;

      if (data) {
        badge.textContent = data.score;
        badge.style.background = data.shouldBuy ? "#22c55e" :
                                  data.score >= 5 ? "#f59e0b" : "#ef4444";
      } else {
        badge.textContent = "●";
        badge.style.background = "rgba(99,102,241,0.7)";
        badge.style.fontSize = "8px";
      }

      const parent = card.style.position ? card : card.parentElement;
      if (parent) {
        if (getComputedStyle(parent).position === "static") {
          parent.style.position = "relative";
        }
        parent.appendChild(badge);
      }
    }
  }

  // Watch for new cards loaded by infinite scroll
  if (!isListingPage()) {
    injectSearchOverlay();
    const overlayObserver = new MutationObserver(() => injectSearchOverlay());
    overlayObserver.observe(document.body, { childList: true, subtree: true });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 4 — SIDEBAR UI
  // ═══════════════════════════════════════════════════════════════════════════

  // Inject base CSS once
  if (!document.getElementById("ds-styles")) {
    const style = document.createElement("style");
    style.id = "ds-styles";
    style.textContent = `
      #dealscout-root {
        position: fixed;
        z-index: 2147483647;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        color: #f1f5f9;
      }
      #ds-tab {
        position: fixed;
        bottom: 24px;
        right: 0;
        background: #6366f1;
        color: #fff;
        padding: 10px 14px;
        border-radius: 10px 0 0 10px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 700;
        box-shadow: -2px 2px 10px rgba(0,0,0,0.3);
        user-select: none;
        touch-action: none;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: background 0.15s;
      }
      #ds-tab:hover { background: #818cf8; }
      #ds-panel {
        position: fixed;
        bottom: 0;
        right: 0;
        width: 310px;
        max-height: 85vh;
        background: #1e1b2e;
        border-radius: 12px 0 0 0;
        box-shadow: -4px 0 24px rgba(0,0,0,0.5);
        overflow-y: auto;
        overflow-x: hidden;
        display: none;
        z-index: 2147483647;
        scrollbar-width: thin;
        scrollbar-color: #4c1d95 #1e1b2e;
      }
      #ds-panel.open { display: block; }
      .ds-header {
        background: #2d1b69;
        padding: 10px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .ds-header-left { display: flex; align-items: center; gap: 8px; font-weight: 700; }
      .ds-close {
        cursor: pointer; font-size: 18px; opacity: 0.6;
        background: none; border: none; color: #fff; padding: 0;
      }
      .ds-close:hover { opacity: 1; }
      .ds-body { padding: 12px; }
      .ds-score-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
      .ds-score-circle {
        width: 52px; height: 52px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 22px; font-weight: 900; flex-shrink: 0;
        border: 2px solid rgba(255,255,255,0.2);
      }
      .ds-verdict { font-size: 11px; opacity: 0.8; }
      .ds-buy-badge {
        display: inline-block; padding: 2px 9px; border-radius: 12px;
        font-size: 11px; font-weight: 700; margin-bottom: 4px;
      }
      .ds-summary { font-size: 12px; opacity: 0.85; margin: 8px 0; }
      .ds-section { margin: 10px 0; }
      .ds-section-title {
        font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
        text-transform: uppercase; opacity: 0.5; margin-bottom: 6px;
      }
      .ds-price-row {
        display: flex; justify-content: space-between;
        font-size: 12px; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .ds-price-row:last-child { border: none; }
      .ds-price-label { opacity: 0.65; }
      .ds-over   { color: #f87171; }
      .ds-under  { color: #4ade80; }
      .ds-flags { list-style: none; padding: 0; margin: 4px 0; }
      .ds-flags li { font-size: 12px; margin: 3px 0; padding-left: 4px; }
      .ds-offer {
        background: rgba(99,102,241,0.15);
        border: 1px solid rgba(99,102,241,0.3);
        border-radius: 8px; padding: 8px 12px; margin: 8px 0;
        font-size: 13px; display: flex; justify-content: space-between; align-items: center;
      }
      .ds-offer-price { font-size: 20px; font-weight: 800; color: #818cf8; }
      .ds-tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .ds-tab-btn {
        flex: 1; padding: 6px 4px; font-size: 11px; font-weight: 600;
        background: none; border: none; color: rgba(255,255,255,0.5);
        cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s;
      }
      .ds-tab-btn.active { color: #fff; border-bottom-color: #6366f1; }
      .ds-ebay-card {
        display: flex; align-items: center; gap: 8px; padding: 7px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06); cursor: pointer;
        text-decoration: none; color: inherit;
      }
      .ds-ebay-card:hover { opacity: 0.8; }
      .ds-ebay-card:last-child { border: none; }
      .ds-ebay-thumb {
        width: 36px; height: 36px; object-fit: cover;
        border-radius: 4px; flex-shrink: 0; background: #2d1b69;
        display: flex; align-items: center; justify-content: center; font-size: 16px;
      }
      .ds-ebay-thumb img { width: 100%; height: 100%; object-fit: cover; border-radius: 4px; }
      .ds-ebay-info { flex: 1; min-width: 0; }
      .ds-ebay-title { font-size: 11px; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ds-ebay-price { font-size: 12px; font-weight: 700; color: #a78bfa; }
      .ds-ebay-cond { font-size: 10px; opacity: 0.5; }
      .ds-search-links { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
      .ds-link-btn {
        padding: 4px 9px; border-radius: 6px; font-size: 11px; font-weight: 600;
        text-decoration: none; color: #fff; background: rgba(255,255,255,0.1);
        cursor: pointer; border: none; white-space: nowrap;
      }
      .ds-link-btn:hover { background: rgba(255,255,255,0.18); }
      .ds-suggestion-card {
        display: flex; align-items: center; gap: 8px;
        padding: 8px; border-radius: 8px;
        background: rgba(255,255,255,0.05); margin-bottom: 6px;
        cursor: pointer; border: 1px solid rgba(255,255,255,0.08);
        text-decoration: none; color: inherit;
      }
      .ds-suggestion-card:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.15); }
      .ds-suggestion-badge {
        font-size: 10px; padding: 2px 6px; border-radius: 4px;
        font-weight: 700; flex-shrink: 0; white-space: nowrap;
      }
      .ds-suggestion-text { flex: 1; min-width: 0; }
      .ds-suggestion-title { font-size: 11px; opacity: 0.9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ds-suggestion-reason { font-size: 10px; opacity: 0.55; }
      .ds-suggestion-price { font-size: 12px; font-weight: 700; color: #a78bfa; }
      .ds-reliability {
        padding: 8px 10px; border-radius: 8px; margin: 8px 0;
        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
      }
      .ds-loading { text-align: center; padding: 20px; opacity: 0.6; font-size: 13px; }
      .ds-loading::after { content: ""; animation: ds-dots 1.2s infinite; }
      @keyframes ds-dots { 0%{content:"."} 33%{content:".."} 66%{content:"..."} }
      .ds-error { color: #f87171; font-size: 12px; padding: 8px; }
      .ds-seller-trust {
        font-size: 11px; opacity: 0.7;
        padding: 6px 8px; border-radius: 6px;
        background: rgba(255,255,255,0.04); margin: 6px 0;
      }
      .ds-pro-teaser {
        background: linear-gradient(135deg, #4c1d95, #1e1b2e);
        border: 1px solid rgba(124,58,237,0.4);
        border-radius: 8px; padding: 12px; margin: 8px 0; text-align: center;
      }
      .ds-version { font-size: 9px; opacity: 0.4; }
      .ds-photo-badge {
        font-size: 10px; background: rgba(99,102,241,0.3);
        border-radius: 4px; padding: 1px 5px; margin-left: 4px;
      }
      .ds-data-source {
        font-size: 9px; padding: 1px 5px; border-radius: 4px;
        margin-left: 4px; font-weight: 600;
      }
      .ds-shipping-note {
        font-size: 11px; color: #fbbf24; margin: 4px 0;
      }
    `;
    document.head.appendChild(style);
  }


  // ── Create the tab + panel DOM ──────────────────────────────────────────────
  let root, tab, panel;

  function ensureSidebarDOM() {
    if (root) return;

    root = document.createElement("div");
    root.id = "dealscout-root";

    tab = document.createElement("div");
    tab.id = "ds-tab";
    tab.innerHTML = "&#x1F6D2; Deal Scout";

    panel = document.createElement("div");
    panel.id = "ds-panel";

    root.appendChild(tab);
    root.appendChild(panel);
    document.body.appendChild(root);

    makeDraggable(tab, root);

    // Tab click — open/close the panel
    tab.addEventListener("click", () => {
      panel.classList.toggle("open");
    });

    // Restore saved panel position
    restorePosition();
  }


  // ── Drag to move ────────────────────────────────────────────────────────────
  function makeDraggable(handle, container) {
    let startX, startY, startTop, startLeft;
    let wasDragged = false;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();

      // Convert bottom/right positioning to top/left for offset math
      const rect = container.getBoundingClientRect();
      container.style.bottom = "auto";
      container.style.right  = "auto";
      container.style.top    = rect.top + "px";
      container.style.left   = rect.left + "px";

      startX    = e.clientX;
      startY    = e.clientY;
      startTop  = rect.top;
      startLeft = rect.left;
      wasDragged = false;

      // Disable panel pointer events so scroll container doesn't steal capture
      if (panel) panel.style.pointerEvents = "none";
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasDragged = true;

      const newTop  = Math.max(0, Math.min(startTop  + dy, window.innerHeight - 60));
      const newLeft = Math.max(0, Math.min(startLeft + dx, window.innerWidth  - 80));
      container.style.top  = newTop  + "px";
      container.style.left = newLeft + "px";
    });

    const endDrag = (e) => {
      if (panel) panel.style.pointerEvents = "";
      if (!wasDragged) return;
      // Save position
      const top  = parseInt(container.style.top  || 0);
      const left = parseInt(container.style.left || 0);
      chrome.storage.local.set({ ds_sidebar_pos: { top, left } }).catch(() => {});
      // Prevent the click event after drag
      e.preventDefault();
    };

    handle.addEventListener("pointerup",          endDrag);
    handle.addEventListener("lostpointercapture", endDrag);
  }

  async function restorePosition() {
    try {
      const stored = await chrome.storage.local.get("ds_sidebar_pos");
      if (stored.ds_sidebar_pos) {
        let { top, left } = stored.ds_sidebar_pos;
        // Clamp to current viewport — screen may be different size now
        top  = Math.max(0, Math.min(top,  window.innerHeight - 60));
        left = Math.max(0, Math.min(left, window.innerWidth  - 80));
        root.style.top    = top  + "px";
        root.style.left   = left + "px";
        root.style.bottom = "auto";
        root.style.right  = "auto";
      }
    } catch { /* ok */ }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 5 — RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  function showLoading() {
    ensureSidebarDOM();
    panel.classList.add("open");
    panel.innerHTML = `
      <div class="ds-header">
        <div class="ds-header-left">&#x1F6D2; Deal Scout</div>
        <button class="ds-close">&#x2715;</button>
      </div>
      <div class="ds-body">
        <div class="ds-loading">Analyzing deal</div>
      </div>`;
    panel.querySelector(".ds-close").addEventListener("click", () => panel.classList.remove("open"));
  }

  function showError(msg) {
    ensureSidebarDOM();
    panel.innerHTML = `
      <div class="ds-header">
        <div class="ds-header-left">&#x1F6D2; Deal Scout</div>
        <button class="ds-close">&#x2715;</button>
      </div>
      <div class="ds-body">
        <div class="ds-error">&#x26A0;&#xFE0F; ${escHtml(msg)}</div>
      </div>`;
    panel.querySelector(".ds-close").addEventListener("click", () => panel.classList.remove("open"));
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function scoreColor(score) {
    if (score >= 7) return "#22c55e";
    if (score >= 5) return "#fbbf24";
    return "#ef4444";
  }

  function getCraigslistUrl(location, title) {
    const query = encodeURIComponent(title.slice(0, 40));
    const city  = (location || "").toLowerCase().replace(/[^a-z]/g, "");
    const cityMap = {
      sandiego:"sfbay",sanfrancisco:"sfbay",losangeles:"losangeles",
      chicago:"chicago",newyork:"newyork",seattle:"seattle",
      portland:"portland",denver:"denver",phoenix:"phoenix",
      dallas:"dallas",houston:"houston",austin:"austin",
      miami:"miami",atlanta:"atlanta",boston:"boston",
      philadelphia:"philadelphia",detroit:"detroit",
    };
    const cl = cityMap[city] || "craigslist";
    return `https://${cl}.craigslist.org/search/sss?query=${query}`;
  }


  /**
   * Main render function — called after we receive a score from the API.
   * Renders:
   *   - Score circle + verdict + buy/pass badge
   *   - Price comparison row (with shipping if present)
   *   - Seller trust info
   *   - Red/green flags
   *   - Recommended offer
   *   - Like Products (eBay cards)
   *   - Better Options (suggestion cards)
   *   - Search elsewhere links
   *   - Product reliability (if available)
   */
  function renderScore(r, listing) {
    ensureSidebarDOM();
    panel.innerHTML = "";

    const buyLabel  = r.should_buy ? "&#x2705; BUY"  : "&#x274C; PASS";
    const buyColor  = r.should_buy ? "#22c55e" : "#ef4444";
    const dataColor = r.data_source === "ebay"   ? "#22c55e" :
                      r.data_source === "google_shopping" ? "#60a5fa" : "#fbbf24";
    const dataLabel = r.data_source === "ebay"   ? "&#x1F4CA; Live eBay" :
                      r.data_source === "google_shopping" ? "&#x1F50D; Google Shopping" :
                      "&#x26A0;&#xFE0F; Est. prices";

    const photoTag  = r.image_analyzed ? `<span class="ds-photo-badge">&#x1F4F7; photo</span>` : "";
    const dataTag   = `<span class="ds-data-source" style="background:rgba(255,255,255,0.08);color:${dataColor}">${dataLabel}</span>`;

    const diff   = listing.price - r.estimated_value;
    const pct    = r.estimated_value > 0 ? Math.abs(diff / r.estimated_value * 100).toFixed(0) : "?";
    const diffEl = diff > 0
      ? `<span class="ds-over">&#x1F534; $${Math.abs(diff).toFixed(0)} over market (+${pct}%)</span>`
      : `<span class="ds-under">&#x1F7E2; $${Math.abs(diff).toFixed(0)} below market (-${pct}%)</span>`;

    // Shipping note
    const shippingNote = r.shipping_cost > 0
      ? `<div class="ds-shipping-note">&#x1F69A; +$${r.shipping_cost.toFixed(2)} shipping = <strong>$${(listing.price + r.shipping_cost).toFixed(2)} total</strong></div>`
      : "";

    // Original price note
    const origNote = r.original_price > 0 && r.original_price > listing.price
      ? `<div style="font-size:11px;opacity:0.6;margin-bottom:4px">
           <del>$${r.original_price.toLocaleString()}</del> &#x25BC; reduced $${(r.original_price - listing.price).toFixed(0)}
         </div>` : "";

    // Trust display
    const trust = listing.seller_trust || {};
    const trustParts = [];
    if (trust.member_since)   trustParts.push(`&#x1F4C5; ${trust.member_since}`);
    if (trust.review_count)   trustParts.push(`(${trust.review_count} reviews)`);
    if (trust.is_highly_rated) trustParts.push(`&#x1F3C5; Highly rated`);
    if (trust.seller_rating)  trustParts.push(`${trust.seller_rating}/5 stars`);
    const trustLine = trustParts.length
      ? trustParts.join(" &middot; ")
      : "&#x1F464; Limited seller info";

    // Flags HTML
    const greenFlags = (r.green_flags || []).map(f => `<li>&#x2705; ${escHtml(f)}</li>`).join("");
    const redFlags   = (r.red_flags   || []).map(f => `<li>&#x26A0;&#xFE0F; ${escHtml(f)}</li>`).join("");

    // Product scored-as display
    const productInfo   = r.product_info || {};
    const scoredAsLine  = productInfo.display_name && productInfo.display_name !== listing.title
      ? `<div style="font-size:10px;opacity:0.5;margin-top:4px">
           &#x1F50E; Scored as: ${escHtml(productInfo.display_name)} &middot; ${escHtml(productInfo.confidence || "medium")} confidence
         </div>` : "";

    // Build header
    const header = document.createElement("div");
    header.className = "ds-header";
    header.innerHTML = `
      <div class="ds-header-left">
        &#x1F6D2; Deal Scout
        <span class="ds-version">v${VERSION}</span>
        ${photoTag}${dataTag}
      </div>
      <button class="ds-close">&#x2715;</button>`;
    panel.appendChild(header);
    header.querySelector(".ds-close").addEventListener("click", () => panel.classList.remove("open"));

    // Body
    const body = document.createElement("div");
    body.className = "ds-body";
    body.innerHTML = `
      <div class="ds-score-row">
        <div class="ds-score-circle" style="background:${scoreColor(r.score)}22;border-color:${scoreColor(r.score)}">
          <span style="color:${scoreColor(r.score)}">${r.score}</span>
        </div>
        <div>
          <div class="ds-buy-badge" style="background:${buyColor}22;color:${buyColor}">${buyLabel}</div>
          <div class="ds-verdict">${escHtml(r.verdict)}</div>
        </div>
      </div>

      <div class="ds-summary">${escHtml(r.summary)}</div>

      ${origNote}
      ${shippingNote}

      <div class="ds-section">
        <div class="ds-section-title">&#x1F4CA; Market Comparison</div>
        <div class="ds-price-row"><span class="ds-price-label">eBay sold avg</span><span>$${r.sold_avg?.toFixed(0) || 0}</span></div>
        <div class="ds-price-row"><span class="ds-price-label">eBay active avg</span><span>$${r.active_avg?.toFixed(0) || 0}</span></div>
        <div class="ds-price-row"><span class="ds-price-label">New retail</span><span>$${r.new_price?.toFixed(0) || 0}</span></div>
        <div class="ds-price-row"><span class="ds-price-label">Listed price</span><strong>$${listing.price?.toFixed(0) || 0}</strong></div>
        <div style="margin-top:6px;font-size:12px;">${diffEl}</div>
        <div style="font-size:10px;opacity:0.4;margin-top:3px">
          ${escHtml(r.market_confidence || "low")} confidence &middot; ${r.sold_count || 0} eBay comps
        </div>
      </div>

      <div class="ds-seller-trust">&#x1F464; ${trustLine}</div>

      <div class="ds-section">
        <ul class="ds-flags">${greenFlags}${redFlags}</ul>
      </div>

      <div class="ds-offer">
        <span>Recommended offer</span>
        <span class="ds-offer-price">$${(r.recommended_offer || 0).toFixed(0)}</span>
      </div>
      ${scoredAsLine}
    `;
    panel.appendChild(body);

    // Like Products (eBay cards)
    renderLikeProducts(r, panel);

    // Better Options (suggestions)
    renderSuggestions(r, panel);

    // Product reliability
    renderReliability(r, panel);

    // Search elsewhere links
    renderSearchLinks(r, listing, panel);
  }


  /**
   * Render the Like Products eBay cards (Sold / Active tabs).
   * Each card is an affiliate link — our primary revenue source.
   *
   * WHY addEventListener NOT onclick:
   * Facebook's CSP strips inline onclick from dynamically injected HTML.
   */
  function renderLikeProducts(r, container) {
    const sold   = r.sold_items_sample   || [];
    const active = r.active_items_sample || [];
    if (!sold.length && !active.length) return;

    const section = document.createElement("div");
    section.className = "ds-section";
    section.innerHTML = `
      <div class="ds-section-title">&#x1F6CD;&#xFE0F; Like Products on eBay</div>
      <div class="ds-tabs">
        <button class="ds-tab-btn active" data-tab="sold">&#x1F4B0; Sold (${sold.length})</button>
        <button class="ds-tab-btn"        data-tab="active">&#x1F4E6; Active (${active.length})</button>
      </div>
      <div data-tabcontent="sold"   class="ds-tabpanel"></div>
      <div data-tabcontent="active" class="ds-tabpanel" style="display:none"></div>`;

    container.appendChild(section);

    // Build item cards for each tab
    [["sold", sold], ["active", active]].forEach(([tabId, items]) => {
      const pane = section.querySelector(`[data-tabcontent="${tabId}"]`);
      if (!items.length) {
        pane.innerHTML = `<div style="font-size:11px;opacity:0.4;padding:8px 0">No data</div>`;
        return;
      }
      items.forEach(item => {
        const card = document.createElement("a");
        card.className = "ds-ebay-card";
        card.href      = item.url || "#";
        card.target    = "_blank";
        card.rel       = "noopener";

        // Thumbnail
        const thumb = document.createElement("div");
        thumb.className = "ds-ebay-thumb";
        if (item.image_url) {
          const img = document.createElement("img");
          img.src = item.image_url;
          img.alt = "";
          img.addEventListener("error", () => {
            thumb.textContent = "&#x1F4E6;";
            thumb.removeChild(img);
          });
          thumb.appendChild(img);
        } else {
          thumb.textContent = "&#x1F4E6;";
        }

        const info = document.createElement("div");
        info.className = "ds-ebay-info";
        info.innerHTML = `
          <div class="ds-ebay-title">${escHtml(item.title)}</div>
          <div class="ds-ebay-price">&#x24;${item.price?.toFixed(0) || 0}</div>
          <div class="ds-ebay-cond">${escHtml(item.condition)} ${item.sold ? "SOLD" : ""}</div>`;

        card.appendChild(thumb);
        card.appendChild(info);
        pane.appendChild(card);
      });
    });

    // Tab switching — use event delegation, CSP-safe
    section.querySelectorAll(".ds-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        section.querySelectorAll(".ds-tab-btn").forEach(b => b.classList.remove("active"));
        section.querySelectorAll(".ds-tabpanel").forEach(p => p.style.display = "none");
        btn.classList.add("active");
        const target = section.querySelector(`[data-tabcontent="${btn.dataset.tab}"]`);
        if (target) target.style.display = "block";
      });
    });
  }


  /**
   * Render Better Options / suggestion cards.
   * These are affiliate links to eBay and Amazon — generated by suggestion_engine.py.
   */
  function renderSuggestions(r, container) {
    const suggestions = r.suggestions || [];
    if (!suggestions.length) return;

    const section = document.createElement("div");
    section.className = "ds-section";
    section.innerHTML = `<div class="ds-section-title">&#x1F4A1; Better Options</div>`;

    suggestions.forEach(s => {
      const card = document.createElement("a");
      card.className = "ds-suggestion-card";
      card.href      = s.url || "#";
      card.target    = "_blank";
      card.rel       = "noopener";
      card.innerHTML = `
        <span class="ds-suggestion-badge" style="background:${s.badge_color || "#6366f1"}">
          ${escHtml(s.badge || s.platform)}
        </span>
        <div class="ds-suggestion-text">
          <div class="ds-suggestion-title">${escHtml(s.title)}</div>
          <div class="ds-suggestion-reason">${escHtml(s.reason)}</div>
        </div>
        <span class="ds-suggestion-price">${escHtml(s.price_label || "")}</span>`;
      section.appendChild(card);
    });

    container.appendChild(section);
  }


  /**
   * Render product reliability info from product_evaluator.py
   */
  function renderReliability(r, container) {
    const pe = r.product_evaluation;
    if (!pe || !pe.reliability_tier || pe.reliability_tier === "unknown") return;
    if (!pe.overall_rating && !pe.known_issues?.length && !pe.strengths?.length) return;

    const tierColors = {
      excellent: "#22c55e", good: "#86efac",
      mixed: "#fbbf24", poor: "#f87171", unknown: "#94a3b8",
    };
    const tierEmojis = {
      excellent: "&#x2705;", good: "&#x1F44D;",
      mixed: "&#x26A0;&#xFE0F;", poor: "&#x274C;", unknown: "&#x2753;",
    };

    const color  = tierColors[pe.reliability_tier]  || "#94a3b8";
    const emoji  = tierEmojis[pe.reliability_tier]  || "&#x2753;";
    const rating = pe.overall_rating ? ` &middot; ${pe.overall_rating.toFixed(1)}/5 &#x2B50;` : "";
    const count  = pe.review_count   ? ` (${pe.review_count} reviews)` : "";

    let issueHtml = "";
    if (pe.known_issues?.length) {
      issueHtml = `<div style="font-size:11px;opacity:0.6;margin-top:4px">
        Issues: ${pe.known_issues.slice(0,2).map(i => escHtml(i)).join(", ")}
      </div>`;
    }

    const section = document.createElement("div");
    section.className = "ds-section";
    section.innerHTML = `
      <div class="ds-section-title">&#x1F4CB; Product Reputation</div>
      <div class="ds-reliability">
        <span style="font-weight:700;color:${color}">${emoji} ${pe.reliability_tier.toUpperCase()}</span>
        <span style="font-size:11px;opacity:0.7">${rating}${count}</span>
        ${pe.reddit_sentiment ? `<div style="font-size:11px;opacity:0.6;margin-top:4px;font-style:italic">"${escHtml(pe.reddit_sentiment.slice(0,80))}"</div>` : ""}
        ${issueHtml}
      </div>`;
    container.appendChild(section);
  }


  /**
   * Render "Search Elsewhere" external links row (Amazon, OfferUp, Google, Craigslist)
   */
  function renderSearchLinks(r, listing, container) {
    const q    = encodeURIComponent((r.product_info?.display_name || listing.title).slice(0, 50));
    const amz  = `https://www.amazon.com/s?k=${q}&tag=dealscout03f-20`;
    const ofrp = `https://offerup.com/search/?q=${q}`;
    const goog = `https://www.google.com/search?q=${q}+site:shopping.google.com`;
    const cl   = getCraigslistUrl(listing.location || "", listing.title || "");

    const section = document.createElement("div");
    section.className = "ds-section";
    section.innerHTML = `<div class="ds-section-title">Search Elsewhere</div>`;

    const links = [
      { label: "&#x1F6D2; Amazon",  url: amz  },
      { label: "&#x1F4E6; OfferUp", url: ofrp },
      { label: "&#x1F50D; Google",  url: goog },
      { label: "&#x1F4CC; CL",      url: cl   },
    ];

    const row = document.createElement("div");
    row.className = "ds-search-links";

    links.forEach(({ label, url }) => {
      const btn = document.createElement("a");
      btn.className = "ds-link-btn";
      btn.href      = url;
      btn.target    = "_blank";
      btn.rel       = "noopener";
      btn.innerHTML = label;
      row.appendChild(btn);
    });

    section.appendChild(row);

    const note = document.createElement("div");
    note.style.cssText = "font-size:9px;opacity:0.3;margin-top:6px";
    note.textContent = "eBay links via Partner Network";
    section.appendChild(note);

    container.appendChild(section);
  }


  // Pro teaser shown when Pro is OFF
  function renderProTeaser(panel) {
    const teaser = document.createElement("div");
    teaser.className = "ds-pro-teaser";
    teaser.innerHTML = `
      <div style="font-size:20px;margin-bottom:6px">&#x1F512;</div>
      <div style="font-weight:700;margin-bottom:4px">Upgrade to Pro</div>
      <div style="font-size:11px;opacity:0.7">
        Enable full market comparison, photo analysis &amp; product suggestions
      </div>
      <div style="margin-top:8px;font-size:11px;opacity:0.5">
        Toggle Pro in the extension popup
      </div>`;
    panel.appendChild(teaser);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 6 — SCORING PIPELINE
  // ═══════════════════════════════════════════════════════════════════════════

  let currentlyScoring = false;

  async function scoreListing() {
    if (!isListingPage()) return;
    if (currentlyScoring) return;
    currentlyScoring = true;

    try {
      ensureSidebarDOM();
      showLoading();

      const listing = extractListing();
      console.log(LOG_PRE, "Scoring:", listing.title, "@", listing.price, `+shipping:${listing.shipping_cost}`);

      // Record price for history
      await recordPriceHistory(listing.listing_url, listing.price);

      const pro = await isPro();

      // For non-pro users: only send basic fields (no image, no extras)
      const payload = pro
        ? listing
        : { title: listing.title, price: listing.price, raw_price_text: listing.raw_price_text,
            description: listing.description, condition: listing.condition,
            location: listing.location, seller_name: listing.seller_name,
            listing_url: listing.listing_url, is_vehicle: listing.is_vehicle,
            shipping_cost: listing.shipping_cost, original_price: listing.original_price };

      let r;
      try {
        const resp = await fetch(`${API_BASE}/score`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(payload),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.detail || `API error ${resp.status}`);
        }
        r = await resp.json();
      } catch (fetchErr) {
        showError(fetchErr.message);
        return;
      }

      // Save score for search overlay
      await saveScore(listing.listing_url, r.score, r.should_buy);

      // Update badge
      try {
        const color = r.score >= 7 ? "#22c55e" : r.score >= 5 ? "#fbbf24" : "#ef4444";
        chrome.runtime.sendMessage({ type: "SET_BADGE", score: r.score, color });
      } catch { /* ok */ }

      if (!pro) {
        // Show basic info only for free users
        renderScore(r, listing);
        renderProTeaser(panel);
      } else {
        renderScore(r, listing);
      }

    } finally {
      currentlyScoring = false;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 7 — INIT & MESSAGE LISTENER
  // ═══════════════════════════════════════════════════════════════════════════

  // Listen for rescore requests from popup or background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "RESCORE") {
      currentlyScoring = false;
      scoreListing();
      sendResponse({ ok: true });
    }
  });

  // Expose rescore for the double-injection guard at the top
  window.__dealScoutRescore = () => {
    currentlyScoring = false;
    scoreListing();
  };

  // Auto-score on listing pages
  if (isListingPage()) {
    // Small delay — FBM needs a moment to finish hydrating the listing DOM
    setTimeout(scoreListing, 1200);
  } else {
    injectSearchOverlay();
  }

  console.log(LOG_PRE, `v${VERSION} injected on`, window.location.pathname);

})();
