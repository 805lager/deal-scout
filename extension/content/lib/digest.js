/**
 * Deal Scout — Score panel layout primitives (Task #68)
 *
 * Exposes window.DealScoutDigest with two helpers consumed by every
 * marketplace content script (fbm.js, craigslist.js, ebay.js, offerup.js):
 *
 *   beginDigest(panel)
 *     Appends a position:sticky wrapper to the panel and returns it. The
 *     caller writes the headline blocks (header, confidence, trust,
 *     leverage, summary) into the wrapper so they stay visible no matter
 *     how far the user scrolls the long-tail detail underneath.
 *
 *   openCollapsible(container, name, { title })
 *     Appends a click-to-toggle section. Returns { body, setSummary }.
 *     The body div is what the caller renders content into; setSummary
 *     populates the right-aligned one-liner shown on the closed row so
 *     the user can read the verdict without expanding.
 *
 * Expand / collapse state is persisted *per section name* (NOT per
 * listing) under a single ds_section_state key in chrome.storage.local —
 * a power user who always wants Market Comparison expanded only clicks
 * once across all listings on all marketplaces.
 *
 * Loaded as a content_script before each platform script in manifest.json,
 * so it runs in the same isolated world and can safely attach to window.
 * Idempotent — safe to load twice (the second call short-circuits).
 */
