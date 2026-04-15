import asyncio
import json
import logging
import os
import time as _time
from datetime import datetime, timedelta

log = logging.getLogger(__name__)

_last_check_ts = 0.0
_last_reviewed_id = 0

ANOMALY_RULES = {
    "vehicle_stub":       "data_source is vehicle_not_applicable",
    "no_comp_data":       "sold_count=0 with non-Claude data source",
    "zero_confidence":    "market_confidence is none",
    "zero_value":         "estimated_value=0 on item priced >$20",
    "low_photos":         "photo_count ≤1 on item priced >$50",
    "score_price_high":   "score ≥7 but price > estimated_value",
    "score_price_low":    "score ≤4 but price < 60% of estimated_value",
    "security_critical":  "security score ≤3",
    "missing_affiliates": "no affiliate cards returned",
}


def detect_anomalies(scorecard: dict) -> list[dict]:
    flags = []
    listing = scorecard.get("listing", {})
    ds = scorecard.get("deal_score", {})
    pc = scorecard.get("price_comparison", {})
    sec = scorecard.get("security", {})
    aff = scorecard.get("affiliate_cards", [])
    meta = scorecard.get("metadata", {})

    price = listing.get("price", 0) or 0
    score = ds.get("score") or 0
    data_source = pc.get("data_source", "")
    confidence = pc.get("market_confidence", "")
    est_val = pc.get("estimated_value", 0) or 0
    sold_count = pc.get("sold_count", 0) or 0
    photo_count = listing.get("photo_count", 0) or 0
    sec_score = sec.get("score", 10) if isinstance(sec, dict) else 10

    if data_source == "vehicle_not_applicable":
        flags.append({"rule": "vehicle_stub", "severity": "critical",
                       "detail": f"data_source={data_source} — item went through vehicle pricer stub"})

    if sold_count == 0 and data_source not in ("claude_knowledge", "claude_grounded", "vehicle_not_applicable"):
        flags.append({"rule": "no_comp_data", "severity": "critical",
                       "detail": f"sold_count=0 with data_source={data_source}"})

    if confidence == "none":
        flags.append({"rule": "zero_confidence", "severity": "warning",
                       "detail": "market_confidence=none"})

    if est_val == 0 and price > 20:
        flags.append({"rule": "zero_value", "severity": "warning",
                       "detail": f"estimated_value=0 on ${price:.0f} item"})

    if photo_count <= 1 and price > 50:
        flags.append({"rule": "low_photos", "severity": "warning",
                       "detail": f"photo_count={photo_count} on ${price:.0f} item"})

    if score >= 7 and est_val > 0 and price > est_val:
        flags.append({"rule": "score_price_high", "severity": "warning",
                       "detail": f"score={score} but price=${price:.0f} > estimated_value=${est_val:.0f}"})

    if score <= 4 and est_val > 0 and price < est_val * 0.6:
        flags.append({"rule": "score_price_low", "severity": "warning",
                       "detail": f"score={score} but price=${price:.0f} is well below estimated_value=${est_val:.0f}"})

    if sec_score <= 3:
        flags.append({"rule": "security_critical", "severity": "critical",
                       "detail": f"security_score={sec_score}"})

    if len(aff) == 0:
        flags.append({"rule": "missing_affiliates", "severity": "info",
                       "detail": "no affiliate cards returned"})

    return flags


