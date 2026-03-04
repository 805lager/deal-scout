/**
 * content/fbm.js — Facebook Marketplace Content Script
 *
 * FEATURES IN THIS VERSION:
 *   1. Deal scoring with collapsible sidebar (bottom-right tab)
 *   2. One-click message templates (copy offer/inquiry messages)
 *   3. Price history tracking (stored locally, shown in sidebar)
 *   4. Search results overlay (badges on listing thumbnails)
 *   5. Seller trust scoring (DOM extraction + Claude analysis)
 */

// ── State ─────────────────────────────────────────────────────────────────────
let sidebarMinimized = false;


// ── Entry Point ───────────────────────────────────────────────────────────────

(async function () {
  "use strict";

  // Listen for manual rescore from popup
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "RESCORE") {
      if (window.location.pathname.includes("/marketplace/item/")) runScorer();
      else runSearchOverlay();
    }
  });

  // Individual listing page — run full scorer
  if (window.location.pathname.includes("/marketplace/item/")) {
    runScorer();
    return;
  }

  // Search results / browse page — run lightweight overlay
  if (window.location.pathname.startsWith("/marketplace")) {
    runSearchOverlay();
  }
})();


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 1 + 3 + 4 + 5 — LISTING PAGE SCORER
// ══════════════════════════════════════════════════════════════════════════════