(function () {
  'use strict';
  if (window.DealScoutDigest) return;

  const STORAGE_KEY = 'ds_section_state';

  // chrome.storage.local is async, but render is sync. We warm an
  // in-memory mirror on first import so subsequent renders honor the
  // persisted state. The very first render (before the async get
  // resolves) falls back to the per-section default; we then reconcile
  // every still-pristine section once the cache lands so first paint
  // self-corrects without clobbering any clicks the user made meanwhile.
  // Writes go straight to chrome.storage.local and update the mirror.
  let _stateCache = null;
  let _loadingPromise = null;
  // Sections waiting on the initial load. Each entry: { name, apply,
  // dirty }. `dirty` flips to true the moment the user clicks the head
  // so we never overwrite a deliberate toggle.
  const _pendingSections = [];

  function _loadState() {
    if (_stateCache) return Promise.resolve(_stateCache);
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = new Promise((resolve) => {
      const _done = (state) => {
        _stateCache = state || {};
        // Reconcile any sections rendered before the cache landed.
        // Pristine entries (the user hasn't clicked them yet) get their
        // visual state re-applied from the freshly loaded cache.
        for (const p of _pendingSections.splice(0)) {
          if (p.dirty) continue;
          try { p.apply(); } catch (_e) {}
        }
        resolve(_stateCache);
      };
      try {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          _done(res && res[STORAGE_KEY]);
        });
      } catch (_e) {
        _done({});
      }
    });
    return _loadingPromise;
  }

  function _getCollapsed(name, defaultCollapsed) {
    if (!_stateCache) return defaultCollapsed;
    const v = _stateCache[name];
    if (v === 'open') return false;
    if (v === 'closed') return true;
    return defaultCollapsed;
  }

  function _setCollapsed(name, collapsed) {
    if (!_stateCache) _stateCache = {};
    _stateCache[name] = collapsed ? 'closed' : 'open';
    try {
      const obj = {};
      obj[STORAGE_KEY] = _stateCache;
      chrome.storage.local.set(obj);
    } catch (_e) {}
  }

  // Eager warm — most listings render >50ms after the script loads, so
  // the cache is usually populated by then.
  try { _loadState(); } catch (_e) {}

  /**
   * Append a sticky digest wrapper to the panel and return it.
   * The panel itself is overflow-y:auto, so position:sticky on a child
   * pins the digest at the top while the sections below scroll.
   */
  function beginDigest(panel) {
    const wrap = document.createElement('div');
    wrap.dataset.dsDigest = '1';
    wrap.style.cssText =
      'position:sticky;top:0;z-index:5;background:#1e1b2e;'
      + 'border-radius:10px 10px 0 0;'
      + 'box-shadow:0 2px 6px rgba(0,0,0,0.35)';
    panel.appendChild(wrap);
    return wrap;
  }

  /**
   * Append a collapsible section to `container`. Returns:
   *   body        — div the caller writes content into
   *   setSummary  — fn(text, color?) updating the right-aligned one-liner
   *                 visible on the closed row
   *   wrap        — outer wrapper (for callers that need to remove on empty)
   *
   * Default state is collapsed; persisted state under `name` overrides.
   */
  function openCollapsible(container, name, opts) {
    opts = opts || {};
    const title = opts.title || name;
    // v0.47.0 — auto-collapse on small viewports (sub-laptop screens).
    // OR-in window.innerHeight < 700 to the default-collapsed calculation
    // so callers asking for an open-by-default section still collapse on
    // short screens. Persisted user state continues to win via _getCollapsed.
    const _smallViewport = (typeof window !== "undefined") && (window.innerHeight || 0) < 700;
    const defaultCollapsed = _smallViewport ? true : (opts.defaultCollapsed !== false);
    let collapsed = _getCollapsed(name, defaultCollapsed);
    // Track whether the user has clicked this row. Used by the post-load
    // reconciliation pass below — we never overwrite a deliberate toggle.
    let _userClicked = false;

    const wrap = document.createElement('div');
    wrap.style.cssText =
      'margin:8px 12px 0;border:1px solid rgba(255,255,255,0.08);'
      + 'border-radius:10px;background:rgba(255,255,255,0.025);overflow:hidden';

    const head = document.createElement('div');
    head.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;'
      + 'gap:8px;padding:8px 11px;cursor:pointer;user-select:none;font-size:12px';

    const left = document.createElement('div');
    left.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0;flex:1';

    const chev = document.createElement('span');
    chev.style.cssText =
      'color:#7c8cf8;font-size:9px;width:9px;flex-shrink:0;'
      + 'transition:transform .15s ease;display:inline-block';
    chev.textContent = '\u25B6';

    const titleEl = document.createElement('span');
    titleEl.style.cssText =
      'font-weight:600;color:#c9c9d9;'
      + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    titleEl.textContent = title;

    left.appendChild(chev);
    left.appendChild(titleEl);

    const summaryEl = document.createElement('span');
    summaryEl.style.cssText =
      'font-size:11px;color:#9ca3af;'
      + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;'
      + 'max-width:55%;text-align:right';

    head.appendChild(left);
    head.appendChild(summaryEl);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.style.cssText = 'border-top:1px solid rgba(255,255,255,0.05);padding:4px 0 6px';

    function applyState() {
      body.style.display = collapsed ? 'none' : 'block';
      chev.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(90deg)';
    }
    applyState();
    wrap.appendChild(body);

    // If we rendered before the persisted state finished loading, queue
    // ourselves for reconciliation. The post-load pass re-reads the
    // cache and re-applies state — but only if the user hasn't already
    // clicked us in the meantime.
    if (!_stateCache) {
      const _entry = {
        name: name,
        dirty: false,
        apply: () => {
          collapsed = _getCollapsed(name, defaultCollapsed);
          applyState();
        },
      };
      _pendingSections.push(_entry);
      head.addEventListener('click', () => {
        _userClicked = true;
        _entry.dirty = true;
        collapsed = !collapsed;
        applyState();
        _setCollapsed(name, collapsed);
      });
    } else {
      head.addEventListener('click', () => {
        _userClicked = true;
        collapsed = !collapsed;
        applyState();
        _setCollapsed(name, collapsed);
      });
    }
    // Silence unused-var lint without changing observable behavior.
    void _userClicked;

    function setSummary(text, color) {
      summaryEl.textContent = text || '';
      summaryEl.style.color = color || '#9ca3af';
    }

    container.appendChild(wrap);
    return { body, setSummary, wrap };
  }

  // ────────────────────────────────────────────────────────────────────
  // Save star + (?) help icon (Task #69)
  // ────────────────────────────────────────────────────────────────────
  // attachSaveStar(digest, currentEntry) renders three things tied to
  // the saved-listings recall feature:
  //
  //   1. A floating ☆/★ control + (?) tooltip in the digest's top-right
  //      corner. Click ★ → unsave; click ☆ when not at cap → save +
  //      brief toast (longer first-save hint on the very first save);
  //      click ☆ at cap → reveal the swap picker.
  //   2. A "★ Saved Nd ago at $original (down $delta)" annotation under
  //      the digest's header row when the URL is already saved.
  //   3. A swap picker overlaying the digest when the user tries to
  //      save while already at the 10-save cap.
  //
  // Depends on window.DealScoutSaved (lib/saved.js, loaded earlier in
  // manifest.json content_scripts list). Silently no-ops when missing
  // so an older platform script that hasn't been wired up yet doesn't
  // throw.
  function attachSaveStar(digest, current) {
    if (!digest || !current || !current.url) return;
    if (!window.DealScoutSaved) return;
    const Saved = window.DealScoutSaved;

    // v0.47.2 — moved the save star OUT of the topbar (it was getting
    // covered by the new Rate / Share / ✕ controls) to sit just below
    // the topbar at the right edge. We attach to the panel instead of
    // the digest header so it stays visible when the header collapses.
    const controls = document.createElement('div');
    controls.style.cssText =
      'position:absolute;top:40px;right:10px;z-index:6;'
      + 'display:flex;align-items:center;gap:8px';
    const panelHost = digest.closest('[id^="deal-scout-"]') || digest;
    if (getComputedStyle(panelHost).position === 'static') {
      panelHost.style.position = 'relative';
    }
    panelHost.appendChild(controls);

    const star = document.createElement('button');
    star.type = 'button';
    star.title = 'Save listing';
    star.setAttribute('aria-label', 'Save listing');
    star.style.cssText =
      'background:rgba(19,17,31,0.85);border:1px solid rgba(124,140,248,0.25);'
      + 'border-radius:99px;cursor:pointer;padding:3px 8px;'
      + 'font-size:16px;line-height:1;color:#9ca3af;'
      + 'transition:color .15s,transform .1s,border-color .15s;'
      + 'box-shadow:0 2px 6px rgba(0,0,0,0.3)';
    star.textContent = '\u2606'; // ☆
    star.addEventListener('mouseenter', () => {
      star.style.transform = 'scale(1.1)';
      star.style.borderColor = 'rgba(124,140,248,0.55)';
      showHint();
    });
    star.addEventListener('mouseleave', () => {
      star.style.transform = 'scale(1)';
      star.style.borderColor = 'rgba(124,140,248,0.25)';
      scheduleHideHint();
    });
    controls.appendChild(star);

    // v0.47.2 — explicit hover/focus hint explaining the star and
    // pointing users at the Deal Scout toolbar popup where their
    // saved listings are listed. Replaces the old (?) help icon —
    // now triggered by the star itself per user feedback.
    // v0.47.3 — pin a fixed width and attach to the panel host (not
    // the flex `controls` row). Inside the flex parent the hint was
    // collapsing to one column of characters; sized + parented at the
    // panel level it wraps as a normal readable paragraph.
    const hint = document.createElement('div');
    hint.style.cssText =
      'position:absolute;top:80px;right:10px;z-index:7;'
      + 'box-sizing:border-box;width:240px;'
      + 'background:#13111f;border:1px solid rgba(124,140,248,0.45);'
      + 'border-radius:8px;padding:9px 11px;font-size:11.5px;color:#e2e8f0;'
      + 'box-shadow:0 6px 16px rgba(0,0,0,0.5);'
      + 'line-height:1.5;display:none;pointer-events:auto;'
      + 'white-space:normal;text-align:left;word-break:normal;'
      + 'font-family:inherit;font-weight:400';
    hint.textContent = 'Click \u2606 to save this listing. View your saved listings any time from the Deal Scout toolbar icon.';
    panelHost.appendChild(hint);

    let hintHideTimer = null;
    function showHint() {
      if (hintHideTimer) { clearTimeout(hintHideTimer); hintHideTimer = null; }
      hint.style.display = 'block';
    }
    function scheduleHideHint() {
      if (hintHideTimer) clearTimeout(hintHideTimer);
      hintHideTimer = setTimeout(() => { hint.style.display = 'none'; }, 350);
    }
    hint.addEventListener('mouseenter', showHint);
    hint.addEventListener('mouseleave', scheduleHideHint);
    star.addEventListener('focus', showHint);
    star.addEventListener('blur', scheduleHideHint);

    // Tracks live state so click handlers don't re-query storage on
    // every press. Initialised async — the star renders as ☆ until the
    // initial isSaved check resolves, then snaps to ★ if saved.
    let isCurrentlySaved = false;

    function paintStar(saved) {
      isCurrentlySaved = saved;
      star.textContent = saved ? '\u2605' : '\u2606'; // ★ vs ☆
      star.style.color = saved ? '#fbbf24' : '#9ca3af';
      star.title = saved ? 'Remove from saved listings' : 'Save listing';
      star.setAttribute('aria-label', star.title);
    }

    // Initial paint + revisit annotation.
    Saved.getSavedSnapshot(current.url).then((snap) => {
      if (snap) {
        paintStar(true);
        renderRevisitAnnotation(snap);
        // Update change-tracking with the live values from this visit.
        Saved.recordRevisit(current.url, current.asking, current.score);
      } else {
        paintStar(false);
      }
    });

    // ── Toast ──────────────────────────────────────────────────────
    // Small pill at the top of the digest. Only one toast at a time —
    // a fresh call cancels the previous timer and replaces the text so
    // rapid star clicks don't pile up overlapping toasts.
    let toastEl = null;
    let toastTimer = null;
    function showToast(text, ms) {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText =
          'position:absolute;top:36px;right:8px;z-index:7;'
          + 'background:#13111f;border:1px solid rgba(124,140,248,0.4);'
          + 'border-radius:8px;padding:6px 10px;font-size:11px;'
          + 'color:#e2e8f0;box-shadow:0 4px 12px rgba(0,0,0,0.4);'
          + 'max-width:220px;line-height:1.4';
        digest.appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.style.display = 'block';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (toastEl) toastEl.style.display = 'none';
      }, ms || 1800);
    }

    // ── Saved Nd ago annotation ───────────────────────────────────
    // One-line note placed immediately AFTER the header block — i.e.
    // just below the asking/offer row, per spec — and BEFORE confidence
    // / trust / leverage / summary. attachSaveStar runs before
    // renderHeader in each content script, but the snapshot promise
    // resolves in a microtask after the synchronous render flow has
    // finished, so by the time we insert the annotation the header
    // already exists in the DOM. We locate the header by skipping our
    // own floating controls overlay (the only absolutely-positioned
    // child we appended) and any toast/picker UI also owned by the
    // star, then insert right after that first "real" block.
    let annotationEl = null;
    function renderRevisitAnnotation(snap) {
      if (annotationEl) annotationEl.remove();
      annotationEl = document.createElement('div');
      annotationEl.style.cssText =
        'margin:2px 12px 6px;font-size:11px;color:#fbbf24;'
        + 'display:flex;align-items:center;gap:6px';
      const ago = _humanAgo(snap.savedAt);
      // Original at save-time. Falls back to the legacy `asking` field
      // for entries written before the savedAsking/savedScore split so
      // pre-existing saves still render an annotation (just with delta
      // collapsed to 0 until the next revisit re-anchors them).
      const origAsking = (typeof snap.savedAsking === 'number' && snap.savedAsking > 0)
        ? snap.savedAsking
        : (Number(snap.asking) || 0);
      const liveAsking = Number(current.asking) || 0;
      let delta = '';
      if (origAsking > 0 && liveAsking > 0 && liveAsking !== origAsking) {
        const diff = origAsking - liveAsking;
        if (diff > 0) delta = ' (down $' + Math.abs(Math.round(diff)) + ')';
        else delta = ' (up $' + Math.abs(Math.round(diff)) + ')';
      }
      annotationEl.textContent =
        '\u2605 Saved ' + ago + (origAsking > 0 ? ' at $' + Math.round(origAsking) : '') + delta;

      // Find the header block — first child of digest that isn't one
      // of the star's own floating elements (controls, toast, picker).
      let header = null;
      for (const child of digest.children) {
        if (child === controls || child === toastEl || child === pickerEl) continue;
        header = child;
        break;
      }
      if (header && header.nextSibling) {
        digest.insertBefore(annotationEl, header.nextSibling);
      } else {
        digest.appendChild(annotationEl);
      }
    }

    // ── Swap picker ───────────────────────────────────────────────
    // At-cap (10 saves) inline overlay. Reveals all 10 saves in a
    // scrollable list — tap any row to swap it out for the current
    // listing. No FIFO: the user always picks who gets evicted.
    let pickerEl = null;
    async function openSwapPicker() {
      if (pickerEl) return;
      const all = await Saved.getSaved();
      pickerEl = document.createElement('div');
      pickerEl.style.cssText =
        'position:absolute;inset:0;z-index:8;background:#13111f;'
        + 'border-radius:10px 10px 0 0;padding:10px;display:flex;'
        + 'flex-direction:column;gap:6px;overflow:hidden';

      const head = document.createElement('div');
      head.style.cssText = 'font-size:12px;color:#e2e8f0;line-height:1.4';
      head.textContent =
        "You\u2019ve saved the maximum of " + Saved.MAX_SAVES
        + ". Tap one to swap it for this listing, or Cancel.";
      pickerEl.appendChild(head);

      const list = document.createElement('div');
      list.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px';
      for (const old of all) {
        const row = document.createElement('button');
        row.type = 'button';
        row.style.cssText =
          'display:flex;align-items:center;gap:8px;padding:6px 8px;'
          + 'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);'
          + 'border-radius:6px;cursor:pointer;text-align:left;'
          + 'color:#e2e8f0;font-size:11px;font-family:inherit';
        const score = Number(old.score) || 0;
        const sc = score >= 7 ? '#22c55e' : score >= 5 ? '#fbbf24' : '#ef4444';
        const badge = document.createElement('span');
        badge.style.cssText =
          'flex-shrink:0;width:22px;height:22px;border-radius:4px;'
          + 'background:' + sc + '22;color:' + sc + ';font-weight:700;'
          + 'display:flex;align-items:center;justify-content:center;font-size:11px';
        badge.textContent = String(score);
        const titleSpan = document.createElement('span');
        titleSpan.style.cssText =
          'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        titleSpan.textContent = old.title || old.url;
        row.appendChild(badge);
        row.appendChild(titleSpan);
        row.addEventListener('click', async () => {
          await Saved.swapSaved(old.url, current);
          closePicker();
          paintStar(true);
          showToast('Swapped \u2014 saved this listing in place of \u201C'
            + (old.title || 'previous').slice(0, 40) + '\u201D');
        });
        list.appendChild(row);
      }
      pickerEl.appendChild(list);

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.style.cssText =
        'padding:7px;background:rgba(255,255,255,0.05);'
        + 'border:1px solid rgba(255,255,255,0.1);border-radius:6px;'
        + 'color:#9ca3af;font-size:12px;cursor:pointer;font-family:inherit';
      cancel.addEventListener('click', closePicker);
      pickerEl.appendChild(cancel);

      digest.appendChild(pickerEl);
    }

    function closePicker() {
      if (pickerEl) { pickerEl.remove(); pickerEl = null; }
    }

    // ── Star click handler ────────────────────────────────────────
    star.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isCurrentlySaved) {
        await Saved.removeSaved(current.url);
        paintStar(false);
        if (annotationEl) { annotationEl.remove(); annotationEl = null; }
        showToast('Removed from saved listings');
        return;
      }
      // Not saved — try to add. May need swap picker if at cap.
      if (await Saved.isAtCap()) {
        openSwapPicker();
        return;
      }
      const res = await Saved.saveListing(current);
      if (!res || !res.ok) {
        showToast('Could not save \u2014 try again');
        return;
      }
      paintStar(true);
      const seen = await Saved.wasFirstSaveSeen();
      if (!seen) {
        await Saved.markFirstSaveSeen();
        showToast(
          '\u2605 Saved! Click the Deal Scout icon in your toolbar to see your saved listings.',
          6000
        );
      } else {
        showToast('\u2605 Saved');
      }
    });
  }

  // ── Time formatting ─────────────────────────────────────────────────
  // Coarse human-friendly recency for the digest annotation. We don't
  // care about minute precision a week later, so anything older than
  // 7 days collapses to "Nw ago".
  function _humanAgo(iso) {
    if (!iso) return 'just now';
    const then = new Date(iso).getTime();
    if (!isFinite(then)) return 'just now';
    const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (sec < 60)        return 'just now';
    if (sec < 3600)      return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400)     return Math.floor(sec / 3600) + 'h ago';
    const days = Math.floor(sec / 86400);
    if (days === 1)      return '1 day ago';
    if (days < 7)        return days + ' days ago';
    if (days < 30)       return Math.floor(days / 7) + 'w ago';
    return Math.floor(days / 30) + 'mo ago';
  }

  // ── Pricing disclaimer (Task #78) ───────────────────────────────────
  // Renders the server-built `pricing_disclaimer` string (e.g. "Score
  // based on new-retail price (~$950); no used sales found — confidence
  // is low.") immediately under the confidence block. The disclaimer
  // text is ALWAYS server-authored from a fixed template — never the
  // LLM's free text — so an attacker-controlled listing cannot
  // strip the warning or inject HTML. We use textContent (no innerHTML)
  // as a defense-in-depth measure regardless. Empty/missing string is
  // a no-op so existing code can call it unconditionally.
  function renderPricingDisclaimer(container, text) {
    const t = (typeof text === 'string') ? text.trim() : '';
    if (!t || !container) return;
    const banner = document.createElement('div');
    // Amber/info palette (#f59e0b family) — visually distinct from the
    // red CAN'T PRICE banner so users learn "yellow = caveat, red = blocked".
    banner.style.cssText = 'margin:8px 12px 0;border:1px solid #f59e0b44;'
      + 'border-radius:8px;background:#f59e0b14;padding:8px 10px;'
      + 'font-size:11.5px;color:#fbbf24;line-height:1.45;font-weight:500';
    banner.textContent = t;
    container.appendChild(banner);
  }

  // Inline variant — appends the same server-built disclaimer text INSIDE
  // an existing parent (typically the `wrap` element of the confidence
  // block), without the outer margin/border.
  //
  // Task #85 (v0.46.6) — no longer wired by default in any content script.
  // Earlier versions called this AND `renderPricingDisclaimer` together,
  // which surfaced the same string twice on every thin-comps panel and
  // read as visual noise. The header banner alone is now sufficient
  // (the chip already conveys "LOW"). Kept exported as an opt-in helper
  // for anyone who wants to surface the caveat inside a collapsible body
  // again. textContent only — never innerHTML — even though the source
  // string is server-authored.
  function renderPricingDisclaimerInline(parent, text) {
    const t = (typeof text === 'string') ? text.trim() : '';
    if (!t || !parent) return;
    const note = document.createElement('div');
    note.style.cssText = 'border-top:1px solid #f59e0b33;padding:6px 10px;'
      + 'font-size:11px;color:#fbbf24;line-height:1.4;font-weight:500;'
      + 'background:#f59e0b0a';
    note.textContent = t;
    parent.appendChild(note);
  }

  // ────────────────────────────────────────────────────────────────────
  // makeCollapsibleHeader (Task #91 / v0.47.1)
  // ────────────────────────────────────────────────────────────────────
  // Wraps a *header* block in a single collapsible region. Differs from
  // openCollapsible:
  //   • No outer border/padding wrap — the caller's header card supplies
  //     its own chrome.
  //   • The "always-visible" row is a thin one-liner summary the caller
  //     populates via setSummary(node), intended to surface score / tag /
  //     asking → rec when the body is collapsed.
  //   • Auto-collapse on short viewports (<700px), persisted state wins.
  //
  // Returns: { expanded, setSummary(node|string|null), wrap, collapsedRow }
  // The expanded body is appended to `container`; callers append their
  // existing header content into `expanded`.
  function makeCollapsibleHeader(container, name, opts) {
    opts = opts || {};
    const _smallVp = (typeof window !== "undefined") && (window.innerHeight || 0) < 700;
    const defaultCollapsed = (opts.defaultCollapsed != null)
      ? !!opts.defaultCollapsed
      : _smallVp;
    let collapsed = _getCollapsed(name, defaultCollapsed);
    let _userClicked = false;

    const collapsedRow = document.createElement('div');
    collapsedRow.style.cssText =
      'display:flex;align-items:center;gap:8px;'
      + 'padding:7px 12px;cursor:pointer;user-select:none;font-size:12px;'
      + 'background:rgba(255,255,255,0.02);'
      + 'border-bottom:1px solid rgba(255,255,255,0.05)';

    const chev = document.createElement('span');
    chev.style.cssText =
      'color:#7c8cf8;font-size:9px;flex-shrink:0;'
      + 'transition:transform .15s ease;display:inline-block;width:9px';
    chev.textContent = '\u25B6';

    const sumContent = document.createElement('div');
    sumContent.style.cssText =
      'display:flex;align-items:center;gap:8px;min-width:0;flex:1;'
      + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      + 'color:#cbd5e1;font-weight:500';

    collapsedRow.appendChild(chev);
    collapsedRow.appendChild(sumContent);

    const expanded = document.createElement('div');

    function applyState() {
      expanded.style.display = collapsed ? 'none' : 'block';
      chev.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(90deg)';
      collapsedRow.title = collapsed ? 'Expand details' : 'Collapse';
    }
    applyState();

    function _onClick() {
      _userClicked = true;
      collapsed = !collapsed;
      applyState();
      _setCollapsed(name, collapsed);
    }

    if (!_stateCache) {
      const _entry = {
        name: name,
        dirty: false,
        apply: () => {
          if (_userClicked) return;
          collapsed = _getCollapsed(name, defaultCollapsed);
          applyState();
        },
      };
      _pendingSections.push(_entry);
    }
    collapsedRow.addEventListener('click', _onClick);

    container.appendChild(collapsedRow);
    container.appendChild(expanded);

    function setSummary(node) {
      sumContent.textContent = '';
      if (node == null) return;
      if (typeof node === 'string') {
        sumContent.textContent = node;
      } else {
        sumContent.appendChild(node);
      }
    }

    return { expanded: expanded, setSummary: setSummary, wrap: collapsedRow, collapsedRow: collapsedRow };
  }

  window.DealScoutDigest = {
    beginDigest: beginDigest,
    openCollapsible: openCollapsible,
    makeCollapsibleHeader: makeCollapsibleHeader,
    attachSaveStar: attachSaveStar,
    renderPricingDisclaimer: renderPricingDisclaimer,
    renderPricingDisclaimerInline: renderPricingDisclaimerInline,
    _loadState: _loadState,
    _getCollapsed: _getCollapsed,
    _setCollapsed: _setCollapsed,
    _humanAgo: _humanAgo,
  };
})();
