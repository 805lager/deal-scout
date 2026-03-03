/**
 * content/amazon.js — Amazon Content Script
 *
 * WHY AMAZON SPECIFICALLY:
 *   Amazon serves two purposes in our product:
 *     1. RETAIL PRICE ANCHOR — what does this item cost new?
 *        A used item listed at $300 looks different if new retail is $350 vs $900.
 *     2. AFFILIATE REVENUE — we link to Amazon results and earn on purchases
 *
 * ON AMAZON LISTING PAGES:
 *   We extract product data and check if the user is comparing a new
 *   purchase vs a used FBM listing they're considering.
 *   The sidebar shows: "This is $X new. Is the used listing worth it?"
 *
 * URL pattern matched: https://www.amazon.com/dp/* and /*/dp/*
 */

(async function () {
  "use strict";

  // Only run on product pages
  if (!document.getElementById("productTitle")) return;

  const product = extractAmazonProduct();
  if (!product) return;

  // On Amazon we show a simpler sidebar:
  // "You're viewing this item new for $X. If you find it used on FBM, here's what to pay."
  injectAmazonSidebar(product);
})();


function extractAmazonProduct() {
  const title = document.getElementById("productTitle")?.innerText?.trim();
  if (!title) return null;

  // Amazon has multiple price elements depending on sale/Prime state
  const priceWhole = document.querySelector(".a-price-whole")?.innerText?.trim();
  const priceFrac  = document.querySelector(".a-price-fraction")?.innerText?.trim();
  const priceText  = priceWhole
    ? `$${priceWhole.replace(",", "")}${priceFrac ? "." + priceFrac : ""}`
    : document.querySelector("#priceblock_ourprice, #priceblock_dealprice, .a-offscreen")
        ?.innerText?.trim() || null;

  const rating    = document.querySelector("#averageCustomerReviews .a-color-base")
    ?.innerText?.trim() || "";
  const reviewCnt = document.querySelector("#acrCustomerReviewText")
    ?.innerText?.trim() || "";
  const asin      = document.querySelector('[data-asin]')
    ?.getAttribute("data-asin") || "";

  return {
    title,
    price:          parseFloat(priceText?.replace(/[^0-9.]/g, "") || "0"),
    raw_price_text: priceText || "Unknown",
    asin,
    rating,
    review_count:   reviewCnt,
    url:            window.location.href,
    source:         "amazon_extension",
  };
}


function injectAmazonSidebar(product) {
  /**
   * On Amazon pages we show a "Should I buy used instead?" prompt.
   * This drives users back to FBM/Craigslist and scores deals for them —
   * creating a cross-platform loop that increases engagement.
   */
  document.getElementById("dealscout-sidebar")?.remove();

  const usedTarget = Math.round(product.price * 0.55); // Suggest ~45% below new

  const sidebar = document.createElement("div");
  sidebar.id = "dealscout-sidebar";
  sidebar.style.cssText = `
    position:fixed;top:80px;right:16px;width:280px;
    background:#fff;border-radius:12px;
    box-shadow:0 4px 24px rgba(0,0,0,0.18);z-index:99999;
    font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;color:#111827;
  `;

  sidebar.innerHTML = `
    <div style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-weight:700;font-size:15px">🛒 Deal Scout</span>
        <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:18px;color:#9ca3af">✕</button>
      </div>

      <div style="background:#fffbeb;border-radius:8px;padding:12px;margin-bottom:10px">
        <div style="font-weight:600;font-size:13px;color:#92400e;margin-bottom:4px">💡 Buy Used Instead?</div>
        <div style="font-size:12px;color:#374151">
          New price: <strong>${product.raw_price_text}</strong><br>
          Target used price: <strong style="color:#15803d">~$${usedTarget}</strong><br>
          <span style="color:#6b7280">Look for this on FBM or Craigslist</span>
        </div>
      </div>

      <div style="font-size:12px;color:#374151;margin-bottom:10px;padding:8px;background:#f8fafc;border-radius:6px">
        <strong>${product.title.substring(0, 60)}${product.title.length > 60 ? "..." : ""}</strong><br>
        ${product.rating ? `⭐ ${product.rating} · ${product.review_count}` : ""}
      </div>

      <div style="font-size:11px;color:#9ca3af;text-align:center">
        Find this used and paste the listing into Deal Scout to score the deal
      </div>
    </div>
  `;

  document.body.appendChild(sidebar);
  sidebar.querySelector("#dealscout-close")?.addEventListener("click", () => sidebar.remove());
}

function parsePrice(text) {
  if (!text) return 0;
  return parseFloat(text.replace(/[^0-9.]/g, "")) || 0;
}
