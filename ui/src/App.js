import { useState } from "react";

// ── API call ──────────────────────────────────────────────────────────────────
// WHY proxy: package.json has "proxy": "http://localhost:8000"
// so we just call /score and React dev server forwards it to FastAPI.
// No CORS issues, no hardcoded ports in the UI code.
async function scoreListing(formData) {
  const response = await fetch("/score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title:          formData.title,
      price:          parseFloat(formData.price),
      raw_price_text: `$${formData.price}`,
      description:    formData.description,
      location:       formData.location,
      condition:      formData.condition,
      seller_name:    formData.seller_name,
      listing_url:    formData.listing_url,
    }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.detail || "Scoring failed");
  }
  return response.json();
}

// ── Score Bar component ───────────────────────────────────────────────────────
function ScoreBar({ score }) {
  const colors = {
    great:  "#22c55e",
    good:   "#86efac",
    fair:   "#fbbf24",
    poor:   "#f97316",
    bad:    "#ef4444",
  };
  const color =
    score >= 9 ? colors.great :
    score >= 7 ? colors.good  :
    score >= 5 ? colors.fair  :
    score >= 3 ? colors.poor  : colors.bad;

  return (
    <div style={{ margin: "12px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontWeight: 700, fontSize: 18 }}>Deal Score</span>
        <span style={{ fontWeight: 700, fontSize: 18, color }}>{score}/10</span>
      </div>
      <div style={{ background: "#e5e7eb", borderRadius: 8, height: 14, overflow: "hidden" }}>
        <div style={{
          width: `${score * 10}%`,
          height: "100%",
          background: color,
          borderRadius: 8,
          transition: "width 0.6s ease",
        }} />
      </div>
    </div>
  );
}

// ── Flag list component ───────────────────────────────────────────────────────
function FlagList({ flags, type }) {
  if (!flags || flags.length === 0) return null;
  const isGreen = type === "green";
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: isGreen ? "#16a34a" : "#dc2626" }}>
        {isGreen ? "✅ Green Flags" : "⚠️ Red Flags"}
      </div>
      {flags.map((flag, i) => (
        <div key={i} style={{
          padding: "6px 10px",
          marginBottom: 4,
          borderRadius: 6,
          background: isGreen ? "#f0fdf4" : "#fef2f2",
          borderLeft: `3px solid ${isGreen ? "#22c55e" : "#ef4444"}`,
          fontSize: 14,
          color: "#374151",
        }}>
          {flag}
        </div>
      ))}
    </div>
  );
}

// ── Price comparison row ──────────────────────────────────────────────────────
function PriceRow({ label, value, highlight }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      padding: "6px 0",
      borderBottom: "1px solid #f3f4f6",
      fontWeight: highlight ? 700 : 400,
      color: highlight ? "#111827" : "#6b7280",
    }}>
      <span>{label}</span>
      <span>${value.toFixed(2)}</span>
    </div>
  );
}

