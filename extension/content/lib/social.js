/**
 * social.js — Rate / Share helpers + panel resize handle.
 * v0.47.0
 *
 * Loaded into all content-script bundles AND the popup. Self-contained:
 * no chrome.* APIs are required for the rendering bits, only for the
 * resize handle's persistence (which silently no-ops if storage is
 * unavailable).
 *
 * Exposes window.DealScoutSocial.{ RATE_URL, SHARE_URL, SHARE_TEXT,
 * renderRateShareRow, attachResizer }. Idempotent.
 */
(function () {
  if (typeof window === "undefined" || window.DealScoutSocial) return;

  const RATE_URL =
    "https://chromewebstore.google.com/detail/deal-scout-%E2%80%94-ai-deal-scor/" +
    "mbkhagpggkmefaompfjkbbnbmmameapk";
  const SHARE_URL = RATE_URL;
  const SHARE_TEXT =
    "Deal Scout scores Marketplace listings against sold prices and flags scams. Free Chrome extension:";

  function _enc(s) { return encodeURIComponent(s); }

  function _openTab(url) {
    try {
      if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: url });
        return;
      }
    } catch (_) {}
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch (_) {}
  }

  const TARGETS = [
    { id: "copy", label: "Copy link" },
    { id: "x",    label: "X / Twitter",
      url: () => "https://twitter.com/intent/tweet?text=" +
                 _enc(SHARE_TEXT + " " + SHARE_URL) },
    { id: "fb",   label: "Facebook",
      url: () => "https://www.facebook.com/sharer/sharer.php?u=" + _enc(SHARE_URL) },
    { id: "rd",   label: "Reddit",
      url: () => "https://www.reddit.com/submit?url=" + _enc(SHARE_URL) +
                 "&title=" + _enc("Deal Scout — AI deal scorer") },
    { id: "li",   label: "LinkedIn",
      url: () => "https://www.linkedin.com/sharing/share-offsite/?url=" + _enc(SHARE_URL) },
  ];

  function _doShare(id, copyEl) {
    if (id === "copy") {
      try {
        navigator.clipboard.writeText(SHARE_URL).then(() => {
          if (copyEl) {
            const orig = copyEl.textContent;
            copyEl.textContent = "✓ Copied";
            setTimeout(() => { copyEl.textContent = orig; }, 1200);
          }
        }).catch(() => {});
      } catch (_) {}
      return;
    }
    if (id === "native") {
      try {
        navigator.share({ title: "Deal Scout", text: SHARE_TEXT, url: SHARE_URL })
          .catch(() => {});
      } catch (_) {}
      return;
    }
    const t = TARGETS.find((x) => x.id === id);
    if (t && t.url) _openTab(t.url());
  }

  /**
   * renderRateShareRow(container) — appends an "Enjoying Deal Scout?
   * ★ Rate / Share ▾" row. The Share button opens a small dropdown
   * with Copy / X / Facebook / Reddit / LinkedIn (+ Native share when
   * navigator.share is available).
   */
  function renderRateShareRow(container) {
    if (!container) return null;

    const wrap = document.createElement("div");
    wrap.className = "ds-rate-share";
    wrap.style.cssText =
      "margin-top:8px;padding:7px 9px;border-radius:8px;" +
      "background:rgba(124,140,248,0.06);border:1px solid rgba(124,140,248,0.16);" +
      "display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:space-between";

    const label = document.createElement("span");
    label.style.cssText = "font-size:11px;color:#cbd5e1;font-weight:600;white-space:nowrap";
    label.textContent = "Enjoying Deal Scout?";
    wrap.appendChild(label);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;align-items:center;gap:6px;position:relative";

    const rateBtn = document.createElement("button");
    rateBtn.type = "button";
    rateBtn.title = "Rate Deal Scout on the Chrome Web Store";
    rateBtn.style.cssText =
      "display:inline-flex;align-items:center;gap:4px;padding:4px 10px;" +
      "background:linear-gradient(135deg,rgba(251,191,36,0.18),rgba(245,158,11,0.14));" +
      "border:1px solid rgba(251,191,36,0.4);border-radius:6px;" +
      "color:#fbbf24;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;line-height:1";
    rateBtn.textContent = "★ Rate";
    rateBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      _openTab(RATE_URL);
    });
    actions.appendChild(rateBtn);

    const shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.title = "Share Deal Scout";
    shareBtn.style.cssText =
      "display:inline-flex;align-items:center;gap:3px;padding:4px 10px;" +
      "background:rgba(124,140,248,0.12);border:1px solid rgba(124,140,248,0.4);" +
      "border-radius:6px;color:#c7d2fe;font-size:11px;font-weight:700;" +
      "cursor:pointer;font-family:inherit;line-height:1";
    shareBtn.textContent = "Share \u25BE";
    actions.appendChild(shareBtn);

    const menu = document.createElement("div");
    menu.style.cssText =
      "position:absolute;right:0;bottom:calc(100% + 4px);min-width:160px;" +
      "background:#1e1b2e;border:1px solid rgba(255,255,255,0.12);" +
      "border-radius:8px;padding:4px;display:none;flex-direction:column;gap:1px;" +
      "box-shadow:0 4px 14px rgba(0,0,0,0.45);z-index:10";
    actions.appendChild(menu);

    function _mkItem(label, onClick) {
      const it = document.createElement("button");
      it.type = "button";
      it.style.cssText =
        "text-align:left;padding:6px 10px;background:transparent;border:0;" +
        "color:#cbd5e1;font-size:11.5px;font-family:inherit;cursor:pointer;border-radius:5px";
      it.textContent = label;
      it.addEventListener("mouseenter", () => { it.style.background = "rgba(124,140,248,0.16)"; });
      it.addEventListener("mouseleave", () => { it.style.background = "transparent"; });
      it.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        onClick(it);
        menu.style.display = "none";
      });
      return it;
    }

    for (const t of TARGETS) {
      menu.appendChild(_mkItem(t.label, (el) => _doShare(t.id, el)));
    }
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      menu.appendChild(_mkItem("Share via system\u2026", (el) => _doShare("native", el)));
    }

    function _closeMenu(e) {
      if (e && (e.target === shareBtn || menu.contains(e.target))) return;
      menu.style.display = "none";
      document.removeEventListener("click", _closeMenu, true);
    }
    shareBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const open = menu.style.display === "flex";
      if (open) {
        menu.style.display = "none";
        document.removeEventListener("click", _closeMenu, true);
      } else {
        menu.style.display = "flex";
        setTimeout(() => document.addEventListener("click", _closeMenu, true), 0);
      }
    });

    wrap.appendChild(actions);
    container.appendChild(wrap);
    return wrap;
  }

  /**
   * attachResizer(panel, storageKey) — adds a bottom-right resize grip to
   * the in-page scoring panel. Persists {w,h} under `storageKey` in
   * chrome.storage.local. Bounds: min 280×320, max 92vw × 92vh. Restored
   * sizes are clamped to current viewport bounds.
   */
  function attachResizer(panel, storageKey) {
    if (!panel || !storageKey) return;

    const _bounds = () => ({
      minW: 280, minH: 320,
      maxW: Math.floor(window.innerWidth  * 0.92),
      maxH: Math.floor(window.innerHeight * 0.92),
    });
    const _clamp = (w, h) => {
      const b = _bounds();
      return {
        w: Math.max(b.minW, Math.min(b.maxW, w)),
        h: Math.max(b.minH, Math.min(b.maxH, h)),
      };
    };

    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(storageKey, (res) => {
          const v = res && res[storageKey];
          if (!v || !v.w || !v.h) return;
          const c = _clamp(v.w, v.h);
          panel.style.width = c.w + "px";
          panel.style.maxHeight = "none";
          panel.style.height = c.h + "px";
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
      const c = _clamp(sw + (e.clientX - sx), sh + (e.clientY - sy));
      panel.style.width = c.w + "px";
      panel.style.maxHeight = "none";
      panel.style.height = c.h + "px";
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
    RATE_URL: RATE_URL,
    SHARE_URL: SHARE_URL,
    SHARE_TEXT: SHARE_TEXT,
    renderRateShareRow: renderRateShareRow,
    attachResizer: attachResizer,
  };
})();
