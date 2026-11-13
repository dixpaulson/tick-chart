/* Tick Chart — application: chart, replay, paper trading, live trading (via the bridge), UI. */
(function () {
  'use strict';
  const LWC = LightweightCharts;
  const D = TickData;
  const TT = TickTime;
  const $ = id => document.getElementById(id);
  const DAY = D.DAY_MS;

  // ====================================================================
  // Settings
  // ====================================================================
  const DEFAULTS = {
    tickSize: 50, countMode: 'all', syncDay: true, daySep: true, askLine: true,
    ma1: { on: true, type: 'EMA', period: 9, color: '#22c55e', width: 1 },
    ma2: { on: true, type: 'EMA', period: 21, color: '#ff2a2a', width: 2 },
    cpr: { on: true, showRS: true, colP: '#facc15', colCPR: '#22c55e', colR: '#ef5350', colS: '#42a5f5', narrowPct: 0.15, widePct: 0.35 },
    firstHLC: { h: 0, l: 0, c: 0 },
    trade: { lots: 1, balance: 10000, slPts: 0, tpPts: 0, confirm: true },
    tz: { display: 'America/Toronto', server: 'ny7' },
    vppBySymbol: {}, curBySymbol: {},
    speedMode: 'tick', speeds: { tick: 50, candle: 2, time: 10 },
    liveSymbol: '', infoOpen: true, panelOpen: true,
    fc: { on: true, box: true, panel: true, days: 30, horizon: 1 }
  };
  const SPEEDS = {
    tick: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    candle: [0.25, 0.5, 1, 2, 3, 5, 10, 20, 50],
    time: [1, 2, 5, 10, 30, 60, 120, 300]
  };
  const LINE_COLORS = ['#ffffff', '#facc15', '#38bdf8', '#f472b6', '#a3e635', '#fb923c'];
  function merge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(over)) {
      out[k] = (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) ? merge(base[k], over[k]) : over[k];
    }
    return out;
  }
  let S;
  try { S = merge(DEFAULTS, JSON.parse(localStorage.getItem('tickchart.settings') || '{}')); } catch (e) { S = merge(DEFAULTS, {}); }
  const narrowScreen = () => window.matchMedia('(max-width: 760px)').matches;
  if (narrowScreen() && !localStorage.getItem('tickchart.settings')) { S.infoOpen = false; S.panelOpen = false; S.fc.panel = false; }
  function saveSettings() { try { localStorage.setItem('tickchart.settings', JSON.stringify(S)); } catch (e) { /* ignore */ } }

  // ====================================================================
  // State
  // ====================================================================
  let ticks = null, days = [], dayIndex = new Map(), cprMap = new Map();
  let C = null;
  let ma1 = null, ma2 = null;
  let runtimeHLC = null;   // previous-day H/L/C for the first loaded day (from the bridge)
  const R = { active: false, picking: false, cursor: -1, playing: false, shownCi: -1, raf: 0, acc: 0, simT: 0, lastTs: 0 };
  const TR = { balance: S.trade.balance, positions: [], orders: [], history: [], nextId: 1, placing: null };
  const LIVE = {
    bridge: null, on: false, ws: null, symbol: '', symInfo: null, account: null, trading: { enabled: false, reason: '' },
    positions: [], orders: [], connected: false, retry: 0, reconnectT: 0, ignoreSnapUntil: 0, inflight: 0
  };
  const HL = { list: [], selected: null, symbol: '' };
  // next-candle forecast state
  const FCS = { model: null, offset: 0, train: null, trainKey: '', trainDays: 0, loading: false, val: null, valProgress: -1, valToken: 0,
    pred: null, target: -1, anchor: NaN, pending: [], score: { n: 0, hit: 0, cov: 0, confN: 0, confHit: 0 } };

  const symbolKey = () => (ticks ? ticks.symbol.replace(/\s*\(demo\)/, '').toUpperCase() : '');
  const symInfo = () => (LIVE.symInfo && ticks && LIVE.symInfo.name.toUpperCase() === symbolKey()) ? LIVE.symInfo : null;
  function vpp() {
    const si = symInfo(); if (si && si.value_per_point) return si.value_per_point;
    const k = symbolKey();
    if (S.vppBySymbol[k] !== undefined && S.vppBySymbol[k] !== '') return +S.vppBySymbol[k];
    if (/XAU/.test(k)) return 100;
    // GER40: contract size 10 EUR per point per lot, shown in USD (the account currency) at about 1.16 USD/EUR
    if (/GER|DE40|DAX/.test(k)) return 11.6;
    return 1;
  }
  function currency() {
    if (symInfo() && LIVE.account) return LIVE.account.currency;
    const k = symbolKey();
    if (S.curBySymbol[k]) return S.curBySymbol[k];
    return 'USD';
  }
  const digits = () => (ticks ? ticks.digits : 2);
  const fmtP = p => (p == null || !isFinite(p)) ? '—' : p.toFixed(digits());
  const roundP = p => { const f = Math.pow(10, digits()); return Math.round(p * f) / f; };
  const minStopDist = () => { const si = symInfo(); return (tradeMode() === 'live' && si) ? si.stops_level * si.point : 0; };

  const tradeMode = () => R.active ? 'paper' : (LIVE.on ? 'live' : null);
  const curIdx = () => R.active ? R.cursor : (ticks ? ticks.n - 1 : -1);
  const tail = () => R.active || LIVE.on;
  const posList = () => tradeMode() === 'live' ? LIVE.positions : TR.positions;
  const ordList = () => tradeMode() === 'live' ? LIVE.orders : TR.orders;

  // ====================================================================
  // Time formatting — ticks are server time; shown in the chosen zone (default Kitchener)
  // ====================================================================
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const disp = ms => TT.toDisplay(ms, S.tz);
  function fmtShort(ms) { const d = new Date(disp(ms)); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  function fmtSec(ms) { const d = new Date(disp(ms)); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
  function fmtFull(ms) { const d = new Date(disp(ms)); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
  function fmtIso(ms) { const d = new Date(disp(ms)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`; }
  function toInputValue(ms) { const d = new Date(disp(ms)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
  function fromInputValue(v) {
    const m = (v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    return m ? TT.fromDisplay(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)), S.tz) : NaN;
  }
  const dayName = day => { const x = new Date(day * DAY); return `${DOW[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`; };
  const isoDate = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

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
    rebuildMAs();
    rebuildForecast(true);
    $('titleSym').textContent = `${ticks.symbol}.Tick.${C.size}`;
  }
  function rebuildMAs() {
    if (!C) return;
    ma1 = D.computeMA(S.ma1.type, Math.max(1, +S.ma1.period | 0), C.c, C.n);
    ma2 = D.computeMA(S.ma2.type, Math.max(1, +S.ma2.period | 0), C.c, C.n);
  }
  const firstHLC = () => runtimeHLC || S.firstHLC;
  function rebuildCPRMap() {
    dayIndex = new Map(days.map((d, i) => [d.day, i]));
    cprMap = D.buildCPR(days, firstHLC());
  }
  function rebuildCPR() { days = D.buildDays(ticks); rebuildCPRMap(); }

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
    const lv = cprMap.get(C.day[i]);
    if (!lv) return { time: i };
    // The segment i -> i+1 takes the colour of point i: hide the join between days.
    if (i + 1 < C.n && C.day[i + 1] !== C.day[i]) return { time: i, value: lv[key], color: 'transparent' };
    return { time: i, value: lv[key] };
  }

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

  // Render up to the current tick: replay cursor, newest live tick, or the whole history.
  function render(force) {
    if (!C || !ticks || !ticks.n) return;
    if (!tail()) {
      if (force || R.shownCi !== C.n - 1) setAll(C.n - 1, fullBar(C.n - 1), true);
      R.shownCi = C.n - 1;
    } else {
      const cur = curIdx();
      const ci = D.candleOfTick(C, cur);
      const final = !LIVE.on && cur >= C.end[ci];
      const bar = cur >= C.end[ci] ? fullBar(ci) : formingBar(ci, cur);
      if (force || R.shownCi < 0 || ci < R.shownCi || ci - R.shownCi > 400) setAll(ci, bar, final);
      else { for (let k = R.shownCi; k < ci; k++) updateOne(k, fullBar(k), true); updateOne(ci, bar, final); }
      R.shownCi = ci;
    }
    updateForecast();
    refreshMarkers();
    syncLines();
    scheduleUI();
  }

  // ====================================================================
  // Overlays: info panel, legend, day separators, status
  // ====================================================================
  let uiPending = false;
  function scheduleUI() { if (!uiPending) { uiPending = true; requestAnimationFrame(() => { uiPending = false; drawUI(); }); } }
  function drawUI() { drawInfo(); drawDaySeps(); drawOneClick(); drawTables(); drawStatus(); drawLiveStatus(); drawLineMenu(); drawFcPanel(); drawFcBox(); }

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
    $('btnInfo').classList.toggle('active', !!S.infoOpen);
    if (!C || !S.cpr.on || !S.infoOpen) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const t = curIdx();
    const day = Math.floor(ticks.t[t] / DAY);
    const lv = cprMap.get(day);
    const di = dayIndex.get(day);
    const prevLv = di > 0 ? cprMap.get(days[di - 1].day) : null;
    const price = ticks.bid[t];
    const L = [];
    L.push(`<span class="w">CPR + Pivots  [Daily / Floor]</span>`);
    if (!lv) {
      L.push(`<span class="m">No CPR for this day (no previous day loaded).</span>`);
      L.push(`<span class="m">Load one extra day or enter H/L/C in Settings.</span>`);
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
    L.push(`<span class="m">${fmtFull(ticks.t[t])}  ${TT.zoneLabel(S.tz)}</span>`);
    el.innerHTML = L.join('\n');
  }

  function drawDaySeps() {
    const el = $('daySeps');
    if (!C || !S.daySep) { el.innerHTML = ''; return; }
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) { el.innerHTML = ''; return; }
    const from = Math.max(1, Math.floor(range.from)), to = Math.min(R.shownCi, Math.ceil(range.to));
    let html = '', count = 0;
    for (let i = from; i <= to && count < 60; i++) {
      if (C.day[i] !== C.day[i - 1]) {
        const x1 = ts.timeToCoordinate(i), x0 = ts.timeToCoordinate(i - 1);
        const x = x1 === null ? null : (x0 === null ? x1 : (x0 + x1) / 2);
        if (x !== null) { html += `<div style="left:${Math.round(x)}px"></div>`; count++; }
      }
    }
    el.innerHTML = html;
  }

  function drawOneClick() {
    const box = $('oneClick');
    const mode = tradeMode();
    if (!ticks || !mode) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.classList.toggle('live', mode === 'live');
    const i = curIdx();
    $('ocBid').textContent = fmtP(ticks.bid[i]);
    $('ocAsk').textContent = fmtP(ticks.ask[i]);
    const badge = $('ocMode');
    if (mode === 'live') {
      const demo = LIVE.account && LIVE.account.demo;
      badge.textContent = LIVE.trading.enabled ? (demo ? 'DEMO account' : 'LIVE account') : 'Trading off';
      badge.className = 'oc-badge ' + (LIVE.trading.enabled ? (demo ? 'demo' : 'real') : 'off');
      badge.title = LIVE.trading.enabled ? '' : LIVE.trading.reason;
    } else { badge.textContent = 'Paper (replay)'; badge.className = 'oc-badge paper'; badge.title = ''; }
    $('ocConfirmWrap').classList.toggle('hidden', mode !== 'live');
    $('ocConfirm').checked = !S.trade.confirm;
  }

  function drawStatus() {
    const el = $('status');
    if (!ticks) { el.textContent = ''; return; }
    const parts = [`${ticks.n.toLocaleString()} ticks`, `${C.n.toLocaleString()} candles`, `${fmtShort(ticks.t[0])} → ${fmtShort(ticks.t[ticks.n - 1])}`];
    if (R.active) parts.push(`replay ${(R.cursor / Math.max(1, ticks.n - 1) * 100).toFixed(1)}%`);
    el.textContent = parts.join('  ·  ');
  }

  chart.timeScale().subscribeVisibleLogicalRangeChange(() => { drawDaySeps(); drawFcBox(); drawLineMenu(); });
  new ResizeObserver(() => scheduleUI()).observe(chartEl);

  chart.subscribeCrosshairMove(param => {
    const el = $('legend');
    if (!C || param.time === undefined || param.time > R.shownCi) { el.textContent = ''; return; }
    const i = param.time;
    const b = param.seriesData.get(candleSeries);
    if (!b) { el.textContent = ''; return; }
    const endTick = tail() && i === R.shownCi ? Math.min(curIdx(), C.end[i]) : C.end[i];
    const dur = (ticks.t[endTick] - C.t[i]) / 1000;
    const durS = dur >= 60 ? `${Math.floor(dur / 60)}m${pad(Math.round(dur % 60))}s` : `${dur.toFixed(1)}s`;
    el.textContent = `O ${fmtP(b.open)}  H ${fmtP(b.high)}  L ${fmtP(b.low)}  C ${fmtP(b.close)}   ${endTick - C.start[i] + 1} ticks · ${durS}`;
  });

  // ====================================================================
  // Messages
  // ====================================================================
  function busy(on, text) { $('busy').textContent = text || 'Loading…'; $('busy').classList.toggle('hidden', !on); }
  function toast(msg, ms = 2800) {
    const el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms);
  }
  function hint(msg) { const h = $('hint'); if (msg) { h.innerHTML = msg; h.classList.remove('hidden'); } else h.classList.add('hidden'); }

  // In-page confirmation (browser confirm() is unreliable in embedded viewers)
  const confirmDlg = $('confirmDlg');
  function confirmBox(title, detail, danger) {
    return new Promise(resolve => {
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = detail || '';
      $('confirmOk').className = 'btn ' + (danger ? 'danger' : 'primary');
      confirmDlg.returnValue = '';
      confirmDlg.onclose = () => resolve(confirmDlg.returnValue === 'ok');
      confirmDlg.showModal();
    });
  }

  // ====================================================================
  // Loading data
  // ====================================================================
  function setTicks(tk, opts = {}) {
    stopReplay(true);
    ticks = tk;
    FCS.train = null; FCS.trainKey = ''; FCS.trainDays = 0; resetScore();
    resetAccount(true);
    rebuildCPR();
    rebuildCandles();
    applySeriesStyles();
    $('emptyMsg').classList.add('hidden');
    const jd = $('jumpDate');
    jd.min = toInputValue(ticks.t[0]); jd.max = toInputValue(ticks.t[ticks.n - 1]);
    const jv = fromInputValue(jd.value);
    if (!(jv >= ticks.t[0] && jv <= ticks.t[ticks.n - 1])) jd.value = toInputValue(ticks.t[0]);
    $('addBtn').classList.toggle('hidden', !sources.length);
    R.shownCi = -1;
    loadLines();
    render(true);
    chart.timeScale().scrollToRealTime();
    fetchTraining();
    if (!opts.quiet) {
      const noCpr = days.length && !cprMap.get(days[0].day);
      toast(`Loaded ${ticks.n.toLocaleString()} ticks of ${ticks.symbol}: ${days.map(d => dayName(d.day)).join(', ')}` + (noCpr ? ' — first day has no CPR (no previous day)' : ''), 5000);
    }
  }

  let sources = [];
  const baseSym = s => String(s || '').replace(/\s*\(demo\)/, '').toUpperCase();
  async function loadFiles(fileList, add) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    busy(true);
    await new Promise(r => setTimeout(r, 20));
    try {
      const parsed = [];
      for (const f of files) {
        try { parsed.push(D.parseTicks(D.decodeBuffer(await f.arrayBuffer()), f.name)); }
        catch (e) { console.error(e); toast(`${f.name}: ${e.message}`, 5000); }
      }
      if (!parsed.length) return;
      const syms = new Set(parsed.map(p => baseSym(p.symbol)));
      if (add && ticks && sources.length) syms.add(baseSym(sources[0].symbol));
      if (syms.size > 1) { toast(`These files are for different symbols (${[...syms].join(', ')}). Load one symbol at a time.`, 6000); return; }
      stopLive();
      runtimeHLC = null;
      sources = (add && sources.length) ? sources.concat(parsed) : parsed;
      setTicks(D.mergeTicks(sources));
    } finally { busy(false); }
  }
  $('fileInput').addEventListener('change', e => { loadFiles(e.target.files, false); e.target.value = ''; });
  $('addInput').addEventListener('change', e => { loadFiles(e.target.files, true); e.target.value = ''; });
  $('demoSelect').addEventListener('change', e => {
    const v = e.target.value; e.target.value = '';
    if (!v) return;
    busy(true);
    setTimeout(() => { try { stopLive(); runtimeHLC = null; sources = []; setTicks(D.makeDemoTicks(v)); } finally { busy(false); } }, 20);
  });
  window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragover'); });
  window.addEventListener('dragleave', e => { if (e.target === document.documentElement || !e.relatedTarget) document.body.classList.remove('dragover'); });
  window.addEventListener('drop', e => {
    e.preventDefault(); document.body.classList.remove('dragover');
    const fl = e.dataTransfer.files; if (!fl.length) return;
    loadFiles(fl, !!(ticks && sources.length));
  });

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
    fetchTraining();
    if (!tail() && centerTime !== null) scrollToTime(centerTime, false);
  });
  function visibleCenterTime() {
    if (!C) return null;
    const r = chart.timeScale().getVisibleLogicalRange();
    if (!r) return null;
    return C.t[Math.max(0, Math.min(C.n - 1, Math.round((r.from + r.to) / 2)))];
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
    if (LIVE.on) { stopLive(); toast('Live view paused. Replaying the loaded data.'); render(true); }
    R.picking = true; chartEl.classList.add('placing');
    hint('Tap a candle to start the replay after it, or pick a date/time and press <b>Go</b>. (Esc to cancel)');
    setReplayButtons();
  });

  function startReplayAt(cursor) {
    cursor = Math.max(0, Math.min(ticks.n - 1, cursor));
    if (R.active && cursor < R.cursor && (TR.positions.length || TR.orders.length)) {
      toast('Close open positions/orders before jumping backwards'); return;
    }
    if (LIVE.on) stopLive();
    R.picking = false; chartEl.classList.remove('placing'); hint(null);
    if (R.active && cursor > R.cursor) { advanceTo(cursor); }
    else {
      R.active = true; R.cursor = cursor; R.shownCi = -1; resetScore(); FCS.target = -1;
      render(true);
      chart.timeScale().scrollToRealTime();
    }
    setReplayButtons();
  }
  function stopReplay(silent) {
    pause();
    if (R.active && ticks && TR.positions.length) {
      const i = R.cursor;
      TR.positions.slice().forEach(p => paperClose(p, p.side === 'buy' ? ticks.bid[i] : ticks.ask[i], i, 'replay stop'));
    }
    TR.orders = [];
    R.active = false; R.picking = false; R.shownCi = -1;
    cancelPlacing();
    chartEl.classList.remove('placing'); hint(null);
    setReplayButtons();
    if (!silent && C) render(true);
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
      if (next - R.simT > 5000 * speed) R.simT = next;
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
  // Trading — shared by paper (replay) and live (MT5 via the bridge)
  // ====================================================================
  const lotsEl = $('lots');
  lotsEl.value = S.trade.lots;
  lotsEl.addEventListener('change', () => { S.trade.lots = Math.max(0.01, +lotsEl.value || 1); lotsEl.value = S.trade.lots; saveSettings(); });
  const lots = () => Math.max(0.01, +S.trade.lots || 1);
  const dir = side => side === 'buy' ? 1 : -1;
  const money = v => (v >= 0 ? '+' : '') + (+v).toFixed(2);

  function resetAccount(silent) {
    TR.balance = +S.trade.balance || 10000; TR.positions = []; TR.orders = []; TR.history = []; TR.nextId = 1;
    if (!silent) { render(false); toast('Paper account reset'); }
  }
  function defaultStops(side, entry) {
    const sl = +S.trade.slPts > 0 ? roundP(entry - dir(side) * S.trade.slPts) : null;
    const tp = +S.trade.tpPts > 0 ? roundP(entry + dir(side) * S.trade.tpPts) : null;
    return { sl, tp };
  }
  function requireTrading() {
    if (!ticks) { toast('Load tick data first'); return false; }
    const m = tradeMode();
    if (!m) { toast(LIVE.bridge ? 'Switch on Live, or start a Replay to paper trade' : 'Start a replay to paper trade (⏪ Replay)'); return false; }
    if (m === 'live' && !LIVE.trading.enabled) { toast(LIVE.trading.reason || 'Trading is not available', 6000); return false; }
    if (m === 'live' && LIVE.bridge && lots() > LIVE.bridge.limits.max_lots + 1e-9) { toast(`Lot size is above your limit of ${LIVE.bridge.limits.max_lots}`); return false; }
    return true;
  }
  const bidNow = () => ticks.bid[curIdx()], askNow = () => ticks.ask[curIdx()];
  function orderType(side, price) {
    if (side === 'buy') return price < askNow() ? 'limit' : 'stop';
    return price > bidNow() ? 'limit' : 'stop';
  }

  // ---- live requests
  async function api(path, opts) {
    const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...opts });
    if (!r.ok) throw new Error((await r.text()).slice(0, 200) || r.statusText);
    return r;
  }
  async function liveTrade(req, label, confirmText) {
    if (confirmText && S.trade.confirm) {
      const acct = LIVE.account ? `${LIVE.account.demo ? 'DEMO' : 'LIVE'} account ${LIVE.account.login}` : '';
      const ok = await confirmBox(label, `${confirmText}\n${acct}`, LIVE.account && !LIVE.account.demo);
      if (!ok) return false;
    }
    LIVE.inflight++;
    try {
      const res = await (await api('api/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: LIVE.symbol, ...req }) })).json();
      if (!res.ok) { toast(`MT5: ${res.message}`, 6500); return false; }
      toast(`${label}: done`);
      return true;
    } catch (e) { toast(`Bridge error: ${e.message}`, 6000); return false; }
    finally { LIVE.inflight--; LIVE.ignoreSnapUntil = performance.now() + 800; }
  }

  // ---- actions (dispatch by mode)
  async function marketOrder(side) {
    if (!requireTrading()) return;
    const price = side === 'buy' ? askNow() : bidNow();
    const st = defaultStops(side, price);
    if (tradeMode() === 'paper') { paperOpen(side, lots(), price, R.cursor, st.sl, st.tp); render(false); return; }
    await liveTrade({ action: 'market', side, lots: lots(), sl: st.sl, tp: st.tp }, `${side.toUpperCase()} ${lots()} ${LIVE.symbol}`,
      `Market ${side} ${lots()} lot(s) at about ${fmtP(price)}` + (st.sl ? `, S/L ${fmtP(st.sl)}` : '') + (st.tp ? `, T/P ${fmtP(st.tp)}` : ''));
  }
  async function placePending(side, price) {
    if (!requireTrading()) return;
    price = roundP(price);
    const type = orderType(side, price);
    const st = defaultStops(side, price);
    if (type === 'stop') toast(`That price is on the other side of the market, so this is a ${side.toUpperCase()} STOP order`);
    if (tradeMode() === 'paper') {
      TR.orders.push({ id: TR.nextId++, side, type, price, lots: lots(), sl: st.sl, tp: st.tp, createdTick: R.cursor });
      render(false); return;
    }
    await liveTrade({ action: 'pending', side, type, price, lots: lots(), sl: st.sl, tp: st.tp },
      `${side.toUpperCase()} ${type.toUpperCase()} ${lots()} @ ${fmtP(price)}`, `Place a ${side} ${type} order for ${lots()} lot(s) at ${fmtP(price)}`);
  }
  async function closePos(p) {
    if (tradeMode() === 'paper') { paperClose(p, p.side === 'buy' ? bidNow() : askNow(), R.cursor, 'manual'); render(false); return; }
    await liveTrade({ action: 'close', ticket: p.id }, `Close #${p.id}`, `Close ${p.side} ${p.lots} lot(s), profit now ${money(p.profit)} ${currency()}`);
  }
  async function cancelOrder(o) {
    if (tradeMode() === 'paper') { TR.orders = TR.orders.filter(x => x !== o); render(false); return; }
    await liveTrade({ action: 'cancel', ticket: o.id }, `Cancel #${o.id}`);
  }
  // Set S/L & T/P of a position. Optimistic: shown at once, reverted if MT5 refuses.
  async function setPosStops(p, sl, tp) {
    const old = { sl: p.sl, tp: p.tp };
    p.sl = sl; p.tp = tp; render(false);
    if (tradeMode() !== 'live') return;
    const ok = await liveTrade({ action: 'modify_position', ticket: p.id, sl, tp }, `#${p.id} S/L ${fmtP(sl)} T/P ${fmtP(tp)}`);
    if (!ok) { Object.assign(p, old); render(false); }
  }
  async function modifyOrder(o, price, sl, tp) {
    const old = { price: o.price, sl: o.sl, tp: o.tp };
    Object.assign(o, { price, sl, tp }); render(false);
    if (tradeMode() !== 'live') return;
    const ok = await liveTrade({ action: 'modify_order', ticket: o.id, price, sl, tp }, `Order #${o.id} @ ${fmtP(price)}`);
    if (!ok) { Object.assign(o, old); render(false); }
  }

  // ---- paper engine
  function paperOpen(side, l, price, tick, sl, tp) {
    const p = { id: TR.nextId++, side, lots: l, entry: price, entryTick: tick, sl, tp };
    TR.positions.push(p);
    return p;
  }
  function paperClose(p, price, tick, reason) {
    const points = (price - p.entry) * dir(p.side);
    const pnl = points * p.lots * vpp();
    TR.balance += pnl;
    TR.history.push({ ...p, exit: price, exitTick: tick, reason, points, pnl });
    TR.positions = TR.positions.filter(x => x !== p);
  }
  function processTick(i) {
    const b = ticks.bid[i], a = ticks.ask[i];
    if (TR.orders.length) {
      for (const o of TR.orders.slice()) {
        let fill = null;
        if (o.side === 'buy' && o.type === 'limit' && a <= o.price) fill = Math.min(a, o.price);
        else if (o.side === 'sell' && o.type === 'limit' && b >= o.price) fill = Math.max(b, o.price);
        else if (o.side === 'buy' && o.type === 'stop' && a >= o.price) fill = a;
        else if (o.side === 'sell' && o.type === 'stop' && b <= o.price) fill = b;
        if (fill !== null) { TR.orders = TR.orders.filter(x => x !== o); paperOpen(o.side, o.lots, fill, i, o.sl, o.tp); }
      }
    }
    if (TR.positions.length) {
      for (const p of TR.positions.slice()) {
        if (p.entryTick === i) continue;
        if (p.side === 'buy') {
          if (p.sl != null && b <= p.sl) paperClose(p, b, i, 'sl');
          else if (p.tp != null && b >= p.tp) paperClose(p, Math.max(b, p.tp), i, 'tp');
        } else {
          if (p.sl != null && a >= p.sl) paperClose(p, a, i, 'sl');
          else if (p.tp != null && a <= p.tp) paperClose(p, Math.min(a, p.tp), i, 'tp');
        }
      }
    }
  }
  function pnlOf(p) {
    const cur = p.side === 'buy' ? bidNow() : askNow();
    const points = (cur - p.entry) * dir(p.side);
    return { cur, points, pnl: p.live ? p.profit : points * p.lots * vpp() };
  }

  // ---- placing pending orders / horizontal lines by tapping the chart
  function startPlacing(what) {
    if (what !== 'hline' && !requireTrading()) return;
    if (what === 'hline' && !ticks) return toast('Load tick data first');
    TR.placing = what;
    chartEl.classList.add('placing');
    ['btnBuyLimit', 'btnSellLimit', 'btnHLine'].forEach(id => $(id).classList.remove('active'));
    $(what === 'buy' ? 'btnBuyLimit' : what === 'sell' ? 'btnSellLimit' : 'btnHLine').classList.add('active');
    hint(what === 'hline' ? 'Tap the chart where you want the line. (Esc to cancel)'
      : `Tap the chart at the price for your <b>${what.toUpperCase()}</b> order. (Esc to cancel)`);
  }
  function cancelPlacing() {
    TR.placing = null;
    if (!R.picking) { chartEl.classList.remove('placing'); hint(null); }
    ['btnBuyLimit', 'btnSellLimit', 'btnHLine'].forEach(id => $(id).classList.remove('active'));
  }

  // ====================================================================
  // Horizontal lines (support / resistance) — saved per symbol, shared via the bridge
  // ====================================================================
  const linesKey = () => 'tickchart.hlines.' + symbolKey();
  function loadLines() {
    HL.selected = null; HL.symbol = symbolKey();
    try { HL.list = JSON.parse(localStorage.getItem(linesKey()) || '[]'); } catch (e) { HL.list = []; }
    if (LIVE.bridge && symInfo()) {
      api('api/lines?symbol=' + encodeURIComponent(LIVE.symInfo.name)).then(r => r.json()).then(list => {
        if (Array.isArray(list) && HL.symbol === symbolKey()) { HL.list = list; storeLocal(); syncLines(); scheduleUI(); }
      }).catch(() => { /* keep local copy */ });
    }
  }
  function storeLocal() { try { localStorage.setItem(linesKey(), JSON.stringify(HL.list)); } catch (e) { /* ignore */ } }
  let linesSaveT = 0;
  function saveLines() {
    storeLocal();
    if (LIVE.bridge && symInfo()) {
      clearTimeout(linesSaveT);
      linesSaveT = setTimeout(() => api('api/lines?symbol=' + encodeURIComponent(LIVE.symInfo.name), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(HL.list)
      }).catch(e => toast('Could not save lines on the bridge: ' + e.message)), 400);
    }
  }
  function addLine(price) {
    const color = HL.list.length ? HL.list[HL.list.length - 1].color : LINE_COLORS[1];
    const l = { id: 'h' + Date.now().toString(36), price: roundP(price), color };
    HL.list.push(l); HL.selected = l.id;
    saveLines(); syncLines(); scheduleUI();
  }
  function deleteSelectedLine() {
    if (!HL.selected) return;
    HL.list = HL.list.filter(l => l.id !== HL.selected); HL.selected = null;
    saveLines(); syncLines(); scheduleUI();
  }
  function drawLineMenu() {
    const m = $('lineMenu');
    const l = HL.list.find(x => x.id === HL.selected);
    if (!l || !ticks) { m.classList.add('hidden'); return; }
    const y = candleSeries.priceToCoordinate(l.price);
    if (y === null) { m.classList.add('hidden'); return; }
    m.classList.remove('hidden');
    m.style.top = Math.max(4, Math.round(y) - 34) + 'px';
    m.style.right = (chart.priceScale('right').width() + 8) + 'px';
    m.querySelectorAll('.sw').forEach(b => b.classList.toggle('on', b.dataset.c === l.color));
  }
  $('lineMenu').innerHTML = LINE_COLORS.map(c => `<button class="sw" data-c="${c}" style="background:${c}" title="Colour"></button>`).join('') +
    '<button class="btn small" data-act="del" title="Delete line (Del)">🗑 Delete</button>';
  $('lineMenu').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const l = HL.list.find(x => x.id === HL.selected); if (!l) return;
    if (b.dataset.act === 'del') deleteSelectedLine();
    else if (b.dataset.c) { l.color = b.dataset.c; saveLines(); syncLines(); scheduleUI(); }
  });
  $('btnHLine').addEventListener('click', () => TR.placing === 'hline' ? cancelPlacing() : startPlacing('hline'));

  // ====================================================================
  // Price lines on the chart (positions, orders, ask, horizontal lines) + drag targets
  // ====================================================================
  const lines = new Map();
  let dragTargets = [];
  let preview = null;
  function syncLines() {
    const desired = new Map();
    const want = (k, o) => desired.set(k, o);
    dragTargets = [];
    if (ticks && ticks.n) {
      for (const l of HL.list) {
        const sel = l.id === HL.selected;
        want('hl' + l.id, { price: l.price, color: l.color, lineWidth: sel ? 2 : 1, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: true, title: sel ? '◆' : '' });
        dragTargets.push({ kind: 'hline', obj: l, price: l.price });
      }
      const mode = tradeMode();
      if (mode) {
        if (S.askLine) want('ask', { price: askNow(), color: '#ff5c5c', lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: '' });
        const val = vpp();
        for (const p of posList()) {
          const lp = pnlOf(p);
          want(`p${p.id}`, { price: p.entry, color: p.side === 'buy' ? '#2fd16b' : '#ff5c5c', lineWidth: 1, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: true, title: `#${p.id} ${p.side.toUpperCase()} ${p.lots}  ${money(lp.pnl)}` });
          dragTargets.push({ kind: 'posEntry', obj: p, price: p.entry });
          for (const f of ['sl', 'tp']) if (p[f] != null) {
            const pts = (p[f] - p.entry) * dir(p.side);
            want(`p${p.id}${f}`, { price: p[f], color: f === 'sl' ? '#ff5252' : '#00c853', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: `${f.toUpperCase()} #${p.id}  ${money(pts * p.lots * val)}` });
            dragTargets.push({ kind: 'posStop', obj: p, field: f, price: p[f] });
          }
        }
        for (const o of ordList()) {
          want(`o${o.id}`, { price: o.price, color: '#5aa2ff', lineWidth: 1, lineStyle: LWC.LineStyle.LargeDashed, axisLabelVisible: true, title: `#${o.id} ${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.lots}` });
          dragTargets.push({ kind: 'order', obj: o, price: o.price });
          for (const f of ['sl', 'tp']) if (o[f] != null) {
            const pts = (o[f] - o.price) * dir(o.side);
            want(`o${o.id}${f}`, { price: o[f], color: f === 'sl' ? '#ff5252aa' : '#00c853aa', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: `${f.toUpperCase()} #${o.id}  ${money(pts * o.lots * val)}` });
            dragTargets.push({ kind: 'orderStop', obj: o, field: f, price: o[f] });
          }
        }
        if (preview) want('preview', { price: preview.price, color: preview.color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: preview.title });
      }
    }
    for (const [k, line] of lines) if (!desired.has(k)) { candleSeries.removePriceLine(line); lines.delete(k); }
    for (const [k, opts] of desired) {
      const line = lines.get(k);
      if (line) line.applyOptions(opts); else lines.set(k, candleSeries.createPriceLine(opts));
    }
  }

  function refreshMarkers() {
    const mode = tradeMode();
    if (!C || !mode) { candleSeries.setMarkers([]); return; }
    const mk = [];
    const add = (tick, m) => { if (tick < 0 || tick >= ticks.n) return; const ci = D.candleOfTick(C, tick); if (ci <= R.shownCi) mk.push({ time: ci, ...m }); };
    const arrow = p => ({ position: p.side === 'buy' ? 'belowBar' : 'aboveBar', shape: p.side === 'buy' ? 'arrowUp' : 'arrowDown', color: p.side === 'buy' ? '#2f81f7' : '#ff7043', text: `#${p.id}` });
    if (mode === 'paper') {
      for (const h of TR.history) {
        add(h.entryTick, arrow(h));
        add(h.exitTick, { position: h.side === 'buy' ? 'aboveBar' : 'belowBar', shape: 'circle', color: h.pnl >= 0 ? '#2fd16b' : '#ff5c5c', text: money(h.pnl) });
      }
      for (const p of TR.positions) add(p.entryTick, arrow(p));
    } else {
      for (const p of LIVE.positions) if (p.time_msc >= ticks.t[0]) add(Math.min(ticks.n - 1, D.tickAtOrAfter(ticks, p.time_msc)), arrow(p));
    }
    mk.sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(mk);
  }

  function validStop(side, field, level, ref) {
    const md = minStopDist();
    if (field === 'sl') return side === 'buy' ? level < ref - md : level > ref + md;
    return side === 'buy' ? level > ref + md : level < ref - md;
  }

  // ====================================================================
  // Pointer input: drag lines, select lines, tap to place — mouse and touch
  // ====================================================================
  let drag = null, tapStart = null;
  const pt = e => { const t = e.touches ? (e.touches[0] || e.changedTouches[0]) : e; return { x: t.clientX, y: t.clientY }; };
  function rel(p) { const r = chartEl.getBoundingClientRect(); return { x: p.x - r.left, y: p.y - r.top, w: r.width, h: r.height }; }
  function inPane(p) {
    const q = rel(p);
    return q.x >= 0 && q.y >= 0 && q.x < q.w - chart.priceScale('right').width() && q.y < q.h - chart.timeScale().height();
  }
  function hitTest(p, tol) {
    if (!dragTargets.length || !inPane(p)) return null;
    const y = rel(p).y;
    let best = null, bestD = tol;
    for (const t of dragTargets) {
      const c = candleSeries.priceToCoordinate(t.price);
      if (c === null) continue;
      const d = Math.abs(c - y);
      if (d < bestD || (d === bestD && t.kind !== 'hline')) { bestD = d; best = t; }
    }
    return best;
  }
  const priceAtY = y => { const p = candleSeries.coordinateToPrice(y); return p === null ? null : roundP(p); };
  function stopEvt(e) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }

  function onDown(e) {
    const touch = e.type === 'touchstart';
    if (!touch && e.button !== 0) return;
    if (touch && e.touches.length > 1) return;
    const p = pt(e);
    if (!C || !inPane(p)) return;
    if (R.picking || TR.placing) { stopEvt(e); tapStart = p; return; }
    const t = hitTest(p, touch ? 18 : 6);
    if (!t) { if (HL.selected) { HL.selected = null; syncLines(); scheduleUI(); } return; }
    stopEvt(e);
    pause();
    const o = t.obj;
    drag = { t, start: p, moved: false, touch, orig: { price: o.price, entry: o.entry, sl: o.sl, tp: o.tp } };
    chart.applyOptions({ handleScroll: false, handleScale: false });
    if (touch) { document.addEventListener('touchmove', onMove, { passive: false }); document.addEventListener('touchend', onUp); document.addEventListener('touchcancel', onUp); }
    else { document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); }
  }
  function onMove(e) {
    if (!drag) return;
    if (e.cancelable) e.preventDefault();
    const p = pt(e);
    if (!drag.moved && Math.abs(p.y - drag.start.y) < (drag.touch ? 6 : 3)) return;
    drag.moved = true;
    const price = priceAtY(rel(p).y);
    if (price === null) return;
    const { t } = drag, o = t.obj;
    if (t.kind === 'hline') o.price = price;
    else if (t.kind === 'posStop' || t.kind === 'orderStop') o[t.field] = price;
    else if (t.kind === 'order') {
      const d = price - o.price;
      o.price = price;
      if (o.sl != null) o.sl = roundP(o.sl + d);
      if (o.tp != null) o.tp = roundP(o.tp + d);
    } else if (t.kind === 'posEntry') {
      const pts = (price - o.entry) * dir(o.side), isTP = pts > 0;
      preview = { price, color: isTP ? '#00c853' : '#ff5252', title: `${isTP ? 'TP' : 'SL'} #${o.id}  ${money(pts * o.lots * vpp())}` };
    }
    syncLines(); drawLineMenu();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onUp); document.removeEventListener('touchcancel', onUp);
    chart.applyOptions({ handleScroll: true, handleScale: true });
    if (!drag) return;
    const { t, orig, moved } = drag;
    drag = null;
    const o = t.obj;
    if (!moved) {
      if (t.kind === 'hline') { HL.selected = o.id; syncLines(); scheduleUI(); }
      return;
    }
    const b = bidNow(), a = askNow();
    if (t.kind === 'hline') { saveLines(); scheduleUI(); return; }
    if (t.kind === 'posStop') {
      const nv = o[t.field]; o[t.field] = orig[t.field];
      if (!validStop(o.side, t.field, nv, o.side === 'buy' ? b : a)) { toast(`That ${t.field.toUpperCase()} is too close to the price or on the wrong side`); render(false); return; }
      setPosStops(o, t.field === 'sl' ? nv : o.sl, t.field === 'tp' ? nv : o.tp);
    } else if (t.kind === 'orderStop') {
      const nv = o[t.field]; o[t.field] = orig[t.field];
      if (!validStop(o.side, t.field, nv, o.price)) { toast(`Invalid ${t.field.toUpperCase()} for this order`); render(false); return; }
      modifyOrder(o, o.price, t.field === 'sl' ? nv : o.sl, t.field === 'tp' ? nv : o.tp);
    } else if (t.kind === 'order') {
      const np = o.price, nsl = o.sl, ntp = o.tp;
      Object.assign(o, { price: orig.price, sl: orig.sl, tp: orig.tp });
      const nt = orderType(o.side, np);
      if (nt !== o.type) {
        if (tradeMode() === 'live') { toast('Moving an order across the market would change its type. Cancel it and place a new one.', 5000); render(false); return; }
        o.type = nt; toast(`Order changed to ${o.side.toUpperCase()} ${nt.toUpperCase()}`);
      }
      modifyOrder(o, np, nsl, ntp);
    } else if (t.kind === 'posEntry' && preview) {
      const price = preview.price;
      preview = null;
      const field = (price - o.entry) * dir(o.side) > 0 ? 'tp' : 'sl';
      if (!validStop(o.side, field, price, o.side === 'buy' ? b : a)) { toast(`That ${field.toUpperCase()} is too close to the price or on the wrong side`); render(false); return; }
      setPosStops(o, field === 'sl' ? price : o.sl, field === 'tp' ? price : o.tp);
    }
    preview = null;
    render(false);
  }
  function onTapEnd(e) {
    if (!tapStart) return;
    const p = pt(e);
    const moved = Math.hypot(p.x - tapStart.x, p.y - tapStart.y);
    tapStart = null;
    if (moved > 10) return;
    stopEvt(e);
    const q = rel(p);
    if (R.picking) {
      const logical = chart.timeScale().coordinateToLogical(q.x);
      if (logical === null) return;
      const idx = Math.min(R.active ? R.shownCi : C.n - 1, Math.max(0, Math.round(logical)));
      startReplayAt(C.end[idx]);
    } else if (TR.placing) {
      const price = priceAtY(q.y);
      const what = TR.placing;
      cancelPlacing();
      if (price === null) return;
      if (what === 'hline') addLine(price); else placePending(what, price);
    }
  }
  chartEl.addEventListener('mousedown', onDown, true);
  chartEl.addEventListener('touchstart', onDown, { capture: true, passive: false });
  chartEl.addEventListener('mouseup', onTapEnd, true);
  chartEl.addEventListener('touchend', onTapEnd, { capture: true, passive: false });
  chartEl.addEventListener('mousemove', e => {
    if (drag) return;
    chartEl.classList.toggle('drag-hover', !!hitTest(pt(e), 6) && !TR.placing && !R.picking);
  });

  $('btnBuy').addEventListener('click', () => marketOrder('buy'));
  $('btnSell').addEventListener('click', () => marketOrder('sell'));
  $('btnBuyLimit').addEventListener('click', () => TR.placing === 'buy' ? cancelPlacing() : startPlacing('buy'));
  $('btnSellLimit').addEventListener('click', () => TR.placing === 'sell' ? cancelPlacing() : startPlacing('sell'));
  $('ocConfirm').addEventListener('change', e => { S.trade.confirm = !e.target.checked; saveSettings(); });

  // ====================================================================
  // Tables + account summary
  // ====================================================================
  function drawTables() {
    const mode = tradeMode();
    const rows = [];
    if (ticks && mode) {
      for (const p of posList()) {
        const lp = pnlOf(p), cls = lp.pnl >= 0 ? 'pos' : 'neg';
        rows.push(`<tr><td>${p.id}</td><td>${p.side}</td><td>${p.lots}</td><td>${fmtP(p.entry)}</td>
          <td>${p.sl != null ? fmtP(p.sl) + ` <button class="x" data-act="rmsl" data-id="${p.id}" title="Remove S/L">✕</button>` : `<button class="lnk" data-act="addsl" data-id="${p.id}">+SL</button>`}</td>
          <td>${p.tp != null ? fmtP(p.tp) + ` <button class="x" data-act="rmtp" data-id="${p.id}" title="Remove T/P">✕</button>` : `<button class="lnk" data-act="addtp" data-id="${p.id}">+TP</button>`}</td>
          <td>${fmtP(lp.cur)}</td><td class="${cls}">${lp.points.toFixed(digits())}</td><td class="${cls}">${money(lp.pnl)}</td>
          <td><button class="x" data-act="close" data-id="${p.id}" title="Close position">✕ close</button></td></tr>`);
      }
      for (const o of ordList()) {
        rows.push(`<tr class="pending"><td>${o.id}</td><td>${o.side} ${o.type}</td><td>${o.lots}</td><td>${fmtP(o.price)}</td>
          <td>${o.sl != null ? fmtP(o.sl) : `<button class="lnk" data-act="oaddsl" data-id="${o.id}">+SL</button>`}</td>
          <td>${o.tp != null ? fmtP(o.tp) : `<button class="lnk" data-act="oaddtp" data-id="${o.id}">+TP</button>`}</td>
          <td>${fmtP(o.side === 'buy' ? askNow() : bidNow())}</td><td></td><td>pending</td>
          <td><button class="x" data-act="cancel" data-id="${o.id}" title="Cancel order">✕ cancel</button></td></tr>`);
      }
    }
    const empty = !mode ? (LIVE.bridge ? 'Press ● Live to trade your MT5 account, or start a Replay to paper trade.' : 'Start a replay (⏪ Replay) to paper trade.')
      : 'No open positions. BUY / SELL (keys B / S), or Buy/Sell Limit then tap the chart. Drag lines to move S/L, T/P and orders; drag a position line to add S/L or T/P.';
    const openHtml = rows.join('') || `<tr><td colspan="10" class="muted">${empty}</td></tr>`;
    const openRows = $('openRows');
    if (openRows._html !== openHtml) { openRows.innerHTML = openHtml; openRows._html = openHtml; }

    const hist = TR.history.slice().reverse().map(h => `<tr><td>${h.id}</td><td>${h.side}</td><td>${h.lots}</td><td>${fmtSec(ticks.t[h.entryTick])}</td><td>${fmtP(h.entry)}</td>
      <td>${fmtSec(ticks.t[h.exitTick])}</td><td>${fmtP(h.exit)}</td><td>${h.reason}</td>
      <td class="${h.pnl >= 0 ? 'pos' : 'neg'}">${h.points.toFixed(digits())}</td><td class="${h.pnl >= 0 ? 'pos' : 'neg'}">${money(h.pnl)}</td></tr>`).join('');
    const histRows = $('histRows');
    const histHtml = hist || `<tr><td colspan="10" class="muted">No closed paper trades yet.${LIVE.bridge ? ' Closed live trades are in MT5 (History tab).' : ''}</td></tr>`;
    if (histRows._html !== histHtml) { histRows.innerHTML = histHtml; histRows._html = histHtml; }

    const cur = currency();
    let html;
    if (mode === 'live' && LIVE.account) {
      const a = LIVE.account;
      html = `<span class="acct-tag ${a.demo ? 'demo' : 'real'}">${a.demo ? 'DEMO' : 'LIVE'} ${a.login}</span>` +
        `<span>Balance <b>${a.balance.toFixed(2)}</b> ${a.currency}</span><span>Equity <b>${a.equity.toFixed(2)}</b></span>` +
        `<span>Open <b class="${a.profit >= 0 ? 'pos' : 'neg'}">${money(a.profit)}</b></span><span>Free margin <b>${a.free_margin.toFixed(2)}</b></span>`;
    } else {
      const open = mode === 'paper' ? TR.positions.reduce((s, p) => s + pnlOf(p).pnl, 0) : 0;
      const n = TR.history.length, wins = TR.history.filter(h => h.pnl > 0).length;
      const net = TR.history.reduce((s, h) => s + h.pnl, 0);
      const pts = TR.history.reduce((s, h) => s + h.points, 0);
      html = `<span class="acct-tag paper">PAPER</span><span>Balance <b>${TR.balance.toFixed(2)}</b> ${cur}</span><span>Equity <b>${(TR.balance + open).toFixed(2)}</b></span>` +
        `<span>Open <b class="${open >= 0 ? 'pos' : 'neg'}">${money(open)}</b></span>` +
        `<span>Trades <b>${n}</b>${n ? ` · Win <b>${(wins / n * 100).toFixed(0)}%</b>` : ''}</span>` +
        `<span>Net <b class="${net >= 0 ? 'pos' : 'neg'}">${money(net)}</b> (${pts >= 0 ? '+' : ''}${pts.toFixed(1)} pts)</span>`;
    }
    const acct = $('acct');
    if (acct._html !== html) { acct.innerHTML = html; acct._html = html; }
  }

  $('openRows').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn || !tradeMode()) return;
    const id = +btn.dataset.id, act = btn.dataset.act;
    const p = posList().find(x => x.id === id), o = ordList().find(x => x.id === id);
    const md = minStopDist();
    const dist = () => Math.max(md * 1.5, +S.trade.slPts > 0 ? +S.trade.slPts : Math.max(Math.pow(10, -digits()) * 10, bidNow() * 0.001));
    const distTp = () => Math.max(md * 1.5, +S.trade.tpPts > 0 ? +S.trade.tpPts : dist());
    const ref = p ? (p.side === 'buy' ? bidNow() : askNow()) : 0;
    if (act === 'close' && p) closePos(p);
    else if (act === 'cancel' && o) cancelOrder(o);
    else if (act === 'addsl' && p) setPosStops(p, roundP(ref - dir(p.side) * dist()), p.tp);
    else if (act === 'addtp' && p) setPosStops(p, p.sl, roundP(ref + dir(p.side) * distTp()));
    else if (act === 'rmsl' && p) setPosStops(p, null, p.tp);
    else if (act === 'rmtp' && p) setPosStops(p, p.sl, null);
    else if (act === 'oaddsl' && o) modifyOrder(o, o.price, roundP(o.price - dir(o.side) * dist()), o.tp);
    else if (act === 'oaddtp' && o) modifyOrder(o, o.price, o.sl, roundP(o.price + dir(o.side) * distTp()));
  });

  function tradesCsv() {
    const head = `id,side,lots,open_time (${TT.zoneLabel(S.tz)}),open_price,close_time,close_price,reason,points,profit,sl,tp`;
    const rows = TR.history.map(h => [h.id, h.side, h.lots, fmtIso(ticks.t[h.entryTick]), h.entry, fmtIso(ticks.t[h.exitTick]), h.exit, h.reason, h.points.toFixed(digits()), h.pnl.toFixed(2), h.sl ?? '', h.tp ?? ''].join(','));
    return head + '\n' + rows.join('\n') + '\n';
  }
  $('btnExport').addEventListener('click', () => {
    if (!TR.history.length) return toast('No trades to export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([tradesCsv()], { type: 'text/csv' }));
    a.download = `trades_${symbolKey() || 'tickchart'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  const btnReset = $('btnResetAcct');
  btnReset.addEventListener('click', () => {
    if (btnReset.dataset.armed) {
      clearTimeout(btnReset._t); delete btnReset.dataset.armed; btnReset.textContent = 'Reset paper account';
      resetAccount(false);
    } else {
      btnReset.dataset.armed = '1'; btnReset.textContent = 'Click again to reset';
      btnReset._t = setTimeout(() => { delete btnReset.dataset.armed; btnReset.textContent = 'Reset paper account'; }, 3000);
    }
  });
  $('btnCopyCsv').addEventListener('click', () => {
    if (!TR.history.length) return toast('No trades to copy');
    navigator.clipboard.writeText(tradesCsv()).then(() => toast('Trade log copied. Paste it into Excel or a text file.'))
      .catch(() => toast('Copy was blocked by the browser'));
  });

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabBody').forEach(b => b.classList.toggle('hidden', b.id !== t.dataset.tab));
    if (!S.panelOpen) { S.panelOpen = true; applyPanel(); saveSettings(); }
  }));
  function applyPanel() { $('panel').classList.toggle('collapsed', !S.panelOpen); $('btnPanel').textContent = S.panelOpen ? '▾' : '▴'; }
  $('btnPanel').addEventListener('click', () => { S.panelOpen = !S.panelOpen; applyPanel(); saveSettings(); });
  $('btnInfo').addEventListener('click', () => { S.infoOpen = !S.infoOpen; if (S.infoOpen && narrowScreen()) S.fc.panel = false; saveSettings(); scheduleUI(); });
  const fcHEl = $('fcH');
  fcHEl.value = String(horizon());
  fcHEl.addEventListener('change', () => {
    S.fc.horizon = +fcHEl.value; saveSettings(); fcHEl.blur();
    resetScore(); rebuildForecast(true); FCS.target = -1; render(false);
  });
  $('btnFc').addEventListener('click', () => { S.fc.panel = !S.fc.panel; if (S.fc.panel && narrowScreen()) S.infoOpen = false; saveSettings(); scheduleUI(); });
  applyPanel();

  // ====================================================================
  // Next-candle forecast (pattern matching — see js/forecast.js)
  // ====================================================================
  const FC = TickForecast;
  function resetScore() { FCS.score = { n: 0, hit: 0, cov: 0, confN: 0, confHit: 0, pnl: 0 }; FCS.pending = []; }
  function horizon() { return Math.max(1, Math.min(20, +S.fc.horizon | 0 || 1)); }
  // typical spread (points) of the loaded ticks, used to judge results after costs
  function typicalSpread() {
    if (!ticks || !ticks.n) return 0;
    const step = Math.max(1, Math.floor(ticks.n / 4000)), a = [];
    for (let i = 0; i < ticks.n; i += step) a.push(ticks.ask[i] - ticks.bid[i]);
    a.sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)] || 0;
  }
  // Training candles (bridge) + the loaded candles, as one series for the pattern search.
  function fcData() {
    const tr = FCS.train;
    let n0 = 0;
    if (tr) { while (n0 < tr.t.length && tr.t[n0] < ticks.t[0]) n0++; }
    const n = n0 + C.n;
    const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), t = new Float64Array(n), dur = new Float64Array(n);
    for (let i = 0; i < n0; i++) { o[i] = tr.o[i]; h[i] = tr.h[i]; l[i] = tr.l[i]; c[i] = tr.c[i]; t[i] = tr.t[i]; dur[i] = tr.dur[i]; }
    for (let k = 0; k < C.n; k++) {
      const i = n0 + k;
      o[i] = C.o[k]; h[i] = C.h[k]; l[i] = C.l[k]; c[i] = C.c[k]; t[i] = C.t[k]; dur[i] = ticks.t[C.end[k]] - ticks.t[C.start[k]];
    }
    return { data: { n, o, h, l, c, t, dur }, offset: n0 };
  }
  function rebuildForecast(full) {
    if (!S.fc.on || !C || !ticks) { FCS.model = null; FCS.pred = null; return; }
    const { data, offset } = fcData();
    FCS.model = FC.prepare(data, { ma1: S.ma1, ma2: S.ma2, horizon: horizon(), spread: typicalSpread() });
    FCS.offset = offset;
    if (full) { FCS.target = -1; FCS.pred = null; runValidation(); }
  }
  async function runValidation() {
    const token = ++FCS.valToken;
    FCS.val = null; FCS.valProgress = 0;
    await new Promise(r => setTimeout(r, 60));
    if (token !== FCS.valToken || !FCS.model) return;
    const M = FCS.model;
    const v = await FC.validate(M, M.n, p => { if (token === FCS.valToken) { FCS.valProgress = p; scheduleUI(); } });
    if (token !== FCS.valToken) return;
    FCS.val = v; FCS.valProgress = -1; scheduleUI();
  }
  // Which candle are we forecasting? The forming candle in replay/live, otherwise the next one.
  function fcTarget() {
    if (!C) return -1;
    if (tail()) {
      const ci = R.shownCi;
      return (LIVE.on || curIdx() < C.end[ci]) ? ci : ci + 1;
    }
    return C.n;
  }
  function updateForecast() {
    if (!S.fc.on || !FCS.model) { FCS.pred = null; return; }
    const T = fcTarget();
    if (T === FCS.target) return;
    // score earlier forecasts whose whole window of H candles has now finished (replay / live only)
    if (tail() && FCS.pending.length) {
      const lastDone = T - 1;
      FCS.pending = FCS.pending.filter(q => {
        const E = q.T + q.H - 1;
        if (E > lastDone || E >= C.n) return E <= lastDone + 50;   // keep waiting (drop if replay jumped back)
        if (C.day[E] !== C.day[q.T - 1]) return false;              // window crossed a day boundary
        let hi = -Infinity, lo = Infinity;
        for (let k = q.T; k <= E; k++) { if (C.h[k] > hi) hi = C.h[k]; if (C.l[k] < lo) lo = C.l[k]; }
        const a = q.anchor, y = C.c[E] > a, sc = FCS.score, p = q.pred;
        sc.n++;
        if ((p.pUp > 0.5) === y) sc.hit++;
        sc.cov += ((hi - a) <= p.up80 ? 0.5 : 0) + ((a - lo) <= p.dn80 ? 0.5 : 0);
        if (Math.abs(p.z) >= 2) {
          sc.confN++;
          const long = p.pUp > p.baseUp;
          if (long === y) sc.confHit++;
          sc.pnl += (long ? C.c[E] - a : a - C.c[E]) - (FCS.model ? FCS.model.spread : 0);
        }
        return false;
      });
    }
    if (!tail()) FCS.pending = [];
    FCS.target = T;
    if (T < 1) { FCS.pred = { ok: false, reason: 'not enough candles yet' }; return; }
    const iNow = FCS.offset + T - 1;              // last finished candle
    FCS.anchor = C.c[T - 1];
    FCS.newDay = T < C.n && C.day[T] !== C.day[T - 1];
    const H = FCS.model.H;
    FCS.pred = FC.predict(FCS.model, iNow, iNow - H);   // learns only from outcomes that had finished by now
    if (tail() && FCS.pred.ok && T < C.n + 1) FCS.pending.push({ T, H, pred: FCS.pred, anchor: FCS.anchor });
    if (FCS.pending.length > 100) FCS.pending.shift();
  }
  const pct = x => (x * 100).toFixed(0) + '%';
  function leanOf(p) { return p.z >= 2 ? 'up' : p.z <= -2 ? 'down' : 'flat'; }
  function drawFcPanel() {
    const el = $('fcPanel');
    $('btnFc').classList.toggle('active', !!(S.fc.on && S.fc.panel));
    $('btnFc').classList.toggle('hidden', !S.fc.on); $('fcH').classList.toggle('hidden', !S.fc.on);
    if (!S.fc.on || !S.fc.panel || !C) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const L = [];
    const p = FCS.pred, v = FCS.val;
    const learned = FCS.model ? `${(FCS.model.n).toLocaleString()} candles${FCS.trainDays ? ` (${FCS.trainDays} days from MT5 + loaded)` : ' (loaded data)'}` : '';
    const H = horizon(), what = H === 1 ? 'NEXT CANDLE' : `NEXT ${H} CANDLES`;
    L.push(`<span class="w">${what} · pattern match</span>${FCS.loading ? '  <span class="o">learning from MT5 history…</span>' : ''}`);
    if (!p || !p.ok) {
      L.push(`<span class="m">${p ? p.reason : 'waiting for data'}.</span>`);
      if (!FCS.train) L.push(`<span class="m">${LIVE.bridge ? 'Loading more history from MT5…' : 'Load more days (or use the bridge) for a forecast.'}</span>`);
    } else {
      const lean = leanOf(p);
      const cls = lean === 'up' ? 'g' : lean === 'down' ? 'r' : 'b';
      const verdict = lean === 'up' ? 'leans UP' : lean === 'down' ? 'leans DOWN' : 'no clear edge';
      L.push(`<span class="${cls}">${H === 1 ? '' : `After ${H} candles: `}Up ${pct(p.pUp)}  Down ${pct(1 - p.pUp)}   (normal ${pct(p.baseUp)} up) → ${verdict}</span>`);
      L.push(`<span class="w">${H === 1 ? 'Likely range' : `High/low within ${H}`}  50%: +${p.up50.toFixed(1)} / −${p.dn50.toFixed(1)}   80%: +${p.up80.toFixed(1)} / −${p.dn80.toFixed(1)} pts</span>`);
      const sp = FCS.model ? FCS.model.spread : 0;
      L.push(`<span class="m">Avg move after similar: ${p.move >= 0 ? '+' : ''}${p.move.toFixed(1)} pts (spread ${sp.toFixed(1)}) · ${p.K} most similar of ${p.N.toLocaleString()} past patterns${FCS.newDay ? ' · new day: less reliable' : ''}</span>`);
    }
    if (FCS.valProgress >= 0) L.push(`<span class="m">Testing on unseen data… ${pct(FCS.valProgress)}</span>`);
    else if (v && !v.ok) L.push(`<span class="m">Test: ${v.reason}</span>`);
    else if (v && v.ok) {
      const dirTxt = v.edge ? `<span class="g">direction ${pct(v.acc)} right (coin 50%) → some edge</span>` : `<span class="o">direction ${pct(v.acc)} right (coin 50%) → no reliable edge</span>`;
      const covOk = Math.abs(v.cov80 - 0.8) <= 0.06;
      L.push(`<span class="m">Test on ${v.n} unseen:</span> ${dirTxt} <span class="m">·</span> <span class="${covOk ? 'g' : 'o'}">range band held ${pct(v.cov80)} (aim 80%)</span>`);
      if (v.confN >= 10) {
        const ok = v.pnlConf > 0;
        L.push(`<span class="m">Trading only the leans (${v.confN}×, ${pct(v.confAcc)} right):</span> <span class="${ok ? 'g' : 'r'}">${v.pnlConf >= 0 ? '+' : ''}${v.pnlConf.toFixed(1)} pts per trade after spread</span>`);
      } else L.push(`<span class="m">Too few confident leans in the test (${v.confN}) to judge trading them.</span>`);
    }
    const sc = FCS.score;
    if (tail() && sc.n) L.push(`<span class="w">This ${R.active ? 'replay' : 'session'}: ${sc.hit}/${sc.n} direction right (${pct(sc.hit / sc.n)}) · band held ${pct(sc.cov / sc.n)}${sc.confN ? ` · leans: ${sc.confHit}/${sc.confN}, ${sc.pnl >= 0 ? '+' : ''}${sc.pnl.toFixed(1)} pts after spread` : ''}</span>`);
    if (learned) L.push(`<span class="m">Learning from ${learned}</span>`);
    el.innerHTML = L.join('\n');
  }
  function drawFcBox() {
    const el = $('fcLayer');
    const p = FCS.pred, T = FCS.target;
    if (!S.fc.on || !S.fc.box || !p || !p.ok || !C || T < 1) { el.innerHTML = ''; return; }
    const ts = chart.timeScale();
    const x = ts.logicalToCoordinate(T);
    if (x === null) { el.innerHTML = ''; return; }
    const y = v => candleSeries.priceToCoordinate(v);
    const a = FCS.anchor;
    const yo1 = y(a + p.up80), yo2 = y(a - p.dn80), yi1 = y(a + p.up50), yi2 = y(a - p.dn50), ym = y(a + p.move), ya = y(a);
    if ([yo1, yo2, yi1, yi2, ym, ya].some(v => v === null)) { el.innerHTML = ''; return; }
    const bs = ts.options().barSpacing, H = FCS.model ? FCS.model.H : 1;
    const xEnd = ts.logicalToCoordinate(T + H - 1);
    const span = (xEnd !== null ? xEnd - x : (H - 1) * bs) + bs;
    const w = Math.max(14, H === 1 ? bs * 1.6 : span), left = Math.round(H === 1 ? x - w / 2 : x - bs / 2);
    const cls = 'fc-' + leanOf(p);
    const arrow = p.pUp >= 0.5 ? '▲' : '▼';
    const lab = `${H > 1 ? H + ': ' : ''}${pct(Math.max(p.pUp, 1 - p.pUp))}${arrow}`;
    el.innerHTML =
      `<div class="fc-anchor" style="left:${left - 4}px;width:${w + 8}px;top:${Math.round(ya)}px"></div>` +
      `<div class="fc-box outer ${cls}" style="left:${left}px;width:${w}px;top:${Math.round(yo1)}px;height:${Math.max(2, Math.round(yo2 - yo1))}px"></div>` +
      `<div class="fc-box ${cls}" style="left:${left}px;width:${w}px;top:${Math.round(yi1)}px;height:${Math.max(2, Math.round(yi2 - yi1))}px"></div>` +
      `<div class="fc-mid ${cls}" style="left:${left}px;width:${w}px;top:${Math.round(ym)}px;background:none"></div>` +
      `<div class="fc-label ${cls}" style="left:${left + w + 4}px;top:${Math.round(yo1) - 2}px;background:none">${lab}</div>`;
  }
  // Long training history from MT5 (bridge builds the candles; the phone downloads little)
  async function fetchTraining() {
    if (!S.fc.on || !LIVE.bridge || !ticks || !symInfo()) return;
    const end = Math.floor(ticks.t[0] / DAY) * DAY;
    const days = Math.max(5, Math.min(60, +S.fc.days || 30));
    const from = end - days * DAY;
    const key = [LIVE.symInfo.name, S.tickSize, S.countMode, S.syncDay, end, days].join('|');
    if (key === FCS.trainKey || FCS.loading) return;
    FCS.loading = true; scheduleUI();
    try {
      const q = `symbol=${encodeURIComponent(LIVE.symInfo.name)}&from=${from}&to=${end}&size=${Math.max(2, +S.tickSize | 0)}&mode=${S.countMode}&sync=${S.syncDay ? 1 : 0}`;
      const res = await (await api('api/candles?' + q)).json();
      if (!ticks || Math.floor(ticks.t[0] / DAY) * DAY !== end) return;   // data changed meanwhile
      FCS.train = res; FCS.trainKey = key;
      FCS.trainDays = new Set(res.t.map(t => Math.floor(t / DAY))).size;
      rebuildForecast(true);
      render(false);
    } catch (e) {
      toast('Could not load training history for the forecast: ' + e.message, 6000);
    } finally { FCS.loading = false; scheduleUI(); }
  }

  // ====================================================================
  // Live mode (bridge)
  // ====================================================================
  const liveSymEl = $('liveSymbol'), btnLive = $('btnLive');
  function drawLiveStatus() {
    const el = $('liveStatus');
    if (!LIVE.bridge) { el.className = 'hidden'; return; }
    btnLive.classList.toggle('active', LIVE.on);
    btnLive.textContent = LIVE.on ? '● Live' : '○ Live';
    if (!LIVE.on) { el.className = 'chip'; el.textContent = 'Live off'; return; }
    if (!LIVE.connected) { el.className = 'chip warn'; el.textContent = 'Reconnecting…'; return; }
    const a = LIVE.account;
    el.className = 'chip ' + (a && !a.demo ? 'real' : 'ok');
    el.textContent = a ? `${a.demo ? 'DEMO' : 'LIVE'} ${a.login} · ${a.hedging ? 'hedging' : 'netting'}` : 'Connected';
  }
  async function prevDay(symbol, before) {
    try { return await (await api(`api/prevday?symbol=${encodeURIComponent(symbol)}&before=${before}`)).json(); } catch (e) { return null; }
  }
  async function fetchTicks(symbol, from, to) {
    const txt = await (await api(`api/ticks?symbol=${encodeURIComponent(symbol)}&from=${Math.floor(from)}&to=${Math.ceil(to)}`)).text();
    return D.parseTicks(txt, symbol + '.csv');
  }
  async function refreshInfo() {
    const info = await (await api('api/info')).json();
    LIVE.bridge = info; LIVE.account = info.account; LIVE.trading = info.trading;
    return info;
  }

  async function startLive(symbol) {
    symbol = symbol || liveSymEl.value;
    if (!symbol) return;
    stopReplay(true); stopLive();
    busy(true, `Loading ${symbol} from MT5…`);
    try {
      const info = await refreshInfo();
      LIVE.symInfo = info.symbols.find(s => s.name === symbol) || null;
      const now = info.server_time_ms || (Date.now() + TT.serverOffset(Date.now(), S.tz.server));
      const todayStart = Math.floor(now / DAY) * DAY;
      const pd = await prevDay(symbol, todayStart);          // previous trading day (shown for context)
      const from = pd ? pd.time : todayStart - DAY;
      const pp = await prevDay(symbol, from);                // its previous day: CPR for the first day
      runtimeHLC = pp ? { h: pp.h, l: pp.l, c: pp.c } : null;
      const tk = await fetchTicks(symbol, from, now + 3600000);
      tk.symbol = symbol;
      sources = [];
      LIVE.symbol = symbol; S.liveSymbol = symbol; saveSettings();
      LIVE.on = true;
      setTicks(tk, { quiet: true });
      connectWS();
      toast(`Live: ${symbol}. Showing ${days.map(d => dayName(d.day)).join(' + ')}.`);
    } catch (e) {
      LIVE.on = false;
      toast(`Could not start live data: ${e.message}`, 7000);
    } finally { busy(false); drawLiveStatus(); }
  }
  function stopLive() {
    if (!LIVE.on && !LIVE.ws) return;
    LIVE.on = false;
    clearTimeout(LIVE.reconnectT);
    if (LIVE.ws) { LIVE.ws.onclose = null; try { LIVE.ws.close(); } catch (e) { /* ignore */ } LIVE.ws = null; }
    LIVE.connected = false; LIVE.positions = []; LIVE.orders = [];
    cancelPlacing();
    scheduleUI();
  }
  function connectWS() {
    if (LIVE.ws) { LIVE.ws.onclose = null; try { LIVE.ws.close(); } catch (e) { /* ignore */ } }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    LIVE.ws = ws;
    ws.onopen = () => {
      LIVE.connected = true; LIVE.retry = 0;
      let since = 0, sinceN = 0;
      if (ticks && ticks.n) { since = ticks.t[ticks.n - 1]; for (let i = ticks.n - 1; i >= 0 && ticks.t[i] === since; i--) sinceN++; }
      ws.send(JSON.stringify({ type: 'subscribe', symbol: LIVE.symbol, since, since_n: sinceN }));
      drawLiveStatus();
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'ticks' && m.symbol === LIVE.symbol && LIVE.on) onLiveTicks(m.rows);
      else if (m.type === 'account' && LIVE.on) onSnapshot(m);
    };
    ws.onclose = () => {
      LIVE.connected = false; drawLiveStatus();
      if (!LIVE.on) return;
      const wait = Math.min(10000, 1000 * Math.pow(2, LIVE.retry++));
      LIVE.reconnectT = setTimeout(connectWS, wait);
    };
  }
  function onLiveTicks(rows) {
    if (!ticks || !rows.length) return;
    const n0 = ticks.n;
    D.appendTicks(ticks, rows);
    if (ticks.n === n0) return;
    const cBefore = C.n, dBefore = days.length;
    D.extendCandles(C, ticks);
    D.updateDays(days, ticks, n0);
    if (days.length !== dBefore) rebuildCPRMap();
    if (C.n !== cBefore) { rebuildMAs(); rebuildForecast(false); }
    render(false);
  }
  function onSnapshot(m) {
    LIVE.account = m.account; LIVE.trading = m.trading || LIVE.trading;
    if (drag || LIVE.inflight || performance.now() < LIVE.ignoreSnapUntil) { scheduleUI(); return; }
    LIVE.positions = (m.positions || []).map(p => ({ id: p.ticket, side: p.side, lots: p.lots, entry: p.entry, sl: p.sl, tp: p.tp, profit: p.profit, time_msc: p.time_msc, live: true }));
    LIVE.orders = (m.orders || []).map(o => ({ id: o.ticket, side: o.side, type: o.type, price: o.price, lots: o.lots, sl: o.sl, tp: o.tp, live: true }));
    refreshMarkers(); syncLines(); scheduleUI();
  }
  btnLive.addEventListener('click', () => { if (LIVE.on) { stopLive(); render(true); } else startLive(); });
  liveSymEl.addEventListener('change', () => { liveSymEl.blur(); startLive(liveSymEl.value); });
  $('btnHist').addEventListener('click', async () => {
    const symbol = liveSymEl.value;
    const f = $('histFrom').value, t = $('histTo').value || f;
    if (!f) return toast('Pick the first trading day');
    const from = Date.parse(f + 'T00:00:00Z'), to = Date.parse(t + 'T00:00:00Z') + DAY;
    if (!(to > from)) return toast('The last day must be on or after the first day');
    stopReplay(true); stopLive();
    busy(true, `Loading ${symbol} ${f} → ${t} from MT5…`);
    try {
      await refreshInfo();
      LIVE.symInfo = LIVE.bridge.symbols.find(s => s.name === symbol) || null;
      const pd = await prevDay(symbol, from);
      runtimeHLC = pd ? { h: pd.h, l: pd.l, c: pd.c } : null;
      const tk = await fetchTicks(symbol, from, to);
      tk.symbol = symbol; sources = [];
      LIVE.symbol = symbol;
      setTicks(tk);
    } catch (e) { toast(`Could not load history: ${e.message}`, 7000); }
    finally { busy(false); drawLiveStatus(); }
  });

  async function detectBridge() {
    if (!/^https?:$/.test(location.protocol)) return;
    let info;
    try { info = await refreshInfo(); } catch (e) { return; }
    document.body.classList.add('bridge');
    liveSymEl.innerHTML = info.symbols.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    if (info.symbols.some(s => s.name === S.liveSymbol)) liveSymEl.value = S.liveSymbol;
    const today = isoDate(info.server_time_ms || Date.now());
    $('histFrom').value = today; $('histTo').value = today;
    lotsEl.max = info.limits.max_lots;
    // Check the time-zone rule against the live server clock (only meaningful while ticks are fresh)
    if (info.server_time_ms) {
      const chk = TT.ruleMatches(info.server_time_ms, S.tz);
      if (Math.abs(info.server_time_ms - (info.now_ms + chk.measured * 3600000)) < 600000 && chk.measured !== chk.expected)
        toast(`Note: the MT5 server looks like GMT${chk.measured >= 0 ? '+' : ''}${chk.measured}. Check Settings → Time if times look wrong.`, 8000);
    }
    drawLiveStatus();
    if (info.symbols.length) startLive(liveSymEl.value);
  }

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
    const fromMt5 = !!symInfo();
    form.elements.vpp.disabled = fromMt5; form.elements.cur.disabled = fromMt5;
    $('vppNote').textContent = fromMt5 ? 'Taken from MT5 for this symbol.' : 'Saved per symbol, in your account currency (USD). GER40: 10 EUR per point per lot ≈ 11.6 USD (changes with EUR/USD). XAUUSD: 100 USD. With the bridge, MT5 supplies the exact value.';
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const before = JSON.stringify([S.countMode, S.syncDay]);
    const beforeHLC = JSON.stringify(S.firstHLC);
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      const v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (el.value === '' ? 0 : +el.value) : el.value);
      if (el.name === 'vpp') { if (ticks) S.vppBySymbol[symbolKey()] = v; continue; }
      if (el.name === 'cur') { if (ticks) S.curBySymbol[symbolKey()] = v; continue; }
      setPath(S, el.name, v);
    }
    saveSettings();
    applySeriesStyles();
    if (!ticks) return;
    if (JSON.stringify(S.firstHLC) !== beforeHLC) rebuildCPRMap();
    if (JSON.stringify([S.countMode, S.syncDay]) !== before) rebuildCandles(); else { rebuildMAs(); rebuildForecast(true); }
    R.shownCi = -1; FCS.target = -1;
    $('fcH').value = String(horizon());
    render(true);
    fetchTraining();
    chart.applyOptions({});   // refresh time labels for a new time zone
  });

  // ====================================================================
  // Keyboard
  // ====================================================================
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea') || dlg.open || confirmDlg.open) return;
    if (e.key === 'Escape') { cancelPlacing(); if (R.picking) btnReplay.click(); if (HL.selected) { HL.selected = null; syncLines(); scheduleUI(); } return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && HL.selected) { e.preventDefault(); deleteSelectedLine(); return; }
    if (e.key === 'h' || e.key === 'H') { if (ticks) startPlacing('hline'); return; }
    if (tradeMode() && (e.key === 'b' || e.key === 'B')) { marketOrder('buy'); return; }
    if (tradeMode() && (e.key === 's' || e.key === 'S')) { marketOrder('sell'); return; }
    if (!R.active) return;
    if (e.code === 'Space') { e.preventDefault(); R.playing ? pause() : play(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); advanceTo(e.shiftKey ? R.cursor + 1 : endOfNextCandle(R.cursor)); }
  });

  ['speedMode', 'speed', 'tickSize', 'demoSelect'].forEach(id => $(id).addEventListener('change', e => e.target.blur()));
  document.querySelectorAll('#toolbar button, #oneClick button, #panel button').forEach(el => el.addEventListener('click', () => el.blur()));

  setReplayButtons();
  applySeriesStyles();
  drawTables();
  detectBridge();

  window.TickChartApp = {
    get ticks() { return ticks; }, get candles() { return C; }, R, TR, LIVE, HL, S, FCS,
    setTicks, startReplayAt, advanceTo, marketOrder, placePending, addLine, startLive, stopLive, chart, candleSeries
  };
})();
