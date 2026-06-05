# Deal Scout — Chrome Web Store Submission Packet

Everything the reviewer needs is in this file. Paste each section into the
matching field of the developer dashboard.

---

## 1. Item details

**Name** (max 75 chars):
> Deal Scout — AI Buying Assistant for FB, eBay, Craigslist & OfferUp

**Short description** (max 132 chars):
> AI-powered buying assistant for Facebook Marketplace, eBay, Craigslist & OfferUp. Score deals 1–10, spot scams, find better prices.

**Category:** Shopping

**Language:** English (US)

---

## 2. Detailed description (store listing body)

**Stop overpaying on used marketplaces.** Deal Scout uses Claude AI to score
every listing 1–10 against real sold-price comps from eBay, flags scams,
checks product reputation, and surfaces better deals before you commit.

### NEW in v0.48 — FBM Search Shortlist
On any Facebook Marketplace **search-results page**, click the new
**"Shortlist Top 10"** button. Deal Scout reads the visible cards, asks
Claude Haiku to triage them, and returns the top 10 picks ranked by:
- **45% retail-vs-asking** — how far below market is the price?
- **25% model tier** — premium SKU vs budget version
- **20% capacity / spec** — bigger / better-equipped wins
- **10% signal words** — "barely used", "with receipt", "OBO", etc.

Each pick shows the score, a one-line reason, and a **Score this** button.
Picks you've already scored show **"Already scored: X/10 ↗"** with a
tap-to-focus link back to that tab.

### Core features
- **AI deal scoring** — every listing gets 1–10 with comps + verdict
- **3-layer scam detection** — generic titles, image reuse, seller red flags
- **Cross-site price comparison** — eBay sold-price comps, retail anchors
- **Negotiation help** — counter-offer scripts based on the verdict
- **Save & recall** — star listings to revisit later
- **Privacy first** — no account required; nothing personal stored

### Supported platforms
- Facebook Marketplace (listing pages + search/category shortlist)
- Craigslist (listing pages)
- OfferUp (listing pages)
- eBay (item pages, all major locales)

---

## 3. Single-purpose statement (required field)

> Deal Scout's single purpose is to help shoppers evaluate listings on
> Facebook Marketplace, Craigslist, eBay, and OfferUp by computing an
> AI-powered deal score with sold-price comparisons and scam detection.

---

## 4. Permission justifications (required for every permission)

Paste each one verbatim into the matching field on the dashboard.

**`activeTab`**
> Used to read the current listing's title, price, description, and photos
> on supported marketplace pages so we can score the deal. Only activated
> when the user clicks the extension icon or visits a supported listing.

**`storage`**
> Used to persist user preferences (auto-score on/off, dismissed tips),
> a per-install ID for rate-limiting, the user's saved/starred listings,
> and a short-lived per-tab score cache to avoid re-scoring on SPA
> navigation. No personal data is stored.

**`scripting`**
> Used to programmatically inject the marketplace content script into a
> tab that was opened before the extension was installed or updated, so
> the user doesn't have to manually reload the page before using the
> Shortlist feature.

**`webNavigation`**
> Used to detect SPA navigation on Facebook Marketplace (which doesn't
> trigger a full page load) so we can clear stale score panels and
> re-score the new listing.

**Host permissions**
> Restricted to the four supported marketplaces (Facebook Marketplace,
> Craigslist, eBay regional domains, OfferUp) plus the extension's own
> backend API on `*.replit.app`. We do not request access to any other
> site.

**Remote code (used? `No`)**
> All extension code is bundled in the published package. The extension
> only makes JSON API calls to our backend; it does not load or execute
> remote JavaScript.

---

## 5. Data usage disclosures (required dashboard form)

Check exactly these boxes:

- ☑ **Website content** — listing title, price, description, photos sent
  to our API for scoring
- ☑ **User activity** — affiliate link clicks (program + category, no IDs)
- ☐ Personally identifiable information — NOT collected
- ☐ Health, financial, location, authentication info — NOT collected
- ☐ Personal communications, web history — NOT collected

