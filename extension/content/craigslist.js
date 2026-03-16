/**
 * craigslist.js — Deal Scout Content Script for Craigslist
 * v1.0.4
 *
 * INJECTED INTO: *.craigslist.org  (all pages; isListingPage() filters to listings)
 * PURPOSE: Extracts listing data, scores the deal via backend API,
 *          renders a floating Deal Scout panel on the page.
 */

(function () {
  "use strict";

  const VERSION  = "1.0.4";
  const PANEL_ID = "deal-scout-cl-panel";
  const PLATFORM = "craigslist";

  // Version-keyed guard: if the extension reloads with a new VERSION, the old
  // guard key doesn't match and the new script runs on the existing page.
  const _GUARD_KEY = "__dsCLInjected_" + VERSION;
  if (window[_GUARD_KEY]) {
    return;
  }
  window[_GUARD_KEY] = true;

  // ── API Base (from chrome.storage, same as fbm.js) ─────────────────────────
  let API_BASE = "https://74e2628f-3f35-45e7-a256-28e515813eca-00-1g6ldqrar1bea.spock.replit.dev/api/ds";
  try {
    chrome.storage.local.get("ds_api_base", (r) => {
      if (r && r.ds_api_base) API_BASE = r.ds_api_base;
    });
  } catch (e) {}

  // ── Detection ──────────────────────────────────────────────────────────────
  function isListingPage() {
    // Strategy 1 (most reliable): CL item IDs are always 10 digits.
    // Match any 10-digit number in the URL path — works for ALL CL listing URL
    // formats regardless of how many category segments precede the item ID.
    const pathId = location.pathname.match(/\/\d{10}(?:\.html)?(?:\/|$)/);
    if (pathId) {
      return true;
    }

    // Strategy 2: broader URL pattern — 7+ digit ID (older CL IDs)
    const pathId7 = location.pathname.match(/\/\d{7,}(?:\.html)?(?:\/|$)/);
    if (pathId7) {
      return true;
    }

    // Strategy 3: old CL DOM — #postingbody or #titletextonly
    if (document.getElementById("postingbody") || document.getElementById("titletextonly")) {
      return true;
    }

    // Strategy 4: new CL DOM — look for any element with 'posting' in id/class
    const postingEl = document.querySelector('[id*="posting"], [class*="posting"]');
    if (postingEl) {
      return true;
    }

    return false;
  }

  // ── Extraction ─────────────────────────────────────────────────────────────
  function extractListing() {
    // ── Title ──────────────────────────────────────────────────────────────
    // document.title on a CL listing page is always "Item Title - craigslist"
    // This is the most robust source, guaranteed to work regardless of DOM structure.
    // Fall back to DOM selectors for older/newer CL layouts.
    const titleFromDocTitle = (() => {
      const t = document.title || "";
      // Remove trailing " - craigslist" or " | craigslist" etc.
      return t.replace(/[\s\-–|]+craigslist.*$/i, "").replace(/\s*-\s*$/, "").trim();
    })();
    const title =
      document.querySelector("#titletextonly")?.textContent?.trim() ||
      (() => {
        const el = document.querySelector(".postingtitletext, [class*='postingtitletext']");
        if (!el) return "";
        for (const node of el.childNodes) {
          if (node.nodeType === 3 && node.textContent.trim()) return node.textContent.trim();
        }
        return el.textContent.trim();
      })() ||
      document.querySelector('[id*="title"], [class*="posting-title"], [class*="postingtitle"]')?.textContent?.trim() ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.querySelector('meta[property="og:title"]')?.content?.trim() ||
      titleFromDocTitle;

    // ── Price ──────────────────────────────────────────────────────────────
    // CL price selectors vary by layout and version. Try in decreasing specificity.
    let priceText = "";
    const priceEl =
      document.querySelector("span.price") ||
      document.querySelector("h2.price") ||
      document.querySelector(".price") ||
      document.querySelector("[class*='price'][class*='span'], span[class*='price']") ||
      document.querySelector('meta[property="og:price:amount"]') ||
      null;

    if (priceEl) {
      // og:price:amount uses the 'content' attribute, others use textContent
      priceText = (priceEl.tagName === "META"
        ? priceEl.getAttribute("content")
        : priceEl.textContent
      )?.trim() || "";
    }

    // Fallback 1: scan visible text for the first $N pattern in a prominent position.
    if (!priceText) {
      for (const sel of ["h1, h2, h3", "span, strong, b", "[class*='price']", "body"]) {
        for (const el of document.querySelectorAll(sel)) {
          const m = (el.textContent || "").match(/\$\s?([0-9,]{2,}(?:\.[0-9]{2})?)\b/);
          if (m) { priceText = "$" + m[1]; break; }
        }
        if (priceText) break;
      }
    }

    // Fallback 2: raw innerText scan of the entire visible page.
    if (!priceText && document.body) {
      const bodyText2 = document.body.innerText || "";
      const m = bodyText2.match(/\$\s?([0-9,]{2,}(?:\.[0-9]{2})?)\b/);
      if (m) priceText = "$" + m[1];
    }

    const price = parseFloat(priceText.replace(/[^0-9.]/g, "")) || 0;

    // ── Description ────────────────────────────────────────────────────────
    const rawBodyText =
      document.querySelector("#postingbody")?.innerText ||
      document.querySelector("[id^='postingbody']")?.innerText ||
      document.querySelector("section.postinginfos + section, article, [class*='posting-body']")?.innerText ||
      "";
    // CL injects "QR Code Link to This Post" into every listing's body element.
    // Strip it (and similar CL UI noise) so the security AI doesn't flag it as suspicious.
    const description = rawBodyText
      .replace(/QR\s*Code\s*Link\s*to\s*This\s*Post/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .slice(0, 800)
      .trim();

    const condition = detectCondition(description);

    // ── Location ───────────────────────────────────────────────────────────
    const mapAddress =
      document.querySelector(".mapaddress")?.textContent?.trim() ||
      document.querySelector("[class*='mapaddress']")?.textContent?.trim() ||
      document.querySelector('[data-latitude]')?.nextSibling?.textContent?.trim() ||
      "";
    // Subdomain city — "sandiego.craigslist.org" → "Sandiego" → usable as fallback
    const hostname = location.hostname;
    const subdomain = hostname.replace(/\.craigslist\.org$/, "");
    const cityFromSubdomain = (subdomain && subdomain !== "www" && subdomain !== "craigslist")
      ? subdomain.replace(/\b\w/g, c => c.toUpperCase())
      : "";
    const location_ = mapAddress || cityFromSubdomain;

    // ── Images ─────────────────────────────────────────────────────────────
    const images = [];
    const _addImg = src => {
      if (!src || images.includes(src)) return;
      // Normalise thumbnail URLs to a large format
      const large = src.replace(/\/[0-9]+x[0-9]+\.jpg/, "/600x450.jpg")
                       .replace(/_\d+x\d+\.jpg/, "_600x450.jpg");
      if (!images.includes(large)) images.push(large);
    };

    // Old CL: #thumbs anchor tags
    document.querySelectorAll("#thumbs a").forEach(a => _addImg(a.href));
    // Old CL: swipe gallery images
    document.querySelectorAll(".swipe-wrap img, .slide img").forEach(img => _addImg(img.src));
    // New CL: img tags whose src contains craigslist.org/images
    if (!images.length) {
      document.querySelectorAll("img[src*='craigslist.org/images'], img[src*='images.craigslist.org']")
        .forEach(img => _addImg(img.src));
    }
    // Absolute last resort: any large image on the page
    if (!images.length) {
      document.querySelectorAll("img").forEach(img => {
        if ((img.naturalWidth || img.clientWidth || 0) >= 200) _addImg(img.src);
      });
    }

    const result = {
      title,
      price,
      raw_price_text: priceText,
      description,
      condition,
      location: location_,
      image_urls: images.slice(0, 5),
      platform: PLATFORM,
    };
    return result;
  }

  function detectCondition(text) {
    const t = text.toLowerCase();
    if (/like[\s-]new|likenew|brand[\s-]new|mint\s+condition/i.test(t)) return "Like New";
    if (/excellent\s+condition|great\s+condition/i.test(t)) return "Good";
    if (/good\s+condition/i.test(t)) return "Good";
    if (/fair\s+condition|as[\s-]is|for\s+parts|needs\s+repair/i.test(t)) return "Fair";
    if (/new\b/i.test(t)) return "New";
    return "Used";
  }

  // ── Panel Management ───────────────────────────────────────────────────────
  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function showPanel() {
    removePanel();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = [
      "position:fixed", "top:80px", "right:20px", "width:320px",
      "max-height:calc(100vh - 100px)", "overflow-y:auto",
      "z-index:2147483647",
      "background:#1e1b2e", "border:1px solid #3d3660", "border-radius:10px",
      "box-shadow:0 8px 32px rgba(0,0,0,0.6)",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "font-size:13px", "color:#e0e0e0", "line-height:1.5",
    ].join(";");
    panel._ds_drag = { on: false, ox: 0, oy: 0 };
    const onMove = (e) => {
      if (!panel._ds_drag.on) return;
      const x = Math.max(0, Math.min(e.clientX - panel._ds_drag.ox, window.innerWidth - panel.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - panel._ds_drag.oy, window.innerHeight - panel.offsetHeight));
      panel.style.right = "auto"; panel.style.left = x + "px"; panel.style.top = y + "px";
    };
    const onUp = () => { panel._ds_drag.on = false; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.appendChild(panel);
    return panel;
  }

  function getPanel() { return document.getElementById(PANEL_ID) || showPanel(); }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function priceBucket(p) {
    if (!p) return "0";
    if (p < 50)   return "0-50";
    if (p < 200)  return "50-200";
    if (p < 500)  return "200-500";
    if (p < 1000) return "500-1000";
    return "1000+";
  }

  // ── Direct API Call ────────────────────────────────────────────────────────
  // Call the scoring API directly from the content script (same approach as fbm.js).
  // This bypasses the MV3 service worker, which Chrome can terminate mid-request
  // (30-second idle window), causing the background-routed SCORE_LISTING message
  // to silently disappear and never resolve.
  async function callScoringAPIDirect(listing, signal) {
    const response = await fetch(`${API_BASE}/score`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(listing),
      signal,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `API error ${response.status}`);
    }
    return response.json();
  }

  // Fetch affiliate links via background (it owns the affiliate IDs).
  // Non-critical — panel renders without them if this fails.
  async function fetchAffiliateLinks(title, price) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "GET_AFFILIATE_LINKS", query: title, price },
          (r) => {
            if (chrome.runtime.lastError || !r?.success) { resolve([]); return; }
            resolve(r.links || []);
          }
        );
      } catch (_) { resolve([]); }
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function renderLoading(listing) {
    const panel = getPanel();
    panel.innerHTML = "";
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0";
    bar.innerHTML = '<span style="font-weight:700;font-size:13px;color:#7c8cf8">📊 Deal Scout <span style="font-size:10px;color:#6b7280;font-weight:400">v' + VERSION + " · CL</span></span>";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px";
    closeBtn.onclick = removePanel;
    bar.appendChild(closeBtn);
    panel.appendChild(bar);
    const body = document.createElement("div");
    body.style.cssText = "padding:14px 12px";
    body.innerHTML = '<div style="font-size:12px;color:#9ca3af;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      escHtml(listing?.title || "") + "</div>" +
      '<div style="text-align:center;padding:20px;color:#6b7280">' +
      '<div style="font-size:24px;animation:ds-spin 1s linear infinite;display:inline-block">⟳</div>' +
      '<div style="font-size:12px;margin-top:8px">Analyzing deal…</div>' +
      '<div style="font-size:11px;margin-top:4px;color:#4b5563">eBay comps · AI scoring · Craigslist avg</div></div>';
    panel.appendChild(body);
    if (!document.getElementById("ds-spin-style")) {
      const s = document.createElement("style");
      s.id = "ds-spin-style";
      s.textContent = "@keyframes ds-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(s);
    }
  }

  function renderError(msg) {
    const panel = getPanel();
    panel.innerHTML = '<div style="padding:14px 12px">' +
      '<div style="font-weight:700;font-size:15px;color:#7c8cf8;margin-bottom:10px">🔍 Deal Scout</div>' +
      '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;color:#fca5a5">' +
      '<div style="font-weight:600;margin-bottom:4px">⚠️ Scoring failed</div>' +
      '<div style="font-size:12px">' + escHtml(msg) + '</div></div>' +
      '<button onclick="this.closest(\'#' + PANEL_ID + '\')?.remove()" style="margin-top:10px;width:100%;padding:6px;background:transparent;border:1px solid #3d3660;border-radius:6px;color:#9ca3af;cursor:pointer">Close</button>' +
      "</div>";
  }

  function renderScore(r) {
    const panel = getPanel();
    panel.innerHTML = "";
    renderHeader(r, panel);
    renderSummary(r, panel);
    renderMarketData(r, panel);
    renderBuyNewSection(r, panel);
    renderFlags(r, panel);
    renderSecurityScore(r, panel);
    renderBundleBreakdown(r, panel);
    renderNegotiationMessage(r, panel);
    renderFooter(r, panel);
  }

  function renderHeader(r, container) {
    const score = r.score || 0;
    const scoreColor = score >= 7 ? "#22c55e" : score >= 5 ? "#fbbf24" : "#ef4444";
    const verdict = r.verdict || (score >= 7 ? "Good Deal" : score >= 5 ? "Fair Deal" : "Overpriced");
    const shouldBuy = r.should_buy;

    const hdr = document.createElement("div");
    hdr.style.cssText = "background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0;padding:10px 12px";

    const topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px";
    topRow.innerHTML = '<span style="font-weight:700;font-size:13px;color:#7c8cf8" title="Drag to move" style="cursor:move">📊 Deal Scout</span>';
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px";
    closeBtn.onclick = removePanel;
    topRow.appendChild(closeBtn);
    topRow.addEventListener("mousedown", (e) => {
      if (e.target === closeBtn) return;
      const p = container.closest ? container : getPanel();
      p._ds_drag = { on: true, ox: e.clientX - p.getBoundingClientRect().left, oy: e.clientY - p.getBoundingClientRect().top };
    });
    hdr.appendChild(topRow);

    const scoreRow = document.createElement("div");
    scoreRow.style.cssText = "display:flex;align-items:center;gap:10px";
    scoreRow.innerHTML = '<div style="width:52px;height:52px;border-radius:50%;border:3px solid ' + scoreColor + ';display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
      '<span style="font-size:22px;font-weight:900;color:' + scoreColor + '">' + score + '</span></div>' +
      '<div><div style="font-size:14px;font-weight:800;color:#e2e8f0">' + escHtml(verdict) + '</div>' +
      '<div style="font-size:11px;color:#94a3b8;margin-top:2px">' + (shouldBuy === false ? "⛔ Skip" : shouldBuy ? "✅ Worth buying" : "") + '</div>' +
      '<div style="font-size:10px;color:#6b7280;margin-top:1px">🏷 Craigslist · $' + (r.price || 0).toFixed(0) + '</div></div>';
    hdr.appendChild(scoreRow);
    container.appendChild(hdr);
  }

  function renderSummary(r, container) {
    if (!r.summary && !r.value_assessment) return;
    const section = document.createElement("div");
    section.style.cssText = "padding:10px 12px 0";
    if (r.summary) {
      const s = document.createElement("div");
      s.style.cssText = "font-size:12px;color:#c4b5fd;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);border-radius:8px;padding:9px 10px;line-height:1.5";
      s.textContent = r.summary;
      section.appendChild(s);
    }
    container.appendChild(section);
  }

  function renderMarketData(r, container) {
    const section = document.createElement("div");
    section.style.cssText = "background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:8px 12px";

    const hdr = document.createElement("div");
    hdr.style.cssText = "font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#9ca3af;margin-bottom:8px";
    hdr.textContent = "📈 Market Comparison";
    section.appendChild(hdr);

    const ps = "$";
    const rows = [];
    if (r.sold_avg)   rows.push({ label: "Est. sold avg",   value: ps + r.sold_avg.toFixed(0),   bold: true });
    if (r.active_avg) rows.push({ label: "Active listings", value: ps + r.active_avg.toFixed(0) });
    if (r.new_price)  rows.push({ label: "New retail",      value: ps + r.new_price.toFixed(0) });
    if (r.craigslist_asking_avg > 0) rows.push({ label: "CL asking avg", value: ps + r.craigslist_asking_avg.toFixed(0), note: "(" + (r.craigslist_count || 0) + " local)" });
    rows.push({ label: "Listed price", value: ps + (r.price || 0).toFixed(0) });

    for (const row of rows) {
      const el = document.createElement("div");
      el.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)";
      el.innerHTML = '<span style="color:#9ca3af;font-size:12px">' + escHtml(row.label) + (row.note ? ' <span style="color:#6b7280;font-size:10px">' + escHtml(row.note) + "</span>" : "") + "</span>" +
        '<span style="font-weight:' + (row.bold ? "700" : "500") + ';font-size:' + (row.bold ? "14px" : "13px") + '">' + escHtml(row.value) + "</span>";
      section.appendChild(el);
    }

    if (r.sold_avg && r.price) {
      const delta = r.price - r.sold_avg;
      const pct = Math.abs(Math.round((delta / r.sold_avg) * 100));
      const isBelow = delta < 0;
      const color = isBelow ? "#22c55e" : "#ef4444";
      const deltaEl = document.createElement("div");
      deltaEl.style.cssText = "margin-top:6px;font-size:12px;font-weight:600;color:" + color;
      deltaEl.textContent = "● $" + Math.abs(delta).toFixed(0) + (isBelow ? " below" : " above") + " market (" + (isBelow ? "-" : "+") + pct + "%)";
      section.appendChild(deltaEl);
    }
    if (r.ai_notes) {
      const n = document.createElement("div");
      n.style.cssText = "font-size:11px;color:#9ca3af;font-style:italic;margin-top:6px";
      n.textContent = r.ai_notes;
      section.appendChild(n);
    }
    container.appendChild(section);
  }

  function renderFlags(r, container) {
    const red = r.red_flags || [];
    const green = r.green_flags || [];
    if (!red.length && !green.length) return;
    const section = document.createElement("div");
    section.style.cssText = "margin:0 12px 8px";
    for (const f of green.slice(0, 3)) {
      const el = document.createElement("div");
      el.style.cssText = "font-size:11.5px;color:#6ee7b7;padding:2px 0";
      el.textContent = "✓ " + f;
      section.appendChild(el);
    }
    for (const f of red.slice(0, 3)) {
      const el = document.createElement("div");
      el.style.cssText = "font-size:11.5px;color:#fca5a5;padding:2px 0";
      el.textContent = "⚠ " + f;
      section.appendChild(el);
    }
    container.appendChild(section);
  }

  function renderBuyNewSection(r, container) {
    const ps = "$";
    const hasCards = r.affiliate_cards && r.affiliate_cards.length > 0;
    const hasNew = r.new_price && r.new_price > 0;
    const ratio = hasNew ? r.price / r.new_price : 0;
    const trigger = r.buy_new_trigger || ratio >= 0.72;
    const score = r.score || 0;
    if (!hasCards && !trigger) return;

    const section = document.createElement("div");
    section.style.cssText = [
      "margin:4px 10px 12px",
      "background:linear-gradient(160deg,rgba(99,102,241,0.12) 0%,rgba(15,23,42,0) 60%)",
      "border:1.5px solid rgba(139,92,246,0.35)", "border-radius:14px",
      "padding:13px 13px 10px", "position:relative", "overflow:hidden",
    ].join(";");

    const glow = document.createElement("div");
    glow.style.cssText = "position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#6366f1,#a855f7,#06b6d4);border-radius:14px 14px 0 0";
    section.appendChild(glow);

    let hdrIcon, hdrText, hdrSub;
    if (!hasCards)    { hdrIcon = "💡"; hdrText = "Buy New Instead?"; hdrSub = "Asking price is close to retail."; }
    else if (score <= 3) { hdrIcon = "⚠️"; hdrText = "Better Options Below"; hdrSub = "This deal is overpriced. Skip it."; }
    else if (score <= 5) { hdrIcon = "💡"; hdrText = "You Could Do Better"; hdrSub = "Check these alternatives first."; }
    else if (score <= 7) { hdrIcon = "✅"; hdrText = "Solid Deal — Confirm Price"; hdrSub = "Double-check before you commit."; }
    else              { hdrIcon = "🔥"; hdrText = "Great Deal — Verify Here"; hdrSub = "Compare to make sure it's the best."; }

    const hdrWrap = document.createElement("div");
    hdrWrap.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:11px;margin-top:2px";
    const hdrLeft = document.createElement("div");
    hdrLeft.innerHTML = '<div style="font-size:13px;font-weight:800;color:#e2e8f0">' + hdrIcon + " " + escHtml(hdrText) + "</div>" +
      '<div style="font-size:11px;color:#94a3b8;margin-top:2px">' + escHtml(hdrSub) + "</div>";
    const disc = document.createElement("div");
    disc.style.cssText = "font-size:9px;color:#475569;background:rgba(71,85,105,0.18);border:1px solid rgba(71,85,105,0.3);border-radius:4px;padding:2px 6px;white-space:nowrap";
    disc.textContent = "Affiliate";
    hdrWrap.appendChild(hdrLeft);
    hdrWrap.appendChild(disc);
    section.appendChild(hdrWrap);

    if (trigger && hasNew) {
      const premium = r.new_price - r.price;
      const alertEl = document.createElement("div");
      alertEl.style.cssText = "display:flex;align-items:center;gap:8px;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:8px 10px;margin-bottom:10px";
      alertEl.innerHTML = '<span style="font-size:15px;flex-shrink:0">🏷️</span>' +
        '<div><div style="font-size:11.5px;font-weight:700;color:#6ee7b7">' +
        (premium > 0 ? "Only $" + premium.toFixed(0) + " more gets you:" : "Used asking ≥ new retail:") + "</div>" +
        '<div style="font-size:10.5px;color:#a7f3d0;margin-top:2px">Full warranty • Easy returns • Buyer protection</div></div>';
      section.appendChild(alertEl);
    }

    if (!hasCards) { container.appendChild(section); return; }

    const COLORS = { amazon:"#f97316",ebay:"#22c55e",best_buy:"#0046be",target:"#ef4444",walmart:"#0071ce",home_depot:"#f96302",lowes:"#004990",back_market:"#16a34a",newegg:"#ff6600",rei:"#3d6b4f",sweetwater:"#e67e22",autotrader:"#e8412c",cargurus:"#00968a",carmax:"#003087",advance_auto:"#e2001a",carparts_com:"#f59e0b" };
    const ICONS  = { amazon:"📦",ebay:"🏪",best_buy:"💻",target:"🎯",walmart:"🛒",home_depot:"🏠",lowes:"🔨",back_market:"♻️",newegg:"💻",rei:"⛺",sweetwater:"🎸",autotrader:"🚗",cargurus:"🔍",carmax:"🏢",advance_auto:"🔧",carparts_com:"⚙️" };
    const TRUST  = { amazon:"Prime eligible • Free returns",ebay:"Money-back guarantee • Buyer protection",best_buy:"Geek Squad warranty",target:"Free drive-up pickup",walmart:"Free pickup • Easy returns",home_depot:"In-store pickup • Pro discounts",back_market:"Certified refurb • 1-yr warranty",autotrader:"$50-150 lead value • Dealer-verified",cargurus:"Price drop alerts • Market analysis",carmax:"Certified inspection • 5-day return",advance_auto:"Free store pickup • Free battery test",carparts_com:"Fast shipping • Easy returns" };

    for (const [idx, card] of r.affiliate_cards.slice(0, 3).entries()) {
      const key   = card.program_key || card.program || "";
      const color = COLORS[key] || "#7c8cf8";
      const icon  = card.icon || ICONS[key] || "🛒";
      const trust = TRUST[key] || "Trusted retailer";
      const name  = card.badge_label || key;
      let cardPrice = 0;
      if (card.price_hint) { const m = String(card.price_hint).match(/([0-9,]+(?:\.[0-9]+)?)/); if (m) cardPrice = parseFloat(m[1].replace(/,/g,"")); }
      else if (card.price) cardPrice = parseFloat(card.price) || 0;
      const saving = cardPrice > 0 ? r.price - cardPrice : 0;

      const cardEl = document.createElement("a");
      cardEl.href = card.url || "#";
      cardEl.target = "_blank";
      cardEl.rel = "noopener noreferrer";
      cardEl.style.cssText = "display:block;text-decoration:none;background:rgba(15,23,42,0.55);border:1.5px solid rgba(255,255,255,0.08);border-left:4px solid " + color + ";border-radius:10px;padding:11px 12px 10px;margin-bottom:8px;cursor:pointer";
      cardEl.onmouseenter = () => { cardEl.style.background = "rgba(255,255,255,0.07)"; };
      cardEl.onmouseleave = () => { cardEl.style.background = "rgba(15,23,42,0.55)"; };

      const topRow = document.createElement("div");
      topRow.style.cssText = "display:flex;align-items:center;gap:9px;margin-bottom:7px";
      topRow.innerHTML = '<div style="width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;background:' + color + '1a;border:1.5px solid ' + color + '55">' + icon + "</div>" +
        '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800;color:' + color + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(name) + "</div>" +
        '<div style="font-size:10.5px;color:#64748b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(trust) + "</div></div>" +
        (cardPrice > 0 ? '<div style="display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;gap:2px"><div style="font-size:18px;font-weight:900;color:#f1f5f9">$' + cardPrice.toFixed(0) + "</div>" +
        (saving > 2 ? '<div style="font-size:10px;font-weight:700;color:#6ee7b7;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);border-radius:5px;padding:1px 7px">$' + saving.toFixed(0) + " less</div>" : "") + "</div>" : "");
      cardEl.appendChild(topRow);
      if (card.subtitle) {
        const sub = document.createElement("div");
        sub.style.cssText = "font-size:11px;color:#94a3b8;margin-bottom:8px";
        sub.textContent = card.subtitle;
        cardEl.appendChild(sub);
      }
      const cta = document.createElement("div");
      cta.style.cssText = "display:flex;align-items:center;justify-content:center;background:" + color + ";color:#fff;font-size:12px;font-weight:800;border-radius:7px;padding:8px 0;text-align:center";
      cta.textContent = (cardPrice > 0 ? "Shop " : "Compare on ") + name + " →";
      cardEl.appendChild(cta);
      cardEl.addEventListener("click", () => {
        try { chrome.runtime.sendMessage({ type:"AFFILIATE_CLICK", program:key, category:r.category_detected||"", price_bucket:priceBucket(r.price), deal_score:score, position:idx+1, card_type:card.card_type||"", selection_reason:card.reason||"", commission_live:!!card.commission_live }); } catch(e) {}
      });
      section.appendChild(cardEl);
    }
    container.appendChild(section);
  }

  function renderSecurityScore(r, container) {
    const sec = r.security_score;
    if (!sec) return;
    if (sec.risk_level === "unknown" && (!sec.flags || !sec.flags.length)) return;

    const riskConfig = {
      low:      { color: "#22c55e", bg: "rgba(34,197,94,0.1)",   border: "rgba(34,197,94,0.3)",  shield: "🛡️", label: "LOW RISK" },
      medium:   { color: "#f59e0b", bg: "rgba(245,158,11,0.1)",  border: "rgba(245,158,11,0.3)", shield: "⚠️", label: "CAUTION" },
      high:     { color: "#f97316", bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.4)", shield: "⚠️", label: "HIGH RISK" },
      critical: { color: "#ef4444", bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.5)",  shield: "❌", label: "LIKELY SCAM" },
    };
    const cfg = riskConfig[sec.risk_level] || riskConfig.medium;

    const section = document.createElement("div");
    section.style.cssText = "background:" + cfg.bg + ";border:1px solid " + cfg.border + ";border-radius:10px;padding:10px 12px;margin:4px 12px 8px";
    section.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' +
        '<span style="font-size:16px">' + cfg.shield + "</span>" +
        '<span style="font-weight:700;font-size:13px;color:' + cfg.color + '">' + cfg.label + "</span>" +
        '<span style="margin-left:auto;font-size:11px;color:#6b7280">Security</span>' +
      "</div>" +
      (sec.recommendation ? '<div style="font-size:12px;color:#d1d5db;margin-bottom:6px">' + escHtml(sec.recommendation) + "</div>" : "");

    const allFlags = [...new Set([...(sec.flags || []), ...(sec.layer1_flags || [])])];
    allFlags.slice(0, 5).forEach(flag => {
      const f = document.createElement("div");
      f.style.cssText = "font-size:12px;color:" + cfg.color + ";margin-bottom:2px";
      f.textContent = "• " + flag;
      section.appendChild(f);
    });
    container.appendChild(section);
  }

  function renderNegotiationMessage(r, container) {
    const msg = (r.negotiation_message || "").trim();
    if (!msg) return;
    const section = document.createElement("div");
    section.style.cssText = "background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.22);border-radius:10px;padding:10px 12px;margin:4px 12px 8px";
    const hdr = document.createElement("div");
    hdr.style.cssText = "font-size:11px;font-weight:700;color:#22c55e;margin-bottom:6px;letter-spacing:.04em";
    hdr.textContent = "💬 NEGOTIATION MESSAGE";
    const txt = document.createElement("div");
    txt.style.cssText = "font-size:12px;color:#cbd5e1;line-height:1.55;margin-bottom:8px";
    txt.textContent = msg;
    const btn = document.createElement("button");
    btn.style.cssText = "width:100%;padding:5px 0;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.35);border-radius:7px;color:#22c55e;font-size:11px;font-weight:600;cursor:pointer;letter-spacing:.03em";
    btn.textContent = "Copy Message";
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(msg).then(() => {
        btn.textContent = "✓ Copied!";
        setTimeout(() => { btn.textContent = "Copy Message"; }, 2000);
      }).catch(() => {
        btn.textContent = "Copy failed";
        setTimeout(() => { btn.textContent = "Copy Message"; }, 2000);
      });
    });
    section.appendChild(hdr);
    section.appendChild(txt);
    section.appendChild(btn);
    container.appendChild(section);
  }

  function renderBundleBreakdown(r, container) {
    const items = Array.isArray(r.bundle_items) ? r.bundle_items : [];
    if (!items.length) return;
    const section = document.createElement("div");
    section.style.cssText = "background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:4px 12px 8px";
    const hdr = document.createElement("div");
    hdr.style.cssText = "font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:8px;letter-spacing:.04em";
    hdr.textContent = "📦 BUNDLE BREAKDOWN";
    section.appendChild(hdr);
    let total = 0;
    items.forEach(item => {
      const val = parseFloat(item.value) || 0;
      total += val;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04)";
      const name = document.createElement("span");
      name.style.color = "#cbd5e1";
      name.textContent = item.item || "";
      const price = document.createElement("span");
      price.style.cssText = "color:#7c8cf8;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0;margin-left:8px";
      price.textContent = "$" + val.toFixed(0);
      row.appendChild(name);
      row.appendChild(price);
      section.appendChild(row);
    });
    if (total > 0) {
      const totalRow = document.createElement("div");
      totalRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:5px 0 0;margin-top:2px";
      const tLabel = document.createElement("span");
      tLabel.style.cssText = "color:#94a3b8;font-weight:700";
      tLabel.textContent = "Total individual value";
      const tPrice = document.createElement("span");
      tPrice.style.cssText = "color:#22c55e;font-weight:700;font-variant-numeric:tabular-nums";
      tPrice.textContent = "$" + total.toFixed(0);
      totalRow.appendChild(tLabel);
      totalRow.appendChild(tPrice);
      section.appendChild(totalRow);
    }
    container.appendChild(section);
  }

  function renderFooter(r, container) {
    const footer = document.createElement("div");
    footer.style.cssText = "border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;padding:10px 12px";
    if (r && r.score_id) {
      const thumbSection = document.createElement("div");
      thumbSection.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px";
      const prompt = document.createElement("div");
      prompt.style.cssText = "font-size:11px;color:#9ca3af";
      prompt.textContent = "Was this score accurate?";
      const thumbWrap = document.createElement("div");
      thumbWrap.style.cssText = "display:flex;gap:8px";
      const makeThumb = (emoji, label, val) => {
        const btn = document.createElement("button");
        btn.style.cssText = "display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:14px;color:#d1d5db";
        btn.innerHTML = emoji + ' <span style="font-size:11px">' + label + "</span>";
        btn.addEventListener("click", () => {
          if (val === 1) {
            fetch(API_BASE + "/thumbs", {
              method: "POST", headers: {"Content-Type": "application/json"},
              body: JSON.stringify({score_id: r.score_id, thumbs: 1, reason: ""}),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
            thumbWrap.innerHTML = '<span style="font-size:12px;color:#6ee7b7">✓ Thanks!</span>';
          } else {
            thumbWrap.innerHTML = "";
            const reasonRow = document.createElement("div");
            reasonRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;justify-content:center;max-width:230px";
            [["Score too high","score_too_high"],["Score too low","score_too_low"],
             ["Price wrong","price_wrong"],["Wrong category","wrong_category"],["Missing info","missing_info"]
            ].forEach(([lbl, key]) => {
              const pill = document.createElement("button");
              pill.style.cssText = "font-size:10px;padding:3px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.05);color:#d1d5db;cursor:pointer";
              pill.textContent = lbl;
              pill.addEventListener("click", (e) => {
                e.stopPropagation();
                fetch(API_BASE + "/thumbs", {
                  method: "POST", headers: {"Content-Type": "application/json"},
                  body: JSON.stringify({score_id: r.score_id, thumbs: -1, reason: key}),
                  signal: AbortSignal.timeout(5000),
                }).catch(() => {});
                thumbWrap.innerHTML = '<span style="font-size:12px;color:#6ee7b7">✓ Got it, thanks!</span>';
              });
              reasonRow.appendChild(pill);
            });
            thumbWrap.appendChild(reasonRow);
          }
        });
        return btn;
      };
      thumbWrap.appendChild(makeThumb("👍", "Yes, accurate", 1));
      thumbWrap.appendChild(makeThumb("👎", "No, off", -1));
      thumbSection.appendChild(prompt);
      thumbSection.appendChild(thumbWrap);
      footer.appendChild(thumbSection);
    }
    const versionEl = document.createElement("div");
    versionEl.style.cssText = "text-align:center;font-size:10px;color:#374151;margin-top:" + (r && r.score_id ? "8px" : "0");
    versionEl.textContent = "Deal Scout v" + VERSION + " · Craigslist";
    footer.appendChild(versionEl);
    container.appendChild(footer);
  }

  // ── Auto-Score ─────────────────────────────────────────────────────────────
  async function autoScore() {
    if (!isListingPage()) return;

    // Poll up to 5 seconds (25 × 200ms) for a price to appear.
    let listing = extractListing();
    let waited  = 0;
    while (!listing.price && waited < 25) {
      await new Promise(r => setTimeout(r, 200));
      waited++;
      listing = extractListing();
    }

    showPanel();

    if (!listing.price) {
      renderError("Could not detect a price on this listing. Try refreshing or use the Score button.");
      return;
    }

    renderLoading(listing);

    const abort = new AbortController();
    window.__dsCLAbort = abort;

    try {
      const result = await callScoringAPIDirect(listing, abort.signal);
      if (abort.signal.aborted) return;

      const afLinks = await fetchAffiliateLinks(listing.title, listing.price);
      if (afLinks && afLinks.length) result.affiliateLinks = afLinks;

      try {
        const badgeColor = result.score >= 7 ? "#22c55e" : result.score >= 5 ? "#fbbf24" : "#ef4444";
        chrome.runtime.sendMessage({ type: "BADGE_UPDATE", score: result.score, color: badgeColor }).catch(() => {});
      } catch (_) {}

      renderScore(result);

    } catch (err) {
      if (abort.signal.aborted) return;
      renderError(err.message || "Scoring failed");
    } finally {
      if (window.__dsCLAbort === abort) window.__dsCLAbort = null;
    }
  }

  // ── Global trigger (called directly by popup via executeScript) ────────────
  window.__dsScoreCL = () => {
    if (window.__dsCLAbort) { window.__dsCLAbort.abort(); window.__dsCLAbort = null; }
    _initiated = false;
    removePanel();
    setTimeout(autoScore, 300);
  };

  // ── Message Listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "RESCORE") {
      window.__dsScoreCL();
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  let _initiated = false;
  function tryInit() {
    if (_initiated) return;
    if (!isListingPage()) return;
    _initiated = true;
    autoScore();
  }

  // CL is a traditional multi-page site. Run immediately at document_idle.
  tryInit();

  // Belt-and-suspenders: retry at window load if page wasn't ready yet.
  window.addEventListener("load", tryInit, { once: true });

  // Additional 2-second backup: handles edge cases where both fire too early.
  setTimeout(tryInit, 2000);

})();
