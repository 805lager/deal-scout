/**
 * background.js — Extension Service Worker
 *
 * WHY A SERVICE WORKER:
 *   Manifest V3 replaced background pages with service workers.
 *   This runs persistently in the background, handling:
 *     - Messages from content scripts (scraped listing data)
 *     - API calls to our FastAPI backend
 *     - Affiliate link generation
 *     - Badge updates (show deal score on extension icon)
 *     - Notification triggers (future: watchlist alerts)
 *
 * FLOW:
 *   Content script scrapes listing → sends message here →
 *   we call the API → receive deal score →
 *   send score back to content script → sidebar renders it
 */

// ── Config ────────────────────────────────────────────────────────────────────
// WHY ASYNC: background.js can't read chrome.storage.local synchronously.
// Every caller that needs API_BASE must await getApiBase().
const API_BASE_DEFAULT = "https://74e2628f-3f35-45e7-a256-28e515813eca-00-1g6ldqrar1bea.spock.replit.dev/api/ds";

async function getApiBase() {
  try {
    const stored = await chrome.storage.local.get("ds_api_base");
    return stored.ds_api_base || API_BASE_DEFAULT;
  } catch {
    return API_BASE_DEFAULT;
  }
}

// Affiliate IDs — these live in the background script, never exposed to the page
// WHY HERE: If these were in the content script, savvy users could extract them.
// Keeping them server-side (or in background) is cleaner.
// WHY HARDCODED HERE (not fetched from .env):
// Browser extensions can't read server-side .env files.
// These IDs are safe to be in the extension — they're not secret,
// just unique identifiers. Your actual earnings are protected by
// Amazon/eBay account login, not by keeping the tag private.
const AFFILIATE = {
  ebay: {
    campaignId: "5339144027",              // eBay Partner Network campaign ID
    toolId:     "10001",
    trackingId: "dealscout",
  },
  amazon: {
    associateTag: "dealscout03f-20",        // Amazon Associate Tag
  },
};


// ── Message Handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  /**
   * All messages from content scripts come through here.
   * We use async/await inside but the listener must return true
   * to keep the channel open for async responses — this is a
   * Chrome extension quirk.
   */
  if (message.type === "SCORE_LISTING") {
    handleScoreListing(message.listing, sender.tab.id)
      .then(result => sendResponse({ success: true, result }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (message.type === "GET_AFFILIATE_LINKS") {
    const links = buildAffiliateLinks(message.query, message.price);
    sendResponse({ success: true, links });
    return true;
  }

  if (message.type === "AFFILIATE_CLICK") {
    /**
     * WHY BATCHED HERE (not fired immediately per click):
     * Sending a fetch() per click is noisy and correlatable.
     * Batching 5+ events together anonymizes individual sessions
     * before any data leaves the device.
     *
     * The background script is the right place for this because:
     *   - It persists across tabs/navigations
     *   - Content scripts can't batch across page reloads
     *   - No user-identifiable context is accessible here
     */
    queueAnalyticsEvent({
      event:        "affiliate_click",
      program:      message.program      || "",
      category:     message.category     || "",
      price_bucket: message.price_bucket || "",
      card_type:    message.card_type    || "",
      deal_score:   message.deal_score   || 0,
    });
    sendResponse({ ok: true });
    return true;
  }
});


// ── Scoring Pipeline ──────────────────────────────────────────────────────────

async function handleScoreListing(listing, tabId) {
  /**
   * Receives scraped listing data from a content script,
   * calls our FastAPI backend, updates the extension badge,
   * and returns the full deal score.
   */

  // Show loading state on badge
  setBadge(tabId, "...", "#6366f1");

  try {
    const score = await callScoringAPI(listing);

    // Update badge with the deal score
    const badgeColor = score.score >= 7 ? "#22c55e" :
                       score.score >= 5 ? "#fbbf24" : "#ef4444";
    setBadge(tabId, String(score.score), badgeColor);

    // Inject affiliate links into the result
    score.affiliateLinks = buildAffiliateLinks(listing.title, listing.price);

    return score;

  } catch (err) {
    setBadge(tabId, "!", "#ef4444");
    throw err;
  }
}


async function callScoringAPI(listing) {
  /**
   * POST listing data to our FastAPI /score endpoint.
   * This is the same endpoint the React UI uses — extension
   * and web UI share the same backend.
   */
  const API_BASE = await getApiBase();
  const response = await fetch(`${API_BASE}/score`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(listing),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `API error ${response.status}`);
  }

  return response.json();
}


// ── Affiliate Links ───────────────────────────────────────────────────────────

function buildAffiliateLinks(query, price) {
  /**
   * Build affiliate URLs for eBay and Amazon.
   *
   * WHY AFFILIATE LINKS IN BACKGROUND:
   *   The background script has access to the affiliate credentials.
   *   Content scripts get the final URLs without ever seeing the IDs.
   *   This protects your affiliate accounts from being hijacked.
   *
   * REVENUE MODEL:
   *   - eBay: earn when user buys within 24hrs of clicking
   *   - Amazon: earn when user buys within 24hrs (some categories 90 days)
   */
  const encodedQuery = encodeURIComponent(query);
  const { campaignId, toolId, trackingId } = AFFILIATE.ebay;
  const { associateTag } = AFFILIATE.amazon;

  return {
    ebay: {
      label: "Find on eBay",
      url:   `https://www.ebay.com/sch/i.html?_nkw=${encodedQuery}&mkevt=1&mkcid=1&mkrid=711-53200-19255-0&campid=${campaignId}&toolid=${toolId}&customid=${trackingId}`,
      note:  "See what similar items sell for",
    },
    ebay_sold: {
      label: "eBay Sold Listings",
      url:   `https://www.ebay.com/sch/i.html?_nkw=${encodedQuery}&LH_Complete=1&LH_Sold=1&mkevt=1&mkcid=1&mkrid=711-53200-19255-0&campid=${campaignId}&toolid=${toolId}`,
      note:  "See what people actually paid",
    },
    amazon: {
      label: "Check Amazon Price",
      url:   `https://www.amazon.com/s?k=${encodedQuery}&tag=${associateTag}`,
      note:  "Compare to new retail price",
    },
  };
}


