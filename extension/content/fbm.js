/**
 * content/fbm.js — Facebook Marketplace Content Script
 *
 * WHY THIS APPROACH:
 *   This script runs inside the user's own authenticated FBM session.
 *   It can read the fully-rendered DOM — no scraping, no fake accounts,
 *   no bot detection. The user IS logged in. We just read what's visible.
 *
 * WHAT IT DOES:
 *   1. Detects when a FBM listing page is loaded
 *   2. Extracts listing data from the DOM
 *   3. Sends data to background.js to call our API
 *   4. Injects the deal score sidebar into the page
 *
 * [BOT RISK]: None — this runs as a real user browsing their own session.
 *
 * FRAGILITY NOTE:
 *   FBM uses React with dynamically generated class names that change
 *   frequently. We use multiple selector strategies and aria-labels
 *   where possible — these are more stable than class names.
 */

(async function () {
  "use strict";

  // Listen for manual rescore request from the popup button
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "RESCORE") runScorer();
  });

  // Only auto-run on individual listing pages, not search results
  if (!window.location.pathname.includes("/marketplace/item/")) return;

  runScorer();
})();

async function runScorer() {

  // Wait for React to finish rendering the listing
  // WHY: FBM is a SPA — the DOM isn't ready on DOMContentLoaded
  await waitForElement('h1, [data-testid="marketplace-pdp-title"]', 5000);

  const listing = extractListing();
  if (!listing) {
    console.warn("[DealScout] Could not extract listing data from this page");
    return;
  }

  // Show sidebar immediately with loading state
  injectSidebar({ loading: true, listing });

  // Send to background script for scoring
  const response = await chrome.runtime.sendMessage({
    type:    "SCORE_LISTING",
    listing: listing,
  });

  if (response.success) {
    updateSidebar(response.result);
  } else {
    updateSidebar({ error: response.error });
  }
}


// ── Listing Extraction ────────────────────────────────────────────────────────

function extractListing() {
  /**
   * Extract all available listing fields from the FBM DOM.
   *
   * SELECTOR STRATEGY:
   *   1. Try data-testid attributes first — most stable
   *   2. Fall back to aria-labels — also relatively stable
   *   3. Last resort: structural selectors — most fragile, will break
   *
   * Returns null if we can't get at least a title and price.
   */
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

  if (!title || !rawPriceText) {
    console.warn("[DealScout] Missing required fields — title or price not found");
    return null;
  }

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
    findConditionText() ||
    "Unknown"
  );

  const sellerName = (
    getText('a[href*="/marketplace/seller/"] span') ||
    getText('a[href*="/profile.php"] span') ||
    ""
  );

  return {
    title:          title.trim(),
    price:          parsePrice(rawPriceText),
    raw_price_text: rawPriceText.trim(),
    description:    description.trim(),
    location:       location.trim(),
    condition:      condition.trim(),
    seller_name:    sellerName.trim(),
    listing_url:    window.location.href,
    source:         "fbm_extension",
  };
}


function findPriceText() {
  /** Scan all spans for one containing a $ price — last resort fallback. */
  const spans = document.querySelectorAll("span");
  for (const span of spans) {
    const t = span.innerText?.trim();
    if (t && t.startsWith("$") && t.length < 15 && /\d/.test(t)) return t;
  }
  return null;
}


function findConditionText() {
  /** Look for common FBM condition strings in the page text. */
  const conditions = ["New", "Like New", "Good", "Fair", "Poor"];
  const bodyText   = document.body.innerText;
  for (const cond of conditions) {
    if (bodyText.includes(cond)) return cond;
  }
  return null;
}


// ── DOM Helpers ───────────────────────────────────────────────────────────────

function getText(selector) {
  const el = document.querySelector(selector);
  return el?.innerText?.trim() || null;
}

function parsePrice(text) {
  if (!text) return 0;
  const clean = text.replace(/[^0-9.]/g, "");
  return parseFloat(clean) || 0;
}

