/**
 * content/fbm.js — Facebook Marketplace Content Script
 *
 * CHANGES IN THIS VERSION:
 *   - Sidebar is now collapsible (minimizes to a tab, doesn't block the page)
 *   - Sidebar snaps to bottom-right to avoid FBM's own panels
 *   - Multi-item listing detection (tool sets, lots, bundles)
 *   - Better condition extraction using multiple fallback strategies
 */

// ── State ─────────────────────────────────────────────────────────────────────
let sidebarMinimized = false;

// ── Entry Point ───────────────────────────────────────────────────────────────

(async function () {
  "use strict";

  // Listen for manual rescore from popup button
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "RESCORE") runScorer();
  });

  // Auto-run on individual listing pages only
  if (!window.location.pathname.includes("/marketplace/item/")) return;
  runScorer();
})();


async function runScorer() {
  try {
    await waitForElement('h1, [data-testid="marketplace-pdp-title"]', 6000);
  } catch {
    console.warn("[DealScout] Page took too long to load listing data");
    return;
  }

  const listing = extractListing();
  if (!listing) {
    console.warn("[DealScout] Could not extract title/price from this page");
    return;
  }

  console.log("[DealScout] Extracted listing:", listing.title, "$" + listing.price);
  injectSidebar({ loading: true, listing });

  const response = await chrome.runtime.sendMessage({
    type:    "SCORE_LISTING",
    listing: listing,
  });

  if (response?.success) {
    updateSidebar(response.result);
  } else {
    updateSidebar({ error: response?.error || "Unknown error" });
  }
}


// ── Listing Extraction ────────────────────────────────────────────────────────

function extractListing() {
  const title = (
    getText('[data-testid="marketplace-pdp-title"]') ||
    getText('h1[dir="auto"]') ||
    getText('h1')
  );

  const rawPriceText = (
    getText('[data-testid="marketplace-pdp-price"]') ||
    getText('div[aria-label*="price" i] span') ||
    findPriceText()
  );

  if (!title || !rawPriceText) return null;

  const description = (
    getText('[data-testid="marketplace-pdp-description"]') ||
    getText('div[style*="word-break"] span') ||
    ""
  );

  const location = (
    getText('[data-testid="marketplace-pdp-seller-location"]') ||
    getText('span[aria-label*="location" i]') ||
    ""
  );

  const condition = (
    getText('[data-testid="marketplace-pdp-condition"]') ||
    findConditionText(description) ||
    "Unknown"
  );

  const sellerName = (
    getText('a[href*="/marketplace/seller/"] span') ||
    getText('a[href*="/profile.php"] span') ||
    ""
  );

  // Detect multi-item listings — affects how Claude values the deal
  // WHY: A "Ryobi 6-tool set" should not be compared to a single Ryobi drill price
  const isMultiItem = detectMultiItem(title, description);

  return {
    title:           title.trim(),
    price:           parsePrice(rawPriceText),
    raw_price_text:  rawPriceText.trim(),
    description:     description.trim(),
    location:        location.trim(),
    condition:       condition.trim(),
    seller_name:     sellerName.trim(),
    listing_url:     window.location.href,
    is_multi_item:   isMultiItem,
    source:          "fbm_extension",
  };
}


function detectMultiItem(title, description) {
  /**
   * Detect bundle/lot/set listings so Claude adjusts its valuation.
   *
   * WHY THIS MATTERS:
   *   A "lot of 6 Ryobi tools" is worth 4-6x a single tool.
   *   Without this flag, Claude compares to single-item eBay comps
   *   and massively undervalues the listing.
   *
   *   When is_multi_item=true, the scoring prompt tells Claude to
   *   consider aggregate value, not single-unit comps.
   */
  const text  = `${title} ${description}`.toLowerCase();
  const flags = [
    /\blot\b/, /\bset\b/, /\bbundle\b/, /\bkit\b/, /\bcollection\b/,
    /\bpiece\b/, /\bpcs\b/, /\bitems?\b/,
    /\d+\s*tools?\b/,         // "6 tools"
    /\d+\s*pairs?\b/,         // "3 pairs"
    /\band\b.*\band\b/,       // "drill and saw and sander"
    /comes with|includes|included/,
  ];
  return flags.some(f => f.test(text));
}


function findPriceText() {
  const spans = document.querySelectorAll("span");
  for (const span of spans) {
    const t = span.innerText?.trim();
    if (t && t.startsWith("$") && t.length < 15 && /\d/.test(t)) return t;
  }
  return null;
}


