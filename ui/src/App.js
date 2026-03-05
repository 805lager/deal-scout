/**
 * Deal Scout — React UI
 *
 * Standalone scorer: user fills in a listing manually or pastes a URL,
 * hits Score, and gets the full Claude AI deal analysis.
 *
 * Talks to FastAPI at localhost:8000 via the CRA proxy (package.json → "proxy").
 * So all /score calls in this file are relative — no localhost:8000 needed.
 *
 * To run:  cd ui && npm start
 */

import { useState, useEffect, useRef } from "react";

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:        "#0a0c0f",
  surface:   "#11151a",
  border:    "#1e252f",
  borderHi:  "#2d3a48",
  text:      "#e2e8f0",
  muted:     "#64748b",
  faint:     "#1e2830",
  amber:     "#f59e0b",
  amberDim:  "#78450a",
  green:     "#22c55e",
  greenDim:  "#14532d",
  red:       "#ef4444",
  redDim:    "#7f1d1d",
  blue:      "#38bdf8",
  purple:    "#a78bfa",
};

// ── Fonts injected once ───────────────────────────────────────────────────────
const FONT_LINK = "https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=JetBrains+Mono:wght@400;500;600&display=swap";

// ── Global styles (injected into <head>) ──────────────────────────────────────
const GLOBAL_CSS = `
  @import url('${FONT_LINK}');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; }
  body {
    background: ${C.bg};
    color: ${C.text};
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    line-height: 1.6;
    letter-spacing: -0.02em;
    -webkit-font-smoothing: antialiased;
  }
  ::selection { background: ${C.amber}33; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: ${C.bg}; }
  ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
  input, textarea, select {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  @keyframes scanline {
    0%   { transform: translateY(-100%); }
    100% { transform: translateY(100vh); }
  }
  @keyframes scoreCount {
    from { opacity: 0; transform: scale(0.7); }
    to   { opacity: 1; transform: scale(1); }
  }
`;

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const fmt$ = n => n != null ? `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—";
const scoreColor = s => s >= 8 ? C.green : s >= 6 ? C.amber : s >= 4 ? "#fb923c" : C.red;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ── Sub-components ────────────────────────────────────────────────────────────

function ApiStatus({ status }) {
  const dot = { width: 7, height: 7, borderRadius: "50%", display: "inline-block", marginRight: 6 };
  if (status === "checking") return (
    <span style={{ color: C.muted, fontSize: 11 }}>
      <span style={{ ...dot, background: C.muted, animation: "pulse 1.2s infinite" }} />
      checking api...
    </span>
  );
  if (status === "ok") return (
    <span style={{ color: C.green, fontSize: 11 }}>
      <span style={{ ...dot, background: C.green }} />api online
    </span>
  );
  return (
    <span style={{ color: C.red, fontSize: 11 }}>
      <span style={{ ...dot, background: C.red }} />api offline — run uvicorn
    </span>
  );
}

function ScoreRing({ score, animate }) {
  const r = 52, cx = 64, cy = 64;
  const circ = 2 * Math.PI * r;
  const pct = clamp(score / 10, 0, 1);
  const dash = circ * pct;
  const col = scoreColor(score);

  return (
    <div style={{ position: "relative", width: 128, height: 128 }}>
      <svg width={128} height={128} style={{ transform: "rotate(-90deg)" }}>
        {/* track */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.border} strokeWidth={8} />
        {/* fill */}
        <circle
          cx={cx} cy={cy} r={r} fill="none"
          stroke={col} strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{
            transition: animate ? "stroke-dasharray 1s cubic-bezier(0.34,1.56,0.64,1)" : "none",
            filter: `drop-shadow(0 0 8px ${col}88)`,
          }}
        />
      </svg>
      <div style={{
        position: "absolute", inset: 0, display: "flex",
        flexDirection: "column", alignItems: "center", justifyContent: "center",
        animation: animate ? "scoreCount 0.5s 0.3s both" : "none",
      }}>
        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 32, fontWeight: 800, color: col, lineHeight: 1 }}>
          {score}
        </span>
        <span style={{ color: C.muted, fontSize: 10 }}>/10</span>
      </div>
    </div>
  );
}

function Flag({ type, text }) {
  const isGreen = type === "green";
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 8,
      padding: "7px 10px",
      background: isGreen ? `${C.greenDim}44` : `${C.redDim}44`,
      border: `1px solid ${isGreen ? C.greenDim : C.redDim}`,
      borderRadius: 6, marginBottom: 5, fontSize: 12,
      animation: "fadeUp 0.3s both",
    }}>
      <span style={{ flexShrink: 0, marginTop: 1 }}>{isGreen ? "✅" : "⚠️"}</span>
      <span style={{ color: isGreen ? "#86efac" : "#fca5a5" }}>{text}</span>
    </div>
  );
}

function StatRow({ label, value, highlight }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      padding: "6px 0", borderBottom: `1px solid ${C.border}`,
      fontSize: 12,
    }}>
      <span style={{ color: C.muted }}>{label}</span>
      <span style={{ color: highlight ? C.amber : C.text, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function Input({ label, name, value, onChange, placeholder, multiline, type = "text" }) {
  const common = {
    width: "100%", background: C.surface,
    border: `1px solid ${C.border}`, borderRadius: 6,
    color: C.text, padding: "9px 12px", outline: "none",
    transition: "border-color 0.15s",
    resize: multiline ? "vertical" : "none",
  };
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "block", color: C.muted, fontSize: 11, marginBottom: 5, letterSpacing: "0.06em" }}>
        {label}
      </label>
      {multiline
        ? <textarea name={name} value={value} onChange={onChange} placeholder={placeholder}
            rows={3} style={common}
            onFocus={e => e.target.style.borderColor = C.amber}
            onBlur={e => e.target.style.borderColor = C.border} />
        : <input type={type} name={name} value={value} onChange={onChange} placeholder={placeholder}
            style={common}
            onFocus={e => e.target.style.borderColor = C.amber}
            onBlur={e => e.target.style.borderColor = C.border} />
      }
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  title: "", price: "", description: "",
  condition: "Unknown", location: "", seller_name: "", listing_url: "",
};

export default function App() {
  const [form, setForm]       = useState(EMPTY_FORM);
  const [result, setResult]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [apiStatus, setApiStatus] = useState("checking");
  const [animated, setAnimated]   = useState(false);
  const resultRef = useRef(null);

  // Inject global styles once
  useEffect(() => {
    const tag = document.createElement("style");
    tag.textContent = GLOBAL_CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);

  // Check API health on mount
  useEffect(() => {
    fetch("/health")
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(() => setApiStatus("ok"))
      .catch(() => setApiStatus("offline"));
  }, []);

  const handleChange = e => {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
  };

  const handleScore = async () => {
    if (!form.title.trim() || !form.price) {
      setError("Title and price are required.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setAnimated(false);

    try {
      const payload = {
        title:       form.title.trim(),
        price:       parseFloat(form.price),
        description: form.description.trim(),
        condition:   form.condition,
        location:    form.location.trim(),
        seller_name: form.seller_name.trim(),
        listing_url: form.listing_url.trim(),
        raw_price_text: `$${form.price}`,
        is_multi_item: false,
        seller_trust: {},
      };

      const res = await fetch("/score", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Unknown error" }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setResult(data);

      // Scroll to result and trigger ring animation
      setTimeout(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        setAnimated(true);
      }, 100);

    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setResult(null);
    setError(null);
    setForm(EMPTY_FORM);
  };

  const diff = result ? result.price - result.estimated_value : 0;
  const diffPct = result && result.estimated_value
    ? Math.round(Math.abs(diff) / result.estimated_value * 100)
    : 0;

  // ── Layout ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>

      {/* Scanline overlay — subtle CRT effect */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999,
        background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)",
      }} />

      {/* Header */}
      <header style={{
        borderBottom: `1px solid ${C.border}`,
        padding: "14px 32px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: C.surface,
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 8,
            background: `linear-gradient(135deg, #667eea, #764ba2)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 17, boxShadow: "0 2px 12px #667eea44",
          }}>🛒</div>
          <div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 16, letterSpacing: "-0.01em" }}>
              Deal Scout
            </div>
            <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em" }}>AI DEAL SCORING</div>
          </div>
        </div>
        <ApiStatus status={apiStatus} />
      </header>

      {/* Body */}
      <main style={{ flex: 1, maxWidth: 720, width: "100%", margin: "0 auto", padding: "28px 20px" }}>

        {/* ── Input card ── */}
        <div style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: 28, marginBottom: 24,
          animation: "fadeUp 0.4s both",
        }}>
          <div style={{
            fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 20,
            marginBottom: 6, letterSpacing: "-0.02em",
          }}>
            Score a Deal
          </div>
          <div style={{ color: C.muted, fontSize: 12, marginBottom: 22 }}>
            Enter listing details from Facebook Marketplace, Craigslist, or anywhere else.
          </div>

          {/* Row 1 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 12 }}>
            <Input label="TITLE *" name="title" value={form.title} onChange={handleChange}
              placeholder="e.g. Orion SkyQuest XT8 Dobsonian Telescope" />
            <Input label="PRICE *" name="price" value={form.price} onChange={handleChange}
              placeholder="250" type="number" />
          </div>

          {/* Row 2 */}
          <Input label="DESCRIPTION" name="description" value={form.description} onChange={handleChange}
            placeholder="Paste the seller's description here..." multiline />

          {/* Row 3 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", color: C.muted, fontSize: 11, marginBottom: 5, letterSpacing: "0.06em" }}>
                CONDITION
              </label>
              <select name="condition" value={form.condition} onChange={handleChange}
                style={{
                  width: "100%", background: C.surface, border: `1px solid ${C.border}`,
                  borderRadius: 6, color: C.text, padding: "9px 12px", outline: "none",
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
                }}>
                <option>Unknown</option>
                <option>New</option>
                <option>Used - Like New</option>
                <option>Used - Good</option>
                <option>Used - Fair</option>
                <option>Used - Poor</option>
              </select>
            </div>
            <Input label="LOCATION" name="location" value={form.location} onChange={handleChange}
              placeholder="San Diego, CA" />
            <Input label="SELLER NAME" name="seller_name" value={form.seller_name} onChange={handleChange}
              placeholder="optional" />
          </div>

          {/* Row 4 */}
          <Input label="LISTING URL" name="listing_url" value={form.listing_url} onChange={handleChange}
            placeholder="https://www.facebook.com/marketplace/item/..." />

          {/* Error */}
          {error && (
            <div style={{
              background: `${C.redDim}66`, border: `1px solid ${C.red}44`,
              borderRadius: 6, padding: "10px 14px", marginBottom: 14,
              color: "#fca5a5", fontSize: 12,
            }}>
              ⚠️ {error}
            </div>
          )}

          {/* CTA */}
          <button
            onClick={handleScore}
            disabled={loading || apiStatus === "offline"}
            style={{
              width: "100%", padding: "13px 0",
              background: loading
                ? C.border
                : "linear-gradient(135deg, #667eea, #764ba2)",
              border: "none", borderRadius: 8, color: "#fff",
              fontFamily: "'Syne', sans-serif", fontWeight: 800,
              fontSize: 15, letterSpacing: "0.02em",
              cursor: loading ? "not-allowed" : "pointer",
              transition: "opacity 0.2s, transform 0.1s",
              transform: loading ? "none" : "translateY(0)",
              boxShadow: loading ? "none" : "0 4px 20px #667eea44",
            }}
            onMouseEnter={e => { if (!loading) e.target.style.opacity = "0.9"; }}
            onMouseLeave={e => { e.target.style.opacity = "1"; }}
          >
            {loading ? (
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
                <span style={{ animation: "pulse 0.8s infinite" }}>◈</span>
                analyzing deal...
              </span>
            ) : "▶ Score This Deal"}
          </button>
        </div>

        {/* ── Result card ── */}
        {result && (
          <div ref={resultRef} style={{ animation: "fadeUp 0.5s both" }}>

            {/* Verdict banner */}
            <div style={{
              background: result.should_buy
                ? `linear-gradient(135deg, ${C.greenDim}88, ${C.greenDim}44)`
                : `linear-gradient(135deg, ${C.redDim}88, ${C.redDim}44)`,
              border: `1px solid ${result.should_buy ? C.green : C.red}44`,
              borderRadius: 12, padding: "20px 24px", marginBottom: 16,
              display: "flex", alignItems: "center", gap: 20,
            }}>
              <div style={{ fontSize: 36 }}>{result.should_buy ? "✅" : "❌"}</div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 18,
                  color: result.should_buy ? C.green : C.red, marginBottom: 4,
                }}>
                  {result.should_buy ? "BUY IT" : "PASS ON THIS ONE"}
                </div>
                <div style={{ color: C.text, fontSize: 13, fontStyle: "italic" }}>
                  "{result.verdict}"
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{
                  background: `${scoreColor(result.score)}22`,
                  border: `1px solid ${scoreColor(result.score)}44`,
                  borderRadius: 8, padding: "4px 12px",
                  color: scoreColor(result.score),
                  fontSize: 11, fontWeight: 600, letterSpacing: "0.05em",
                }}>
                  {result.ai_confidence?.toUpperCase()} CONFIDENCE
                </div>
              </div>
            </div>

            {/* Main grid: score ring + price data */}
            <div style={{
              display: "grid", gridTemplateColumns: "175px 1fr",
              gap: 14, marginBottom: 14,
            }}>

              {/* Score ring */}
              <div style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: 24,
                display: "flex", flexDirection: "column", alignItems: "center", gap: 14,
              }}>
                <ScoreRing score={result.score} animate={animated} />
                <div style={{ textAlign: "center" }}>
                  <div style={{
                    fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 14,
                    color: scoreColor(result.score),
                  }}>
                    {result.score >= 8 ? "GREAT DEAL" : result.score >= 6 ? "FAIR DEAL" : result.score >= 4 ? "MARGINAL" : "OVERPRICED"}
                  </div>
                  <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>deal score</div>
                </div>

                {/* Recommended offer box */}
                <div style={{
                  width: "100%", background: `${C.greenDim}44`,
                  border: `1px solid ${C.greenDim}`, borderRadius: 8,
                  padding: "10px 12px", textAlign: "center",
                }}>
                  <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.08em" }}>OFFER</div>
                  <div style={{ color: C.green, fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 22 }}>
                    {fmt$(result.recommended_offer)}
                  </div>
                </div>
              </div>

              {/* Price breakdown */}
              <div style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: 24,
              }}>
                <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", marginBottom: 14 }}>
                  MARKET ANALYSIS
                </div>

                <StatRow label="eBay sold avg"   value={fmt$(result.sold_avg)} />
                <StatRow label="eBay active avg" value={fmt$(result.active_avg)} />
                {result.new_price > 0 &&
                  <StatRow label="New retail"    value={fmt$(result.new_price)} />}
                <StatRow label="Market estimate" value={fmt$(result.estimated_value)} highlight />

                <div style={{ margin: "12px 0", height: 1, background: C.border }} />

                {/* Listed price vs market */}
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "8px 0",
                }}>
                  <span style={{ color: C.muted, fontSize: 12 }}>listed price</span>
                  <span style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 20, color: C.text }}>
                    {fmt$(result.price)}
                  </span>
                </div>

                {/* Delta bar */}
                <div style={{
                  padding: "8px 12px", borderRadius: 6, marginTop: 4,
                  background: diff > 0 ? `${C.redDim}66` : `${C.greenDim}66`,
                  border: `1px solid ${diff > 0 ? C.redDim : C.greenDim}`,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span style={{ fontSize: 12, color: diff > 0 ? "#fca5a5" : "#86efac" }}>
                    {diff > 0 ? `🔴 ${fmt$(Math.abs(diff))} over market` : `🟢 ${fmt$(Math.abs(diff))} below market`}
                  </span>
                  <span style={{
                    fontWeight: 700, fontSize: 13,
                    color: diff > 0 ? C.red : C.green,
                  }}>
                    {diff > 0 ? "+" : "-"}{diffPct}%
                  </span>
                </div>

                <div style={{ marginTop: 12, padding: "8px 0", borderTop: `1px solid ${C.border}` }}>
                  <span style={{ color: C.muted, fontSize: 11 }}>
                    market confidence: <span style={{ color: C.amber }}>{result.market_confidence}</span>
                    {result.sold_count > 0 && ` · ${result.sold_count} comps`}
                  </span>
                </div>
              </div>
            </div>

            {/* Summary + flags */}
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr",
              gap: 16, marginBottom: 16,
            }}>

              {/* Summary */}
              <div style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: 22,
              }}>
                <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", marginBottom: 12 }}>
                  AI ANALYSIS
                </div>
                <div style={{ color: C.text, fontSize: 13, lineHeight: 1.7, marginBottom: 14 }}>
                  {result.summary}
                </div>
                {result.value_assessment && (
                  <div style={{
                    background: C.faint, borderRadius: 6, padding: "10px 12px",
                    color: C.muted, fontSize: 12, borderLeft: `3px solid ${C.purple}`,
                  }}>
                    {result.value_assessment}
                  </div>
                )}
                {result.condition_notes && (
                  <div style={{
                    background: C.faint, borderRadius: 6, padding: "10px 12px",
                    color: C.muted, fontSize: 12, borderLeft: `3px solid ${C.blue}`,
                    marginTop: 8,
                  }}>
                    {result.condition_notes}
                  </div>
                )}
              </div>

              {/* Flags */}
              <div style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: 22,
              }}>
                <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", marginBottom: 12 }}>
                  RED & GREEN FLAGS
                </div>
                {result.green_flags?.map((f, i) =>
                  <Flag key={i} type="green" text={f} />)}
                {result.red_flags?.map((f, i) =>
                  <Flag key={i} type="red" text={f} />)}
                {(!result.green_flags?.length && !result.red_flags?.length) &&
                  <div style={{ color: C.muted, fontSize: 12 }}>No notable flags.</div>}
              </div>
            </div>

            {/* Compare + actions */}
            <div style={{
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 12, padding: 22, marginBottom: 16,
              display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
            }}>
              <div style={{ color: C.muted, fontSize: 10, letterSpacing: "0.1em", width: "100%", marginBottom: 4 }}>
                COMPARE PRICES
              </div>
              {/* eBay */}
              <a
                href={`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(result.title)}&LH_Complete=1&LH_Sold=1`}
                target="_blank" rel="noreferrer"
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "9px 16px", background: C.faint,
                  border: `1px solid ${C.border}`, borderRadius: 8,
                  color: C.green, textDecoration: "none", fontSize: 12, fontWeight: 600,
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = C.green}
                onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
              >
                📦 eBay Sold Listings
              </a>
              {/* Amazon */}
              <a
                href={`https://www.amazon.com/s?k=${encodeURIComponent(result.title)}`}
                target="_blank" rel="noreferrer"
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "9px 16px", background: C.faint,
                  border: `1px solid ${C.border}`, borderRadius: 8,
                  color: C.amber, textDecoration: "none", fontSize: 12, fontWeight: 600,
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = C.amber}
                onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
              >
                🛒 Amazon Price
              </a>
              {result.listing_url && (
                <a
                  href={result.listing_url}
                  target="_blank" rel="noreferrer"
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "9px 16px", background: C.faint,
                    border: `1px solid ${C.border}`, borderRadius: 8,
                    color: C.blue, textDecoration: "none", fontSize: 12, fontWeight: 600,
                    transition: "border-color 0.15s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = C.blue}
                  onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
                >
                  🔗 Original Listing
                </a>
              )}

              {/* Score another */}
              <button
                onClick={handleReset}
                style={{
                  marginLeft: "auto", padding: "9px 18px",
                  background: "transparent", border: `1px solid ${C.border}`,
                  borderRadius: 8, color: C.muted, fontSize: 12,
                  cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
                  transition: "border-color 0.15s, color 0.15s",
                }}
                onMouseEnter={e => { e.target.style.borderColor = C.amber; e.target.style.color = C.amber; }}
                onMouseLeave={e => { e.target.style.borderColor = C.border; e.target.style.color = C.muted; }}
              >
                ↩ Score Another
              </button>
            </div>

            {/* Footer */}
            <div style={{ textAlign: "center", color: C.muted, fontSize: 10, letterSpacing: "0.06em" }}>
              POWERED BY CLAUDE AI · EBAY MARKET DATA · {result.model_used?.toUpperCase()}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
