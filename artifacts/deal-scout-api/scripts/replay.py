#!/usr/bin/env python3
"""
Deal Scout — Scoring Replay & Analysis Script

Usage:
  python scripts/replay.py              # replay all thumbs-down entries
  python scripts/replay.py --all        # replay everything (including unrated)
  python scripts/replay.py --analyze    # show patterns, no replay
  python scripts/replay.py --limit 20   # replay up to 20 entries

What it does:
  1. Fetches thumbs-down (or all) entries from deal_scores
  2. Re-POSTs each listing to the /score endpoint with the CURRENT prompt/logic
  3. Compares old score vs new score
  4. Updates replay_score and replayed_at in the DB
  5. Prints a report showing which listings improved

After the report, look at entries that STILL score wrong and update
the Claude prompt in scoring/deal_scorer.py accordingly.
"""

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime

import asyncpg
import httpx

API_URL = os.getenv(
    "DEAL_SCOUT_API_URL",
    "http://localhost:8000",
)
DB_URL = os.getenv("DATABASE_URL", "")

SCORE_COLOR = {
    "green":  lambda s: s >= 7,
    "yellow": lambda s: 5 <= s < 7,
    "red":    lambda s: s < 5,
}


def color_score(s):
    if s is None:
        return "?"
    s = int(s)
    if s >= 7:
        return f"\033[92m{s}\033[0m"
    if s >= 5:
        return f"\033[93m{s}\033[0m"
    return f"\033[91m{s}\033[0m"


def direction(old, new):
    if old is None or new is None:
        return "?"
    d = new - old
    if d > 0:
        return f"\033[92m▲ +{d}\033[0m"
    if d < 0:
        return f"\033[91m▼ {d}\033[0m"
    return f"\033[90m= 0\033[0m"


async def fetch_entries(pool, mode: str, limit: int):
    if mode == "all":
        where = "TRUE"
    elif mode == "thumbs_down":
        where = "thumbs = -1"
    else:
        where = "thumbs = -1 OR thumbs = 1"

    rows = await pool.fetch(
        f"""SELECT id, created_at, platform, score, thumbs, listing_json, score_json
            FROM deal_scores
            WHERE {where}
            ORDER BY created_at DESC
            LIMIT $1""",
        limit,
    )
    return rows


async def replay_entry(client: httpx.AsyncClient, listing_json: dict) -> dict | None:
    try:
        resp = await client.post(
            f"{API_URL}/score",
            json=listing_json,
            timeout=45.0,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"    [ERROR] API call failed: {e}")
        return None


async def analyze_patterns(pool):
    """Print patterns in thumbs-down scores without replaying."""
    rows = await pool.fetch(
        """SELECT id, platform, score, listing_json, score_json
           FROM deal_scores
           WHERE thumbs = -1
           ORDER BY created_at DESC"""
    )
    print(f"\n{'='*60}")
    print(f"THUMBS-DOWN PATTERN ANALYSIS ({len(rows)} entries)")
    print(f"{'='*60}\n")

    if not rows:
        print("No thumbs-down entries yet. Score some listings and tap 👎 on wrong ones.\n")
        return

    for r in rows:
        listing = r["listing_json"] if isinstance(r["listing_json"], dict) else json.loads(r["listing_json"])
        score_data = r["score_json"] if isinstance(r["score_json"], dict) else json.loads(r["score_json"])
        print(f"  ID {r['id']} | {r['platform']} | Score: {color_score(r['score'])}")
        print(f"  Title:   {listing.get('title','')[:60]}")
        print(f"  Price:   ${listing.get('price', 0):.0f}")
        print(f"  Verdict: {score_data.get('verdict','')}")
        print(f"  Summary: {score_data.get('summary','')[:100]}")
        print(f"  Flags:   🔴 {', '.join(score_data.get('red_flags',[])[:2])}")
        print()


async def main(mode: str, limit: int, analyze_only: bool):
    if not DB_URL:
        print("ERROR: DATABASE_URL env var not set.")
        sys.exit(1)

    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=3)

    if analyze_only:
        await analyze_patterns(pool)
        await pool.close()
        return

    entries = await fetch_entries(pool, mode, limit)
    if not entries:
        print(f"No entries found for mode '{mode}'.")
        await pool.close()
        return

    print(f"\n{'='*60}")
    print(f"DEAL SCOUT REPLAY — {len(entries)} listings")
    print(f"API: {API_URL}")
    print(f"Mode: {mode}  |  Time: {datetime.now():%Y-%m-%d %H:%M}")
    print(f"{'='*60}\n")

    improved = 0
    regressed = 0
    unchanged = 0
    errors = 0

    async with httpx.AsyncClient() as client:
        for i, row in enumerate(entries, 1):
            listing = row["listing_json"] if isinstance(row["listing_json"], dict) else json.loads(row["listing_json"])
            old_score = row["score"]
            thumb = "👍" if row["thumbs"] == 1 else "👎" if row["thumbs"] == -1 else "⬜"

            title = listing.get("title", "")[:50]
            price = listing.get("price", 0)
            platform = row["platform"] or ""

            print(f"[{i}/{len(entries)}] {thumb} {platform} | {title} | ${price:.0f}")
            print(f"  Old score: {color_score(old_score)}", end="  ")

            result = await replay_entry(client, listing)
            if result is None:
                print("SKIP (API error)")
                errors += 1
                continue

            new_score = result.get("score")
            print(f"New score: {color_score(new_score)}  {direction(old_score, new_score)}")
            print(f"  Verdict: {result.get('verdict','')}")

            if old_score is not None and new_score is not None:
                d = new_score - old_score
                if row["thumbs"] == -1:
                    if d > 0:
                        improved += 1
                    elif d < 0:
                        regressed += 1
                    else:
                        unchanged += 1

            try:
                await pool.execute(
                    "UPDATE deal_scores SET replay_score=$1, replayed_at=NOW() WHERE id=$2",
                    new_score, row["id"],
                )
            except Exception as e:
                print(f"  [WARN] DB update failed: {e}")

            print()

    print(f"{'='*60}")
    print(f"SUMMARY")
    print(f"  Replayed:  {len(entries) - errors}")
    print(f"  Errors:    {errors}")
    if mode in ("thumbs_down", "both"):
        print(f"  Improved:  \033[92m{improved}\033[0m  (👎 score moved in right direction)")
        print(f"  Regressed: \033[91m{regressed}\033[0m  (👎 score got worse)")
        print(f"  Unchanged: {unchanged}")
    print(f"{'='*60}\n")

    await pool.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Replay Deal Scout scores and compare old vs new.")
    parser.add_argument("--all",     action="store_true", help="Replay all entries, not just thumbs-down")
    parser.add_argument("--analyze", action="store_true", help="Show patterns in thumbs-down entries, no replay")
    parser.add_argument("--limit",   type=int, default=50, help="Max entries to replay (default 50)")
    args = parser.parse_args()

    mode = "all" if args.all else "thumbs_down"
    asyncio.run(main(mode=mode, limit=args.limit, analyze_only=args.analyze))
