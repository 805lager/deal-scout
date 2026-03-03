/**
 * content/craigslist.js — Craigslist Content Script
 *
 * Craigslist is much simpler than FBM — static HTML, no React,
 * selectors are extremely stable. This is the easiest platform to scrape.
 *
 * URL pattern matched: https://*.craigslist.org/*/d/*/*
 * Example:             https://sandiego.craigslist.org/ele/d/telescope/12345.html
 */

(async function () {
  "use strict";

  // Guard — only run on individual listing pages
  if (!document.querySelector(".postingtitletext, #titletextonly")) return;

  const listing = extractCraigslistListing();
  if (!listing) return;

  // Reuse the same sidebar injection from fbm.js
  // WHY: The sidebar UI is platform-agnostic — same look everywhere
  injectSidebar({ loading: true, listing });

  const response = await chrome.runtime.sendMessage({
    type:    "SCORE_LISTING",
    listing: listing,
  });

  if (response.success) {
    updateSidebar(response.result);
  } else {
    updateSidebar({ error: response.error });
  }
})();


function extractCraigslistListing() {
  // Craigslist HTML is clean and consistent — selectors rarely break
  const title = document.querySelector("#titletextonly, .postingtitletext span")
    ?.innerText?.trim();

  const rawPriceText = document.querySelector(".price")
    ?.innerText?.trim();

  if (!title) return null;

  const description = document.querySelector("#postingbody")
    ?.innerText?.replace("QR Code Link to This Post", "")?.trim() || "";

  // Location is in the postingtitletext after the price
  const locationEl = document.querySelector(".postingtitletext small");
  const location   = locationEl?.innerText?.replace(/[()]/g, "").trim() || "";

  // Condition is rarely listed on CL — we infer from description
  const condition = inferCondition(description);

  return {
    title:          title,
    price:          parsePrice(rawPriceText),
    raw_price_text: rawPriceText || "Unknown",
    description:    description.substring(0, 500), // Cap length
    location:       location,
    condition:      condition,
    seller_name:    "",   // CL doesn't show seller names
    listing_url:    window.location.href,
    source:         "craigslist_extension",
  };
}

function inferCondition(description) {
  const lower = description.toLowerCase();
  if (lower.includes("brand new") || lower.includes("never used")) return "New";
  if (lower.includes("like new") || lower.includes("mint"))         return "Used - Like New";
  if (lower.includes("good condition"))                              return "Used - Good";
  if (lower.includes("fair condition") || lower.includes("wear"))   return "Used - Fair";
  return "Used";
}

function parsePrice(text) {
  if (!text) return 0;
  const clean = text.replace(/[^0-9.]/g, "");
  return parseFloat(clean) || 0;
}

// Sidebar functions are shared — loaded from fbm.js
// TODO: Extract sidebar rendering to a shared content/sidebar.js
// For now, CL and FBM scripts are self-contained to keep the POC simple
function injectSidebar({ loading, listing }) {
  document.getElementById("dealscout-sidebar")?.remove();
  const sidebar = document.createElement("div");
  sidebar.id = "dealscout-sidebar";
  sidebar.style.cssText = `
    position:fixed;top:80px;right:16px;width:300px;
    max-height:calc(100vh - 100px);overflow-y:auto;
    background:#fff;border-radius:12px;
    box-shadow:0 4px 24px rgba(0,0,0,0.18);z-index:99999;
    font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;color:#111827;
  `;
  sidebar.innerHTML = `
    <div style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-weight:700;font-size:15px">🛒 Deal Scout</span>
        <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:18px;color:#9ca3af">✕</button>
      </div>
      <div style="background:#f3f4f6;border-radius:8px;padding:16px;text-align:center;color:#6b7280">
        ⏳ Analyzing deal...<br>
        <span style="font-size:11px">${listing?.title?.substring(0, 40)}</span>
      </div>
    </div>`;
  document.body.appendChild(sidebar);
  sidebar.querySelector("#dealscout-close")?.addEventListener("click", () => sidebar.remove());
}

function updateSidebar(result) {
  const sidebar = document.getElementById("dealscout-sidebar");
  if (sidebar) sidebar.remove();
  // Re-inject with result — full render handled by background response
  // TODO: Share renderScore() between content scripts
}