function findConditionText(description = "") {
  // Check description text for condition hints
  const lower = description.toLowerCase();
  if (/brand new|never used|sealed|unopened/.test(lower))  return "New";
  if (/like new|mint condition|barely used/.test(lower))   return "Used - Like New";
  if (/good condition|works great|fully functional/.test(lower)) return "Used - Good";
  if (/fair condition|some wear|shows wear/.test(lower))   return "Used - Fair";

  // Fall back to scanning page body
  const conditions = ["Like New", "New", "Good", "Fair", "Poor"];
  const bodyText   = document.body.innerText;
  for (const cond of conditions) {
    if (bodyText.includes(cond)) return cond;
  }
  return null;
}


// ── DOM Helpers ───────────────────────────────────────────────────────────────

function getText(selector) {
  return document.querySelector(selector)?.innerText?.trim() || null;
}

function parsePrice(text) {
  if (!text) return 0;
  return parseFloat(text.replace(/[^0-9.]/g, "")) || 0;
}

function waitForElement(selector, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { observer.disconnect(); resolve(found); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); reject(new Error("Timeout")); }, timeoutMs);
  });
}


// ── Sidebar ───────────────────────────────────────────────────────────────────

function injectSidebar({ loading, listing }) {
  document.getElementById("dealscout-root")?.remove();

  // WHY bottom-right + toggle tab:
  //   FBM's own panels live on the right side ~400px wide.
  //   We sit at bottom-right and let the user toggle us open/closed
  //   so we never permanently block the listing content.
  const root = document.createElement("div");
  root.id = "dealscout-root";
  root.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 14px;
    color: #111827;
  `;

  root.innerHTML = `
    <!-- Toggle tab — always visible even when minimized -->
    <div id="dealscout-tab" style="
      position: absolute;
      bottom: 0;
      right: 0;
      background: linear-gradient(135deg,#667eea,#764ba2);
      color: #fff;
      border-radius: 10px 10px 6px 6px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 2px 12px rgba(102,102,234,0.4);
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    ">
      🛒 Deal Scout <span id="dealscout-badge" style="background:rgba(255,255,255,0.25);border-radius:4px;padding:1px 6px;font-size:12px">...</span>
    </div>

    <!-- Main panel -->
    <div id="dealscout-panel" style="
      position: absolute;
      bottom: 38px;
      right: 0;
      width: 300px;
      max-height: 80vh;
      overflow-y: auto;
      background: #fff;
      border-radius: 12px 12px 0 12px;
      box-shadow: 0 4px 32px rgba(0,0,0,0.20);
      transition: opacity 0.2s, transform 0.2s;
    ">
      <div id="dealscout-content">
        ${renderLoading(listing)}
      </div>
    </div>
  `;

  document.body.appendChild(root);

  // Toggle panel on tab click
  root.querySelector("#dealscout-tab").addEventListener("click", toggleSidebar);
}


function toggleSidebar() {
  const panel = document.getElementById("dealscout-panel");
  if (!panel) return;
  sidebarMinimized = !sidebarMinimized;
  panel.style.display = sidebarMinimized ? "none" : "block";
}


function updateSidebar(resultOrError) {
  const content = document.getElementById("dealscout-content");
  const badge   = document.getElementById("dealscout-badge");
  if (!content) return;

  if (resultOrError.error) {
    content.innerHTML = renderError(resultOrError.error);
    if (badge) badge.textContent = "!";
    return;
  }

  const r = resultOrError;
  content.innerHTML = renderScore(r);

  // Update the always-visible tab badge with the score + buy/pass
  if (badge) {
    const emoji = r.should_buy ? "✅" : "❌";
    badge.textContent = `${r.score}/10 ${emoji}`;
    badge.style.background = r.score >= 7 ? "rgba(34,197,94,0.3)"
                           : r.score >= 5 ? "rgba(251,191,36,0.3)"
                           : "rgba(239,68,68,0.3)";
  }

  // Re-attach close button
  document.getElementById("dealscout-close")?.addEventListener("click", () => {
    document.getElementById("dealscout-root")?.remove();
  });
}


// ── Render Templates ──────────────────────────────────────────────────────────

function renderLoading(listing) {
  return `
    <div style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-weight:700">🛒 Deal Scout</span>
        <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:16px;color:#9ca3af">✕</button>
      </div>
      <div style="background:#f3f4f6;border-radius:8px;padding:16px;text-align:center;color:#6b7280">
        ⏳ Analyzing deal...<br>
        <span style="font-size:11px;margin-top:4px;display:block">${listing?.title?.substring(0, 45) || ""}${listing?.title?.length > 45 ? "..." : ""}</span>
      </div>
    </div>`;
}


function renderError(msg) {
  return `
    <div style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-weight:700">🛒 Deal Scout</span>
        <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:16px;color:#9ca3af">✕</button>
      </div>
      <div style="background:#fef2f2;border-radius:8px;padding:12px;color:#dc2626;font-size:13px">
        ⚠️ ${msg}<br>
        <span style="font-size:11px;color:#9ca3af">Is the API running? python -m uvicorn api.main:app --port 8000</span>
      </div>
    </div>`;
}


function renderScore(r) {
  const scoreColor = r.score >= 7 ? "#22c55e" : r.score >= 5 ? "#fbbf24" : "#ef4444";
  const buyBg      = r.should_buy ? "#22c55e" : "#ef4444";
  const buyLabel   = r.should_buy ? "✅ BUY" : "❌ PASS";
  const diff       = r.price - r.estimated_value;
  const diffLabel  = diff > 0
    ? `🔴 $${Math.abs(diff).toFixed(0)} over market`
    : `🟢 $${Math.abs(diff).toFixed(0)} below market`;

  const greenFlags = (r.green_flags || []).map(f =>
    `<div style="padding:4px 0;font-size:12px;border-bottom:1px solid #f0fdf4">✅ ${f}</div>`
  ).join("");

  const redFlags = (r.red_flags || []).map(f =>
    `<div style="padding:4px 0;font-size:12px;border-bottom:1px solid #fef2f2">⚠️ ${f}</div>`
  ).join("");

  const affiliateLinks = r.affiliateLinks ? `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid #f3f4f6">
      <div style="font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:6px">COMPARE PRICES</div>
      <a href="${r.affiliateLinks.ebay_sold.url}" target="_blank"
         style="display:block;padding:7px 10px;background:#f0fdf4;border-radius:6px;
                color:#15803d;text-decoration:none;font-size:12px;font-weight:600;margin-bottom:4px">
        📦 eBay Sold Listings
      </a>
      <a href="${r.affiliateLinks.amazon.url}" target="_blank"
         style="display:block;padding:7px 10px;background:#fffbeb;border-radius:6px;
                color:#92400e;text-decoration:none;font-size:12px;font-weight:600">
        🛒 Check Amazon Price
      </a>
    </div>` : "";

  return `
    <div style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-weight:700">🛒 Deal Scout</span>
        <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:16px;color:#9ca3af">✕</button>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:30px;font-weight:800;color:${scoreColor};line-height:1">
          ${r.score}<span style="font-size:13px;color:#9ca3af;font-weight:400">/10</span>
        </div>
        <div style="background:${buyBg};color:#fff;border-radius:6px;padding:5px 12px;font-weight:700;font-size:13px">
          ${buyLabel}
        </div>
      </div>

      <div style="background:#e5e7eb;border-radius:6px;height:6px;margin-bottom:8px;overflow:hidden">
        <div style="width:${r.score * 10}%;height:100%;background:${scoreColor};border-radius:6px"></div>
      </div>

      <div style="font-style:italic;font-size:12px;color:#374151;padding:8px;background:#f8fafc;
                  border-radius:6px;border-left:3px solid #6366f1;margin-bottom:10px">
        ${r.verdict}
      </div>

      <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:8px">
        ${r.sold_avg   ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;padding:2px 0"><span>eBay sold avg</span><span>$${r.sold_avg.toFixed(0)}</span></div>` : ""}
        ${r.active_avg ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;padding:2px 0"><span>eBay active avg</span><span>$${r.active_avg.toFixed(0)}</span></div>` : ""}
        ${r.new_price  ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;padding:2px 0"><span>New retail</span><span>$${r.new_price.toFixed(0)}</span></div>` : ""}
        <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;
                    border-top:1px solid #e5e7eb;padding-top:6px;margin-top:4px">
          <span>Listed price</span><span>$${r.price.toFixed(0)}</span>
        </div>
        <div style="font-size:12px;font-weight:600;margin-top:4px">${diffLabel}</div>
      </div>

      ${greenFlags ? `<div style="margin-bottom:8px">${greenFlags}</div>` : ""}
      ${redFlags   ? `<div style="margin-bottom:8px">${redFlags}</div>`   : ""}

      <div style="background:#f0fdf4;border-radius:8px;padding:10px;
                  display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:600;color:#15803d;font-size:13px">💬 Offer</span>
        <span style="font-weight:800;font-size:20px;color:#15803d">$${r.recommended_offer.toFixed(0)}</span>
      </div>

      ${affiliateLinks}

      <div style="margin-top:8px;font-size:10px;color:#d1d5db;text-align:center">
        Powered by Claude AI · eBay market data
      </div>
    </div>`;
}
