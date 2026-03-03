/**
 * popup.js — Extension Popup Logic
 *
 * Handles the popup that appears when you click the extension icon.
 * Checks API health, shows current platform status, and lets
 * users manually trigger scoring on the current page.
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


// ── Score Current Page ────────────────────────────────────────────────────────

document.getElementById("score-current").addEventListener("click", async () => {
  /**
   * Manually trigger scoring on the current tab.
   * Useful when the auto-detect didn't fire, or user wants a re-score.
   */
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

  // Send message to the content script on the current page
  chrome.tabs.sendMessage(tab.id, { type: "RESCORE" }, (response) => {
    if (chrome.runtime.lastError) {
      document.getElementById("api-status").className = "status-card error";
      document.getElementById("api-status").innerText =
        "⚠️ Could not reach content script — try refreshing the page";
    }
  });

  window.close(); // Close popup so user can see the sidebar
});


// ── Init ──────────────────────────────────────────────────────────────────────
checkAPIHealth();
