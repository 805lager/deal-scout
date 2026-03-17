export default function DealScoutResultsMockup() {
  const score = 8;
  const scoreColor = '#22c55e';

  return (
    <div style={{
      background: '#1a1a2e',
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      padding: '32px 24px',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    }}>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start', maxWidth: '900px', width: '100%' }}>

        {/* Left: simulated FBM listing page */}
        <div style={{
          flex: 1,
          background: '#fff',
          borderRadius: '12px',
          overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          minWidth: 0,
        }}>
          {/* FB nav bar */}
          <div style={{ background: '#1877f2', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ color: '#fff', fontWeight: 800, fontSize: '20px' }}>f</span>
            <div style={{ flex: 1, background: 'rgba(255,255,255,0.2)', borderRadius: '20px', padding: '6px 14px', fontSize: '13px', color: 'rgba(255,255,255,0.7)' }}>🔍 Search Marketplace</div>
          </div>
          {/* Listing content */}
          <div style={{ padding: '16px' }}>
            {/* Product image placeholder */}
            <div style={{
              background: '#f3f4f6',
              borderRadius: '10px',
              height: '220px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '14px',
              fontSize: '64px',
            }}>🔊</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#111', marginBottom: '4px' }}>Pioneer SP-BS21-LR Bookshelf Speakers</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: '#111', marginBottom: '8px' }}>$120</div>
            <div style={{ fontSize: '13px', color: '#606770', marginBottom: '12px' }}>📍 Austin, TX · Listed 2 days ago</div>
            <div style={{ fontSize: '13px', color: '#444', lineHeight: 1.6 }}>
              Pair of Pioneer bookshelf speakers in great condition. Barely used, kept in living room. No damage, all original parts. Pickup only.
            </div>
            {/* Seller row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px', padding: '12px', background: '#f9fafb', borderRadius: '8px' }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#ddd', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>👤</div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#111' }}>Marcus T.</div>
                <div style={{ fontSize: '11px', color: '#888' }}>⭐ 4.8 · 42 ratings · Highly rated</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Deal Scout floating panel */}
        <div style={{
          width: '290px',
          flexShrink: 0,
          background: '#13111f',
          border: '1px solid #3d3660',
          borderRadius: '10px',
          overflow: 'hidden',
          boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
          fontSize: '13px',
          color: '#e2e8f0',
        }}>
          {/* Top bar */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '7px 10px',
            background: '#13111f',
            borderBottom: '1px solid #3d3660',
          }}>
            <span style={{ fontWeight: 700, fontSize: '13px', color: '#7c8cf8', display: 'flex', alignItems: 'center', gap: '5px' }}>
              📊 Deal Scout <span style={{ fontSize: '10px', color: '#6b7280', fontWeight: 400 }}>v0.26.42</span>
            </span>
            <span style={{ color: '#6b7280', fontSize: '15px', cursor: 'pointer' }}>✕</span>
          </div>

          {/* Body */}
          <div style={{ padding: '12px 12px 10px' }}>

            {/* Score + verdict */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '11px', marginBottom: '10px' }}>
              <div style={{
                minWidth: 52, height: 52, borderRadius: '50%',
                border: `3px solid ${scoreColor}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '22px', fontWeight: 800, color: scoreColor, flexShrink: 0,
              }}>{score}</div>
              <div style={{ flex: 1, paddingTop: '1px' }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                  background: `${scoreColor}22`, border: `1px solid ${scoreColor}66`,
                  borderRadius: '5px', padding: '2px 8px',
                  fontSize: '11px', fontWeight: 700, color: scoreColor, marginBottom: '4px',
                }}>✅ GREAT DEAL</div>
                <div style={{ fontSize: '12px', color: '#c9c9d9', lineHeight: 1.4 }}>
                  Pioneer SP-BS21-LR at $120 is 18% below eBay sold average of $146.
                </div>
                <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '3px' }}>high confidence · sonnet-4-5</div>
              </div>
            </div>

            {/* Price row */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              background: 'rgba(255,255,255,0.05)', borderRadius: '8px', padding: '8px 10px', marginBottom: '8px',
            }}>
              <div>
                <span style={{ color: '#9ca3af', fontSize: '12px' }}>Asking price </span>
                <span style={{ fontWeight: 700, fontSize: '16px' }}>$120</span>
              </div>
              <div>
                <span style={{ color: '#9ca3af', fontSize: '12px' }}>Rec. offer </span>
                <span style={{ fontWeight: 600, color: '#7c8cf8' }}>$105</span>
              </div>
            </div>

            {/* Meta badges */}
            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginBottom: '4px' }}>
              {['Used — Good', '📍 Austin, TX'].map(b => (
                <span key={b} style={{ fontSize: '11px', padding: '2px 7px', background: 'rgba(255,255,255,0.07)', color: '#9ca3af', borderRadius: '4px' }}>{b}</span>
              ))}
            </div>

            {/* AI summary */}
            <div style={{ fontSize: '12px', color: '#c9c9d9', lineHeight: 1.6, padding: '6px 0 4px' }}>
              These speakers sell consistently on eBay. Seller has strong ratings and the condition matches the asking price. No red flags.
            </div>
          </div>

          {/* Market comparison */}
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '10px', padding: '10px 12px', margin: '0 12px 8px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontWeight: 600, fontSize: '11px', letterSpacing: '0.5px', textTransform: 'uppercase', color: '#9ca3af' }}>📈 Market Comparison</span>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#22c55e', background: 'rgba(34,197,94,0.15)', borderRadius: '6px', padding: '2px 7px' }}>📊 Live eBay</span>
            </div>
            {[
              { label: 'eBay sold avg', value: '$146', bold: true },
              { label: 'Active listings avg', value: '$158' },
              { label: 'New retail', value: '$199' },
              { label: 'Sold range', value: '$110 – $180' },
              { label: 'Listed price', value: '$120' },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <span style={{ color: '#9ca3af', fontSize: '12px' }}>{row.label}</span>
                <span style={{ fontWeight: row.bold ? 700 : 500, fontSize: row.bold ? '14px' : '13px' }}>{row.value}</span>
              </div>
            ))}
            <div style={{ marginTop: '6px', fontSize: '12px', fontWeight: 600, color: '#22c55e' }}>
              ● $26 below market (−18%)
            </div>
          </div>

          {/* Green / red flags */}
          <div style={{ padding: '4px 12px 4px' }}>
            {[
              { text: 'Price 18% below eBay sold average', green: true },
              { text: 'Highly-rated seller · 4.8 stars · 42 reviews', green: true },
              { text: 'Pioneer SP-BS21-LR is a well-reviewed budget audiophile pick', green: true },
              { text: 'Condition listed as "Used — Good" — inspect before buying', green: false },
            ].map((f, i) => (
              <div key={i} style={{ fontSize: '12px', color: f.green ? '#86efac' : '#fde68a', marginBottom: '5px' }}>
                {f.green ? '✅' : '⚠'} {f.text}
              </div>
            ))}
          </div>

          {/* Buy new section */}
          <div style={{ padding: '4px 12px 8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>🛒 Buy New Instead</div>
            {[
              { store: 'Pioneer SP-BS21-LR at Amazon', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', price: '$199' },
              { store: 'Pioneer SP-BS21-LR on eBay', color: '#e53e3e', bg: 'rgba(229,62,62,0.1)', price: '$146 used' },
            ].map(card => (
              <div key={card.store} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '7px 10px', background: card.bg,
                border: `1px solid ${card.color}33`, borderRadius: '7px', marginBottom: '5px',
              }}>
                <span style={{ fontSize: '12px', color: card.color, fontWeight: 600 }}>{card.store}</span>
                <span style={{ fontSize: '11px', color: '#9ca3af' }}>{card.price}</span>
              </div>
            ))}
          </div>

          {/* Security score */}
          <div style={{
            background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.15)',
            borderRadius: '8px', margin: '0 12px 8px', padding: '8px 10px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '3px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>🛡 Security Score</span>
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#22c55e' }}>9/10 · Low Risk</span>
            </div>
            <div style={{ fontSize: '11px', color: '#86efac' }}>Established seller, clear photos, reasonable price — no scam signals.</div>
          </div>

          {/* Negotiation message */}
          <div style={{
            background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.2)',
            borderRadius: '8px', margin: '0 12px 10px', padding: '8px 10px',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#4ade80', marginBottom: '5px' }}>💬 Negotiation Message</div>
            <div style={{ fontSize: '12px', color: '#c9c9d9', lineHeight: 1.5, marginBottom: '7px' }}>
              "Hey! Love the speakers. I've been checking eBay and similar Pioneers sell for around $105–120 used. Would you take $105?"
            </div>
            <button style={{
              padding: '5px 12px', background: 'rgba(34,197,94,0.15)',
              border: '1px solid rgba(34,197,94,0.35)', borderRadius: '5px',
              color: '#4ade80', fontSize: '11px', fontWeight: 600, cursor: 'pointer',
            }}>📋 Copy</button>
          </div>

          {/* Footer */}
          <div style={{
            padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.05)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: '10.5px', color: '#374151' }}>Scored in 4.2s</span>
            <span style={{ fontSize: '10.5px', color: '#374151' }}>⚠ Report</span>
          </div>
        </div>
      </div>
    </div>
  );
}
