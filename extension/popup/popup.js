/**
 * popup.js — Deal Scout Extension Popup
 * v0.20.0
 *
 * DEPLOYMENT NOTE:
 *   API_BASE is read from chrome.storage.local key "ds_api_base" if set.
 *   Default falls back to localhost for local dev.
 *   To point at production: set ds_api_base = "https://your-api.railway.app"
 *   in background.js onInstalled, or hardcode the URL below before packaging.
 */

const API_BASE_DEFAULT = "https://deal-scout-production.up.railway.app";

async function getApiBase() {
  try {
    const stored = await chrome.storage.local.get("ds_api_base");
    return stored.ds_api_base || API_BASE_DEFAULT;
  } catch {
    return API_BASE_DEFAULT;
  }
}

// ── API Health Check ──────────────────────────────────────────────────────────

async function checkAPIHealth() {
  const statusEl = document.getElementById("api-status");
  const API_BASE = await getApiBase();
  try {
    const resp = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      statusEl.className = "status-card active";
      statusEl.innerHTML = `
        ✅ API connected<br>
        <span style="font-size:11px">
          Claude: ${data.anthropic_key} &nbsp;·&nbsp;
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
        Start: <code>uvicorn api.main:app --port 8000</code>
      </span>`;
  }
}



// ── Score Current Listing ─────────────────────────────────────────────────────

document.getElementById("score-current").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const isSupportedPage =
    tab.url?.includes("facebook.com/marketplace/item") ||
    tab.url?.includes("amazon.com/dp");

  if (!isSupportedPage) {
    const statusEl = document.getElementById("api-status");
    statusEl.className = "status-card error";
    statusEl.innerText = "⚠️ Navigate to a Facebook Marketplace listing first";
    return;
  }

  // Close popup AFTER message confirmed — close-before-deliver drops the message
  chrome.tabs.sendMessage(tab.id, { type: "RESCORE" }, (response) => {
    if (chrome.runtime.lastError) {
      const statusEl = document.getElementById("api-status");
      statusEl.className = "status-card error";
      statusEl.innerText = "⚠️ Reload the listing page and try again";
      setTimeout(() => window.close(), 2000);
    } else {
      window.close();
    }
  });
});


// ── Report Issue Modal ────────────────────────────────────────────────────────
//
// POC: POSTs to /report on the local API, which appends to reports.jsonl.
// Production swap: replace the fetch URL with a Slack webhook, a Sentry
// dsn, or a simple Airtable form — no other code changes needed.

const modal     = document.getElementById("report-modal");
const modalForm = document.getElementById("modal-form");
const modalSent = document.getElementById("modal-sent");

document.getElementById("report-link").addEventListener("click", async (e) => {
  e.preventDefault();
  // Pre-fill the URL so the user doesn't have to copy-paste it
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const ta = document.getElementById("report-text");
    if (tab?.url && ta.value === "") ta.value = `URL: ${tab.url}\n\nIssue: `;
  } catch {}
  modal.classList.add("open");
  document.getElementById("report-text").focus();
});

document.getElementById("modal-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

document.getElementById("modal-send").addEventListener("click", async () => {
  const text = document.getElementById("report-text").value.trim();
  if (!text) return;

  const API_BASE = await getApiBase();
  try {
    await fetch(`${API_BASE}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report: text, ts: new Date().toISOString() }),
      signal: AbortSignal.timeout(4000),
    });
  } catch { /* fire-and-forget — don't block UX if API is down */ }

  modalForm.style.display = "none";
  modalSent.style.display = "block";
  setTimeout(closeModal, 2000);
});

function closeModal() {
  modal.classList.remove("open");
  modalSent.style.display = "none";
  modalForm.style.display = "";
  document.getElementById("report-text").value = "";
}


// ── Settings Panel ───────────────────────────────────────────────────────────
// Lets you switch between localhost and Railway without touching code.
// The saved URL persists in chrome.storage.local as "ds_api_base".

document.getElementById("settings-toggle").addEventListener("click", async () => {
  const panel = document.getElementById("settings-panel");
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) {
    const current = await getApiBase();
    document.getElementById("api-url-input").value = current;
  }
});

document.getElementById("settings-save").addEventListener("click", async () => {
  const url = document.getElementById("api-url-input").value.trim().replace(/\/$/, "");
  if (!url) return;
  await chrome.storage.local.set({ ds_api_base: url });
  const saved = document.getElementById("settings-saved");
  saved.style.display = "inline";
  setTimeout(() => { saved.style.display = "none"; }, 2000);
  checkAPIHealth(); // re-ping with new URL
});

// ── Init ──────────────────────────────────────────────────────────────────────
checkAPIHealth();
