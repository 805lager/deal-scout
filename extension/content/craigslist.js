/**
 * content/craigslist.js — Craigslist Content Script
 *
 * WHY CL IS EASIER THAN FBM:
 *   Craigslist uses static server-rendered HTML — no React, no dynamic
 *   class names, no SPA routing. Selectors here are extremely stable
 *   and have barely changed in years.
 *
 * CHANGES IN THIS VERSION:
 *   - updateSidebar now fully renders the score (was a stub before)
 *   - Shared renderScore/renderLoading/renderError with fbm.js approach
 *   - Better condition inference from description text
 *   - Multi-item detection same as FBM
 *
 * URL pattern: https://*.craigslist.org/*/d/*/*
 */

let sidebarMinimized = false;

(async function () {
  "use strict";

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "RESCORE") runScorer();
  });

  // CL listing pages always have #titletextonly
  if (!document.querySelector("#titletextonly, .postingtitletext")) return;
  runScorer();
})();


async function runScorer() {
  const listing = extractListing();
  if (!listing) {
    console.warn("[DealScout] Could not extract Craigslist listing data");
    return;
  }

  console.log("[DealScout] CL listing:", listing.title, "$" + listing.price);
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
  // CL title is rock-solid — this selector has not changed in years
  const title = (
    document.querySelector("#titletextonly")?.innerText?.trim() ||
    document.querySelector(".postingtitletext span:first-child")?.innerText?.trim()
  );

  if (!title) return null;

  const rawPriceText = document.querySelector(".price")?.innerText?.trim() || "Unknown";
  const price        = parsePrice(rawPriceText);

  // Full listing body — CL descriptions are usually detailed
  const description = document.querySelector("#postingbody")
    ?.innerText
    ?.replace("QR Code Link to This Post", "")
    ?.trim() || "";

  // Location appears in parens after title on CL e.g. "(San Diego)"
  const location = document.querySelector(".postingtitletext small")
    ?.innerText?.replace(/[()]/g, "").trim() || "";

  const condition    = inferCondition(description);
  const isMultiItem  = detectMultiItem(title, description);

  // Seller info — CL hides this for privacy, we note it's absent
  return {
    title:          title,
    price:          price,
    raw_price_text: rawPriceText,
    description:    description.substring(0, 800),
    location:       location,
    condition:      condition,
    seller_name:    "",
    listing_url:    window.location.href,
    is_multi_item:  isMultiItem,
    source:         "craigslist_extension",
  };
}


function inferCondition(description) {
  const lower = description.toLowerCase();
  if (/brand new|never used|sealed|unopened/.test(lower))       return "New";
  if (/like new|mint|barely used|excellent condition/.test(lower)) return "Used - Like New";
  if (/good condition|works (great|perfectly|well)/.test(lower))  return "Used - Good";
  if (/fair|some wear|shows wear|cosmetic/.test(lower))            return "Used - Fair";
  return "Used";
}


function detectMultiItem(title, description) {
  const text  = `${title} ${description}`.toLowerCase();
  const flags = [
    /\blot\b/, /\bset\b/, /\bbundle\b/, /\bkit\b/, /\bcollection\b/,
    /\bpieces?\b/, /\bpcs\b/, /\d+\s*items?\b/, /\d+\s*tools?\b/,
    /comes with|includes|included/,
  ];
  return flags.some(f => f.test(text));
}


function parsePrice(text) {
  if (!text) return 0;
  return parseFloat(text.replace(/[^0-9.]/g, "")) || 0;
}


// ── Sidebar — same structure as fbm.js ───────────────────────────────────────

function injectSidebar({ loading, listing }) {
  document.getElementById("dealscout-root")?.remove();

  const root = document.createElement("div");
  root.id = "dealscout-root";
  root.style.cssText = `
    position:fixed;bottom:20px;right:20px;z-index:2147483647;
    font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;color:#111827;
  `;
  root.innerHTML = `
    <div id="dealscout-tab" style="
      position:absolute;bottom:0;right:0;
      background:linear-gradient(135deg,#667eea,#764ba2);
      color:#fff;border-radius:10px 10px 6px 6px;
      padding:6px 14px;font-size:13px;font-weight:700;
      cursor:pointer;box-shadow:0 2px 12px rgba(102,102,234,0.4);
      user-select:none;display:flex;align-items:center;gap:6px;
    ">🛒 Deal Scout <span id="dealscout-badge" style="background:rgba(255,255,255,0.25);border-radius:4px;padding:1px 6px;font-size:12px">...</span></div>
    <div id="dealscout-panel" style="
      position:absolute;bottom:38px;right:0;width:300px;
      max-height:80vh;overflow-y:auto;background:#fff;
      border-radius:12px 12px 0 12px;
      box-shadow:0 4px 32px rgba(0,0,0,0.20);
    ">
      <div id="dealscout-content">${renderLoading(listing)}</div>
    </div>`;

  document.body.appendChild(root);
  root.querySelector("#dealscout-tab").addEventListener("click", () => {
    sidebarMinimized = !sidebarMinimized;
    const panel = document.getElementById("dealscout-panel");
    if (panel) panel.style.display = sidebarMinimized ? "none" : "block";
  });
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

  if (badge) {
    badge.textContent = `${r.score}/10 ${r.should_buy ? "✅" : "❌"}`;
    badge.style.background = r.score >= 7 ? "rgba(34,197,94,0.3)"
                           : r.score >= 5 ? "rgba(251,191,36,0.3)"
                           : "rgba(239,68,68,0.3)";
  }

  document.getElementById("dealscout-close")?.addEventListener("click", () => {
    document.getElementById("dealscout-root")?.remove();
  });
}


