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

  const VERSION  = chrome.runtime.getManifest().version;
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
  let API_BASE = "https://deal-scout-805lager.replit.app/api/ds";
  const DS_API_KEY = atob("MDVlZmZjMGQ2NTg2MTJiYzc5N2QwNDM0NWVhYWM4OTBfZXZpbF9zZA==").split('').reverse().join('');
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
      listing_url: location.href,
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

  // ── Raw Data Extraction ──────────────────────────────────────────────────────
  // Sends raw page text to Claude Haiku server-side for structured extraction.
  // Images still need DOM extraction (CL embeds full-size images as <img> tags).

  function extractRaw() {
    // CL images: direct <img> tags in the swipe gallery
    const imageUrls = Array.from(
      document.querySelectorAll("#imageswap img, .swipe img, [class*='slide'] img, [class*='photo'] img")
    )
      .map(img => img.src)
      .filter(s => s && s.startsWith("http") && !s.includes("icons"))
      .slice(0, 5);

    // CL posts are single-page — body.innerText is clean enough
    const rawText = (document.body.innerText || "").slice(0, 4000);

    return {
      raw_text:    rawText,
      image_urls:  imageUrls,
      platform:    PLATFORM,
      listing_url: location.href,
    };
  }

  // ── Streaming API Client ─────────────────────────────────────────────────────

  async function callStreamingAPI(rawData, abort) {
    showPanel();
    renderLoading({});

    let response;
    try {
      response = await fetch(`${API_BASE}/score/stream`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-DS-Key": DS_API_KEY, "X-DS-Ext-Version": VERSION },
        body:    JSON.stringify(rawData),
        signal:  abort.signal,
      });
    } catch (fetchErr) {
      if (abort.signal.aborted) return;
      throw new Error("Can\u2019t reach Deal Scout servers \u2014 check your connection");
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error("Too many requests \u2014 please wait a moment");
      if (response.status >= 500) throw new Error("Deal Scout servers are temporarily unavailable");
      throw new Error(err.detail || `API error ${response.status}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (abort.signal.aborted) { reader.cancel(); return; }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === "progress") {
            renderProgress(evt.label);
          } else if (evt.type === "extracted") {
            renderLoading(evt.data);
          } else if (evt.type === "score") {
            const result = evt.data;
            try {
              const afLinks = await new Promise((res) => {
                chrome.runtime.sendMessage(
                  { type: "GET_AFFILIATE_LINKS", query: result.title, price: result.price },
                  (r) => res((r?.success && r.links) ? r.links : [])
                );
              });
              if (afLinks.length) result.affiliateLinks = afLinks;
            } catch (_) {}
            renderScore(result);
            chrome.runtime.sendMessage({ type: "BADGE_UPDATE", score: result.score }).catch(() => {});
          } else if (evt.type === "error") {
            renderError(evt.message || "Scoring failed");
          }
        } catch (_) {}
      }
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function _addBarDrag(bar, closeBtn) {
    bar.style.cursor = "move";
    bar.addEventListener("mousedown", function(e) {
      if (e.target === closeBtn) return;
      var p = document.getElementById(PANEL_ID);
      if (p) {
        var rect = p.getBoundingClientRect();
        p._ds_drag = { on: true, ox: e.clientX - rect.left, oy: e.clientY - rect.top };
      }
    });
  }

  function renderLoading(listing) {
    const panel = getPanel();
    panel.textContent = "";
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:#13111f;border-bottom:1px solid #3d3660;border-radius:10px 10px 0 0";
    const titleText = (listing && listing.title) ? listing.title.slice(0, 30) : "Scoring";
    const priceText = (listing && listing.price) ? " \xb7 $" + Number(listing.price).toLocaleString() : "";
    bar.innerHTML = DOMPurify.sanitize('<span style="font-weight:700;font-size:13px;color:#7c8cf8">\ud83d\udcca ' +
      '<span style="font-size:11px;color:#e0e0e0;font-weight:600">' + escHtml(titleText) + '</span>' +
      '<span style="font-size:11px;color:#7c8cf8;font-weight:700">' + priceText + '</span></span>');
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.style.cssText = "background:none;border:none;color:#6b7280;font-size:15px;cursor:pointer;padding:1px 4px";
    closeBtn.onclick = removePanel;
    bar.appendChild(closeBtn);
    _addBarDrag(bar, closeBtn);
    panel.appendChild(bar);

    const body = document.createElement("div");
    body.style.cssText = "padding:8px 10px;display:flex;align-items:center;gap:8px;color:#6b7280;font-size:12px";
    body.innerHTML = DOMPurify.sanitize('<span style="animation:ds-spin 1s linear infinite;display:inline-block;font-size:16px">\u27f3</span>' +
      '<span id="ds-progress-label">Analyzing deal\u2026</span>');
    panel.appendChild(body);

    if (!document.getElementById("ds-spin-style")) {
      const s = document.createElement("style");
      s.id = "ds-spin-style";
      s.textContent = "@keyframes ds-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(s);
    }
  }

  function renderProgress(label) {
    const el = document.getElementById("ds-progress-label");
    if (el) el.textContent = label;
  }

  function renderError(msg) {
    const panel = getPanel();
    panel.textContent = "";
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:14px 12px";
    wrap.innerHTML = DOMPurify.sanitize('<div style="font-weight:700;font-size:15px;color:#7c8cf8;margin-bottom:10px">\ud83d\udd0d Deal Scout</div>' +
      '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;color:#fca5a5">' +
      '<div style="font-weight:600;margin-bottom:4px">\u26a0\ufe0f Scoring failed</div>' +
      '<div style="font-size:12px">' + escHtml(msg) + '</div></div>');
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.style.cssText = "margin-top:10px;width:100%;padding:6px;background:transparent;border:1px solid #3d3660;border-radius:6px;color:#9ca3af;cursor:pointer";
    closeBtn.addEventListener("click", removePanel);
    wrap.appendChild(closeBtn);
    panel.appendChild(wrap);
  }

  function renderScore(r) {
    const panel = getPanel();
    panel.textContent = "";
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
    topRow.innerHTML = DOMPurify.sanitize('<span style="font-weight:700;font-size:13px;color:#7c8cf8" title="Drag to move" style="cursor:move">📊 Deal Scout</span>');
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
    // Optional rationale row — server already truncates ≤140 chars.
    const ratHtml = r.score_rationale
      ? '<div style="font-size:11px;color:#9ca3af;margin-top:4px;line-height:1.4;font-style:italic">' + escHtml(r.score_rationale) + '</div>'
      : '';
    scoreRow.innerHTML = DOMPurify.sanitize('<div style="width:52px;height:52px;border-radius:50%;border:3px solid ' + scoreColor + ';display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
      '<span style="font-size:22px;font-weight:900;color:' + scoreColor + '">' + score + '</span></div>' +
      '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800;color:#e2e8f0">' + escHtml(verdict) + '</div>' +
      '<div style="font-size:11px;color:#94a3b8;margin-top:2px">' + (shouldBuy === false ? "⛔ Skip" : shouldBuy ? "✅ Worth buying" : "") + '</div>' +
      '<div style="font-size:10px;color:#6b7280;margin-top:1px">🏷 Craigslist · $' + (r.price || 0).toFixed(0) + '</div>' +
      ratHtml + '</div>');
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

    const _thinCompsForRows = (r.market_confidence === "low") && ((r.sold_count || 0) <= 2) && r.sold_avg;
    if (_thinCompsForRows) {
      for (const rw of rows) {
        if (/sold avg|mid-point avg|ai market avg/i.test(rw.label)) {
          rw.dim = true;
          rw.bold = false;
        }
      }
    }

    for (const row of rows) {
      const el = document.createElement("div");
      el.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)";
      const valStyle = 'font-weight:' + (row.bold ? "700" : "500") + ';font-size:' + (row.bold ? "14px" : "13px") + (row.dim ? ';color:#6b7280' : '');
      el.innerHTML = DOMPurify.sanitize('<span style="color:#9ca3af;font-size:12px">' + escHtml(row.label) + (row.note ? ' <span style="color:#6b7280;font-size:10px">' + escHtml(row.note) + "</span>" : "") + "</span>" +
        '<span style="' + valStyle + '">' + escHtml(row.value) + "</span>");
      section.appendChild(el);
    }

    if (r.sold_avg && r.price) {
      const thinComps = (r.market_confidence === "low") && ((r.sold_count || 0) <= 2);
      if (thinComps) {
        const warnEl = document.createElement("div");
        warnEl.style.cssText = "margin-top:6px;font-size:12px;font-style:italic;color:#9ca3af";
        warnEl.textContent = "○ Comps limited — comparison unreliable";
        section.appendChild(warnEl);
      } else {
        const delta = r.price - r.sold_avg;
        const pct = Math.abs(Math.round((delta / r.sold_avg) * 100));
        const isBelow = delta < 0;
        const color = isBelow ? "#22c55e" : "#ef4444";
        const deltaEl = document.createElement("div");
        deltaEl.style.cssText = "margin-top:6px;font-size:12px;font-weight:600;color:" + color;
        deltaEl.textContent = "● $" + Math.abs(delta).toFixed(0) + (isBelow ? " below" : " above") + " market (" + (isBelow ? "-" : "+") + pct + "%)";
        section.appendChild(deltaEl);
      }
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
    const hasCards = r.affiliate_cards && r.affiliate_cards.length > 0;
    const hasNew = r.new_price && r.new_price > 0;
    const trigger = r.buy_new_trigger || (hasNew && r.price / r.new_price >= 0.72);
    const score = r.score || 0;
    if (!hasCards && !trigger) return;

    const hasBetterDeal = hasCards && r.affiliate_cards.some(c => c.deal_tier === "better_deal");
    const hasSimilar = hasCards && r.affiliate_cards.some(c => c.deal_tier === "similar_price");
    const hasCompare = hasCards && r.affiliate_cards.some(c => c.deal_tier === "compare");

    if (!document.getElementById("ds-aff-glow-anim")) {
      const styleEl = document.createElement("style");
      styleEl.id = "ds-aff-glow-anim";
      styleEl.textContent = "@keyframes ds-glow-green{0%{box-shadow:0 0 4px rgba(34,197,94,0.0)}50%{box-shadow:0 0 12px rgba(34,197,94,0.35)}100%{box-shadow:0 0 4px rgba(34,197,94,0.0)}}@keyframes ds-glow-blue{0%{box-shadow:0 0 4px rgba(96,165,250,0.0)}50%{box-shadow:0 0 10px rgba(96,165,250,0.3)}100%{box-shadow:0 0 4px rgba(96,165,250,0.0)}}";
      document.head.appendChild(styleEl);
    }

    const section = document.createElement("div");
    section.style.cssText = "margin:4px 10px 12px;background:linear-gradient(160deg,rgba(99,102,241,0.12) 0%,rgba(15,23,42,0) 60%);border:1.5px solid rgba(139,92,246,0.35);border-radius:14px;padding:13px 13px 10px;position:relative;overflow:hidden";
    const glow = document.createElement("div");
    glow.style.cssText = "position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#6366f1,#a855f7,#06b6d4);border-radius:14px 14px 0 0";
    section.appendChild(glow);

    let hdrIcon, hdrText, hdrSub;
    if (hasBetterDeal)     { hdrIcon = "\uD83D\uDCA1"; hdrText = "Better Deals Found"; hdrSub = "We found lower prices available now."; }
    else if (hasSimilar)   { hdrIcon = "\u2705"; hdrText = "Available Elsewhere"; hdrSub = "Similar prices with buyer protection."; }
    else if (hasCompare)   { hdrIcon = "\uD83D\uDD0D"; hdrText = "Compare Prices"; hdrSub = "Check similar listings before buying."; }
    else if (!hasCards)    { hdrIcon = "\uD83D\uDCA1"; hdrText = "Buy New Instead?"; hdrSub = "Asking price is close to retail."; }
    else if (score <= 3)   { hdrIcon = "\u26A0\uFE0F"; hdrText = "Better Options Available"; hdrSub = "This deal is overpriced \u2014 compare below."; }
    else if (score <= 5)   { hdrIcon = "\uD83D\uDCA1"; hdrText = "Compare Before Buying"; hdrSub = "Check these alternatives first."; }
    else if (score <= 7)   { hdrIcon = "\u2705"; hdrText = "Solid Deal \u2014 Verify Price"; hdrSub = "Double-check before you commit."; }
    else                   { hdrIcon = "\uD83D\uDD25"; hdrText = "Great Deal \u2014 Compare Here"; hdrSub = "Confirm it's the best price."; }

    const hdrWrap = document.createElement("div");
    hdrWrap.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:11px;margin-top:2px";
    const hdrLeft = document.createElement("div");
    hdrLeft.innerHTML = DOMPurify.sanitize('<div style="font-size:13px;font-weight:800;color:#e2e8f0">' + hdrIcon + " " + escHtml(hdrText) + '</div><div style="font-size:11px;color:#94a3b8;margin-top:2px">' + escHtml(hdrSub) + "</div>");
    const disc = document.createElement("div");
    disc.style.cssText = "font-size:9px;color:#475569;background:rgba(71,85,105,0.18);border:1px solid rgba(71,85,105,0.3);border-radius:4px;padding:2px 6px;white-space:nowrap";
    disc.textContent = "Affiliate";
    hdrWrap.appendChild(hdrLeft); hdrWrap.appendChild(disc);
    section.appendChild(hdrWrap);

    if (trigger && hasNew) {
      const premium = r.new_price - r.price;
      const alertEl = document.createElement("div");
      alertEl.style.cssText = "display:flex;align-items:center;gap:8px;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:8px 10px;margin-bottom:10px";
      alertEl.innerHTML = DOMPurify.sanitize('<span style="font-size:15px;flex-shrink:0">\uD83C\uDFF7\uFE0F</span><div><div style="font-size:11.5px;font-weight:700;color:#6ee7b7">' + (premium > 0 ? "Only $" + premium.toFixed(0) + " more gets you:" : "Used asking \u2265 new retail:") + '</div><div style="font-size:10.5px;color:#a7f3d0;margin-top:2px">Full warranty \u2022 Easy returns \u2022 Buyer protection</div></div>');
      section.appendChild(alertEl);
    }

    if (!hasCards) { container.appendChild(section); return; }

    const COLORS = {amazon:"#f97316",ebay:"#22c55e",best_buy:"#0046be",target:"#ef4444",walmart:"#0071ce",home_depot:"#f96302",lowes:"#004990",back_market:"#16a34a",newegg:"#ff6600",rei:"#3d6b4f",sweetwater:"#e67e22",autotrader:"#e8412c",cargurus:"#00968a",carmax:"#003087",advance_auto:"#e2001a",carparts_com:"#f59e0b",wayfair:"#7b2d8b",dicks:"#1e3a5f",chewy:"#0c6bb1",camping_world:"#1a5632",rv_trader:"#2d6a4f",boat_trader:"#1e40af"};
    const ICONS = {amazon:"\uD83D\uDCE6",ebay:"\uD83C\uDFEA",best_buy:"\uD83D\uDCBB",target:"\uD83C\uDFAF",walmart:"\uD83D\uDED2",home_depot:"\uD83C\uDFE0",lowes:"\uD83D\uDD28",back_market:"\u267B\uFE0F",newegg:"\uD83D\uDCBB",rei:"\u26FA",sweetwater:"\uD83C\uDFB8",autotrader:"\uD83D\uDE97",cargurus:"\uD83D\uDD0D",carmax:"\uD83C\uDFE2",advance_auto:"\uD83D\uDD27",carparts_com:"\u2699\uFE0F",wayfair:"\uD83D\uDECB\uFE0F",dicks:"\uD83C\uDFCB\uFE0F",chewy:"\uD83D\uDC3E",camping_world:"\uD83C\uDFD5\uFE0F",rv_trader:"\uD83D\uDE90",boat_trader:"\u26F5"};
    const TRUST = {amazon:"Prime eligible \u2022 Free returns",ebay:"Money-back guarantee \u2022 Buyer protection",best_buy:"Geek Squad warranty",target:"Free drive-up pickup",walmart:"Free pickup \u2022 Easy returns",home_depot:"In-store pickup \u2022 Pro discounts",back_market:"Certified refurb \u2022 1-yr warranty",autotrader:"$50-150 lead value \u2022 Dealer-verified",cargurus:"Price drop alerts \u2022 Market analysis",carmax:"Certified inspection \u2022 5-day return",advance_auto:"Free store pickup \u2022 Free battery test",carparts_com:"Fast shipping \u2022 Easy returns",wayfair:"Free shipping on orders $35+",dicks:"Price match guarantee",chewy:"Autoship savings \u2022 Free shipping",camping_world:"Nationwide service network",rv_trader:"Largest RV marketplace",boat_trader:"Largest boat marketplace"};

    for (const [idx, card] of r.affiliate_cards.slice(0, 3).entries()) {
      const key = card.program_key || card.program || "";
      const color = COLORS[key] || "#7c8cf8";
      const icon = card.icon || ICONS[key] || "\uD83D\uDED2";
      const trust = TRUST[key] || "Trusted retailer";
      const name = card.badge_label || key;
      const tier = card.deal_tier || "compare";
      const hasItems = card.items && card.items.length > 0;
      let cardPrice = card.product_price || 0;
      if (!cardPrice && card.price_hint) { const m = String(card.price_hint).match(/([0-9,]+(?:\.[0-9]+)?)/); if (m) cardPrice = parseFloat(m[1].replace(/,/g,"")); }
      const saving = cardPrice > 0 ? r.price - cardPrice : 0;
      const tierBorder = tier === "better_deal" ? "rgba(34,197,94,0.5)" : tier === "similar_price" ? "rgba(96,165,250,0.4)" : "rgba(255,255,255,0.08)";
      const tierGlow = tier === "better_deal" ? "ds-glow-green 1.5s ease-in-out 3" : tier === "similar_price" ? "ds-glow-blue 1.5s ease-in-out 3" : "none";

      const cardEl = document.createElement("a");
      cardEl.href = card.url || "#"; cardEl.target = "_blank"; cardEl.rel = "noopener noreferrer";
      cardEl.style.cssText = "display:block;text-decoration:none;background:rgba(15,23,42,0.55);border:1.5px solid " + tierBorder + ";border-left:4px solid " + color + ";border-radius:10px;padding:11px 12px 10px;margin-bottom:8px;cursor:pointer;animation:" + tierGlow;
      cardEl.onmouseenter = function(){ this.style.background = "rgba(255,255,255,0.07)"; };
      cardEl.onmouseleave = function(){ this.style.background = "rgba(15,23,42,0.55)"; };

      if (tier === "better_deal" || tier === "similar_price" || tier === "compare") {
        const badge = document.createElement("div");
        if (tier === "better_deal") {
          badge.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;color:#22c55e;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.35);border-radius:5px;padding:2px 8px;margin-bottom:8px";
          badge.textContent = "\u2B06 Better Deal Found";
        } else if (tier === "similar_price") {
          badge.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;color:#60a5fa;background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.35);border-radius:5px;padding:2px 8px;margin-bottom:8px";
          badge.textContent = "\u2194 Similar Price \u2022 Buy with Protection";
        } else {
          badge.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:800;color:#94a3b8;background:rgba(148,163,184,0.10);border:1px solid rgba(148,163,184,0.25);border-radius:5px;padding:2px 8px;margin-bottom:8px";
          badge.textContent = "\uD83D\uDD0D Compare Prices";
        }
        cardEl.appendChild(badge);
      }

      if (hasItems) {
        for (const item of card.items.slice(0, 2)) {
          const itemRow = document.createElement("div");
          itemRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:8px;cursor:pointer";
          if (item.url) { itemRow.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); window.open(item.url, "_blank"); }); }
          if (item.image_url) {
            const thumb = document.createElement("img");
            thumb.src = item.image_url;
            thumb.style.cssText = "width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0;background:#1e293b;border:1px solid rgba(255,255,255,0.1)";
            thumb.onerror = function(){ this.style.display = "none"; };
            itemRow.appendChild(thumb);
          }
          const itemInfo = document.createElement("div");
          itemInfo.style.cssText = "flex:1;min-width:0";
          const itemTitle = document.createElement("div");
          itemTitle.style.cssText = "font-size:12px;font-weight:600;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
          itemTitle.textContent = item.title || "";
          itemInfo.appendChild(itemTitle);
          const itemMeta = document.createElement("div");
          itemMeta.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:3px";
          if (item.price > 0) { const ip = document.createElement("span"); ip.style.cssText = "font-size:14px;font-weight:900;color:#f1f5f9"; ip.textContent = "$" + item.price.toFixed(0); itemMeta.appendChild(ip); }
          if (item.condition) { const ic = document.createElement("span"); ic.style.cssText = "font-size:10px;color:#94a3b8;background:rgba(148,163,184,0.15);border-radius:4px;padding:1px 5px"; ic.textContent = item.condition; itemMeta.appendChild(ic); }
          itemInfo.appendChild(itemMeta);
          itemRow.appendChild(itemInfo);
          if (item.price > 0 && r.price > item.price) {
            const saveBadge = document.createElement("div");
            saveBadge.style.cssText = "font-size:10px;font-weight:700;color:#6ee7b7;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);border-radius:5px;padding:2px 7px;flex-shrink:0;white-space:nowrap";
            saveBadge.textContent = "$" + (r.price - item.price).toFixed(0) + " less";
            itemRow.appendChild(saveBadge);
          }
          cardEl.appendChild(itemRow);
        }
      } else {
        const topRow = document.createElement("div");
        topRow.style.cssText = "display:flex;align-items:center;gap:9px;margin-bottom:7px";
        topRow.innerHTML = DOMPurify.sanitize('<div style="width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;background:' + color + '1a;border:1.5px solid ' + color + '55">' + icon + '</div><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:800;color:' + color + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(name) + '</div><div style="font-size:10.5px;color:#64748b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(trust) + '</div></div>' + (cardPrice > 0 ? '<div style="display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0;gap:2px"><div style="font-size:18px;font-weight:900;color:#f1f5f9">$' + cardPrice.toFixed(0) + '</div>' + (saving > 2 ? '<div style="font-size:10px;font-weight:700;color:#6ee7b7;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);border-radius:5px;padding:1px 7px">$' + saving.toFixed(0) + ' less</div>' : '') + '</div>' : ''));
        cardEl.appendChild(topRow);
      }
      if (card.subtitle) { const sub = document.createElement("div"); sub.style.cssText = "font-size:11px;color:#94a3b8;margin-bottom:8px"; sub.textContent = card.subtitle; cardEl.appendChild(sub); }
      const cta = document.createElement("div");
      cta.style.cssText = "display:flex;align-items:center;justify-content:center;background:" + color + ";color:#fff;font-size:12px;font-weight:800;border-radius:7px;padding:8px 0;text-align:center";
      cta.textContent = (hasItems ? "View on " : cardPrice > 0 ? "Shop " : "Compare on ") + name + " \u2192";
      cardEl.appendChild(cta);
      cardEl.addEventListener("click", function() {
        try { chrome.runtime.sendMessage({type:"AFFILIATE_CLICK",program:key,category:r.category_detected||"",price_bucket:priceBucket(r.price),deal_score:score,position:idx+1,card_type:card.card_type||"",selection_reason:card.reason||"",commission_live:!!card.commission_live,deal_tier:tier}); } catch(e) {}
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
    section.innerHTML = DOMPurify.sanitize(
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' +
        '<span style="font-size:16px">' + cfg.shield + "</span>" +
        '<span style="font-weight:700;font-size:13px;color:' + cfg.color + '">' + cfg.label + "</span>" +
        '<span style="margin-left:auto;font-size:11px;color:#6b7280">Security</span>' +
      "</div>" +
      (sec.recommendation ? '<div style="font-size:12px;color:#d1d5db;margin-bottom:6px">' + escHtml(sec.recommendation) + "</div>" : ""));

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
        btn.innerHTML = DOMPurify.sanitize(emoji + ' <span style="font-size:11px">' + label + "</span>");
        btn.addEventListener("click", () => {
          if (val === 1) {
            fetch(API_BASE + "/thumbs", {
              method: "POST", headers: {"Content-Type": "application/json", "X-DS-Key": DS_API_KEY, "X-DS-Ext-Version": VERSION},
              body: JSON.stringify({score_id: r.score_id, thumbs: 1, reason: ""}),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {});
            thumbWrap.innerHTML = DOMPurify.sanitize('<span style="font-size:12px;color:#6ee7b7">✓ Thanks!</span>');
          } else {
            thumbWrap.textContent = "";
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
                  method: "POST", headers: {"Content-Type": "application/json", "X-DS-Key": DS_API_KEY, "X-DS-Ext-Version": VERSION},
                  body: JSON.stringify({score_id: r.score_id, thumbs: -1, reason: key}),
                  signal: AbortSignal.timeout(5000),
                }).catch(() => {});
                thumbWrap.innerHTML = DOMPurify.sanitize('<span style="font-size:12px;color:#6ee7b7">✓ Got it, thanks!</span>');
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

    // CL is a traditional multi-page site — content is loaded at page ready.
    // Brief poll for page text (max 2s) in case the browser is still parsing.
    let waited = 0;
    while ((document.body.innerText || "").length < 200 && waited < 10) {
      await new Promise(r => setTimeout(r, 200));
      waited++;
    }

    const rawData = extractRaw();
    if (!rawData.raw_text || rawData.raw_text.length < 100) {
      showPanel();
      renderError("Could not read this listing — try refreshing.");
      return;
    }

    const abort = new AbortController();
    window.__dsCLAbort = abort;

    try {
      await callStreamingAPI(rawData, abort);
    } catch (err) {
      if (abort.signal.aborted) return;
      showPanel();
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

  // ── Auto-score preference ──────────────────────────────────────────────────
  function _dsAutoScoreEnabled() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get("ds_auto_score", (result) => {
          resolve(!result || result.ds_auto_score !== false);
        });
      } catch { resolve(true); }
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  let _initiated = false;
  async function tryInit() {
    if (_initiated) return;
    if (!isListingPage()) return;
    if (!(await _dsAutoScoreEnabled())) return;
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