def build_review_packet(scorecards: list, version_filter: str = None, since_id: int = 0) -> dict:
    filtered = []
    for sc in scorecards:
        sc_id = sc.get("_id", 0)
        sc_version = sc.get("metadata", {}).get("backend_version", "")
        if since_id and sc_id <= since_id:
            continue
        if version_filter and sc_version != version_filter:
            continue
        filtered.append(sc)

    anomalies = []
    healthy = []
    source_counts = {}
    confidence_counts = {}
    platform_counts = {}
    total_score = 0
    score_count = 0

    for sc in filtered:
        flags = detect_anomalies(sc)
        listing = sc.get("listing", {})
        ds_data = sc.get("deal_score", {})
        pc = sc.get("price_comparison", {})
        meta = sc.get("metadata", {})

        summary = {
            "_id": sc.get("_id"),
            "_server_ts": sc.get("_server_ts"),
            "title": listing.get("title"),
            "price": listing.get("price"),
            "platform": listing.get("platform"),
            "score": ds_data.get("score"),
            "verdict": ds_data.get("verdict"),
            "data_source": pc.get("data_source"),
            "market_confidence": pc.get("market_confidence"),
            "estimated_value": pc.get("estimated_value"),
            "sold_avg": pc.get("sold_avg"),
            "sold_count": pc.get("sold_count"),
            "active_count": pc.get("active_count"),
            "security_score": sc.get("security", {}).get("score") if isinstance(sc.get("security"), dict) else None,
            "photo_count": listing.get("photo_count"),
            "category": sc.get("product_info", {}).get("category") if isinstance(sc.get("product_info"), dict) else None,
            "backend_version": meta.get("backend_version"),
            "total_ms": meta.get("total_ms"),
        }

        src = pc.get("data_source", "unknown")
        source_counts[src] = source_counts.get(src, 0) + 1
        conf = pc.get("market_confidence", "unknown")
        confidence_counts[conf] = confidence_counts.get(conf, 0) + 1
        plat = listing.get("platform", "unknown")
        platform_counts[plat] = platform_counts.get(plat, 0) + 1
        if ds_data.get("score") is not None:
            total_score += ds_data["score"]
            score_count += 1

        if flags:
            anomalies.append({"summary": summary, "flags": flags, "scorecard": sc})
        else:
            healthy.append(summary)

    stats = {
        "total_reviewed": len(filtered),
        "anomaly_count": len(anomalies),
        "anomaly_rate": f"{len(anomalies)/len(filtered)*100:.1f}%" if filtered else "0%",
        "avg_score": round(total_score / score_count, 1) if score_count else None,
        "by_data_source": source_counts,
        "by_confidence": confidence_counts,
        "by_platform": platform_counts,
    }

    return {"stats": stats, "anomalies": anomalies, "healthy": healthy}


