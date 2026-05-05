const API_BASE_DEFAULT = "https://deal-scout-805lager.replit.app/api/ds";
const EXT_VERSION = chrome.runtime.getManifest().version;

async function getApiBase() {
  try {
    const stored = await chrome.storage.local.get("ds_api_base");
    return stored.ds_api_base || API_BASE_DEFAULT;
  } catch { return API_BASE_DEFAULT; }
}

function detectPlatform(url) {
  if (!url) return null;
  if (url.includes("facebook.com/marketplace/item") || /facebook\.com\/marketplace\/[^/]+\/item\//.test(url)) return "fbm";
  if (url.includes("craigslist.org")) return "craigslist";
  if (url.includes("offerup.com/item/detail")) return "offerup";
  if (url.includes("ebay.com/itm")) return "ebay";
  return null;
}

// v0.47.2 — the idle health-check status bar (green dot above
// "Supported Platforms") was removed. The popup only surfaces a
// connection error inline when the user actively tries to score and
// the API is unreachable; otherwise the popup stays clean.
function showInlineStatus(kind, msg) {
  const el = document.getElementById("status-inline");
  if (!el) return;
  if (!msg) { el.style.display = "none"; el.textContent = ""; el.className = ""; return; }
  el.className = kind === "progress" ? "progress" : "";
  el.style.display = "block";
  el.textContent = msg;
}

async function checkAPIHealth() {
  const API_BASE = await getApiBase();
  try {
    const resp = await fetch(`${API_BASE}/health`, { headers: { "X-DS-Ext-Version": EXT_VERSION }, signal: AbortSignal.timeout(4000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await resp.json();
    // Healthy — leave the popup clean (no status bar).
  } catch (e) {
    const msg = (e.name === "TypeError" || e.message.includes("fetch"))
      ? "Can\u2019t reach Deal Scout servers \u2014 check your connection"
      : `API offline \xb7 ${e.message}`;
    showInlineStatus("error", msg);
  }
}

// ── Inline extractors run directly in the page via executeScript ──────────────
function extractCraigslist() {
  const title =
    document.querySelector("#titletextonly")?.textContent?.trim() ||
    document.querySelector(".postingtitletext")?.childNodes?.[0]?.textContent?.trim() ||
    document.title.split(" - ")[0].trim();
  const priceEl = document.querySelector(".price, [class*='price'][class*='Price']") || document.querySelector(".price");
  let priceText = priceEl?.textContent?.trim() || "";
  if (!priceText) { const m = document.body.innerText?.match(/\$\s?([0-9,]+)/); if (m) priceText = "$" + m[1]; }
  const price = parseFloat(priceText.replace(/[^0-9.]/g, "")) || 0;
  const bodyText = document.querySelector("#postingbody")?.textContent?.slice(0, 800) || "";
  const loc = document.querySelector(".mapaddress")?.textContent?.trim() || location.hostname.replace(".craigslist.org", "");
  return { title, price, raw_price_text: priceText, description: bodyText, location: loc, platform: "craigslist" };
}

function extractOfferUp() {
  const title = document.querySelector("h1")?.textContent?.trim() || document.title.split(" | ")[0].trim();
  let price = 0, priceText = "";
  for (const sel of ["[data-testid='item-price']", "[class*='price']", "[class*='Price']", "h2", "h3"]) {
    for (const el of document.querySelectorAll(sel)) {
      const m = el.textContent?.trim().match(/^\$([0-9,]+(?:\.[0-9]{2})?)$/);
      if (m) { price = parseFloat(m[1].replace(/,/g, "")); priceText = el.textContent.trim(); break; }
    }
    if (price) break;
  }
  const loc = document.querySelector("[data-testid='item-location']")?.textContent?.trim() || "";
  const desc = (() => { for (const sel of ["[data-testid='item-description']","[class*='description']","p"]) { for (const el of document.querySelectorAll(sel)) { const t = el.textContent?.trim(); if (t?.length > 30) return t.slice(0,800); } } return ""; })();
  return { title, price, raw_price_text: priceText, description: desc, location: loc, platform: "offerup" };
}

// ── Inline panel renderer injected into the page ──────────────────────────────
function renderDealPanel(r, panelId, apiBase, extVersion) {
  const existing = document.getElementById(panelId);
  if (existing) existing.remove();
  const score = r.score || 0;
  const sc = score >= 7 ? "#22c55e" : score >= 5 ? "#fbbf24" : "#ef4444";
  const esc = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  let cta = score <= 3 ? "\u26a0\ufe0f Better Options Below" : score <= 5 ? "\ud83d\udca1 You Could Do Better" : score <= 7 ? "\u2705 Solid \u2014 Confirm Price" : "\ud83d\udd25 Great Deal";

  const panel = document.createElement("div");
  panel.id = panelId;
  panel.style.cssText = "position:fixed;top:80px;right:20px;width:320px;max-height:calc(100vh - 100px);overflow-y:auto;z-index:2147483647;background:#1e1b2e;border:1px solid #3d3660;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.6);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#e0e0e0;line-height:1.5";

  var hdr = document.createElement("div");
  hdr.style.cssText = "background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0;padding:10px 12px";
  var topRow = document.createElement("div");
  topRow.style.cssText = "display:flex;justify-content:space-between;margin-bottom:6px";
  var titleSpan = document.createElement("span");
  titleSpan.style.cssText = "font-weight:700;font-size:13px;color:#7c8cf8";
  titleSpan.textContent = "\ud83d\udcca Deal Scout";
  topRow.appendChild(titleSpan);
  var closeBtn = document.createElement("button");
  closeBtn.textContent = "\u2715";
  closeBtn.style.cssText = "background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer";
  closeBtn.addEventListener("click", function() { document.getElementById(panelId).remove(); });
  topRow.appendChild(closeBtn);
  hdr.appendChild(topRow);

  var scoreRow = document.createElement("div");
  scoreRow.style.cssText = "display:flex;align-items:center;gap:10px";
  scoreRow.innerHTML = DOMPurify.sanitize('<div style="width:52px;height:52px;border-radius:50%;border:3px solid ' + sc + ';display:flex;align-items:center;justify-content:center;flex-shrink:0"><span style="font-size:22px;font-weight:900;color:' + sc + '">' + score + '</span></div><div><div style="font-size:14px;font-weight:800;color:#e2e8f0">' + esc(r.verdict||"") + '</div><div style="font-size:11px;color:#94a3b8;margin-top:2px">' + (r.should_buy===false?"\u26d4 Skip":r.should_buy?"\u2705 Worth buying":"") + '</div><div style="font-size:10px;color:#6b7280;margin-top:1px">$' + Math.round(r.price||0) + '</div></div>');
  hdr.appendChild(scoreRow);
  panel.appendChild(hdr);

  if (r.summary) {
    var sumDiv = document.createElement("div");
    sumDiv.style.cssText = "margin:10px 12px 0;font-size:12px;color:#c4b5fd;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);border-radius:8px;padding:9px 10px;line-height:1.5";
    sumDiv.textContent = r.summary;
    panel.appendChild(sumDiv);
  }

  var rows = "";
  if (r.sold_avg)  rows += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span style="color:#9ca3af;font-size:12px">Est. sold avg</span><span style="font-weight:700;font-size:14px">$' + Math.round(r.sold_avg) + '</span></div>';
  if (r.new_price) rows += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span style="color:#9ca3af;font-size:12px">New retail</span><span style="font-size:13px">$' + Math.round(r.new_price) + '</span></div>';
  rows += '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="color:#9ca3af;font-size:12px">Listed price</span><span style="font-size:13px">$' + Math.round(r.price||0) + '</span></div>';
  if (r.sold_avg && r.price) {
    var delta = r.price - r.sold_avg, pct = Math.abs(Math.round(delta/r.sold_avg*100));
    rows += '<div style="margin-top:6px;font-size:12px;font-weight:600;color:' + (delta<0?"#22c55e":"#ef4444") + '">\u25cf $' + Math.abs(Math.round(delta)) + ' ' + (delta<0?"below":"above") + ' market (' + (delta<0?"-":"+") + pct + '%)</div>';
  }
  var mktDiv = document.createElement("div");
  mktDiv.style.cssText = "background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:8px 12px";
  mktDiv.innerHTML = DOMPurify.sanitize('<div style="font-weight:600;font-size:11px;text-transform:uppercase;color:#9ca3af;margin-bottom:8px">\ud83d\udcc8 Market Comparison</div>' + rows);
  panel.appendChild(mktDiv);

  var flagsHtml = "";
  for (var i = 0; i < (r.green_flags||[]).slice(0,3).length; i++) flagsHtml += '<div style="font-size:11.5px;color:#6ee7b7;padding:2px 0">\u2713 ' + esc(r.green_flags[i]) + '</div>';
  for (var j = 0; j < (r.red_flags||[]).slice(0,3).length; j++) flagsHtml += '<div style="font-size:11.5px;color:#fca5a5;padding:2px 0">\u26a0 ' + esc(r.red_flags[j]) + '</div>';
  if (flagsHtml) {
    var fDiv = document.createElement("div");
    fDiv.style.cssText = "margin:0 12px 8px";
    fDiv.innerHTML = DOMPurify.sanitize(flagsHtml);
    panel.appendChild(fDiv);
  }

  var foot = document.createElement("div");
  foot.style.cssText = "border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;padding:10px 12px";

  if (r.score_id) {
    var fbWrap = document.createElement("div");
    fbWrap.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px";
    var fbLabel = document.createElement("div");
    fbLabel.style.cssText = "font-size:11px;color:#9ca3af";
    fbLabel.textContent = "Was this score accurate?";
    fbWrap.appendChild(fbLabel);

    var thumbsDiv = document.createElement("div");
    thumbsDiv.id = panelId + "-thumbs";
    thumbsDiv.style.cssText = "display:flex;gap:8px";

    function makeThumbBtn(emoji, label, thumbsVal) {
      var btn = document.createElement("button");
      btn.style.cssText = "display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:14px;color:#d1d5db";
      btn.innerHTML = DOMPurify.sanitize(emoji + ' <span style="font-size:11px">' + label + '</span>');
      btn.addEventListener("click", function() {
        fetch(apiBase + "/thumbs", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-DS-Ext-Version": extVersion || "" },
          body: JSON.stringify({ score_id: r.score_id, thumbs: thumbsVal }),
          signal: AbortSignal.timeout(5000)
        }).catch(function(){});
        var td = document.getElementById(panelId + "-thumbs");
        if (td) { td.textContent = ""; var sp = document.createElement("span"); sp.style.cssText = "font-size:12px;color:#6ee7b7"; sp.textContent = "\u2713 Thanks for the feedback!"; td.appendChild(sp); }
      });
      return btn;
    }
    thumbsDiv.appendChild(makeThumbBtn("\ud83d\udc4d", "Yes, accurate", 1));
    thumbsDiv.appendChild(makeThumbBtn("\ud83d\udc4e", "No, off", -1));
    fbWrap.appendChild(thumbsDiv);
    foot.appendChild(fbWrap);
  }

  var ctaDiv = document.createElement("div");
  ctaDiv.style.cssText = "text-align:center;font-size:10px;color:#374151;margin-top:" + (r.score_id ? "8" : "0") + "px";
  ctaDiv.textContent = cta;
  foot.appendChild(ctaDiv);
  panel.appendChild(foot);

  document.body.appendChild(panel);
}

// ── Score Current Listing button ──────────────────────────────────────────────
document.getElementById("score-current").addEventListener("click", async () => {
  const [tab]     = await chrome.tabs.query({ active: true, currentWindow: true });
  const platform  = detectPlatform(tab?.url);

  const setStatus = (state, msg) => {
    // v0.47.2 — uses the inline error/progress strip beneath the platform
    // grid; the idle health-check bar was removed.
    showInlineStatus(state === "error" ? "error" : "progress", msg);
  };

  if (!platform) {
    setStatus("error", "Navigate to a Craigslist, OfferUp, eBay, or FBM listing first.");
    return;
  }

  // Try RESCORE message first (works if content script is already live)
  const rescoreWorked = await new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, { type: "RESCORE" }, r => {
      resolve(!chrome.runtime.lastError && r?.ok !== false);
    });
  });
  if (rescoreWorked) { window.close(); return; }

  // Content script not responding — run self-contained extraction + API + render
  setStatus("", "Extracting listing…");

  const extractor = platform === "craigslist" ? extractCraigslist : extractOfferUp;

  let listing;
  try {
    const extracted = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractor,
    });
    listing = extracted?.[0]?.result;
  } catch (e) {
    setStatus("error", `Could not read page: ${e.message}`);
    return;
  }

  if (!listing?.price) {
    setStatus("error", "No price found — make sure you're on an individual listing page.");
    return;
  }

  setStatus("", `Scoring "${listing.title?.slice(0, 36)}…"`);

  const API_BASE = await getApiBase();
  let result;
  try {
    const resp = await fetch(`${API_BASE}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DS-Ext-Version": EXT_VERSION },
      body: JSON.stringify(listing),
      signal: AbortSignal.timeout(35000),
    });
    result = await resp.json();
  } catch (e) {
    const msg = (e.name === "TypeError" || e.message.includes("fetch"))
      ? "Can\u2019t reach Deal Scout servers \u2014 check your connection"
      : `API error: ${e.message}`;
    setStatus("error", msg);
    return;
  }

  const panelId = { craigslist: "deal-scout-cl-panel", offerup: "deal-scout-ou-panel", ebay: "deal-scout-eb-panel", fbm: "deal-scout-fbm-panel" }[platform];

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: renderDealPanel,
      args: [result, panelId, API_BASE, EXT_VERSION],
    });
  } catch (e) {
    setStatus("error", `Could not render panel: ${e.message}`);
    return;
  }

  window.close();
});


// ── Report Issue ──────────────────────────────────────────────────────────────
const modal     = document.getElementById("report-modal");
const modalForm = document.getElementById("modal-form");
const modalSent = document.getElementById("modal-sent");

document.getElementById("report-link").addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const ta = document.getElementById("report-text");
    if (tab?.url && ta.value === "") ta.value = `URL: ${tab.url}\n\nIssue: `;
  } catch {}
  modal.classList.add("open");
  document.getElementById("report-text").focus();
});

document.getElementById("modal-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

document.getElementById("modal-send").addEventListener("click", async () => {
  const text = document.getElementById("report-text").value.trim();
  if (!text) return;
  // Route through background so the request carries X-DS-Key (the popup
  // intentionally has no access to the shared key). After security
  // hardening, /report rejects unauthenticated requests with 401, so a
  // direct popup fetch would silently fail and the user would still see
  // "report sent" — masking real delivery failures. The background handler
  // returns { ok, status } we can surface if needed.
  try {
    await chrome.runtime.sendMessage({
      type: "SEND_REPORT",
      text,
      ts:   new Date().toISOString(),
    });
  } catch {}
  modalForm.style.display = "none";
  modalSent.style.display = "block";
  setTimeout(closeModal, 2000);
});

function closeModal() {
  modal.classList.remove("open");
  modalSent.style.display = "none";
  modalForm.style.display = "";
  document.getElementById("report-text").value = "";
}

// ── Auto-score toggle ────────────────────────────────────────────────────────
// v0.47.1 — the API Settings (⚙) panel and footer-hint were removed. The API
// base URL is no longer user-overridable from the popup; for advanced users
// it can still be set via chrome.storage.local.ds_api_base from devtools.
async function loadAutoScoreToggle() {
  const cb   = document.getElementById("auto-score-toggle");
  const hint = document.getElementById("auto-score-off-hint");
  const syncHint = () => { if (hint) hint.style.display = cb.checked ? "none" : ""; };
  try {
    const stored = await chrome.storage.local.get("ds_auto_score");
    cb.checked = stored.ds_auto_score !== false; // default ON
  } catch {
    cb.checked = true;
  }
  syncHint();
  cb.addEventListener("change", async () => {
    try {
      await chrome.storage.local.set({ ds_auto_score: cb.checked });
    } catch {}
    syncHint();
  });
}

loadAutoScoreToggle();
checkAPIHealth();
document.getElementById("version-label").textContent = "v" + EXT_VERSION;

// ── Saved listings (Task #69 — popup recall) ─────────────────────────
// Renders the user's saved listings (max 10) at the bottom of the
// popup. Each row links back to the original listing in a new tab.
// All storage I/O lives in extension/content/lib/saved.js, which the
// popup loads via <script src="../content/lib/saved.js"> — same file
// that powers the in-page star, so the two views can never disagree
// on storage shape.
//
// We deliberately don't poll or refresh — the popup is short-lived
// (closes the moment the user clicks a row or anywhere outside) so a
// single render at open time is the right granularity.

const PLATFORM_LABELS = {
  fbm:        "Facebook",
  craigslist: "Craigslist",
  ebay:       "eBay",
  offerup:    "OfferUp",
};

function _humanAgo(iso) {
  if (!iso) return "just now";
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return "just now";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60)    return "just now";
  if (sec < 3600)  return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  const days = Math.floor(sec / 86400);
  if (days === 1)  return "1d ago";
  if (days < 7)    return days + "d ago";
  if (days < 30)   return Math.floor(days / 7) + "w ago";
  return Math.floor(days / 30) + "mo ago";
}

function _scoreColor(score) {
  if (score >= 7) return "#22c55e";
  if (score >= 5) return "#fbbf24";
  return "#ef4444";
}

async function renderSavedListings() {
  if (!window.DealScoutSaved) return;
  const Saved   = window.DealScoutSaved;
  const listEl  = document.getElementById("saved-list");
  const emptyEl = document.getElementById("saved-empty");
  const titleEl = document.getElementById("saved-title-text");
  const noteEl  = document.getElementById("saved-sync-note");

  // Read first — getStorageMode() only knows about a policy-disabled
  // chrome.storage.sync after an actual read fails (the API can be
  // present but blocked by enterprise policy, which only surfaces
  // through chrome.runtime.lastError on .get()/.set()). Checking the
  // mode after getSaved() ensures the "Sync disabled" note appears on
  // the very first popup open in that scenario, not just on a refresh.
  const arr = await Saved.getSaved();
  if (Saved.getStorageMode() === "local") {
    noteEl.style.display = "block";
  }
  listEl.textContent = "";

  if (!arr.length) {
    emptyEl.style.display = "block";
    titleEl.textContent = "Saved listings";
    return;
  }
  emptyEl.style.display = "none";
  titleEl.textContent = "Saved listings (" + arr.length + " of " + Saved.MAX_SAVES + ")";

  for (const entry of arr) {
    const row = document.createElement("div");
    row.className = "saved-row";

    const score = Number(entry.score) || 0;
    const sc    = _scoreColor(score);
    const badge = document.createElement("div");
    badge.className = "saved-badge";
    badge.style.background = sc + "22";
    badge.style.color = sc;
    badge.textContent = String(score);
    row.appendChild(badge);

    const info = document.createElement("div");
    info.className = "saved-info";

    const title = document.createElement("div");
    title.className = "saved-row-title";
    title.textContent = entry.title || entry.url;
    info.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "saved-meta";
    const platLabel = PLATFORM_LABELS[entry.platform] || entry.platform || "—";
    const askingTxt = entry.asking ? "$" + Math.round(entry.asking) : "—";
    meta.textContent = askingTxt + " · " + platLabel + " · " + _humanAgo(entry.savedAt);
    info.appendChild(meta);

    // "↓ down $X since saved" — compares the latest `asking` (mutated
    // on each revisit per spec step 4) against the frozen save-time
    // `savedAsking`. Hidden when the price is unchanged, when the user
    // has never re-opened the listing (lastVisitedAt null), or when
    // the saved snapshot predates the savedAsking field. Up-moves are
    // intentionally suppressed — the spec only calls out price drops.
    if (entry.lastVisitedAt
        && typeof entry.savedAsking === "number"
        && entry.savedAsking > 0
        && typeof entry.asking === "number"
        && entry.asking > 0
        && entry.asking < entry.savedAsking) {
      const drop = document.createElement("div");
      drop.className = "saved-drop";
      drop.textContent = "↓ down $" + Math.round(entry.savedAsking - entry.asking) + " since saved";
      info.appendChild(drop);
    }

    row.appendChild(info);

    const removeBtn = document.createElement("button");
    removeBtn.className = "saved-remove";
    removeBtn.title = "Remove from saved listings";
    removeBtn.setAttribute("aria-label", "Remove " + (entry.title || "listing"));
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await Saved.removeSaved(entry.url);
      renderSavedListings();
    });
    row.appendChild(removeBtn);

    row.addEventListener("click", () => {
      try { chrome.tabs.create({ url: entry.url }); } catch (_) {}
    });

    listEl.appendChild(row);
  }
}

renderSavedListings();

// ── Rate / Share row (v0.47.0) ──────────────────────────────────────
try {
  const mount = document.getElementById("rate-share-mount");
  if (mount && window.DealScoutSocial && window.DealScoutSocial.renderRateShareRow) {
    window.DealScoutSocial.renderRateShareRow(mount);
  }
} catch (_) {}
