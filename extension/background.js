/**
 * background.js — Extension Service Worker (v0.31.0)
 *
 * WHY A SERVICE WORKER:
 *   Manifest V3 replaced background pages with service workers.
 *   This runs persistently in the background, handling:
 *     - Messages from content scripts (scraped listing data)
 *     - API calls to our FastAPI backend
 *     - Affiliate link generation
 *     - Badge updates (show deal score on extension icon)
 *     - Tab-level score caching (survives FBM context teardowns)
 *
 * FLOW (v0.31.0 — background-first scoring):
 *   Content script extracts listing data → sends SCORE_LISTING here →
 *   we call the API → cache result per tab → send score back →
 *   content script renders the panel.
 *
 *   On FBM context teardown + re-injection, content script sends
 *   GET_CACHED_SCORE → we return the cached result instantly →
 *   content script renders without a new API call.
 */

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE_DEFAULT = "https://deal-scout-805lager.replit.app/api/ds";
const DS_API_KEY = atob("MDVlZmZjMGQ2NTg2MTJiYzc5N2QwNDM0NWVhYWM4OTBfZXZpbF9zZA==").split('').reverse().join('');

async function getApiBase() {
  try { await chrome.storage.local.remove("ds_api_base"); } catch {}
  return API_BASE_DEFAULT;
}

async function clearApiBaseOverride() {
  try { await chrome.storage.local.remove("ds_api_base"); } catch {}
}

async function getInstallId() {
  try {
    const stored = await chrome.storage.local.get("ds_install_id");
    if (stored.ds_install_id) return stored.ds_install_id;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ ds_install_id: id });
    return id;
  } catch {
    return "unknown";
  }
}

const AFFILIATE = {
  ebay: {
    campaignId: "5339144027",
    toolId:     "10001",
    trackingId: "dealscout",
  },
  amazon: {
    associateTag: "dealscout03f-20",
  },
};


// ── Tab-Level Score Cache ───────────────────────────────────────────────────
// Map<tabId, { listingId: string, result: object }>
// Each tab stores the most recently scored listing. Cleared on new listing
// navigation or tab close. No TTL needed — cache is invalidated by new
// SCORE_LISTING messages with a different listingId.
const scoreCache = new Map();

const pendingScores = new Map();

// ── Task #103 — Shortlist attribution & session score map ─────────────────
// Map<canonical_fbm_item_url, {score, tabId, scoredAt}> — populated whenever
// /score/stream resolves for an FBM listing tab. The popup's shortlist UI
// queries this via GET_SHORTLIST_SCORES so picks the user already scored
// in this session render as "Already scored: X/10 ↗" with a tap-to-focus
// link back to that tab. Cleared per-tab on tab close; map itself has a
// soft ceiling so a long browsing session can't grow it unbounded.
const _shortlistScoreMap = new Map();
const _SHORTLIST_SCORE_MAP_MAX = 200;
// Map<tabId, {url:canonical, rank, query, openedAt}> — popped on score
// completion so we can tag analytics with shortlist attribution
// (shortlist_score_completed) and tag downstream affiliate clicks from
// that tab with selection_reason="from_shortlist".
const _shortlistPickByTabId = new Map();

function _canonicalFbmItem(url) {
  if (!url || typeof url !== "string") return "";
  const m = url.match(/\/marketplace\/(?:[^/]+\/)?item\/(\d+)/);
  return m ? `https://www.facebook.com/marketplace/item/${m[1]}` : "";
}

function _recordShortlistScore(tabId, listing, score) {
  try {
    const canon = _canonicalFbmItem(listing && listing.listing_url);
    if (!canon) return;
    if (_shortlistScoreMap.size >= _SHORTLIST_SCORE_MAP_MAX) {
      // Evict the oldest entry — Map iterates in insertion order.
      const oldest = _shortlistScoreMap.keys().next().value;
      if (oldest) _shortlistScoreMap.delete(oldest);
    }
    _shortlistScoreMap.set(canon, {
      score:    (score && typeof score.score === "number") ? score.score : 0,
      tabId,
      scoredAt: Date.now(),
    });
  } catch (_) {}
}

