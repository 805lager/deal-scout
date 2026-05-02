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
    const defaultCollapsed = opts.defaultCollapsed !== false;
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

  window.DealScoutDigest = {
    beginDigest: beginDigest,
    openCollapsible: openCollapsible,
    _loadState: _loadState,
  };
})();