function waitForElement(selector, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for: ${selector}`));
    }, timeoutMs);
  });
}


// ── Sidebar Injection ─────────────────────────────────────────────────────────

function injectSidebar({ loading, listing, result, error }) {
  /**
   * Inject the deal score sidebar into the FBM listing page.
   *
   * WHY INJECT INTO THE PAGE (not a popup):
   *   A sidebar that appears right on the listing is far more useful
   *   than a popup that requires a click. The user sees the score
   *   immediately while looking at the listing.
   *
   *   This is the same pattern used by Honey and Capital One Shopping.
   */

  // Remove existing sidebar if present
  document.getElementById("dealscout-sidebar")?.remove();

  const sidebar = document.createElement("div");
  sidebar.id = "dealscout-sidebar";
  sidebar.style.cssText = `
    position: fixed;
    top: 80px;
    right: 16px;
    width: 300px;
    max-height: calc(100vh - 100px);
    overflow-y: auto;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.18);
    z-index: 99999;
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 14px;
    color: #111827;
  `;

  sidebar.innerHTML = loading
    ? renderLoading(listing)
    : error
    ? renderError(error)
    : renderScore(result);

  document.body.appendChild(sidebar);

  // Allow user to close the sidebar
  sidebar.querySelector("#dealscout-close")?.addEventListener("click", () => {
    sidebar.remove();
  });
}

function updateSidebar(resultOrError) {
  const sidebar = document.getElementById("dealscout-sidebar");
  if (!sidebar) return;

  if (resultOrError.error) {
    sidebar.innerHTML = renderError(resultOrError.error);
  } else {
    sidebar.innerHTML = renderScore(resultOrError);
    // Re-attach close button listener after re-render
    sidebar.querySelector("#dealscout-close")?.addEventListener("click", () => {
      sidebar.remove();
    });
  }
}


// ── Sidebar HTML Templates ────────────────────────────────────────────────────

function renderLoading(listing) {
  return `
    <div style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-weight:700;font-size:15px">🛒 Deal Scout</span>
        <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:18px;color:#9ca3af">✕</button>
      </div>
      <div style="color:#6b7280;font-size:13px;margin-bottom:8px">
        Scoring: <strong>${listing?.title?.substring(0, 40)}...</strong>
      </div>
      <div style="background:#f3f4f6;border-radius:8px;padding:16px;text-align:center;color:#6b7280">
        ⏳ Analyzing deal...<br>
        <span style="font-size:11px">Checking eBay + Amazon prices</span>
      </div>
    </div>
  `;
}

function renderError(errorMsg) {
  return `
    <div style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-weight:700;font-size:15px">🛒 Deal Scout</span>
        <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:18px;color:#9ca3af">✕</button>
      </div>
      <div style="background:#fef2f2;border-radius:8px;padding:12px;color:#dc2626;font-size:13px">
        ⚠️ Scoring failed: ${errorMsg}<br><br>
        Make sure the Deal Scout API is running at localhost:8000
      </div>
    </div>
  `;
}

function renderScore(r) {
  const scoreColor = r.score >= 7 ? "#22c55e" : r.score >= 5 ? "#fbbf24" : "#ef4444";
  const buyLabel   = r.should_buy ? "✅ BUY" : "❌ PASS";
  const buyBg      = r.should_buy ? "#22c55e" : "#ef4444";
  const diff       = r.price - r.estimated_value;
  const diffLabel  = diff > 0
    ? `🔴 $${diff.toFixed(0)} over market`
    : `🟢 $${Math.abs(diff).toFixed(0)} below market`;

  const greenFlags = (r.green_flags || [])
    .map(f => `<div style="padding:4px 0;border-bottom:1px solid #f0fdf4;font-size:12px">✅ ${f}</div>`)
    .join("");

  const redFlags = (r.red_flags || [])
    .map(f => `<div style="padding:4px 0;border-bottom:1px solid #fef2f2;font-size:12px">⚠️ ${f}</div>`)
    .join("");

  const affiliateLinks = r.affiliateLinks
    ? `
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f3f4f6">
        <div style="font-weight:600;font-size:12px;color:#6b7280;margin-bottom:6px">COMPARE PRICES</div>
        <a href="${r.affiliateLinks.ebay_sold.url}" target="_blank"
           style="display:block;padding:7px 10px;background:#f0fdf4;border-radius:6px;
                  color:#15803d;text-decoration:none;font-size:12px;font-weight:600;margin-bottom:4px">
          📦 ${r.affiliateLinks.ebay_sold.label}
        </a>
        <a href="${r.affiliateLinks.amazon.url}" target="_blank"
           style="display:block;padding:7px 10px;background:#fffbeb;border-radius:6px;
                  color:#92400e;text-decoration:none;font-size:12px;font-weight:600">
          🛒 ${r.affiliateLinks.amazon.label}
        </a>
      </div>`
    : "";

  return `
    <div style="padding:16px">
      <!-- Header -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-weight:700;font-size:15px">🛒 Deal Scout</span>
        <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:18px;color:#9ca3af">✕</button>
      </div>

      <!-- Score + verdict -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:28px;font-weight:800;color:${scoreColor}">${r.score}<span style="font-size:14px;color:#9ca3af">/10</span></div>
        <div style="background:${buyBg};color:#fff;border-radius:6px;padding:6px 12px;font-weight:700;font-size:13px">${buyLabel}</div>
      </div>

      <!-- Score bar -->
      <div style="background:#e5e7eb;border-radius:6px;height:8px;margin-bottom:8px;overflow:hidden">
        <div style="width:${r.score * 10}%;height:100%;background:${scoreColor};border-radius:6px;transition:width 0.5s"></div>
      </div>

      <!-- Verdict -->
      <div style="font-style:italic;color:#374151;font-size:13px;margin-bottom:10px;padding:8px;background:#f8fafc;border-radius:6px;border-left:3px solid #6366f1">
        ${r.verdict}
      </div>

      <!-- Price comparison -->
      <div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-bottom:4px">
          <span>eBay sold avg</span><span>$${r.sold_avg?.toFixed(0)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-bottom:4px">
          <span>Est. value</span><span>$${r.estimated_value?.toFixed(0)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;border-top:1px solid #e5e7eb;padding-top:6px;margin-top:4px">
          <span>Listed price</span><span>$${r.price?.toFixed(0)}</span>
        </div>
        <div style="font-size:12px;font-weight:600;margin-top:6px">${diffLabel}</div>
      </div>

      <!-- Flags -->
      ${greenFlags ? `<div style="margin-bottom:8px">${greenFlags}</div>` : ""}
      ${redFlags   ? `<div style="margin-bottom:8px">${redFlags}</div>`   : ""}

      <!-- Recommended offer -->
      <div style="background:#f0fdf4;border-radius:8px;padding:10px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:600;color:#15803d;font-size:13px">💬 Offer</span>
        <span style="font-weight:800;font-size:18px;color:#15803d">$${r.recommended_offer?.toFixed(0)}</span>
      </div>

      <!-- Affiliate links (revenue) -->
      ${affiliateLinks}

      <!-- Footer -->
      <div style="margin-top:10px;font-size:10px;color:#d1d5db;text-align:center">
        Powered by Claude AI · eBay market data
      </div>
    </div>
  `;
}