chrome.tabs.onRemoved.addListener((tabId) => {
  scoreCache.delete(tabId);
  pendingScores.delete(tabId);
  spaDebounceTimers.delete(tabId);
  spaLastListingId.delete(tabId);
  _shortlistPickByTabId.delete(tabId);
  // Mark map entries owned by this tab as stale by dropping the tabId;
  // we keep the score so the popup can still show "Already scored: 8"
  // but without a focus link.
  for (const [url, entry] of _shortlistScoreMap) {
    if (entry.tabId === tabId) {
      _shortlistScoreMap.set(url, { ...entry, tabId: null });
    }
  }
});


// ── Message Handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SCORE_LISTING") {
    const tabId = sender.tab.id;
    const listingId = message.listingId || '';

    if (listingId) {
      const cached = scoreCache.get(tabId);
      if (cached && cached.listingId === listingId) {
        sendResponse({ success: true, result: cached.result, cached: true });
        return true;
      }

      const pending = pendingScores.get(tabId);
      if (pending && pending.listingId === listingId) {
        pending.promise
          .then(result => sendResponse({ success: true, result }))
          .catch(err  => sendResponse({ success: false, error: err.message }));
        return true;
      }
    }

    const scorePromise = handleScoreListing(message.listing, tabId, listingId);
    if (listingId) {
      pendingScores.set(tabId, { listingId, promise: scorePromise });
    }
    scorePromise
      .then(result => sendResponse({ success: true, result }))
      .catch(err  => sendResponse({ success: false, error: err.message }))
      .finally(() => {
        const cur = pendingScores.get(tabId);
        if (cur && cur.listingId === listingId) pendingScores.delete(tabId);
      });
    return true;
  }

  if (message.type === "GET_CACHED_SCORE") {
    const tabId = sender.tab.id;
    const listingId = message.listingId || '';
    const cached = scoreCache.get(tabId);
    if (cached && cached.listingId === listingId) {
      sendResponse({ success: true, result: cached.result, cached: true });
      return true;
    }
    const pending = pendingScores.get(tabId);
    if (pending && pending.listingId === listingId) {
      pending.promise
        .then(result => sendResponse({ success: true, result, cached: true }))
        .catch(err  => sendResponse({ success: false, error: err.message }));
      return true;
    }
    sendResponse({ success: false, error: 'no cache' });
    return true;
  }

  if (message.type === "CLEAR_SCORE_CACHE") {
    const tabId = sender.tab.id;
    scoreCache.delete(tabId);
    pendingScores.delete(tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_AFFILIATE_LINKS") {
    const links = buildAffiliateLinks(message.query, message.price);
    sendResponse({ success: true, links });
    return true;
  }

  if (message.type === "BADGE_UPDATE") {
    const color = message.score >= 7 ? "#22c55e"
                : message.score >= 5 ? "#fbbf24" : "#ef4444";
    setBadge(sender.tab.id, String(message.score), color);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "AFFILIATE_CLICK") {
    // Task #103 attribution: if this click originates from a tab that was
    // opened via a shortlist pick, tag the event so we can join shortlist →
    // score → affiliate-click funnels in analytics.
    const fromTab = sender && sender.tab && sender.tab.id;
    const pickInfo = fromTab ? _shortlistPickByTabId.get(fromTab) : null;
    queueAnalyticsEvent({
      event:            "affiliate_click",
      program:          message.program      || "",
      category:         message.category     || "",
      price_bucket:     message.price_bucket || "",
      card_type:        message.card_type    || "",
      deal_score:       message.deal_score   || 0,
      selection_reason: pickInfo ? "from_shortlist" : "",
      position:         pickInfo ? pickInfo.rank : 0,
    });
    sendResponse({ ok: true });
    return true;
  }

  // Task #103 — popup asks for any session scores tied to its current picks
  // so it can render "Already scored: X/10 ↗" badges + a tap-to-focus link.
  if (message.type === "GET_SHORTLIST_SCORES") {
    const out = {};
    const urls = Array.isArray(message.urls) ? message.urls : [];
    for (const u of urls) {
      const canon = _canonicalFbmItem(u);
      if (canon && _shortlistScoreMap.has(canon)) {
        out[u] = _shortlistScoreMap.get(canon);
      }
    }
    sendResponse({ ok: true, scores: out });
    return true;
  }

  // ── Task #103 — FBM Search Shortlist request ──────────────────────────────
  // The popup scraped a deck of visible search cards and forwards them
  // here so the API key stays in the background script (same pattern as
  // SEND_REPORT / SCORE_LISTING). We surface 200-with-empty-picks as a
  // soft error to the popup so it can render a clean empty state.
  if (message.type === "SHORTLIST_REQUEST") {
    (async () => {
      try {
        const result = await callShortlistAPI(message.listings || [], message.search_query || "");
        // Telemetry — reuse the existing /event sink. Truncate query to
        // 80 chars so we don't blow the schema's selection_reason cap.
        try {
          queueAnalyticsEvent({
            event:            "shortlist_requested",
            category:         (message.search_query || "").slice(0, 80),
            position:         (message.listings || []).length,
            deal_score:       (result.picks || []).length,
            selection_reason: result.cached ? "cache_hit" : "fresh",
          });
        } catch (_) {}
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message.type === "SHORTLIST_PICK_CLICKED") {
    try {
      queueAnalyticsEvent({
        event:            "shortlist_pick_clicked",
        category:         (message.search_query || "").slice(0, 80),
        position:         message.rank || 0,
        deal_score:       message.score || 0,
      });
    } catch (_) {}
    // Attribution: remember which tab was opened from a shortlist pick so
    // the eventual score completion + affiliate click in that tab can be
    // tagged. tabId is supplied by the popup after chrome.tabs.create
    // resolves.
    if (message.tabId && typeof message.tabId === "number") {
      _shortlistPickByTabId.set(message.tabId, {
        url:      _canonicalFbmItem(message.listing_url) || (message.listing_url || ""),
        rank:     message.rank || 0,
        query:    (message.search_query || "").slice(0, 80),
        openedAt: Date.now(),
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  // Bug-report submission proxied through background so the API key never
  // leaves this script. Popup posts the user's text via chrome.runtime
  // .sendMessage; we attach X-DS-Key from this scope and forward to /report.
  // Server now requires auth (was previously anonymous), so popup direct-
  // posting would 401 silently after the security hardening.
  if (message.type === "SEND_REPORT") {
    (async () => {
      try {
        const API_BASE   = await getApiBase();
        const extVersion = chrome.runtime.getManifest().version;
        const resp = await fetch(`${API_BASE}/report`, {
          method:  "POST",
          headers: {
            "Content-Type":     "application/json",
            "X-DS-Key":         DS_API_KEY,
            "X-DS-Ext-Version": extVersion,
          },
          body:   JSON.stringify({ report: message.text || "", ts: message.ts || new Date().toISOString() }),
          signal: AbortSignal.timeout(5000),
        });
        sendResponse({ ok: resp.ok, status: resp.status });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }
});


// ── Scoring Pipeline ──────────────────────────────────────────────────────────

async function handleScoreListing(listing, tabId, listingId) {
  setBadge(tabId, "...", "#6366f1");

  try {
    const score = await callScoringAPI(listing);

    const badgeColor = score.score >= 7 ? "#22c55e" :
                       score.score >= 5 ? "#fbbf24" : "#ef4444";
    setBadge(tabId, String(score.score), badgeColor);

    score.affiliateLinks = buildAffiliateLinks(listing.title || listing.raw_text?.slice(0, 60) || '', listing.price || 0);

    if (listingId) {
      scoreCache.set(tabId, { listingId, result: score });
    }

    // Task #103: record canonical FBM URL → score so the popup shortlist
    // can show "Already scored: X/10" on subsequent runs in the same
    // session. Cheap; no-op when listing isn't an FBM item.
    _recordShortlistScore(tabId, listing, score);

    // Attribution: if this tab was opened via a shortlist pick, emit a
    // joined event so the funnel (shortlist_requested → pick_clicked →
    // score_completed → affiliate_click) is reconstructable.
    const pickInfo = _shortlistPickByTabId.get(tabId);
    if (pickInfo) {
      try {
        queueAnalyticsEvent({
          event:            "shortlist_score_completed",
          category:         pickInfo.query,
          position:         pickInfo.rank,
          deal_score:       (score && typeof score.score === "number") ? score.score : 0,
          selection_reason: "from_shortlist",
        });
      } catch (_) {}
    }

    return score;

  } catch (err) {
    setBadge(tabId, "!", "#ef4444");
    throw err;
  }
}


async function callScoringAPI(listing, _retryCount = 0) {
  const MAX_RETRIES = 2;
  const API_BASE = await getApiBase();
  const extVersion = chrome.runtime.getManifest().version;
  const installId = await getInstallId();
  let response;
  try {
    response = await fetch(`${API_BASE}/score/stream`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-DS-Key": DS_API_KEY, "X-DS-Ext-Version": extVersion, "X-DS-Install-Id": installId },
      body:    JSON.stringify(listing),
    });
  } catch (fetchErr) {
    if (_retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, _retryCount)));
      return callScoringAPI(listing, _retryCount + 1);
    }
    throw new Error("Can\u2019t reach Deal Scout servers \u2014 check your connection");
  }

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") || "60", 10);
    if (_retryCount < 1) {
      await new Promise(r => setTimeout(r, Math.min(retryAfter, 120) * 1000));
      return callScoringAPI(listing, _retryCount + 1);
    }
    throw new Error("Too many requests \u2014 please wait a moment and try again");
  }

  if (response.status >= 500 && _retryCount < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, 2000 * Math.pow(2, _retryCount)));
    return callScoringAPI(listing, _retryCount + 1);
  }

  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && API_BASE !== API_BASE_DEFAULT && _retryCount < MAX_RETRIES) {
      await clearApiBaseOverride();
      return callScoringAPI(listing, _retryCount + 1);
    }
    const bodyText = await response.text().catch(() => "");
    const srv = response.headers.get("server") || "?";
    const ct = response.headers.get("content-type") || "?";
    const cf = response.headers.get("cf-ray") ? " cf-ray=" + response.headers.get("cf-ray") : "";
    const snippet = bodyText.slice(0, 120).replace(/\s+/g, " ");
    let detail = "";
    try { const j = JSON.parse(bodyText); detail = Array.isArray(j.detail) ? j.detail.map(d=>d.msg||d.message||JSON.stringify(d)).join("; ") : (j.detail || ""); } catch {}
    if (response.status >= 500) throw new Error("Deal Scout servers are temporarily unavailable \u2014 try again shortly");
    throw new Error(`API ${response.status} | url=${API_BASE} | server=${srv}${cf} | ct=${ct} | body=${snippet || detail || "(empty)"}`);
  }

  const text = await response.text();
  const lines = text.split('\n');
  let scoreData = null;
  let lastError = null;

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    try {
      const parsed = JSON.parse(line.slice(6));
      if (parsed.type === 'score' && parsed.data) {
        scoreData = parsed.data;
      } else if (parsed.type === 'error') {
        lastError = parsed.message || 'Scoring failed';
      }
    } catch (_e) {}
  }

  if (scoreData) return scoreData;
  throw new Error(lastError || 'No score returned from API');
}