async function runScorer() {
  try {
    await waitForElement('h1, [data-testid="marketplace-pdp-title"]', 6000);
  } catch {
    console.warn("[DealScout] Page took too long to load");
    return;
  }

  const listing = extractListing();
  if (!listing) {
    console.warn("[DealScout] Could not extract title/price");
    return;
  }

  // FEATURE 3: Record this visit for price history BEFORE scoring
  // WHY: We want to track price over time even if scoring fails
  await recordPriceHistory(listing);

  console.log("[DealScout] Scoring:", listing.title, "$" + listing.price);
  injectSidebar({ loading: true, listing });

  const response = await chrome.runtime.sendMessage({
    type:    "SCORE_LISTING",
    listing: listing,
  });

  if (response?.success) {
    // Attach price history to result so sidebar can display it
    response.result.priceHistory = await getPriceHistory(listing.listing_url);
    updateSidebar(response.result);
  } else {
    updateSidebar({ error: response?.error || "Unknown error" });
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 4 — SELLER TRUST EXTRACTION
// WHY: Seller info is visible in the DOM — account age, other listings, etc.
// We extract it here and include it in the listing sent to Claude so it can
// factor seller credibility into the deal score.
// ══════════════════════════════════════════════════════════════════════════════

function extractSellerTrust() {
  /**
   * WHY THESE SPECIFIC PATTERNS:
   * Verified live against current FBM DOM (March 2026):
   *   - FBM says "Joined Facebook in 2022", NOT "Member since"
   *   - Review count appears as standalone "(5)" span near seller name
   *   - "Highly rated" appears as exact text in a span
   *   - FBM does NOT show numeric star ratings — we infer from badges
   */
  const bodyText = document.body.innerText;

  // "Joined Facebook in 2022" — confirmed present in current DOM
  const joinedMatch = bodyText.match(/Joined Facebook in (\d{4})/i);
  const memberSince = joinedMatch ? `Jan ${joinedMatch[1]}` : null;

  // Review count — appears as "(5)" as a standalone leaf span
  const reviewSpan = Array.from(document.querySelectorAll('span'))
    .find(el => el.childElementCount === 0 && /^\(\d+\)$/.test(el.innerText?.trim()));
  const reviewCount = reviewSpan
    ? parseInt(reviewSpan.innerText.replace(/[()]/g, ''))
    : null;

  // "Highly rated" badge — confirmed present in current DOM
  const isHighlyRated = bodyText.includes('Highly rated');

  // Response rate — not always shown but check anyway
  const responseMatch = bodyText.match(/(\d+)%\s*response rate/i);
  const responseRate  = responseMatch ? parseInt(responseMatch[1]) : null;

  // Other listings count
  const listingsMatch = bodyText.match(/(\d+)\s*(?:other\s*)?listings?/i);
  const otherListings = listingsMatch ? parseInt(listingsMatch[1]) : null;

  // Infer a rating proxy from what FBM actually shows
  // FBM has no numeric stars — "Highly rated" + review count is our signal
  const inferredRating = isHighlyRated ? 4.8
    : (reviewCount && reviewCount >= 5) ? 4.0
    : null;

  return {
    member_since:    memberSince,
    response_rate:   responseRate,
    other_listings:  otherListings,
    seller_rating:   inferredRating,
    review_count:    reviewCount,
    is_highly_rated: isHighlyRated,
    trust_tier:      computeTrustTier(memberSince, responseRate, otherListings, inferredRating),
  };
}

function computeTrustTier(memberSince, responseRate, otherListings, rating) {
  /**
   * Scoring based on signals actually present in the FBM DOM.
   * "Highly rated" badge (inferred rating 4.8) is the strongest signal.
   * Account age (from "Joined Facebook in YYYY") is second.
   */
  let score = 0;

  if (memberSince) {
    const year = parseInt(memberSince.match(/\d{4}/)?.[0] || "0");
    if (year && year <= 2022) score += 2;      // 3+ year old account
    else if (year && year <= 2024) score += 1; // 1-2 year old account
  }

  if (rating && rating >= 4.5) score += 3;    // "Highly rated" badge = inferred 4.8
  else if (rating && rating >= 4.0) score += 2; // Has reviews, decent score

  if (responseRate && responseRate >= 80) score += 1;

  if (otherListings && otherListings >= 5) score += 1;

  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "unknown"; // Not enough data visible — not necessarily bad
}


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 3 — PRICE HISTORY (chrome.storage.local)
// WHY: No server/database needed. chrome.storage.local holds ~5MB per extension.
// We store price observations keyed by listing URL.
// This tells buyers "this was $600 two weeks ago, now $500" — powerful signal.
// ══════════════════════════════════════════════════════════════════════════════

async function recordPriceHistory(listing) {
  const key     = `ph_${hashUrl(listing.listing_url)}`;
  const now     = Date.now();
  const entry   = { price: listing.price, date: now, title: listing.title };

  try {
    const stored = await chrome.storage.local.get(key);
    const history = stored[key] || [];

    // Only record if price changed or it's the first visit
    const last = history[history.length - 1];
    if (!last || last.price !== listing.price) {
      history.push(entry);
      // Keep last 20 price observations per listing
      if (history.length > 20) history.shift();
      await chrome.storage.local.set({ [key]: history });
    }
  } catch (e) {
    console.warn("[DealScout] Price history write failed:", e);
  }
}

async function getPriceHistory(url) {
  const key = `ph_${hashUrl(url)}`;
  try {
    const stored = await chrome.storage.local.get(key);
    return stored[key] || [];
  } catch {
    return [];
  }
}

function hashUrl(url) {
  // Simple hash to create a storage key from a URL
  // WHY: URL can contain characters invalid for storage keys
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash) + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function renderPriceHistory(history) {
  /**
   * WHY SHOW PRICE HISTORY:
   * A seller dropping from $600 → $500 is motivated — make a lower offer.
   * A stable price means they're not in a hurry — different negotiation.
   * CamelCamelCamel does this for Amazon. Nobody does it for FBM. This is
   * one of our clearest competitive advantages.
   */
  if (!history || history.length < 2) return "";

  const rows = history.slice(-5).map(h => {
    const date  = new Date(h.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;color:#6b7280">
      <span>${date}</span><span style="font-weight:600;color:#374151">$${h.price.toFixed(0)}</span>
    </div>`;
  }).join("");

  const first = history[0].price;
  const last  = history[history.length - 1].price;
  const delta = last - first;
  const deltaLabel = delta < 0
    ? `<span style="color:#22c55e">↓ $${Math.abs(delta).toFixed(0)} since first seen</span>`
    : delta > 0
    ? `<span style="color:#ef4444">↑ $${delta.toFixed(0)} since first seen</span>`
    : `<span style="color:#6b7280">Stable price</span>`;

  return `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid #f3f4f6">
      <div style="font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:6px">
        📈 PRICE HISTORY ${deltaLabel}
      </div>
      <div style="background:#f8fafc;border-radius:6px;padding:8px">
        ${rows}
      </div>
    </div>`;
}


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — MESSAGE TEMPLATES
// WHY: The scoring result tells you what to offer. The message template
// removes friction from acting on that recommendation. User sees $420 offer
// suggestion → clicks "Copy" → pastes directly into FBM messenger.
// This is a tiny feature with huge UX impact — closes the loop.
// ══════════════════════════════════════════════════════════════════════════════

function renderMessageTemplates(r) {
  const offer      = r.recommended_offer.toFixed(0);
  const isGoodDeal = r.should_buy;

  // Three templates covering the main scenarios
  const templates = [
    {
      label: `💬 Offer $${offer}`,
      color: "#667eea",
      message: `Hi! I'm interested in your listing. Would you accept $${offer}? I can pick up at your convenience. Thanks!`,
    },
    {
      label: "❓ Ask condition",
      color: "#64748b",
      message: `Hi! I'm interested. Could you tell me more about the condition? Any issues, missing parts, or cosmetic damage I should know about? Thanks!`,
    },
    ...(isGoodDeal ? [{
      label: "⚡ Fast offer",
      color: "#22c55e",
      message: `Hi! I can offer $${offer} and pick up today or tomorrow. Is this still available? Thanks!`,
    }] : [{
      label: "💰 Low offer",
      color: "#f59e0b",
      message: `Hi! I noticed this has been listed for a while. Would you consider $${Math.round(r.recommended_offer * 0.9).toFixed(0)}? Happy to pick up quickly. Thanks!`,
    }]),
  ];

  const buttons = templates.map(t => `
    <button class="ds-msg-btn" data-message="${encodeURIComponent(t.message)}"
      style="display:block;width:100%;padding:7px 10px;margin-bottom:4px;
             background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;
             color:#374151;font-size:12px;font-weight:600;cursor:pointer;
             text-align:left;transition:background 0.15s">
      ${t.label}
    </button>`).join("");

  return `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid #f3f4f6">
      <div style="font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:6px">SEND A MESSAGE</div>
      ${buttons}
      <div id="ds-copy-confirm" style="display:none;font-size:11px;color:#22c55e;text-align:center;margin-top:4px">
        ✅ Copied to clipboard!
      </div>
    </div>`;
}

function attachMessageHandlers() {
  /**
   * WHY COPY TO CLIPBOARD (not auto-fill the FBM message box):
   * Auto-filling FBM's message textarea is fragile — their React component
   * fights DOM manipulation. Clipboard copy is instant, reliable, and
   * lets the user review the message before sending.
   */
  document.querySelectorAll(".ds-msg-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const message = decodeURIComponent(btn.getAttribute("data-message"));
      try {
        await navigator.clipboard.writeText(message);
        const confirm = document.getElementById("ds-copy-confirm");
        if (confirm) {
          confirm.style.display = "block";
          setTimeout(() => { confirm.style.display = "none"; }, 2000);
        }
      } catch {
        // Clipboard API can fail if page isn't focused — fallback
        const ta = document.createElement("textarea");
        ta.value = message;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
    });

    btn.addEventListener("mouseenter", () => { btn.style.background = "#f0f4ff"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#f8fafc"; });
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — SEARCH RESULTS OVERLAY
// WHY: The Honey model — works passively in the background. User browses
// normally and sees deal quality at a glance without clicking each listing.
// We badge each thumbnail with a coloured indicator:
//   🟢 Cached good deal (previously scored)
//   🟡 Cached fair deal
//   🔴 Cached bad deal
//   ⭐ New — never scored (click to score)
// This drives listing page visits which drives scoring which drives affiliate clicks.
// ══════════════════════════════════════════════════════════════════════════════

async function runSearchOverlay() {
  /**
   * WHY MutationObserver here:
   * FBM search results load more listings as you scroll (infinite scroll).
   * We can't just run once — we need to badge new listings as they appear.
   */
  await waitForElement('[data-testid="marketplace-search-feed-item"], a[href*="/marketplace/item/"]', 5000)
    .catch(() => null);

  // Badge existing listings
  await badgeVisibleListings();

  // Watch for new listings loaded by infinite scroll
  const observer = new MutationObserver(async () => {
    await badgeVisibleListings();
  });

  const feed = document.querySelector('[role="main"], #content, body');
  if (feed) {
    observer.observe(feed, { childList: true, subtree: true });
  }
}

async function badgeVisibleListings() {
  // Find all listing links on the search page
  const links = document.querySelectorAll('a[href*="/marketplace/item/"]');

  for (const link of links) {
    // Skip if already badged
    if (link.querySelector(".ds-badge")) continue;

    const href    = link.href;
    const key     = `ph_${hashUrl(href)}`;
    const history = await chrome.storage.local.get(key).then(r => r[key]).catch(() => null);

    // Check if we have a cached score for this listing
    const scoreKey   = `score_${hashUrl(href)}`;
    const cachedScore = await chrome.storage.local.get(scoreKey)
      .then(r => r[scoreKey]).catch(() => null);

    const badge = document.createElement("div");
    badge.className = "ds-badge";
    badge.style.cssText = `
      position:absolute;top:6px;left:6px;
      border-radius:6px;padding:2px 7px;
      font-size:11px;font-weight:700;
      color:#fff;z-index:9999;
      pointer-events:none;
      box-shadow:0 1px 4px rgba(0,0,0,0.3);
      font-family:'Segoe UI',system-ui,sans-serif;
    `;

    if (cachedScore) {
      // We've scored this before — show the cached score
      const s = cachedScore;
      badge.style.background = s >= 7 ? "#22c55e" : s >= 5 ? "#f59e0b" : "#ef4444";
      badge.textContent = `${s}/10`;
      badge.title = "Deal Scout score — click listing for full analysis";
    } else if (history && history.length > 0) {
      // We've seen this listing before but haven't scored it
      badge.style.background = "#6366f1";
      badge.textContent = "seen";
      badge.title = "Deal Scout has seen this listing before";
    } else {
      // Never seen — subtle new indicator
      badge.style.background = "rgba(99,102,241,0.7)";
      badge.textContent = "new";
      badge.title = "Deal Scout — click to score this listing";
    }

    // Make the link container relative so we can position the badge
    const container = link.querySelector("div") || link;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(badge);
  }
}


// ── Listing Extraction ────────────────────────────────────────────────────────

function extractListing() {
  /**
   * WHY WE NO LONGER USE data-testid SELECTORS:
   * Facebook silently removed all data-testid attributes from Marketplace
   * in late 2024. Every selector like [data-testid="marketplace-pdp-title"]
   * now returns null. We've replaced them with structural + pattern selectors
   * that are more resilient to FBM's frequent DOM changes.
   */

  // TITLE — FBM always has two h1s on a listing page:
  //   [0] = "Notifications" (left nav)
  //   [1] = actual listing title
  // We skip the first one explicitly.
  const allH1s  = Array.from(document.querySelectorAll('h1'))
    .map(el => el.innerText?.trim())
    .filter(t => t && t !== 'Notifications' && t.length > 1);
  const title = allH1s[0] || null;

  // PRICE — Scan all spans for the first clean "$XXX" or "$X,XXX" pattern.
  // The listing price is always the first $ amount that appears in the DOM
  // flow (above the fold on the right panel).
  const rawPriceText = findPriceText();

  if (!title || !rawPriceText) {
    console.warn("[DealScout] Missing title or price", { title, rawPriceText });
    return null;
  }

  // DESCRIPTION — FBM wraps listing body text in span[dir=auto] inside
  // div[aria-hidden=false]. We grab all candidates and return the longest
  // one — that's almost always the actual listing description.
  const description = findDescription();

  // LOCATION — Scan leaf spans for "City, ST" pattern (e.g. "San Marcos, CA").
  // This is more reliable than any structural selector since FBM wraps it
  // differently depending on listing type.
  const location = findLocation();

  // CONDITION — Scan for exact FBM condition strings at the leaf span level.
  const condition = findConditionInDOM() || findConditionText(description) || "Unknown";

  // SELLER NAME — Scan for the name text that appears in the Seller section.
  // FBM no longer uses /marketplace/seller/ or /profile.php hrefs reliably.
  const sellerName = findSellerName();

  // FEATURE 5: Extract seller trust signals
  const sellerTrust = extractSellerTrust();

  return {
    title:           title.trim(),
    price:           parsePrice(rawPriceText),
    raw_price_text:  rawPriceText.trim(),
    description:     description.trim(),
    location:        location.trim(),
    condition:       condition.trim(),
    seller_name:     sellerName.trim(),
    seller_trust:    sellerTrust,
    listing_url:     window.location.href,
    is_multi_item:   detectMultiItem(title, description),
    source:          "fbm_extension",
  };
}

function findDescription() {
  /**
   * WHY WE FILTER SOCIAL CONTENT:
   * FBM pages contain Facebook feed posts (reels, shared posts) alongside
   * the actual listing. span[dir=auto] matches both. We filter out social
   * media noise by excluding strings that look like posts rather than
   * product descriptions.
   *
   * Strategy: collect all span[dir=auto] candidates, exclude obvious social
   * content (contains "shared a", has @-mentions, has multiple newlines),
   * then return the longest clean candidate.
   */
  const socialNoiseRe = /shared a |shared an |@[\w]+|#[\w]+|\n.*\n.*\n/i;

  const candidates = Array.from(
    document.querySelectorAll('div[aria-hidden="false"] span[dir="auto"]')
  )
    .map(el => el.innerText?.trim())
    .filter(t =>
      t &&
      t.length > 15 &&          // long enough to be a real description
      t.length < 3000 &&        // not a giant blob of page text
      !socialNoiseRe.test(t)    // not a social media post
    );

  if (!candidates.length) return "";

  // Return the longest clean candidate
  return candidates.reduce((a, b) => a.length > b.length ? a : b, "");
}

function findLocation() {
  // Scan leaf spans for a "City, ST" or "City, State" pattern.
  // Exclude obvious non-location matches.
  const cityStateRe = /^[A-Za-z\s]+,\s*[A-Z]{2}$/;
  const found = Array.from(document.querySelectorAll('span'))
    .find(el => el.childElementCount === 0 && cityStateRe.test(el.innerText?.trim()));
  return found?.innerText?.trim() || "";
}

function findConditionInDOM() {
  /**
   * WHY WE PREFER FULL CONDITION STRINGS:
   * "New", "Good", "Fair" appear as standalone words all over the page.
   * The full FBM condition strings like "Used - Like New" are unique to
   * the listing details panel. We check full strings first, fall back to
   * short ones only if nothing else matches.
   */
  const fullConditions  = ["Used - Like New", "Used - Good", "Used - Fair", "Used - Poor"];
  const shortConditions = ["New", "Like New", "Good", "Fair", "Poor"];

  const allLeafSpans = Array.from(document.querySelectorAll('span'))
    .filter(el => el.childElementCount === 0);

  // Try unambiguous multi-word conditions first
  const fullMatch = allLeafSpans.find(el => fullConditions.includes(el.innerText?.trim()));
  if (fullMatch) return fullMatch.innerText.trim();

  // For short conditions, only match if near the "Condition" label
  // to avoid matching "New" from unrelated page content
  const conditionLabel = allLeafSpans.find(el => el.innerText?.trim() === 'Condition');
  if (conditionLabel) {
    const section = conditionLabel.closest('div') || conditionLabel.parentElement;
    const nearby  = Array.from(section?.querySelectorAll('span') || [])
      .find(el => el.childElementCount === 0 && shortConditions.includes(el.innerText?.trim()));
    if (nearby) return nearby.innerText.trim();
  }

  return null;
}

function findSellerName() {
  // The seller section contains a clickable name — find spans inside links
  // that appear near "Seller information" heading text.
  // Fall back to scanning for any person-name-looking span near seller section.
  const sellerHeading = Array.from(document.querySelectorAll('span, div'))
    .find(el => el.innerText?.trim() === 'Seller information');

  if (sellerHeading) {
    // Walk siblings/children to find a name span nearby
    const section = sellerHeading.closest('div[class]') || sellerHeading.parentElement;
    const nameEl  = section?.querySelector?.('a span, strong');
    if (nameEl?.innerText?.trim()) return nameEl.innerText.trim();
  }

  // Fallback — find a link that goes to a profile containing a name span
  return (
    getText('a[href*="/marketplace/seller/"] span') ||
    getText('a[href*="/profile/"] span') ||
    ""
  );
}

function detectMultiItem(title, description) {
  const text  = `${title} ${description}`.toLowerCase();
  const flags = [
    /\blot\b/, /\bset\b/, /\bbundle\b/, /\bkit\b/, /\bcollection\b/,
    /\bpiece\b/, /\bpcs\b/, /\bitems?\b/, /\d+\s*tools?\b/, /\d+\s*pairs?\b/,
    /\band\b.*\band\b/, /comes with|includes|included/,
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
  const lower = description.toLowerCase();
  if (/brand new|never used|sealed|unopened/.test(lower))       return "New";
  if (/like new|mint condition|barely used/.test(lower))         return "Used - Like New";
  if (/good condition|works great|fully functional/.test(lower)) return "Used - Good";
  if (/fair condition|some wear|shows wear/.test(lower))         return "Used - Fair";
  const conditions = ["Like New", "New", "Good", "Fair", "Poor"];
  for (const cond of conditions) {
    if (document.body.innerText.includes(cond)) return cond;
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
    ">
      🛒 Deal Scout
      <span id="dealscout-badge" style="background:rgba(255,255,255,0.25);border-radius:4px;padding:1px 6px;font-size:12px">...</span>
    </div>
    <div id="dealscout-panel" style="
      position:absolute;bottom:38px;right:0;width:310px;
      max-height:82vh;overflow-y:auto;background:#fff;
      border-radius:12px 12px 0 12px;
      box-shadow:0 4px 32px rgba(0,0,0,0.20);
    ">
      <div id="dealscout-content">${renderLoading(listing)}</div>
    </div>`;

  document.body.appendChild(root);
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

  if (badge) {
    badge.textContent = `${r.score}/10 ${r.should_buy ? "✅" : "❌"}`;
    badge.style.background = r.score >= 7 ? "rgba(34,197,94,0.3)"
                           : r.score >= 5 ? "rgba(251,191,36,0.3)"
                           : "rgba(239,68,68,0.3)";
  }

  // Cache the score so search overlay can display it on future visits
  const key = `score_${hashUrl(window.location.href)}`;
  chrome.storage.local.set({ [key]: r.score }).catch(() => {});

  document.getElementById("dealscout-close")?.addEventListener("click", () => {
    document.getElementById("dealscout-root")?.remove();
  });

  // FEATURE 1: Attach message button handlers after render
  attachMessageHandlers();
}


// ── Render Templates ──────────────────────────────────────────────────────────

function renderLoading(listing) {
  return `<div style="padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span style="font-weight:700">🛒 Deal Scout</span>
      <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:16px;color:#9ca3af">✕</button>
    </div>
    <div style="background:#f3f4f6;border-radius:8px;padding:16px;text-align:center;color:#6b7280">
      ⏳ Analyzing deal...<br>
      <span style="font-size:11px;margin-top:4px;display:block">
        ${listing?.title?.substring(0, 45) || ""}${(listing?.title?.length || 0) > 45 ? "..." : ""}
      </span>
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
      ⚠️ ${msg}<br>
      <span style="font-size:11px;color:#9ca3af">API running? python -m uvicorn api.main:app --port 8000</span>
    </div>
  </div>`;
}

function renderScore(r) {
  const scoreColor = r.score >= 7 ? "#22c55e" : r.score >= 5 ? "#fbbf24" : "#ef4444";
  const buyBg      = r.should_buy ? "#22c55e" : "#ef4444";
  const diff       = r.price - r.estimated_value;
  const diffLabel  = diff > 0
    ? `🔴 $${Math.abs(diff).toFixed(0)} over market`
    : `🟢 $${Math.abs(diff).toFixed(0)} below market`;

  const greenFlags = (r.green_flags || []).map(f =>
    `<div style="padding:4px 0;font-size:12px;border-bottom:1px solid #f0fdf4">✅ ${f}</div>`).join("");
  const redFlags = (r.red_flags || []).map(f =>
    `<div style="padding:4px 0;font-size:12px;border-bottom:1px solid #fef2f2">⚠️ ${f}</div>`).join("");

  // FEATURE 5: Seller trust badge
  const trust      = r.seller_trust;
  const trustColor = trust?.trust_tier === "high"    ? "#22c55e"
                   : trust?.trust_tier === "medium"  ? "#f59e0b" : "#9ca3af";
  const trustLabel = trust?.trust_tier === "high"    ? "Trusted seller"
                   : trust?.trust_tier === "medium"  ? "Moderate history"
                   : "Limited seller info";
  const trustDetails = [
    trust?.member_since    ? `Member since ${trust.member_since}` : null,
    trust?.review_count    ? `${trust.review_count} reviews` : null,
    trust?.is_highly_rated ? `🏅 Highly rated` : null,
    trust?.response_rate   ? `${trust.response_rate}% response rate` : null,
    trust?.other_listings  ? `${trust.other_listings} other listings` : null,
  ].filter(Boolean).join(" · ");

  const sellerBlock = `
    <div style="background:#f8fafc;border-radius:6px;padding:8px;margin-bottom:8px;font-size:12px">
      <span style="font-weight:600;color:${trustColor}">👤 ${trustLabel}</span>
      ${trustDetails ? `<div style="color:#6b7280;margin-top:2px">${trustDetails}</div>` : ""}
    </div>`;

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
    <!-- Header -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span style="font-weight:700">🛒 Deal Scout</span>
      <button id="dealscout-close" style="background:none;border:none;cursor:pointer;font-size:16px;color:#9ca3af">✕</button>
    </div>

    <!-- Score -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div style="font-size:30px;font-weight:800;color:${scoreColor};line-height:1">
        ${r.score}<span style="font-size:13px;color:#9ca3af;font-weight:400">/10</span>
      </div>
      <div style="background:${buyBg};color:#fff;border-radius:6px;padding:5px 12px;font-weight:700;font-size:13px">
        ${r.should_buy ? "✅ BUY" : "❌ PASS"}
      </div>
    </div>

    <!-- Score bar -->
    <div style="background:#e5e7eb;border-radius:6px;height:6px;margin-bottom:8px;overflow:hidden">
      <div style="width:${r.score * 10}%;height:100%;background:${scoreColor};border-radius:6px"></div>
    </div>

    <!-- Verdict -->
    <div style="font-style:italic;font-size:12px;color:#374151;padding:8px;background:#f8fafc;
                border-radius:6px;border-left:3px solid #6366f1;margin-bottom:10px">
      ${r.verdict}
    </div>

    <!-- Price comparison -->
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

    <!-- Seller trust (Feature 5) -->
    ${sellerBlock}

    <!-- Flags -->
    ${greenFlags ? `<div style="margin-bottom:8px">${greenFlags}</div>` : ""}
    ${redFlags   ? `<div style="margin-bottom:8px">${redFlags}</div>`   : ""}

    <!-- Offer -->
    <div style="background:#f0fdf4;border-radius:8px;padding:10px;
                display:flex;justify-content:space-between;align-items:center;margin-bottom:0">
      <span style="font-weight:600;color:#15803d;font-size:13px">💬 Recommended offer</span>
      <span style="font-weight:800;font-size:20px;color:#15803d">$${r.recommended_offer.toFixed(0)}</span>
    </div>

    <!-- Message templates (Feature 1) -->
    ${renderMessageTemplates(r)}

    <!-- Price history (Feature 3) -->
    ${renderPriceHistory(r.priceHistory || [])}

    <!-- Affiliate links -->
    ${affiliateLinks}

    <div style="margin-top:8px;font-size:10px;color:#d1d5db;text-align:center">
      Powered by Claude AI · eBay market data
    </div>
  </div>`;
}
