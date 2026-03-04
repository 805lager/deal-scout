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
      // Enable the open scorer button only if API is up
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


// ── Open Full Scorer ──────────────────────────────────────────────────────────

document.getElementById("open-scorer").addEventListener("click", async (e) => {
  /**
   * WHY WE OPEN IN A NEW TAB (not a popup window):
   * The full scorer at localhost:8000/docs gives a live interactive API view.
   * Once the React UI (Week 4) is running on :3000, swap the URL below.
   * For now this opens the FastAPI docs which lets you manually score listings.
   */
  e.preventDefault();

  // Check if API is actually up before opening
  try {
    const resp = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      chrome.tabs.create({ url: `${API_BASE}/docs` });
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

  chrome.tabs.sendMessage(tab.id, { type: "RESCORE" }, (response) => {
    if (chrome.runtime.lastError) {
      document.getElementById("api-status").className = "status-card error";
      document.getElementById("api-status").innerText =
        "⚠️ Could not reach content script — try refreshing the page";
    }
  });

  window.close();
});


// ── Init ──────────────────────────────────────────────────────────────────────
checkAPIHealth();
