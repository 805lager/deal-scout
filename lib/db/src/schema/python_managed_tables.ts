// Tables created and managed by the Python FastAPI service
// (artifacts/deal-scout-api/main.py + scoring/*.py) via raw
// `CREATE TABLE IF NOT EXISTS` statements at startup.
//
// They are declared here ONLY so `drizzle-kit push` recognizes them
// and stops proposing to drop them on every migration. The TypeScript
// app does not read or write these tables directly — schema changes
// MUST be made on the Python side first, then mirrored here.
//
// Source of truth for each table:
//   affiliate_events    — main.py (_ensure_affiliate_table)
//   query_corrections   — main.py (_ensure_corrections_table)
//   score_cache         — main.py (_ensure_score_cache_table)
//   nav_debug_events    — main.py (_ensure_nav_debug_table)
//   score_log           — main.py (_ensure_score_log_table)
//   price_cache         — scoring/claude_pricer.py
//   deal_scores         — scoring/data_pipeline.py + Migration "install_id" in main.py
//   diag_reports        — scoring/data_pipeline.py
//   market_signals      — scoring/data_pipeline.py

import {
  pgTable,
  serial,
  bigserial,
  text,
  varchar,
  integer,
  smallint,
  doublePrecision,
  numeric,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── affiliate_events ────────────────────────────────────────────────
export const affiliateEventsTable = pgTable("affiliate_events", {
  id:               serial("id").primaryKey(),
  createdAt:        timestamp("created_at",   { withTimezone: true }).defaultNow(),
  event:            text("event").notNull(),
  program:          text("program").default(""),
  category:         text("category").default(""),
  priceBucket:      text("price_bucket").default(""),
  cardType:         text("card_type").default(""),
  dealScore:        integer("deal_score").default(0),
  position:         integer("position").default(0),
  selectionReason:  text("selection_reason").default(""),
  commissionLive:   boolean("commission_live").default(false),
});

// ── query_corrections ───────────────────────────────────────────────
export const queryCorrectionsTable = pgTable("query_corrections", {
  id:                 serial("id").primaryKey(),
  createdAt:          timestamp("created_at", { withTimezone: true }).defaultNow(),
  listingTitle:       text("listing_title").notNull(),
  badQuery:           text("bad_query").default(""),
  goodQuery:          text("good_query").default(""),
  correctPriceLow:    doublePrecision("correct_price_low").default(0),
  correctPriceHigh:   doublePrecision("correct_price_high").default(0),
  notes:              text("notes").default(""),
});

// ── score_cache (PK is cache_key, not id) ───────────────────────────
export const scoreCacheTable = pgTable(
  "score_cache",
  {
    cacheKey:     text("cache_key").primaryKey(),
    listingUrl:   text("listing_url").default(""),
    askingPrice:  doublePrecision("asking_price").default(0),
    responseJson: jsonb("response_json").notNull(),
    createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow(),
    expiresAt:    timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    urlIdx:     index("idx_score_cache_url").on(t.listingUrl),
    expiresIdx: index("idx_score_cache_expires").on(t.expiresAt),
  }),
);

// ── nav_debug_events ────────────────────────────────────────────────
export const navDebugEventsTable = pgTable("nav_debug_events", {
  id:        serial("id").primaryKey(),
  serverTs:  timestamp("server_ts", { withTimezone: true }).defaultNow(),
  payload:   jsonb("payload").notNull(),
});

// ── score_log ───────────────────────────────────────────────────────
export const scoreLogTable = pgTable("score_log", {
  id:        serial("id").primaryKey(),
  serverTs:  timestamp("server_ts", { withTimezone: true }).defaultNow(),
  payload:   jsonb("payload").notNull(),
});