// ── Task #103 — Shortlist API ─────────────────────────────────────────────────
// Calls POST /shortlist with the deck + user query. Mirrors callScoringAPI's
// retry shape on transient failures (network blip / 5xx), surfaces 429
// rate-limit messages verbatim, and returns the parsed JSON body on success.
async function callShortlistAPI(listings, search_query, _retryCount = 0) {
  const MAX_RETRIES = 2;
  const API_BASE   = await getApiBase();
  const extVersion = chrome.runtime.getManifest().version;
  const installId  = await getInstallId();

  let response;
  try {
    response = await fetch(`${API_BASE}/shortlist`, {
      method: "POST",
      headers: {
        "Content-Type":     "application/json",
        "X-DS-Key":         DS_API_KEY,
        "X-DS-Ext-Version": extVersion,
        "X-DS-Install-Id":  installId,
      },
      body:   JSON.stringify({ listings, search_query }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (fetchErr) {
    if (_retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 800 * Math.pow(2, _retryCount)));
      return callShortlistAPI(listings, search_query, _retryCount + 1);
    }
    throw new Error("Can\u2019t reach Deal Scout servers \u2014 check your connection");
  }

  if (response.status === 429) {
    let detail = "";
    try { detail = (await response.json()).detail || ""; } catch (_) {}
    throw new Error(detail || "Shortlist rate limit reached \u2014 try again in a few minutes.");
  }

  if (response.status >= 500 && _retryCount < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, 1500 * Math.pow(2, _retryCount)));
    return callShortlistAPI(listings, search_query, _retryCount + 1);
  }

  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && API_BASE !== API_BASE_DEFAULT && _retryCount < MAX_RETRIES) {
      await clearApiBaseOverride();
      return callShortlistAPI(listings, search_query, _retryCount + 1);
    }
    const bodyText = await response.text().catch(() => "");
    throw new Error(`Shortlist API ${response.status}: ${bodyText.slice(0, 160) || "(empty)"}`);
  }

  return await response.json();
}