async def get_telemetry(pool) -> dict:
    result = {}

    try:
        row = await pool.fetchrow("""
            SELECT COUNT(*) AS total,
                   AVG(score) AS avg_score,
                   COUNT(*) FILTER (WHERE thumbs=1) AS thumbs_up,
                   COUNT(*) FILTER (WHERE thumbs=-1) AS thumbs_down,
                   COUNT(*) FILTER (WHERE thumbs IS NULL) AS unrated
            FROM deal_scores
        """)
        result["deal_scores"] = dict(row) if row else {}
        result["deal_scores"]["avg_score"] = round(float(row["avg_score"]), 1) if row and row["avg_score"] else None
    except Exception as e:
        log.warning(f"[audit/telemetry] deal_scores query: {e}")
        result["deal_scores"] = {}

    try:
        src_rows = await pool.fetch("""
            SELECT payload->'price_comparison'->>'data_source' AS src,
                   COUNT(*) AS cnt
            FROM score_log
            GROUP BY src ORDER BY cnt DESC
        """)
        result["data_sources"] = {r["src"]: r["cnt"] for r in src_rows}
    except Exception as e:
        log.warning(f"[audit/telemetry] data_sources: {e}")
        result["data_sources"] = {}

    try:
        conf_rows = await pool.fetch("""
            SELECT payload->'price_comparison'->>'market_confidence' AS conf,
                   COUNT(*) AS cnt
            FROM score_log
            GROUP BY conf ORDER BY cnt DESC
        """)
        result["confidence"] = {r["conf"]: r["cnt"] for r in conf_rows}
    except Exception as e:
        log.warning(f"[audit/telemetry] confidence: {e}")
        result["confidence"] = {}

    try:
        plat_rows = await pool.fetch("""
            SELECT payload->'listing'->>'platform' AS plat,
                   COUNT(*) AS cnt
            FROM score_log
            GROUP BY plat ORDER BY cnt DESC
        """)
        result["platforms"] = {r["plat"]: r["cnt"] for r in plat_rows}
    except Exception as e:
        log.warning(f"[audit/telemetry] platforms: {e}")
        result["platforms"] = {}

    try:
        timing_row = await pool.fetchrow("""
            SELECT AVG((payload->'metadata'->>'total_ms')::float) AS avg_ms,
                   PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (payload->'metadata'->>'total_ms')::float) AS p95_ms,
                   MAX((payload->'metadata'->>'total_ms')::float) AS max_ms
            FROM score_log
            WHERE payload->'metadata'->>'total_ms' IS NOT NULL
        """)
        result["timing"] = {
            "avg_ms": round(float(timing_row["avg_ms"])) if timing_row and timing_row["avg_ms"] else None,
            "p95_ms": round(float(timing_row["p95_ms"])) if timing_row and timing_row["p95_ms"] else None,
            "max_ms": round(float(timing_row["max_ms"])) if timing_row and timing_row["max_ms"] else None,
        }
    except Exception as e:
        log.warning(f"[audit/telemetry] timing: {e}")
        result["timing"] = {}

    try:
        cache_row = await pool.fetchrow("""
            SELECT COUNT(*) AS cnt,
                   MIN(created_at) AS oldest,
                   MAX(created_at) AS newest
            FROM price_cache
        """)
        result["price_cache"] = {
            "count": cache_row["cnt"] if cache_row else 0,
            "oldest": cache_row["oldest"].isoformat() if cache_row and cache_row["oldest"] else None,
            "newest": cache_row["newest"].isoformat() if cache_row and cache_row["newest"] else None,
        }
    except Exception as e:
        log.warning(f"[audit/telemetry] price_cache: {e}")
        result["price_cache"] = {}

    try:
        ver_rows = await pool.fetch("""
            SELECT payload->'metadata'->>'backend_version' AS ver,
                   COUNT(*) AS cnt,
                   AVG((payload->'deal_score'->>'score')::float) AS avg_score,
                   AVG(CASE WHEN (payload->'price_comparison'->>'market_confidence') = 'high' THEN 1
                            WHEN (payload->'price_comparison'->>'market_confidence') = 'medium' THEN 0.5
                            ELSE 0 END) AS confidence_quality,
                   COUNT(*) FILTER (WHERE (payload->'price_comparison'->>'data_source') = 'vehicle_not_applicable'
                                      OR (payload->'price_comparison'->>'market_confidence') = 'none'
                                      OR (payload->'price_comparison'->>'sold_count')::int = 0) AS anomaly_count
            FROM score_log
            WHERE payload->'metadata'->>'backend_version' IS NOT NULL
            GROUP BY ver ORDER BY ver DESC
        """)
        versions = []
        for r in ver_rows:
            cnt = r["cnt"]
            versions.append({
                "version": r["ver"],
                "count": cnt,
                "avg_score": round(float(r["avg_score"]), 1) if r["avg_score"] else None,
                "confidence_quality": round(float(r["confidence_quality"]) * 100, 1) if r["confidence_quality"] else 0,
                "anomaly_rate": round(r["anomaly_count"] / cnt * 100, 1) if cnt else 0,
            })
        result["versions"] = versions

        if len(versions) >= 2:
            cur = versions[0]
            prev = versions[1]
            result["version_comparison"] = {
                "current": cur["version"],
                "previous": prev["version"],
                "score_delta": round(cur["avg_score"] - prev["avg_score"], 1) if cur["avg_score"] and prev["avg_score"] else None,
                "confidence_delta": round(cur["confidence_quality"] - prev["confidence_quality"], 1),
                "anomaly_rate_delta": round(cur["anomaly_rate"] - prev["anomaly_rate"], 1),
            }
    except Exception as e:
        log.warning(f"[audit/telemetry] versions: {e}")
        result["versions"] = []

    try:
        signals_row = await pool.fetchrow("SELECT COUNT(*) AS cnt FROM market_signals")
        result["market_signals_count"] = signals_row["cnt"] if signals_row else 0
    except Exception as e:
        result["market_signals_count"] = 0

    try:
        daily_rows = await pool.fetch("""
            SELECT DATE(server_ts) AS day,
                   COUNT(*) AS cnt,
                   AVG((payload->'deal_score'->>'score')::float) AS avg_score
            FROM score_log
            WHERE server_ts > NOW() - INTERVAL '14 days'
            GROUP BY DATE(server_ts)
            ORDER BY day
        """)
        result["daily_trend"] = [
            {"date": r["day"].isoformat(), "count": r["cnt"],
             "avg_score": round(float(r["avg_score"]), 1) if r["avg_score"] else None}
            for r in daily_rows
        ]
    except Exception as e:
        log.warning(f"[audit/telemetry] daily_trend: {e}")
        result["daily_trend"] = []

    try:
        cache_health = await pool.fetchrow("""
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS fresh_24h,
                   COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '48 hours') AS fresh_48h,
                   AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600) AS avg_age_hours
            FROM price_cache
        """)
        if cache_health:
            result["price_cache"]["total"] = cache_health["total"]
            result["price_cache"]["fresh_24h"] = cache_health["fresh_24h"]
            result["price_cache"]["fresh_48h"] = cache_health["fresh_48h"]
            result["price_cache"]["avg_age_hours"] = round(float(cache_health["avg_age_hours"]), 1) if cache_health["avg_age_hours"] else None
    except Exception as e:
        log.warning(f"[audit/telemetry] cache_health: {e}")

    result["last_reviewed_id"] = _last_reviewed_id

    return result