Then certify:
- ☑ I do not sell or transfer user data to third parties (except for the
  approved use cases of fulfilling the single purpose: sending listing
  text to Claude AI for scoring, and to eBay's Finding API for comps)
- ☑ I do not use or transfer user data for purposes unrelated to the
  item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or
  for lending purposes

**Privacy policy URL:**
> https://deal-scout-805lager.replit.app/api/ds/privacy

---

## 6. Store graphics checklist (you provide)

These are the only items left that require manual work:

| Asset | Size | Required? | Notes |
|---|---|---|---|
| Icon | 128×128 PNG | ✅ included | `extension/icons/icon128.png` |
| Small promo tile | 440×280 PNG | **REQUIRED** | High-impact hero shot of the score panel on a real FBM listing |
| Marquee promo tile | 1400×560 PNG | optional | Skips the homepage feature spot if missing |
| Screenshots | 1280×800 or 640×400 PNG | **1–5 REQUIRED** | See shot list below |

### Recommended screenshot shot list (take 5)
1. **FBM listing page** with the Deal Scout score panel visible (8/10
   or higher — looks compelling)
2. **FBM search page** showing the "Shortlist Top 10" results panel in
   the popup
3. **eBay item page** with the score + comparable-prices section
4. **Craigslist listing** with the scam-detection callout visible
5. **Popup** showing saved listings + the affiliate "Compare prices" card

Tip: capture at exactly 1280×800 (Chrome DevTools → Device Toolbar →
Responsive → 1280×800) so they fill the store carousel.

---

## 7. Pre-submission test checklist

Run through this on a fresh Chrome profile before uploading:

- [ ] Load unpacked → no manifest warnings
- [ ] Open FBM listing → panel appears with score within ~5s
- [ ] Open FBM search page → popup button says "Shortlist Top 10" →
      click → 10 picks render → "Score this" opens listing → after a
      few seconds, returning to the popup shows "Already scored: X/10 ↗"
- [ ] Open eBay item → score panel
- [ ] Open Craigslist listing → score panel
- [ ] Open OfferUp listing → score panel
- [ ] Click an affiliate "Compare" card → opens the retailer in a new tab
- [ ] Click ⚠ Report in popup → submit a test report
- [ ] Star a listing → reopen popup → starred listing appears in
      "Saved" section

---

## 8. Version + release notes (paste into "What's new" box)

**v0.48.19**
- Improved: negotiation messages now read like a real, skilled
  negotiator wrote them — rapport-led openers, a reason behind
  every offer, and three genuinely different tones instead of
  templated one-liners
- Improved: Shortlist Top 10 now treats too-good-to-be-true prices
  as a red flag (likely bait/scam) instead of ranking them highest
- More resilient morning scoring: the extension now retries longer
  and smarter while the server wakes up, so a cold start no longer
  shows an error

**v0.48.18**
- Fixed: scoring popup now clears immediately when you click from
  one listing to another (previously the old score lingered as a
  thin loading bar for ~1s while the next listing was scored)

**v0.48.17**
- NEW: "📋 Report this issue" link on the error panel — one click
  sends the error, listing URL, and version straight to support
  with no typing required
- Fixed: scoring errors caused by Claude wrapping its response in
  markdown or trailing commentary (auto-recovery via JSON repair
  across all four AI parse points — DealScorer, ProductExtractor,
  Shortlist, ClaudePricer)
- Fixed: shortlist deck cap at 50 cards to prevent server 422
  rejection on scrolled search pages

**v0.48.15**
- NEW: Shortlist Top 10 on Facebook Marketplace search pages
- NEW: "Already scored" badges link back to your scored tabs
- NEW: human-readable loading status ("Reading: <title>") while
  Claude is working
- Fixed: "Score this" on a shortlist pick now scores reliably on
  Facebook's direct-load full-page listing layout
- Fixed: RESCORE on an error now reloads the page to recover from
  partial Facebook hydration
- Fixed: scoring panel no longer collapses to a thin bar when
  Facebook updates the URL mid-scoring
- Improved: resilient card scraper survives Facebook layout changes
- Improved: auto-injects scanner into tabs opened before install

Bump versions monotonically (Chrome rejects re-uploads at the same
version). Suggested cadence: patch for hotfixes (`0.48.3`), minor for
new platforms (`0.49.0`), major for paid tier (`1.0.0`).

---

## 9. Reviewer notes (optional but helpful — paste into "Notes for the reviewer")

> Deal Scout helps users evaluate buying decisions on marketplace sites.
> The extension is fully functional without an account — just install and
> visit any supported listing.
>
> Test account: not required. To verify the Shortlist feature, visit
> facebook.com/marketplace/search?query=iphone (any FBM search URL),
> click the extension icon, then "Shortlist Top 10".
>
> Our backend at deal-scout-805lager.replit.app is on always-on hosting
> and responds within ~3 seconds for scoring and ~5 seconds for shortlist.
>
> All listing data sent to our API is processed by Anthropic's Claude API
> for scoring and is not stored long-term. See privacy policy.

---

## 10. Final pre-flight

Run from project root:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')).version)"
# Confirm version matches the zip filename you upload.
```

Upload zip: `extension/deal-scout-v0.48.19.zip` (or whatever version is current).
