"""
Market Signal Data Pipeline

Collects anonymized aggregate signals from every scored listing.
Data is stored in the market_signals PostgreSQL table and can be
sold as a market intelligence dataset.

WHAT IS COLLECTED — only aggregate pricing signals:
  - Item category + normalized label (e.g. "iPhone 14 Pro")
  - Condition (Used / Like New / etc.)
  - City + state (no street, no zip, no seller identity)
  - Asking price, eBay sold avg, eBay active avg, new price, Craigslist avg
  - Price gap % vs market, deal score, buy_new_trigger flag
  - Which affiliate programs were shown
  - Source platform (facebook_marketplace / craigslist / amazon)

WHAT IS NOT COLLECTED:
  - User IDs, browser fingerprints, IP addresses
  - Seller names, phone numbers, listing URLs
  - Any data that could identify a buyer or seller

MONETIZATION:
  - Aggregate weekly exports sold to retailers / insurers / research firms
  - Direct API endpoint (/v1/market-data) for B2B subscribers
  - AWS Data Exchange or Snowflake Marketplace listing
"""

import asyncio
import logging
import os
from typing import Optional

log = logging.getLogger(__name__)

_pool: Optional[object] = None


async def _get_pool():
    """Return a reused asyncpg connection pool. Created lazily on first call."""
    global _pool
    if _pool is None:
        try:
            import asyncpg
            db_url = os.environ.get("DATABASE_URL", "")
            if not db_url:
                return None
            _pool = await asyncpg.create_pool(db_url, min_size=1, max_size=3, command_timeout=5)
            log.info("[data_pipeline] DB pool created")
        except Exception as e:
            log.warning(f"[data_pipeline] pool creation failed: {e}")
            return None
    return _pool


async def record_signal(
    *,
    category: str = "",
    item_label: str = "",
    condition: str = "",
    city: str = "",
    state_code: str = "",
    asking_price: float = 0.0,
    ebay_sold_avg: float = 0.0,
    ebay_active_avg: float = 0.0,
    new_price: float = 0.0,
    cl_asking_avg: float = 0.0,
    price_gap_pct: float = 0.0,
    deal_score: int = 0,
    buy_new_trigger: bool = False,
    affiliate_programs: str = "",
    platform: str = "facebook_marketplace",
) -> None:
    """
    Write one anonymized market signal row to the database.

    USAGE: Always fire this as asyncio.create_task() so it never blocks
    the API response. Swallows all errors silently — the main pipeline
    must never fail because of a data collection write.
    """
    try:
        pool = await _get_pool()
        if pool is None:
            return
        await pool.execute(
            """
            INSERT INTO market_signals
              (category, item_label, condition, city, state_code,
               asking_price, ebay_sold_avg, ebay_active_avg, new_price, cl_asking_avg,
               price_gap_pct, deal_score, buy_new_trigger, affiliate_programs, platform)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            """,
            category or None,
            item_label or None,
            condition or None,
            city or None,
            state_code or None,
            float(asking_price) if asking_price else None,
            float(ebay_sold_avg) if ebay_sold_avg else None,
            float(ebay_active_avg) if ebay_active_avg else None,
            float(new_price) if new_price else None,
            float(cl_asking_avg) if cl_asking_avg else None,
            float(price_gap_pct) if price_gap_pct else None,
            int(deal_score) if deal_score else None,
            bool(buy_new_trigger),
            affiliate_programs or None,
            platform or "facebook_marketplace",
        )
    except Exception as e:
        log.debug(f"[data_pipeline] write skipped (non-fatal): {e}")


async def get_aggregate_stats(
    category: Optional[str] = None,
    days: int = 30,
    min_count: int = 5,
) -> dict:
    """
    Return aggregate market signal data for the API /v1/market-data endpoint.
    Groups by category + item_label, only returns rows with >= min_count samples
    to prevent any single listing from being identifiable.
    """
    pool = await _get_pool()
    if pool is None:
        return {"error": "database_unavailable", "rows": []}

    where_clauses = ["ts >= NOW() - ($1 || ' days')::INTERVAL"]
    params: list = [days]

    if category:
        where_clauses.append("category = $2")
        params.append(category)

    where_sql = " AND ".join(where_clauses)
    count_param = f"${len(params) + 1}"
    params.append(min_count)

    query = f"""
        SELECT
            category,
            item_label,
            COUNT(*)                              AS sample_count,
            ROUND(AVG(asking_price)::NUMERIC, 2)  AS avg_asking,
            ROUND(MIN(asking_price)::NUMERIC, 2)  AS min_asking,
            ROUND(MAX(asking_price)::NUMERIC, 2)  AS max_asking,
            ROUND(AVG(ebay_sold_avg)::NUMERIC, 2) AS avg_ebay_sold,
            ROUND(AVG(new_price)::NUMERIC, 2)     AS avg_new_price,
            ROUND(AVG(price_gap_pct)::NUMERIC, 1) AS avg_price_gap_pct,
            ROUND(AVG(deal_score)::NUMERIC, 1)    AS avg_deal_score,
            MODE() WITHIN GROUP (ORDER BY condition) AS typical_condition,
            MODE() WITHIN GROUP (ORDER BY platform)  AS platform
        FROM market_signals
        WHERE {where_sql}
          AND asking_price IS NOT NULL
        GROUP BY category, item_label
        HAVING COUNT(*) >= {count_param}
        ORDER BY sample_count DESC
        LIMIT 500
    """

    try:
        rows = await pool.fetch(query, *params)
        return {
            "days": days,
            "category_filter": category,
            "min_sample_size": min_count,
            "row_count": len(rows),
            "rows": [dict(r) for r in rows],
        }
    except Exception as e:
        log.error(f"[data_pipeline] aggregate query failed: {e}")
        return {"error": str(e), "rows": []}


async def get_dashboard_summary() -> dict:
    """Quick summary stats for an admin dashboard."""
    pool = await _get_pool()
    if pool is None:
        return {}
    try:
        row = await pool.fetchrow("""
            SELECT
                COUNT(*)                                        AS total_signals,
                COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '24 hours') AS signals_24h,
                COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '7 days')  AS signals_7d,
                COUNT(DISTINCT category)                        AS unique_categories,
                COUNT(DISTINCT item_label)                      AS unique_items,
                ROUND(AVG(deal_score)::NUMERIC, 1)              AS avg_deal_score,
                ROUND(AVG(price_gap_pct)::NUMERIC, 1)           AS avg_price_gap_pct,
                MIN(ts)                                         AS oldest_signal,
                MAX(ts)                                         AS newest_signal
            FROM market_signals
        """)
        return dict(row) if row else {}
    except Exception as e:
        log.error(f"[data_pipeline] summary query failed: {e}")
        return {}