// ── price_cache ─────────────────────────────────────────────────────
export const priceCacheTable = pgTable(
  "price_cache",
  {
    id:           serial("id").primaryKey(),
    queryKey:     text("query_key").notNull(),
    condition:    text("condition").notNull().default("Used"),
    avgUsedPrice: doublePrecision("avg_used_price"),
    priceLow:     doublePrecision("price_low"),
    priceHigh:    doublePrecision("price_high"),
    newRetail:    doublePrecision("new_retail").default(0),
    confidence:   text("confidence").default("medium"),
    itemId:       text("item_id").default(""),
    notes:        text("notes").default(""),
    dataSource:   text("data_source").default("claude_knowledge"),
    createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    queryIdx: index("idx_price_cache_query").on(t.queryKey, t.condition),
  }),
);

// ── deal_scores (heaviest table — 5 indexes inc. 2 partial) ─────────
export const dealScoresTable = pgTable(
  "deal_scores",
  {
    id:                       serial("id").primaryKey(),
    createdAt:                timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    platform:                 varchar("platform"),
    listingUrl:               varchar("listing_url"),
    listingJson:              jsonb("listing_json").notNull(),
    scoreJson:                jsonb("score_json").notNull(),
    score:                    smallint("score"),
    thumbs:                   smallint("thumbs"),
    thumbsAt:                 timestamp("thumbs_at", { withTimezone: true }),
    replayScore:              smallint("replay_score"),
    replayedAt:               timestamp("replayed_at", { withTimezone: true }),
    thumbsReason:             varchar("thumbs_reason"),
    ebayCompsJson:            jsonb("ebay_comps_json"),
    affiliateImpressionsJson: jsonb("affiliate_impressions_json"),
    installId:                text("install_id"),
  },
  (t) => ({
    createdIdx:      index("idx_deal_scores_created").on(sql`${t.createdAt} DESC`),
    installIdIdx:    index("idx_deal_scores_install_id").on(t.installId),
    platformIdx:     index("idx_deal_scores_platform").on(t.platform),
    thumbsIdx:       index("idx_deal_scores_thumbs").on(t.thumbs).where(sql`${t.thumbs} IS NOT NULL`),
    thumbsReasonIdx: index("idx_deal_scores_thumbs_reason").on(t.thumbsReason).where(sql`${t.thumbsReason} IS NOT NULL`),
  }),
);

// ── diag_reports ────────────────────────────────────────────────────
export const diagReportsTable = pgTable(
  "diag_reports",
  {
    id:        serial("id").primaryKey(),
    serverTs:  timestamp("server_ts", { withTimezone: true }).notNull().defaultNow(),
    payload:   jsonb("payload").notNull(),
  },
  (t) => ({
    tsIdx: index("diag_reports_ts_idx").on(sql`${t.serverTs} DESC`),
  }),
);

// ── market_signals (bigint id) ──────────────────────────────────────
export const marketSignalsTable = pgTable(
  "market_signals",
  {
    id:                bigserial("id", { mode: "bigint" }).primaryKey(),
    ts:                timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    category:          text("category"),
    itemLabel:         text("item_label"),
    condition:         text("condition"),
    city:              text("city"),
    stateCode:         text("state_code"),
    askingPrice:       numeric("asking_price"),
    ebaySoldAvg:       numeric("ebay_sold_avg"),
    ebayActiveAvg:     numeric("ebay_active_avg"),
    newPrice:          numeric("new_price"),
    clAskingAvg:       numeric("cl_asking_avg"),
    priceGapPct:       numeric("price_gap_pct"),
    dealScore:         smallint("deal_score"),
    buyNewTrigger:     boolean("buy_new_trigger").default(false),
    affiliatePrograms: text("affiliate_programs"),
    platform:          text("platform").default("facebook_marketplace"),
  },
  (t) => ({
    categoryIdx: index("idx_ms_category").on(t.category),
    itemIdx:     index("idx_ms_item").on(t.itemLabel),
    platformIdx: index("idx_ms_platform").on(t.platform),
    tsIdx:       index("idx_ms_ts").on(t.ts),
  }),
);
