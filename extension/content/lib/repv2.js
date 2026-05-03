// extension/content/lib/repv2.js — v0.46.0 Reputation + Negotiation v2 renderers.
//
// Shared between fbm/ebay/craigslist/offerup content scripts so the new UI
// only lives in one place. Exposes window.DealScoutV2 with these helpers:
//
//   renderRecallBanner(r, container)        — sticky red banner when r.recall_flag
//   renderReputationV2Extra(r, container)   — brand_rank + category leaders +
//                                             same-budget alternatives, suppressed
//                                             on low-confidence sources
//   renderNegotiation(r, container)         — Negotiation v2 (3 variants +
//                                             leverage + counter + walk_away).
//                                             Falls back to legacy
//                                             negotiation_message when r.negotiation
//                                             is absent so old responses still work.
//   renderBundleHardened(r, container)      — Always emit a "📦 Bundle of N items"
//                                             line whenever is_multi_item is true,
//                                             even if bundle_items=[] (placeholder).
//   renderAffiliateFlagFooter(r, panel)     — "Report a wrong recommendation"
//                                             link → POST /affiliate/flag.
//
// All output is built with createElement + textContent (or DOMPurify-sanitised
// innerHTML) so any model-emitted strings stay inert in the page DOM.

(function () {
  if (window.DealScoutV2) return;

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safe(o, path, dflt) {
    try {
      const parts = path.split('.');
      let cur = o;
      for (const p of parts) { if (cur == null) return dflt; cur = cur[p]; }
      return cur == null ? dflt : cur;
    } catch (_e) { return dflt; }
  }

  // ── Recall banner ─────────────────────────────────────────────────────
  function renderRecallBanner(r, container) {
    if (!r || !r.product_evaluation) return;
    const pe = r.product_evaluation;
    if (!pe.recall_flag) return;
    const summary = pe.recall_summary || 'This model has an active recall — verify before purchasing.';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:8px 12px 0;border:1px solid rgba(239,68,68,0.55);'
      + 'background:rgba(239,68,68,0.10);border-radius:8px;padding:8px 10px;'
      + 'display:flex;align-items:flex-start;gap:8px';
    const icon = document.createElement('div');
    icon.style.cssText = 'font-size:14px;flex-shrink:0';
    icon.textContent = '\u26A0\uFE0F';
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:11.5px;font-weight:800;color:#fca5a5';
    title.textContent = 'Recall flag — check before buying';
    const text = document.createElement('div');
    text.style.cssText = 'font-size:11.5px;color:#fecaca;margin-top:2px;line-height:1.4';
    text.textContent = summary;
    body.appendChild(title); body.appendChild(text);
    wrap.appendChild(icon); wrap.appendChild(body);
    container.appendChild(wrap);
  }

  // ── Reputation v2 extras ──────────────────────────────────────────────
  function renderReputationV2Extra(r, container) {
    const pe = r && r.product_evaluation;
    if (!pe) return;

    // Brand rank tier line — built with createElement+textContent so any
    // model-emitted summary stays inert in the DOM.
    const br = pe.brand_rank_in_category || pe.brand_rank;
    if (br && (br.tier || br.summary)) {
      const conf = (br.confidence || 'medium').toLowerCase();
      if (conf !== 'low') {
        const row = document.createElement('div');
        row.style.cssText = 'margin-top:6px;font-size:12px;color:#d1d5db';
        const tier = (br.tier || '').toUpperCase();
        const tcolor = tier === 'TOP' ? '#86efac'
                     : tier === 'STRONG' ? '#93c5fd'
                     : tier === 'MID' ? '#fde68a'
                     :                   '#fca5a5';
        const tierSpan = document.createElement('span');
        tierSpan.style.cssText = 'font-weight:700;color:' + tcolor;
        tierSpan.textContent = tier || 'rank';
        const inCat = document.createElement('span');
        inCat.style.cssText = 'color:#9ca3af';
        inCat.textContent = ' in category';
        row.appendChild(tierSpan);
        row.appendChild(inCat);
        if (br.summary) row.appendChild(document.createTextNode(' \u2014 ' + br.summary));
        container.appendChild(row);
      }
    }

    // Category leaders
    const leaders = (pe.category_leaders || []).filter(l => (l.confidence || 'medium').toLowerCase() !== 'low');
    if (leaders.length) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'margin-top:8px;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;font-weight:700';
      hdr.textContent = 'Category leaders';
      container.appendChild(hdr);
      leaders.slice(0, 3).forEach(l => {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:12px;color:#d1d5db;margin-top:3px';
        const b = document.createElement('span');
        b.style.cssText = 'font-weight:700;color:#a5b4fc';
        b.textContent = l.brand || '';
        row.appendChild(b);
        if (l.why) row.appendChild(document.createTextNode(' — ' + l.why));
        container.appendChild(row);
      });
    }

    // Same-budget alternatives
    const alts = (pe.same_budget_alternatives || []).filter(a => (a.confidence || 'medium').toLowerCase() !== 'low');
    if (alts.length) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'margin-top:8px;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;font-weight:700';
      hdr.textContent = 'Same-budget alternatives';
      container.appendChild(hdr);
      alts.slice(0, 3).forEach(a => {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:12px;color:#d1d5db;margin-top:3px';
        const b = document.createElement('span');
        b.style.cssText = 'font-weight:700;color:#a5b4fc';
        b.textContent = a.brand_model || '';
        row.appendChild(b);
        if (a.why) row.appendChild(document.createTextNode(' — ' + a.why));
        container.appendChild(row);
      });
    }

    // Low-confidence teaser when everything was suppressed
    const all = [].concat(pe.category_leaders || [], pe.same_budget_alternatives || []);
    if (all.length && !leaders.length && !alts.length) {
      const teaser = document.createElement('div');
      teaser.style.cssText = 'margin-top:6px;font-size:11px;color:#9ca3af;font-style:italic';
      teaser.textContent = 'Limited reputation data for this exact model.';
      container.appendChild(teaser);
    }
  }

  // ── Negotiation v2 ────────────────────────────────────────────────────
  async function _copy(btn, text) {
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = '\u2705 Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1800);
    } catch (_e) {
      btn.textContent = '\u274C Failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
    }
  }

  function _legacyNegotiation(r, container) {
    if (!r || !r.negotiation_message) return;
    const section = document.createElement('div');
    section.style.cssText = 'margin:4px 12px 8px';
    const toggleBtn = document.createElement('button');
    toggleBtn.style.cssText = 'width:100%;padding:7px 10px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:8px;color:#818cf8;font-size:12px;cursor:pointer;text-align:left';
    toggleBtn.textContent = '\uD83D\uDCAC Copy negotiation message';
    section.appendChild(toggleBtn);
    const msgBox = document.createElement('div');
    msgBox.style.cssText = 'display:none;margin-top:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px';
    const msgText = document.createElement('div');
    msgText.style.cssText = 'font-size:12px;color:#d1d5db;line-height:1.5;white-space:pre-wrap;margin-bottom:8px';
    msgText.textContent = r.negotiation_message;
    msgBox.appendChild(msgText);
    const copyBtn = document.createElement('button');
    copyBtn.style.cssText = 'width:100%;padding:6px;background:#6366f1;border:none;border-radius:4px;color:white;font-size:12px;cursor:pointer';
    copyBtn.textContent = 'Copy to clipboard';
    copyBtn.addEventListener('click', () => _copy(copyBtn, r.negotiation_message));
    msgBox.appendChild(copyBtn);
    section.appendChild(msgBox);
    toggleBtn.addEventListener('click', () => {
      msgBox.style.display = msgBox.style.display === 'none' ? 'block' : 'none';
    });
    container.appendChild(section);
  }

  // Cross-browser hiding of the native <details> disclosure triangle on
  // the Negotiation summary. Idempotent — only injects once per document.
  function _ensureNegStyles() {
    try {
      if (document.getElementById('ds-neg-styles')) return;
      const st = document.createElement('style');
      st.id = 'ds-neg-styles';
      st.textContent =
        '.ds-neg-summary::-webkit-details-marker{display:none}' +
        '.ds-neg-summary::marker{content:""}';
      (document.head || document.documentElement).appendChild(st);
    } catch (_) { /* style injection is best-effort */ }
  }

  function renderNegotiation(r, container) {
    const neg = r && r.negotiation;
    if (!neg || (!neg.variants && !neg.strategy)) {
      _legacyNegotiation(r, container);
      return;
    }
    const strategy = String(neg.strategy || '').toLowerCase();
    const ps = '$';

    // Task #85 (v0.46.6) — outer wrapper is a native <details> so the
    // negotiation block can collapse to a single-line summary. Default
    // collapsed except for pay_asking, where the "Strong deal — pay
    // asking" note IS the primary actionable signal and should stay
    // visible. Inner content (variants, leverage, counter, walk-away)
    // is unchanged.
    const wrap = document.createElement('details');
    wrap.style.cssText = 'margin:6px 12px 8px;background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.25);border-radius:10px;padding:10px 12px';
    wrap.open = (strategy === 'pay_asking');

    // Build a compact preview line for the closed state: polite target
    // (or pay_asking note) + walk-away ceiling. Lets the user skim the
    // headline negotiation numbers without expanding the section.
    const variantsForPreview = neg.variants || {};
    const politeTgt = (variantsForPreview.polite && typeof variantsForPreview.polite.target_offer === 'number' && variantsForPreview.polite.target_offer > 0)
      ? variantsForPreview.polite.target_offer : 0;
    const previewBits = [];
    if (strategy === 'pay_asking') {
      previewBits.push('\u2705 pay asking');
    } else if (politeTgt > 0) {
      previewBits.push('Polite ' + ps + politeTgt.toFixed(0));
    }
    if (typeof neg.walk_away === 'number' && neg.walk_away > 0) {
      previewBits.push('\uD83D\uDED1 ' + ps + Number(neg.walk_away).toFixed(0));
    }

    // Inject the marker-suppression stylesheet once per document. Inline
    // `list-style:none` on the summary covers Firefox/Gecko, but Safari/
    // WebKit needs the `::-webkit-details-marker` pseudo-element rule and
    // older Chromium versions honour `summary::marker` — both are
    // unreachable from inline `style.cssText`, so we ship them as a
    // class-scoped <style> tag.
    _ensureNegStyles();
    // Summary is shaped to match the other section headers in the panel
    // ("Category leaders", "Same-budget alternatives", "Leverage points"):
    // a single row with an uppercase 11px gray label on the left and a
    // compact metric/control on the right. The strategy badge moved into
    // the open body so the closed line stays on one row even on narrow
    // panels.
    const sum = document.createElement('summary');
    sum.className = 'ds-neg-summary';
    sum.style.cssText = 'cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;outline:none;min-height:18px';
    const sLabel = document.createElement('span');
    sLabel.style.cssText = 'font-size:11px;font-weight:700;color:#9ca3af;letter-spacing:0.5px;text-transform:uppercase;flex-shrink:0';
    sLabel.textContent = '\uD83D\uDCAC Negotiation';
    const sRight = document.createElement('span');
    sRight.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';
    if (previewBits.length) {
      const sPreview = document.createElement('span');
      sPreview.style.cssText = 'font-size:11.5px;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600';
      sPreview.textContent = previewBits.join(' \u00B7 ');
      sRight.appendChild(sPreview);
    }
    const sChev = document.createElement('span');
    sChev.style.cssText = 'color:#a5b4fc;font-size:10px;flex-shrink:0;transition:transform .15s ease';
    sChev.textContent = '\u25BE';
    wrap.addEventListener('toggle', () => {
      sChev.style.transform = wrap.open ? 'rotate(180deg)' : 'rotate(0deg)';
    });
    if (wrap.open) sChev.style.transform = 'rotate(180deg)';
    sRight.appendChild(sChev);
    sum.appendChild(sLabel); sum.appendChild(sRight);
    wrap.appendChild(sum);

    // Inner body container — separates the summary from the existing
    // content blocks so the top margin doesn't collide with <summary>.
    // First child of inner is a small strategy badge row (moved out of
    // the summary so the closed-state stays single-line).
    const inner = document.createElement('div');
    inner.style.cssText = 'margin-top:8px';
    wrap.appendChild(inner);
    if (strategy && strategy !== 'pay_asking') {
      const stratRow = document.createElement('div');
      stratRow.style.cssText = 'margin-bottom:8px';
      const sStrategy = document.createElement('span');
      sStrategy.style.cssText = 'font-size:10.5px;font-weight:700;color:#a5b4fc;background:rgba(165,180,252,0.10);border-radius:5px;padding:2px 7px;text-transform:capitalize';
      sStrategy.textContent = 'Strategy: ' + (strategy.replace(/_/g, ' '));
      stratRow.appendChild(sStrategy);
      inner.appendChild(stratRow);
    }

    // Score-8+ short-circuit / pay_asking
    if (strategy === 'pay_asking') {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:12px;color:#86efac;font-weight:600';
      const askPrice = (typeof r.price === 'number' && r.price > 0) ? (' (' + ps + r.price.toFixed(0) + ')') : '';
      note.textContent = '\u2705 Strong deal — pay asking' + askPrice + ' and act fast.';
      inner.appendChild(note);
    }

    // Variants
    const variants = neg.variants || {};
    const order = ['polite', 'direct', 'lowball'];
    const labels = { polite: 'Polite', direct: 'Direct', lowball: 'Lowball' };
    const colors = { polite: '#22c55e', direct: '#60a5fa', lowball: '#f59e0b' };
    order.forEach(k => {
      const v = variants[k];
      if (!v || !v.message) return;  // lowball intentionally null when forbidden
      const card = document.createElement('div');
      card.style.cssText = 'margin-top:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-left:3px solid ' + colors[k] + ';border-radius:8px;padding:8px 10px';
      const top = document.createElement('div');
      top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:5px';
      const lbl = document.createElement('span');
      lbl.style.cssText = 'font-size:11px;font-weight:700;color:' + colors[k];
      const tgt = (typeof v.target_offer === 'number' && v.target_offer > 0) ? (' \u00B7 ' + ps + v.target_offer.toFixed(0)) : '';
      lbl.textContent = labels[k] + tgt;
      const copyBtn = document.createElement('button');
      copyBtn.style.cssText = 'font-size:10.5px;background:rgba(99,102,241,0.18);border:1px solid rgba(99,102,241,0.4);color:#c7d2fe;border-radius:5px;padding:2px 8px;cursor:pointer';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', e => { e.stopPropagation(); _copy(copyBtn, v.message); });
      top.appendChild(lbl); top.appendChild(copyBtn);
      card.appendChild(top);
      const body = document.createElement('div');
      body.style.cssText = 'font-size:12px;color:#d1d5db;line-height:1.45;white-space:pre-wrap';
      body.textContent = v.message;
      card.appendChild(body);
      inner.appendChild(card);
    });

    // Leverage points
    const lev = (neg.leverage_points || []).filter(Boolean);
    if (lev.length) {
      const hdr2 = document.createElement('div');
      hdr2.style.cssText = 'margin-top:10px;font-size:10.5px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px';
      hdr2.textContent = 'Leverage points';
      inner.appendChild(hdr2);
      lev.slice(0, 4).forEach(pt => {
        const li = document.createElement('div');
        li.style.cssText = 'font-size:11.5px;color:#d1d5db;margin-top:3px;padding-left:10px;position:relative';
        const dot = document.createElement('span');
        dot.style.cssText = 'position:absolute;left:0;color:#a5b4fc';
        dot.textContent = '\u2022';
        li.appendChild(dot);
        li.appendChild(document.createTextNode(' ' + String(pt)));
        inner.appendChild(li);
      });
    }

    // Counter-response (collapsible — inner <details>, independent of
    // the outer Negotiation collapsible).
    const cr = neg.counter_response || {};
    if (cr.if_seller_says && cr.you_respond) {
      const det = document.createElement('details');
      det.style.cssText = 'margin-top:10px;background:rgba(255,255,255,0.03);border:1px dashed rgba(255,255,255,0.12);border-radius:8px;padding:6px 10px';
      const crSum = document.createElement('summary');
      crSum.style.cssText = 'cursor:pointer;font-size:11px;font-weight:700;color:#fde68a';
      crSum.textContent = 'If they counter\u2026';
      det.appendChild(crSum);
      const sLine = document.createElement('div');
      sLine.style.cssText = 'font-size:11.5px;color:#9ca3af;margin-top:5px;font-style:italic';
      sLine.textContent = 'Seller: ' + cr.if_seller_says;
      const yLine = document.createElement('div');
      yLine.style.cssText = 'font-size:12px;color:#d1d5db;margin-top:3px;line-height:1.4';
      yLine.textContent = 'You: ' + cr.you_respond;
      det.appendChild(sLine); det.appendChild(yLine);
      inner.appendChild(det);
    }

    // Walk-away ceiling
    if (typeof neg.walk_away === 'number' && neg.walk_away > 0) {
      const wa = document.createElement('div');
      wa.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);font-size:11.5px;color:#fca5a5;font-weight:700';
      wa.textContent = '\uD83D\uDED1 Walk-away ceiling: ' + ps + Number(neg.walk_away).toFixed(0);
      inner.appendChild(wa);
    }

    container.appendChild(wrap);
  }

  // ── Bundle hardened ───────────────────────────────────────────────────
  function renderBundleHardened(r, container) {
    if (!r) return;
    const items = (r.bundle_items || []).filter(Boolean);
    const isBundle = !!r.is_multi_item || items.length > 0;
    if (!isBundle) return;
    const ps = '$';
    const conf = (r.bundle_confidence || 'unknown').toLowerCase();
    const cColor = conf === 'high' ? '#86efac' : conf === 'medium' ? '#fde68a' : '#fca5a5';

    const section = document.createElement('div');
    section.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;margin:8px 12px';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const hL = document.createElement('span');
    hL.style.cssText = 'font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#9ca3af';
    hL.textContent = '\uD83D\uDCE6 Bundle of ' + (items.length ? items.length + ' items' : '~? items');
    const hR = document.createElement('span');
    hR.style.cssText = 'font-size:10.5px;font-weight:700;color:' + cColor + ';background:' + cColor + '22;border-radius:5px;padding:2px 7px';
    hR.textContent = conf + ' confidence';
    hdr.appendChild(hL); hdr.appendChild(hR);
    section.appendChild(hdr);

    if (!items.length) {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'font-size:11.5px;color:#9ca3af;font-style:italic';
      placeholder.textContent = 'Listing flagged as multi-item but the AI could not enumerate the contents — verify what is actually included before negotiating.';
      section.appendChild(placeholder);
      container.appendChild(section);
      return;
    }

    let total = 0;
    items.forEach(it => {
      const name = it.item || it.name || '(unspecified)';
      const val = Number(it.value || it.estimated_value || 0);
      total += val;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:12px';
      const nm = document.createElement('span');
      nm.style.cssText = 'color:#d1d5db';
      nm.textContent = name;
      const vl = document.createElement('span');
      vl.style.cssText = 'color:#7c8cf8;font-weight:600';
      vl.textContent = val ? (ps + val.toFixed(0)) : '?';
      row.appendChild(nm); row.appendChild(vl);
      section.appendChild(row);
    });

    if (total > 0) {
      const totalRow = document.createElement('div');
      totalRow.style.cssText = 'display:flex;justify-content:space-between;padding:5px 0;margin-top:4px;font-size:13px;font-weight:700';
      const tn = document.createElement('span'); tn.style.color = '#e0e0e0'; tn.textContent = 'Total separate value';
      const tv = document.createElement('span'); tv.style.cssText = 'color:#22c55e'; tv.textContent = ps + total.toFixed(0);
      totalRow.appendChild(tn); totalRow.appendChild(tv);
      section.appendChild(totalRow);
      if (r.price && total > r.price) {
        const sav = document.createElement('div');
        sav.style.cssText = 'font-size:12px;color:#22c55e;font-weight:600;margin-top:4px';
        sav.textContent = '\u2705 Bundle saves ' + ps + (total - r.price).toFixed(0) + ' vs buying separately';
        section.appendChild(sav);
      }
    }

    container.appendChild(section);
  }

  // ── Affiliate flag footer ─────────────────────────────────────────────
  function renderAffiliateFlagFooter(r, panel, opts) {
    opts = opts || {};
    const cards = (r && r.affiliate_cards) || [];
    if (!cards.length) return;
    const apiBase = opts.apiBase || (window.__DealScoutApiBase || '');
    const apiKey  = opts.apiKey  || (window.__DealScoutApiKey  || '');
    const installId = opts.installId || (window.__DealScoutInstallId || '');
    const version = opts.version || (window.__DealScoutVersion || '');

    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:4px 12px 8px;font-size:11px;color:#94a3b8;text-align:right';
    const link = document.createElement('a');
    link.href = '#';
    link.style.cssText = 'color:#94a3b8;text-decoration:underline;cursor:pointer';
    link.textContent = '\uD83D\uDEA9 Report a wrong recommendation';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const choice = window.prompt(
        'Which retailer is wrong? Type one of:\n  ' + cards.map(c => c.program_key).filter(Boolean).join(', '),
        cards[0].program_key || ''
      );
      if (!choice) return;
      const card = cards.find(c => (c.program_key || '').toLowerCase() === choice.toLowerCase());
      if (!card) { link.textContent = '\u274C Unknown retailer'; return; }
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey)     headers['X-DS-Key'] = apiKey;
        if (installId)  headers['X-DS-Install-Id'] = installId;
        if (version)    headers['X-DS-Ext-Version'] = version;
        const res = await fetch(apiBase + '/affiliate/flag', {
          method: 'POST', headers,
          body: JSON.stringify({
            listing_url: location.href,
            program_key: card.program_key || '',
            brand: safe(r, 'product_info.brand', ''),
            model: safe(r, 'product_info.model', ''),
            retailer: card.badge_label || card.program_key || '',
            url: card.url || '',
            reason: 'user_reported_wrong',
          }),
        });
        if (res.ok) {
          link.textContent = '\u2705 Thanks — flagged ' + card.program_key + ' for this listing';
          link.style.pointerEvents = 'none';
        } else {
          link.textContent = '\u274C Flag failed (' + res.status + ')';
        }
      } catch (_e) {
        link.textContent = '\u274C Flag failed (network)';
      }
    });
    wrap.appendChild(link);
    panel.appendChild(wrap);
  }

  // ── Per-card 🚩 flag affordance ───────────────────────────────────────
  // Mounts a small absolutely-positioned button on an affiliate <a> card.
  // Click → confirm → POST /affiliate/flag → fade card and disable click.
  function attachFlagButton(cardEl, card, r, opts) {
    if (!cardEl || !card) return;
    opts = opts || {};
    const apiBase = opts.apiBase || (window.__DealScoutApiBase || '');
    const apiKey  = opts.apiKey  || (window.__DealScoutApiKey  || '');
    const installId = opts.installId || (window.__DealScoutInstallId || '');
    const version = opts.version || (window.__DealScoutVersion || '');
    if (cardEl.style.position !== 'absolute' && cardEl.style.position !== 'fixed') {
      cardEl.style.position = 'relative';
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Report as wrong / spam';
    btn.textContent = '\uD83D\uDEA9';
    btn.style.cssText = 'position:absolute;top:6px;right:6px;width:22px;height:22px;'
      + 'padding:0;border:1px solid rgba(255,255,255,0.15);background:rgba(15,23,42,0.7);'
      + 'border-radius:5px;color:#cbd5e1;font-size:12px;line-height:20px;cursor:pointer;'
      + 'opacity:0.55;z-index:5';
    btn.onmouseenter = () => { btn.style.opacity = '1'; btn.style.borderColor = '#fca5a5'; };
    btn.onmouseleave = () => { btn.style.opacity = '0.55'; btn.style.borderColor = 'rgba(255,255,255,0.15)'; };
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const label = card.badge_label || card.program_key || 'this retailer';
      if (!window.confirm('Report ' + label + ' as a wrong recommendation?')) return;
      btn.textContent = '\u2026';
      btn.disabled = true;
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey)    headers['X-DS-Key'] = apiKey;
        if (installId) headers['X-DS-Install-Id'] = installId;
        if (version)   headers['X-DS-Ext-Version'] = version;
        const res = await fetch(apiBase + '/affiliate/flag', {
          method: 'POST', headers,
          body: JSON.stringify({
            listing_url: location.href,
            program_key: card.program_key || '',
            brand: safe(r, 'product_info.brand', ''),
            model: safe(r, 'product_info.model', ''),
            retailer: card.badge_label || card.program_key || '',
            url: card.url || '',
            reason: 'user_reported_wrong',
          }),
        });
        if (res.ok) {
          btn.textContent = '\u2705';
          btn.title = 'Flagged — thanks';
          cardEl.style.opacity = '0.45';
          cardEl.style.pointerEvents = 'none';
        } else {
          btn.textContent = '\u274C';
          btn.title = 'Flag failed (' + res.status + ')';
          btn.disabled = false;
        }
      } catch (_e) {
        btn.textContent = '\u274C';
        btn.title = 'Flag failed (network)';
        btn.disabled = false;
      }
    });
    cardEl.appendChild(btn);
  }

  // ── install_id bootstrap ──────────────────────────────────────────────
  // Stable per-install UUID kept in chrome.storage.local. Each content
  // script calls DealScoutV2.initInstallId() once at startup so the
  // /affiliate/flag rate limiter buckets per user (not globally).
  function initInstallId() {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(['ds_install_id'], (res) => {
        let id = res && res.ds_install_id;
        if (!id) {
          id = (crypto && crypto.randomUUID) ? crypto.randomUUID()
             : ('inst-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
          try { chrome.storage.local.set({ ds_install_id: id }); } catch (_e) {}
        }
        window.__DealScoutInstallId = id;
      });
    } catch (_e) { /* best-effort */ }
  }

  window.DealScoutV2 = {
    renderRecallBanner,
    renderReputationV2Extra,
    renderNegotiation,
    renderBundleHardened,
    renderAffiliateFlagFooter,
    attachFlagButton,
    initInstallId,
  };

  // Auto-bootstrap install_id so any later flag POST has it ready.
  initInstallId();
})();
