/* Tick Chart — application: chart, replay, paper trading, UI. */
(function () {
  'use strict';
  const LWC = LightweightCharts;
  const D = TickData;
  const $ = id => document.getElementById(id);

  // ====================================================================
  // Settings
  // ====================================================================
  const DEFAULTS = {
    tickSize: 50, countMode: 'all', syncDay: true, daySep: true, askLine: true,
    ma1: { on: true, type: 'EMA', period: 9, color: '#22c55e', width: 1 },
    ma2: { on: true, type: 'EMA', period: 21, color: '#ff2a2a', width: 2 },
    cpr: { on: true, showRS: true, colP: '#facc15', colCPR: '#22c55e', colR: '#ef5350', colS: '#42a5f5', narrowPct: 0.15, widePct: 0.35 },
    firstHLC: { h: 0, l: 0, c: 0 },
    trade: { lots: 1, balance: 10000, slPts: 0, tpPts: 0 },
    vppBySymbol: {}, curBySymbol: {},
    speedMode: 'tick', speeds: { tick: 50, candle: 2, time: 10 }
  };
  const SPEEDS = {
    tick: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    candle: [0.25, 0.5, 1, 2, 3, 5, 10, 20, 50],
    time: [1, 2, 5, 10, 30, 60, 120, 300]
  };
  function merge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(over)) {
      out[k] = (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) ? merge(base[k], over[k]) : over[k];
    }
    return out;
  }
  let S = DEFAULTS;
  try { S = merge(DEFAULTS, JSON.parse(localStorage.getItem('tickchart.settings') || '{}')); } catch (e) { S = merge(DEFAULTS, {}); }
  function saveSettings() { try { localStorage.setItem('tickchart.settings', JSON.stringify(S)); } catch (e) { /* ignore */ } }

  // ====================================================================
  // State
  // ====================================================================
  let ticks = null, days = [], dayIndex = new Map(), cprMap = new Map();
  let C = null;            // candles
  let cDay = null;         // day number per candle
  let ma1 = null, ma2 = null;
  const R = { active: false, picking: false, cursor: -1, playing: false, shownCi: -1, raf: 0, acc: 0, simT: 0, lastTs: 0 };
  const TR = { balance: S.trade.balance, positions: [], orders: [], history: [], nextId: 1, placing: null };

  const symbolKey = () => (ticks ? ticks.symbol.replace(/\s*\(demo\)/, '').toUpperCase() : '');
  function vpp() {
    const k = symbolKey();
    if (S.vppBySymbol[k] !== undefined) return +S.vppBySymbol[k];
    return /XAU/.test(k) ? 100 : 1;
  }
  function currency() {
    const k = symbolKey();
    if (S.curBySymbol[k]) return S.curBySymbol[k];
    return /XAU|USD$|US30|NAS|SPX/.test(k) ? 'USD' : 'EUR';
  }
  const digits = () => (ticks ? ticks.digits : 2);
  const fmtP = p => (p == null || !isFinite(p)) ? '—' : p.toFixed(digits());
  const roundP = p => { const f = Math.pow(10, digits()); return Math.round(p * f) / f; };

  // ====================================================================
  // Time formatting (server time stored as UTC ms)
  // ====================================================================
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function fmtShort(ms) { const d = new Date(ms); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  function fmtFull(ms) { const d = new Date(ms); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
  function fmtIso(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`; }
  function toInputValue(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
  function fromInputValue(v) {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN;
  }

  // ====================================================================
  // Chart
  // ====================================================================
  const chartEl = $('chart');
  const chart = LWC.createChart(chartEl, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#000000' }, textColor: '#cfd2d8', fontSize: 11, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: '#6b7080', labelBackgroundColor: '#3a3e47' }, horzLine: { color: '#6b7080', labelBackgroundColor: '#3a3e47' } },
    rightPriceScale: { borderColor: '#5a5e68', scaleMargins: { top: 0.08, bottom: 0.06 } },
    timeScale: {
      borderColor: '#5a5e68', rightOffset: 10, barSpacing: 7, minBarSpacing: 0.5,
      tickMarkMaxCharacterLength: 13,
      tickMarkFormatter: (time) => (C && time >= 0 && time < C.n) ? fmtShort(C.t[time]) : ''
    },
    localization: {
      timeFormatter: (time) => (C && time >= 0 && time < C.n) ? fmtFull(C.t[time]) : '',
      priceFormatter: (p) => p.toFixed(digits())
    },
    handleScale: { axisPressedMouseMove: { time: true, price: true } }
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#00e600', downColor: '#ff1a1a', wickUpColor: '#00e600', wickDownColor: '#ff1a1a', borderVisible: false,
    priceLineColor: '#8a93a6', priceLineWidth: 1, priceLineStyle: LWC.LineStyle.Solid
  });
  const lineOpts = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
  const ma1Series = chart.addLineSeries({ ...lineOpts });
  const ma2Series = chart.addLineSeries({ ...lineOpts });
  const CPR_KEYS = ['R3', 'R2', 'R1', 'TC', 'P', 'BC', 'S1', 'S2', 'S3'];
  const cprSeries = {};
  CPR_KEYS.forEach(k => { cprSeries[k] = chart.addLineSeries({ ...lineOpts, lineWidth: 1, title: '', autoscaleInfoProvider: () => null }); });

  function applySeriesStyles() {
    ma1Series.applyOptions({ color: S.ma1.color, lineWidth: +S.ma1.width, visible: !!S.ma1.on });
    ma2Series.applyOptions({ color: S.ma2.color, lineWidth: +S.ma2.width, visible: !!S.ma2.on });
    CPR_KEYS.forEach(k => {
      const isRS = k[0] === 'R' || k[0] === 'S';
      const color = k === 'P' ? S.cpr.colP : (k === 'TC' || k === 'BC') ? S.cpr.colCPR : k[0] === 'R' ? S.cpr.colR : S.cpr.colS;
      cprSeries[k].applyOptions({
        color, lineWidth: k === 'P' ? 2 : 1,
        lineStyle: isRS ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid,
        visible: !!S.cpr.on && (!isRS || !!S.cpr.showRS),
        lastValueVisible: true, title: k
      });
    });
    const pf = { type: 'price', precision: digits(), minMove: 1 / Math.pow(10, digits()) };
    [candleSeries, ma1Series, ma2Series, ...Object.values(cprSeries)].forEach(s => s.applyOptions({ priceFormat: pf }));
  }

  // ====================================================================
  // Building / rendering
  // ====================================================================
  function rebuildCandles() {
    if (!ticks) return;
    C = D.buildCandles(ticks, Math.max(2, +S.tickSize | 0), S.countMode, S.syncDay);
    cDay = new Int32Array(C.n);
    for (let i = 0; i < C.n; i++) cDay[i] = Math.floor(C.t[i] / D.DAY_MS);
    rebuildMAs();
    $('titleSym').textContent = `${ticks.symbol}.Tick.${C.size}`;
  }
  function rebuildMAs() {
    if (!C) return;
    ma1 = D.computeMA(S.ma1.type, Math.max(1, +S.ma1.period | 0), C.c, C.n);
    ma2 = D.computeMA(S.ma2.type, Math.max(1, +S.ma2.period | 0), C.c, C.n);
  }
  function rebuildCPR() {
    days = D.buildDays(ticks);
    dayIndex = new Map(days.map((d, i) => [d.day, i]));
    cprMap = D.buildCPR(days, S.firstHLC);
  }

  function fullBar(i) { return { time: i, open: C.o[i], high: C.h[i], low: C.l[i], close: C.c[i] }; }
  function formingBar(i, cursor) {
    const B = ticks.bid; const s = C.start[i];
    let o = B[s], h = o, l = o, c = o;
    for (let k = s + 1; k <= cursor; k++) { const p = B[k]; if (p > h) h = p; if (p < l) l = p; c = p; }
    return { time: i, open: o, high: h, low: l, close: c };
  }
  function maPoint(which, i, bar, final) {
    const cfg = which === 1 ? S.ma1 : S.ma2, arr = which === 1 ? ma1 : ma2;
    const v = final ? arr[i] : D.maLive(cfg.type, Math.max(1, +cfg.period | 0), arr, C.c, i, bar.close);
    return isFinite(v) ? { time: i, value: v } : { time: i };
  }
  function cprPoint(key, i) {
    const lv = cprMap.get(cDay[i]);
    if (!lv) return { time: i };
    // The segment i -> i+1 takes the colour of point i: hide the join between days.
    if (i + 1 < C.n && cDay[i + 1] !== cDay[i]) return { time: i, value: lv[key], color: 'transparent' };
    return { time: i, value: lv[key] };
  }

  // Show candles up to candle ci (whose bar is `bar`).
  function setAll(ci, bar, final) {
    const bars = new Array(ci + 1), m1 = new Array(ci + 1), m2 = new Array(ci + 1);
    const cp = {}; CPR_KEYS.forEach(k => cp[k] = new Array(ci + 1));
    for (let i = 0; i <= ci; i++) {
      const b = i === ci ? bar : fullBar(i);
      const fin = i < ci || final;
      bars[i] = b; m1[i] = maPoint(1, i, b, fin); m2[i] = maPoint(2, i, b, fin);
      for (const k of CPR_KEYS) cp[k][i] = cprPoint(k, i);
    }
    candleSeries.setData(bars); ma1Series.setData(m1); ma2Series.setData(m2);
    for (const k of CPR_KEYS) cprSeries[k].setData(cp[k]);
  }
  function updateOne(i, bar, final) {
    candleSeries.update(bar);
    ma1Series.update(maPoint(1, i, bar, final));
    ma2Series.update(maPoint(2, i, bar, final));
    for (const k of CPR_KEYS) cprSeries[k].update(cprPoint(k, i));
  }

  // Render everything visible up to tick `cursor` (replay), or the whole history.
  function render(force) {
    if (!C) return;
    if (!R.active) {
      if (force || R.shownCi !== C.n - 1) { setAll(C.n - 1, fullBar(C.n - 1), true); }
      R.shownCi = C.n - 1;
    } else {
      const cur = R.cursor;
      const ci = D.candleOfTick(C, cur);
      const final = cur >= C.end[ci];
      const bar = final ? fullBar(ci) : formingBar(ci, cur);
      if (force || R.shownCi < 0 || ci < R.shownCi || ci - R.shownCi > 400) setAll(ci, bar, final);
      else { for (let k = R.shownCi; k < ci; k++) updateOne(k, fullBar(k), true); updateOne(ci, bar, final); }
      R.shownCi = ci;
    }
    refreshMarkers();
    syncLines();
    scheduleUI();
  }

  // ====================================================================
  // Overlays: info panel, legend, day separators, status
  // ====================================================================
  let uiPending = false;
  function scheduleUI() { if (!uiPending) { uiPending = true; requestAnimationFrame(() => { uiPending = false; drawUI(); }); } }
  function drawUI() { drawInfo(); drawDaySeps(); drawOneClick(); drawTables(); drawStatus(); }

  function currentTick() { return R.active ? R.cursor : (ticks ? ticks.n - 1 : -1); }

  function cprRelation(cur, prev) {
    if (!prev) return null;
    if (cur.BC > prev.TC) return ['Higher Value', 'bullish', 'g'];
    if (cur.TC < prev.BC) return ['Lower Value', 'bearish', 'r'];
    if (cur.TC <= prev.TC && cur.BC >= prev.BC) return ['Inside Value', 'breakout?', 'o'];
    if (cur.TC >= prev.TC && cur.BC <= prev.BC) return ['Outside Value', 'sideways', 'o'];
    if (cur.P > prev.P) return ['Overlapping Higher', 'mild bullish', 'g'];
    return ['Overlapping Lower', 'mild bearish', 'r'];
  }
  function drawInfo() {
    const el = $('infoPanel');
    if (!C || !S.cpr.on) { el.innerHTML = ''; return; }
    const t = currentTick();
    const day = Math.floor(ticks.t[t] / D.DAY_MS);
    const lv = cprMap.get(day);
    const di = dayIndex.get(day);
    const prevLv = di > 0 ? cprMap.get(days[di - 1].day) : null;
    const price = ticks.bid[t];
    const L = [];
    L.push(`<span class="w">CPR + Pivots  [Daily / Floor]</span>`);
    if (!lv) {
      L.push(`<span class="m">No CPR for this day (no previous day loaded).</span>`);
      L.push(`<span class="m">Export one extra day or enter H/L/C in Settings.</span>`);
    } else {
      L.push(`<span class="w">P ${fmtP(lv.P)}   TC ${fmtP(lv.TC)}   BC ${fmtP(lv.BC)}</span>`);
      const w = lv.TC - lv.BC, wp = w / lv.P * 100;
      const cls = wp < S.cpr.narrowPct ? ['NARROW -> trend day', 'g'] : wp > S.cpr.widePct ? ['WIDE -> range day', 'o'] : ['NORMAL', 'w'];
      L.push(`<span class="${cls[1]}">CPR width: ${w.toFixed(digits())} pts (${wp.toFixed(2)}%)  ${cls[0]}</span>`);
      const pos = price > lv.TC ? ['ABOVE CPR (bullish)', 'g'] : price < lv.BC ? ['BELOW CPR (bearish)', 'r'] : ['INSIDE CPR (neutral)', 'o'];
      L.push(`<span class="${pos[1]}">Price: ${pos[0]}</span>`);
      const rel = cprRelation(lv, prevLv);
      if (rel) L.push(`<span class="${rel[2]}">Vs prev CPR: ${rel[0]}  (${rel[1]})</span>`);
      if (S.cpr.showRS) {
        L.push(`<span class="r">R1 ${fmtP(lv.R1)}  R2 ${fmtP(lv.R2)}  R3 ${fmtP(lv.R3)}</span>`);
        L.push(`<span class="g">S1 ${fmtP(lv.S1)}  S2 ${fmtP(lv.S2)}  S3 ${fmtP(lv.S3)}</span>`);
      }
    }
    L.push(`<span class="m">${fmtFull(ticks.t[t])}  (server)</span>`);
    el.innerHTML = L.join('\n');
  }

  function drawDaySeps() {
    const el = $('daySeps');
    if (!C || !S.daySep) { el.innerHTML = ''; return; }
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) { el.innerHTML = ''; return; }
    const from = Math.max(1, Math.floor(range.from)), to = Math.min(R.shownCi, Math.ceil(range.to));
    let html = '';
    let count = 0;
    for (let i = from; i <= to && count < 60; i++) {
      if (cDay[i] !== cDay[i - 1]) {
        const x1 = ts.timeToCoordinate(i), x0 = ts.timeToCoordinate(i - 1);
        const x = x1 === null ? null : (x0 === null ? x1 : (x0 + x1) / 2);
        if (x !== null) { html += `<div style="left:${Math.round(x)}px"></div>`; count++; }
      }
    }
    el.innerHTML = html;
  }

  function drawOneClick() {
    const box = $('oneClick');
    if (!ticks || !R.active) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    $('ocBid').textContent = fmtP(ticks.bid[R.cursor]);
    $('ocAsk').textContent = fmtP(ticks.ask[R.cursor]);
  }

  function drawStatus() {
    const el = $('status');
    if (!ticks) { el.textContent = ''; return; }
    const parts = [`${ticks.n.toLocaleString()} ticks`, `${C.n.toLocaleString()} candles`, `${fmtShort(ticks.t[0])} → ${fmtShort(ticks.t[ticks.n - 1])}`];
    if (R.active) parts.push(`replay ${(R.cursor / (ticks.n - 1) * 100).toFixed(1)}%`);
    el.textContent = parts.join('  ·  ');
  }

  chart.timeScale().subscribeVisibleLogicalRangeChange(() => drawDaySeps());
  new ResizeObserver(() => scheduleUI()).observe(chartEl);

  // Crosshair legend (O H L C / ticks / duration)
  chart.subscribeCrosshairMove(param => {
    const el = $('legend');
    if (!C || param.time === undefined || param.time > R.shownCi) { el.textContent = ''; return; }
    const i = param.time;
    const b = param.seriesData.get(candleSeries);
    if (!b) { el.textContent = ''; return; }
    const endTick = R.active && i === R.shownCi ? Math.min(R.cursor, C.end[i]) : C.end[i];
    const dur = (ticks.t[endTick] - C.t[i]) / 1000;
    const durS = dur >= 60 ? `${Math.floor(dur / 60)}m${pad(Math.round(dur % 60))}s` : `${dur.toFixed(1)}s`;
    el.textContent = `O ${fmtP(b.open)}  H ${fmtP(b.high)}  L ${fmtP(b.low)}  C ${fmtP(b.close)}   ${endTick - C.start[i] + 1} ticks · ${durS}`;
  });

  // ====================================================================
  // Loading data
  // ====================================================================
  function busy(on) { $('busy').classList.toggle('hidden', !on); }
  function toast(msg, ms = 2600) {
    const el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms);
  }

  function setTicks(tk) {
    stopReplay(true);
    ticks = tk;
    resetAccount(true);
    rebuildCPR();
    rebuildCandles();
    applySeriesStyles();
    $('emptyMsg').classList.add('hidden');
    const jd = $('jumpDate');
    jd.min = toInputValue(ticks.t[0]); jd.max = toInputValue(ticks.t[ticks.n - 1]);
    if (!jd.value) jd.value = toInputValue(ticks.t[0]);
    render(true);
    chart.timeScale().scrollToRealTime();
    const noCpr = days.length && !cprMap.get(days[0].day);
    toast(`Loaded ${ticks.n.toLocaleString()} ticks, ${days.length} day(s) of ${ticks.symbol}` + (noCpr ? ' — first day has no CPR (no previous day)' : ''), 4000);
  }

  function loadFile(file) {
    if (!file) return;
    busy(true);
    const reader = new FileReader();
    reader.onerror = () => { busy(false); toast('Could not read file'); };
    reader.onload = () => {
      setTimeout(() => {
        try { setTicks(D.parseTicks(D.decodeBuffer(reader.result), file.name)); }
        catch (e) { console.error(e); toast('Error: ' + e.message, 5000); }
        finally { busy(false); }
      }, 20);
    };
    reader.readAsArrayBuffer(file);
  }
  $('fileInput').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('demoSelect').addEventListener('change', e => {
    const v = e.target.value; e.target.value = '';
    if (!v) return;
    busy(true);
    setTimeout(() => { try { setTicks(D.makeDemoTicks(v)); } finally { busy(false); } }, 20);
  });
  window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragover'); });
  window.addEventListener('dragleave', e => { if (e.target === document.documentElement || !e.relatedTarget) document.body.classList.remove('dragover'); });
  window.addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('dragover'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

  // ====================================================================
  // Tick size
  // ====================================================================
  const tickSizeEl = $('tickSize');
  tickSizeEl.value = S.tickSize;
  tickSizeEl.addEventListener('change', () => {
    const v = Math.max(2, Math.min(100000, +tickSizeEl.value | 0));
    tickSizeEl.value = v;
    if (v === S.tickSize && C) return;
    S.tickSize = v; saveSettings();
    if (!ticks) return;
    const centerTime = visibleCenterTime();
    rebuildCandles();
    R.shownCi = -1;
    render(true);
    if (!R.active && centerTime !== null) scrollToTime(centerTime, false);
  });
  function visibleCenterTime() {
    if (!C) return null;
    const r = chart.timeScale().getVisibleLogicalRange();
    if (!r) return null;
    const i = Math.max(0, Math.min(C.n - 1, Math.round((r.from + r.to) / 2)));
    return C.t[i];
  }
  function scrollToTime(ms, mark) {
    const i = D.candleOfTick(C, Math.min(ticks.n - 1, D.tickAtOrAfter(ticks, ms)));
    const r = chart.timeScale().getVisibleLogicalRange();
    const half = r ? Math.max(20, (r.to - r.from) / 2) : 80;
    chart.timeScale().setVisibleLogicalRange({ from: i - half, to: i + half });
    if (mark) toast(`Jumped to ${fmtFull(C.t[i])}`);
  }

  // ====================================================================
  // Replay
  // ====================================================================
  const btnReplay = $('btnReplay'), btnPlay = $('btnPlay');
  function hint(msg) { const h = $('hint'); if (msg) { h.innerHTML = msg; h.classList.remove('hidden'); } else h.classList.add('hidden'); }
  function setReplayButtons() {
    const on = R.active;
    btnReplay.classList.toggle('active', on || R.picking);
    btnReplay.textContent = on ? '⏹ Stop replay' : (R.picking ? '✕ Cancel' : '⏪ Replay');
    btnPlay.disabled = !on; $('btnStepTick').disabled = !on; $('btnStepCandle').disabled = !on;
    btnPlay.textContent = R.playing ? '❚❚' : '▶';
  }

  btnReplay.addEventListener('click', () => {
    if (!ticks) return toast('Load tick data first');
    if (R.active) { stopReplay(false); return; }
    if (R.picking) { R.picking = false; chartEl.classList.remove('placing'); hint(null); setReplayButtons(); return; }
    R.picking = true; chartEl.classList.add('placing');
    hint('Click a candle to start the replay after it — or pick a date/time and press <b>Go</b>.  (Esc to cancel)');
    setReplayButtons();
  });

  function startReplayAt(cursor) {
    cursor = Math.max(0, Math.min(ticks.n - 1, cursor));
    if (R.active && cursor < R.cursor && (TR.positions.length || TR.orders.length)) {
      toast('Close open positions/orders before jumping backwards'); return;
    }
    R.picking = false; chartEl.classList.remove('placing'); hint(null);
    if (R.active && cursor > R.cursor) { advanceTo(cursor); }
    else {
      R.active = true; R.cursor = cursor; R.shownCi = -1;
      render(true);
      chart.timeScale().scrollToRealTime();
    }
    setReplayButtons();
  }

  function stopReplay(silent) {
    pause();
    if (R.active && ticks && TR.positions.length) {
      const i = R.cursor;
      TR.positions.slice().forEach(p => closePosition(p, p.side === 'buy' ? ticks.bid[i] : ticks.ask[i], i, 'replay stop'));
    }
    TR.orders = [];
    R.active = false; R.picking = false; R.shownCi = -1;
    cancelPlacing();
    chartEl.classList.remove('placing'); hint(null);
    setReplayButtons();
    if (!silent && C) { render(true); }
  }

  function advanceTo(target) {
    target = Math.min(ticks.n - 1, target);
    for (let i = R.cursor + 1; i <= target; i++) processTick(i);
    R.cursor = target;
    render(false);
    if (R.cursor >= ticks.n - 1) { pause(); toast('End of data'); }
  }
  function endOfNextCandle(cur) {
    const ci = D.candleOfTick(C, cur);
    if (cur < C.end[ci]) return C.end[ci];
    return ci + 1 < C.n ? C.end[ci + 1] : cur;
  }

  function play() {
    if (!R.active || R.playing) return;
    if (R.cursor >= ticks.n - 1) return toast('End of data');
    R.playing = true; R.acc = 0; R.lastTs = performance.now(); R.simT = ticks.t[R.cursor];
    setReplayButtons();
    R.raf = requestAnimationFrame(loop);
  }
  function pause() { R.playing = false; cancelAnimationFrame(R.raf); setReplayButtons(); }
  function loop(ts) {
    if (!R.playing) return;
    const dt = Math.min(0.25, (ts - R.lastTs) / 1000); R.lastTs = ts;
    const speed = S.speeds[S.speedMode];
    let target = R.cursor;
    if (S.speedMode === 'tick') {
      R.acc += dt * speed; const k = Math.floor(R.acc); R.acc -= k; target += k;
    } else if (S.speedMode === 'candle') {
      R.acc += dt * speed;
      while (R.acc >= 1) { R.acc -= 1; target = endOfNextCandle(target); }
    } else {
      R.simT += dt * speed * 1000;
      const next = target + 1 < ticks.n ? ticks.t[target + 1] : Infinity;
      if (next - R.simT > 5000 * speed) R.simT = next; // skip long gaps (e.g. overnight)
      while (target + 1 < ticks.n && ticks.t[target + 1] <= R.simT) target++;
    }
    if (target > R.cursor) advanceTo(target);
    if (R.playing) R.raf = requestAnimationFrame(loop);
  }

  btnPlay.addEventListener('click', () => R.playing ? pause() : play());
  $('btnStepTick').addEventListener('click', () => { if (R.active) { pause(); advanceTo(R.cursor + 1); } });
  $('btnStepCandle').addEventListener('click', () => { if (R.active) { pause(); advanceTo(endOfNextCandle(R.cursor)); } });

  const speedModeEl = $('speedMode'), speedEl = $('speed');
  function fillSpeeds() {
    speedModeEl.value = S.speedMode;
    speedEl.innerHTML = SPEEDS[S.speedMode].map(v => `<option value="${v}">${S.speedMode === 'time' ? '×' + v : v}</option>`).join('');
    if (!SPEEDS[S.speedMode].includes(+S.speeds[S.speedMode])) S.speeds[S.speedMode] = SPEEDS[S.speedMode][3];
    speedEl.value = S.speeds[S.speedMode];
  }
  speedModeEl.addEventListener('change', () => { S.speedMode = speedModeEl.value; fillSpeeds(); saveSettings(); R.simT = ticks ? ticks.t[Math.max(0, R.cursor)] : 0; R.acc = 0; });
  speedEl.addEventListener('change', () => { S.speeds[S.speedMode] = +speedEl.value; saveSettings(); });
  fillSpeeds();

  $('btnJump').addEventListener('click', () => {
    if (!ticks) return toast('Load tick data first');
    const ms = fromInputValue($('jumpDate').value);
    if (!isFinite(ms)) return toast('Pick a date and time');
    const idx = D.tickAtOrAfter(ticks, ms);
    if (R.active || R.picking) startReplayAt(Math.max(0, idx - 1));
    else scrollToTime(ms, true);
  });

  // ====================================================================
  // Paper trading
  // ====================================================================
  const lotsEl = $('lots');
  lotsEl.value = S.trade.lots;
  lotsEl.addEventListener('change', () => { S.trade.lots = Math.max(0.01, +lotsEl.value || 1); lotsEl.value = S.trade.lots; saveSettings(); });
  const lots = () => Math.max(0.01, +S.trade.lots || 1);
  const dir = side => side === 'buy' ? 1 : -1;

  function resetAccount(silent) {
    TR.balance = +S.trade.balance || 10000; TR.positions = []; TR.orders = []; TR.history = []; TR.nextId = 1;
    if (!silent) { render(false); toast('Account reset'); }
  }
  function defaultStops(side, entry) {
    const sl = +S.trade.slPts > 0 ? roundP(entry - dir(side) * S.trade.slPts) : null;
    const tp = +S.trade.tpPts > 0 ? roundP(entry + dir(side) * S.trade.tpPts) : null;
    return { sl, tp };
  }
  function requireReplay() {
    if (!ticks) { toast('Load tick data first'); return false; }
    if (!R.active) { toast('Start a replay to paper trade (⏪ Replay)'); return false; }
    return true;
  }

  function marketOrder(side) {
    if (!requireReplay()) return;
    const i = R.cursor;
    const price = side === 'buy' ? ticks.ask[i] : ticks.bid[i];
    const st = defaultStops(side, price);
    openPosition(side, lots(), price, i, st.sl, st.tp);
    render(false);
  }
  function openPosition(side, l, price, tick, sl, tp) {
    const p = { id: TR.nextId++, side, lots: l, entry: price, entryTick: tick, sl, tp };
    TR.positions.push(p);
    return p;
  }
  function closePosition(p, price, tick, reason) {
    const points = (price - p.entry) * dir(p.side);
    const pnl = points * p.lots * vpp();
    TR.balance += pnl;
    TR.history.push({ ...p, exit: price, exitTick: tick, reason, points, pnl });
    TR.positions = TR.positions.filter(x => x !== p);
  }

  function startPlacing(side) {
    if (!requireReplay()) return;
    TR.placing = side;
    chartEl.classList.add('placing');
    $(side === 'buy' ? 'btnBuyLimit' : 'btnSellLimit').classList.add('active');
    $(side === 'buy' ? 'btnSellLimit' : 'btnBuyLimit').classList.remove('active');
    hint(`Click on the chart at the price for your <b>${side.toUpperCase()}</b> order. (Esc to cancel)`);
  }
  function cancelPlacing() {
    TR.placing = null;
    if (!R.picking) { chartEl.classList.remove('placing'); hint(null); }
    $('btnBuyLimit').classList.remove('active'); $('btnSellLimit').classList.remove('active');
  }
  function orderType(side, price) {
    const i = R.cursor;
    if (side === 'buy') return price < ticks.ask[i] ? 'limit' : 'stop';
    return price > ticks.bid[i] ? 'limit' : 'stop';
  }
  function placePending(side, price) {
    price = roundP(price);
    const type = orderType(side, price);
    const st = defaultStops(side, price);
    TR.orders.push({ id: TR.nextId++, side, type, price, lots: lots(), sl: st.sl, tp: st.tp, createdTick: R.cursor });
    if (type === 'stop') toast(`Price is on the other side of the market — placed as ${side.toUpperCase()} STOP`);
    render(false);
  }

  // Called for every tick revealed during replay.
  function processTick(i) {
    const b = ticks.bid[i], a = ticks.ask[i];
    if (TR.orders.length) {
      for (const o of TR.orders.slice()) {
        let fill = null;
        if (o.side === 'buy' && o.type === 'limit' && a <= o.price) fill = Math.min(a, o.price);
        else if (o.side === 'sell' && o.type === 'limit' && b >= o.price) fill = Math.max(b, o.price);
        else if (o.side === 'buy' && o.type === 'stop' && a >= o.price) fill = a;
        else if (o.side === 'sell' && o.type === 'stop' && b <= o.price) fill = b;
        if (fill !== null) {
          TR.orders = TR.orders.filter(x => x !== o);
          openPosition(o.side, o.lots, fill, i, o.sl, o.tp);
        }
      }
    }
    if (TR.positions.length) {
      for (const p of TR.positions.slice()) {
        if (p.entryTick === i) continue;
        if (p.side === 'buy') {
          if (p.sl != null && b <= p.sl) closePosition(p, b, i, 'sl');
          else if (p.tp != null && b >= p.tp) closePosition(p, Math.max(b, p.tp), i, 'tp');
        } else {
          if (p.sl != null && a >= p.sl) closePosition(p, a, i, 'sl');
          else if (p.tp != null && a <= p.tp) closePosition(p, Math.min(a, p.tp), i, 'tp');
        }
      }
    }
  }

  function livePnL(p) {
    const i = R.cursor;
    const cur = p.side === 'buy' ? ticks.bid[i] : ticks.ask[i];
    const points = (cur - p.entry) * dir(p.side);
    return { cur, points, pnl: points * p.lots * vpp() };
  }
  const money = v => (v >= 0 ? '+' : '') + v.toFixed(2);

  // ---------- price lines (orders / positions / ask) ----------
  const lines = new Map(); // key -> IPriceLine
  let dragTargets = [];    // { key, price, kind, obj, field }
  let preview = null;      // { price, title, color } temporary line while dragging from an entry line

  function want(map, key, opts) { map.set(key, opts); }
  function syncLines() {
    const desired = new Map();
    dragTargets = [];
    if (ticks && R.active) {
      const i = R.cursor;
      if (S.askLine) want(desired, 'ask', { price: ticks.ask[i], color: '#ff5c5c', lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: '' });
      const val = vpp();
      for (const p of TR.positions) {
        const lp = livePnL(p);
        const col = p.side === 'buy' ? '#2fd16b' : '#ff5c5c';
        want(desired, `p${p.id}`, { price: p.entry, color: col, lineWidth: 1, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: true, title: `#${p.id} ${p.side.toUpperCase()} ${p.lots}  ${money(lp.pnl)}` });
        dragTargets.push({ key: `p${p.id}`, price: p.entry, kind: 'posEntry', obj: p });
        for (const f of ['sl', 'tp']) if (p[f] != null) {
          const pts = (p[f] - p.entry) * dir(p.side);
          want(desired, `p${p.id}${f}`, { price: p[f], color: f === 'sl' ? '#ff5252' : '#00c853', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: `${f.toUpperCase()} #${p.id}  ${money(pts * p.lots * val)}` });
          dragTargets.push({ key: `p${p.id}${f}`, price: p[f], kind: 'posStop', obj: p, field: f });
        }
      }
      for (const o of TR.orders) {
        want(desired, `o${o.id}`, { price: o.price, color: '#5aa2ff', lineWidth: 1, lineStyle: LWC.LineStyle.LargeDashed, axisLabelVisible: true, title: `#${o.id} ${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.lots}` });
        dragTargets.push({ key: `o${o.id}`, price: o.price, kind: 'order', obj: o });
        for (const f of ['sl', 'tp']) if (o[f] != null) {
          const pts = (o[f] - o.price) * dir(o.side);
          want(desired, `o${o.id}${f}`, { price: o[f], color: f === 'sl' ? '#ff5252aa' : '#00c853aa', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: `${f.toUpperCase()} #${o.id}  ${money(pts * o.lots * val)}` });
          dragTargets.push({ key: `o${o.id}${f}`, price: o[f], kind: 'orderStop', obj: o, field: f });
        }
      }
      if (preview) want(desired, 'preview', { price: preview.price, color: preview.color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: preview.title });
    }
    for (const [k, line] of lines) if (!desired.has(k)) { candleSeries.removePriceLine(line); lines.delete(k); }
    for (const [k, opts] of desired) {
      const line = lines.get(k);
      if (line) line.applyOptions(opts); else lines.set(k, candleSeries.createPriceLine(opts));
    }
  }

  // ---------- markers ----------
  function refreshMarkers() {
    if (!C || !R.active) { candleSeries.setMarkers([]); return; }
    const mk = [];
    const add = (tick, m) => { const ci = D.candleOfTick(C, tick); if (ci <= R.shownCi) mk.push({ time: ci, ...m }); };
    for (const h of TR.history) {
      add(h.entryTick, { position: h.side === 'buy' ? 'belowBar' : 'aboveBar', shape: h.side === 'buy' ? 'arrowUp' : 'arrowDown', color: h.side === 'buy' ? '#2f81f7' : '#ff7043', text: `#${h.id}` });
      add(h.exitTick, { position: h.side === 'buy' ? 'aboveBar' : 'belowBar', shape: 'circle', color: h.pnl >= 0 ? '#2fd16b' : '#ff5c5c', text: money(h.pnl) });
    }
    for (const p of TR.positions) add(p.entryTick, { position: p.side === 'buy' ? 'belowBar' : 'aboveBar', shape: p.side === 'buy' ? 'arrowUp' : 'arrowDown', color: p.side === 'buy' ? '#2f81f7' : '#ff7043', text: `#${p.id}` });
    mk.sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(mk);
  }

  // ---------- validation of dragged levels ----------
  function validStop(side, field, level, ref) {
    // ref: market price relevant for positions, or order price for pending orders
    if (field === 'sl') return side === 'buy' ? level < ref : level > ref;
    return side === 'buy' ? level > ref : level < ref;
  }

  // ---------- dragging ----------
  let drag = null;
  function paneY(e) { return e.clientY - chartEl.getBoundingClientRect().top; }
  function inPane(e) {
    const r = chartEl.getBoundingClientRect();
    const x = e.clientX - r.left;
    return x < r.width - chart.priceScale('right').width() && (e.clientY - r.top) < r.height - chart.timeScale().height();
  }
  function hitTest(e) {
    if (!R.active || !dragTargets.length || !inPane(e)) return null;
    const y = paneY(e);
    let best = null, bestD = 6;
    for (const t of dragTargets) {
      const c = candleSeries.priceToCoordinate(t.price);
      if (c === null) continue;
      const d = Math.abs(c - y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }
  chartEl.addEventListener('mousedown', e => {
    if (e.button !== 0 || TR.placing || R.picking) return;
    const t = hitTest(e);
    if (!t) return;
    e.stopPropagation(); e.preventDefault();
    pause();
    drag = { t, orig: t.kind === 'posStop' || t.kind === 'orderStop' ? t.obj[t.field] : t.obj.price ?? t.obj.entry };
    chart.applyOptions({ handleScroll: false, handleScale: false });
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }, true);
  chartEl.addEventListener('mousemove', e => {
    if (drag) return;
    chartEl.classList.toggle('drag-hover', !!hitTest(e) && !TR.placing && !R.picking);
  });
  function priceAt(e) { const p = candleSeries.coordinateToPrice(paneY(e)); return p === null ? null : roundP(p); }
  function onDragMove(e) {
    const price = priceAt(e);
    if (price === null) return;
    const { t } = drag;
    if (t.kind === 'posStop' || t.kind === 'orderStop') t.obj[t.field] = price;
    else if (t.kind === 'order') {
      const d = price - t.obj.price;
      t.obj.price = price;
      if (t.obj.sl != null) t.obj.sl = roundP(t.obj.sl + d);  // stops move with the order
      if (t.obj.tp != null) t.obj.tp = roundP(t.obj.tp + d);
    } else if (t.kind === 'posEntry') {
      const p = t.obj;
      const isTP = (price - p.entry) * dir(p.side) > 0;
      const pts = (price - p.entry) * dir(p.side);
      preview = { price, color: isTP ? '#00c853' : '#ff5252', title: `${isTP ? 'TP' : 'SL'} #${p.id}  ${money(pts * p.lots * vpp())}` };
    }
    syncLines();
  }
  function onDragEnd(e) {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    chart.applyOptions({ handleScroll: true, handleScale: true });
    const { t, orig } = drag;
    drag = null;
    const i = R.cursor, b = ticks.bid[i], a = ticks.ask[i];
    if (t.kind === 'posStop') {
      const p = t.obj, ref = p.side === 'buy' ? b : a;
      if (!validStop(p.side, t.field, p[t.field], ref)) { p[t.field] = orig; toast(`Invalid ${t.field.toUpperCase()}: it would trigger immediately`); }
    } else if (t.kind === 'orderStop') {
      const o = t.obj;
      if (!validStop(o.side, t.field, o[t.field], o.price)) { o[t.field] = orig; toast(`Invalid ${t.field.toUpperCase()} for this order`); }
    } else if (t.kind === 'order') {
      const o = t.obj, nt = orderType(o.side, o.price);
      if (nt !== o.type) { o.type = nt; toast(`Order changed to ${o.side.toUpperCase()} ${nt.toUpperCase()}`); }
    } else if (t.kind === 'posEntry' && preview) {
      const p = t.obj, price = preview.price;
      const field = (price - p.entry) * dir(p.side) > 0 ? 'tp' : 'sl';
      preview = null;
      if (validStop(p.side, field, price, p.side === 'buy' ? b : a)) p[field] = price;
      else toast(`Invalid ${field.toUpperCase()}: it would trigger immediately`);
    }
    preview = null;
    render(false);
  }

  // Chart clicks: choose replay start / place pending order.
  // Handled directly (not via chart.subscribeClick) so quick successive clicks are never
  // swallowed as a double-click, and so the chart doesn't pan while in these modes.
  let clickDown = null;
  chartEl.addEventListener('mousedown', e => {
    if (e.button !== 0 || !C || !(R.picking || TR.placing) || !inPane(e)) return;
    e.stopPropagation(); e.preventDefault();
    clickDown = { x: e.clientX, y: e.clientY };
  }, true);
  chartEl.addEventListener('mouseup', e => {
    if (!clickDown) return;
    const moved = Math.hypot(e.clientX - clickDown.x, e.clientY - clickDown.y);
    clickDown = null;
    if (moved > 6) return;
    const r = chartEl.getBoundingClientRect();
    if (R.picking) {
      const logical = chart.timeScale().coordinateToLogical(e.clientX - r.left);
      if (logical === null) return;
      const idx = Math.min(R.active ? R.shownCi : C.n - 1, Math.max(0, Math.round(logical)));
      startReplayAt(C.end[idx]);
    } else if (TR.placing) {
      const price = candleSeries.coordinateToPrice(e.clientY - r.top);
      const side = TR.placing;
      cancelPlacing();
      if (price !== null) placePending(side, price);
    }
  }, true);

  $('btnBuy').addEventListener('click', () => marketOrder('buy'));
  $('btnSell').addEventListener('click', () => marketOrder('sell'));
  $('btnBuyLimit').addEventListener('click', () => TR.placing === 'buy' ? cancelPlacing() : startPlacing('buy'));
  $('btnSellLimit').addEventListener('click', () => TR.placing === 'sell' ? cancelPlacing() : startPlacing('sell'));

  // ---------- tables ----------
  function drawTables() {
    const rows = [];
    if (ticks && R.active) {
      for (const p of TR.positions) {
        const lp = livePnL(p), cls = lp.pnl >= 0 ? 'pos' : 'neg';
        rows.push(`<tr><td>${p.id}</td><td>${p.side}</td><td>${p.lots}</td><td>${fmtP(p.entry)}</td>
          <td>${p.sl != null ? fmtP(p.sl) + ` <button class="x" data-act="rmsl" data-id="${p.id}" title="Remove S/L">✕</button>` : `<button class="lnk" data-act="addsl" data-id="${p.id}">+SL</button>`}</td>
          <td>${p.tp != null ? fmtP(p.tp) + ` <button class="x" data-act="rmtp" data-id="${p.id}" title="Remove T/P">✕</button>` : `<button class="lnk" data-act="addtp" data-id="${p.id}">+TP</button>`}</td>
          <td>${fmtP(lp.cur)}</td><td class="${cls}">${lp.points.toFixed(digits())}</td><td class="${cls}">${money(lp.pnl)}</td>
          <td><button class="x" data-act="close" data-id="${p.id}" title="Close position">✕ close</button></td></tr>`);
      }
      for (const o of TR.orders) {
        rows.push(`<tr class="pending"><td>${o.id}</td><td>${o.side} ${o.type}</td><td>${o.lots}</td><td>${fmtP(o.price)}</td>
          <td>${o.sl != null ? fmtP(o.sl) : `<button class="lnk" data-act="oaddsl" data-id="${o.id}">+SL</button>`}</td>
          <td>${o.tp != null ? fmtP(o.tp) : `<button class="lnk" data-act="oaddtp" data-id="${o.id}">+TP</button>`}</td>
          <td>${fmtP(o.side === 'buy' ? ticks.ask[R.cursor] : ticks.bid[R.cursor])}</td><td></td><td>pending</td>
          <td><button class="x" data-act="cancel" data-id="${o.id}" title="Cancel order">✕ cancel</button></td></tr>`);
      }
    }
    const openHtml = rows.join('') || `<tr><td colspan="10" class="muted">${R.active ? 'No open positions. Use BUY / SELL (or keys B / S), or Buy/Sell Limit and click the chart. Drag lines to move S/L, T/P and orders; drag a position line to add S/L or T/P.' : 'Start a replay (⏪ Replay) to paper trade.'}</td></tr>`;
    const openRows = $('openRows');
    if (openRows._html !== openHtml) { openRows.innerHTML = openHtml; openRows._html = openHtml; }

    const hist = TR.history.slice().reverse().map(h => `<tr><td>${h.id}</td><td>${h.side}</td><td>${h.lots}</td><td>${fmtShort(ticks.t[h.entryTick])}:${pad(new Date(ticks.t[h.entryTick]).getUTCSeconds())}</td><td>${fmtP(h.entry)}</td>
      <td>${fmtShort(ticks.t[h.exitTick])}:${pad(new Date(ticks.t[h.exitTick]).getUTCSeconds())}</td><td>${fmtP(h.exit)}</td><td>${h.reason}</td>
      <td class="${h.pnl >= 0 ? 'pos' : 'neg'}">${h.points.toFixed(digits())}</td><td class="${h.pnl >= 0 ? 'pos' : 'neg'}">${money(h.pnl)}</td></tr>`).join('');
    const histRows = $('histRows');
    const histHtml = hist || '<tr><td colspan="10" class="muted">No closed trades yet.</td></tr>';
    if (histRows._html !== histHtml) { histRows.innerHTML = histHtml; histRows._html = histHtml; }

    // account summary
    const open = (ticks && R.active) ? TR.positions.reduce((s, p) => s + livePnL(p).pnl, 0) : 0;
    const n = TR.history.length, wins = TR.history.filter(h => h.pnl > 0).length;
    const net = TR.history.reduce((s, h) => s + h.pnl, 0);
    const pts = TR.history.reduce((s, h) => s + h.points, 0);
    const cur = currency();
    $('acct').innerHTML = `<span>Balance <b>${TR.balance.toFixed(2)}</b> ${cur}</span><span>Equity <b>${(TR.balance + open).toFixed(2)}</b></span>` +
      `<span>Open <b class="${open >= 0 ? 'pos' : 'neg'}">${money(open)}</b></span>` +
      `<span>Trades <b>${n}</b>${n ? ` · Win <b>${(wins / n * 100).toFixed(0)}%</b>` : ''}</span>` +
      `<span>Net <b class="${net >= 0 ? 'pos' : 'neg'}">${money(net)}</b> (${pts >= 0 ? '+' : ''}${pts.toFixed(1)} pts)</span>`;
  }

  $('openRows').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn || !R.active) return;
    const id = +btn.dataset.id, act = btn.dataset.act, i = R.cursor;
    const p = TR.positions.find(x => x.id === id), o = TR.orders.find(x => x.id === id);
    const dist = () => +S.trade.slPts > 0 ? +S.trade.slPts : Math.max(Math.pow(10, -digits()) * 10, ticks.bid[i] * 0.001);
    const distTp = () => +S.trade.tpPts > 0 ? +S.trade.tpPts : dist();
    if (act === 'close' && p) closePosition(p, p.side === 'buy' ? ticks.bid[i] : ticks.ask[i], i, 'manual');
    else if (act === 'cancel' && o) TR.orders = TR.orders.filter(x => x !== o);
    else if (act === 'addsl' && p) p.sl = roundP((p.side === 'buy' ? ticks.bid[i] : ticks.ask[i]) - dir(p.side) * dist());
    else if (act === 'addtp' && p) p.tp = roundP((p.side === 'buy' ? ticks.bid[i] : ticks.ask[i]) + dir(p.side) * distTp());
    else if (act === 'rmsl' && p) p.sl = null;
    else if (act === 'rmtp' && p) p.tp = null;
    else if (act === 'oaddsl' && o) o.sl = roundP(o.price - dir(o.side) * dist());
    else if (act === 'oaddtp' && o) o.tp = roundP(o.price + dir(o.side) * distTp());
    render(false);
  });

  $('btnExport').addEventListener('click', () => {
    if (!TR.history.length) return toast('No trades to export');
    const head = 'id,side,lots,open_time,open_price,close_time,close_price,reason,points,profit,sl,tp';
    const rows = TR.history.map(h => [h.id, h.side, h.lots, fmtIso(ticks.t[h.entryTick]), h.entry, fmtIso(ticks.t[h.exitTick]), h.exit, h.reason, h.points.toFixed(digits()), h.pnl.toFixed(2), h.sl ?? '', h.tp ?? ''].join(','));
    const blob = new Blob([head + '\n' + rows.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trades_${symbolKey() || 'tickchart'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('btnResetAcct').addEventListener('click', () => { if (confirm('Clear all trades and reset the balance?')) resetAccount(false); });

  // tabs
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabBody').forEach(b => b.classList.toggle('hidden', b.id !== t.dataset.tab));
  }));

  // ====================================================================
  // Settings dialog
  // ====================================================================
  const dlg = $('settingsDlg'), form = $('settingsForm');
  const getPath = (o, p) => p.split('.').reduce((a, k) => a && a[k], o);
  const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
  $('btnSettings').addEventListener('click', () => {
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = el.name === 'vpp' ? vpp() : el.name === 'cur' ? currency() : getPath(S, el.name);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
    }
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const before = JSON.stringify([S.countMode, S.syncDay]);
    const beforeHLC = JSON.stringify(S.firstHLC);
    for (const el of form.elements) {
      if (!el.name) continue;
      let v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (el.value === '' ? 0 : +el.value) : el.value);
      if (el.name === 'vpp') { if (ticks) S.vppBySymbol[symbolKey()] = v; continue; }
      if (el.name === 'cur') { if (ticks) S.curBySymbol[symbolKey()] = v; continue; }
      setPath(S, el.name, v);
    }
    saveSettings();
    applySeriesStyles();
    if (!ticks) return;
    if (JSON.stringify(S.firstHLC) !== beforeHLC) cprMap = D.buildCPR(days, S.firstHLC);
    if (JSON.stringify([S.countMode, S.syncDay]) !== before) rebuildCandles(); else rebuildMAs();
    R.shownCi = -1;
    render(true);
  });

  // ====================================================================
  // Keyboard
  // ====================================================================
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea') || dlg.open) return;
    if (e.key === 'Escape') { cancelPlacing(); if (R.picking) btnReplay.click(); return; }
    if (!R.active) return;
    if (e.code === 'Space') { e.preventDefault(); R.playing ? pause() : play(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); advanceTo(e.shiftKey ? R.cursor + 1 : endOfNextCandle(R.cursor)); }
    else if (e.key === 'b' || e.key === 'B') marketOrder('buy');
    else if (e.key === 's' || e.key === 'S') marketOrder('sell');
  });

  // Give keyboard shortcuts back to the chart after using a toolbar control.
  ['speedMode', 'speed', 'tickSize', 'demoSelect'].forEach(id => $(id).addEventListener('change', e => e.target.blur()));
  document.querySelectorAll('#toolbar button, #oneClick button, #panel button').forEach(el => el.addEventListener('click', () => el.blur()));

  setReplayButtons();
  applySeriesStyles();
  drawTables();

  // expose for debugging / tests
  window.TickChartApp = { get ticks() { return ticks; }, get candles() { return C; }, R, TR, setTicks, startReplayAt, advanceTo, marketOrder, placePending, chart, candleSeries };
})();
