const API_BASE_DEFAULT = "https://74e2628f-3f35-45e7-a256-28e515813eca-00-1g6ldqrar1bea.spock.replit.dev/api/ds";

async function getApiBase() {
  try {
    const stored = await chrome.storage.local.get("ds_api_base");
    return stored.ds_api_base || API_BASE_DEFAULT;
  } catch {
    return API_BASE_DEFAULT;
  }
}

function detectPlatform(url) {
  if (!url) return null;
  if (url.includes("facebook.com/marketplace/item") || url.match(/facebook\.com\/marketplace\/[^/]+\/item\//)) return "fbm";
  if (url.includes("craigslist.org")) return "craigslist";
  if (url.includes("offerup.com/item/detail")) return "offerup";
  if (url.includes("ebay.com/itm")) return "ebay";
  if (url.includes("amazon.com/dp") || url.includes("amazon.com/") && url.includes("/dp/")) return "amazon";
  return null;
}

const CONTENT_SCRIPT = {
  fbm:        "content/fbm.js",
  craigslist: "content/craigslist.js",
  offerup:    "content/offerup.js",
  ebay:       "content/ebay.js",
};

async function checkAPIHealth() {
  const statusEl = document.getElementById("api-status");
  const API_BASE = await getApiBase();
  try {
    const resp = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(4000) });
    if (resp.ok) {
      const data = await resp.json();
      statusEl.className = "status-card active";
      statusEl.innerHTML = `✅ API connected &nbsp;·&nbsp; <span style="font-size:11px">Claude: ${data.anthropic_key} &nbsp;·&nbsp; eBay: ${data.ebay_key}</span>`;
    } else {
      throw new Error(`HTTP ${resp.status}`);
    }
  } catch (e) {
    statusEl.className = "status-card error";
    statusEl.innerHTML = `❌ API offline &nbsp;·&nbsp; <span style="font-size:11px">${e.message}</span>`;
  }
}

document.getElementById("score-current").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const statusEl = document.getElementById("api-status");
  const platform = detectPlatform(tab?.url);

  if (!platform || platform === "amazon") {
    statusEl.className = "status-card error";
    statusEl.innerText = "⚠️ Navigate to a Craigslist, OfferUp, eBay, or Facebook Marketplace listing first.";
    return;
  }

  const scriptFile = CONTENT_SCRIPT[platform];

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [scriptFile],
    });
  } catch (_) {}

  await new Promise(r => setTimeout(r, 300));

  chrome.tabs.sendMessage(tab.id, { type: "RESCORE" }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.className = "status-card error";
      statusEl.innerText = "⚠️ Could not reach the page script. Try reloading the listing page first.";
    } else {
      window.close();
    }
  });
});


const modal     = document.getElementById("report-modal");
const modalForm = document.getElementById("modal-form");
const modalSent = document.getElementById("modal-sent");

document.getElementById("report-link").addEventListener("click", async (e) => {
  e.preventDefault();
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
  } catch {}
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
  checkAPIHealth();
});

checkAPIHealth();