// ── Render Templates (identical to fbm.js) ────────────────────────────────────

function renderLoading(listing) {
  return `<div style="padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span style="font-weight:700">🛒 Deal Scout</span>
      <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:16px;color:#9ca3af">✕</button>
    </div>
    <div style="background:#f3f4f6;border-radius:8px;padding:16px;text-align:center;color:#6b7280">
      ⏳ Analyzing deal...<br>
      <span style="font-size:11px;margin-top:4px;display:block">${listing?.title?.substring(0, 45) || ""}</span>
    </div>
  </div>`;
}

function renderError(msg) {
  return `<div style="padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span style="font-weight:700">🛒 Deal Scout</span>
      <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:16px;color:#9ca3af">✕</button>
    </div>
    <div style="background:#fef2f2;border-radius:8px;padding:12px;color:#dc2626;font-size:13px">
      ⚠️ ${msg}
    </div>
  </div>`;
}

function renderScore(r) {
  const scoreColor = r.score >= 7 ? "#22c55e" : r.score >= 5 ? "#fbbf24" : "#ef4444";
  const buyBg      = r.should_buy ? "#22c55e" : "#ef4444";
  const diff       = r.price - r.estimated_value;
  const diffLabel  = diff > 0 ? `🔴 $${Math.abs(diff).toFixed(0)} over market`
                               : `🟢 $${Math.abs(diff).toFixed(0)} below market`;

  const greenFlags = (r.green_flags || []).map(f =>
    `<div style="padding:4px 0;font-size:12px;border-bottom:1px solid #f0fdf4">✅ ${f}</div>`).join("");
  const redFlags = (r.red_flags || []).map(f =>
    `<div style="padding:4px 0;font-size:12px;border-bottom:1px solid #fef2f2">⚠️ ${f}</div>`).join("");

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

  return `<div style="padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span style="font-weight:700">🛒 Deal Scout</span>
      <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:16px;color:#9ca3af">✕</button>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div style="font-size:30px;font-weight:800;color:${scoreColor};line-height:1">
        ${r.score}<span style="font-size:13px;color:#9ca3af;font-weight:400">/10</span>
      </div>
      <div style="background:${buyBg};color:#fff;border-radius:6px;padding:5px 12px;font-weight:700;font-size:13px">
        ${r.should_buy ? "✅ BUY" : "❌ PASS"}
      </div>
    </div>
    <div style="background:#e5e7eb;border-radius:6px;height:6px;margin-bottom:8px;overflow:hidden">
      <div style="width:${r.score * 10}%;height:100%;background:${scoreColor};border-radius:6px"></div>
    </div>
    <div style="font-style:italic;font-size:12px;color:#374151;padding:8px;background:#f8fafc;
                border-radius:6px;border-left:3px solid #6366f1;margin-bottom:10px">${r.verdict}</div>
    <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:8px">
      ${r.sold_avg   ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;padding:2px 0"><span>eBay sold avg</span><span>$${r.sold_avg.toFixed(0)}</span></div>` : ""}
      ${r.new_price  ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;padding:2px 0"><span>New retail</span><span>$${r.new_price.toFixed(0)}</span></div>` : ""}
      <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;border-top:1px solid #e5e7eb;padding-top:6px;margin-top:4px">
        <span>Listed price</span><span>$${r.price.toFixed(0)}</span>
      </div>
      <div style="font-size:12px;font-weight:600;margin-top:4px">${diffLabel}</div>
    </div>
    ${greenFlags ? `<div style="margin-bottom:8px">${greenFlags}</div>` : ""}
    ${redFlags   ? `<div style="margin-bottom:8px">${redFlags}</div>`   : ""}
    <div style="background:#f0fdf4;border-radius:8px;padding:10px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-weight:600;color:#15803d;font-size:13px">💬 Offer</span>
      <span style="font-weight:800;font-size:20px;color:#15803d">$${r.recommended_offer.toFixed(0)}</span>
    </div>
    ${affiliateLinks}
    <div style="margin-top:8px;font-size:10px;color:#d1d5db;text-align:center">Powered by Claude AI · eBay market data</div>
  </div>`;
}
