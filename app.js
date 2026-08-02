// ================================================================================
// DEL Ops Control Center — v2 — Airport Operations Control Center
// Grand Finale · Frontend Wars 2026
// Vanilla JS · no framework · no build step
// ================================================================================

(function () {
  'use strict';

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const P = (s) => {
    if (!s) return null;
    const [d, t] = s.split(' ');
    if (!t) return new Date(s);
    const [yr, mo, da] = d.split('-');
    const [hr, mi, se] = t.split(':');
    return new Date(yr, mo - 1, da, hr, mi, se);
  };

  function isRecordActive(t, start, end) {
    if (!start || !end) return false;
    const realStart = start > end ? end : start;
    const realEnd = start > end ? start : end;
    return t >= realStart && t <= realEnd;
  }

  // ─── Parse all tables ─────────────────────────────────────────────────────
  const flights     = RAW.flights.map(f     => ({ ...f, _schedDep: P(f.sched_dep),        _actDep: P(f.actual_dep),    _schedArr: P(f.sched_arr),      _actArr: P(f.actual_arr) }));
  const passengers  = RAW.passengers.map(p  => ({ ...p, _checkin:  P(p.checkin_time),      _boarding: P(p.boarding_time) }));
  const baggage     = RAW.baggage.map(b     => ({ ...b, _checkin:  P(b.checkin_time),      _loaded:   P(b.loaded_time) }));
  const security    = RAW.security.map(s    => ({ ...s, _enter:    P(s.queue_enter_time),  _screen:   P(s.screening_time), _clear: P(s.clear_time) }));
  const staff       = RAW.staff.map(s       => ({ ...s, _start:    P(s.shift_start),        _end:      P(s.shift_end) }));
  const retail      = RAW.retail.map(r      => ({ ...r, _txn:      P(r.txn_time) }));
  const maintenance = RAW.maintenance.map(m => ({ ...m, _start:    P(m.start_time),         _end:      P(m.end_time) }));
  const gateEvents  = RAW.gateEvents.map(g  => ({ ...g, _t:        P(g.event_time) }));

  console.log('--- DEBUG: TIMESTAMPS ---');
  console.log('Current simTime value:', new Date(2024, 9, 22, 6, 0, 0));
  console.log('simTime format/type:', typeof new Date(), (new Date(2024, 9, 22) instanceof Date ? 'Date object' : ''));
  console.log('Raw Staff [0]:', RAW.staff[0].shift_start, '->', RAW.staff[0].shift_end);
  console.log('Raw Staff [1]:', RAW.staff[1].shift_start, '->', RAW.staff[1].shift_end);
  console.log('Raw Gate [0]:', RAW.gateEvents[0].event_time);
  console.log('---------------------------');

  // ─── Indexes ──────────────────────────────────────────────────────────────
  const byId = (arr, key) => { const m = new Map(); for (const r of arr) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const flightById      = new Map(flights.map(f => [f.flight_id, f]));
  const passByFlight    = byId(passengers, 'flight_id');
  const bagByFlight     = byId(baggage,    'flight_id');
  const bagByPnr        = byId(baggage,    'pnr');
  const secByPnr        = byId(security,   'pnr');
  const maintByTail     = byId(maintenance,'tail_number');
  const gateEvByFlight  = byId(gateEvents, 'flight_id');
  const passByPnr       = new Map(passengers.map(p => [p.pnr, p]));

  // ─── Dataset bounds ───────────────────────────────────────────────────────
  const allTimes = flights.flatMap(f => [f._schedDep, f._actArr]).filter(Boolean).map(d => d.getTime());
  const MIN_T = Math.min(...allTimes), MAX_T = Math.max(...allTimes);
  const BOARD_LEAD = 35, GATE_BUF = 20;

  // ─── Gates ────────────────────────────────────────────────────────────────
  const GATES = [...new Set(flights.map(f => f.gate))].filter(Boolean).sort((a, b) => {
    return (parseInt(a.replace(/\D/g,'')) || 0) - (parseInt(b.replace(/\D/g,'')) || 0);
  });

  // ─── State ────────────────────────────────────────────────────────────────
  const state = {
    simTime:     new Date(MIN_T),
    playing:     false,
    speed:       60,
    tab:         'overview',
    flightSort:  { key: '_schedDep', dir: 1 },
    flightFilter:{ q: '', status: '', terminal: '' },
    drawerTrigger: null,
    useRealTime: false,
    crossFilter: null,   // { type: 'flight'|'gate', id: string }
    prevAlertIds: new Set(),
  };

  // ─── Pre-compute KPI sparkline history (Oct 22 at hourly buckets) ─────────
  const KPI_HISTORY = (() => {
    const hours = Array.from({ length: 24 }, (_, h) => new Date(2024, 9, 22, h, 0, 0));
    return {
      active:  hours.map(t => flightsNear(t, 1, 1).filter(f => { const s = flightStatusAt(f, t).code; return s === 'boarding' || s === 'airborne'; }).length),
      delayed: hours.map(t => flightsNear(t, 1, 1).filter(f => f.delay_min >= 30).length),
      secWait: hours.map(t => { const w = security.filter(s => s._enter && Math.abs(s._enter - t) < 30*60000); return w.length ? w.reduce((a,s) => a+(s.duration_sec||0), 0)/w.length/60 : 0; }),
      alerts:  hours.map(t => computeAlerts(t).length),
    };
  })();

  // ─── Auto-detect crisis moment ────────────────────────────────────────────
  const CRISIS_TIME = (() => {
    const day = new Date(2024, 9, 22);
    let worst = null, worstScore = -1;
    for (let h = 5.5; h <= 22; h += 0.5) {
      const t = new Date(day.getTime() + h * 3600000);
      const score = computeAlerts(t).reduce((a, x) => a + sevRank(x.sev), 0);
      if (score > worstScore) { worstScore = score; worst = t; }
    }
    return worst || new Date(2024, 9, 22, 9, 0, 0);
  })();


  // ════════════════════════════════════════════════════════════════════════
  // DOMAIN HELPERS
  // ════════════════════════════════════════════════════════════════════════

  function flightStatusAt(f, t) {
    const dep = f._actDep || f._schedDep, arr = f._actArr || f._schedArr;
    if (!dep || !arr) return { code: 'scheduled', label: 'Scheduled' };
    const boardStart = new Date(dep.getTime() - BOARD_LEAD * 60000);
    if (t < boardStart) return { code: 'scheduled', label: 'Scheduled' };
    if (t < dep)        return { code: 'boarding',  label: f.delay_min > 15 ? 'Boarding · Delayed' : 'Boarding' };
    if (t < arr)        return { code: 'airborne',  label: 'In Progress' };
    return { code: 'arrived', label: 'Completed' };
  }

  function severityOf(f) {
    if (f.delay_min >= 90) return 'critical';
    if (f.delay_min >= 45) return 'alert';
    if (f.delay_min >= 15) return 'watch';
    return 'nominal';
  }

  function gateWindow(f) {
    const dep = f._actDep || f._schedDep;
    return [new Date(dep.getTime() - GATE_BUF * 60000), new Date(dep.getTime() + GATE_BUF * 60000)];
  }

  function flightsNear(t, hoursBack = 6, hoursFwd = 10) {
    const lo = t.getTime() - hoursBack * 3600000, hi = t.getTime() + hoursFwd * 3600000;
    return flights.filter(f => { const dep = f._actDep || f._schedDep; return dep && dep.getTime() >= lo && dep.getTime() <= hi; });
  }

  // Predictive delay risk (§7.2) — weighted score, no ML
  function predictDelayRisk(f) {
    let score = 0;
    if (f.delay_min >= 30) score += 40;
    else if (f.delay_min >= 15) score += 20;
    const maintIssues = (maintByTail.get(f.tail_number) || []).filter(m => m._end && m._end > state.simTime).length;
    score += maintIssues * 20;
    const dep = f._actDep || f._schedDep;
    if (dep) {
      const h = dep.getHours();
      if ((h >= 7 && h <= 9) || (h >= 17 && h <= 19)) score += 10; // rush hours
    }
    const pax = (passByFlight.get(f.flight_id) || []).length;
    if (f.pax_count && pax < f.pax_count * 0.5) score += 15; // low check-in suggests issues
    if (score >= 60) return 'high';
    if (score >= 30) return 'medium';
    return 'low';
  }


  // ════════════════════════════════════════════════════════════════════════
  // ALERT ENGINE
  // ════════════════════════════════════════════════════════════════════════

  function computeAlerts(t) {
    const alerts = [], near = flightsNear(t, 4, 8);

    // 1 — Severe delays
    for (const f of near) {
      if (f.delay_min >= 60 && flightStatusAt(f, t).code !== 'arrived') {
        alerts.push({ id: `delay-${f.flight_id}`, sev: f.delay_min >= 90 ? 'critical' : 'alert', title: `${f.flight_id} delayed ${f.delay_min}m`, meta: `${f.origin}→${f.destination} · Gate ${f.gate} · ${f.delay_reason}`, type: 'flight', ref: f.flight_id });
      }
    }

    // 2 — Gate conflicts
    const byGate = new Map();
    for (const g of GATES) byGate.set(g, []);
    for (const f of near) { if (byGate.has(f.gate)) byGate.get(f.gate).push(f); }
    const seenConflicts = new Set();
    for (const [gate, list] of byGate) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) for (let j = i+1; j < list.length; j++) {
        const [as, ae] = gateWindow(list[i]), [bs, be] = gateWindow(list[j]);
        if (as < be && bs < ae) {
          const key = `${gate}-${list[i].flight_id}-${list[j].flight_id}`;
          if (!seenConflicts.has(key)) {
            seenConflicts.add(key);
            alerts.push({ id: `conflict-${key}`, sev: 'critical', title: `Gate ${gate} conflict`, meta: `${list[i].flight_id} × ${list[j].flight_id} overlapping turnaround`, type: 'gate', ref: gate });
          }
        }
      }
    }

    // 3 — Maintenance → flight cross-check (§7.1) — THE signature join
    for (const f of near) {
      const wos = (maintByTail.get(f.tail_number) || []).filter(wo => wo._start && wo._end && wo._end > t && wo._end > (f._schedDep || t));
      if (wos.length) {
        for (const wo of wos.slice(0, 1)) {
          alerts.push({ id: `maint-${f.flight_id}-${wo.work_order_id}`, sev: 'alert', title: `${f.tail_number} WO open — ${f.flight_id} at risk`, meta: `${wo.defect_type} · WO ${wo.work_order_id} · est. clear ${fmtTime(wo._end)}`, type: 'flight', ref: f.flight_id });
        }
      }
    }

    // 4 — Security surge
    const secWin = security.filter(s => s._enter && Math.abs(s._enter - t) < 45*60000);
    if (secWin.length >= 4) {
      const avgQ = secWin.reduce((a, s) => a + (s.queue_position || 0), 0) / secWin.length;
      if (avgQ >= 5) alerts.push({ id: `sec-surge-${Math.round(t.getTime()/3600000)}`, sev: avgQ >= 6.5 ? 'critical' : 'alert', title: `Security queue surge`, meta: `Avg. pos. ${avgQ.toFixed(1)} across ${secWin.length} passengers`, type: 'security', ref: null });
    }

    return alerts;
  }

  function sevRank(s) { return { critical: 4, alert: 3, watch: 2, info: 1, nominal: 0 }[s] || 0; }


  // ════════════════════════════════════════════════════════════════════════
  // FORMATTING
  // ════════════════════════════════════════════════════════════════════════

  const fmtTime     = d => d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
  const fmtDate     = d => d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const fmtDateTime = d => d ? `${fmtDate(d)} · ${fmtTime(d)}` : '—';
  const minsBetween = (a, b) => a && b ? Math.round((b-a)/60000) : null;
  const esc = s => (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  // Severity icon + color pill (§5.1 — icon companion, never colour alone)
  const SEV_ICON = { critical: '✕', alert: '⚠', watch: '◉', info: 'ℹ', nominal: '✓', neutral: '—' };
  function pillFor(sev, label) {
    return `<span class="pill ${sev}" role="status" aria-label="${sev}: ${label}"><span class="pi" aria-hidden="true">${SEV_ICON[sev]||'·'}</span>${label}</span>`;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MICRO-CHARTS (§2.2)
  // ──────────────────────────────────────────────────────────────────────────

  function sparklineSVG(data, color = '#c8a25a', w = 68, h = 22) {
    const max = Math.max(...data, 1), min = 0;
    const pts = data.map((v, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * w;
      const y = h - ((v - min) / (max - min || 1)) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    // Always draw the dot at the end
    const lastIdx = data.length - 1;
    const endX = w;
    const endY = h - ((data[lastIdx] - min) / (max - min || 1)) * (h - 2) - 1;
    const dot = `<circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="2.5" fill="${color}" opacity="0.9"/>`;
    return `<svg class="kpi-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.7"/>
      ${dot}
    </svg>`;
  }

  // Trend arrow (§1.3)
  function trendArrow(history) {
    if (history.length < 2) return `<span class="kpi-trend flat">–</span>`;
    const diff = history[history.length - 1] - history[history.length - 2];
    if (diff > 0.5)  return `<span class="kpi-trend up"   aria-label="increasing">▲${Math.round(diff)}</span>`;
    if (diff < -0.5) return `<span class="kpi-trend down" aria-label="decreasing">▼${Math.abs(Math.round(diff))}</span>`;
    return `<span class="kpi-trend flat" aria-label="stable">–</span>`;
  }


  // ════════════════════════════════════════════════════════════════════════
  // OPS SUMMARY NARRATIVE  (§10.1)
  // ════════════════════════════════════════════════════════════════════════

  function computeOpsSummary(t) {
    const alerts   = computeAlerts(t).sort((a,b) => sevRank(b.sev) - sevRank(a.sev));
    const critical = alerts.filter(a => a.sev === 'critical');
    const near     = flightsNear(t, 3, 5);
    const del90    = near.filter(f => f.delay_min >= 90);
    const maintOpen = [...new Set(near.filter(f => (maintByTail.get(f.tail_number)||[]).some(wo => wo._end && wo._end > t)).map(f => f.tail_number))];
    const secWin   = security.filter(s => s._enter && Math.abs(s._enter - t) < 45*60000);
    const avgQ     = secWin.length ? secWin.reduce((a,s) => a+(s.queue_position||0), 0)/secWin.length : 0;

    if (alerts.length === 0 && del90.length === 0) {
      return { cls: 'ops-nominal', icon: '✓', label: 'All Systems Nominal', text: `No active incidents. ${near.length} flights in the ±window, security wait nominal, no maintenance conflicts.` };
    }

    const parts = [];
    if (critical.length) parts.push(`${critical.length} critical alert${critical.length > 1 ? 's' : ''}`);
    if (del90.length)    parts.push(`${del90.length} flight${del90.length > 1 ? 's' : ''} delayed 90m+`);
    if (maintOpen.length) parts.push(`${maintOpen.length} tail number${maintOpen.length > 1 ? 's' : ''} (${maintOpen.slice(0,2).join(', ')}) with open maintenance WOs`);
    if (avgQ >= 5)       parts.push(`security queue surging (avg. pos. ${avgQ.toFixed(1)})`);
    const gateConflicts = alerts.filter(a => a.type === 'gate');
    if (gateConflicts.length) parts.push(`gate conflict at ${gateConflicts.map(a => a.ref).join(', ')}`);

    const cls = critical.length ? 'ops-critical' : 'ops-alert';
    return { cls, icon: critical.length ? '⚠' : '◉', label: `${alerts.length} Active Alert${alerts.length > 1 ? 's' : ''}`, text: parts.join(' · ') + '.' };
  }


  // ════════════════════════════════════════════════════════════════════════
  // TOAST SYSTEM  (§9.2)
  // ════════════════════════════════════════════════════════════════════════

  function showToast(title, sub, sev = 'alert', duration = 5000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const t = document.createElement('div');
    t.className = `toast t-${sev}`;
    t.innerHTML = `<span class="t-icon" aria-hidden="true">${SEV_ICON[sev] || '◉'}</span><div class="t-body"><div class="t-title">${esc(title)}</div>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}</div>`;
    container.appendChild(t);
    requestAnimationFrame(() => { requestAnimationFrame(() => { t.classList.add('show'); }); });
    setTimeout(() => { t.classList.replace('show', 'hide'); setTimeout(() => t.remove(), 350); }, duration);
  }

  function checkForNewAlerts() {
    const alerts   = computeAlerts(state.simTime);
    const newCrit  = alerts.filter(a => a.sev === 'critical' && !state.prevAlertIds.has(a.id));
    for (const a of newCrit.slice(0, 2)) showToast(a.title, a.meta, 'critical');
    state.prevAlertIds = new Set(alerts.map(a => a.id));
  }


  // ════════════════════════════════════════════════════════════════════════
  // CHROME: CLOCK + KPIs + GATES + ALERTS
  // ════════════════════════════════════════════════════════════════════════

  function renderClock() {
    const dt = state.useRealTime ? new Date() : state.simTime;
    document.getElementById('clockDate').textContent = dt.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
    document.getElementById('clockTime').textContent = dt.toLocaleTimeString('en-GB');
    document.getElementById('liveDot').classList.toggle('paused', !state.playing && !state.useRealTime);

    if (!state.useRealTime) {
      const pct = (state.simTime.getTime() - MIN_T) / (MAX_T - MIN_T) * 1000;
      const range = document.getElementById('scrubRange');
      if (document.activeElement !== range) range.value = Math.max(0, Math.min(1000, pct));
    }
  }

  let _prevKpiVals = {};
  function renderKPIs() {
    const t        = state.simTime;
    const near     = flightsNear(t, 6, 10);
    const active   = near.filter(f => { const s = flightStatusAt(f, t).code; return s === 'boarding' || s === 'airborne'; });
    const delayed  = near.filter(f => f.delay_min >= 30);
    const secWin   = security.filter(s => s._enter && Math.abs(s._enter - t) < 45*60000);
    const avgWait  = secWin.length ? secWin.reduce((a, s) => a + (s.duration_sec||0), 0)/secWin.length/60 : 0;
    const alerts   = computeAlerts(t);
    const critCount= alerts.filter(a => a.sev === 'critical').length;
    const retailW  = retail.filter(r => r._txn && Math.abs(r._txn - t) < 6*3600000);
    const revenue  = retailW.reduce((a, r) => a + (r.amount||0), 0);

    // Maintain a rolling history buffer for live sparklines (every 5 sim-minutes)
    if (!state.sparkHistory) {
      state.sparkHistory = { lastT: 0, active: Array(30).fill(active.length), delayed: Array(30).fill(delayed.length), secWait: Array(30).fill(avgWait), alerts: Array(30).fill(alerts.length) };
    }
    if (t.getTime() - state.sparkHistory.lastT > 5 * 60000 || t.getTime() < state.sparkHistory.lastT) {
      state.sparkHistory.active.shift(); state.sparkHistory.active.push(active.length);
      state.sparkHistory.delayed.shift(); state.sparkHistory.delayed.push(delayed.length);
      state.sparkHistory.secWait.shift(); state.sparkHistory.secWait.push(avgWait);
      state.sparkHistory.alerts.shift(); state.sparkHistory.alerts.push(alerts.length);
      state.sparkHistory.lastT = t.getTime();
    }

    const kpis = [
      { id:'kpiA', label:'Active Flights',   val: active.length,  sparkData: state.sparkHistory.active,  color:'#7aa55e', sub:`of ${near.length} in window`,              sev: active.length > 5 ? 'sev-nominal' : '' },
      { id:'kpiD', label:'Delayed ≥30m',     val: delayed.length, sparkData: state.sparkHistory.delayed, color:'#d87a3d', sub:`${near.length?Math.round(delayed.length/near.length*100):0}% of window`, sev: delayed.length >= 5 ? 'sev-critical' : delayed.length >= 2 ? 'sev-alert' : 'sev-nominal' },
      { id:'kpiS', label:'Security Wait',    val: avgWait ? avgWait.toFixed(0)+'m':'—', sparkData: state.sparkHistory.secWait, color:'#5a8fa8', sub:`${secWin.length} screened nearby`, sev: avgWait > 25 ? 'sev-alert' : 'sev-nominal' },
      { id:'kpiG', label:'Gates Occupied',   val: gatesState(t).filter(g=>g.state!=='idle').length+'/'+GATES.length, sparkData: state.sparkHistory.active, color:'#c8a25a', sub:'Terminal 3', sev:'' },
      { id:'kpiR', label:'Retail ±6h',       val: '₹'+Math.round(revenue).toLocaleString('en-IN'), sparkData: null, color:'#c8a25a', sub:`${retailW.length} transactions`, sev:'sev-watch' },
      { id:'kpiAl',label:'Open Alerts',      val: alerts.length,  sparkData: state.sparkHistory.alerts,  color: critCount ? '#cf5040' : '#d87a3d', sub:`${critCount} critical`, sev: critCount ? 'sev-critical' : alerts.length ? 'sev-alert' : 'sev-nominal', clickable: true },
    ];

    const strip = document.getElementById('kpiStrip');

    if (near.length === 0) {
      strip.innerHTML = `<div class="kpi sev-nominal" style="width:100%; justify-content:center; align-items:center; flex-direction:row; gap:16px;">
        <span class="kpi-icon" style="font-size:24px; color:var(--ink-muted)">∅</span>
        <span class="kpi-label" style="font-size:16px; color:var(--ink-subtle)">No active flights in this operational window</span>
      </div>`;
      return;
    }

    strip.innerHTML = kpis.map(k => {
      const vStr = String(k.val);
      const prev = _prevKpiVals[k.id];
      const changed = prev !== undefined && prev !== vStr;
      _prevKpiVals[k.id] = vStr;
      const colClass = k.sev.includes('critical') ? 'c-critical' : k.sev.includes('alert') ? 'c-alert' : k.sev.includes('watch') ? 'c-watch' : 'c-nominal';
      const sparkH = k.sparkData ? sparklineSVG(k.sparkData, k.color, 68, 22) : '';
      const trend  = k.sparkData ? trendArrow(k.sparkData) : '';
      return `
        <div class="kpi ${k.sev}${k.clickable?' clickable':''}" id="${k.id}"
          ${k.clickable ? 'role="button" tabindex="0" aria-label="Open Alerts — jump to incident feed"' : ''}>
          <span class="kpi-label">${k.label}</span>
          <span class="kpi-value mono ${colClass}${changed&&!reducedMotion()?' kpi-count-up':''}">${vStr}</span>
          <span class="kpi-sub">${k.sub}</span>
          <div class="kpi-foot">${trend}${sparkH}</div>
        </div>`;
    }).join('');

    // Open Alerts deep-link
    const kpiAl = document.getElementById('kpiAl');
    if (kpiAl) {
      const jump = () => {
        const feed = document.getElementById('alertFeed');
        if (feed) { feed.scrollIntoView({ behavior: reducedMotion()?'auto':'smooth', block: 'nearest' }); const p = feed.closest('.panel'); if (p) { p.classList.add('alert-feed-flash'); setTimeout(() => p.classList.remove('alert-feed-flash'), 1000); } }
      };
      kpiAl.addEventListener('click', jump);
      kpiAl.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); jump(); } });
    }
  }

  function gatesState(t) {
    const near = flightsNear(t, 3, 3);
    const byG  = new Map(GATES.map(g => [g, []]));
    for (const f of near) if (byG.has(f.gate)) byG.get(f.gate).push(f);
    return GATES.map(g => {
      const list = byG.get(g); let conflict = false;
      for (let i=0;i<list.length;i++) for (let j=i+1;j<list.length;j++) { const [as,ae]=gateWindow(list[i]),[bs,be]=gateWindow(list[j]); if(as<be&&bs<ae) conflict=true; }
      let st = 'idle';
      const occ = list.find(f => { const [s,e]=gateWindow(f); return isRecordActive(t, s, e); });
      if (conflict) st = 'conflict';
      else if (occ) { const c = flightStatusAt(occ, t).code; st = c==='boarding'?'boarding':'occupied'; }
      return { gate: g, state: st, flight: occ };
    });
  }

  function renderGates() {
    const states = gatesState(state.simTime);
    const activeCount = states.filter(g => g.state !== 'idle').length;
    const grid = document.getElementById('gateGrid');
    
    if (activeCount === 0) {
      grid.innerHTML = `<div class="alert-empty" style="grid-column: 1 / -1; padding: 40px; text-align: center; border: 1px dashed var(--border);">
        <div style="font-size: 24px; color: var(--ink-faint); margin-bottom: 8px;">⊘</div>
        Terminal gates are fully unoccupied at this time.
      </div>`;
      return;
    }

    grid.innerHTML = states.map(g => {
      const label = g.gate.replace(/[A-Z]/g, '');
      const tip   = g.flight ? `${g.gate} · ${g.flight.flight_id} · ${g.flight.origin}→${g.flight.destination} · ${g.state}` : `${g.gate} · idle`;
      const onclick = g.flight ? `openFlightDrawer('${g.flight.flight_id}')` : `showToast('Gate ${g.gate} is currently unoccupied.')`;
      return `<div class="gate-cell interactive" data-state="${g.state}" data-tip="${esc(tip)}" tabindex="0" role="button" aria-label="Gate ${esc(g.gate)}, ${g.state}${g.flight?' — '+esc(g.flight.flight_id):''}" onclick="${onclick}">${label}</div>`;
    }).join('');
  }

  function renderAlerts() {
    const alerts = computeAlerts(state.simTime).sort((a,b) => sevRank(b.sev)-sevRank(a.sev));
    document.getElementById('alertCount').textContent = `${alerts.length} open`;
    const feed = document.getElementById('alertFeed');
    if (!alerts.length) { 
      feed.innerHTML = `<div class="alert-empty" aria-live="polite" style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding: 40px 20px; border: 1px dashed var(--border); border-radius: 6px; margin-top: 8px; color: var(--ink-subtle);">
        <span style="font-size: 24px; margin-bottom: 12px; opacity: 0.5;">✓</span>
        <span>No active incidents at this time.</span>
      </div>`; 
      return; 
    }
    feed.innerHTML = alerts.slice(0, 14).map(a => `
      <div class="alert-item" data-type="${a.type}" data-ref="${esc(a.ref||'')}"
        tabindex="${a.type==='flight'?'0':'-1'}"
        role="${a.type==='flight'?'button':'listitem'}"
        aria-label="${esc(a.title+' — '+a.meta)}">
        <span class="alert-dot ${a.sev}" aria-hidden="true"></span>
        <div class="alert-body">
          <div class="title">${esc(a.title)}</div>
          <div class="meta">${esc(a.meta)}</div>
        </div>
      </div>`).join('');
    feed.querySelectorAll('.alert-item').forEach(el => {
      const open = () => { if (el.dataset.type==='flight') openFlightDrawer(el.dataset.ref); };
      el.addEventListener('click', open);
      el.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); open(); } });
    });
  }

  function renderChrome() { renderClock(); renderKPIs(); renderGates(); renderAlerts(); }


  // ════════════════════════════════════════════════════════════════════════
  // TABS
  // ════════════════════════════════════════════════════════════════════════

  const TAB_RENDER = { overview: renderOverview, map: renderMap, flights: renderFlights, trace: renderTrace, security: renderSecurity, staff: renderStaff, retail: renderRetail, maintenance: renderMaintenance };
  function renderTab() { TAB_RENDER[state.tab](document.getElementById('mainCol')); }


  // ──────────────────────────────────────────────────────────────────────────
  // OVERVIEW  (§5.4 — focus-mode: curated narrative, not raw tables)
  // ──────────────────────────────────────────────────────────────────────────
  function renderOverview(el) {
    const t      = state.simTime;
    const near   = flightsNear(t, 6, 10).sort((a,b) => a._schedDep - b._schedDep);
    const upcoming = near.filter(f => (f._actDep||f._schedDep) >= t).slice(0, 10);
    const { cls, icon, label, text } = computeOpsSummary(t);

    if (el.dataset.initializedTab !== 'overview') {
      el.innerHTML = `
        <div class="ops-summary" id="overviewOpsSummary" role="status" aria-live="polite">
          <div class="ops-icon" aria-hidden="true"></div>
          <div class="ops-text"><div class="ops-label"></div><span id="overviewOpsText"></span></div>
        </div>

        <div class="section-title">Departure Board <span style="font-size:12px;color:var(--sev-alert);border:1px solid var(--sev-alert);padding:2px 6px;border-radius:4px;margin-left:12px;">DEPARTURES</span></div>
        <div class="section-sub">Next departures at T-3 — mechanical split-flap board shows the next 5 imminent departures. Scrub the timeline to replay any operational window.</div>

        <div class="split-flap-board" id="splitFlapBoardOverview" style="margin-bottom:16px;"></div>

        <div class="panel" style="margin-bottom:16px;">
          <div class="panel-header">
            <h2>Upcoming Departures</h2>
            <span class="hint">next 10 scheduled</span>
          </div>
          <div class="table-wrap">
            <table class="data" aria-label="Upcoming departures">
              <thead><tr><th>Flight</th><th>Route</th><th>Sched. Dep</th><th>Gate</th><th>Delay</th><th>Severity</th></tr></thead>
              <tbody id="nextDepBody"></tbody>
            </table>
          </div>
        </div>

        <!-- Gate Gantt view (§8.1) -->
        <div class="panel" style="margin-bottom:16px;">
          <div class="panel-header">
            <h2>Gate Timeline</h2>
            <span class="hint">±6h · amber line = now</span>
          </div>
          <div class="panel-body" style="padding:10px 8px;">
            <div class="gantt-wrap" id="ganttWrap"></div>
          </div>
        </div>

        <!-- Fleet snapshot -->
        <div class="chart-row" id="fleetSnapshotRow"></div>
      `;
      el.dataset.initializedTab = 'overview';
    }

    // Update Ops Summary
    const opsSummary = document.getElementById('overviewOpsSummary');
    if (opsSummary) {
      if (opsSummary.dataset.cls !== cls) {
        opsSummary.className = 'ops-summary ' + cls;
        opsSummary.dataset.cls = cls;
      }
      const iconEl = opsSummary.querySelector('.ops-icon');
      if (iconEl.innerHTML !== icon) iconEl.innerHTML = icon;
      const labelEl = opsSummary.querySelector('.ops-label');
      if (labelEl.innerHTML !== label) labelEl.innerHTML = label;
      const textEl = document.getElementById('overviewOpsText');
      if (textEl.innerHTML !== text) textEl.innerHTML = text;
    }

    // Update Split Flap
    drawSplitFlapBoard('splitFlapBoardOverview', 5);

    // Upcoming departures table (DOM diffing)
    const nextDepBody = document.getElementById('nextDepBody');
    if (nextDepBody) {
      const flightSignatures = upcoming.map(f => `${f.flight_id}-${severityOf(f)}-${f.delay_min}`).join(',');
      if (nextDepBody.dataset.lastSigs !== flightSignatures) {
        nextDepBody.innerHTML = upcoming.map((f, i) => {
          const sev = severityOf(f);
          return `<tr class="stagger-in" style="animation-delay:${i * 0.05}s" tabindex="0" onclick="openFlightDrawer('${f.flight_id}')">
            <td><b>${esc(f.flight_id)}</b></td>
            <td>${esc(f.origin)} → ${esc(f.destination)}</td>
            <td>${fmtDateTime(f._schedDep)}</td>
            <td>${esc(f.gate)}</td>
            <td>${f.delay_min > 0 ? '+' + f.delay_min + 'm' : '—'}</td>
            <td>${pillFor(sev, sev === 'nominal' ? 'Nominal' : sev.charAt(0).toUpperCase() + sev.slice(1))}</td>
          </tr>`;
        }).join('') || `<tr><td colspan="6" class="alert-empty">No departures in this window.</td></tr>`;
        nextDepBody.dataset.lastSigs = flightSignatures;
      }
    }

    // Update Fleet Snapshot
    const fleetRow = document.getElementById('fleetSnapshotRow');
    if (fleetRow) {
      const fleetHTML = `
        <div class="panel">
          <div class="panel-header"><h2>Fleet Snapshot</h2><span class="hint">near now</span></div>
          <div class="panel-body">
            <div class="stat-row">
              <div class="stat-block"><div class="n mono">${near.length}</div><div class="l">Flights in window</div></div>
              <div class="stat-block"><div class="n mono">${new Set(near.map(f=>f.tail_number)).size}</div><div class="l">Distinct aircraft</div></div>
              <div class="stat-block"><div class="n mono">${near.reduce((a,f)=>a+f.pax_count,0).toLocaleString()}</div><div class="l">Passengers moved</div></div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Delay Reasons</h2><span class="hint">near window</span></div>
          <div class="panel-body">
            ${delayReasonBars(near)}
          </div>
        </div>
      `;
      if (fleetRow.innerHTML !== fleetHTML) fleetRow.innerHTML = fleetHTML;
    }

    // Render gate Gantt
    const ganttEl = document.getElementById('ganttWrap');
    if (ganttEl) renderGantt(ganttEl, state.simTime);
  }

  function delayReasonBars(near) {
    const by = {}; for (const f of near) if (f.delay_min>0) by[f.delay_reason] = (by[f.delay_reason]||0)+1;
    const max = Math.max(1, ...Object.values(by));
    return `<div class="mini-bar-row">${Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>`
      <div class="mini-bar-col">
        <div class="mini-bar ${v===max?'hi':''}" style="height:${Math.max(4,v/max*60)}px" title="${k}: ${v}"></div>
        <div class="mini-bar-label">${esc(k.substring(0,6))}</div>
      </div>`).join('')||'<div class="alert-empty" style="padding:12px 0">No delays in window</div>'}</div>`;
  }


  // ──────────────────────────────────────────────────────────────────────────
  // GATE GANTT  (§8.1 — SVG, pure JS, no library)
  // ──────────────────────────────────────────────────────────────────────────
  function renderGantt(container, t) {
    const W_LABEL = 52, ROWS = Math.min(GATES.length, 24), H_ROW = 26, H_HEAD = 30;
    const W = container.clientWidth || 680;
    const H = ROWS * H_ROW + H_HEAD;
    const WINDOW_MS = 6 * 3600000;
    const tMin = t.getTime() - WINDOW_MS, tMax = t.getTime() + WINDOW_MS;
    const toX = ts => W_LABEL + ((ts - tMin) / (tMax - tMin)) * (W - W_LABEL);
    const SEV_COLORS = { nominal:'#7aa55e', watch:'#c8a25a', alert:'#d87a3d', critical:'#cf5040' };

    // Time axis ticks (every hour)
    const ticks = [];
    let h0 = new Date(tMin); h0.setMinutes(0,0,0);
    for (let h = h0.getTime(); h <= tMax; h += 3600000) {
      const x = toX(h); if (x < W_LABEL || x > W) continue;
      const isHalf = new Date(h).getHours() % 2 === 0;
      ticks.push(`<line x1="${x.toFixed(1)}" y1="${H_HEAD-6}" x2="${x.toFixed(1)}" y2="${H}" stroke="rgba(242,237,228,${isHalf?.06:.03})" />`);
      if (isHalf) ticks.push(`<text x="${x.toFixed(1)}" y="${H_HEAD-10}" fill="var(--ink-faint)" font-size="9" text-anchor="middle" font-family="JetBrains Mono,monospace">${new Date(h).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</text>`);
    }

    // Gate rows with flight bars
    const rows = GATES.slice(0, ROWS).map((g, i) => {
      const y = H_HEAD + i * H_ROW;
      const gFlights = flights.filter(f => f.gate === g);
      const bars = gFlights.map(f => {
        const [gs, ge] = gateWindow(f);
        const x1 = Math.max(W_LABEL, toX(gs.getTime()));
        const x2 = Math.min(W, toX(ge.getTime()));
        if (x2 - x1 < 2) return '';
        const sev = severityOf(f);
        const col = SEV_COLORS[sev] || '#7aa55e';
        const sta = flightStatusAt(f, t).code;
        const opa = sta === 'arrived' ? .3 : .82;
        const w = Math.max(x2-x1, 2);
        return `<rect x="${x1.toFixed(1)}" y="${(y+3).toFixed(1)}" width="${w.toFixed(1)}" height="${H_ROW-6}" rx="2"
          fill="${col}" opacity="${opa}" data-flight="${esc(f.flight_id)}" style="cursor:pointer">
          <title>${esc(f.flight_id)} · ${esc(f.origin)}→${esc(f.destination)} · ${fmtTime(f._schedDep)}${f.delay_min>0?' (+'+f.delay_min+'m)':''}</title>
        </rect>`;
      }).join('');
      return `<text x="${(W_LABEL-4).toFixed(1)}" y="${(y+H_ROW/2+4).toFixed(1)}" fill="var(--ink-faint)" font-size="9.5" text-anchor="end" font-family="JetBrains Mono,monospace">${g}</text>
        <line x1="${W_LABEL}" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(242,237,228,.04)"/>
        ${bars}`;
    }).join('');

    const nowX = Math.max(W_LABEL, Math.min(W, toX(t.getTime())));

    container.innerHTML = `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;overflow:visible;">
      <rect width="${W}" height="${H}" fill="transparent"/>
      ${ticks.join('')}
      ${rows}
      <line x1="${nowX.toFixed(1)}" y1="${H_HEAD-6}" x2="${nowX.toFixed(1)}" y2="${H}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3,4"/>
      <text x="${(nowX+3).toFixed(1)}" y="${(H_HEAD-12).toFixed(1)}" fill="var(--accent)" font-size="9" font-family="JetBrains Mono,monospace" font-weight="600">NOW</text>
    </svg>`;

    container.querySelector('svg').querySelectorAll('[data-flight]').forEach(el => {
      el.addEventListener('click', () => openFlightDrawer(el.dataset.flight));
    });
  }


  // ──────────────────────────────────────────────────────────────────────────
  // FLIGHTS TAB  (§5.5)
  // ──────────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────────
  // DIGITAL TWIN MAP
  // ──────────────────────────────────────────────────────────────────────────
  function renderMap(el) {
    if (el.dataset.initializedTab !== 'map') {
      el.dataset.initializedTab = 'map';
      const numGates = GATES.length;
      const initialGatesHTML = GATES.map((g, i) => {
        const pierIdx = Math.floor(i / 13);
        const posInPier = i % 13;
        const isLeft = posInPier % 2 === 0;
        const piersX = [200, 333, 466, 600];
        const cx = piersX[pierIdx] + (isLeft ? -25 : 25);
        const cy = 150 + Math.floor(posInPier / 2) * 45;
        
        return `
          <g transform="translate(${cx}, ${cy})" id="gate-group-${g}" class="map-gate-group">
            <line x1="0" y1="0" x2="${isLeft ? 18 : -18}" y2="0" stroke="rgba(255,255,255,0.1)" stroke-width="4" />
            <circle cx="0" cy="0" r="16" class="map-gate" id="gate-circle-${g}" onclick="window.showToast('Gate ${g} is currently unoccupied.')" style="cursor:pointer; transition: all 0.3s;" role="button" tabindex="0" aria-label="Gate ${g}" />
            <text x="0" y="4" class="map-gate-text" id="gate-text-${g}" style="font-size: 11px; text-anchor: middle; pointer-events: none; opacity: 0; transition: opacity 0.3s;">${g}</text>
            <text x="${isLeft ? -22 : 22}" y="4" class="map-flight-label" id="flight-label-${g}" style="font-size: 12px; font-family: var(--font-mono); text-anchor: ${isLeft ? 'end' : 'start'}; fill: var(--ink-main); opacity: 0; transition: opacity 0.3s; pointer-events: none; font-weight: bold;"></text>
          </g>
        `;
      }).join('');

      el.innerHTML = `
        <style>
          .map-gate-group:hover .map-gate-text { opacity: 1 !important; fill: #fff !important; }
        </style>
        <div class="section-title">Digital Twin · T3 Concourses</div>
        <div class="section-sub">Live physical schematic of terminal gates (1-50). Aircraft and gate states update instantly as the timeline progresses.</div>
        <div class="map-wrap" style="margin-top: 16px;">
          <div class="map-container" style="background: var(--bg-1); border-radius: 8px; border: 1px solid var(--panel-hair);">
            <svg class="map-svg" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid meet" id="mapSvg" style="width: 100%; height: 60vh;">
              
              <!-- Main Terminal Spine -->
              <line x1="150" y1="120" x2="650" y2="120" stroke="rgba(255,255,255,0.05)" stroke-width="40" stroke-linecap="round"/>
              <line x1="150" y1="120" x2="650" y2="120" stroke="rgba(255,255,255,0.1)" stroke-width="2" stroke-linecap="round"/>
              <!-- Pier 1 -->
              <line x1="200" y1="120" x2="200" y2="450" stroke="rgba(255,255,255,0.05)" stroke-width="40" stroke-linecap="round"/>
              <line x1="200" y1="120" x2="200" y2="450" stroke="rgba(255,255,255,0.1)" stroke-width="2" stroke-linecap="round"/>
              <!-- Pier 2 -->
              <line x1="333" y1="120" x2="333" y2="450" stroke="rgba(255,255,255,0.05)" stroke-width="40" stroke-linecap="round"/>
              <line x1="333" y1="120" x2="333" y2="450" stroke="rgba(255,255,255,0.1)" stroke-width="2" stroke-linecap="round"/>
              <!-- Pier 3 -->
              <line x1="466" y1="120" x2="466" y2="450" stroke="rgba(255,255,255,0.05)" stroke-width="40" stroke-linecap="round"/>
              <line x1="466" y1="120" x2="466" y2="450" stroke="rgba(255,255,255,0.1)" stroke-width="2" stroke-linecap="round"/>
              <!-- Pier 4 -->
              <line x1="600" y1="120" x2="600" y2="450" stroke="rgba(255,255,255,0.05)" stroke-width="40" stroke-linecap="round"/>
              <line x1="600" y1="120" x2="600" y2="450" stroke="rgba(255,255,255,0.1)" stroke-width="2" stroke-linecap="round"/>
              
              <!-- Runway -->
              <line x1="100" y1="650" x2="700" y2="650" stroke="rgba(255,255,255,0.2)" stroke-width="30" stroke-linecap="round" />
              <line x1="150" y1="650" x2="650" y2="650" stroke="rgba(255,255,255,0.8)" stroke-width="4" stroke-dasharray="20, 20" />
              <text x="70" y="655" fill="rgba(255,255,255,0.4)" font-family="var(--font-mono)" font-size="14" text-anchor="middle" transform="rotate(-90 70 655)">29R</text>
              <text x="730" y="655" fill="rgba(255,255,255,0.4)" font-family="var(--font-mono)" font-size="14" text-anchor="middle" transform="rotate(90 730 655)">11L</text>
              
              <!-- Tarmac taxiways (connecting piers to runway) -->
              <path d="M 200 450 L 200 635" stroke="rgba(200, 162, 90, 0.3)" stroke-width="2" stroke-dasharray="5, 5" fill="none"/>
              <path d="M 333 450 L 333 635" stroke="rgba(200, 162, 90, 0.3)" stroke-width="2" stroke-dasharray="5, 5" fill="none"/>
              <path d="M 466 450 L 466 635" stroke="rgba(200, 162, 90, 0.3)" stroke-width="2" stroke-dasharray="5, 5" fill="none"/>
              <path d="M 600 450 L 600 635" stroke="rgba(200, 162, 90, 0.3)" stroke-width="2" stroke-dasharray="5, 5" fill="none"/>

              <g id="mapLinesLayer"></g>
              <g id="mapGatesLayer">${initialGatesHTML}</g>
              <g id="mapPlanesLayer"></g>
            </svg>
          </div>
        </div>
      `;
      el.dataset.initialized = 'true';
    }

    const t = state.simTime;
    
    // Find flights that are currently boarding, or have departed within the last 15 minutes (for taxiing animation).
    const mapFlights = flightsNear(t, 2, 2).filter(f => {
      const dep = f._actDep || f._schedDep;
      const boardStart = new Date(dep.getTime() - BOARD_LEAD * 60000);
      const isBoarding = t >= boardStart && t < dep;
      const isTaxiing = t >= dep && t < new Date(dep.getTime() + 15 * 60000);
      return isBoarding || isTaxiing;
    });

    GATES.forEach((g) => {
      // Find the flight boarding at this gate.
      const occ = mapFlights.find(f => {
        const dep = f._actDep || f._schedDep;
        return f.gate === g && t < dep;
      });
      const c = document.getElementById('gate-circle-' + g);
      const tEl = document.getElementById('gate-text-' + g);
      const fLabel = document.getElementById('flight-label-' + g);
      if (c && tEl && fLabel) {
        if (occ) {
          const sev = severityOf(occ);
          const st = flightStatusAt(occ, t).code;
          const trueSev = st === 'boarding' ? 'boarding' : sev;
          c.setAttribute('class', `map-gate glow-${trueSev}`);
          c.setAttribute('onclick', `window.openFlightDrawer('${occ.flight_id}')`);
          fLabel.textContent = occ.flight_id;
          fLabel.style.opacity = '1';
          tEl.style.opacity = '1';
          tEl.style.fill = '#111';
          tEl.style.fontWeight = 'bold';
        } else {
          c.setAttribute('class', 'map-gate');
          c.setAttribute('onclick', `window.showToast('Gate ${g} is currently unoccupied.')`);
          fLabel.style.opacity = '0';
          tEl.style.opacity = '0';
          tEl.style.fill = '';
          tEl.style.fontWeight = '';
        }
      }
    });

    const planesLayer = document.getElementById('mapPlanesLayer');
    if (!planesLayer) return;

    let planesHTML = '';
    const numGates = GATES.length;
    mapFlights.forEach(f => {
      const gateIdx = GATES.indexOf(f.gate);
      if (gateIdx < 0) return;
      
      const angle = Math.PI * 0.85 - (gateIdx / (numGates - 1)) * (Math.PI * 0.70);
      const radius = 250;
      const gateX = 400 + Math.cos(angle) * radius;
      const gateY = 400 - Math.sin(angle) * radius;
      
      const dep = f._actDep || f._schedDep;
      
      let px = gateX;
      let py = gateY;
      let rot = -(angle * 180 / Math.PI) + 90;
      let opacity = 1;
      let scale = 1;

      if (t >= dep) {
        // Taxiing from gate to runway (15 mins = 900,000 ms)
        const progress = (t - dep) / (15 * 60000);
        if (progress > 1) return; // Gone
        
        // Taxi path: back out of gate, turn towards runway, taxi down to runway, then accelerate right.
        if (progress < 0.2) {
          // Pushback
          const p = progress / 0.2;
          px = gateX + Math.cos(angle) * (50 * p);
          py = gateY - Math.sin(angle) * (50 * p);
        } else if (progress < 0.8) {
          // Taxi to runway
          const p = (progress - 0.2) / 0.6;
          const startX = gateX + Math.cos(angle) * 50;
          const startY = gateY - Math.sin(angle) * 50;
          const endX = 200 + gateIdx * 15; // spread them out on runway
          const endY = 650;
          px = startX + (endX - startX) * p;
          py = startY + (endY - startY) * p;
          rot = Math.atan2(endY - startY, endX - startX) * 180 / Math.PI + 90;
        } else {
          // Takeoff roll
          const p = (progress - 0.8) / 0.2;
          const startX = 200 + gateIdx * 15;
          const startY = 650;
          const endX = 900;
          const endY = 650;
          px = startX + (endX - startX) * Math.pow(p, 2); // accelerate
          py = startY;
          rot = 90; // Face right
          if (p > 0.5) {
            scale = 1 + (p - 0.5) * 2; // lift off
            opacity = 1 - (p - 0.5) * 2; // fade out
            py -= (p - 0.5) * 100; // climb
          }
        }
      }

      const sev = severityOf(f);
      let color = 'var(--ink-subtle)';
      if (sev === 'critical') color = 'var(--sev-critical)';
      else if (sev === 'alert') color = 'var(--sev-alert)';
      else if (sev === 'watch') color = 'var(--sev-watch)';
      else if (sev === 'nominal') color = 'var(--brand)';

      // Draw a simple plane SVG
      planesHTML += `
        <g transform="translate(${px}, ${py}) rotate(${rot}) scale(${scale})" opacity="${opacity}" style="pointer-events: none; transition: transform 0.5s linear;">
          <path d="M0,-14 L4,-2 L18,-2 L18,1 L4,3 L2,14 L8,18 L8,20 L0,18 L-8,20 L-8,18 L-2,14 L-4,3 L-18,1 L-18,-2 L-4,-2 Z" fill="${color}" stroke="#111" stroke-width="1.5"/>
          ${t < dep ? `<text x="0" y="-22" fill="${color}" font-family="var(--font-mono)" font-size="12" text-anchor="middle" transform="rotate(${-rot})">${f.flight_id}</text>` : ''}
        </g>
      `;
    });

    const linesLayer = document.getElementById('mapLinesLayer');
    if (linesLayer) linesLayer.innerHTML = '';
    
    planesLayer.innerHTML = planesHTML;
  }

  function renderFlights(el) {
    el.innerHTML = `
      <div class="section-title">Flight Board <span style="font-size:12px;color:var(--sev-alert);border:1px solid var(--sev-alert);padding:2px 6px;border-radius:4px;margin-left:12px;">DEPARTURES</span></div>
      <div class="section-sub">${flights.length.toLocaleString()} scheduled movements. Mechanical split-flap board shows the next 5 imminent departures. Filter below to explore the full manifest.</div>
      
      <div class="split-flap-board" id="splitFlapBoard"></div>
      
      <div class="toolbar" style="margin-top:24px;">
        <input class="input" id="flQ" placeholder="Search flight, airline, route, tail…" value="${esc(state.flightFilter.q)}" autocomplete="off" aria-label="Search flights">
        <select class="select" id="flStatus" aria-label="Filter by severity">
          <option value="">All severities</option>
          <option value="critical">Critical (90m+)</option>
          <option value="alert">Alert (45-89m)</option>
          <option value="watch">Watch (15-44m)</option>
          <option value="nominal">Nominal</option>
        </select>
        <select class="select" id="flType" aria-label="Filter by route type">
          <option value="">All routes</option>
          <option value="Domestic">Domestic</option>
          <option value="Long-Haul Intl">Long-Haul Intl</option>
        </select>
      </div>
      <div class="panel">
        <div class="panel-body">
          <div class="table-wrap" style="max-height:62vh;overflow-y:auto;">
            <table class="data" aria-label="Full flight board">
              <thead><tr>
                <th data-k="flight_id" aria-sort="none">Flight <span class="sort-arrow" aria-hidden="true">↕</span></th>
                <th>Airline</th><th>Route</th>
                <th data-k="_schedDep" aria-sort="ascending">Sched. Dep <span class="sort-arrow" aria-hidden="true">↑</span></th>
                <th>Aircraft</th><th>Gate</th>
                <th data-k="delay_min" aria-sort="none">Delay <span class="sort-arrow" aria-hidden="true">↕</span></th>
                <th>Risk</th><th>Severity</th>
              </tr></thead>
              <tbody id="flightsBody"></tbody>
            </table>
          </div>
          <div class="card-list" id="flightsCardList" style="max-height:62vh;overflow-y:auto;"></div>
        </div>
      </div>`;

    const flQ = document.getElementById('flQ');
    flQ.value = state.flightFilter.q;
    flQ.addEventListener('input', debounce(e => { state.flightFilter.q = e.target.value; drawFlightsBody(); }, 220));
    document.getElementById('flStatus').addEventListener('change', e => { state.flightFilter.status = e.target.value; drawFlightsBody(); });
    document.getElementById('flType').addEventListener('change',   e => { state.flightFilter.terminal = e.target.value; drawFlightsBody(); });

    el.querySelectorAll('th[data-k]').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.k;
      state.flightSort.dir = state.flightSort.key === k ? -state.flightSort.dir : 1;
      state.flightSort.key = k;
      el.querySelectorAll('th[data-k]').forEach(h => { h.setAttribute('aria-sort','none'); const a=h.querySelector('.sort-arrow'); if(a) a.textContent='↕'; });
      th.setAttribute('aria-sort', state.flightSort.dir===1 ? 'ascending':'descending');
      const arrow = th.querySelector('.sort-arrow'); if (arrow) arrow.textContent = state.flightSort.dir===1?'↑':'↓';
      drawFlightsBody();
    }));
    drawFlightsBody();
  }

  function filteredFlights() {
    const { q, status, terminal } = state.flightFilter;
    const ql = q.trim().toLowerCase();
    return flights.filter(f => {
      if (ql && !`${f.flight_id} ${f.airline} ${f.origin} ${f.destination} ${f.aircraft_type} ${f.tail_number}`.toLowerCase().includes(ql)) return false;
      if (status && severityOf(f) !== status) return false;
      if (terminal && f.flight_type !== terminal) return false;
      return true;
    }).sort((a,b) => { const k=state.flightSort.key, d=state.flightSort.dir; return (a[k]>b[k]?1:a[k]<b[k]?-1:0)*d; });
  }

  function drawSplitFlapBoard(boardId, limit) {
    const board = document.getElementById(boardId);
    if (!board) return;
    const t = state.simTime;
    const upNext = flights.filter(f => {
      const s = flightStatusAt(f, t).code;
      return (s === 'scheduled' || s === 'boarding' || s === 'taxing') && f._actDep > t;
    }).sort((a,b) => a._actDep - b._actDep).slice(0, limit);
    
    const newBoardHTML = upNext.map(f => {
      const time = fmtDateTime(f._actDep).split(' ')[1] || '00:00'; 
      const flId = (f.flight_id).padEnd(6, ' ').substring(0, 6);
      const dest = (f.destination).padEnd(12, ' ').substring(0, 12);
      const gate = (f.gate).padEnd(3, ' ').substring(0, 3);
      const stat = (flightStatusAt(f, t).label).padEnd(8, ' ').substring(0, 8);
      const sev = severityOf(f);
      const colorClass = sev !== 'nominal' ? ' glow-' + sev : '';
      
      const buildChars = (s) => s.toUpperCase().split('').map(c => `<div class="sf-char">${c}</div>`).join('');

      return `<div class="sf-row${colorClass}" onclick="window.showFlight('${esc(f.flight_id)}')">
        <div class="sf-col-time" style="display:flex;gap:2px;">${buildChars(time)}</div>
        <div class="sf-col-flt" style="display:flex;gap:2px;">${buildChars(flId)}</div>
        <div class="sf-col-dest" style="display:flex;gap:2px;">${buildChars(dest)}</div>
        <div class="sf-col-gate" style="display:flex;gap:2px;">${buildChars(gate)}</div>
        <div class="sf-col-stat" style="display:flex;gap:2px;">${buildChars(stat)}</div>
      </div>`;
    }).join('');
    
    if (board.innerHTML !== newBoardHTML) {
       board.innerHTML = newBoardHTML;
       // Trigger animation on children
       const chars = board.querySelectorAll('.sf-char');
       chars.forEach(c => {
         c.classList.remove('sf-flip');
         void c.offsetWidth; // trigger reflow
         c.classList.add('sf-flip');
       });
    }
  }

  function drawFlightsBody() {
    drawSplitFlapBoard('splitFlapBoard', 5);

    const body = document.getElementById('flightsBody'), cards = document.getElementById('flightsCardList');
    if (!body && !cards) return;
    const rows = filteredFlights().slice(0, 300);

    if (body) {
      body.innerHTML = rows.map(f => {
        const sev  = severityOf(f);
        const risk = predictDelayRisk(f);
        return `<tr data-flight="${esc(f.flight_id)}" tabindex="0">
          <td><b>${esc(f.flight_id)}</b></td>
          <td>${esc(f.airline)}</td>
          <td>${esc(f.origin)} → ${esc(f.destination)}</td>
          <td>${fmtDateTime(f._schedDep)}</td>
          <td>${esc(f.aircraft_type)} <span style="color:var(--ink-faint)">${esc(f.tail_number)}</span></td>
          <td>${esc(f.gate)}</td>
          <td>${f.delay_min>0?'+'+f.delay_min+'m':'—'}</td>
          <td><span class="risk-badge ${risk}">${risk.toUpperCase()}</span></td>
          <td>${pillFor(sev, sev==='nominal'?'Nominal':sev.charAt(0).toUpperCase()+sev.slice(1))}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="9" class="alert-empty">No flights match these filters.</td></tr>`;
      body.querySelectorAll('tr[data-flight]').forEach(r => { r.addEventListener('click', () => openFlightDrawer(r.dataset.flight)); r.addEventListener('keydown', e => { if (e.key==='Enter') openFlightDrawer(r.dataset.flight); }); });
    }

    if (cards) {
      cards.innerHTML = rows.map(f => `
        <div class="card-item" data-flight="${esc(f.flight_id)}" tabindex="0">
          <div class="card-title"><span><b>${esc(f.flight_id)}</b> · ${esc(f.airline)}</span>${pillFor(severityOf(f), severityOf(f))}</div>
          <div class="card-row"><span class="label">Route</span><span>${esc(f.origin)} → ${esc(f.destination)}</span></div>
          <div class="card-row"><span class="label">Sched. Dep</span><span>${fmtDateTime(f._schedDep)}</span></div>
          <div class="card-row"><span class="label">Delay</span><span>${f.delay_min>0?'+'+f.delay_min+'m · '+esc(f.delay_reason):'—'}</span></div>
          <div class="card-row"><span class="label">Risk</span><span class="risk-badge ${predictDelayRisk(f)}">${predictDelayRisk(f).toUpperCase()}</span></div>
        </div>`).join('') || `<div class="alert-empty">No flights match.</div>`;
      cards.querySelectorAll('.card-item').forEach(c => { c.addEventListener('click', () => openFlightDrawer(c.dataset.flight)); c.addEventListener('keydown', e => { if (e.key==='Enter') openFlightDrawer(c.dataset.flight); }); });
    }
  }


  // ──────────────────────────────────────────────────────────────────────────
  // PASSENGER TRACE  (§5.6)
  // ──────────────────────────────────────────────────────────────────────────
  function renderTrace(el) {
    const samples = passengers.slice(0, 6).map(p => p.pnr);
    el.innerHTML = `
      <div class="trace-hero">
        <h2 class="serif">Trace a passenger's journey</h2>
        <p>Enter a PNR to assemble one connected story from four tables — check-in, security screening, gate boarding and baggage handling. The way an ops team actually traces a passenger.</p>
        <form class="trace-form" id="traceForm">
          <input class="input mono" id="traceInput" placeholder="e.g. ${esc(samples[0])}" autocomplete="off" spellcheck="false" aria-label="Passenger PNR">
          <button class="btn-primary" type="submit">Trace →</button>
        </form>
        <div style="margin-top:12px;">${samples.map(p => `<button class="trace-chip" data-pnr="${esc(p)}" type="button">${esc(p)}</button>`).join('')}</div>
      </div>
      <div id="traceResult" aria-live="polite" aria-atomic="true"></div>`;
    const run = pnr => { document.getElementById('traceInput').value = pnr; drawTrace(pnr); };
    el.querySelectorAll('.trace-chip').forEach(c => c.addEventListener('click', () => run(c.dataset.pnr)));
    document.getElementById('traceForm').addEventListener('submit', e => { e.preventDefault(); run(document.getElementById('traceInput').value.trim().toUpperCase()); });
  }

  function drawTrace(pnr) {
    const out = document.getElementById('traceResult');
    const p   = passByPnr.get(pnr);
    if (!p) { out.innerHTML = `<div class="empty-state"><div class="big serif">PNR not found</div><div class="hint">Try one of the sample codes above.</div></div>`; return; }
    const f    = flightById.get(p.flight_id);
    const sec  = (secByPnr.get(pnr)||[])[0];
    const bags = bagByPnr.get(pnr)||[];
    // Baggage journey tracker (§7.3) — visual mini-timeline per bag
    const bagTimeline = bags.map(b => {
      const stages = [
        { label:'Check-in',   done: !!b._checkin, time: fmtTime(b._checkin) },
        { label:'Sorted',     done: b.bag_status !== 'Checked-in', time:'—' },
        { label:'Loaded',     done: !!b._loaded || b.bag_status==='Loaded', time: fmtTime(b._loaded) },
        { label:'Arrival',    done: b.bag_status==='Delivered', time:'—' },
      ];
      const isMishandled = b.bag_status && !['Loaded','Delivered','Checked-in'].includes(b.bag_status);
      return `<div style="margin-bottom:10px;">
        <div style="font-size:10px;color:var(--ink-faint);margin-bottom:5px;font-family:var(--font-mono);">${esc(b.bag_tag)} · ${b.weight_kg.toFixed(1)}kg${isMishandled?` · <span style="color:var(--sev-critical)">${esc(b.bag_status)}</span>`:''}</div>
        <div style="display:flex;align-items:center;gap:0;">
          ${stages.map((s, i) => `
            <div style="display:flex;align-items:center;">
              <div style="text-align:center;">
                <div style="width:22px;height:22px;border-radius:50%;background:${s.done?'var(--sev-nominal)':'var(--panel-2)'};border:1px solid ${s.done?'var(--sev-nominal)':'var(--panel-hair-strong)'};display:flex;align-items:center;justify-content:center;font-size:9px;color:${s.done?'#12141a':'var(--ink-faint)'};">${s.done?'✓':i+1}</div>
                <div style="font-size:9px;color:var(--ink-faint);margin-top:3px;white-space:nowrap;">${s.label}</div>
              </div>
              ${i<stages.length-1?`<div style="width:28px;height:1px;background:${stages[i+1].done?'var(--sev-nominal)':'var(--panel-hair-strong)'};margin:0 3px;margin-bottom:16px;"></div>`:''}
            </div>`).join('')}
        </div>
      </div>`;
    }).join('') || '<div class="alert-empty">No baggage linked to this PNR.</div>';

    const steps = [];
    if (p._checkin)    steps.push({ icon:'01', stage:'Check-in',   detail:`Seat ${esc(p.seat)} · ${esc(p.cabin_class)}${f?' · '+esc(f.flight_id):''}`, time: fmtDateTime(p._checkin) });
    if (sec?._enter)   steps.push({ icon:'02', stage:'Security',   detail:`Lane ${esc(sec.lane)} · Queue ${sec.queue_position} · ${esc(sec.outcome)}`, time:`${fmtTime(sec._enter)}→${fmtTime(sec._clear)} (${minsBetween(sec._enter,sec._clear)}m)` });
    if (p._boarding)   steps.push({ icon:'03', stage:'Boarding',   detail:`Gate ${esc(p.gate)}${f?' · '+esc(f.origin)+'→'+esc(f.destination):''}`, time: fmtDateTime(p._boarding) });

    out.innerHTML = `
      <div class="panel">
        <div class="panel-header">
          <h2>${esc(p.first_name)} ${esc(p.last_name)}</h2>
          <span class="hint mono">${esc(p.pnr)}</span>
        </div>
        <div class="panel-body">
          <div class="kv-grid" style="margin-bottom:16px;">
            <div class="kv"><span class="k">Flight</span><span class="v">${f?esc(f.flight_id)+' ('+esc(f.origin)+'→'+esc(f.destination)+')':esc(p.flight_id)}</span></div>
            <div class="kv"><span class="k">Cabin / Fare</span><span class="v">${esc(p.cabin_class)} / ${esc(p.fare_class)}</span></div>
            <div class="kv"><span class="k">Seat / Gate</span><span class="v">${esc(p.seat)} / ${esc(p.gate)}</span></div>
            <div class="kv"><span class="k">Nationality</span><span class="v">${esc(p.nationality)}</span></div>
            <div class="kv"><span class="k">Age / Group</span><span class="v">${p.age} · ${esc(p.age_group)}</span></div>
            <div class="kv"><span class="k">Frequent Flyer</span><span class="v">${p.frequent_flyer?'✓ Yes':'No'}</span></div>
          </div>
          <h4 style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-faint);margin-bottom:12px;">Journey Timeline</h4>
          <ol style="list-style:none;">
            ${steps.map(s=>`<li class="journey-step"><div class="journey-dot">${s.icon}</div><div class="journey-content"><div class="stage">${esc(s.stage)}</div><div class="detail">${s.detail}</div><div class="time">${s.time}</div></div></li>`).join('')||'<li class="alert-empty">No further journey records.</li>'}
          </ol>
          <h4 style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-faint);margin:16px 0 10px;">Baggage Journey (§7.3)</h4>
          ${bagTimeline}
        </div>
      </div>
      ${f?`<button class="btn-primary" id="traceOpenFlight" style="margin:12px 0;">View full flight detail →</button>`:''}`;
    const btn = document.getElementById('traceOpenFlight');
    if (btn) btn.addEventListener('click', () => openFlightDrawer(f.flight_id));
  }


  // ──────────────────────────────────────────────────────────────────────────
  // SECURITY TAB  (§5.7 + §8.2)
  // ──────────────────────────────────────────────────────────────────────────
  function renderSecurity(el) {
    const t      = state.simTime;
    const nearby = security.filter(s => s._enter && Math.abs(s._enter - t) < 3 * 3600000).slice(0, 60);
    const avgDur = security.reduce((a,s) => a+(s.duration_sec||0),0) / security.length / 60;
    const alarms = security.filter(s => s.alarm_triggered).length;

    // Hourly wait time chart
    const hourlyWait = Array.from({length:24},(_,h) => { const w=security.filter(s=>s._enter&&new Date(2024,9,22,h,0,0)<=s._enter&&s._enter<new Date(2024,9,22,h+1,0,0)); return w.length?w.reduce((a,s)=>a+(s.duration_sec||0),0)/w.length/60:0; });
    const maxW = Math.max(...hourlyWait, 1);
    const curH = t.getHours();
    const chartPts = hourlyWait.map((v,i) => { const x=(i/23)*100; const y=100-((v/maxW)*90+5); return `${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');

    el.innerHTML = `
      <div class="section-title">Security Screening</div>
      <div class="section-sub">${security.length.toLocaleString()} passenger screenings. Live queue chart shows wait-time trend across the operational day — scrub the timeline to see your position.</div>

      <div class="panel" style="margin-bottom:14px;">
        <div class="panel-header"><h2>Security Queue Wait — Hourly Trend</h2><span class="hint">average wait in minutes</span></div>
        <div class="panel-body">
          <svg class="svg-chart" width="100%" height="90" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Security wait time by hour" style="overflow:visible;height:80px;">
            <defs><linearGradient id="secGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--sev-info)" stop-opacity=".4"/><stop offset="100%" stop-color="var(--sev-info)" stop-opacity="0"/></linearGradient></defs>
            <polygon points="${chartPts} 100,100 0,100" fill="url(#secGrad)"/>
            <polyline points="${chartPts}" fill="none" stroke="var(--sev-info)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
            <line x1="${((curH/23)*100).toFixed(1)}" y1="0" x2="${((curH/23)*100).toFixed(1)}" y2="100" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3,3" vector-effect="non-scaling-stroke"/>
          </svg>
          <div style="display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:9px;color:var(--ink-faint);margin-top:4px;"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:59</span></div>
        </div>
      </div>

      <div class="chart-row" style="margin-bottom:14px;">
        <div class="panel">
          <div class="panel-header"><h2>Throughput Stats</h2></div>
          <div class="panel-body">
            <div class="stat-row">
              <div class="stat-block"><div class="n mono">${avgDur.toFixed(1)}m</div><div class="l">Avg. wait</div></div>
              <div class="stat-block"><div class="n mono">${alarms}</div><div class="l">Alarms</div></div>
              <div class="stat-block"><div class="n mono">${security.filter(s=>s.outcome!=='Clear').length}</div><div class="l">Non-clear</div></div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Near-Window Screenings</h2><span class="hint">±3h</span></div>
          <div class="panel-body"><div class="stat-row">
            <div class="stat-block"><div class="n mono">${nearby.length}</div><div class="l">Screenings</div></div>
            <div class="stat-block"><div class="n mono">${nearby.filter(s=>s.alarm_triggered).length}</div><div class="l">Alarms now</div></div>
          </div></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header"><h2>Near-Window Records</h2><span class="hint">±3h</span></div>
        <div class="panel-body table-wrap" style="max-height:44vh;overflow-y:auto;">
          <table class="data">
            <thead><tr><th>ID</th><th>PNR</th><th>Lane</th><th>Queue</th><th>Wait</th><th>Outcome</th></tr></thead>
            <tbody>${nearby.map(s=>`<tr><td>${esc(s.screening_id)}</td><td class="mono">${esc(s.pnr)}</td><td>${esc(s.lane)}</td><td>${s.queue_position}</td><td>${minsBetween(s._enter,s._clear)}m</td><td>${pillFor(s.outcome==='Clear'?'nominal':'watch',esc(s.outcome))}</td></tr>`).join('')||`<tr><td colspan="6" class="alert-empty">No screenings in window.</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
  }


  // ──────────────────────────────────────────────────────────────────────────
  // STAFF + RETAIL + MAINTENANCE
  // ──────────────────────────────────────────────────────────────────────────
  function renderStaff(el) {
    if (el.dataset.initializedTab !== 'staff') {
      el.dataset.initializedTab = 'staff';
      const allDeptsObj = {}; for (const s of staff) allDeptsObj[s.department] = (allDeptsObj[s.department]||0)+1;
      const allDepts = Object.keys(allDeptsObj).sort((a,b)=>allDeptsObj[b]-allDeptsObj[a]);
      
      el.innerHTML = `
        <div class="section-title">Workforce</div>
        <div class="section-sub"><span id="staffTotalCount">0</span> shift records · <b id="staffOnShiftCountSub">0</b> currently on duty at the simulated time.</div>
        <div class="chart-row" style="margin-bottom:14px;">
          <div class="panel"><div class="panel-header"><h2>Departments on Duty</h2></div>
            <div class="panel-body"><div class="mini-bar-row">
              ${allDepts.map(k=>`<div class="mini-bar-col"><div class="mini-bar" id="staff-bar-${esc(k.replace(/\s/g,''))}" style="height:4px; transition: height 0.3s, background-color 0.3s;" title="${k}: 0"></div><div class="mini-bar-label">${esc(k.substring(0,5))}</div></div>`).join('')}
            </div></div>
          </div>
          <div class="panel"><div class="panel-header"><h2>On Shift Now</h2></div><div class="panel-body"><div class="stat-row">
            <div class="stat-block"><div class="n mono" id="staffOnShiftCount">0</div><div class="l">On duty</div></div>
            <div class="stat-block"><div class="n mono" id="staffOTCount">0</div><div class="l">Overtime</div></div>
            <div class="stat-block"><div class="n mono" id="staffActiveDepts">0</div><div class="l">Depts active</div></div>
          </div></div></div>
        </div>
        <div class="panel"><div class="panel-header"><h2>On-Shift Roster</h2></div><div class="panel-body table-wrap" style="max-height:52vh;overflow-y:auto;">
          <table class="data"><thead><tr><th>Name</th><th>Role</th><th>Gate</th><th>Shift</th><th>OT</th></tr></thead>
          <tbody id="staffTableBody"></tbody>
          </table></div></div>
      `;
      el.dataset.initialized = 'true';
      el.dataset.allDepts = JSON.stringify(allDepts);
    }

    const t = state.simTime;
    const onShift = staff.filter(s => isRecordActive(t, s._start, s._end));
    const byDept = {}; for (const s of onShift) byDept[s.department] = (byDept[s.department]||0)+1;
    const maxD = Math.max(1, ...Object.values(byDept));

    document.getElementById('staffTotalCount').innerText = staff.length.toLocaleString();
    document.getElementById('staffOnShiftCountSub').innerText = onShift.length;
    document.getElementById('staffOnShiftCount').innerText = onShift.length;
    document.getElementById('staffOTCount').innerText = onShift.filter(s=>s.is_overtime).length;
    document.getElementById('staffActiveDepts').innerText = Object.keys(byDept).length;

    const allDepts = JSON.parse(el.dataset.allDepts);
    allDepts.forEach(k => {
      const v = byDept[k] || 0;
      const bar = document.getElementById('staff-bar-' + k.replace(/\s/g, ''));
      if (bar) {
        bar.style.height = Math.max(4, (v/maxD)*58) + 'px';
        if (v === maxD && maxD > 1) bar.classList.add('hi'); else bar.classList.remove('hi');
        bar.title = `${k}: ${v}`;
      }
    });

    const tbody = document.getElementById('staffTableBody');
    if (tbody) {
      tbody.innerHTML = onShift.slice(0,100).map(s=>`<tr><td>${esc(s.staff_name)}<br><span style="color:var(--ink-faint);font-size:10px;">${esc(s.staff_id)}</span></td><td>${esc(s.role)}</td><td>${esc(s.terminal)}/${esc(s.gate)}</td><td>${fmtTime(s._start)}–${fmtTime(s._end)}</td><td>${s.is_overtime?pillFor('watch','OT'):'—'}</td></tr>`).join('')||`<tr><td colspan="5" class="alert-empty">No staff on shift in this window.</td></tr>`;
    }
  }

  function renderRetail(el) {
    if (el.dataset.initializedTab !== 'retail') {
      el.dataset.initializedTab = 'retail';
      const allCatObj = {}; for (const r of retail) allCatObj[r.category] = (allCatObj[r.category]||0)+r.amount;
      const allCat = Object.keys(allCatObj).sort((a,b)=>allCatObj[b]-allCatObj[a]);

      el.innerHTML = `
        <div class="section-title">Retail &amp; Concessions</div>
        <div class="section-sub">${retail.length.toLocaleString()} transactions — joined to flights via passenger passport. Click any row to open the linked flight detail.</div>
        <div class="chart-row" style="margin-bottom:14px;">
          <div class="panel"><div class="panel-header"><h2>Revenue by Category (±12h)</h2></div>
            <div class="panel-body"><div class="mini-bar-row">
              ${allCat.map(k=>`<div class="mini-bar-col"><div class="mini-bar" id="retail-bar-${esc(k.replace(/\\s/g,''))}" style="height:4px; transition: height 0.3s, background-color 0.3s;" title="${k}: 0"></div><div class="mini-bar-label">${esc(k.substring(0,5))}</div></div>`).join('')}
            </div></div>
          </div>
          <div class="panel"><div class="panel-header"><h2>Revenue</h2></div><div class="panel-body"><div class="stat-row">
            <div class="stat-block"><div class="n mono" style="font-size:20px;">₹${Math.round(retail.reduce((a,r)=>a+r.amount,0)).toLocaleString('en-IN')}</div><div class="l">Total dataset</div></div>
            <div class="stat-block"><div class="n mono" style="font-size:20px;" id="retailWindowTotal">₹0</div><div class="l">±12h window</div></div>
          </div></div></div>
        </div>
        <div class="panel"><div class="panel-header"><h2>Transactions ±12h</h2></div><div class="panel-body table-wrap" style="max-height:48vh;overflow-y:auto;">
          <table class="data"><thead><tr><th>Txn</th><th>Flight</th><th>Item</th><th>Qty</th><th>Amount</th><th>Time</th></tr></thead>
          <tbody id="retailTableBody"></tbody>
          </table></div></div>
      `;
      el.dataset.initialized = 'true';
      el.dataset.allCat = JSON.stringify(allCat);
    }

    const t = state.simTime;
    const w_ = retail.filter(r => r._txn && Math.abs(r._txn - t) < 12*3600000);
    const byCategory = {}; for (const r of w_) byCategory[r.category] = (byCategory[r.category]||0)+r.amount;
    const maxCat = Math.max(1, ...Object.values(byCategory));

    document.getElementById('retailWindowTotal').innerText = '₹' + Math.round(w_.reduce((a,r)=>a+r.amount,0)).toLocaleString('en-IN');

    const allCat = JSON.parse(el.dataset.allCat);
    allCat.forEach(k => {
      const v = byCategory[k] || 0;
      const bar = document.getElementById('retail-bar-' + k.replace(/\\s/g, ''));
      if (bar) {
        bar.style.height = Math.max(4, (v/maxCat)*58) + 'px';
        if (v === maxCat && maxCat > 1) bar.classList.add('hi'); else bar.classList.remove('hi');
        bar.title = `${k}: ₹${Math.round(v).toLocaleString('en-IN')}`;
      }
    });

    const tbody = document.getElementById('retailTableBody');
    if (tbody) {
      tbody.innerHTML = w_.slice(0,80).map(r=>`<tr data-flight="${esc(r.flight_id)}" tabindex="0"><td>${esc(r.txn_id.split('-')[0])}</td><td><b>${esc(r.flight_id)}</b></td><td>${esc(r.item)}</td><td>${r.quantity}</td><td>₹${r.amount}</td><td>${fmtTime(r._txn)}</td></tr>`).join('')||`<tr><td colspan="6" class="alert-empty">No transactions in window.</td></tr>`;
      // Re-attach listeners to new rows (within the table body!)
      tbody.querySelectorAll('[data-flight]').forEach(r => { r.addEventListener('click', () => openFlightDrawer(r.dataset.flight)); r.addEventListener('keydown', e => { if (e.key==='Enter') openFlightDrawer(r.dataset.flight); }); });
    }
  }

  function renderMaintenance(el) {
    if (el.dataset.initializedTab !== 'maintenance') {
      el.dataset.initializedTab = 'maintenance';
      const allTypesObj = {}; for (const m of maintenance) allTypesObj[m.maint_type] = (allTypesObj[m.maint_type]||0)+1;
      const allTypes = Object.keys(allTypesObj).sort((a,b)=>allTypesObj[b]-allTypesObj[a]);

      el.innerHTML = `
        <div class="section-title">Maintenance &amp; Engineering</div>
        <div class="section-sub">${maintenance.length.toLocaleString()} work orders. <b id="maintOpenCountSub">0</b> open now. WOs are cross-checked against upcoming departures — conflicts surface in the incident feed and on flight risk badges.</div>
        <div class="chart-row" style="margin-bottom:14px;">
          <div class="panel"><div class="panel-header"><h2>Open WO Types</h2></div>
            <div class="panel-body"><div class="mini-bar-row">
              ${allTypes.map(k=>`<div class="mini-bar-col"><div class="mini-bar" id="maint-bar-${esc(k.replace(/\\s/g,''))}" style="height:4px; transition: height 0.3s, background-color 0.3s;" title="${k}: 0"></div><div class="mini-bar-label">${esc(k.substring(0,6))}</div></div>`).join('')}
            </div></div>
          </div>
          <div class="panel"><div class="panel-header"><h2>Fleet Health</h2><span class="hint mono" id="maintSimTime">00:00</span></div><div class="panel-body"><div class="stat-row">
            <div class="stat-block"><div class="n mono" id="maintOpenCount">0</div><div class="l">Open WOs</div></div>
            <div class="stat-block"><div class="n mono" id="maintAffectedCount">0</div><div class="l">Aircraft affected</div></div>
            <div class="stat-block"><div class="n mono">${(maintenance.reduce((a,m)=>a+(m.downtime_hours||0),0)/maintenance.length).toFixed(1)}h</div><div class="l">Avg downtime</div></div>
          </div></div></div>
        </div>
        <div class="panel"><div class="panel-header"><h2>Work Orders</h2></div><div class="panel-body table-wrap" style="max-height:58vh;overflow-y:auto;">
          <table class="data"><thead><tr><th>WO</th><th>Tail</th><th>Type</th><th>Defect</th><th>Downtime</th><th>Status</th></tr></thead>
          <tbody id="maintTableBody"></tbody>
          </table></div></div>
      `;
      el.dataset.initialized = 'true';
      el.dataset.allTypes = JSON.stringify(allTypes);
    }

    const t = state.simTime;
    const activeMaint = maintenance.filter(m => isRecordActive(t, m._start, m._end));
    const byType = {}; for (const m of activeMaint) byType[m.maint_type] = (byType[m.maint_type]||0)+1;
    const maxT = Math.max(1, ...Object.values(byType));

    document.getElementById('maintAffectedCount').innerText = new Set(open.map(m=>m.tail_number)).size;
    document.getElementById('maintSimTime').innerText = fmtTime(t);

    const allTypes = JSON.parse(el.dataset.allTypes);
    allTypes.forEach(k => {
      const v = byType[k] || 0;
      const bar = document.getElementById('maint-bar-' + k.replace(/\\s/g, ''));
      if (bar) {
        bar.style.height = Math.max(4, (v/maxT)*58) + 'px';
        if (v === maxT && maxT > 1) bar.classList.add('hi'); else bar.classList.remove('hi');
        bar.title = `${k}: ${v}`;
      }
    });

    const tbody = document.getElementById('maintTableBody');
    if (tbody) {
      tbody.innerHTML = [...maintenance].sort((a,b)=>b._start-a._start).slice(0,120).map(m=>{
        const isOpen = m._end && m._end > t && m._start <= t;
        const linkedF = flights.find(f => f.tail_number===m.tail_number);
        return `<tr ${linkedF?`data-flight="${esc(linkedF.flight_id)}" tabindex="0"`:''}>
          <td>${esc(m.work_order_id)}</td><td class="mono">${esc(m.tail_number)}</td>
          <td>${esc(m.maint_type)}</td><td>${esc(m.defect_type)}</td>
          <td>${m.downtime_hours}h</td><td>${isOpen?pillFor('watch','Open'):pillFor('nominal','Closed')}</td></tr>`;
      }).join('');
      tbody.querySelectorAll('[data-flight]').forEach(r => { r.addEventListener('click', () => openFlightDrawer(r.dataset.flight)); r.addEventListener('keydown', e => { if (e.key==='Enter') openFlightDrawer(r.dataset.flight); }); });
    }
  }


  // ════════════════════════════════════════════════════════════════════════
  // FLIGHT DETAIL DRAWER  (§5.10 — cross-table, 5-table join)
  // ════════════════════════════════════════════════════════════════════════

  function openFlightDrawer(flightId) {
    const f = flightById.get(flightId); if (!f) return;
    state.drawerTrigger = document.activeElement;

    const pax    = passByFlight.get(flightId)||[];
    const bags   = bagByFlight.get(flightId)||[];
    const gEvs   = gateEvByFlight.get(flightId)||[];
    const wos    = maintByTail.get(f.tail_number)||[];
    const sev    = severityOf(f);
    const risk   = predictDelayRisk(f);
    const classSplit = pax.reduce((m,p) => (m[p.cabin_class]=(m[p.cabin_class]||0)+1, m), {});
    const totalW = bags.reduce((a,b) => a+(b.weight_kg||0), 0);

    // Maintenance cross-check (§7.1) — highlighted if open WOs exist
    const openWOs = wos.filter(w => w._end && w._end > state.simTime);

    document.getElementById('drawerTitle').textContent = `${f.flight_id} · ${f.origin} → ${f.destination}`;
    document.getElementById('drawerSub').textContent   = `${f.airline} · ${f.aircraft_type} (${f.tail_number}) · ${fmtDate(f._schedDep)}`;
    document.getElementById('drawerBody').innerHTML = `
      <div class="drawer-section">
        <h4>Status & Severity</h4>
        <div style="margin-bottom:11px;display:flex;gap:7px;flex-wrap:wrap;align-items:center;">
          ${pillFor(sev, sev==='nominal'?'On schedule':`${f.delay_min}m delay`)}
          ${pillFor('neutral', flightStatusAt(f, state.simTime).label)}
          <span class="risk-badge ${risk}" title="Predictive delay risk score">Risk: ${risk.toUpperCase()}</span>
        </div>
        <div class="kv-grid">
          <div class="kv"><span class="k">Sched. Dep.</span><span class="v">${fmtDateTime(f._schedDep)}</span></div>
          <div class="kv"><span class="k">Actual Dep.</span><span class="v">${fmtDateTime(f._actDep)}</span></div>
          <div class="kv"><span class="k">Gate / Terminal</span><span class="v">${esc(f.gate)} / ${esc(f.terminal)}</span></div>
          <div class="kv"><span class="k">Delay Reason</span><span class="v">${f.delay_min>0?esc(f.delay_reason):'—'}</span></div>
          <div class="kv"><span class="k">OTP Score</span><span class="v">${f.otp_score.toFixed(1)}</span></div>
          <div class="kv"><span class="k">Pax count</span><span class="v">${f.pax_count} (cap. ${f.capacity})</span></div>
        </div>
      </div>

      <div class="drawer-section">
        <h4>⚙ Maintenance Cross-Check (§7.1)</h4>
        ${openWOs.length
          ? `<div style="background:var(--sev-critical-bg);border:1px solid rgba(207,80,64,.3);border-radius:var(--r-sm);padding:8px 10px;margin-bottom:8px;font-size:11px;">
              <b style="color:var(--sev-critical)">⚠ ${openWOs.length} open WO${openWOs.length>1?'s':''} on ${esc(f.tail_number)} — departure at risk</b><br>
              ${openWOs.slice(0,2).map(w=>`${esc(w.defect_type)} · WO ${esc(w.work_order_id)} · est. clear ${fmtTime(w._end)}`).join('<br>')}
            </div>`
          : `<div style="color:var(--ink-faint);font-size:11px;margin-bottom:8px;">No open maintenance WOs for ${esc(f.tail_number)}.</div>`}
        ${wos.slice(0,3).map(w=>`<div class="kv" style="margin-bottom:5px;"><span class="k">${fmtDate(w._start)}</span><span class="v">${esc(w.maint_type)} · ${esc(w.defect_type)} · ${w.downtime_hours}h</span></div>`).join('')}
      </div>

      <div class="drawer-section">
        <h4>Passengers (${pax.length} / cap. ${f.capacity})</h4>
        <div class="kv-grid">${Object.entries(classSplit).map(([k,v])=>`<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v} pax</span></div>`).join('')||'<div class="kv"><span class="v" style="color:var(--ink-faint)">No passenger records linked</span></div>'}</div>
      </div>

      <div class="drawer-section">
        <h4>Baggage (${bags.length} bags · ${totalW.toFixed(0)}kg)</h4>
        ${bags.slice(0,6).map(b=>`<div class="kv" style="margin-bottom:5px;"><span class="k">${esc(b.bag_tag)}</span><span class="v">${b.weight_kg.toFixed(1)}kg · ${esc(b.bag_status)} @ ${esc(b.current_location)}</span></div>`).join('')||'<div class="alert-empty">No baggage records.</div>'}
      </div>

      <div class="drawer-section">
        <h4>Gate Activity</h4>
        ${gEvs.slice(0,5).map(g=>`<div class="kv" style="margin-bottom:5px;"><span class="k">${fmtTime(g._t)}</span><span class="v">${esc(g.event_type)} · Gate ${esc(g.gate)}</span></div>`).join('')||'<div class="alert-empty">No gate events linked.</div>'}
      </div>
    `;

    document.getElementById('drawer').classList.add('is-open');
    document.getElementById('drawerScrim').classList.add('is-open');
    const closeBtn = document.getElementById('drawerClose');
    if (closeBtn) setTimeout(() => closeBtn.focus(), reducedMotion()?0:310);
  }

  function closeDrawer() {
    document.getElementById('drawer').classList.remove('is-open');
    document.getElementById('drawerScrim').classList.remove('is-open');
    if (state.drawerTrigger?.focus) { state.drawerTrigger.focus(); state.drawerTrigger = null; }
  }

  function trapFocus(e) {
    const drawer = document.getElementById('drawer');
    if (!drawer.classList.contains('is-open')) return;
    const focusable = [...drawer.querySelectorAll('button,[href],input,select,[tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled);
    if (!focusable.length) return;
    const [first, last] = [focusable[0], focusable[focusable.length-1]];
    if (e.key==='Tab') { if (e.shiftKey) { if (document.activeElement===first) { e.preventDefault(); last.focus(); } } else { if (document.activeElement===last) { e.preventDefault(); first.focus(); } } }
  }


  // ════════════════════════════════════════════════════════════════════════
  // COMMAND PALETTE  (§2.3 — ⌘K)
  // ════════════════════════════════════════════════════════════════════════

  let cmdFocusIdx = -1;

  function openCommandPalette() {
    document.getElementById('cmdBackdrop').classList.add('is-open');
    document.getElementById('cmdInput').focus();
    runCommandSearch('');
  }
  function closeCommandPalette() {
    document.getElementById('cmdBackdrop').classList.remove('is-open');
    cmdFocusIdx = -1;
  }

  function runCommandSearch(q) {
    const ql  = q.trim().toLowerCase();
    const out = document.getElementById('cmdResults');
    const results = [];

    // Search flights
    for (const f of flights) {
      if (results.length >= 12) break;
      if (!ql || `${f.flight_id} ${f.airline} ${f.origin} ${f.destination}`.toLowerCase().includes(ql)) {
        const sev = severityOf(f);
        results.push({ type:'flight', icon:'✈', title:`${f.flight_id} · ${f.origin}→${f.destination}`, sub:`${f.airline} · ${fmtTime(f._schedDep)} · Gate ${f.gate}`, badge:pillFor(sev,sev), action:() => { closeCommandPalette(); openFlightDrawer(f.flight_id); } });
      }
    }
    // Search passengers
    for (const p of passengers) {
      if (results.length >= 18) break;
      if (ql && `${p.pnr} ${p.first_name} ${p.last_name}`.toLowerCase().includes(ql)) {
        results.push({ type:'passenger', icon:'👤', title:`${p.first_name} ${p.last_name}`, sub:`PNR: ${p.pnr} · ${p.cabin_class} · Seat ${p.seat}`, badge:'', action:() => { closeCommandPalette(); state.tab='trace'; document.querySelectorAll('.tab-btn').forEach(b => { b.classList.toggle('is-active', b.dataset.tab==='trace'); b.setAttribute('aria-selected', b.dataset.tab==='trace'?'true':'false'); }); renderTab(); setTimeout(() => { const input=document.getElementById('traceInput'); if(input){input.value=p.pnr;} drawTrace(p.pnr); }, 100); } });
      }
    }

    if (!results.length) { out.innerHTML = `<div class="cmd-empty">No results${ql?' for "'+esc(q)+'"':''} — try a flight ID, airline, route or PNR.</div>`; return; }

    out.innerHTML = results.map((r,i) => `
      <div class="cmd-result${i===cmdFocusIdx?' is-focused':''}" data-idx="${i}" tabindex="-1"
        role="option" aria-label="${esc(r.title)}: ${esc(r.sub)}">
        <div class="cr-icon" aria-hidden="true">${r.icon}</div>
        <div class="cr-main">
          <div class="cr-title">${esc(r.title)}</div>
          <div class="cr-sub">${esc(r.sub)}</div>
        </div>
        <div class="cr-badge">${r.badge}</div>
      </div>`).join('');

    // Store results for keyboard nav
    out.querySelectorAll('.cmd-result').forEach((el, i) => {
      el.addEventListener('click', () => results[i].action());
      el.addEventListener('mouseenter', () => { cmdFocusIdx = i; out.querySelectorAll('.cmd-result').forEach((r,j) => r.classList.toggle('is-focused', j===i)); });
    });
  }


  // ════════════════════════════════════════════════════════════════════════
  // UTILITY
  // ════════════════════════════════════════════════════════════════════════

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }


  // ════════════════════════════════════════════════════════════════════════
  // EVENT WIRING
  // ════════════════════════════════════════════════════════════════════════

  // Drawer
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  document.getElementById('drawerScrim').addEventListener('click', closeDrawer);

  // Command palette
  document.getElementById('cmdBackdrop').addEventListener('click', e => { if (e.target===e.currentTarget) closeCommandPalette(); });
  document.getElementById('cmdInput').addEventListener('input', debounce(e => { cmdFocusIdx=-1; runCommandSearch(e.target.value); }, 160));

  // Global keyboard
  document.addEventListener('keydown', e => {
    // Escape
    if (e.key === 'Escape') { if (document.getElementById('cmdBackdrop').classList.contains('is-open')) closeCommandPalette(); else closeDrawer(); return; }
    // Focus trap in drawer
    if (document.getElementById('drawer').classList.contains('is-open')) { trapFocus(e); }
    // ⌘K / Ctrl+K — command palette
    if ((e.metaKey||e.ctrlKey) && e.key==='k') { e.preventDefault(); openCommandPalette(); return; }
    // Space = play/pause (outside inputs)
    if (e.code==='Space' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); btnPlay.click(); return; }
    // Arrow keys in command palette
    if (document.getElementById('cmdBackdrop').classList.contains('is-open')) {
      const results = document.getElementById('cmdResults').querySelectorAll('.cmd-result');
      if (e.key==='ArrowDown') { e.preventDefault(); cmdFocusIdx = Math.min(cmdFocusIdx+1, results.length-1); results.forEach((r,i) => r.classList.toggle('is-focused', i===cmdFocusIdx)); }
      if (e.key==='ArrowUp')   { e.preventDefault(); cmdFocusIdx = Math.max(cmdFocusIdx-1, 0); results.forEach((r,i) => r.classList.toggle('is-focused', i===cmdFocusIdx)); }
      if (e.key==='Enter' && cmdFocusIdx>=0) results[cmdFocusIdx]?.click();
    }
  });

  // Tabs
  document.getElementById('tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn'); if (!btn) return;
    state.tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.toggle('is-active', b===btn); b.setAttribute('aria-selected', b===btn?'true':'false'); });
    renderTab();
  });

  // Play / Pause
  const btnPlay = document.getElementById('btnPlay');
  btnPlay.addEventListener('click', () => {
    state.useRealTime = false;
    state.playing = !state.playing;
    btnPlay.textContent = state.playing ? '❚❚' : '▶';
    btnPlay.classList.toggle('is-active', state.playing);
    btnPlay.setAttribute('aria-pressed', String(state.playing));
    renderClock();
  });

  // Reset
  document.getElementById('btnReset').addEventListener('click', () => {
    state.useRealTime = false; state.playing = false;
    btnPlay.textContent = '▶'; btnPlay.classList.remove('is-active');
    state.simTime = new Date(2024, 9, 22, 6, 0, 0);
    state.prevAlertIds.clear();
    tick(true);
  });

  // Crisis scenario (§4.1) — jump to auto-detected worst window
  document.getElementById('btnCrisis').addEventListener('click', () => {
    state.useRealTime = false; state.playing = false;
    btnPlay.textContent = '▶'; btnPlay.classList.remove('is-active');
    state.simTime = new Date(CRISIS_TIME);
    state.prevAlertIds.clear();
    const alerts = computeAlerts(state.simTime);
    showToast(`Crisis scenario loaded`, `${alerts.length} alerts at ${fmtTime(state.simTime)} — scrub ±30m to explore`, 'critical', 6000);
    tick(true);
  });

  // Command palette button
  document.getElementById('btnCmd').addEventListener('click', openCommandPalette);

  // Speed
  document.querySelectorAll('.speed-btn').forEach(b => b.addEventListener('click', () => {
    state.speed = parseInt(b.dataset.speed, 10);
    document.querySelectorAll('.speed-btn').forEach(x => x.classList.toggle('is-active', x===b));
  }));

  // Scrubber
  const scrubRange = document.getElementById('scrubRange');
  scrubRange.addEventListener('input', () => {
    state.useRealTime = false;
    state.simTime = new Date(MIN_T + (scrubRange.value/1000) * (MAX_T - MIN_T));
    const hint = document.getElementById('scrubHint');
    if (hint) { hint.textContent = fmtDate(state.simTime); hint.classList.add('active'); }
    tick(true);
  });
  scrubRange.addEventListener('change', () => {
    const hint = document.getElementById('scrubHint');
    if (hint) { hint.textContent = 'drag to scrub any date'; hint.classList.remove('active'); }
  });


  // ════════════════════════════════════════════════════════════════════════
  // MAIN LOOP
  // ════════════════════════════════════════════════════════════════════════

  function tick() { renderChrome(); renderTab(); }

  let lastTs = performance.now(), lastClockSec = -1, lastAlertCheck = 0;
  function loop(ts) {
    const dtSec = Math.min((ts - lastTs) / 1000, 0.5); lastTs = ts;
    if (state.playing) {
      state.simTime = new Date(state.simTime.getTime() + dtSec * state.speed * 1000);
      if (state.simTime.getTime() > MAX_T) state.simTime = new Date(MIN_T);
      renderChrome();
      if (state.tab==='flights') drawFlightsBody();
      else if (state.tab==='overview') {
        const ganttEl = document.getElementById('ganttWrap');
        if (ganttEl) renderGantt(ganttEl, state.simTime);
        document.getElementById('nextDepBody') && renderTab();
      } else renderTab();
      // Toast check every 30 sim-minutes
      if (state.simTime.getTime() - lastAlertCheck > 30 * 60000) { lastAlertCheck = state.simTime.getTime(); checkForNewAlerts(); }
    } else if (state.useRealTime) {
      const sec = Math.floor(ts / 1000);
      if (sec !== lastClockSec) { lastClockSec = sec; renderClock(); }
    }
    requestAnimationFrame(loop);
  }

  const splashBtn = document.getElementById('btnEnterSplash');
  if (splashBtn) {
    splashBtn.addEventListener('click', () => {
      document.getElementById('splashScreen').classList.add('hidden');
    });
  }

  // Global exports for inline HTML handlers
  window.openFlightDrawer = openFlightDrawer;
  window.showFlight = openFlightDrawer;
  window.showToast = showToast;

  tick();
  requestAnimationFrame(loop);

})();