// ── Result card ───────────────────────────────────────────────────────────────
function ResultCard({ result }) {
  const buyColor  = result.should_buy ? "#16a34a" : "#dc2626";
  const buyLabel  = result.should_buy ? "✅ BUY" : "❌ PASS";
  const diffAmt   = result.price - result.estimated_value;
  const diffPct   = ((diffAmt / result.estimated_value) * 100).toFixed(1);
  const overUnder = diffAmt > 0 ? `🔴 Overpriced by $${diffAmt.toFixed(0)} (${diffPct}%)` : `🟢 Below market by $${Math.abs(diffAmt).toFixed(0)} (${Math.abs(diffPct)}%)`;

  return (
    <div style={{
      background: "#fff",
      borderRadius: 12,
      padding: 24,
      boxShadow: "0 4px 24px rgba(0,0,0,0.10)",
      marginTop: 24,
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18, color: "#111827" }}>{result.title}</div>
          <div style={{ color: "#6b7280", fontSize: 14, marginTop: 2 }}>
            {result.condition} · {result.location}
          </div>
        </div>
        <div style={{
          background: buyColor,
          color: "#fff",
          borderRadius: 8,
          padding: "8px 16px",
          fontWeight: 700,
          fontSize: 16,
        }}>
          {buyLabel}
        </div>
      </div>

      {/* Score bar */}
      <ScoreBar score={result.score} />

      {/* Verdict */}
      <div style={{
        background: "#f8fafc",
        borderRadius: 8,
        padding: "12px 14px",
        margin: "12px 0",
        fontStyle: "italic",
        color: "#374151",
        fontSize: 15,
        borderLeft: "4px solid #6366f1",
      }}>
        {result.verdict}
      </div>

      {/* Summary */}
      <p style={{ color: "#374151", fontSize: 14, lineHeight: 1.6, margin: "12px 0" }}>
        {result.summary}
      </p>

      {/* Price comparison */}
      <div style={{
        background: "#f8fafc",
        borderRadius: 8,
        padding: "14px 16px",
        margin: "12px 0",
      }}>
        <div style={{ fontWeight: 600, marginBottom: 8, color: "#111827" }}>
          📊 Price Comparison
          <span style={{ fontSize: 12, fontWeight: 400, color: "#9ca3af", marginLeft: 8 }}>
            ({result.market_confidence} confidence · {result.sold_count} eBay sold comps)
          </span>
        </div>
        {result.sold_avg > 0    && <PriceRow label="eBay sold avg"    value={result.sold_avg} />}
        {result.active_avg > 0  && <PriceRow label="eBay active avg"  value={result.active_avg} />}
        {result.new_price > 0   && <PriceRow label="New retail"       value={result.new_price} />}
        <PriceRow label="Estimated value"  value={result.estimated_value} />
        <PriceRow label="Listing price"    value={result.price} highlight />
        <div style={{ marginTop: 8, fontWeight: 600, fontSize: 14 }}>{overUnder}</div>
      </div>

      {/* Flags */}
      <FlagList flags={result.green_flags} type="green" />
      <FlagList flags={result.red_flags}   type="red" />

      {/* Condition + value notes */}
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ background: "#f0f9ff", borderRadius: 8, padding: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#0369a1", marginBottom: 4 }}>
            💎 Value Assessment
          </div>
          <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5 }}>
            {result.value_assessment}
          </div>
        </div>
        <div style={{ background: "#fefce8", borderRadius: 8, padding: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#a16207", marginBottom: 4 }}>
            🔍 Condition Notes
          </div>
          <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5 }}>
            {result.condition_notes}
          </div>
        </div>
      </div>

      {/* Recommended offer */}
      <div style={{
        marginTop: 16,
        background: "#f0fdf4",
        borderRadius: 8,
        padding: "12px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span style={{ fontWeight: 600, color: "#15803d" }}>💬 Recommended Offer</span>
        <span style={{ fontWeight: 700, fontSize: 20, color: "#15803d" }}>
          ${result.recommended_offer.toFixed(0)}
        </span>
      </div>

      {/* Footer */}
      <div style={{ marginTop: 12, fontSize: 12, color: "#9ca3af", textAlign: "right" }}>
        Scored by {result.model_used} · AI confidence: {result.ai_confidence}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
const EMPTY_FORM = {
  title: "", price: "", description: "",
  location: "", condition: "Used", seller_name: "", listing_url: "",
};

export default function App() {
  const [form,    setForm]    = useState(EMPTY_FORM);
  const [result,  setResult]  = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  const handleChange = (e) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async () => {
    if (!form.title || !form.price) {
      setError("Title and price are required.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await scoreListing(form);
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setForm(EMPTY_FORM);
    setResult(null);
    setError(null);
  };

  // Input field style
  const inp = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
    fontFamily: "inherit",
  };

  const label = {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
    marginBottom: 4,
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      padding: "32px 16px",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
    }}>
      <div style={{ maxWidth: 680, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🛒</div>
          <h1 style={{ color: "#fff", fontSize: 28, fontWeight: 800, margin: 0 }}>
            Deal Scorer
          </h1>
          <p style={{ color: "rgba(255,255,255,0.8)", marginTop: 6, fontSize: 15 }}>
            AI-powered deal analysis for second-hand listings
          </p>
        </div>

        {/* Input card */}
        <div style={{
          background: "#fff",
          borderRadius: 14,
          padding: 24,
          boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
        }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16, color: "#111827" }}>
            Paste Listing Details
          </div>

          {/* Title + Price row */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={label}>Item Title *</label>
              <input style={inp} name="title" value={form.title}
                placeholder="e.g. MacBook Pro 2021 M1" onChange={handleChange} />
            </div>
            <div>
              <label style={label}>Price *</label>
              <input style={inp} name="price" value={form.price} type="number"
                placeholder="450" onChange={handleChange} />
            </div>
          </div>

          {/* Condition + Location row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={label}>Condition</label>
              <select style={inp} name="condition" value={form.condition} onChange={handleChange}>
                <option>New</option>
                <option>Used - Like New</option>
                <option>Used - Good</option>
                <option>Used - Fair</option>
                <option>For Parts</option>
              </select>
            </div>
            <div>
              <label style={label}>Location</label>
              <input style={inp} name="location" value={form.location}
                placeholder="e.g. San Diego, CA" onChange={handleChange} />
            </div>
          </div>

          {/* Description */}
          <div style={{ marginBottom: 12 }}>
            <label style={label}>Description</label>
            <textarea style={{ ...inp, minHeight: 80, resize: "vertical" }}
              name="description" value={form.description}
              placeholder="Paste the seller's description here..."
              onChange={handleChange} />
          </div>

          {/* Seller + URL row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div>
              <label style={label}>Seller Name</label>
              <input style={inp} name="seller_name" value={form.seller_name}
                placeholder="Optional" onChange={handleChange} />
            </div>
            <div>
              <label style={label}>Listing URL</label>
              <input style={inp} name="listing_url" value={form.listing_url}
                placeholder="Optional" onChange={handleChange} />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div style={{
              background: "#fef2f2", border: "1px solid #fecaca",
              borderRadius: 8, padding: "10px 14px", marginBottom: 16,
              color: "#dc2626", fontSize: 14,
            }}>
              ⚠️ {error}
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={handleSubmit}
              disabled={loading}
              style={{
                flex: 1,
                padding: "12px 0",
                background: loading ? "#9ca3af" : "linear-gradient(135deg, #667eea, #764ba2)",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: 15,
                cursor: loading ? "not-allowed" : "pointer",
                transition: "opacity 0.2s",
              }}
            >
              {loading ? "⏳ Scoring..." : "🔍 Score This Deal"}
            </button>
            {(result || error) && (
              <button onClick={handleClear} style={{
                padding: "12px 20px",
                background: "#f3f4f6",
                border: "none",
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 14,
                cursor: "pointer",
                color: "#374151",
              }}>
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Result */}
        {result && <ResultCard result={result} />}

        {/* Footer */}
        <div style={{ textAlign: "center", marginTop: 20, color: "rgba(255,255,255,0.6)", fontSize: 13 }}>
          Powered by Claude AI · eBay market data
        </div>
      </div>
    </div>
  );
}