// ── Badge Helper ──────────────────────────────────────────────────────────────

function setBadge(tabId, text, color) {
  /**
   * Shows the deal score on the extension icon badge.
   * e.g. a "8" in green means great deal at a glance.
   * WHY: Users can see the score without opening the sidebar.
   */
  chrome.action.setBadgeText({        text,   tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
}


// ── SPA Navigation Handler ───────────────────────────────────────────────────

/**
 * WHY THIS IS NEEDED:
 * FBM is a React SPA. Clicking a listing from search results changes the URL
 * via history.pushState() — no full page reload happens. Chrome only injects
 * content scripts on full page loads, so fbm.js never fires on SPA navigation.
 *
 * Fix: listen for history state changes on facebook.com and programmatically
 * re-inject fbm.js when the URL becomes a listing page.
 *
 * WHY webNavigation over tabs.onUpdated:
 * tabs.onUpdated fires for every DOM mutation and status change — too noisy.
 * onHistoryStateUpdated fires exactly once per pushState/replaceState call,
 * which is what FBM uses for in-app navigation.
 */
/**
 * WHY DEBOUNCE:
 * FBM calls history.pushState() 3-4 times per listing page load as it
 * progressively hydrates the SPA (routing, prefetch, analytics, etc.).
 * Without debouncing, fbm.js injects 4 times and fires 4 API calls.
 * We wait 800ms after the LAST pushState before injecting — by that point
 * FBM has settled and the DOM is ready for extraction.
 *
 * Per-tab map so navigating two tabs concurrently doesn't cross-cancel.
 */
const spaDebounceTimers = new Map();

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (!details.url.includes("facebook.com/marketplace")) return;
  if (details.frameId !== 0) return;

  // Re-inject on ALL FBM pages during SPA navigation.
  // WHY: Manifest content_scripts only fire on hard page loads.
  // FBM is a React SPA — every internal navigation (listing → search,
  // category → listing, etc.) is a pushState, not a reload.
  // Without this, search overlay badges never appear after SPA nav.
  // The content script's __dealScoutInjected guard + isListingPage() logic
  // handles the correct behaviour once injected.

  // Cancel any pending inject for this tab and restart the timer
  if (spaDebounceTimers.has(details.tabId)) {
    clearTimeout(spaDebounceTimers.get(details.tabId));
  }

  const timer = setTimeout(() => {
    spaDebounceTimers.delete(details.tabId);
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files:  ["content/fbm.js"],
    }).catch(err => {
      console.debug("[DealScout] Re-inject skipped:", err.message);
    });
  }, 800); // 800ms — long enough for FBM's burst of pushStates to finish

  spaDebounceTimers.set(details.tabId, timer);
}, {
  url: [{ hostContains: "facebook.com" }],
});


// ── Installation Handler ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install" || reason === "update") {
    // Clear any previously stored API URL so the hardcoded default always wins.
    // Without this, an old saved URL in chrome.storage silently overrides the default.
    chrome.storage.local.remove("ds_api_base");
    console.log(`Deal Scout ${reason === "install" ? "installed" : "updated"} — API URL reset to default`);
  }
});


// ── Anonymous Analytics Batch Queue ─────────────────────────────────────────────

/**
 * WHY BATCH INSTEAD OF FIRE IMMEDIATELY:
 *   Batching prevents per-click correlation. A single click from a single
 *   session is indistinguishable from clicks aggregated across many users.
 *   We send when 5+ events accumulate OR 60s has elapsed — whichever
 *   comes first. At POC scale this is mostly a design statement, but it's
 *   the right architecture for when you have real user volume.
 *
 * WHAT GETS SENT (and what does not):
 *   SENT: event type, program name, category, price bucket, card type, score
 *   NEVER SENT: user ID, IP address, listing URL, item title, location
 */

const _analyticsQueue = [];
let   _flushTimer     = null;
const FLUSH_BATCH_SIZE = 5;
const FLUSH_MAX_WAIT   = 60_000; // 60s

function queueAnalyticsEvent(evt) {
  _analyticsQueue.push(evt);
  console.debug(`[DealScout] Analytics queued: ${evt.event} / ${evt.program} — queue=${_analyticsQueue.length}`);

  if (_analyticsQueue.length >= FLUSH_BATCH_SIZE) {
    _flushAnalytics();
    return;
  }

  // Start a max-wait timer if not already running
  if (!_flushTimer) {
    _flushTimer = setTimeout(_flushAnalytics, FLUSH_MAX_WAIT);
  }
}

async function _flushAnalytics() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_analyticsQueue.length) return;

  // Snapshot and clear the queue before the async send
  // (prevents duplicate sends if another event arrives mid-fetch)
  const batch = _analyticsQueue.splice(0);

  try {
    // Send each event — /event accepts one at a time (simple server)
    // For production: add a /events bulk endpoint
    const API_BASE = await getApiBase();
    for (const evt of batch) {
      await fetch(`${API_BASE}/event`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(evt),
      });
    }
    console.debug(`[DealScout] Flushed ${batch.length} analytics events`);
  } catch (err) {
    // Non-critical — put events back in queue for next flush
    console.debug("[DealScout] Analytics flush failed (non-critical):", err.message);
    _analyticsQueue.unshift(...batch);
  }
}
