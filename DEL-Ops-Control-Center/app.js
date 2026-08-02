// ================= Airport Operations Control Center =================
// Vanilla JS, no framework, no build step. Reads RAW from data.js
// (which was generated directly from the provided CSVs — see /tools/build_data.py
// in the repo for the exact column mapping used, since the source files ship
// with positional headers only).

(function () {
  'use strict';

  // ---------- Parse & index ----------
  const P = (s) => (s ? new Date(s.replace(' ', 'T')) : null);

  const flights = RAW.flights.map(f => ({
    ...f,
    _schedDep: P(f.sched_dep), _actDep: P(f.actual_dep),
    _schedArr: P(f.sched_arr), _actArr: P(f.actual_arr),
  }));
  const passengers = RAW.passengers.map(p => ({ ...p, _checkin: P(p.checkin_time), _boarding: P(p.boarding_time) }));
  const baggage = RAW.baggage.map(b => ({ ...b, _checkin: P(b.checkin_time), _loaded: P(b.loaded_time) }));
  const security = RAW.security.map(s => ({ ...s, _enter: P(s.queue_enter_time), _screen: P(s.screening_time), _clear: P(s.clear_time) }));
  const staff = RAW.staff.map(s => ({ ...s, _start: P(s.shift_start), _end: P(s.shift_end) }));
  const retail = RAW.retail.map(r => ({ ...r, _txn: P(r.txn_time) }));
  const maintenance = RAW.maintenance.map(m => ({ ...m, _start: P(m.start_time), _end: P(m.end_time) }));
  const gateEvents = RAW.gateEvents.map(g => ({ ...g, _t: P(g.event_time) }));

  const byId = (arr, key) => { const m = new Map(); for (const r of arr) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const flightById = new Map(flights.map(f => [f.flight_id, f]));
  const passByFlight = byId(passengers, 'flight_id');
  const bagByFlight = byId(baggage, 'flight_id');
  const bagByPnr = byId(baggage, 'pnr');
  const secByPnr = byId(security, 'pnr');
  const retailByPassport = byId(retail, 'passport_masked');
  const maintByTail = byId(maintenance, 'tail_number');
  const gateEvByFlight = byId(gateEvents, 'flight_id');
  const passByPnr = new Map(passengers.map(p => [p.pnr, p]));

  // dataset time bounds
  const allTimes = flights.flatMap(f => [f._schedDep, f._actArr]).filter(Boolean).map(d => d.getTime());
  const MIN_T = Math.min(...allTimes), MAX_T = Math.max(...allTimes);

  // ---------- State ----------
  const state = {
    simTime: new Date(2024, 9, 22, 0, 0, 0), // busiest recorded day, midnight
    playing: false,
    speed: 60, // sim-minutes per real-second-ish (multiplier on 1s tick)
    tab: 'overview',
    flightSort: { key: '_schedDep', dir: 1 },
    flightFilter: { q: '', status: '', terminal: '' },
  };

  const GATES = [...new Set(flights.map(f => f.gate))].filter(Boolean).sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, '')) || 0, nb = parseInt(b.replace(/\D/g, '')) || 0;
    return na - nb;
  });

  // ---------- Derived flight status at a point in time ----------
  const BOARD_LEAD_MIN = 35, GATE_BUFFER_MIN = 20;
  function flightStatusAt(f, t) {
    const dep = f._actDep || f._schedDep, arr = f._actArr || f._schedArr;
    if (!dep || !arr) return { code: 'scheduled', label: 'Scheduled' };
    const boardStart = new Date(dep.getTime() - BOARD_LEAD_MIN * 60000);
    if (t < boardStart) return { code: 'scheduled', label: 'Scheduled' };
    if (t < dep) return { code: 'boarding', label: f.delay_min > 15 ? 'Boarding · Delayed' : 'Boarding' };
    if (t < arr) return { code: 'airborne', label: 'In Progress' };
    return { code: 'arrived', label: 'Completed' };
  }
  function severityOf(f) {
    if (f.delay_min >= 90) return 'critical';
    if (f.delay_min >= 45) return 'alert';
    if (f.delay_min >= 15) return 'attention';
    return 'nominal';
  }
  function gateWindow(f) {
    const dep = f._actDep || f._schedDep;
    return [new Date(dep.getTime() - GATE_BUFFER_MIN * 60000), new Date(dep.getTime() + GATE_BUFFER_MIN * 60000)];
  }

  // window of flights "around now" — used across overview/gates/alerts for performance
  function flightsNear(t, hoursBack = 6, hoursFwd = 10) {
    const lo = t.getTime() - hoursBack * 3600000, hi = t.getTime() + hoursFwd * 3600000;
    return flights.filter(f => {
      const dep = (f._actDep || f._schedDep); if (!dep) return false;
      return dep.getTime() >= lo && dep.getTime() <= hi;
    });
  }

  // ---------- Alert engine (cross-table) ----------
  function computeAlerts(t) {
    const alerts = [];
    const near = flightsNear(t, 4, 8);

    // 1. Severe delays
    for (const f of near) {
      if (f.delay_min >= 60 && flightStatusAt(f, t).code !== 'arrived') {
        alerts.push({
          sev: f.delay_min >= 90 ? 'critical' : 'alert',
          title: `${f.flight_id} delayed ${f.delay_min}m`,
          meta: `${f.origin}→${f.destination} · Gate ${f.gate} · ${f.delay_reason}`,
          type: 'flight', ref: f.flight_id,
        });
      }
    }

    // 2. Gate conflicts — two flights, same gate, overlapping turnaround windows
    const byGate = new Map();
    for (const f of near) { if (!byGate.has(f.gate)) byGate.set(f.gate, []); byGate.get(f.gate).push(f); }
    for (const [gate, list] of byGate) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const [as, ae] = gateWindow(list[i]), [bs, be] = gateWindow(list[j]);
        if (as < be && bs < ae) {
          alerts.push({
            sev: 'critical',
            title: `Gate ${gate} conflict`,
            meta: `${list[i].flight_id} × ${list[j].flight_id} overlapping turnaround`,
            type: 'gate', ref: gate,
          });
        }
      }
    }

    // 3. Grounding risk — aircraft with an open/overlapping maintenance work order before its next flight
    for (const f of near) {
      const wos = maintByTail.get(f.tail_number) || [];
      for (const wo of wos) {
        if (!wo._end) continue;
        const dep = f._schedDep;
        if (wo._start && wo._end && dep && wo._start <= dep && wo._end >= new Date(dep.getTime() - 60 * 60000) && wo._end > t) {
          alerts.push({
            sev: 'alert',
            title: `${f.tail_number} maintenance overlaps ${f.flight_id}`,
            meta: `${wo.defect_type} · WO ${wo.work_order_id} · est. clear ${fmtTime(wo._end)}`,
            type: 'flight', ref: f.flight_id,
          });
        }
      }
    }

    // 4. Security surge — average queue position for screenings entering near now
    const secWindow = security.filter(s => s._enter && Math.abs(s._enter - t) < 45 * 60000);
    if (secWindow.length >= 4) {
      const avgQ = secWindow.reduce((a, s) => a + (s.queue_position || 0), 0) / secWindow.length;
      if (avgQ >= 5) {
        alerts.push({
          sev: avgQ >= 6.5 ? 'critical' : 'alert',
          title: `Security queue surge`,
          meta: `Avg. position ${avgQ.toFixed(1)} across ${secWindow.length} passengers in window`,
          type: 'security', ref: null,
        });
      }
    }

    return alerts;
  }

  // ---------- Formatting ----------
  function fmtTime(d) { return d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'; }
  function fmtDate(d) { return d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
  function fmtDateTime(d) { return d ? `${fmtDate(d)} · ${fmtTime(d)}` : '—'; }
  function minsBetween(a, b) { return a && b ? Math.round((b - a) / 60000) : null; }
  function pillFor(sev, label) { return `<span class="pill ${sev}">${label}</span>`; }
  function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ================= RENDER: chrome (clock, kpis, gates, alerts) =================
  function renderClock() {
    document.getElementById('clockDate').textContent = state.simTime.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
    document.getElementById('clockTime').textContent = state.simTime.toLocaleTimeString('en-GB');
    document.getElementById('liveDot').classList.toggle('paused', !state.playing);
    const pct = ((state.simTime.getTime() - MIN_T) / (MAX_T - MIN_T)) * 1000;
    const range = document.getElementById('scrubRange');
    if (document.activeElement !== range) range.value = Math.max(0, Math.min(1000, pct));
  }

  function renderKPIs() {
    const near = flightsNear(state.simTime, 6, 10);
    const active = near.filter(f => { const s = flightStatusAt(f, state.simTime).code; return s === 'boarding' || s === 'airborne'; });
    const delayed = near.filter(f => f.delay_min >= 30);
    const secWindow = security.filter(s => s._enter && Math.abs(s._enter - state.simTime) < 45 * 60000);
    const avgWait = secWindow.length ? (secWindow.reduce((a, s) => a + (s.duration_sec || 0), 0) / secWindow.length / 60) : 0;
    const retailWindow = retail.filter(r => r._txn && Math.abs(r._txn - state.simTime) < 6 * 3600000);
    const revenue = retailWindow.reduce((a, r) => a + (r.amount || 0), 0);
    const alerts = computeAlerts(state.simTime);

    const kpis = [
      { label: 'Active Flights', value: active.length, sub: `of ${near.length} in ±window`, cls: '' },
      { label: 'Delayed ≥30m', value: delayed.length, sub: `${near.length ? Math.round(delayed.length / near.length * 100) : 0}% of window`, cls: delayed.length ? 'accent-orange' : 'accent-olive' },
      { label: 'Security Avg Wait', value: avgWait ? avgWait.toFixed(0) + 'm' : '—', sub: `${secWindow.length} screened nearby`, cls: avgWait > 25 ? 'accent-orange' : 'accent-olive' },
      { label: 'Gates Occupied', value: gatesState(state.simTime).filter(g => g.state !== 'idle').length + ' / ' + GATES.length, sub: 'Terminal 3', cls: '' },
      { label: 'Retail Revenue', value: '₹' + Math.round(revenue).toLocaleString('en-IN'), sub: '±6h window', cls: 'accent-gold' },
      { label: 'Open Alerts', value: alerts.length, sub: alerts.filter(a => a.sev === 'critical').length + ' critical', cls: alerts.length ? 'accent-orange' : 'accent-olive' },
    ];
    document.getElementById('kpiStrip').innerHTML = kpis.map(k => `
      <div class="kpi"><span class="label">${k.label}</span><span class="value mono ${k.cls}">${k.value}</span><span class="sub">${k.sub}</span></div>
    `).join('');
  }

  function gatesState(t) {
    const near = flightsNear(t, 3, 3);
    const byGate = new Map();
    for (const g of GATES) byGate.set(g, []);
    for (const f of near) { if (byGate.has(f.gate)) byGate.get(f.gate).push(f); }
    return GATES.map(g => {
      const list = byGate.get(g);
      let conflict = false;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const [as, ae] = gateWindow(list[i]), [bs, be] = gateWindow(list[j]);
        if (as < be && bs < ae) conflict = true;
      }
      let state_ = 'idle';
      const occ = list.find(f => { const [s, e] = gateWindow(f); return t >= s && t <= e; });
      if (conflict) state_ = 'conflict';
      else if (occ) { const st = flightStatusAt(occ, t).code; state_ = st === 'boarding' ? 'boarding' : 'occupied'; }
      return { gate: g, state: state_, flight: occ };
    });
  }

  function renderGates() {
    const gs = gatesState(state.simTime);
    document.getElementById('gateGrid').innerHTML = gs.map(g => `
      <div class="gate-cell" data-state="${g.state}" title="${g.gate}${g.flight ? ' · ' + g.flight.flight_id + ' ' + g.flight.origin + '→' + g.flight.destination : ' · idle'}">${g.gate.replace('B', '')}</div>
    `).join('');
  }

  function renderAlerts() {
    const alerts = computeAlerts(state.simTime).sort((a, b) => sevRank(b.sev) - sevRank(a.sev));
    document.getElementById('alertCount').textContent = `${alerts.length} open`;
    const feed = document.getElementById('alertFeed');
    if (!alerts.length) { feed.innerHTML = `<div class="alert-empty">No active incidents at this time.</div>`; return; }
    feed.innerHTML = alerts.slice(0, 12).map(a => `
      <div class="alert-item" data-type="${a.type}" data-ref="${esc(a.ref)}">
        <span class="alert-dot ${a.sev}"></span>
        <div class="alert-body"><div class="title">${esc(a.title)}</div><div class="meta">${esc(a.meta)}</div></div>
      </div>
    `).join('');
    feed.querySelectorAll('.alert-item').forEach(el => el.addEventListener('click', () => {
      if (el.dataset.type === 'flight') openFlightDrawer(el.dataset.ref);
    }));
  }
  function sevRank(s) { return { critical: 3, alert: 2, attention: 1, nominal: 0 }[s] || 0; }

  function renderChrome() { renderClock(); renderKPIs(); renderGates(); renderAlerts(); }

  // ================= TABS =================
  const TAB_RENDER = { overview: renderOverview, flights: renderFlights, trace: renderTrace, security: renderSecurity, staff: renderStaff, retail: renderRetail, maintenance: renderMaintenance };

  function renderTab() { TAB_RENDER[state.tab](document.getElementById('mainCol')); }

  // ---- Overview ----
  function renderOverview(el) {
    const near = flightsNear(state.simTime, 6, 10).sort((a, b) => a._schedDep - b._schedDep);
    const upcoming = near.filter(f => (f._actDep || f._schedDep) >= state.simTime).slice(0, 8);
    const byReason = {};
    for (const f of flights) if (f.delay_min > 0) byReason[f.delay_reason] = (byReason[f.delay_reason] || 0) + 1;
    const maxReason = Math.max(1, ...Object.values(byReason));

    el.innerHTML = `
      <div class="section-title">Airport-Wide Status</div>
      <div class="section-sub">Reconstructed from the provided flight, gate, security and maintenance tables as of the current simulated time. Scrub the timeline above to replay the operational day.</div>

      <div class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><h2>Next Departures</h2><span class="hint">Terminal 3</span></div>
        <div class="panel-body table-wrap">
          <table class="data"><thead><tr><th>Flight</th><th>Route</th><th>Sched.</th><th>Gate</th><th>Status</th></tr></thead>
          <tbody>${upcoming.map(f => rowFlightMini(f)).join('') || `<tr><td colspan="5" class="alert-empty">No departures in this window.</td></tr>`}</tbody></table>
        </div>
      </div>

      <div class="chart-row">
        <div class="panel">
          <div class="panel-header"><h2>Delay Reasons</h2><span class="hint">full dataset</span></div>
          <div class="panel-body">
            <div class="mini-bar-row">
              ${Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
                <div style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; height:100%;">
                  <div class="mini-bar ${v === maxReason ? 'hi' : ''}" style="height:${Math.max(4, v / maxReason * 66)}px;" title="${k}: ${v}"></div>
                  <div class="mini-bar-label">${k}</div>
                </div>`).join('')}
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Fleet Snapshot</h2><span class="hint">near now</span></div>
          <div class="panel-body">
            <div class="stat-row">
              <div class="stat-block"><div class="n mono">${near.length}</div><div class="l">Flights ±window</div></div>
              <div class="stat-block"><div class="n mono">${new Set(near.map(f => f.tail_number)).size}</div><div class="l">Distinct aircraft</div></div>
              <div class="stat-block"><div class="n mono">${near.reduce((a, f) => a + f.pax_count, 0).toLocaleString()}</div><div class="l">Passengers moved</div></div>
              <div class="stat-block"><div class="n mono">${(near.reduce((a, f) => a + f.otp_score, 0) / (near.length || 1)).toFixed(0)}</div><div class="l">Avg OTP score</div></div>
            </div>
          </div>
        </div>
      </div>
    `;
    el.querySelectorAll('[data-flight]').forEach(r => r.addEventListener('click', () => openFlightDrawer(r.dataset.flight)));
  }

  function rowFlightMini(f) {
    const s = flightStatusAt(f, state.simTime);
    const sev = severityOf(f);
    return `<tr data-flight="${f.flight_id}">
      <td><b>${f.flight_id}</b><br><span style="color:var(--ink-faint); font-size:10.5px;">${esc(f.airline)}</span></td>
      <td>${f.origin} → ${f.destination}</td>
      <td>${fmtTime(f._schedDep)}</td>
      <td>${f.gate}</td>
      <td>${pillFor(f.delay_min > 0 ? sev : 'nominal', f.delay_min > 0 ? `+${f.delay_min}m` : s.label)}</td>
    </tr>`;
  }

  // ---- Flights tab ----
  function renderFlights(el) {
    el.innerHTML = `
      <div class="section-title">Flight Board</div>
      <div class="section-sub">All ${flights.length} scheduled movements in the dataset. Filter, sort and open any row for the full cross-table detail view.</div>
      <div class="toolbar">
        <input class="input" id="flQ" placeholder="Search flight, airline, route, aircraft…" value="${esc(state.flightFilter.q)}">
        <select class="select" id="flStatus">
          <option value="">All conditions</option>
          <option value="ontime">On-time (&lt;15m)</option>
          <option value="attention">Attention (15–44m)</option>
          <option value="alert">Alert (45–89m)</option>
          <option value="critical">Critical (90m+)</option>
        </select>
        <select class="select" id="flType">
          <option value="">All routes</option>
          <option value="Domestic">Domestic</option>
          <option value="Long-Haul Intl">Long-Haul Intl</option>
        </select>
      </div>
      <div class="panel"><div class="panel-body table-wrap" style="max-height:62vh; overflow-y:auto;">
        <table class="data"><thead><tr>
          <th data-k="flight_id">Flight</th><th>Airline</th><th>Route</th><th data-k="_schedDep">Sched. Dep</th>
          <th>Aircraft</th><th>Gate</th><th data-k="delay_min">Delay</th><th>Reason</th><th>Condition</th>
        </tr></thead><tbody id="flightsBody"></tbody></table>
      </div></div>
    `;
    document.getElementById('flQ').value = state.flightFilter.q;
    document.getElementById('flStatus').value = state.flightFilter.status;
    document.getElementById('flType').value = state.flightFilter.terminal;
    document.getElementById('flQ').addEventListener('input', e => { state.flightFilter.q = e.target.value; drawFlightsBody(); });
    document.getElementById('flStatus').addEventListener('change', e => { state.flightFilter.status = e.target.value; drawFlightsBody(); });
    document.getElementById('flType').addEventListener('change', e => { state.flightFilter.terminal = e.target.value; drawFlightsBody(); });
    el.querySelectorAll('th[data-k]').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.k;
      state.flightSort.dir = state.flightSort.key === k ? -state.flightSort.dir : 1;
      state.flightSort.key = k; drawFlightsBody();
    }));
    drawFlightsBody();
  }

  function drawFlightsBody() {
    const body = document.getElementById('flightsBody'); if (!body) return;
    const { q, status, terminal } = state.flightFilter;
    const ql = q.trim().toLowerCase();
    let rows = flights.filter(f => {
      if (ql && !(`${f.flight_id} ${f.airline} ${f.origin} ${f.destination} ${f.aircraft_type} ${f.tail_number}`.toLowerCase().includes(ql))) return false;
      if (status) { const sev = severityOf(f); const map = { ontime: 'nominal', attention: 'attention', alert: 'alert', critical: 'critical' }; if (sev !== map[status]) return false; }
      if (terminal && f.flight_type !== terminal) return false;
      return true;
    });
    const { key, dir } = state.flightSort;
    rows = rows.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * dir);
    body.innerHTML = rows.slice(0, 250).map(f => `
      <tr data-flight="${f.flight_id}">
        <td><b>${f.flight_id}</b></td>
        <td>${esc(f.airline)}</td>
        <td>${f.origin} → ${f.destination}</td>
        <td>${fmtDateTime(f._schedDep)}</td>
        <td>${f.aircraft_type} <span style="color:var(--ink-faint)">${f.tail_number}</span></td>
        <td>${f.gate}</td>
        <td>${f.delay_min > 0 ? '+' + f.delay_min + 'm' : '—'}</td>
        <td>${f.delay_min > 0 ? esc(f.delay_reason) : '—'}</td>
        <td>${pillFor(severityOf(f), severityOf(f) === 'nominal' ? 'Nominal' : severityOf(f))}</td>
      </tr>`).join('') || `<tr><td colspan="9" class="alert-empty">No flights match these filters.</td></tr>`;
    body.querySelectorAll('tr[data-flight]').forEach(r => r.addEventListener('click', () => openFlightDrawer(r.dataset.flight)));
  }

  // ---- Passenger trace tab ----
  function renderTrace(el) {
    const samplePnrs = passengers.slice(0, 6).map(p => p.pnr);
    el.innerHTML = `
      <div class="trace-hero">
        <h2 class="serif">Trace a passenger's journey</h2>
        <p>Enter a PNR to assemble one connected story from four tables — check-in, security screening, gate boarding and baggage handling — the way an operator would trace a single passenger end-to-end.</p>
        <form class="trace-form" id="traceForm">
          <input class="input mono" id="traceInput" placeholder="e.g. ${samplePnrs[0]}" autocomplete="off">
          <button class="btn-primary" type="submit">Trace</button>
        </form>
        <div style="margin-top:14px;">
          ${samplePnrs.map(p => `<button class="trace-chip" data-pnr="${p}" type="button">${p}</button>`).join('')}
        </div>
      </div>
      <div id="traceResult"></div>
    `;
    const run = (pnr) => { document.getElementById('traceInput').value = pnr; drawTrace(pnr); };
    el.querySelectorAll('.trace-chip').forEach(c => c.addEventListener('click', () => run(c.dataset.pnr)));
    document.getElementById('traceForm').addEventListener('submit', e => { e.preventDefault(); run(document.getElementById('traceInput').value.trim().toUpperCase()); });
  }

  function drawTrace(pnr) {
    const out = document.getElementById('traceResult');
    const p = passByPnr.get(pnr);
    if (!p) { out.innerHTML = `<div class="empty-state"><div class="big serif">No passenger found</div>Check the PNR and try again.</div>`; return; }
    const f = flightById.get(p.flight_id);
    const sec = (secByPnr.get(pnr) || [])[0];
    const bags = bagByPnr.get(pnr) || [];
    const txns = retail.filter(r => r.flight_id === p.flight_id && false); // placeholder, replaced below by passport join
    const purchases = retailByPassport.get(p.pnr) || []; // fallback if no passport match

    const steps = [];
    if (p._checkin) steps.push({ icon: '01', stage: 'Check-in', detail: `Seat ${p.seat} · ${p.cabin_class} · ${f ? f.flight_id : p.flight_id}`, time: fmtDateTime(p._checkin) });
    if (sec && sec._enter) steps.push({ icon: '02', stage: 'Security Screening', detail: `Lane ${sec.lane} · Queue position ${sec.queue_position} · Outcome: ${sec.outcome}`, time: `${fmtTime(sec._enter)} → ${fmtTime(sec._clear)} (${minsBetween(sec._enter, sec._clear)}m)` });
    if (bags.length) bags.forEach(b => steps.push({ icon: '03', stage: 'Baggage', detail: `Tag ${b.bag_tag} · ${b.weight_kg.toFixed(1)}kg · ${b.bag_status} at ${b.current_location}`, time: fmtDateTime(b._checkin) }));
    if (p._boarding) steps.push({ icon: '04', stage: 'Gate Boarding', detail: `Gate ${p.gate}${f ? ' · ' + f.origin + ' → ' + f.destination : ''}`, time: fmtDateTime(p._boarding) });

    out.innerHTML = `
      <div class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><h2>${esc(p.first_name)} ${esc(p.last_name)}</h2><span class="hint mono">${p.pnr}</span></div>
        <div class="panel-body">
          <div class="kv-grid" style="margin-bottom:18px;">
            <div class="kv"><span class="k">Nationality</span><span class="v">${esc(p.nationality)}</span></div>
            <div class="kv"><span class="k">Age / Group</span><span class="v">${p.age} · ${esc(p.age_group)}</span></div>
            <div class="kv"><span class="k">Flight</span><span class="v">${f ? f.flight_id + ' (' + f.origin + '→' + f.destination + ')' : p.flight_id}</span></div>
            <div class="kv"><span class="k">Cabin / Fare</span><span class="v">${esc(p.cabin_class)} / ${esc(p.fare_class)}</span></div>
            <div class="kv"><span class="k">Frequent Flyer</span><span class="v">${p.frequent_flyer ? 'Yes' : 'No'}</span></div>
            <div class="kv"><span class="k">Seat / Gate</span><span class="v">${p.seat} / ${p.gate}</span></div>
          </div>
          <h4 style="font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink-faint); margin-bottom:12px;">Journey Timeline</h4>
          ${steps.sort((a, b) => a.icon.localeCompare(b.icon)).map(s => `
            <div class="journey-step">
              <div class="journey-dot mono">${s.icon}</div>
              <div class="journey-content"><div class="stage">${s.stage}</div><div class="detail">${s.detail}</div><div class="time">${s.time}</div></div>
            </div>`).join('') || `<div class="alert-empty">No further records linked to this PNR.</div>`}
        </div>
      </div>
      ${f ? `<button class="btn-primary" id="traceOpenFlight" style="margin-bottom:20px;">View full flight detail →</button>` : ''}
    `;
    const btn = document.getElementById('traceOpenFlight');
    if (btn) btn.addEventListener('click', () => openFlightDrawer(f.flight_id));
  }

  // ---- Security tab ----
  function renderSecurity(el) {
    const buckets = Array.from({ length: 8 }, (_, i) => i + 1).map(qp => security.filter(s => s.queue_position === qp).length);
    const maxB = Math.max(1, ...buckets);
    const avgDur = security.reduce((a, s) => a + (s.duration_sec || 0), 0) / security.length / 60;
    const alarms = security.filter(s => s.alarm_triggered).length;
    el.innerHTML = `
      <div class="section-title">Security Screening</div>
      <div class="section-sub">${security.length.toLocaleString()} passenger screenings recorded across all lanes.</div>
      <div class="chart-row" style="margin-bottom:16px;">
        <div class="panel"><div class="panel-header"><h2>Queue Position Distribution</h2></div><div class="panel-body">
          <div class="mini-bar-row">${buckets.map((v, i) => `<div style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; height:100%;"><div class="mini-bar ${v === maxB ? 'hi' : ''}" style="height:${Math.max(4, v / maxB * 66)}px"></div><div class="mini-bar-label">${i + 1}</div></div>`).join('')}</div>
        </div></div>
        <div class="panel"><div class="panel-header"><h2>Throughput Summary</h2></div><div class="panel-body">
          <div class="stat-row">
            <div class="stat-block"><div class="n mono">${avgDur.toFixed(1)}m</div><div class="l">Avg. duration</div></div>
            <div class="stat-block"><div class="n mono">${alarms}</div><div class="l">Alarms triggered</div></div>
            <div class="stat-block"><div class="n mono">${security.filter(s => s.outcome !== 'Clear').length}</div><div class="l">Non-clear outcomes</div></div>
          </div>
        </div></div>
      </div>
      <div class="panel"><div class="panel-header"><h2>Recent Screenings near current time</h2></div>
        <div class="panel-body table-wrap" style="max-height:44vh; overflow-y:auto;">
          <table class="data"><thead><tr><th>ID</th><th>PNR</th><th>Lane</th><th>Queue Pos.</th><th>Wait</th><th>Outcome</th></tr></thead>
          <tbody>${security.filter(s => s._enter && Math.abs(s._enter - state.simTime) < 3 * 3600000).slice(0, 60).map(s => `
            <tr><td>${s.screening_id}</td><td class="mono">${s.pnr}</td><td>${s.lane}</td><td>${s.queue_position}</td><td>${minsBetween(s._enter, s._clear)}m</td><td>${pillFor(s.outcome === 'Clear' ? 'nominal' : 'attention', s.outcome)}</td></tr>
          `).join('') || `<tr><td colspan="6" class="alert-empty">No screenings in this window — try scrubbing the timeline.</td></tr>`}</tbody></table>
        </div>
      </div>
    `;
  }

  // ---- Staff tab ----
  function renderStaff(el) {
    const onShift = staff.filter(s => s._start && s._end && state.simTime >= s._start && state.simTime <= s._end);
    const byDept = {}; for (const s of staff) byDept[s.department] = (byDept[s.department] || 0) + 1;
    el.innerHTML = `
      <div class="section-title">Workforce</div>
      <div class="section-sub">${staff.length.toLocaleString()} shift records. ${onShift.length} staff currently on shift at the simulated time.</div>
      <div class="panel"><div class="panel-header"><h2>On Shift Now</h2><span class="hint mono">${fmtTime(state.simTime)}</span></div>
        <div class="panel-body table-wrap" style="max-height:56vh; overflow-y:auto;">
          <table class="data"><thead><tr><th>Staff</th><th>Role</th><th>Terminal / Gate</th><th>Shift</th><th>Hours</th><th>OT</th></tr></thead>
          <tbody>${onShift.slice(0, 100).map(s => `
            <tr><td>${esc(s.staff_name)}<br><span style="color:var(--ink-faint); font-size:10.5px;">${s.staff_id}</span></td><td>${esc(s.role)}</td><td>${s.terminal} / ${s.gate}</td><td>${fmtTime(s._start)}–${fmtTime(s._end)}</td><td>${s.shift_hours}h</td><td>${s.is_overtime ? pillFor('attention', 'OT') : '—'}</td></tr>
          `).join('') || `<tr><td colspan="6" class="alert-empty">Nobody on shift in this window — try scrubbing the timeline.</td></tr>`}</tbody></table>
        </div>
      </div>
    `;
  }

  // ---- Retail tab ----
  function renderRetail(el) {
    const window_ = retail.filter(r => r._txn && Math.abs(r._txn - state.simTime) < 12 * 3600000);
    const revenue = window_.reduce((a, r) => a + r.amount, 0);
    const totalRevenue = retail.reduce((a, r) => a + r.amount, 0);
    el.innerHTML = `
      <div class="section-title">Retail &amp; Concessions</div>
      <div class="section-sub">${retail.length.toLocaleString()} transactions logged across duty-free outlets, joined here to flights via passenger records.</div>
      <div class="stat-row" style="margin-bottom:16px;">
        <div class="panel-body panel" style="padding:16px; flex:1;"><div class="stat-block"><div class="n mono">₹${Math.round(totalRevenue).toLocaleString('en-IN')}</div><div class="l">Total revenue (dataset)</div></div></div>
        <div class="panel-body panel" style="padding:16px; flex:1;"><div class="stat-block"><div class="n mono">₹${Math.round(revenue).toLocaleString('en-IN')}</div><div class="l">±12h of current time</div></div></div>
        <div class="panel-body panel" style="padding:16px; flex:1;"><div class="stat-block"><div class="n mono">₹${(totalRevenue / retail.length).toFixed(0)}</div><div class="l">Avg. transaction</div></div></div>
      </div>
      <div class="panel"><div class="panel-header"><h2>Transactions near current time</h2></div>
        <div class="panel-body table-wrap" style="max-height:50vh; overflow-y:auto;">
          <table class="data"><thead><tr><th>Txn</th><th>Flight</th><th>Item</th><th>Qty</th><th>Amount</th><th>Time</th></tr></thead>
          <tbody>${window_.slice(0, 80).map(r => `<tr data-flight="${r.flight_id}"><td>${r.txn_id.split('-')[0]}</td><td>${r.flight_id}</td><td>${esc(r.item)}</td><td>${r.quantity}</td><td>₹${r.amount}</td><td>${fmtTime(r._txn)}</td></tr>`).join('') || `<tr><td colspan="6" class="alert-empty">No transactions in this window.</td></tr>`}</tbody></table>
        </div>
      </div>
    `;
    el.querySelectorAll('[data-flight]').forEach(r => r.addEventListener('click', () => openFlightDrawer(r.dataset.flight)));
  }

  // ---- Maintenance tab ----
  function renderMaintenance(el) {
    const open = maintenance.filter(m => m._end && m._end > state.simTime && m._start && m._start <= state.simTime);
    el.innerHTML = `
      <div class="section-title">Maintenance &amp; Engineering</div>
      <div class="section-sub">${maintenance.length.toLocaleString()} work orders. ${open.length} currently open at the simulated time — cross-checked against upcoming flights for that tail number in the incident feed.</div>
      <div class="panel"><div class="panel-header"><h2>Work Orders</h2><span class="hint">most recent first</span></div>
        <div class="panel-body table-wrap" style="max-height:60vh; overflow-y:auto;">
          <table class="data"><thead><tr><th>WO</th><th>Tail</th><th>Type</th><th>Defect</th><th>Window</th><th>Downtime</th><th>Status</th></tr></thead>
          <tbody>${[...maintenance].sort((a, b) => b._start - a._start).slice(0, 100).map(m => {
      const isOpenNow = m._end && m._end > state.simTime && m._start <= state.simTime;
      return `<tr><td>${m.work_order_id}</td><td class="mono">${m.tail_number}</td><td>${esc(m.maint_type)}</td><td>${esc(m.defect_type)}</td><td>${fmtDate(m._start)}</td><td>${m.downtime_hours}h</td><td>${isOpenNow ? pillFor('attention', 'Open') : pillFor('nominal', 'Closed')}</td></tr>`;
    }).join('')}</tbody></table>
        </div>
      </div>
    `;
  }

  // ================= Flight detail drawer =================
  function openFlightDrawer(flightId) {
    const f = flightById.get(flightId); if (!f) return;
    const pax = passByFlight.get(flightId) || [];
    const bags = bagByFlight.get(flightId) || [];
    const gEvents = gateEvByFlight.get(flightId) || [];
    const wos = maintByTail.get(f.tail_number) || [];
    const classSplit = pax.reduce((m, p) => (m[p.cabin_class] = (m[p.cabin_class] || 0) + 1, m), {});
    const totalWeight = bags.reduce((a, b) => a + (b.weight_kg || 0), 0);
    const sev = severityOf(f);

    document.getElementById('drawerTitle').textContent = `${f.flight_id} · ${f.origin} → ${f.destination}`;
    document.getElementById('drawerSub').textContent = `${f.airline} · ${f.aircraft_type} (${f.tail_number}) · ${fmtDate(f._schedDep)}`;
    document.getElementById('drawerBody').innerHTML = `
      <div class="drawer-section">
        <h4>Status</h4>
        <div style="margin-bottom:12px;">${pillFor(sev, sev === 'nominal' ? 'On schedule' : (f.delay_min + 'm delay · ' + sev))} ${pillFor('neutral', flightStatusAt(f, state.simTime).label)}</div>
        <div class="kv-grid">
          <div class="kv"><span class="k">Scheduled Dep.</span><span class="v">${fmtDateTime(f._schedDep)}</span></div>
          <div class="kv"><span class="k">Actual Dep.</span><span class="v">${fmtDateTime(f._actDep)}</span></div>
          <div class="kv"><span class="k">Scheduled Arr.</span><span class="v">${fmtDateTime(f._schedArr)}</span></div>
          <div class="kv"><span class="k">Gate / Terminal</span><span class="v">${f.gate} / ${f.terminal}</span></div>
          <div class="kv"><span class="k">Delay Reason</span><span class="v">${f.delay_min > 0 ? esc(f.delay_reason) : '—'}</span></div>
          <div class="kv"><span class="k">OTP Score</span><span class="v">${f.otp_score.toFixed(1)}</span></div>
        </div>
      </div>

      <div class="drawer-section">
        <h4>Passengers (${pax.length} / cap. ${f.capacity})</h4>
        <div class="kv-grid">
          ${Object.entries(classSplit).map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') || '<div class="kv"><span class="v">No linked passenger records</span></div>'}
        </div>
      </div>

      <div class="drawer-section">
        <h4>Baggage (${bags.length} bags · ${totalWeight.toFixed(0)}kg total)</h4>
        ${bags.slice(0, 5).map(b => `<div class="kv" style="margin-bottom:6px;"><span class="k">${b.bag_tag}</span><span class="v">${b.weight_kg.toFixed(1)}kg · ${b.bag_status} @ ${b.current_location}</span></div>`).join('') || '<div class="alert-empty">No linked baggage records.</div>'}
      </div>

      <div class="drawer-section">
        <h4>Gate Activity</h4>
        ${gEvents.slice(0, 5).map(g => `<div class="kv" style="margin-bottom:6px;"><span class="k">${fmtTime(g._t)}</span><span class="v">${esc(g.event_type)} · Gate ${g.gate}</span></div>`).join('') || '<div class="alert-empty">No linked gate events.</div>'}
      </div>

      <div class="drawer-section">
        <h4>Aircraft Maintenance History (${f.tail_number})</h4>
        ${wos.slice(0, 4).map(w => `<div class="kv" style="margin-bottom:6px;"><span class="k">${fmtDate(w._start)}</span><span class="v">${esc(w.maint_type)} · ${esc(w.defect_type)} · ${w.downtime_hours}h downtime</span></div>`).join('') || '<div class="alert-empty">No maintenance history for this tail number.</div>'}
      </div>
    `;
    document.getElementById('drawer').classList.add('is-open');
    document.getElementById('drawerScrim').classList.add('is-open');
  }
  function closeDrawer() {
    document.getElementById('drawer').classList.remove('is-open');
    document.getElementById('drawerScrim').classList.remove('is-open');
  }

  // ================= Wiring =================
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  document.getElementById('drawerScrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

  document.getElementById('tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn'); if (!btn) return;
    state.tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-selected', b === btn ? 'true' : 'false'); });
    renderTab();
  });

  const btnPlay = document.getElementById('btnPlay');
  btnPlay.addEventListener('click', () => { state.playing = !state.playing; btnPlay.textContent = state.playing ? '❚❚' : '▶'; btnPlay.classList.toggle('is-active', state.playing); renderClock(); });
  document.addEventListener('keydown', e => { if (e.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); btnPlay.click(); } });

  document.getElementById('btnReset').addEventListener('click', () => { state.simTime = new Date(2024, 9, 22, 6, 0, 0); tick(true); });

  document.querySelectorAll('.speed-btn').forEach(b => b.addEventListener('click', () => {
    state.speed = parseInt(b.dataset.speed, 10);
    document.querySelectorAll('.speed-btn').forEach(x => x.classList.toggle('is-active', x === b));
  }));

  const scrubRange = document.getElementById('scrubRange');
  scrubRange.addEventListener('input', () => {
    const pct = scrubRange.value / 1000;
    state.simTime = new Date(MIN_T + pct * (MAX_T - MIN_T));
    tick(true);
  });

  function tick(force) {
    renderChrome();
    if (force || state.tab !== 'flights') { /* flights tab keeps its own filtered body via drawFlightsBody, others re-render fully */ }
    renderTab();
  }

  let lastTs = performance.now();
  function loop(ts) {
    const dtSec = (ts - lastTs) / 1000; lastTs = ts;
    if (state.playing) {
      state.simTime = new Date(state.simTime.getTime() + dtSec * state.speed * 60000 / 60);
      if (state.simTime.getTime() > MAX_T) state.simTime = new Date(MIN_T);
      renderChrome();
      if (state.tab === 'flights') drawFlightsBody(); else renderTab();
    }
    requestAnimationFrame(loop);
  }

  // ---------- Init ----------
  tick(true);
  requestAnimationFrame(loop);
})();
