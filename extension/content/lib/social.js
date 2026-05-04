/**
 * social.js — Rate / Share helpers + per-site panel resize handle.
 * v0.47.0
 *
 * Loaded into all content-script bundles AND the popup. Self-contained:
 * no chrome.* APIs are required for the rendering bits, only for the
 * resize handle's persistence (which silently no-ops if storage is
 * unavailable).
 *
 * Exposes window.DealScoutSocial.{ STORE_URL, renderRateShareRow,
 * attachResizer }. Idempotent.
 */
(function () {
  if (typeof window === "undefined" || window.DealScoutSocial) return;

  const STORE_URL =
    "https://chromewebstore.google.com/detail/deal-scout-%E2%80%94-ai-deal-scor/" +
    "mbkhagpggkmefaompfjkbbnbmmameapk";
  const SHARE_TEXT =
    "Deal Scout — free Chrome extension that AI-scores Marketplace, Craigslist, eBay & OfferUp listings before you buy.";

  function _enc(s) { return encodeURIComponent(s); }

  function _openTab(url) {
    // popup uses chrome.tabs.create (window.open closes the popup); content
    // scripts use window.open. Try chrome.tabs first when available.
    try {
      if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: url });
        return;
      }
    } catch (_) {}
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch (_) {}
  }

  const TARGETS = [
    { id: "copy",   label: "Copy link",         icon: "🔗" },
    { id: "x",      label: "Share on X",        icon: "𝕏",
      url: () => "https://twitter.com/intent/tweet?text=" +
                 _enc(SHARE_TEXT + " " + STORE_URL) },
    { id: "fb",     label: "Share on Facebook", icon: "f",
      url: () => "https://www.facebook.com/sharer/sharer.php?u=" +
                 _enc(STORE_URL) },
    { id: "li",     label: "Share on LinkedIn", icon: "in",
      url: () => "https://www.linkedin.com/sharing/share-offsite/?url=" +
                 _enc(STORE_URL) },
    { id: "rd",     label: "Share on Reddit",   icon: "R",
      url: () => "https://www.reddit.com/submit?url=" +
                 _enc(STORE_URL) +
                 "&title=" + _enc("Deal Scout — AI deal scorer") },
  ];

  function _doShare(id, btn) {
    if (id === "copy") {
      try {
        navigator.clipboard.writeText(STORE_URL).then(() => {
          if (btn) {
            const orig = btn.textContent;
            btn.textContent = "✓";
            setTimeout(() => { btn.textContent = orig; }, 1200);
          }
        }).catch(() => {});
      } catch (_) {}
      return;
    }
    if (id === "native") {
      try {
        navigator.share({ title: "Deal Scout", text: SHARE_TEXT, url: STORE_URL })
          .catch(() => {});
      } catch (_) {}
      return;
    }
    const t = TARGETS.find((x) => x.id === id);
    if (t && t.url) _openTab(t.url());
  }

  function _mkBtn(label, icon, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;" +
      "min-width:24px;height:24px;padding:0 6px;" +
      "background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);" +
      "border-radius:6px;color:#cbd5e1;font-size:11px;font-weight:700;" +
      "cursor:pointer;font-family:inherit;line-height:1;transition:background .12s,border-color .12s";
    b.textContent = icon;
    b.addEventListener("mouseenter", () => {
      b.style.background = "rgba(124,140,248,0.15)";
      b.style.borderColor = "rgba(124,140,248,0.4)";
    });
    b.addEventListener("mouseleave", () => {
      b.style.background = "rgba(255,255,255,0.05)";
      b.style.borderColor = "rgba(255,255,255,0.12)";
    });
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      onClick(b);
    });
    return b;
  }

  /**
   * renderRateShareRow(container) — appends a one-line "Enjoying Deal Scout?
   * ★ Rate / share-icons" row. Safe to call from a content-script panel
   * footer or from popup HTML.
   */
  function renderRateShareRow(container) {
    if (!container) return null;

    const wrap = document.createElement("div");
    wrap.className = "ds-rate-share";
    wrap.style.cssText =
      "margin-top:8px;padding:7px 9px;border-radius:8px;" +
      "background:rgba(124,140,248,0.06);border:1px solid rgba(124,140,248,0.16);" +
      "display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:space-between";

    const left = document.createElement("div");
    left.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0";

    const label = document.createElement("span");
    label.style.cssText = "font-size:11px;color:#cbd5e1;font-weight:600;white-space:nowrap";
    label.textContent = "Enjoying Deal Scout?";
    left.appendChild(label);

    const rateBtn = document.createElement("button");
    rateBtn.type = "button";
    rateBtn.title = "Rate Deal Scout on the Chrome Web Store";
    rateBtn.setAttribute("aria-label", "Rate Deal Scout on the Chrome Web Store");
    rateBtn.style.cssText =
      "display:inline-flex;align-items:center;gap:4px;padding:4px 10px;" +
      "background:linear-gradient(135deg,rgba(251,191,36,0.18),rgba(245,158,11,0.14));" +
      "border:1px solid rgba(251,191,36,0.4);border-radius:6px;" +
      "color:#fbbf24;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;line-height:1";
    rateBtn.textContent = "★ Rate";
    rateBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      _openTab(STORE_URL);
    });
    left.appendChild(rateBtn);

    wrap.appendChild(left);

    const right = document.createElement("div");
    right.style.cssText = "display:flex;align-items:center;gap:4px;flex-wrap:wrap";
    for (const t of TARGETS) {
      right.appendChild(_mkBtn(t.label, t.icon, (btn) => _doShare(t.id, btn)));
    }
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      right.appendChild(_mkBtn("Share via system…", "⤴", (btn) => _doShare("native", btn)));
    }
    wrap.appendChild(right);

    container.appendChild(wrap);
    return wrap;
  }

  /**
   * attachResizer(panel, storageKey) — adds a bottom-right resize grip to
   * the in-page scoring panel and persists width/height per-site under
   * `storageKey` in chrome.storage.local. No-ops if storage isn't available.
   *
   * Caller must ensure the panel uses position:fixed (or relative) so the
   * absolute grip anchors to it.
   */
  function attachResizer(panel, storageKey) {
    if (!panel || !storageKey) return;

    // Restore saved size first.
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(storageKey, (res) => {
          const v = res && res[storageKey];
          if (!v) return;
          if (v.w) panel.style.width = v.w + "px";
          if (v.h) {
            panel.style.maxHeight = "none";
            panel.style.height = v.h + "px";
          }
        });
      }
    } catch (_) {}

    const handle = document.createElement("div");
    handle.title = "Drag to resize";
    handle.style.cssText =
      "position:absolute;right:2px;bottom:2px;width:14px;height:14px;" +
      "cursor:nwse-resize;opacity:.55;z-index:2;" +
      "background:linear-gradient(135deg,transparent 0,transparent 55%," +
      "#7c8cf8 55%,#7c8cf8 65%,transparent 65%,transparent 78%," +
      "#7c8cf8 78%,#7c8cf8 88%,transparent 88%);" +
      "border-bottom-right-radius:10px";
    panel.appendChild(handle);

    let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0;
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = panel.getBoundingClientRect();
      resizing = true;
      sx = e.clientX; sy = e.clientY;
      sw = r.width;   sh = r.height;
      document.body.style.userSelect = "none";
    });
    const onMove = (e) => {
      if (!resizing) return;
      const w = Math.max(280, Math.min(window.innerWidth  - 20, sw + (e.clientX - sx)));
      const h = Math.max(220, Math.min(window.innerHeight - 20, sh + (e.clientY - sy)));
      panel.style.width = w + "px";
      panel.style.maxHeight = "none";
      panel.style.height = h + "px";
    };
    const onUp = () => {
      if (!resizing) return;
      resizing = false;
      document.body.style.userSelect = "";
      try {
        const r = panel.getBoundingClientRect();
        const obj = {};
        obj[storageKey] = { w: Math.round(r.width), h: Math.round(r.height) };
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set(obj);
        }
      } catch (_) {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);

    // Tear down listeners (and self) when the panel is removed from the DOM.
    const _mo = new MutationObserver(() => {
      if (!document.body.contains(panel)) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        try { _mo.disconnect(); } catch (_) {}
      }
    });
    _mo.observe(document.body, { childList: true, subtree: false });
  }

  window.DealScoutSocial = {
    STORE_URL: STORE_URL,
    renderRateShareRow: renderRateShareRow,
    attachResizer: attachResizer,
  };
})();
