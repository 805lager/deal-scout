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

async function checkAPIHealth() {
  const statusEl  = document.getElementById("api-status");
  const statusTxt = document.getElementById("status-text");
  const API_BASE  = await getApiBase();
  try {
    const resp = await fetch(`${API_BASE}/health`, { headers: { "X-DS-Ext-Version": EXT_VERSION }, signal: AbortSignal.timeout(4000) });
    if (resp.ok) {
      const data = await resp.json();
      statusEl.className = "active";
      statusTxt.textContent = `Connected · Claude: ${data.anthropic_key} · eBay: ${data.ebay_key}`;
    } else { throw new Error(`HTTP ${resp.status}`); }
  } catch (e) {
    statusEl.className = "error";
    const msg = (e.name === "TypeError" || e.message.includes("fetch"))
      ? "Can\u2019t reach Deal Scout servers \u2014 check your connection"
      : `API offline \xb7 ${e.message}`;
    statusTxt.textContent = msg;
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
  scoreRow.innerHTML = '<div style="width:52px;height:52px;border-radius:50%;border:3px solid ' + sc + ';display:flex;align-items:center;justify-content:center;flex-shrink:0"><span style="font-size:22px;font-weight:900;color:' + sc + '">' + score + '</span></div><div><div style="font-size:14px;font-weight:800;color:#e2e8f0">' + esc(r.verdict||"") + '</div><div style="font-size:11px;color:#94a3b8;margin-top:2px">' + (r.should_buy===false?"\u26d4 Skip":r.should_buy?"\u2705 Worth buying":"") + '</div><div style="font-size:10px;color:#6b7280;margin-top:1px">$' + Math.round(r.price||0) + '</div></div>';
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
  mktDiv.innerHTML = '<div style="font-weight:600;font-size:11px;text-transform:uppercase;color:#9ca3af;margin-bottom:8px">\ud83d\udcc8 Market Comparison</div>' + rows;
  panel.appendChild(mktDiv);

  var flagsHtml = "";
  for (var i = 0; i < (r.green_flags||[]).slice(0,3).length; i++) flagsHtml += '<div style="font-size:11.5px;color:#6ee7b7;padding:2px 0">\u2713 ' + esc(r.green_flags[i]) + '</div>';
  for (var j = 0; j < (r.red_flags||[]).slice(0,3).length; j++) flagsHtml += '<div style="font-size:11.5px;color:#fca5a5;padding:2px 0">\u26a0 ' + esc(r.red_flags[j]) + '</div>';
  if (flagsHtml) {
    var fDiv = document.createElement("div");
    fDiv.style.cssText = "margin:0 12px 8px";
    fDiv.innerHTML = flagsHtml;
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
      btn.innerHTML = emoji + ' <span style="font-size:11px">' + label + '</span>';
      btn.addEventListener("click", function() {
        fetch(apiBase + "/thumbs", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-DS-Ext-Version": extVersion || "" },
          body: JSON.stringify({ score_id: r.score_id, thumbs: thumbsVal }),
          signal: AbortSignal.timeout(5000)
        }).catch(function(){});
        var td = document.getElementById(panelId + "-thumbs");
        if (td) { td.innerHTML = ""; var sp = document.createElement("span"); sp.style.cssText = "font-size:12px;color:#6ee7b7"; sp.textContent = "\u2713 Thanks for the feedback!"; td.appendChild(sp); }
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
  const statusEl  = document.getElementById("api-status");
  const statusTxt = document.getElementById("status-text");
  const platform  = detectPlatform(tab?.url);

  const setStatus = (state, msg) => {
    statusEl.className = state;
    statusTxt.textContent = msg;
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
  const API_BASE = await getApiBase();
  try {
    await fetch(`${API_BASE}/report`, { method: "POST", headers: { "Content-Type": "application/json", "X-DS-Ext-Version": EXT_VERSION }, body: JSON.stringify({ report: text, ts: new Date().toISOString() }), signal: AbortSignal.timeout(4000) });
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

// ── Settings ──────────────────────────────────────────────────────────────────
document.getElementById("settings-toggle").addEventListener("click", async () => {
  const panel = document.getElementById("settings-panel");
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) {
    const current = await getApiBase();
    document.getElementById("api-url-input").value = current;
  }
});

document.getElementById("settings-save").addEventListener("click", async () => {
  const url = document.getElementById("api-url-input").value.trim().replace(/\/$/, "");
  if (!url) return;
  await chrome.storage.local.set({ ds_api_base: url });
  const saved = document.getElementById("settings-saved");
  saved.style.display = "inline";
  setTimeout(() => { saved.style.display = "none"; }, 2000);
  checkAPIHealth();
});

checkAPIHealth();
document.getElementById("version-label").textContent = "v" + EXT_VERSION;
