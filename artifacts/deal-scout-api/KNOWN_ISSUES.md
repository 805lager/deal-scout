# Deal Scout — Known Issues & Fix Log

Tracking doc for scoring pipeline issues discovered via score-log / diag review.
Check this file when reviewing new score logs to see if old issues have resurfaced.

---

## FIXED — v0.33.2 (2026-03-31)

### ISS-007: Daily Discord summary always shows 0 scores
- **Symptom**: Discord daily digest shows "0 total" even though scores exist
  in the production database.
- **Root cause**: Both the dev server AND production server had the daily
  scheduler running. The dev server's scheduler fires at midnight UTC and
  queries the DEV database (which has 0 recent scores because all user traffic
  goes to the production API). The dev's "0 scores" message overwrites or
  precedes the production summary.
- **Fix**: Added `REPLIT_DEPLOYMENT=1` guard to `_start_daily_summary_task()`.
  The scheduler now only runs in production, where the real score data lives.
  The manual `/admin/daily-summary` endpoint still works in both environments.
- **Regression check**: Discord daily summary should show non-zero scores
  matching production DB. Manual trigger via
  `GET /admin/daily-summary?key=...` can verify.

---

## FIXED — v0.33.2 (2026-03-30)

### ISS-001: Photo count undercount → false "1 photo" security ding
- **Symptom**: Security scorer flagged "Only 1 photo provided" when the listing
  actually had 5+ photos available. Score log showed `photo_count=1` with
  `image_urls_len=5` on the same entry.
- **Root cause**: `security_scorer.py` and `main.py` used an or-chain
  (`photo_count or len(image_urls)`) which prefers `photo_count` even when it's
  a smaller number than the actual `image_urls` array length. The extension's
  DOM-based `photo_count` heuristic sometimes undercounts carousel images.
- **Fix**: Changed to `max(photo_count, len(image_urls))` in three locations:
  - `scoring/security_scorer.py` — security prompt photo string (line ~389)
  - `scoring/security_scorer.py` — layer1 positive signals (line ~567)
  - `main.py` — deal_scorer `photo_count` param (both endpoints, lines ~562, ~1176)
- **Regression check**: In score log, look for entries where `photo_count < image_urls_len`.
  Should no longer happen.

### ISS-002: Contradictory Claude verdict direction (says "overpriced" on discounted items)
- **Symptom**: Three telescope listings priced at 31–43% of estimated value had
  verdicts saying "overpriced", "above market", or "69% markup." Score and
  should_buy were correct (7/10, true), but the verdict text contradicted them.
- **Root cause**: Claude confused the direction of the price-to-market gap when
  the discount was large. No explicit ratio context was given in the prompt.
- **Fix**: Added `_price_direction_hint()` function to `scoring/deal_scorer.py`
  that injects an explicit line like:
  `>>> PRICE DIRECTION: Asking $225 is 69% BELOW estimated value $720. This is a DISCOUNTED listing — do NOT say overpriced.`
- **Regression check**: In score log, filter entries where `price/estimated_value < 0.5`
  and verdict contains "overpriced" or "above market". Should be zero.

---

## KNOWN — Not a bug (documented for context)

### ISS-003: eBay Finding API rate-limited (0/71 ebay_live results)
- **Symptom**: All 71 scored listings show `data_source` as either
  `claude_knowledge` (53) or `ebay_mock` (13). Zero `ebay_live` results.
- **Root cause**: eBay Finding API free tier has a daily call limit (~5,000/day
  officially, but in practice rate-limits after ~50 calls). Both
  `findCompletedItems` and `findItemsAdvanced` return error 10001.
- **Impact**: The pipeline gracefully falls back to Claude AI pricing (primary)
  and eBay mock data (for affiliate cards). Scoring quality is not degraded
  because Claude AI pricing is now the primary data source. eBay live data would
  improve confidence levels but is not required for accurate scores.
- **Circuit breaker**: 30-minute cooldown after rate limit detection. Prevents
  wasting API calls when quota is exhausted.
- **Potential fix**: Upgrade to eBay Production API tier, or switch to eBay
  Browse API (OAuth-based, higher limits). Not urgent since Claude pricing
  provides good coverage.

### ISS-004: $0 price entries still appearing in score log
- **Symptom**: 3 entries (#64, #68, #69) with `price=$0` in the score log.
  These got score=3 with "Price missing or $0" verdict (correct behavior).
- **Status**: The $0 guard (T002 fix) IS working — these entries get capped at
  score=3 with appropriate messaging. They're not false positives; the extension
  sent listings where the seller didn't set a price (common on FBM for
  "contact for pricing" listings).
- **The guard works**: Score is capped, should_buy=false, red_flag explains why.

### ISS-005: eBay mock returning $0 estimated value for vague listings
- **Symptom**: 5 entries with `data_source=ebay_mock` and `estimated_value=0`.
  Titles like "SKATTEBO LOT!!!!", "Plushy's", "Telescope" (single-word).
- **Root cause**: Mock data generator derives prices from keywords. When the
  listing title is too vague or unusual, the keyword matching fails to produce
  a price range, resulting in $0.
- **Impact**: Low — Claude AI pricing is attempted first and usually succeeds.
  Mock data is only used for eBay affiliate card generation, not primary pricing.

### ISS-006: 75% Claude-only pricing (no market data backing)
- **Context**: 53/71 listings rely on Claude's training knowledge for pricing.
  This is by design — Claude AI pricer is the PRIMARY pricing source since
  v0.33.0. eBay is the FALLBACK (for affiliate cards + sold comps when available).
- **Quality**: Claude pricing has been validated against eBay sold data and is
  generally accurate for common consumer goods. Confidence levels ("low",
  "medium", "high") accurately reflect Claude's certainty.
- **Improvement path**: When eBay API is available, both run in parallel and
  eBay data enriches the output without replacing Claude's primary estimate.

---

## Monitoring Checklist (for future score log reviews)

1. **Security/buy conflicts**: Filter `security_score <= 3 AND should_buy = true`. Should be 0.
2. **$0 price scores**: Filter `price = 0`. Should show score=3, should_buy=false.
3. **Photo undercount**: Compare `photo_count` vs `len(image_urls)`. Should use max().
4. **Verdict contradictions**: Filter `price/estimated_value < 0.5` + verdict contains "overpriced". Should be 0.
5. **eBay live rate**: Count `data_source = ebay_live`. If consistently 0, eBay API is rate-limited.
6. **Response times**: Check for requests > 15s. May indicate Claude timeout issues.
7. **Retry 401 errors**: Check server logs for "Retry attempt" messages. Should resolve within 2 retries.
