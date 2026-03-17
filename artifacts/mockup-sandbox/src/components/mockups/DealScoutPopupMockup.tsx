export default function DealScoutPopupMockup() {
  return (
    <div style={{
      background: "#1a1a2e",
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "40px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "32px" }}>

        {/* Browser chrome frame */}
        <div style={{
          background: "#2d2d2d",
          borderRadius: "12px",
          overflow: "hidden",
          boxShadow: "0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08)",
          width: "360px",
        }}>
          {/* Browser top bar */}
          <div style={{
            background: "#3c3c3c",
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ff5f57" }} />
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#febc2e" }} />
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#28c840" }} />
            <div style={{
              flex: 1,
              background: "#1e1e1e",
              borderRadius: "6px",
              padding: "4px 12px",
              fontSize: "11px",
              color: "#888",
              marginLeft: "8px",
            }}>
              facebook.com/marketplace/item/123456
            </div>
            {/* Extension icon in toolbar */}
            <div style={{
              width: 20,
              height: 20,
              borderRadius: "4px",
              background: "linear-gradient(135deg, #0d1117, #1a1f2e)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "12px",
              boxShadow: "0 0 0 1px rgba(124,140,248,0.4)",
            }}>🔍</div>
          </div>

          {/* The Popup itself */}
          <div style={{
            background: "#0d0c18",
            width: "320px",
            color: "#e2e8f0",
            fontSize: "13px",
            margin: "0 auto",
          }}>
            {/* Header */}
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 16px 12px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: "7px",
                  background: "linear-gradient(135deg, #1a1f2e, #0d1117)",
                  boxShadow: "0 0 0 1px rgba(124,140,248,0.3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "16px",
                }}>🔍</div>
                <span style={{ fontSize: "15px", fontWeight: 800, color: "#e2e8f0", letterSpacing: "-0.01em" }}>
                  Deal<span style={{ color: "#7c8cf8" }}> Scout</span>
                </span>
              </div>
              <span style={{
                fontSize: "10px",
                fontWeight: 600,
                color: "#4b5563",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: "99px",
                padding: "2px 8px",
              }}>v0.26.42</span>
            </div>

            {/* API Status — active/connected */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "7px",
              margin: "12px 16px",
              padding: "8px 12px",
              borderRadius: "8px",
              fontSize: "12px",
              background: "rgba(34,197,94,0.08)",
              border: "1px solid rgba(34,197,94,0.22)",
              color: "#86efac",
            }}>
              <div style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "#22c55e",
                boxShadow: "0 0 6px #22c55e88",
                flexShrink: 0,
              }} />
              Connected · Claude: ✓ · eBay: ✓
            </div>

            {/* Section label */}
            <div style={{
              fontSize: "10px",
              fontWeight: 700,
              color: "#4b5563",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              padding: "0 16px",
              marginBottom: "8px",
            }}>Supported Platforms</div>

            {/* Platform grid */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "8px",
              padding: "0 16px",
              marginBottom: "14px",
            }}>
              {[
                { icon: "📘", name: "Facebook", badge: "Live", badgeStyle: { background: "rgba(34,197,94,0.15)", color: "#4ade80" } },
                { icon: "📋", name: "Craigslist", badge: "Live", badgeStyle: { background: "rgba(34,197,94,0.15)", color: "#4ade80" } },
                { icon: "🏷️", name: "OfferUp", badge: "Live", badgeStyle: { background: "rgba(34,197,94,0.15)", color: "#4ade80" } },
                { icon: "🛒", name: "eBay", badge: "Live", badgeStyle: { background: "rgba(34,197,94,0.15)", color: "#4ade80" } },
              ].map((p) => (
                <div key={p.name} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "9px 10px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.07)",
                  borderRadius: "10px",
                }}>
                  <span style={{ fontSize: "18px", lineHeight: 1 }}>{p.icon}</span>
                  <div>
                    <div style={{ fontSize: "11px", fontWeight: 600, color: "#cbd5e1" }}>{p.name}</div>
                    <span style={{
                      display: "inline-block",
                      marginTop: "2px",
                      fontSize: "9px",
                      fontWeight: 700,
                      padding: "1px 6px",
                      borderRadius: "99px",
                      letterSpacing: "0.03em",
                      ...p.badgeStyle,
                    }}>{p.badge}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Score button */}
            <div style={{ padding: "0 16px", marginBottom: "10px" }}>
              <button style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "7px",
                width: "100%",
                padding: "11px 16px",
                background: "linear-gradient(135deg, rgba(34,197,94,0.18), rgba(16,185,129,0.14))",
                border: "1.5px solid rgba(34,197,94,0.4)",
                borderRadius: "10px",
                color: "#4ade80",
                fontSize: "13px",
                fontWeight: 700,
                cursor: "pointer",
                letterSpacing: "0.01em",
              }}>
                <span style={{ fontSize: "15px" }}>🔍</span>
                Score Current Listing
              </button>
            </div>

            {/* Settings toggle */}
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              padding: "0 16px",
              marginBottom: "4px",
            }}>
              <span style={{ fontSize: "11px", color: "#4b5563" }}>⚙ API Settings</span>
            </div>

            {/* Footer */}
            <div style={{
              padding: "10px 16px 12px",
              borderTop: "1px solid rgba(255,255,255,0.05)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}>
              <div style={{ fontSize: "10.5px", color: "#374151", lineHeight: 1.5 }}>
                Navigate to a listing — scored automatically.<br />
                Or click <strong style={{ color: "#4b5563" }}>Score Current Listing</strong>.
              </div>
              <span style={{ fontSize: "10.5px", color: "#374151", marginLeft: "8px" }}>⚠ Report</span>
            </div>
          </div>
        </div>

        <p style={{ color: "rgba(255,255,255,0.3)", fontSize: "12px" }}>Deal Scout — Chrome Extension Popup</p>
      </div>
    </div>
  );
}
