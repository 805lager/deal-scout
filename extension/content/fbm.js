/**
 * content/fbm.js — Facebook Marketplace Content Script v0.24.0
 *
 * FEATURES:
 *   1. Collapsible deal scoring sidebar (bottom-right tab, draggable)
 *   2. Auto-scores on page load + SPA re-injection
 *   3. Free for all — affiliate + data monetization (v0.19.0)
 *   4. Price history tracking (chrome.storage.local, no server)
 *   5. Search results overlay (score badges on listing thumbnails)
 *   6. Seller trust extraction from DOM
 *   7. Shipping cost extraction — adds to total cost for scoring
 *   8. Price reduction detection (strikethrough original price)
 *   9. Image extraction for Claude Vision
 *  10. Like Products (affiliate cards from eBay comps)
 *  11. Better Options (Claude suggestion cards)
 *  12. Product reliability badge
 *
 * ARCHITECTURE NOTE:
 *   All rendering uses DOM creation + addEventListener — NEVER inline onclick.
 *   Facebook's CSP strips inline event handlers from dynamically injected HTML.
 *   Failing to follow this causes silent click failures.
 */

(function () {
  "use strict";

  // Prevent double-injection on SPA re-navigations.
  // WHY: FBM's window context persists across pushState navigations.
  // __dealScoutInjected stays true, so the background's re-inject lands here.
  // We dispatch to the right handler based on page type:
  //   • Listing page  → re-score the listing
  //   • Search/category → re-run overlay badge injection
  if (window.__dealScoutInjected) {
    const onListing = /\/marketplace\/(item\/|\w+\/item\/)/.test(window.location.pathname);
    if (onListing) {
      window.__dealScoutRescore && window.__dealScoutRescore();
    } else {
      window.__dealScoutReoverlay && window.__dealScoutReoverlay();
    }
    return;
  }
  window.__dealScoutInjected = true;

  // ⚙️  DEPLOYMENT — API base URL
  //  Reads from chrome.storage.local key "ds_api_base" if set.
  //  Set it once from the popup or background.js onInstalled:
  //    chrome.storage.local.set({ ds_api_base: "https://your-app.up.railway.app" })
  //  Falls back to localhost for local dev with no configuration needed.
  //  WHY let (not const): storage read is async; resolved before first score
  //  fires (~1s debounce) but after injection.
  let API_BASE = "http://localhost:8000";
  chrome.storage.local.get("ds_api_base").then(s => {
    if (s.ds_api_base) API_BASE = s.ds_api_base;
  }).catch(() => {});

  const VERSION   = "0.24.0";
  const LOG_PRE   = "[DealScout]";

  // v0.19.0: Pro gating removed — fully free (affiliate + data monetization)


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 1 — DATA EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find the listing title.
   * FBM renders it as an h1 — but the LEFT NAV also has an h1 ("Notifications").
   * We want the SECOND h1, which is always the listing title in the right panel.
   * WHY NOT data-testid: Facebook removed all data-testid attrs in early 2025.
   */
  function findTitle() {
    const NOISE = new Set(["marketplace", "notifications", "facebook", "search results"]);
    const _listingDialog = [...document.querySelectorAll('[role="dialog"]')].find(
      dlg => [...dlg.querySelectorAll('h1')].some(h => !NOISE.has(h.textContent.trim().toLowerCase()) && h.textContent.trim().length > 2)
    );
    const _docRoot = _listingDialog || document;
    const h1s = _docRoot.querySelectorAll("h1");
    let best = "";
    for (const h1 of h1s) {
      const t = h1.textContent.trim();
      if (!t || NOISE.has(t.toLowerCase())) continue;
      if (t.length > best.length) best = t;
    }
    if (best) return best;
    return document.title
      .replace(" | Facebook", "")
      .replace(/^Marketplace\s*[-–]\s*/i, "")
      .trim();
  }

  /**
   * Find the current listing price.
   *
   * v0.19.9 FIX — B-PE4: "$1" price extraction bug.
   * FBM now renders offer-count badges and rating fragments as "$1" spans at
   * shallow DOM depth near the listing h1. The old return-first logic grabbed
   * "$1" before finding the real "$15". Fix uses three strategies in order:
   *
   *   STRATEGY 0: aria-label exact match (most reliable, FBM-specific)
   *   STRATEGY 1: line-through dual-price container (price-reduced listings)
   *   STRATEGY 2: collect ALL $X candidates >= $2, pick shallowest+largest
   *
   * Returns: { price: number, original: number|null }
   */
  function findPrices() {
    // Scope to the listing dialog only — same fix as findTitle.
    const _DIALOG_NOISE = new Set(["marketplace", "notifications", "facebook", "search results"]);
    const _listingDlg = [...document.querySelectorAll('[role="dialog"]')].find(
      dlg => [...dlg.querySelectorAll('h1')].some(h => !_DIALOG_NOISE.has(h.textContent.trim().toLowerCase()) && h.textContent.trim().length > 2)
    );
    const _priceRoot = _listingDlg || document;

    // STRATEGY 0: aria-label price extraction.
    // WHY FIRST: FBM accessibility labels like aria-label="$15" are the most
    // reliable signal — set explicitly for the price element, never on ratings
    // or badge counts. Catches DOM restructures that keep aria attrs intact.
    for (const el of _priceRoot.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') || '';
      if (/^\$[\d,]+(\.\d{2})?$/.test(label.trim())) {
        const p = parsePrice(label);
        if (p >= 2) return { price: p, original: null };
      }
    }

    // STRATEGY 1: dual-price container (price-reduced listings)
    // FBM DOM: <span>$15<span style="text-decoration:line-through">$25</span></span>
    const allSpans = _priceRoot.querySelectorAll("span");
    for (const span of allSpans) {
      for (const child of span.children) {
        const deco = window.getComputedStyle(child).textDecoration;
        if (deco.includes("line-through")) {
          const original = parsePrice(child.textContent);
          for (const node of span.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              const current = parsePrice(node.textContent);
              if (current >= 2 && current < original) {
                return { price: current, original };
              }
            }
          }
        }
      }
    }

    // STRATEGY 2: h1-anchored ancestor walk — collect ALL candidates, pick best.
    //
    // WHY COLLECT-ALL instead of return-first:
    //   FBM's DOM has "$1" UI elements (offer-count badges, rating fragments)
    //   at shallow depth from the listing h1. The old return-first logic grabbed
    //   "$1" before finding the real "$15". Collecting all candidates >= $2 and
    //   sorting by (shallowest depth, largest price) picks the right one.
    //
    // MINIMUM $2 GUARD:
    //   Legitimate FBM listings under $2 are extremely rare. "$1" is almost
    //   always a UI element — offer count, star rating digit, badge — not the price.
    const PRICE_H1_NOISE = new Set(["marketplace", "notifications", "facebook", "search results"]);
    const h1 = Array.from(_priceRoot.querySelectorAll("h1")).find(
      h => { const t = h.textContent.trim().toLowerCase(); return t.length > 2 && !PRICE_H1_NOISE.has(t); }
    );

    if (h1) {
      const listingTitleLower = h1.textContent.trim().toLowerCase();
      const candidates = [];
      let ancestor = h1.parentElement;

      for (let depth = 0; depth < 20 && ancestor; depth++, ancestor = ancestor.parentElement) {
        // Contamination guard at depth >= 8: ancestor must contain listing title text
        if (depth >= 8 && !ancestor.textContent.toLowerCase().includes(listingTitleLower)) continue;

        for (const span of ancestor.querySelectorAll("span")) {
          const txt = span.textContent.trim();
          if (!/^\$[\d,]+/.test(txt)) continue;
          const price = parsePrice(txt);
          if (price < 2) {
            console.debug(`[DealScout] findPrices: skipping $${price} UI element at depth ${depth}`);
            continue;
          }
          candidates.push({ price, depth });
        }
      }

      if (candidates.length > 0) {
        // Shallowest depth = tightest scope to h1 = most likely listing price.
        // Tie-break: larger price (e.g. $15 beats $5 from a shipping badge).
        candidates.sort((a, b) => a.depth - b.depth || b.price - a.price);
        const best = candidates[0];
        console.log(`[DealScout] findPrices: $${best.price} (depth ${best.depth}, ${candidates.length} candidates)`);
        return { price: best.price, original: null };
      }
    }

    console.warn('[DealScout] findPrices: no price found — returning 0');
    return { price: 0, original: null };
  }

  function parsePrice(text) {
    if (!text) return 0;
    // Extract only the FIRST price from a string like "$200$250" or "$200 - $250"
    const match = text.match(/\$?([\d,]+)/);
    return match ? parseFloat(match[1].replace(/,/g, "")) : 0;
  }

  function formatPriceText(price, original) {
    if (!price) return "$0";
    let txt = "$" + price.toLocaleString();
    if (original && original > price) {
      txt += ` (was $${original.toLocaleString()})`;
    }
    return txt;
  }


  /**
   * Find shipping cost.
   * FBM shows "Ships for $46.68" near the price section.
   * Returns a float (0 if free/local pickup).
   */
  function findShippingCost() {
    const patterns = [
      /ships?\s+for\s+\$(\d+(?:\.\d{1,2})?)/i,
      /shipping[:\s]+\$(\d+(?:\.\d{1,2})?)/i,
      /delivery[:\s]+\$(\d+(?:\.\d{1,2})?)/i,
    ];
    const bodyText = document.body.innerText;
    for (const re of patterns) {
      const match = bodyText.match(re);
      if (match) return parseFloat(match[1]);
    }
    return 0;
  }


  /**
   * Find the item condition.
   */
  function findCondition() {
    const conditions = [
      "Used - Like New",
      "Used - Good",
      "Used - Fair",
      "Used - Poor",
      "For Parts",
      "New",
    ];

    const allText = document.body.innerText;
    const condBlock = allText.match(/Condition[\s\n:]+(.{3,30})/);
    if (condBlock) {
      const nearby = condBlock[1].trim();
      for (const c of conditions) {
        if (nearby.toLowerCase().startsWith(c.toLowerCase())) return c;
      }
    }

    for (const c of conditions.filter(c => c !== "New")) {
      if (allText.includes(c)) return c;
    }

    if (/\bNew\b/.test(allText)) return "New";
    return "Unknown";
  }


  /**
   * Find the listing description.
   *
   * WHY h2-ANCHORED (not longest-span):
   *   FBM embeds RELATED LISTING titles inside the same content area as the
   *   actual listing. Anchoring to h2 section labels gives us clean,
   *   listing-specific text with zero cross-contamination.
   */
  function findDescription() {
    const SECTION_PRIORITY = [
      "seller's description",
      "about this vehicle",
      "about this listing",
      "item details",
      "details",
    ];

    function extractSection(h2el) {
      let el = h2el;
      for (let depth = 0; depth < 12; depth++) {
        const parent = el.parentElement;
        if (!parent) break;
        const siblings = Array.from(parent.children).filter(c => c !== el);
        const contentSibling = siblings.find(s => s.textContent.trim().length > 10);
        if (contentSibling) {
          const spanTexts = Array.from(contentSibling.querySelectorAll("span[dir=auto]"))
            .map(s => s.textContent.trim())
            .filter(t => t.length > 3);
          if (spanTexts.length) return spanTexts.join(" \u00b7 ");
          const raw = contentSibling.textContent.trim();
          if (raw.length > 10) return raw;
        }
        el = parent;
      }
      return null;
    }

    const NAV_NOISE = /\b(see more|see translation|location is approximate|see less|report|save|share|message seller)\b/gi;

    function cleanContent(text) {
      return text
        .replace(NAV_NOISE, " ")
        .replace(/\s{2,}/g, " ")
        .replace(/^\s*[\u00b7·]\s*/g, "")
        .trim();
    }

    const collected = [];
    const seenLabels = new Set();

    for (const targetLabel of SECTION_PRIORITY) {
      for (const h2 of document.querySelectorAll("h2")) {
        const label = h2.textContent.trim().toLowerCase();
        if (!label.includes(targetLabel)) continue;
        if (seenLabels.has(label)) continue;
        seenLabels.add(label);
        const content = extractSection(h2);
        if (content) {
          const cleaned = cleanContent(content);
          if (cleaned.length > 10) collected.push(cleaned);
        }
      }
    }

    if (collected.length) {
      return collected.join(" | ").slice(0, 800);
    }

    return "";
  }


  /**
   * Find the listing location (City, ST format).
   */
  function findLocation() {
    const bodyText = document.body.innerText;

    const labeled = bodyText.match(/(?:Listed\s+in|Location)[:\s]+([A-Za-z\s]+,\s*[A-Z]{2})/);
    if (labeled) return labeled[1].trim();

    const cityState = bodyText.match(/\b([A-Z][a-zA-Z\s]{2,20}),\s+([A-Z]{2})\b/);
    if (cityState) return cityState[0].trim();

    return "";
  }


  /**
   * Find the seller's name.
   */
  function findSellerName() {
    const links = document.querySelectorAll("a[href*='/user/'], a[href*='/profile/']");
    for (const link of links) {
      const text = link.textContent.trim();
      if (text && text.length > 1 && text.length < 60 && !text.includes("Facebook")) {
        return text;
      }
    }
    return "";
  }


  /**
   * Find listing images.
   *
   * B-I2 + B-I2b FIX: Three-path image scoping strategy.
   * PATH A: listing dialog overlay → scope to dialog
   * PATH B: direct URL → walk UP from h1 to find photo gallery container
   * PATH C: fallback → document + alt-text relevance filter
   */
  function findListingImages() {
    const _IMG_NOISE = new Set(["marketplace", "notifications", "facebook", "search results"]);

    const listingDialog = [...document.querySelectorAll('[role="dialog"]')].find(
      dlg => [...dlg.querySelectorAll('h1')].some(
        h => !_IMG_NOISE.has(h.textContent.trim().toLowerCase()) && h.textContent.trim().length > 2
      )
    );

    let _imgRoot = null;

    if (listingDialog) {
      _imgRoot = listingDialog;
    } else {
      const listingH1 = [...document.querySelectorAll('h1')]
        .filter(h => h.textContent.trim().length > 2 && !_IMG_NOISE.has(h.textContent.trim().toLowerCase()))
        .reduce((best, h) => h.textContent.trim().length > (best?.textContent.trim().length || 0) ? h : best, null);

      if (listingH1) {
        let el = listingH1.parentElement;
        for (let depth = 0; depth < 30 && el && el !== document.documentElement; depth++) {
          const imgs = el.querySelectorAll("img[src*='fbcdn.net'][src*='t39.84726']");
          if (imgs.length >= 1 && imgs.length <= 8) {
            _imgRoot = el;
            break;
          }
          el = el.parentElement;
        }
      }
    }

    const usingDocFallback = !_imgRoot;
    if (usingDocFallback) _imgRoot = document;

    let titleWords = null;
    if (usingDocFallback) {
      const h1Text = [...document.querySelectorAll('h1')]
        .filter(h => !_IMG_NOISE.has(h.textContent.trim().toLowerCase()))
        .map(h => h.textContent.trim().toLowerCase())
        .sort((a, b) => b.length - a.length)[0] || '';
      titleWords = new Set(h1Text.split(/\s+/).filter(w => w.length > 3));
    }

    const seen       = new Set();
    const candidates = [];

    for (const img of _imgRoot.querySelectorAll("img[src*='fbcdn.net']")) {
      const src = img.src;
      if (!src.includes('_n.jpg'))    continue;
      if (!src.includes('t39.84726') && !src.includes('t45.84726')) continue;

      const w = img.naturalWidth  || img.width  || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 200 || h < 200) continue;

      if (usingDocFallback && titleWords && titleWords.size > 0) {
        const alt = (img.alt || '').toLowerCase();
        if (alt.length > 5) {
          const altWords = new Set(alt.split(/\s+/).filter(w => w.length > 3));
          const overlap = [...titleWords].some(w => altWords.has(w));
          if (!overlap) continue;
        }
      }

      if (!seen.has(src)) {
        seen.add(src);
        candidates.push({ src, w });
      }
    }

    candidates.sort((a, b) => b.w - a.w);
    return candidates.slice(0, 3).map(c => c.src);
  }

  /**
   * Extract seller trust signals from the DOM.
   */
  function extractSellerTrust() {
    const bodyText = document.body.innerText;
    const trust = {
      member_since:     null,
      review_count:     null,
      seller_rating:    null,
      is_highly_rated:  false,
      response_rate:    null,
      other_listings:   null,
      trust_tier:       "unknown",
    };

    const joined = bodyText.match(/Joined\s+Facebook\s+in\s+(\d{4})/i);
    if (joined) trust.member_since = `Jan ${joined[1]}`;

    const reviews = bodyText.match(/\((\d+)\)/g);
    if (reviews && reviews.length > 0) {
      const nums = reviews.map(r => parseInt(r.replace(/[()]/g, ""))).filter(n => n < 10000);
      if (nums.length > 0) trust.review_count = Math.min(...nums);
    }

    if (/highly\s+rated/i.test(bodyText)) {
      trust.is_highly_rated = true;
    }

    const starEl = document.querySelector("[aria-label*='out of 5 stars'], [aria-label*='out of 5 star']");
    if (starEl) {
      const ariaLabel = starEl.getAttribute("aria-label") || "";
      const ratingMatch = ariaLabel.match(/(\d+\.?\d*)\s+out of\s+5/);
      if (ratingMatch) trust.seller_rating = parseFloat(ratingMatch[1]);
    }

    if (trust.seller_rating === null) {
      if (trust.is_highly_rated) {
        trust.seller_rating = 4.8;
      } else if (trust.review_count && trust.review_count > 0) {
        trust.seller_rating = null;
      }
    }

    trust.trust_tier = computeTrustTier(trust);

    return trust;
  }

  function computeTrustTier(trust) {
    let score = 0;

    if (trust.is_highly_rated)             score += 3;
    if (trust.review_count >= 10)          score += 2;
    else if (trust.review_count >= 3)      score += 1;
    if (trust.member_since) {
      const year = parseInt((trust.member_since.match(/\d{4}/) || ["2024"])[0]);
      const age  = new Date().getFullYear() - year;
      if (age >= 3)      score += 2;
      else if (age >= 1) score += 1;
    }
    if (trust.seller_rating !== null) {
      if (trust.seller_rating >= 4.5)      score += 2;
      else if (trust.seller_rating >= 3.5) score += 1;
      else if (trust.seller_rating < 3.0)  score -= 2;
    }

    if (score >= 5) return "high";
    if (score >= 2) return "medium";
    return "unknown";
  }


  /**
   * Detect multi-item / bundle listings.
   */
  function detectMultiItem(title, description) {
    const text  = (title + " " + description).toLowerCase();
    const multi = [
      /\b(\d+)\s*[-–]?\s*(?:piece|pack|set|tool|item|pc|pcs)\b/,
      /\blot\s+of\s+\d+\b/,
      /\bcollection\s+of\b/,
      /\bkit\s+includes?\b/,
    ];
    for (const re of multi) {
      const m = text.match(re);
      if (m) {
        const n = parseInt(m[1] || "3");
        if (n >= 3) return true;
      }
    }
    return false;
  }


  /**
   * Detect vehicle listings — cars, trucks, motorcycles, ATVs, e-bikes, etc.
   */
  function detectVehicle(title, description) {
    const text = (title + " " + description).toLowerCase();

    const keywords = [
      " car ", " cars ", " truck ", " trucks ", " suv ", " van ", " minivan ",
      "sedan", "coupe", "hatchback", "convertible", "station wagon", "pickup truck",
      "crossover", "4x4", "4wd", "awd",
      "toyota", "honda", "ford", "chevrolet", "chevy", "dodge", "jeep",
      "nissan", "subaru", "hyundai", "kia", "mazda", "volkswagen", " vw ",
      "audi", "bmw", "mercedes", "lexus", "acura", "infiniti", "cadillac",
      "buick", "gmc", "pontiac", "chrysler", "tesla", "volvo",
      "lincoln", "mitsubishi",
      "camry", "corolla", "civic", "accord", "prius", "tacoma", "tundra",
      "highlander", "rav4", "sienna", "4runner",
      "f-150", "f150", "f-250", "f250", "mustang",
      "silverado", "colorado", "equinox", "tahoe", "suburban", "traverse",
      "impala", "cruze", "trax", "trailblazer",
      "altima", "sentra", "maxima", "rogue",
      "forester", "impreza", "crosstrek",
      "elantra", "sonata", "tucson", "santa fe", "sorento", "sportage",
      "wrangler", "grand cherokee", "durango", "challenger",
      "ram 1500", "ram 2500",
      "3 series", "5 series", "7 series", "x3", "x5",
      "a4", "a6", "q5", "q7",
      "c-class", "e-class", "glc",
      "motorcycle", "dirt bike", "motocross", "mx bike", "pit bike",
      "atv", "quad", "side by side", "utv", "go-kart", "gokart",
      "moped", "vespa",
      "surron", "sur-ron", "talaria", "super73", "super 73",
      "light bee", "storm bee", "ultra bee",
      "x160", "x260", "electric dirt bike", "electric moto",
      "cr250", "cr500", "crf", "kx250", "kx450", "yz450", "yz250",
      "rmz250", "rmz450", "ktm", "kawasaki motorcycle", "yamaha motorcycle",
      "honda dirt", "honda motorcycle",
      "60v bike", "72v bike", "48v bike",
    ];

    const sanitized = text
      .replace(/\bcar\s+seat(s)?\b/g, 'CARSEAT')
      .replace(/\bcar\s+charger(s)?\b/g, 'CARCHARGER')
      .replace(/\bcar\s+wash(es)?\b/g, 'CARWASH')
      .replace(/\bcar\s+audio\b/g, 'CARAUDIO')
      .replace(/\bcar\s+freshener(s)?\b/g, 'CARFRESHENER')
      .replace(/\b(toy|race|cable|tram|stock)\s+car(s)?\b/g, 'TOYCAR');

    if (keywords.some(kw => sanitized.includes(kw))) return true;

    const MAKES_RE = /toyota|honda|ford|chevy|chevrolet|dodge|jeep|nissan|subaru|hyundai|kia|mazda|vw|volkswagen|audi|bmw|mercedes|benz|lexus|acura|infiniti|cadillac|buick|gmc|pontiac|chrysler|lincoln|mitsubishi|tesla|volvo/i;
    const yearPattern = /\b(19[5-9]\d|20[0-2]\d|'[5-9]\d)\b/;
    if (yearPattern.test(text) && MAKES_RE.test(text)) return true;

    return false;
  }


  /**
   * Extract structured vehicle attributes from FBM's "About this vehicle" section.
   */
  function extractVehicleDetails() {
    const details = {};

    const allText = Array.from(document.querySelectorAll('span[dir=auto]'))
      .map(s => s.textContent.trim())
      .filter(t => t.length > 3 && t.length < 120);

    for (const t of allText) {
      const lower = t.toLowerCase();

      const mileMatch = t.match(/(\d[\d,]*(?:\.\d+)?[Kk]?)\s*miles?/i);
      if (mileMatch && !details.mileage) {
        const raw = mileMatch[1].replace(/,/g, "");
        const num = raw.toLowerCase().endsWith("k")
          ? parseFloat(raw) * 1000
          : parseFloat(raw);
        if (!isNaN(num) && num > 0 && num < 1000000) details.mileage = Math.round(num);
      }

      if (!details.transmission) {
        if (lower.includes("automatic")) details.transmission = "Automatic";
        else if (lower.includes("manual") || lower.includes("6-speed") || lower.includes("5-speed")) details.transmission = "Manual";
      }

      if (!details.fuel_type) {
        if (lower.includes("gasoline") || lower.includes("petrol")) details.fuel_type = "Gasoline";
        else if (lower.includes("diesel")) details.fuel_type = "Diesel";
        else if (lower.includes("electric") && lower.includes("fuel")) details.fuel_type = "Electric";
        else if (lower.includes("hybrid")) details.fuel_type = "Hybrid";
      }

      if (!details.title_status) {
        if (lower.includes("clean title")) details.title_status = "Clean";
        else if (lower.includes("salvage")) details.title_status = "Salvage";
        else if (lower.includes("rebuilt")) details.title_status = "Rebuilt";
        else if (lower.includes("lien")) details.title_status = "Lien";
      }

      const ownersMatch = t.match(/(\d+)\s+owner/i);
      if (ownersMatch && !details.owners) details.owners = parseInt(ownersMatch[1]);

      if (!details.paid_off && lower.includes("paid off")) details.paid_off = true;

      if (!details.drivetrain) {
        if (lower.includes("all-wheel") || lower.includes("awd")) details.drivetrain = "AWD";
        else if (lower.includes("four-wheel") || lower.includes("4wd") || lower.includes("4x4")) details.drivetrain = "4WD";
        else if (lower.includes("front-wheel") || lower.includes("fwd")) details.drivetrain = "FWD";
        else if (lower.includes("rear-wheel") || lower.includes("rwd")) details.drivetrain = "RWD";
      }
    }
    return Object.keys(details).length ? details : null;
  }


  /**
   * Master listing extraction — calls all the helpers above.
   */
  function extractListing() {
    const title       = findTitle();
    const { price, original: originalPrice } = findPrices();
    const description = findDescription();
    const condition   = findCondition();
    const location    = findLocation();
    const sellerName  = findSellerName();
    const images      = findListingImages();
    const sellerTrust = extractSellerTrust();
    const shippingCost = findShippingCost();

    const isMulti   = detectMultiItem(title, description);
    const isVehicle = detectVehicle(title, description);
    const vehicleDetails = isVehicle ? extractVehicleDetails() : null;

    return {
      title,
      price,
      raw_price_text:  formatPriceText(price, originalPrice),
      description,
      condition,
      location,
      seller_name:     sellerName,
      listing_url:     window.location.href,
      is_multi_item:   isMulti,
      is_vehicle:      isVehicle,
      seller_trust:    sellerTrust,
      original_price:  originalPrice || 0,
      shipping_cost:   shippingCost,
      image_urls:      images,
      vehicle_details: vehicleDetails || {},
    };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 2 — PRICE HISTORY (chrome.storage.local)
  // ═══════════════════════════════════════════════════════════════════════════

  const HISTORY_KEY_PREFIX = "ds_ph_";

  async function recordPriceHistory(listingUrl, price) {
    if (!price || !listingUrl) return;
    const key = HISTORY_KEY_PREFIX + btoa(listingUrl).slice(0, 40);
    try {
      const stored = await chrome.storage.local.get(key);
      const history = stored[key] || [];
      const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const last = history[history.length - 1];
      if (!last || last.price !== price || last.date !== today) {
        history.push({ price, date: today });
        if (history.length > 10) history.shift();
        await chrome.storage.local.set({ [key]: history });
      }
    } catch (e) {
      console.debug(LOG_PRE, "Price history write failed:", e);
    }
  }

  async function getPriceHistory(listingUrl) {
    if (!listingUrl) return [];
    const key = HISTORY_KEY_PREFIX + btoa(listingUrl).slice(0, 40);
    try {
      const stored = await chrome.storage.local.get(key);
      return stored[key] || [];
    } catch { return []; }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 3 — SEARCH RESULTS OVERLAY
  // ═══════════════════════════════════════════════════════════════════════════

  const OVERLAY_SCORES_KEY = "ds_scores";
  const isListingPage = () => /\/marketplace\/(item\/|\w+\/item\/)/.test(window.location.pathname);

  async function getSavedScores() {
    try {
      const r = await chrome.storage.local.get(OVERLAY_SCORES_KEY);
      return r[OVERLAY_SCORES_KEY] || {};
    } catch { return {}; }
  }

  async function saveScore(url, score, shouldBuy) {
    try {
      const scores = await getSavedScores();
      scores[url] = { score, shouldBuy, ts: Date.now() };
      const keys = Object.keys(scores);
      if (keys.length > 200) {
        keys.sort((a, b) => scores[a].ts - scores[b].ts).slice(0, 50).forEach(k => delete scores[k]);
      }
      await chrome.storage.local.set({ [OVERLAY_SCORES_KEY]: scores });
    } catch { /* ok */ }
  }

  async function injectSearchOverlay() {
    if (isListingPage()) return;
    const scores = await getSavedScores();

    const cards = document.querySelectorAll("a[href*='/marketplace/item/']");
    for (const card of cards) {
      if (card.dataset.dsOverlay) continue;
      card.dataset.dsOverlay = "1";

      const href = card.href.split("?")[0];
      const data = scores[href];

      const badge = document.createElement("div");
      badge.style.cssText = `
        position:absolute;top:6px;left:6px;z-index:9999;
        padding:2px 7px;border-radius:12px;font-size:11px;
        font-weight:700;color:#fff;pointer-events:none;
        font-family:system-ui,sans-serif;line-height:1.4;
      `;

      if (data) {
        badge.textContent = data.score;
        badge.style.background = data.shouldBuy ? "#22c55e" :
                                  data.score >= 5 ? "#f59e0b" : "#ef4444";
      } else {
        badge.textContent = "●";
        badge.style.background = "rgba(99,102,241,0.7)";
        badge.style.fontSize = "8px";
      }

      const parent = card.style.position ? card : card.parentElement;
      if (parent) {
        if (getComputedStyle(parent).position === "static") {
          parent.style.position = "relative";
        }
        parent.appendChild(badge);
      }
    }
  }

  if (!isListingPage()) {
    injectSearchOverlay();
    const overlayObserver = new MutationObserver(() => injectSearchOverlay());
    overlayObserver.observe(document.body, { childList: true, subtree: true });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 4 — SIDEBAR UI
  // ═══════════════════════════════════════════════════════════════════════════

  if (!document.getElementById("ds-styles")) {
    const style = document.createElement("style");
    style.id = "ds-styles";
    style.textContent = `
      #dealscout-root {
        position: fixed;
        bottom: 0;
        right: 0;
        z-index: 2147483647;
        width: 0;
        height: 0;
        pointer-events: none;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        color: #f1f5f9;
      }
      #ds-tab {
        position: absolute;
        bottom: 24px;
        right: 0;
        pointer-events: auto;
        background: #6366f1;
        color: #fff;
        padding: 10px 14px;
        border-radius: 10px 0 0 10px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 700;
        box-shadow: -2px 2px 10px rgba(0,0,0,0.3);
        user-select: none;
        touch-action: none;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: background 0.15s;
        white-space: nowrap;
      }
      #ds-tab:hover { background: #818cf8; }
      #ds-panel {
        position: absolute;
        bottom: 48px;
        right: 0;
        width: 310px;
        max-height: 85vh;
        background: #1e1b2e;
        border-radius: 12px 0 0 0;
        box-shadow: -4px 0 24px rgba(0,0,0,0.5);
        overflow-y: auto;
        overflow-x: hidden;
        display: none;
        pointer-events: auto;
        scrollbar-width: thin;
        scrollbar-color: #4c1d95 #1e1b2e;
      }
      #ds-panel.open { display: block; }
      .ds-header {
        background: #2d1b69;
        padding: 8px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        position: sticky;
        top: 0;
        z-index: 1;
        gap: 6px;
      }
      .ds-header-left {
        display: flex;
        align-items: center;
        gap: 5px;
        font-weight: 700;
        min-width: 0;
        flex-shrink: 1;
        white-space: nowrap;
        overflow: hidden;
      }
      .ds-header-badges {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .ds-close {
        cursor: pointer; font-size: 18px; opacity: 0.6;
        background: none; border: none; color: #fff; padding: 0;
      }
      .ds-close:hover { opacity: 1; }
      .ds-body { padding: 12px; }
      .ds-score-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
      .ds-score-circle {
        width: 52px; height: 52px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 22px; font-weight: 900; flex-shrink: 0;
        border: 2px solid rgba(255,255,255,0.2);
      }
      .ds-verdict { font-size: 11px; opacity: 0.8; }
      .ds-buy-badge {
        display: inline-block; padding: 2px 9px; border-radius: 12px;
        font-size: 11px; font-weight: 700; margin-bottom: 4px;
      }
      .ds-summary { font-size: 12px; opacity: 0.85; margin: 8px 0; }
      .ds-section { margin: 10px 0; }
      .ds-section-title {
        font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
        text-transform: uppercase; opacity: 0.5; margin-bottom: 6px;
      }
      .ds-price-row {
        display: flex; justify-content: space-between;
        font-size: 12px; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .ds-price-row:last-child { border: none; }
      .ds-price-label { opacity: 0.65; }
      .ds-over   { color: #f87171; }
      .ds-under  { color: #4ade80; }
      .ds-flags { list-style: none; padding: 0; margin: 4px 0; }
      .ds-flags li { font-size: 12px; margin: 3px 0; padding-left: 4px; }
      .ds-offer {
        background: rgba(99,102,241,0.15);
        border: 1px solid rgba(99,102,241,0.3);
        border-radius: 8px; padding: 8px 12px; margin: 8px 0;
        font-size: 13px; display: flex; justify-content: space-between; align-items: center;
      }
      .ds-offer-price { font-size: 20px; font-weight: 800; color: #818cf8; }
      .ds-tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .ds-tab-btn {
        flex: 1; padding: 6px 4px; font-size: 11px; font-weight: 600;
        background: none; border: none; color: rgba(255,255,255,0.5);
        cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s;
      }
      .ds-tab-btn.active { color: #fff; border-bottom-color: #6366f1; }
      .ds-ebay-card {
        display: flex; align-items: center; gap: 8px; padding: 7px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06); cursor: pointer;
        text-decoration: none; color: inherit;
      }
      .ds-ebay-card:hover { opacity: 0.8; }
      .ds-ebay-card:last-child { border: none; }
      .ds-ebay-thumb {
        width: 36px; height: 36px; object-fit: cover;
        border-radius: 4px; flex-shrink: 0; background: #2d1b69;
        display: flex; align-items: center; justify-content: center; font-size: 16px;
      }
      .ds-ebay-thumb img { width: 100%; height: 100%; object-fit: cover; border-radius: 4px; }
      .ds-ebay-info { flex: 1; min-width: 0; }
      .ds-ebay-title { font-size: 11px; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ds-ebay-price { font-size: 12px; font-weight: 700; color: #a78bfa; }
      .ds-ebay-cond { font-size: 10px; opacity: 0.5; }
      .ds-search-links { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
      .ds-link-btn {
        padding: 4px 9px; border-radius: 6px; font-size: 11px; font-weight: 600;
        text-decoration: none; color: #fff; background: rgba(255,255,255,0.1);
        cursor: pointer; border: none; white-space: nowrap;
      }
      .ds-link-btn:hover { background: rgba(255,255,255,0.18); }
      .ds-affiliate-card {
        display: flex; align-items: center; gap: 8px;
        padding: 9px 8px; border-radius: 8px;
        background: rgba(255,255,255,0.05); margin-bottom: 6px;
        cursor: pointer; border: 1px solid rgba(255,255,255,0.08);
        text-decoration: none; color: inherit; transition: background 0.15s;
      }
      .ds-affiliate-card:hover { background: rgba(255,255,255,0.11); border-color: rgba(255,255,255,0.18); }
      .ds-aff-badge {
        font-size: 10px; padding: 3px 7px; border-radius: 5px;
        font-weight: 700; flex-shrink: 0; white-space: nowrap; color: #fff;
        min-width: 52px; text-align: center;
      }
      .ds-aff-text { flex: 1; min-width: 0; }
      .ds-aff-title { font-size: 11px; font-weight: 600; opacity: 0.92; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ds-aff-sub { font-size: 10px; opacity: 0.55; margin-top: 1px; }
      .ds-aff-reason { font-size: 10px; opacity: 0.4; font-style: italic; margin-top: 1px; }
      .ds-aff-arrow { font-size: 14px; opacity: 0.35; flex-shrink: 0; }
      .ds-suggestion-card {
        display: flex; align-items: center; gap: 8px;
        padding: 8px; border-radius: 8px;
        background: rgba(255,255,255,0.05); margin-bottom: 6px;
        cursor: pointer; border: 1px solid rgba(255,255,255,0.08);
        text-decoration: none; color: inherit;
      }
      .ds-suggestion-card:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.15); }
      .ds-suggestion-badge {
        font-size: 10px; padding: 2px 6px; border-radius: 4px;
        font-weight: 700; flex-shrink: 0; white-space: nowrap;
      }
      .ds-suggestion-text { flex: 1; min-width: 0; }
      .ds-suggestion-title { font-size: 11px; opacity: 0.9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ds-suggestion-reason { font-size: 10px; opacity: 0.55; }
      .ds-suggestion-price { font-size: 12px; font-weight: 700; color: #a78bfa; }
      .ds-reliability {
        padding: 8px 10px; border-radius: 8px; margin: 8px 0;
        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
      }
      .ds-loading { text-align: center; padding: 20px; opacity: 0.6; font-size: 13px; }
      .ds-loading::after { content: ""; animation: ds-dots 1.2s infinite; }
      @keyframes ds-dots { 0%{content:"."} 33%{content:".."} 66%{content:"..."} }
      .ds-error { color: #f87171; font-size: 12px; padding: 8px; }
      .ds-seller-trust {
        font-size: 11px; opacity: 0.7;
        padding: 6px 8px; border-radius: 6px;
        background: rgba(255,255,255,0.04); margin: 6px 0;
      }
      .ds-version { font-size: 9px; opacity: 0.4; }
      .ds-photo-badge {
        font-size: 10px; background: rgba(99,102,241,0.3);
        border-radius: 4px; padding: 1px 5px; margin-left: 4px;
      }
      .ds-data-source {
        font-size: 9px; padding: 1px 5px; border-radius: 4px;
        margin-left: 4px; font-weight: 600;
      }
      .ds-shipping-note {
        font-size: 11px; color: #fbbf24; margin: 4px 0;
      }
      /* ── Buy-New Parity Banner — primary revenue trigger ── */
      .ds-parity-banner {
        position: relative; overflow: hidden;
        background: linear-gradient(135deg, #1e1b4b 0%, #312e81 60%, #1e3a5f 100%);
        border: 1px solid rgba(129,140,248,0.5);
        border-radius: 10px; padding: 10px 12px 10px 12px;
        margin-bottom: 10px; cursor: default;
      }
      /* Animated shimmer sweep — draws the eye */
      .ds-parity-banner::before {
        content: ''; position: absolute;
        top: -50%; left: -75%; width: 50%; height: 200%;
        background: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.06) 50%, transparent 80%);
        animation: ds-shimmer 3s infinite linear;
        pointer-events: none;
      }
      @keyframes ds-shimmer { 0% { left: -75%; } 100% { left: 125%; } }
      .ds-parity-top {
        display: flex; align-items: center; gap: 7px; margin-bottom: 7px;
      }
      .ds-parity-badge {
        background: linear-gradient(135deg, #f59e0b, #ef4444);
        color: #fff; font-size: 9px; font-weight: 800; letter-spacing: 0.5px;
        padding: 2px 6px; border-radius: 4px; text-transform: uppercase; flex-shrink: 0;
      }
      .ds-parity-headline {
        font-size: 12px; font-weight: 700; color: #e0e7ff; flex: 1;
      }
      .ds-parity-prices {
        display: flex; gap: 6px; align-items: center; margin-bottom: 9px;
      }
      .ds-parity-price-used {
        font-size: 11px; color: rgba(255,255,255,0.45);
        text-decoration: line-through;
      }
      .ds-parity-price-arrow {
        font-size: 10px; color: #f59e0b;
      }
      .ds-parity-price-new {
        font-size: 13px; font-weight: 800; color: #a5f3fc;
      }
      .ds-parity-price-delta {
        font-size: 10px; color: #86efac;
        background: rgba(134,239,172,0.12);
        border-radius: 4px; padding: 1px 5px;
      }
      .ds-parity-cta {
        display: flex; align-items: center; justify-content: center; gap: 6px;
        background: linear-gradient(135deg, #f59e0b, #f97316);
        color: #000; font-size: 12px; font-weight: 800;
        border-radius: 7px; padding: 7px 10px;
        text-decoration: none; letter-spacing: 0.2px;
        transition: filter 0.15s ease; border: none; width: 100%; cursor: pointer;
        box-shadow: 0 2px 8px rgba(249,115,22,0.35);
      }
      .ds-parity-cta:hover { filter: brightness(1.1); }
      .ds-parity-cta-sub {
        font-size: 9px; color: rgba(255,255,255,0.4);
        text-align: center; margin-top: 5px;
      }
      .ds-section-parity { border-left: 3px solid #6366f1; padding-left: 8px; }
    `;
    document.head.appendChild(style);
  }


  let root, tab, panel;

  function ensureSidebarDOM() {
    if (root) return;

    root = document.createElement("div");
    root.id = "dealscout-root";

    tab = document.createElement("div");
    tab.id = "ds-tab";
    tab.innerHTML = "&#x1F6D2; Deal Scout";

    panel = document.createElement("div");
    panel.id = "ds-panel";

    root.appendChild(tab);
    root.appendChild(panel);

    document.documentElement.appendChild(root);

    makeDraggable(tab, root);

    tab.addEventListener("click", () => {
      panel.classList.toggle("open");
    });

    restorePosition();
  }


  function makeDraggable(handle, container) {
    let startX, startY, startTop, startLeft;
    let wasDragged = false;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();

      const rect = container.getBoundingClientRect();
      container.style.bottom = "auto";
      container.style.right  = "auto";
      container.style.top    = rect.top + "px";
      container.style.left   = rect.left + "px";

      startX    = e.clientX;
      startY    = e.clientY;
      startTop  = rect.top;
      startLeft = rect.left;
      wasDragged = false;

      if (panel) panel.style.pointerEvents = "none";
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasDragged = true;

      const newTop  = Math.max(80, Math.min(startTop  + dy, window.innerHeight));
      const newLeft = Math.max(0,  Math.min(startLeft + dx, window.innerWidth));
      container.style.top  = newTop  + "px";
      container.style.left = newLeft + "px";
    });

    const endDrag = (e) => {
      if (panel) panel.style.pointerEvents = "";
      if (!wasDragged) return;
      const top  = parseInt(container.style.top  || 0);
      const left = parseInt(container.style.left || 0);
      chrome.storage.local.set({ ds_sidebar_pos: { top, left } }).catch(() => {});
      e.preventDefault();
    };

    handle.addEventListener("pointerup",          endDrag);
    handle.addEventListener("lostpointercapture", endDrag);
  }

  async function restorePosition() {
    try {
      const stored = await chrome.storage.local.get("ds_sidebar_pos");
      if (!stored.ds_sidebar_pos) return;

      let { top, left } = stored.ds_sidebar_pos;

      const isValid = (v) => typeof v === "number" && isFinite(v) && v >= 0;
      if (!isValid(top) || !isValid(left)) {
        chrome.storage.local.remove("ds_sidebar_pos").catch(() => {});
        return;
      }

      top  = Math.max(80, Math.min(top,  window.innerHeight));
      left = Math.max(0,  Math.min(left, window.innerWidth));

      root.style.top    = top  + "px";
      root.style.left   = left + "px";
      root.style.bottom = "auto";
      root.style.right  = "auto";
    } catch { /* ok */ }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 5 — RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  function showLoading() {
    ensureSidebarDOM();
    panel.classList.add("open");
    panel.innerHTML = `
      <div class="ds-header">
        <div class="ds-header-left">&#x1F6D2; Deal Scout</div>
        <button class="ds-close">&#x2715;</button>
      </div>
      <div class="ds-body">
        <div id="ds-preflight-warnings" style="display:none;padding:4px 0 2px 0"></div>
        <div class="ds-loading">Analyzing deal</div>
      </div>`;
    panel.querySelector(".ds-close").addEventListener("click", () => panel.classList.remove("open"));
  }

  function showError(msg) {
    ensureSidebarDOM();
    panel.innerHTML = `
      <div class="ds-header">
        <div class="ds-header-left">&#x1F6D2; Deal Scout</div>
        <button class="ds-close">&#x2715;</button>
      </div>
      <div class="ds-body">
        <div class="ds-error">&#x26A0;&#xFE0F; ${escHtml(msg)}</div>
      </div>`;
    panel.querySelector(".ds-close").addEventListener("click", () => panel.classList.remove("open"));
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function scoreColor(score) {
    if (score >= 7) return "#22c55e";
    if (score >= 5) return "#fbbf24";
    return "#ef4444";
  }

  function getCraigslistUrl(location, title) {
    const query = encodeURIComponent(title.slice(0, 40));
    const city  = (location || "").toLowerCase().replace(/[^a-z]/g, "");
    const cityMap = {
      sandiego:"sandiego",sanfrancisco:"sfbay",losangeles:"losangeles",
      chicago:"chicago",newyork:"newyork",seattle:"seattle",
      portland:"portland",denver:"denver",phoenix:"phoenix",
      dallas:"dallas",houston:"houston",austin:"austin",
      miami:"miami",atlanta:"atlanta",boston:"boston",
      philadelphia:"philadelphia",detroit:"detroit",
    };
    const cl = cityMap[city] || "craigslist";
    return `https://${cl}.craigslist.org/search/sss?query=${query}`;
  }


  function renderScore(r, listing) {
    ensureSidebarDOM();
    panel.innerHTML = "";

    const buyLabel  = r.score >= 7 ? "&#x2705; BUY" : r.score >= 4 ? "&#x26A0;&#xFE0F; CAUTION" : "&#x274C; AVOID";
    const buyColor  = r.score >= 7 ? "#22c55e"      : r.score >= 4 ? "#f59e0b"                  : "#ef4444";
    const dataColor = r.data_source === "ebay"                    ? "#22c55e" :
                      r.data_source === "google_shopping"          ? "#60a5fa" :
                      r.data_source === "vehicle_not_applicable"   ? "#f59e0b" :
                      r.data_source === "cargurus"                 ? "#22c55e" :
                      r.data_source === "craigslist"               ? "#a78bfa" :
                      r.data_source === "google+ebay"              ? "#60a5fa" :
                      r.data_source === "ebay_mock"                ? "#94a3b8" :
                      "#fbbf24";
    const dataLabel = r.data_source === "ebay"                    ? "&#x1F4CA; Live eBay" :
                      r.data_source === "google_shopping"          ? "&#x1F50D; Google Shopping" :
                      r.data_source === "vehicle_not_applicable"   ? "&#x1F697; No data" :
                      r.data_source === "cargurus"                 ? "&#x1F697; CarGurus" :
                      r.data_source === "craigslist"               ? "&#x1F697; Craigslist" :
                      r.data_source === "google+ebay"              ? "&#x1F50D; Google+eBay" :
                      r.data_source === "ebay_mock"                ? "&#x1F4CA; Est. prices" :
                      "&#x26A0;&#xFE0F; Est. prices";

    const photoTag  = r.image_analyzed ? `<span class="ds-photo-badge">&#x1F4F7; photo</span>` : "";
    const dataTag   = `<span class="ds-data-source" style="background:rgba(255,255,255,0.08);color:${dataColor}">${dataLabel}</span>`;

    const diff   = listing.price - r.estimated_value;
    const pct    = r.estimated_value > 0 ? Math.abs(diff / r.estimated_value * 100).toFixed(0) : "?";
    const diffEl = diff > 0
      ? `<span class="ds-over">&#x1F534; $${Math.abs(diff).toFixed(0)} over market (+${pct}%)</span>`
      : `<span class="ds-under">&#x1F7E2; $${Math.abs(diff).toFixed(0)} below market (-${pct}%)</span>`;

    const shippingNote = r.shipping_cost > 0
      ? `<div class="ds-shipping-note">&#x1F69A; +$${r.shipping_cost.toFixed(2)} shipping = <strong>$${(listing.price + r.shipping_cost).toFixed(2)} total</strong></div>`
      : "";

    const origNote = r.original_price > 0 && r.original_price > listing.price
      ? `<div style="font-size:11px;opacity:0.6;margin-bottom:4px">
           <del>$${r.original_price.toLocaleString()}</del> &#x25BC; reduced $${(r.original_price - listing.price).toFixed(0)}
         </div>` : "";

    const trust = listing.seller_trust || {};
    const trustParts = [];
    if (trust.member_since)   trustParts.push(`&#x1F4C5; ${trust.member_since}`);
    if (trust.review_count)   trustParts.push(`(${trust.review_count} reviews)`);
    if (trust.is_highly_rated) trustParts.push(`&#x1F3C5; Highly rated`);
    if (trust.seller_rating)  trustParts.push(`${trust.seller_rating}/5 stars`);
    const trustLine = trustParts.length
      ? trustParts.join(" &middot; ")
      : "&#x1F464; Limited seller info";

    const greenFlags = (r.green_flags || []).map(f => `<li>&#x2705; ${escHtml(f)}</li>`).join("");
    const redFlags   = (r.red_flags   || []).map(f => `<li>&#x26A0;&#xFE0F; ${escHtml(f)}</li>`).join("");

    const productInfo   = r.product_info || {};
    const scoredAsLine  = productInfo.display_name && productInfo.display_name !== listing.title
      ? `<div style="font-size:10px;opacity:0.5;margin-top:4px">
           &#x1F50E; Scored as: ${escHtml(productInfo.display_name)} &middot; ${escHtml(productInfo.confidence || "medium")} confidence
         </div>` : "";

    const header = document.createElement("div");
    header.className = "ds-header";
    header.innerHTML = `
      <div class="ds-header-left">
        &#x1F6D2; <span>Deal Scout</span>
        <span class="ds-version">v${VERSION}</span>
      </div>
      <div class="ds-header-badges">
        ${photoTag}${dataTag}
      </div>
      <button class="ds-close" style="flex-shrink:0">&#x2715;</button>`;
    panel.appendChild(header);
    header.querySelector(".ds-close").addEventListener("click", () => panel.classList.remove("open"));

    const body = document.createElement("div");
    body.className = "ds-body";
    body.innerHTML = `
      <div class="ds-score-row">
        <div class="ds-score-circle" style="background:${scoreColor(r.score)}22;border-color:${scoreColor(r.score)}">
          <span style="color:${scoreColor(r.score)}">${r.score}</span>
        </div>
        <div>
          <div class="ds-buy-badge" style="background:${buyColor}22;color:${buyColor}">${buyLabel}</div>
          <div class="ds-verdict">${escHtml(r.verdict)}</div>
        </div>
      </div>

      <div class="ds-summary">${escHtml(r.summary)}</div>

      ${origNote}
      ${shippingNote}

      <div class="ds-section">
        <div class="ds-section-title">&#x1F4CA; Market Comparison</div>
        ${r.data_source === 'vehicle_not_applicable' ? `
          <div style="font-size:12px;color:#f59e0b;padding:6px 0;line-height:1.5">
            &#x26A0;&#xFE0F; eBay &amp; Google return <strong>parts prices</strong> for vehicles — not actual vehicle values.
          </div>
          <div style="font-size:11px;opacity:0.7;margin-top:4px">Check these for accurate comps:</div>
          <div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">
            <a href="https://www.kbb.com/used-cars/" target="_blank" style="color:#818cf8;font-size:12px">&#x1F4B0; KBB &#x2014; Private Party Value</a>
            <a href="https://www.carfax.com/vehicle-history-reports" target="_blank" style="color:#818cf8;font-size:12px">&#x1F4CB; Carfax &#x2014; Vehicle History</a>
            <a href="https://www.cargurus.com" target="_blank" style="color:#818cf8;font-size:12px">&#x1F50D; CarGurus &#x2014; Local Comps</a>
          </div>
          <div class="ds-price-row" style="margin-top:8px"><span class="ds-price-label">Listed price</span><strong>$${listing.price?.toFixed(0) || 0}</strong></div>
        ` : (r.data_source === 'cargurus' || r.data_source === 'craigslist') ? `
          <div style="font-size:11px;opacity:0.6;margin-bottom:6px">
            ${r.data_source === 'cargurus' ? '&#x1F50D; CarGurus \u2014 comparable listings near you' : '&#x1F50D; Craigslist \u2014 local private-party comps'}
          </div>
          <div class="ds-price-row"><span class="ds-price-label">Market avg</span><span>$${r.active_avg?.toFixed(0) || 0}</span></div>
          <div class="ds-price-row"><span class="ds-price-label">Price range</span><span style="font-size:11px;opacity:0.8">$${r.active_low?.toFixed(0) || 0} &#x2013; $${r.sold_high?.toFixed(0) || 0}</span></div>
          <div class="ds-price-row"><span class="ds-price-label">Listed price</span><strong>$${listing.price?.toFixed(0) || 0}</strong></div>
          <div style="margin-top:6px;font-size:12px;">${diffEl}</div>
          <div style="font-size:10px;opacity:0.4;margin-top:3px">
            ${escHtml(r.market_confidence || 'low')} confidence &#x00b7; ${r.sold_count || 0} comps
          </div>
          <div style="margin-top:7px;display:flex;gap:10px">
            <a href="https://www.kbb.com/used-cars/" target="_blank" style="color:#818cf8;font-size:10px">&#x1F4B0; KBB</a>
            <a href="https://www.carfax.com/vehicle-history-reports" target="_blank" style="color:#818cf8;font-size:10px">&#x1F4CB; Carfax</a>
          </div>
        ` : `
          ${(()=>{
            // Use source-accurate labels — Google Shopping is primary,
            // so showing "eBay sold avg" when Google won is misleading.
            const isGoogle   = r.data_source === 'google_shopping' || r.data_source === 'google+ebay';
            const isEbayMock = r.data_source === 'ebay_mock';
            const soldLabel   = isGoogle ? 'Market avg (sold)'   : isEbayMock ? 'Est. sold avg'   : 'eBay sold avg';
            const activeLabel = isGoogle ? 'Market avg (active)' : isEbayMock ? 'Est. active avg' : 'eBay active avg';
            const compSource  = isGoogle ? 'Google Shopping'     : isEbayMock ? 'estimated'       : 'eBay';
            const suspectStyle = r.market_confidence === 'suspect' ? 'color:#f59e0b;opacity:1' : 'opacity:0.4';
            const confLine = r.market_confidence === 'suspect'
              ? '&#x26A0;&#xFE0F; comps may be inaccurate — verify manually'
              : `${escHtml(r.market_confidence || 'low')} confidence · ${r.sold_count || 0} ${compSource} comps`;
            return `
              <div class="ds-price-row"><span class="ds-price-label">${soldLabel}</span><span>$${r.sold_avg?.toFixed(0) || 0}</span></div>
              <div class="ds-price-row"><span class="ds-price-label">${activeLabel}</span><span>$${r.active_avg?.toFixed(0) || 0}</span></div>
              <div class="ds-price-row"><span class="ds-price-label">New retail</span><span>$${r.new_price?.toFixed(0) || 0}</span></div>
              <div class="ds-price-row"><span class="ds-price-label">Listed price</span><strong>$${listing.price?.toFixed(0) || 0}</strong></div>
              <div style="margin-top:6px;font-size:12px;">${diffEl}</div>
              <div style="font-size:10px;margin-top:3px;${suspectStyle}">${confLine}</div>
            `;
          })()}
        `}
      </div>

      <div class="ds-seller-trust">&#x1F464; ${trustLine}</div>

      <div class="ds-section">
        <ul class="ds-flags">${greenFlags}${redFlags}</ul>
      </div>

      <div class="ds-offer">
        <span>Recommended offer</span>
        <span class="ds-offer-price" id="ds-tmp-offer"></span>
      </div>
      ${scoredAsLine}
    `;
    const _offerEl = body.querySelector('#ds-tmp-offer');
    if (_offerEl) {
      if (r.recommended_offer === -1) {
        _offerEl.textContent = '\uD83D\uDEAB Not recommended';
      } else {
        _offerEl.textContent = '$' + Math.round(r.recommended_offer || 0);
      }
    }
    panel.appendChild(body);

    renderSecurityScore(r, body);
    renderBuyNewBanner(r, body);
    renderAffiliateCards(r, listing, body);
    renderReliability(r, body);
    renderQueryFeedback(r, listing, body);
  }


  /**
   * Inline "Fix comps" button + form at the bottom of every scored listing.
   *
   * WHY IN-SIDEBAR:
   *   The sidebar already has the listing title and the exact query used.
   *   Going to /admin to correct a bad query adds 5+ steps. This reduces
   *   it to: see bad comp → click Fix → type correct query → Save.
   *   Corrections take effect immediately on the next score — no redeploy.
   *
   * DATA FLOW:
   *   r.query_used  → pre-filled as the "bad" query (what was used)
   *   listing.title → sent as listing_title so fuzzy matching works
   *   user input    → sent as good_query to POST /feedback
   */
  function renderQueryFeedback(r, listing, container) {
    // Don't show for vehicles — they use a different pricing pipeline
    if (!r.query_used || r.data_source === 'vehicle_not_applicable') return;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.07)';

    // ── Collapsed state: just the Fix button ──────────────────────────────
    const fixBtn = document.createElement('button');
    fixBtn.textContent = '📊 Fix market comps';
    fixBtn.style.cssText = [
      'background:none',
      'border:none',
      'color:rgba(255,255,255,0.35)',
      'font-size:10px',
      'cursor:pointer',
      'padding:0',
      'text-decoration:underline',
      'text-underline-offset:2px',
    ].join(';');

    // ── Expanded state: inline correction form ────────────────────────────
    const form = document.createElement('div');
    form.style.cssText = 'display:none;margin-top:8px';
    form.innerHTML = `
      <div style="font-size:10px;opacity:0.5;margin-bottom:6px;line-height:1.5">
        Tell Deal Scout a better eBay search query for this item.<br>
        Applies immediately — no redeploy needed.
      </div>
      <div style="font-size:10px;opacity:0.4;margin-bottom:3px">Current query used:</div>
      <div style="font-size:11px;color:#f59e0b;margin-bottom:8px;word-break:break-all">${escHtml(r.query_used)}</div>
      <div style="font-size:10px;opacity:0.4;margin-bottom:3px">Better eBay search query:</div>
      <input id="ds-fix-query"
        placeholder="e.g. Taylor 114ce acoustic guitar"
        style="
          width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);
          border:1px solid rgba(255,255,255,0.15);border-radius:6px;
          color:#e0e0e0;font-size:11px;padding:6px 8px;outline:none;
          font-family:inherit;
        "
      />
      <div style="display:flex;gap:6px;margin-top:6px">
        <button id="ds-fix-save" style="
          flex:1;background:#6366f1;color:#fff;border:none;border-radius:6px;
          padding:6px;font-size:11px;cursor:pointer;font-weight:600;
        ">Save correction</button>
        <button id="ds-fix-cancel" style="
          background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.5);
          border:none;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;
        ">Cancel</button>
      </div>
      <div id="ds-fix-status" style="font-size:10px;margin-top:5px;min-height:14px"></div>
    `;

    wrap.appendChild(fixBtn);
    wrap.appendChild(form);
    container.appendChild(wrap);

    // ── Event handlers ─────────────────────────────────────────────────────
    fixBtn.addEventListener('click', () => {
      form.style.display = 'block';
      fixBtn.style.display = 'none';
      const inp = form.querySelector('#ds-fix-query');
      inp.value = r.query_used; // pre-fill with what was used
      inp.focus();
      inp.select();
    });

    form.querySelector('#ds-fix-cancel').addEventListener('click', () => {
      form.style.display = 'none';
      fixBtn.style.display = 'inline';
    });

    form.querySelector('#ds-fix-save').addEventListener('click', async () => {
      const goodQuery  = form.querySelector('#ds-fix-query').value.trim();
      const statusEl   = form.querySelector('#ds-fix-status');
      const saveBtn    = form.querySelector('#ds-fix-save');

      if (!goodQuery || goodQuery === r.query_used) {
        statusEl.style.color = '#f59e0b';
        statusEl.textContent = goodQuery === r.query_used
          ? '⚠️ Query is the same — enter a different search term'
          : '⚠️ Please enter a query first';
        return;
      }

      saveBtn.textContent  = 'Saving…';
      saveBtn.disabled     = true;
      statusEl.textContent = '';

      try {
        const resp = await fetch(`${API_BASE}/feedback`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            listing_title: listing.title || '',
            bad_query:     r.query_used,
            good_query:    goodQuery,
            notes:         'submitted from sidebar',
          }),
        });

        if (resp.ok) {
          statusEl.style.color = '#22c55e';
          statusEl.textContent  = '✅ Saved! Next score for similar items will use the new query.';
          saveBtn.textContent   = '✓ Saved';
          // Collapse after 3 seconds
          setTimeout(() => {
            form.style.display  = 'none';
            fixBtn.style.display = 'inline';
            fixBtn.textContent  = '✅ Comp fixed';
            fixBtn.style.color  = 'rgba(34,197,94,0.6)';
          }, 3000);
        } else {
          throw new Error(`HTTP ${resp.status}`);
        }
      } catch (err) {
        statusEl.style.color = '#ef4444';
        statusEl.textContent = `❌ Save failed: ${err.message}`;
        saveBtn.textContent  = 'Save correction';
        saveBtn.disabled     = false;
      }
    });

    // Submit on Enter key in the input
    form.querySelector('#ds-fix-query').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') form.querySelector('#ds-fix-save').click();
    });
  }


  function renderSecurityScore(r, container) {
    const sec = r.security_score;
    if (!sec) return;
    if (sec.risk_level === "unknown" && !sec.flags?.length && !sec.layer1_flags?.length) return;

    const riskConfig = {
      low:      { color: "#22c55e", bg: "rgba(34,197,94,0.1)",  border: "rgba(34,197,94,0.3)",  shield: "\uD83D\uDEE1\uFE0F", label: "LOW RISK" },
      medium:   { color: "#f59e0b", bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.3)", shield: "\u26A0\uFE0F",    label: "CAUTION" },
      high:     { color: "#f97316", bg: "rgba(249,115,22,0.12)",border: "rgba(249,115,22,0.4)", shield: "\u26A0\uFE0F",    label: "HIGH RISK" },
      critical: { color: "#ef4444", bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.5)",  shield: "\u274C",         label: "LIKELY SCAM" },
    };
    const cfg = riskConfig[sec.risk_level] || riskConfig.medium;

    const section = document.createElement("div");
    section.className = "ds-section ds-security";
    section.style.cssText = [
      `background:${cfg.bg}`,
      `border:1px solid ${cfg.border}`,
      "border-radius:10px",
      "padding:10px 12px",
      "margin-bottom:8px",
    ].join(";");

    const hdr = document.createElement("div");
    hdr.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px";
    hdr.innerHTML = `
      <span style="font-size:16px">${cfg.shield}</span>
      <span style="font-weight:700;font-size:12px;color:${cfg.color};flex:1">${cfg.label}</span>
      <span style="font-size:11px;font-weight:700;background:${cfg.color};color:#000;padding:2px 7px;border-radius:10px">${sec.score}/10</span>
    `;
    section.appendChild(hdr);

    const rec = document.createElement("div");
    rec.style.cssText = `font-size:11px;color:${cfg.color};font-weight:600;margin-bottom:5px`;
    rec.textContent = (sec.recommendation || "").replace(/\b\w/g, c => c.toUpperCase());
    section.appendChild(rec);

    const flags = sec.flags || [];
    if (flags.length) {
      const ul = document.createElement("div");
      ul.style.cssText = "font-size:10.5px;line-height:1.6;opacity:0.85";
      flags.forEach(flag => {
        const li = document.createElement("div");
        li.style.cssText = "display:flex;gap:5px;align-items:flex-start";
        li.innerHTML = `<span style="color:${cfg.color};flex-shrink:0">•</span><span>${escHtml(flag)}</span>`;
        ul.appendChild(li);
      });
      section.appendChild(ul);
    }

    const itemRisks = sec.item_risks || [];
    if (itemRisks.length) {
      const riskDiv = document.createElement("div");
      riskDiv.style.cssText = "margin-top:5px;font-size:10px;opacity:0.6;font-style:italic";
      riskDiv.textContent = "Item risks: " + itemRisks.join(" · ");
      section.appendChild(riskDiv);
    }

    container.appendChild(section);
  }


  function renderBuyNewBanner(r, container) {
    if (!r.buy_new_trigger || !r.buy_new_message) return;

    const banner = document.createElement("div");
    banner.style.cssText = [
      "background:#fef3c7",
      "border:1px solid #fbbf24",
      "border-radius:8px",
      "padding:8px 10px",
      "margin:8px 0",
      "font-size:11px",
      "color:#92400e",
      "line-height:1.4",
    ].join(";");
    banner.textContent = r.buy_new_message;
    container.appendChild(banner);
  }


  function fireAffiliateEvent(card, r) {
    try {
      chrome.runtime.sendMessage({
        type:         "AFFILIATE_CLICK",
        program:      card.program_key   || "",
        category:     r.category_detected || "",
        price_bucket: card.price_bucket  || "",
        card_type:    card.card_type     || "",
        deal_score:   r.score            || 0,
      });
    } catch { /* non-critical */ }
  }


  function renderAffiliateCards(r, listing, container) {
    const cards = r.affiliate_cards || [];

    const newRetail   = r.new_price   || 0;
    const listedPrice = listing.price || 0;
    const parityRatio = (newRetail > 0 && listedPrice > 0) ? listedPrice / newRetail : 0;
    const isDealParity = parityRatio >= 0.65;
    const newPremium   = newRetail - listedPrice;

    const section = document.createElement("div");
    section.className = isDealParity ? "ds-section ds-section-parity" : "ds-section";

    const titleDiv = document.createElement("div");
    titleDiv.className = "ds-section-title";
    titleDiv.innerHTML = "&#x1F6CD;&#xFE0F; Where to Buy";
    section.appendChild(titleDiv);

    if (isDealParity && newRetail > 0) {
      // Build Amazon affiliate URL for the CTA button
      // WHY AMAZON: highest conversion rate + fastest shipping expectation.
      // We put the direct CTA here — not buried in the cards below — because
      // this is the highest-intent moment: user already sees the used price
      // isn't much cheaper than new.
      const q          = encodeURIComponent((r.product_info?.display_name || listing.title || "").slice(0, 60));
      const amzUrl     = `https://www.amazon.com/s?k=${q}&tag=dealscout03f-20`;
      const deltaText  = newPremium > 0
        ? `+${newPremium.toFixed(0)} for brand new`
        : `same price as used`;
      const headline   = newPremium > 0
        ? `Only ${newPremium.toFixed(0)} more gets you brand new`
        : `New is the same price — why buy used?`;

      const banner = document.createElement("div");
      banner.className = "ds-parity-banner";
      banner.innerHTML = `
        <div class="ds-parity-top">
          <span class="ds-parity-badge">&#x26A1; Deal Alert</span>
          <span class="ds-parity-headline">${escHtml(headline)}</span>
        </div>
        <div class="ds-parity-prices">
          <span class="ds-parity-price-used">Used ${listedPrice.toFixed(0)}</span>
          <span class="ds-parity-price-arrow">&#x2192;</span>
          <span class="ds-parity-price-new">New ~${newRetail.toFixed(0)}</span>
          <span class="ds-parity-price-delta">${escHtml(deltaText)}</span>
        </div>
        <a href="${amzUrl}" target="_blank" rel="noopener noreferrer"
           class="ds-parity-cta" id="ds-parity-cta-btn">
          &#x1F6D2; Buy New on Amazon
        </a>
        <div class="ds-parity-cta-sub">Free returns on most items &middot; Prime eligible</div>
      `;

      // Fire affiliate event on CTA click
      banner.querySelector('#ds-parity-cta-btn').addEventListener('click', () => {
        fireAffiliateEvent({
          program_key: 'amazon', card_type: 'parity_cta',
          price_bucket: newRetail > 500 ? 'high' : newRetail > 100 ? 'mid' : 'low',
        }, r);
      });

      section.appendChild(banner);
    }

    if (cards.length === 0) {
      const q       = encodeURIComponent((r.product_info?.display_name || listing.title || "").slice(0, 60));
      const amzUrl  = `https://www.amazon.com/s?k=${q}&tag=dealscout03f-20`;
      const ebayUrl = `https://www.ebay.com/sch/i.html?_nkw=${q}&mkevt=1&mkcid=1&mkrid=711-53200-19255-0&campid=5339144027&toolid=10001`;

      const amzSubtitle = (isDealParity && newRetail > 0)
        ? `New from ~$${newRetail.toFixed(0)} · Free returns on most items`
        : "New retail reference";
      const amzReason = (isDealParity && newPremium > 0)
        ? `Only $${newPremium.toFixed(0)} more than the used asking price`
        : "Compare before deciding";

      _appendAffiliateCard(section, {
        program_key: "amazon", title: "Shop new on Amazon",
        subtitle: amzSubtitle, reason: amzReason,
        url: amzUrl, badge_label: "Amazon", badge_color: "#f59e0b",
        icon: "\u{1F6D2}", card_type: "new_retail", commission_live: true,
      }, r);
      _appendAffiliateCard(section, {
        program_key: "ebay", title: "Search on eBay",
        subtitle: "Compare used prices", reason: "See what similar items sell for",
        url: ebayUrl, badge_label: "eBay", badge_color: "#e53e3e",
        icon: "\u{1F3F7}\uFE0F", card_type: "used_comp", commission_live: true,
      }, r);
    } else {
      if (isDealParity && newRetail > 0) {
        const firstNew = cards.find(c => c.card_type === "new_retail" || c.program_key === "amazon");
        if (firstNew && newPremium > 0) {
          firstNew.subtitle = `New from ~$${newRetail.toFixed(0)}`;
          firstNew.reason   = `Only $${newPremium.toFixed(0)} more than asking price`;
        }
      }
      cards.forEach(card => _appendAffiliateCard(section, card, r));
    }

    const note = document.createElement("div");
    note.style.cssText = "font-size:9px;opacity:0.3;margin-top:6px;text-align:right";
    note.textContent = "Affiliate links \u00b7 Deal Scout earns on qualifying purchases";
    section.appendChild(note);

    container.appendChild(section);
  }

  function _appendAffiliateCard(section, card, r) {
    const a = document.createElement("a");
    a.className = "ds-affiliate-card";
    a.href      = card.url || "#";
    a.target    = "_blank";
    a.rel       = "noopener noreferrer";

    a.innerHTML = `
      <span class="ds-aff-badge" style="background:${card.badge_color || '#6366f1'}">
        ${escHtml(card.icon || "")} ${escHtml(card.badge_label || "")}
      </span>
      <div class="ds-aff-text">
        <div class="ds-aff-title">${escHtml(card.title || "")}</div>
        <div class="ds-aff-sub">${escHtml(card.subtitle || "")}${card.price_hint ? " · <b>" + escHtml(card.price_hint) + "</b>" : ""}</div>
        <div class="ds-aff-reason">${escHtml(card.reason || "")}</div>
      </div>
      <span class="ds-aff-arrow">&#x2192;</span>
    `;

    a.addEventListener("click", () => fireAffiliateEvent(card, r));
    section.appendChild(a);
  }


  function renderLikeProducts(r, container) { /* @deprecated — replaced by renderAffiliateCards */ }
  function renderSuggestions(r, container)  { /* @deprecated — no-op */ }
  function renderSearchLinks(r, listing, container) { /* @deprecated — no-op */ }


  function renderReliability(r, container) {
    const pe = r.product_evaluation;
    if (!pe || !pe.reliability_tier || pe.reliability_tier === "unknown") return;

    const tierColors = {
      excellent: "#22c55e", good: "#86efac",
      mixed: "#fbbf24", poor: "#f87171", unknown: "#94a3b8",
    };
    const tierEmojis = {
      excellent: "&#x2705;", good: "&#x1F44D;",
      mixed: "&#x26A0;&#xFE0F;", poor: "&#x274C;", unknown: "&#x2753;",
    };

    const color  = tierColors[pe.reliability_tier]  || "#94a3b8";
    const emoji  = tierEmojis[pe.reliability_tier]  || "&#x2753;";
    const rating = pe.overall_rating ? ` &middot; ${pe.overall_rating.toFixed(1)}/5 &#x2B50;` : "";
    const count  = pe.review_count   ? ` (${pe.review_count} reviews)` : "";

    let issueHtml = "";
    if (pe.known_issues?.length) {
      issueHtml = `<div style="font-size:11px;opacity:0.6;margin-top:4px">
        Issues: ${pe.known_issues.slice(0,2).map(i => escHtml(i)).join(", ")}
      </div>`;
    }

    const section = document.createElement("div");
    section.className = "ds-section";
    section.innerHTML = `
      <div class="ds-section-title">&#x1F4CB; Product Reputation</div>
      <div class="ds-reliability">
        <span style="font-weight:700;color:${color}">${emoji} ${pe.reliability_tier.toUpperCase()}</span>
        <span style="font-size:11px;opacity:0.7">${rating}${count}</span>
        ${pe.reddit_sentiment ? `<div style="font-size:11px;opacity:0.6;margin-top:4px;font-style:italic">"${escHtml(pe.reddit_sentiment.slice(0,80))}"</div>` : ""}
        ${issueHtml}
      </div>`;
    container.appendChild(section);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 5b — LISTING READINESS + PRE-FLIGHT ERROR DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Wait for the listing DOM to fully hydrate using MutationObserver.
   *
   * WHY NOT A RETRY LOOP:
   *   FBM is a React SPA. Fields hydrate at different times:
   *     - Title:       ~200ms after navigation
   *     - Price:       ~300-500ms
   *     - Description: ~500-1500ms (fetched separately, sometimes lazy)
   *   A fixed retry loop either misses the description (too fast) or wastes
   *   time (too slow). MutationObserver fires exactly when each node appears.
   *
   * READINESS CRITERIA (all must pass):
   *   1. price > 0
   *   2. title is non-empty and not a nav label
   *   3. description is non-empty OR 2 seconds have passed with price+title ready
   *      (some listings genuinely have no description — don't block on them)
   *
   * Returns the extracted listing object, or null on hard timeout.
   */
  async function waitForListingReady() {
    const TITLE_NOISE  = new Set(["marketplace", "notifications", "facebook", "search results", ""]);
    const HARD_TIMEOUT = 6000;   // never wait more than 6s total
    const DESC_GRACE   = 2000;   // if price+title ready, allow 2s for description before giving up

    function isReady(listing) {
      const t = listing.title?.toLowerCase().trim() || "";
      return listing.price > 0 && t.length > 2 && !TITLE_NOISE.has(t);
    }

    function hasDescription(listing) {
      return (listing.description || "").trim().length > 5;
    }

    // Fast path — listing may already be fully rendered (e.g. hard refresh)
    let listing = extractListing();
    if (isReady(listing) && hasDescription(listing)) {
      console.log(LOG_PRE, "Listing ready immediately (fast path)");
      return listing;
    }

    return new Promise((resolve) => {
      let priceTitleReadyAt = null;
      let descGraceTimer    = null;
      let hardTimer         = null;
      let observer          = null;

      function done(result) {
        observer?.disconnect();
        clearTimeout(descGraceTimer);
        clearTimeout(hardTimer);
        resolve(result);
      }

      function check() {
        listing = extractListing();

        if (isReady(listing)) {
          if (hasDescription(listing)) {
            console.log(LOG_PRE, `Listing fully ready (desc: ${listing.description.length} chars)`);
            done(listing);
            return;
          }

          // Price+title ready but no description yet — start grace timer
          if (!priceTitleReadyAt) {
            priceTitleReadyAt = Date.now();
            console.log(LOG_PRE, "Price+title ready, waiting for description...");
            descGraceTimer = setTimeout(() => {
              // Description never appeared — listing may genuinely have none
              const fresh = extractListing();
              console.log(LOG_PRE, `Description grace period expired. desc="${fresh.description?.slice(0, 50)}"`);
              done(fresh.price > 0 ? fresh : null);
            }, DESC_GRACE);
          }
        }
      }

      // Observe the entire listing content area for any DOM mutations.
      // WHY subtree+childList+characterData: description text arrives as
      // new text nodes OR as attribute changes on existing spans depending
      // on FBM's React version — we need all three to catch every case.
      const target = document.querySelector('[role="main"]') || document.body;
      observer = new MutationObserver(check);
      observer.observe(target, { subtree: true, childList: true, characterData: true });

      // Hard timeout — safety net if FBM changes its structure
      hardTimer = setTimeout(() => {
        console.warn(LOG_PRE, "Hard timeout reached in waitForListingReady");
        const fresh = extractListing();
        done(isReady(fresh) ? fresh : null);
      }, HARD_TIMEOUT);

      // Run once immediately in case DOM changed between setup and observe()
      check();
    });
  }


  /**
   * Pre-flight listing error detector — runs client-side before API call.
   *
   * WHY CLIENT-SIDE (not Claude):
   *   These are pattern-based checks that don't need AI reasoning. Running
   *   them here gives instant feedback (0ms latency) and saves API cost.
   *   Nuanced errors (description contradicts photos, price justification)
   *   are left to Claude via the score prompt.
   *
   * Returns array of warning objects: { code, severity, message }
   *   severity: "error" | "warning" | "info"
   */
  function detectListingErrors(listing) {
    const warnings = [];
    const title  = (listing.title  || "").toLowerCase();
    const desc   = (listing.description || "").toLowerCase();
    const price  = listing.price || 0;
    const combined = title + " " + desc;

    // ── Price sanity checks ────────────────────────────────────────────────

    // $1 listings are almost always a badge extraction error or bait price
    // WHY NOT IN BACKEND: we can catch this before wasting an API call
    if (price === 1) {
      warnings.push({
        code: "PRICE_LIKELY_ERROR",
        severity: "warning",
        message: "Price shows $1 — may be a page-read error. Verify before scoring.",
      });
    }

    // Price ends in .00 and is suspiciously round for used goods — could be
    // a placeholder. Not an error, just flag for context.
    // Only flag if it's also a very low price for a non-trivial item.
    if (price > 0 && price < 5 && !detectMultiItem(listing.title, listing.description)) {
      warnings.push({
        code: "PRICE_VERY_LOW",
        severity: "info",
        message: `Price is $${price} — confirm this isn't per-item pricing for a bundle.`,
      });
    }

    // ── ISO / Wanted posts ─────────────────────────────────────────────────

    // FBM has "Wanted" listings mixed in with "For Sale". DS should not score them.
    // WHY REGEX: FBM doesn't expose listing type in the DOM reliably.
    const ISO_RE = /(iso|in search of|looking for|wtb|want to buy|wanted[:\s])/i;
    if (ISO_RE.test(combined)) {
      warnings.push({
        code: "POSSIBLY_ISO",
        severity: "error",
        message: "This may be a 'Wanted' post, not a sale. Deal scoring won't be accurate.",
      });
    }

    // ── Per-item vs. bundle price ambiguity ───────────────────────────────

    // "each" or "per item" in description when it's also a bundle listing
    // is a very common source of buyer confusion and bad AI scores
    const PER_ITEM_RE = /(\$\d+\s*(each|ea|per\s+(item|piece|pair|unit))|each.*\$\d+)/i;
    if (PER_ITEM_RE.test(desc) && detectMultiItem(listing.title, listing.description)) {
      warnings.push({
        code: "PRICE_AMBIGUITY",
        severity: "warning",
        message: "Description mentions per-item pricing — listed price may be for one item only.",
      });
    }

    // ── Pickup vs. shipping conflict ──────────────────────────────────────

    // Seller says "local pickup only" but FBM shows a shipping cost.
    // This often means the shipping cost was read from a different listing.
    const PICKUP_ONLY_RE = /(local\s+pick\s*up\s+only|no\s+shipping|cash\s+only)/i;
    if (PICKUP_ONLY_RE.test(desc) && listing.shipping_cost > 0) {
      warnings.push({
        code: "SHIPPING_CONFLICT",
        severity: "info",
        message: "Seller says pickup only but a shipping cost was detected — verify delivery option.",
      });
    }

    // ── Clearly broken description ────────────────────────────────────────

    // Description is just the title repeated, or a single word, or nav noise
    const descTrimmed = (listing.description || "").trim();
    if (descTrimmed.length > 0 && descTrimmed.length < 15 && !listing.is_vehicle) {
      warnings.push({
        code: "SPARSE_DESCRIPTION",
        severity: "info",
        message: "Description is very short — score may have less context than usual.",
      });
    }

    return warnings;
  }


  /**
   * Render pre-flight warnings in the sidebar immediately (before score loads).
   * They stay visible and get merged with the score output.
   *
   * WHY SEPARATE FROM SCORE RENDER:
   *   Pre-flight fires before the API call. Score render fires after (~2-4s).
   *   Showing warnings immediately feels snappy. We don't want to wait.
   */
  function showPreflightWarnings(warnings) {
    const container = document.getElementById("ds-preflight-warnings");
    if (!container) return;

    const errorWarnings   = warnings.filter(w => w.severity === "error");
    const normalWarnings  = warnings.filter(w => w.severity === "warning");
    const infoWarnings    = warnings.filter(w => w.severity === "info");

    const rows = [
      ...errorWarnings.map(w =>
        `<li style="color:#f87171">&#x26D4; ${escHtml(w.message)}</li>`),
      ...normalWarnings.map(w =>
        `<li style="color:#fbbf24">&#x26A0;&#xFE0F; ${escHtml(w.message)}</li>`),
      ...infoWarnings.map(w =>
        `<li style="color:#94a3b8">&#x2139;&#xFE0F; ${escHtml(w.message)}</li>`),
    ].join("\n");

    container.innerHTML = `<ul class="ds-flags" style="margin-bottom:8px">${rows}</ul>`;
    container.style.display = "block";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 6 — SCORING PIPELINE
  // ═══════════════════════════════════════════════════════════════════════════

  let currentlyScoring = false;

  async function scoreListing() {
    if (!isListingPage()) return;
    if (currentlyScoring) return;
    currentlyScoring = true;

    try {
      ensureSidebarDOM();
      showLoading();

      // Wait for listing DOM to fully hydrate using MutationObserver.
      // WHY MUTATIONOBSERVER OVER RETRY LOOP:
      //   The old retry loop (8×800ms) had two failure modes:
      //     1. Fires too early — description still empty, Claude gets no context
      //     2. Fires too late — wastes up to 6.4s on fast connections
      //   MutationObserver fires the instant React renders each field,
      //   so we get the description as soon as it's available, not 800ms after.
      //   Hard timeout (6s) prevents hanging if FBM changes its DOM structure.
      let listing = await waitForListingReady();

      if (!listing) {
        console.warn(LOG_PRE, "Listing DOM not ready after timeout — aborting score");
        showError("Could not read listing — try refreshing the page");
        return;
      }

      // Pre-flight: catch obvious listing errors before the API call.
      // WHY CLIENT-SIDE: instant feedback, no latency, no API cost.
      // Errors that need AI reasoning go to the backend in the score prompt.
      const preflightWarnings = detectListingErrors(listing);
      if (preflightWarnings.length) {
        console.log(LOG_PRE, "Pre-flight warnings:", preflightWarnings);
        // Surface warnings in sidebar immediately, then continue scoring.
        // We don't abort — Claude may have more context from the full listing.
        showPreflightWarnings(preflightWarnings);
      }

      console.log(LOG_PRE, "Scoring:", listing.title, "@", listing.price, `+shipping:${listing.shipping_cost}`);

      await recordPriceHistory(listing.listing_url, listing.price);

      const payload = listing;

      let r;
      try {
        const resp = await fetch(`${API_BASE}/score`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(payload),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          const detail = err.detail;
          let msg;
          if (Array.isArray(detail)) {
            msg = detail.map(e => `${(e.loc || []).slice(-1)[0]}: ${e.msg}`).join('; ');
          } else {
            msg = detail || `API error ${resp.status}`;
          }
          console.error(LOG_PRE, `API ${resp.status} — full detail:`, JSON.stringify(err));
          throw new Error(msg);
        }
        r = await resp.json();
      } catch (fetchErr) {
        const isNetworkErr = fetchErr instanceof TypeError;
        showError(
          isNetworkErr
            ? `API not reachable — is it running?\n\nStart it:\n  uvicorn api.main:app --reload --port 8000`
            : fetchErr.message
        );
        return;
      }

      await saveScore(listing.listing_url, r.score, r.should_buy);

      try {
        const color = r.score >= 7 ? "#22c55e" : r.score >= 5 ? "#fbbf24" : "#ef4444";
        chrome.runtime.sendMessage({ type: "SET_BADGE", score: r.score, color });
      } catch { /* ok */ }

      renderScore(r, listing);

    } finally {
      currentlyScoring = false;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SECTION 7 — INIT & MESSAGE LISTENER
  // ═══════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "RESCORE") {
      currentlyScoring = false;
      scoreListing();
      sendResponse({ ok: true });
    }
  });

  window.__dealScoutRescore = () => {
    currentlyScoring = false;
    scoreListing();
  };

  window.__dealScoutReoverlay = () => {
    injectSearchOverlay();
  };

  if (isListingPage()) {
    setTimeout(scoreListing, 1200);
  } else {
    injectSearchOverlay();
  }

  console.log(LOG_PRE, `v${VERSION} injected on`, window.location.pathname);

})();