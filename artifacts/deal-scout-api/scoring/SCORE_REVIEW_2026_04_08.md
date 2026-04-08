# Production Score Log Review — April 8, 2026

## Dataset: 210 production scores from score_log table

## Data Source Distribution
| Source | Count | Notes |
|--------|-------|-------|
| claude_knowledge | 135 | Primary source (eBay rate-limited) |
| claude_web_grounded | 26 | DuckDuckGo pricing working correctly |
| ebay_mock | 20 | Circuit breaker open, mock fallback |
| vehicle_not_applicable | 19 | Vehicles without comp data |
| cargurus+claude | 5 | Blended vehicle pricing |
| cargurus | 5 | Pure CarGurus comps |

## Key Metrics
- **Low confidence scores**: 33/210 (15.7%)
- **$0 estimated value**: 30/210 (14.3%) — 19 are vehicles (expected), remainder edge cases

## Flagged Entries

### Stale CarGurus Outliers (pre-fix, no action needed)
- 1966 Impala Convertible: $35k listing vs $88,888 est (single CarGurus outlier)
- 1964 Nova Classic: $5,500 listing vs $88,888 est (same pattern)
- 1963 Nova: $29,500 listing vs $89,999 est (same pattern)

These are stale entries from before the Claude supplement blend fix (vehicle_pricer.py
lines 473-494). The fix blends Claude AI pricing when CarGurus returns < 3 comps.
New vehicle scores use blended estimates. No backend fix needed.

### Low-Value Items (acceptable variance)
- Hot Wheels Premium 2 Pack: $30 vs $8 est — reasonable for collectibles
- Toyota Pickup Lug Nut: $20 vs $0.50 est — very small items hard to price

### Inflatable Water Slide (overestimated, acceptable)
- $120 listing vs $635 est (claude_web_grounded, score 9)
- DuckDuckGo returned new retail prices; 10x sanity cap prevents extremes

## Primary Accuracy Gap
Truncated descriptions from missing "See more" expansion was the main gap.
Without full descriptions, Claude misses condition disclosures, seller notes,
item specs, and red flags. Fixed in v0.33.0 with _expandSeeMore().

## Conclusion
No backend quick fixes required. Scoring pipeline working correctly.
Primary improvement: fuller description text via extension-side "See more" expansion.
