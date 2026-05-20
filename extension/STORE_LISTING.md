# Deal Scout — Chrome Web Store Listing

## Short description (≤132 chars)
AI-powered buying assistant for Facebook Marketplace, eBay, Craigslist & OfferUp. Score deals 1–10, spot scams, find better prices.

## Detailed description

**Stop overpaying on used marketplaces.** Deal Scout uses Claude AI to score
every listing 1–10 against real sold-price comps from eBay, flags scams,
checks product reputation, and surfaces better deals before you commit.

### What's new in v0.48.0 — FBM Search Shortlist
On any Facebook Marketplace **search-results page**, click the new
**"Shortlist Top 10"** button in the popup. Deal Scout reads the visible
cards, asks Claude Haiku to triage them against your search, and returns
the top 10 picks ranked by:

- **45% retail-vs-asking** — how far below market is the price?
- **25% model tier** — is this a premium SKU or the budget version?
- **20% capacity / spec** — bigger / better-equipped wins
- **10% signal words** — "barely used", "with receipt", "OBO", etc.

Each pick shows the score, a one-line reason, and a **Score this** button
that opens the listing in a new tab where the existing per-listing scorer
takes over. Picks you've already scored in the session show **"Already
scored: X/10 ↗"** with a tap-to-focus link back to that tab.

### Core features
- **AI deal scoring** — every supported listing gets a 1–10 score with
  comp data, market position, and a verdict
- **3-layer scam detection** — generic titles, image reuse, seller-account
  red flags
- **Cross-site price comparison** — eBay sold-price comps, retail anchors
- **Negotiation help** — counter-offer scripts based on the verdict
- **Save & recall** — star listings to revisit later; price-drop alerts
- **Privacy first** — no account required; no listing data is stored
  beyond the score cache

### Supported platforms
- Facebook Marketplace (listing pages + search/category shortlist)
- Craigslist (listing pages)
- OfferUp (listing pages)
- eBay (item pages)

### Permissions
- `activeTab` / `storage` — score & save listings on the page you're viewing
- Host permissions are limited to the four supported marketplaces

### Support
Report issues from the **⚠ Report** link in the popup, or open an issue
on our GitHub.