async def run_llm_check(scorecards: list, version_filter: str = None, since_id: int = 0, limit: int = 50) -> dict:
    global _last_check_ts, _last_reviewed_id

    now = _time.time()
    if now - _last_check_ts < 60:
        wait = int(60 - (now - _last_check_ts))
        return {"error": f"Rate limited — try again in {wait}s", "retry_after": wait}
    _last_check_ts = now

    candidates = []
    for sc in scorecards:
        sc_id = sc.get("_id", 0)
        sc_version = sc.get("metadata", {}).get("backend_version", "")
        if since_id and sc_id <= since_id:
            continue
        if version_filter and sc_version != version_filter:
            continue
        candidates.append(sc)

    candidates.sort(key=lambda sc: sc.get("_id", 0))
    filtered = candidates[:limit]

    if not filtered:
        return {"findings": [], "reviewed_count": 0, "message": "No new scores to review"}

    compact = []
    for sc in filtered:
        listing = sc.get("listing", {})
        ds_data = sc.get("deal_score", {})
        pc = sc.get("price_comparison", {})
        sec = sc.get("security", {})
        aff = sc.get("affiliate_cards", [])
        pi = sc.get("product_info", {})
        meta = sc.get("metadata", {})
        compact.append({
            "id": sc.get("_id"),
            "title": listing.get("title"),
            "price": listing.get("price"),
            "platform": listing.get("platform"),
            "condition": listing.get("condition"),
            "photo_count": listing.get("photo_count"),
            "is_vehicle": listing.get("is_vehicle"),
            "description": listing.get("description_snippet", ""),
            "score": ds_data.get("score"),
            "verdict": ds_data.get("verdict"),
            "should_buy": ds_data.get("should_buy"),
            "green_flags": ds_data.get("green_flags", []),
            "red_flags": ds_data.get("red_flags", []),
            "recommended_offer": ds_data.get("recommended_offer"),
            "affiliate_category": ds_data.get("affiliate_category"),
            "data_source": pc.get("data_source"),
            "market_confidence": pc.get("market_confidence"),
            "estimated_value": pc.get("estimated_value"),
            "sold_avg": pc.get("sold_avg"),
            "sold_count": pc.get("sold_count"),
            "active_count": pc.get("active_count"),
            "active_avg": pc.get("active_avg"),
            "query_used": pc.get("query_used"),
            "new_price": pc.get("new_price"),
            "security_score": sec.get("score") if isinstance(sec, dict) else None,
            "security_risk": sec.get("risk_level") if isinstance(sec, dict) else None,
            "security_warnings": sec.get("warnings", []) if isinstance(sec, dict) else [],
            "affiliate_programs": [c.get("program_key", "") for c in aff],
            "category": pi.get("category") if isinstance(pi, dict) else None,
            "brand": pi.get("brand") if isinstance(pi, dict) else None,
            "backend_version": meta.get("backend_version"),
        })

    prompt = f"""You are a QA auditor for a deal scoring system called Deal Scout. It scores second-hand marketplace listings (Facebook Marketplace, Craigslist, eBay, OfferUp) using eBay sold prices, Google Shopping, and AI estimates.

Review the following {len(compact)} scorecards and identify any that look WRONG or SUSPICIOUS. Focus on:

1. **Score accuracy**: Does the score make sense given the price vs estimated_value? A score of 7+ means great deal (price well below value). Score of 4- means bad deal (overpriced). Check if the math adds up.
2. **Data source issues**: "vehicle_not_applicable" means the pricing pipeline failed. "none" confidence means no real market data was found.
3. **Category routing**: Do the affiliate programs match the item? (e.g., Camping World for electronics is wrong, Autotrader for furniture is wrong)
4. **Flag accuracy**: Are green_flags and red_flags sensible for the item? Flagging "limited photos" when photo_count is high is a bug.
5. **Security sanity**: Is the security score reasonable? Very low security on a normal-looking listing might be a false positive.
6. **Query quality**: Does query_used look like it would find the right eBay comps? Overly generic or wrong queries produce bad pricing.
7. **Negotiation logic**: Is recommended_offer reasonable relative to the price and estimated value?

For each issue found, return a JSON object. Return a JSON array of findings (empty array if everything looks good).

Each finding:
{{"id": <score_log_id>, "title": "<listing title>", "price": <price>, "issue_type": "<category>", "severity": "critical|warning|info", "description": "<what's wrong and why>", "suggested_fix": "<what should change>"}}

Issue types: "score_accuracy", "data_source", "category_routing", "flag_error", "security_false_positive", "query_quality", "negotiation_logic", "other"

SCORECARDS:
{json.dumps(compact, default=str)}

Return ONLY the JSON array, no markdown fences, no explanation."""

    try:
        import anthropic
        api_key = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "")
        base_url = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "")
        if not api_key or not base_url:
            return {"error": "Claude API not configured", "findings": []}

        client = anthropic.Anthropic(api_key=api_key, base_url=base_url)

        from scoring import claude_call_with_retry
        loop = asyncio.get_running_loop()
        response = await claude_call_with_retry(
            lambda: client.messages.create(
                model="claude-haiku-4-5",
                max_tokens=4000,
                messages=[{"role": "user", "content": prompt}],
            ),
            label="AuditCheck",
        )

        raw = response.content[0].text.strip()
        import re
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)

        try:
            from json_repair import repair_json
            findings = json.loads(repair_json(raw))
        except Exception:
            findings = json.loads(raw)

        if not isinstance(findings, list):
            findings = [findings]

        max_id = max((sc.get("_id", 0) for sc in filtered), default=0)
        if max_id > 0:
            _last_reviewed_id = max_id

        return {
            "findings": findings,
            "reviewed_count": len(filtered),
            "last_reviewed_id": _last_reviewed_id,
        }

    except Exception as e:
        log.error(f"[audit/check] LLM check failed: {e}")
        return {"error": str(e), "findings": []}