// ── Affiliate Links ───────────────────────────────────────────────────────────

function buildAffiliateLinks(query, price) {
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
  chrome.action.setBadgeText({        text,   tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
}


// ── SPA Navigation Handler ───────────────────────────────────────────────────

const spaDebounceTimers = new Map();
const spaLastListingId = new Map();

function _bgListingId(href) {
  const m = String(href || '').match(/\/marketplace\/(?:[^/]+\/)?item\/(\d+)/);
  return m ? m[1] : '';
}

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (!details.url.includes("facebook.com/marketplace")) return;
  if (details.frameId !== 0) return;

  const newId  = _bgListingId(details.url);
  const lastId = spaLastListingId.get(details.tabId) || '';

  if (newId && newId === lastId) return;

  clearTimeout(spaDebounceTimers.get(details.tabId));

  spaDebounceTimers.set(details.tabId, setTimeout(() => {
    spaDebounceTimers.delete(details.tabId);
    spaLastListingId.set(details.tabId, newId);
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files:  ["content/fbm.js"],
    }).catch(err => {
      console.debug("[DealScout] Re-inject skipped:", err.message);
    });
  }, 800));
}, {
  url: [{ hostContains: "facebook.com" }],
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const newId = _bgListingId(details.url);
  if (newId) {
    spaLastListingId.set(details.tabId, newId);
  } else {
    spaLastListingId.delete(details.tabId);
    // Defense-in-depth: tell the FBM content script to clear any stale Deal
    // Scout panel even if its own pushState/popstate hook missed the event
    // (happens occasionally on cross-origin or refresh-style navigations).
    // Marketplace's left-rail search is on facebook.com but isn't a listing
    // URL, so the message is a no-op when there's no panel to remove.
    if (details.url.includes("facebook.com")) {
      try {
        chrome.tabs.sendMessage(details.tabId, { type: "CLEAR_PANEL" })
          .catch(() => {});
      } catch (_e) {}
    }
  }
  clearTimeout(spaDebounceTimers.get(details.tabId));
  spaDebounceTimers.delete(details.tabId);
}, { url: [{ hostContains: "facebook.com" }] });


