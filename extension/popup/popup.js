/**
 * popup.js — Extension Popup Logic
 */

const API_BASE = "http://localhost:8000";

// ── API Health Check ──────────────────────────────────────────────────────────

async function checkAPIHealth() {
  const statusEl = document.getElementById("api-status");
  try {
    const resp = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      statusEl.className = "status-card active";
      statusEl.innerHTML = `
        ✅ API connected<br>
        <span style="font-size:11px">
          Claude: ${data.anthropic_key} ·
          eBay: ${data.ebay_key}
        </span>`;
      document.getElementById("open-scorer").classList.remove("disabled");
    } else {
      throw new Error(`HTTP ${resp.status}`);
    }
  } catch (e) {
    statusEl.className = "status-card error";
    statusEl.innerHTML = `
      ❌ API not running<br>
      <span style="font-size:11px">
        Start it: python -m uvicorn api.main:app --port 8000
      </span>`;
  }
}


// ── Pro Toggle ────────────────────────────────────────────────────────────────
//
// WHY chrome.storage.local (not a cookie or in-page state):
// The toggle needs to be readable by the content script on any Facebook tab.
// chrome.storage.local is shared across all extension contexts — popup,
// content scripts, background worker. Cookies and localStorage are
// origin-scoped (Facebook's domain) and aren't accessible from the popup.
//
// In production: replace this with a check against your Stripe subscription
// API. The content script's isPro() already reads 'ds_pro' — just make the
// server set it after verifying the payment.

async function initProToggle() {
  const toggle  = document.getElementById("pro-toggle");
  const hint    = document.getElementById("pro-hint");

  // Read current Pro state and set toggle accordingly
  try {
    const stored = await chrome.storage.local.get("ds_pro");
    toggle.checked = stored.ds_pro === true;
    updateProHint(toggle.checked, hint);
  } catch {
    toggle.checked = false;
  }

  toggle.addEventListener("change", async () => {
    const isNowPro = toggle.checked;
    try {
      await chrome.storage.local.set({ ds_pro: isNowPro });
      updateProHint(isNowPro, hint);

      // Tell the active tab's content script to re-render — it caches isPro()
      // as part of updateSidebar(), so a rescore is needed to reflect the change.
      // We silently ignore errors here (tab might not have a content script loaded).
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && (tab.url?.includes("facebook.com/marketplace") || tab.url?.includes("craigslist.org"))) {
        chrome.tabs.sendMessage(tab.id, { type: "RESCORE" }).catch(() => {});
      }
    } catch (e) {
      console.warn("[DealScout Popup] Failed to save Pro state:", e);
      toggle.checked = !isNowPro; // Revert on failure
    }
  });
}

function updateProHint(isPro, hintEl) {
  if (isPro) {
    hintEl.innerHTML = '<span style="color:#7c3aed;font-weight:600">✓ Pro active</span> — eBay comps &amp; photo analysis on';
  } else {
    hintEl.textContent = 'Enables eBay comps & photo analysis';
  }
}


// ── Open Full Scorer ──────────────────────────────────────────────────────────

document.getElementById("open-scorer").addEventListener("click", async (e) => {
  /**
   * WHY WE OPEN IN A NEW TAB (not a popup window):
   * The full scorer at localhost:8000/docs gives a live interactive API view.
   * Once the React UI (Week 4) is running on :3000, swap the URL below.
   * For now this opens the FastAPI docs which lets you manually score listings.
   */
  e.preventDefault();

  try {
    const resp = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      chrome.tabs.create({ url: "http://localhost:3000" });
      window.close();
    } else {
      throw new Error("not ok");
    }
  } catch {
    const statusEl = document.getElementById("api-status");
    statusEl.className = "status-card error";
    statusEl.innerHTML = `
      ❌ API not running — can't open scorer<br>
      <span style="font-size:11px">
        Run: python -m uvicorn api.main:app --port 8000
      </span>`;
  }
});


// ── Score Current Page ────────────────────────────────────────────────────────

document.getElementById("score-current").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const isSupportedPage =
    tab.url.includes("facebook.com/marketplace/item") ||
    tab.url.includes("craigslist.org") ||
    tab.url.includes("amazon.com/dp");

  if (!isSupportedPage) {
    document.getElementById("api-status").className = "status-card error";
    document.getElementById("api-status").innerText =
      "⚠️ Navigate to a FBM, Craigslist, or Amazon listing first";
    return;
  }

  // WHY sendMessage BEFORE window.close():
  // Closing the popup before the message is delivered can drop the message
  // entirely. We close inside the callback so the channel stays open.
  chrome.tabs.sendMessage(tab.id, { type: "RESCORE" }, (response) => {
    if (chrome.runtime.lastError) {
      document.getElementById("api-status").className = "status-card error";
      document.getElementById("api-status").innerText =
        "⚠️ Could not reach content script — navigate to a FBM listing first";
      setTimeout(() => window.close(), 2000);
    } else {
      window.close();
    }
  });
});


// ── Init ──────────────────────────────────────────────────────────────────────
checkAPIHealth();
initProToggle();
