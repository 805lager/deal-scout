/**
 * Deal Scout — Saved listings storage helper (Task #69)
 *
 * Browser-only recall feature. Saves up to 10 listings the user wants to
 * come back to. Storage lives in chrome.storage.sync so Google syncs it
 * across the user's Chrome installs at zero infra cost. Falls back to
 * chrome.storage.local when sync is unavailable (enterprise policy).
 *
 * Used by both content scripts (fbm.js, craigslist.js, ebay.js, offerup.js
 * via lib/digest.js) AND the popup (popup.js renders the list). Same file
 * loaded from both worlds — they share chrome.storage but not window.
 *
 * Storage shape (chrome.storage.sync key `ds_saved_listings`, sorted
 * newest-first, max 10):
 *   {
 *     url, title, platform, score, asking, recommendedOffer, savedAt,
 *     thumbnailUrl,                    // optional URL (never a data URI)
 *     lastAsking, lastScore, lastVisitedAt  // updated on revisit; powers
 *                                            // the "down $X since saved"
 *                                            // line in the popup
 *   }
 *
 * `score` and `asking` are the values at save-time and never mutate.
 * `lastAsking` / `lastScore` track the most recent re-score so the popup
 * can show a price drop without needing a backend cron.
 *
 * Idempotent — safe to load twice (the second IIFE short-circuits on
 * window.DealScoutSaved presence).
 */