def build_rescore_diff(old_scorecard: dict, new_response: dict) -> dict:
    old_ds = old_scorecard.get("deal_score", {})
    if not isinstance(old_ds, dict):
        old_ds = {}
    old_pc = old_scorecard.get("price_comparison", {})
    if not isinstance(old_pc, dict):
        old_pc = {}
    old_sec = old_scorecard.get("security", {})

    new_sec = new_response.get("security_score")
    new_sec_val = new_sec.get("score") if isinstance(new_sec, dict) else new_sec
    old_sec_val = old_sec.get("score") if isinstance(old_sec, dict) else old_sec

    diff: dict = {
        "score_old": old_ds.get("score"),
        "score_new": new_response.get("score"),
        "verdict_old": old_ds.get("verdict"),
        "verdict_new": new_response.get("verdict"),
        "data_source_old": old_pc.get("data_source"),
        "data_source_new": new_response.get("data_source"),
        "field_changes": [],
    }

    compare_fields = [
        ("score", old_ds.get("score"), new_response.get("score")),
        ("verdict", old_ds.get("verdict"), new_response.get("verdict")),
        ("data_source", old_pc.get("data_source"), new_response.get("data_source")),
        ("market_confidence", old_pc.get("market_confidence"), new_response.get("market_confidence")),
        ("estimated_value", old_pc.get("estimated_value"), new_response.get("estimated_value")),
        ("sold_avg", old_pc.get("sold_avg"), new_response.get("sold_avg")),
        ("sold_count", old_pc.get("sold_count"), new_response.get("sold_count")),
        ("active_count", old_pc.get("active_count", 0), new_response.get("active_count", 0)),
        ("security_score", old_sec_val, new_sec_val),
    ]

    for name, old_val, new_val in compare_fields:
        if old_val != new_val:
            diff["field_changes"].append({"field": name, "old": old_val, "new": new_val})

    old_greens = set(old_ds.get("green_flags", []))
    new_greens = set(new_response.get("green_flags", []))
    if old_greens != new_greens:
        diff["green_flags"] = {"added": list(new_greens - old_greens), "removed": list(old_greens - new_greens)}

    old_reds = set(old_ds.get("red_flags", []))
    new_reds = set(new_response.get("red_flags", []))
    if old_reds != new_reds:
        diff["red_flags"] = {"added": list(new_reds - old_reds), "removed": list(old_reds - new_reds)}

    old_aff = old_scorecard.get("affiliate_cards", [])
    new_aff = new_response.get("affiliate_cards", [])
    old_aff_keys = set(c.get("program_key", "") for c in old_aff if isinstance(c, dict))
    new_aff_keys = set(c.get("program_key", "") for c in new_aff if isinstance(c, dict))
    if old_aff_keys != new_aff_keys:
        diff["affiliate_cards"] = {"added": list(new_aff_keys - old_aff_keys), "removed": list(old_aff_keys - new_aff_keys)}

    return diff