// ── Installation Handler ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install" || reason === "update") {
    chrome.storage.local.remove("ds_api_base");
    console.log(`Deal Scout ${reason === "install" ? "installed" : "updated"} — API URL reset to default`);
  }
});


// ── Anonymous Analytics Batch Queue ─────────────────────────────────────────────

const _analyticsQueue = [];
let   _flushTimer     = null;
const FLUSH_BATCH_SIZE = 5;
const FLUSH_MAX_WAIT   = 60_000;

function queueAnalyticsEvent(evt) {
  _analyticsQueue.push(evt);
  console.debug(`[DealScout] Analytics queued: ${evt.event} / ${evt.program} — queue=${_analyticsQueue.length}`);

  if (_analyticsQueue.length >= FLUSH_BATCH_SIZE) {
    _flushAnalytics();
    return;
  }

  if (!_flushTimer) {
    _flushTimer = setTimeout(_flushAnalytics, FLUSH_MAX_WAIT);
  }
}

async function _flushAnalytics() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_analyticsQueue.length) return;

  const batch = _analyticsQueue.splice(0);

  try {
    const API_BASE = await getApiBase();
    const extVersion = chrome.runtime.getManifest().version;
    for (const evt of batch) {
      await fetch(`${API_BASE}/event`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-DS-Key": DS_API_KEY, "X-DS-Ext-Version": extVersion },
        body:    JSON.stringify(evt),
      });
    }
    console.debug(`[DealScout] Flushed ${batch.length} analytics events`);
  } catch (err) {
    console.debug("[DealScout] Analytics flush failed (non-critical):", err.message);
    _analyticsQueue.unshift(...batch);
  }
}