(function () {
  'use strict';
  if (window.DealScoutSaved) return;

  const KEY = 'ds_saved_listings';
  const FIRST_SAVE_KEY = 'ds_first_save_seen';
  const MAX_SAVES = 10;

  // Storage mode resolution. We always *prefer* chrome.storage.sync — it
  // gives the user free cross-device recall. When sync is missing
  // entirely (enterprise policy disabled it, or test runtime), fall back
  // to chrome.storage.local and surface that fact via getStorageMode()
  // so the popup can render the "Sync disabled — saves stay on this
  // device." note.
  let _modeCache = null;
  function _resolveMode() {
    if (_modeCache) return _modeCache;
    try {
      if (chrome && chrome.storage && chrome.storage.sync) {
        _modeCache = 'sync';
      } else {
        _modeCache = 'local';
      }
    } catch (_e) {
      _modeCache = 'local';
    }
    return _modeCache;
  }

  function _store() {
    return _resolveMode() === 'sync' ? chrome.storage.sync : chrome.storage.local;
  }

  function _get(key) {
    return new Promise((resolve) => {
      try {
        _store().get([key], (res) => {
          if (chrome.runtime && chrome.runtime.lastError && _modeCache === 'sync') {
            // Sync read failed — fall back to local for this and future
            // operations so we don't ping-pong between stores.
            _modeCache = 'local';
            chrome.storage.local.get([key], (r2) => resolve((r2 && r2[key]) || null));
            return;
          }
          resolve((res && res[key]) || null);
        });
      } catch (_e) {
        resolve(null);
      }
    });
  }

  function _set(key, value) {
    return new Promise((resolve) => {
      const obj = {}; obj[key] = value;
      try {
        _store().set(obj, () => {
          if (chrome.runtime && chrome.runtime.lastError && _modeCache === 'sync') {
            // Quota exceeded or sync write failure — degrade to local.
            _modeCache = 'local';
            chrome.storage.local.set(obj, () => resolve());
            return;
          }
          resolve();
        });
      } catch (_e) {
        resolve();
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────

  async function getSaved() {
    const arr = await _get(KEY);
    return Array.isArray(arr) ? arr : [];
  }

  async function isSaved(url) {
    if (!url) return false;
    const arr = await getSaved();
    return arr.some((e) => e && e.url === url);
  }

  async function getSavedSnapshot(url) {
    if (!url) return null;
    const arr = await getSaved();
    return arr.find((e) => e && e.url === url) || null;
  }

  async function isAtCap() {
    const arr = await getSaved();
    return arr.length >= MAX_SAVES;
  }

  /**
   * Save a new listing (newest-first). Refuses when at cap — caller
   * should detect that via isAtCap() first and present the swap picker.
   * If the URL is already saved, we keep the existing entry and just
   * refresh its lastAsking/lastScore/lastVisitedAt change-tracking
   * fields (so re-saving an already-saved listing is idempotent).
   */
  async function saveListing(entry) {
    if (!entry || !entry.url) return { ok: false, reason: 'missing_url' };
    const arr = await getSaved();
    const idx = arr.findIndex((e) => e && e.url === entry.url);
    if (idx >= 0) {
      // Already saved — just touch the change-tracking fields.
      arr[idx] = _mergeRevisit(arr[idx], entry);
      await _set(KEY, arr);
      return { ok: true, alreadySaved: true };
    }
    if (arr.length >= MAX_SAVES) {
      return { ok: false, reason: 'at_cap' };
    }
    const fresh = {
      url:              String(entry.url),
      title:            String(entry.title || '').slice(0, 200),
      platform:         String(entry.platform || ''),
      score:            Number(entry.score) || 0,
      asking:           Number(entry.asking) || 0,
      recommendedOffer: Number(entry.recommendedOffer) || 0,
      savedAt:          new Date().toISOString(),
      thumbnailUrl:     _safeThumbnail(entry.thumbnailUrl),
      lastAsking:       null,
      lastScore:        null,
      lastVisitedAt:    null,
    };
    arr.unshift(fresh);
    await _set(KEY, arr);
    return { ok: true };
  }

  async function removeSaved(url) {
    if (!url) return;
    const arr = await getSaved();
    const next = arr.filter((e) => !e || e.url !== url);
    if (next.length !== arr.length) await _set(KEY, next);
  }

  /**
   * Atomic swap — single storage write that removes one entry and adds
   * the new one in the same operation. Used by the at-cap picker so the
   * user never sees a transient 9-of-10 or 11-of-10 state and there's
   * no race window where a concurrent read could observe an over-cap
   * array.
   */
  async function swapSaved(removeUrl, newEntry) {
    if (!newEntry || !newEntry.url) return { ok: false };
    const arr = await getSaved();
    const filtered = arr.filter((e) => !e || e.url !== removeUrl);
    const fresh = {
      url:              String(newEntry.url),
      title:            String(newEntry.title || '').slice(0, 200),
      platform:         String(newEntry.platform || ''),
      score:            Number(newEntry.score) || 0,
      asking:           Number(newEntry.asking) || 0,
      recommendedOffer: Number(newEntry.recommendedOffer) || 0,
      savedAt:          new Date().toISOString(),
      thumbnailUrl:     _safeThumbnail(newEntry.thumbnailUrl),
      lastAsking:       null,
      lastScore:        null,
      lastVisitedAt:    null,
    };
    filtered.unshift(fresh);
    if (filtered.length > MAX_SAVES) filtered.length = MAX_SAVES;
    await _set(KEY, filtered);
    return { ok: true };
  }

  /**
   * Called by the digest when the user re-visits an already-saved
   * listing. Updates lastAsking/lastScore/lastVisitedAt so the popup
   * can render the "↓ down $X since saved" line. The original `asking`
   * and `score` fields are intentionally NOT touched — they're the
   * snapshot at save-time and the comparison anchor.
   */
  async function recordRevisit(url, currentAsking, currentScore) {
    if (!url) return;
    const arr = await getSaved();
    const idx = arr.findIndex((e) => e && e.url === url);
    if (idx < 0) return;
    arr[idx] = _mergeRevisit(arr[idx], {
      asking: currentAsking,
      score:  currentScore,
    });
    await _set(KEY, arr);
  }

  function _mergeRevisit(existing, fresh) {
    const out = Object.assign({}, existing);
    if (typeof fresh.asking === 'number' && fresh.asking > 0) {
      out.lastAsking = fresh.asking;
    }
    if (typeof fresh.score === 'number' && fresh.score > 0) {
      out.lastScore = fresh.score;
    }
    out.lastVisitedAt = new Date().toISOString();
    return out;
  }

  // First-save hint state lives in chrome.storage.local on purpose —
  // it's a per-device onboarding nudge, not a per-account fact. We
  // don't want a user who already saw it on their laptop to see it
  // again the first time they save on their phone.
  async function wasFirstSaveSeen() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([FIRST_SAVE_KEY], (res) => {
          resolve(!!(res && res[FIRST_SAVE_KEY]));
        });
      } catch (_e) {
        resolve(false);
      }
    });
  }

  async function markFirstSaveSeen() {
    return new Promise((resolve) => {
      try {
        const obj = {}; obj[FIRST_SAVE_KEY] = true;
        chrome.storage.local.set(obj, () => resolve());
      } catch (_e) {
        resolve();
      }
    });
  }

  function getStorageMode() { return _resolveMode(); }

  // Thumbnails: spec says URL only, never a data URI. Reject anything
  // that isn't a plain http/https URL so we can never blow the per-item
  // sync quota with an inlined image payload.
  function _safeThumbnail(value) {
    if (!value || typeof value !== 'string') return null;
    if (!/^https?:\/\//i.test(value)) return null;
    if (value.length > 500) return null;
    return value;
  }

  window.DealScoutSaved = {
    MAX_SAVES,
    getSaved,
    isSaved,
    getSavedSnapshot,
    isAtCap,
    saveListing,
    removeSaved,
    swapSaved,
    recordRevisit,
    wasFirstSaveSeen,
    markFirstSaveSeen,
    getStorageMode,
  };
})();
