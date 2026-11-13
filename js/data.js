/* Tick Chart — data layer: parsing MT5 tick exports, building tick candles,
   daily OHLC + CPR levels, and moving averages.
   All timestamps are MT5 *server time* stored as if they were UTC milliseconds,
   so a "day" is simply floor(t / 86400000) and matches the broker's day rollover. */
(function (global) {
  'use strict';

  const DAY_MS = 86400000;
  // MT5 tick flags
  const FLAG_BID = 2, FLAG_ASK = 4;

  // ---------- File decoding ----------
  function decodeBuffer(buf) {
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
    // UTF-16LE without BOM: every second byte of ASCII text is 0
    if (b.length >= 4 && b[1] === 0 && b[3] === 0 && b[0] !== 0) return new TextDecoder('utf-16le').decode(buf);
    return new TextDecoder('utf-8').decode(buf);
  }

  // ---------- Timestamp parsing (fast, cached per date string) ----------
  const dateCache = new Map();
  function parseDatePart(s) {
    let v = dateCache.get(s);
    if (v !== undefined) return v;
    // accepts 2026.11.12, 2026-11-12, 2026/11/12, 20261112
    let y, m, d;
    if (s.length === 8 && /^\d{8}$/.test(s)) { y = +s.slice(0, 4); m = +s.slice(4, 6); d = +s.slice(6, 8); }
    else { const p = s.split(/[.\-\/]/); y = +p[0]; m = +p[1]; d = +p[2]; }
    v = Date.UTC(y, m - 1, d);
    dateCache.set(s, v);
    return v;
  }
  function parseTimePart(s) {
    // HH:MM:SS(.mmm)
    const h = (s.charCodeAt(0) - 48) * 10 + (s.charCodeAt(1) - 48);
    const mi = (s.charCodeAt(3) - 48) * 10 + (s.charCodeAt(4) - 48);
    const se = s.length >= 8 ? (s.charCodeAt(6) - 48) * 10 + (s.charCodeAt(7) - 48) : 0;
    let ms = 0;
    if (s.length > 9) { const frac = s.slice(9, 12); ms = +frac.padEnd(3, '0'); }
    return ((h * 60 + mi) * 60 + se) * 1000 + ms;
  }

  // ---------- Tick file parser ----------
  // Supports:
  //  A) MT5 Symbols > Ticks > Export:  <DATE> <TIME> <BID> <ASK> <LAST> <VOLUME> <FLAGS>  (tab separated, empty = unchanged)
  //  B) ExportTicks.mq5 script:        time_msc,bid,ask,last,volume,flags   (+ optional "#key=value" meta lines)
  //  C) Generic:                       datetime,bid,ask  /  date,time,bid,ask
  function parseTicks(text, fileName) {
    const meta = {};
    let pos = 0;
    const len = text.length;
    function nextLine() {
      if (pos >= len) return null;
      let e = text.indexOf('\n', pos);
      if (e < 0) e = len;
      let line = text.slice(pos, e);
      pos = e + 1;
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
      return line;
    }

    // Read meta + header
    let header = null;
    let firstData = null;
    while (true) {
      const line = nextLine();
      if (line === null) break;
      if (!line.trim()) continue;
      if (line[0] === '#') {
        line.slice(1).split(/[,;]/).forEach(kv => {
          const i = kv.indexOf('=');
          if (i > 0) meta[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
        });
        continue;
      }
      if (/[a-df-zA-DF-Z<]/.test(line.replace(/e[+-]?\d/gi, ''))) { header = line; } else { firstData = line; }
      break;
    }
    if (!header && !firstData) throw new Error('File is empty');

    const sample = header || firstData;
    const delim = sample.indexOf('\t') >= 0 ? '\t' : (sample.indexOf(';') >= 0 ? ';' : ',');

    let col = { date: -1, time: -1, datetime: -1, msc: -1, bid: -1, ask: -1, flags: -1 };
    if (header) {
      header.split(delim).forEach((h, i) => {
        const k = h.replace(/[<>"\s]/g, '').toLowerCase();
        if (k === 'date') col.date = i;
        else if (k === 'time') col.time = i;
        else if (k === 'datetime' || k === 'timestamp') col.datetime = i;
        else if (k === 'time_msc' || k === 'timemsc' || k === 'msc') col.msc = i;
        else if (k === 'bid') col.bid = i;
        else if (k === 'ask') col.ask = i;
        else if (k === 'flags') col.flags = i;
      });
    } else {
      // headerless: guess
      const p = firstData.split(delim);
      if (/^\d{12,}$/.test(p[0])) { col.msc = 0; col.bid = 1; col.ask = 2; }
      else if (p[0].indexOf(' ') > 0) { col.datetime = 0; col.bid = 1; col.ask = 2; }
      else { col.date = 0; col.time = 1; col.bid = 2; col.ask = 3; }
    }
    if (col.bid < 0) throw new Error('Could not find a BID column in the file header');
    if (col.msc < 0 && col.datetime < 0 && (col.date < 0 || col.time < 0))
      throw new Error('Could not find time columns (expected DATE + TIME, or time_msc)');

    // Allocate growable typed arrays
    let cap = Math.max(1024, Math.floor(len / 40));
    let T = new Float64Array(cap), B = new Float64Array(cap), A = new Float64Array(cap), F = new Uint8Array(cap);
    let n = 0;
    let lastBid = NaN, lastAsk = NaN, lastT = -Infinity;
    let maxDec = 0;

    function grow() {
      cap *= 2;
      const t2 = new Float64Array(cap); t2.set(T); T = t2;
      const b2 = new Float64Array(cap); b2.set(B); B = b2;
      const a2 = new Float64Array(cap); a2.set(A); A = a2;
      const f2 = new Uint8Array(cap); f2.set(F); F = f2;
    }
    function decimals(s) { const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }

    let decSamples = 0;
    function handle(line) {
      if (!line) return;
      const p = line.split(delim);
      let t;
      if (col.msc >= 0) t = +p[col.msc];
      else if (col.datetime >= 0) {
        const s = p[col.datetime].trim(); const sp = s.indexOf(' ') >= 0 ? s.indexOf(' ') : s.indexOf('T');
        t = parseDatePart(s.slice(0, sp)) + parseTimePart(s.slice(sp + 1));
      } else t = parseDatePart(p[col.date].trim()) + parseTimePart(p[col.time].trim());
      if (!isFinite(t)) return;

      const bs = p[col.bid], as = col.ask >= 0 ? p[col.ask] : undefined;
      let flags = col.flags >= 0 ? (+p[col.flags] || 0) : 0;
      let bidChanged = false, askChanged = false;
      if (bs !== undefined && bs !== '') { const v = +bs; if (v > 0) { if (v !== lastBid) bidChanged = true; lastBid = v; if (decSamples < 2000) { maxDec = Math.max(maxDec, decimals(bs.trim())); decSamples++; } } }
      if (as !== undefined && as !== '') { const v = +as; if (v > 0) { if (v !== lastAsk) askChanged = true; lastAsk = v; } }
      if (col.ask < 0) lastAsk = lastBid;
      if (!(lastBid > 0) || !(lastAsk > 0)) return; // wait until both sides known
      if (!(bidChanged || askChanged) && col.flags < 0) return; // duplicate row
      if (col.flags < 0) flags = (bidChanged ? FLAG_BID : 0) | (askChanged ? FLAG_ASK : 0);
      if (t < lastT) t = lastT; // keep monotonic
      lastT = t;
      if (n >= cap) grow();
      T[n] = t; B[n] = lastBid; A[n] = lastAsk; F[n] = flags; n++;
    }
    if (firstData) handle(firstData);
    while (true) { const line = nextLine(); if (line === null) break; handle(line); }
    if (n === 0) throw new Error('No valid ticks found in file');

    let symbol = meta.symbol || '';
    if (!symbol && fileName) {
      const m = fileName.replace(/\.[^.]+$/, '').match(/^([A-Za-z0-9.#_]+?)(?:[_\- ]|$)/);
      if (m) symbol = m[1];
    }
    const digits = meta.digits !== undefined ? +meta.digits : maxDec;
    return {
      n, t: T.subarray(0, n), bid: B.subarray(0, n), ask: A.subarray(0, n), flags: F.subarray(0, n),
      digits, symbol: symbol || 'SYMBOL', meta
    };
  }

  // ---------- Demo data (random walk) ----------
  function makeDemoTicks(symbol) {
    const gold = /XAU/i.test(symbol);
    const digits = 2;
    const days = 5;
    const out = { t: [], bid: [], ask: [] };
    let price = gold ? 2650 : 26700;
    let anchor = price;
    const vol = gold ? 0.05 : 0.5;
    const spread = gold ? 0.25 : 1.2;
    // mulberry32: a proper PRNG (the old LCG overflowed JS number precision and repeated patterns)
    let seed = gold ? 2654435 : 1234567;
    function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
    function gauss() { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
    const start = Date.UTC(2026, 10, 9); // Mon 9 Nov 2026
    let drift = 0;
    for (let d = 0; d < days; d++) {
      const dayStart = start + d * DAY_MS;
      let t = dayStart + (gold ? 60 : 9 * 3600) * 1000;
      const end = dayStart + (gold ? 23.9 : 23) * 3600000;
      while (t < end) {
        const hour = (t - dayStart) / 3600000;
        const active = gold ? (hour > 9 && hour < 20 ? 1 : 0.35) : (hour > 10 && hour < 18.5 ? 1 : 0.3);
        t += Math.max(20, -Math.log(rnd() + 1e-9) * (gold ? 700 : 450) / active);
        if (rnd() < 0.0005) drift = (rnd() - 0.5) * vol * 0.06;
        anchor += drift;
        price += gauss() * vol * Math.sqrt(active) + (anchor - price) * 0.00004;
        const b = Math.round(price * 100) / 100;
        out.t.push(t); out.bid.push(b); out.ask.push(Math.round((b + spread * (0.8 + rnd() * 0.5)) * 100) / 100);
      }
    }
    const n = out.t.length;
    const flags = new Uint8Array(n).fill(FLAG_BID | FLAG_ASK);
    return { n, t: Float64Array.from(out.t), bid: Float64Array.from(out.bid), ask: Float64Array.from(out.ask), flags, digits, symbol: (gold ? 'XAUUSD' : 'GER40') + ' (demo)', meta: {} };
  }

  // ---------- Growable tick store (for live data) ----------
  function growArr(a, need) {
    if (need <= a.length) return a;
    const b = new a.constructor(Math.max(need, a.length * 2, 1024));
    b.set(a);
    return b;
  }
  // Append ticks: rows = [[time_msc, bid, ask, flags], ...] (must be newer than the last tick).
  function appendTicks(tk, rows) {
    const need = tk.n + rows.length;
    tk.t = growArr(tk.t, need); tk.bid = growArr(tk.bid, need); tk.ask = growArr(tk.ask, need); tk.flags = growArr(tk.flags, need);
    let added = 0;
    for (const r of rows) {
      const t = +r[0];
      if (tk.n > 0 && t < tk.t[tk.n - 1]) continue;
      tk.t[tk.n] = t; tk.bid[tk.n] = +r[1]; tk.ask[tk.n] = +r[2]; tk.flags[tk.n] = (+r[3] || 6) & 255; tk.n++; added++;
    }
    return added;
  }
  function emptyTicks(symbol, digits) {
    return { n: 0, t: new Float64Array(1024), bid: new Float64Array(1024), ask: new Float64Array(1024), flags: new Uint8Array(1024), digits, symbol, meta: {} };
  }

  // ---------- Tick candles (incremental) ----------
  // countMode: 'all' = every tick record counts; 'bid' = only ticks where bid changed.
  // syncDay: start a fresh candle at the first tick of each new (server) day.
  function createCandles(size, countMode, syncDay, cap) {
    cap = Math.max(256, cap || 0);
    return {
      n: 0, size, countMode, syncDay, nextTick: 0, count: 0, curDay: -1, prevBid: NaN,
      start: new Int32Array(cap), end: new Int32Array(cap), day: new Int32Array(cap),
      o: new Float64Array(cap), h: new Float64Array(cap), l: new Float64Array(cap), c: new Float64Array(cap), t: new Float64Array(cap)
    };
  }
  // Process ticks C.nextTick .. ticks.n-1. Returns index of the first candle that changed.
  function extendCandles(C, ticks) {
    const n = ticks.n, T = ticks.t, B = ticks.bid, F = ticks.flags;
    const bidOnly = C.countMode === 'bid', size = C.size;
    const firstChanged = Math.max(0, C.n - 1);
    for (let i = C.nextTick; i < n; i++) {
      const day = Math.floor(T[i] / DAY_MS);
      const counts = !bidOnly || (F[i] & FLAG_BID) || B[i] !== C.prevBid;
      C.prevBid = B[i];
      if (C.n === 0 || (C.syncDay && day !== C.curDay) || (C.count >= size && counts)) {
        const m = C.n;
        if (m >= C.start.length) {
          const need = m + 1;
          C.start = growArr(C.start, need); C.end = growArr(C.end, need); C.day = growArr(C.day, need);
          C.o = growArr(C.o, need); C.h = growArr(C.h, need); C.l = growArr(C.l, need); C.c = growArr(C.c, need); C.t = growArr(C.t, need);
        }
        C.start[m] = i; C.end[m] = i; C.o[m] = C.h[m] = C.l[m] = C.c[m] = B[i]; C.t[m] = T[i]; C.day[m] = day;
        C.n++; C.count = 0; C.curDay = day;
      }
      const k = C.n - 1, p = B[i];
      if (p > C.h[k]) C.h[k] = p; if (p < C.l[k]) C.l[k] = p; C.c[k] = p; C.end[k] = i;
      if (counts) C.count++;
    }
    C.nextTick = n;
    return firstChanged;
  }
  function buildCandles(ticks, size, countMode, syncDay) {
    const C = createCandles(size, countMode, syncDay, Math.ceil(ticks.n / Math.max(1, size)) + 64);
    extendCandles(C, ticks);
    return C;
  }

  // Binary search: index of candle containing tick i
  function candleOfTick(candles, i) {
    let lo = 0, hi = candles.n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (candles.start[mid] <= i) lo = mid; else hi = mid - 1; }
    return lo;
  }
  // First tick index with t >= target (n if none)
  function tickAtOrAfter(ticks, target) {
    let lo = 0, hi = ticks.n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ticks.t[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // ---------- Daily OHLC + CPR ----------
  // Daily OHLC (server days). updateDays continues from tick `from` (pass days.from to resume).
  function updateDays(days, ticks, from) {
    const T = ticks.t, B = ticks.bid;
    let cur = days.length ? days[days.length - 1] : null;
    for (let i = from || 0; i < ticks.n; i++) {
      const d = Math.floor(T[i] / DAY_MS);
      if (!cur || cur.day !== d) { cur = { day: d, start: i, end: i, o: B[i], h: B[i], l: B[i], c: B[i] }; days.push(cur); }
      const p = B[i]; if (p > cur.h) cur.h = p; if (p < cur.l) cur.l = p; cur.c = p; cur.end = i;
    }
    return days;
  }
  function buildDays(ticks) { return updateDays([], ticks, 0); }

  function cprFromHLC(H, L, C) {
    const P = (H + L + C) / 3;
    const BCraw = (H + L) / 2;
    const TCraw = 2 * P - BCraw;
    const TC = Math.max(TCraw, BCraw), BC = Math.min(TCraw, BCraw);
    return {
      P, TC, BC,
      R1: 2 * P - L, S1: 2 * P - H,
      R2: P + (H - L), S2: P - (H - L),
      R3: H + 2 * (P - L), S3: L - 2 * (H - P),
      prevH: H, prevL: L, prevC: C
    };
  }

  // Map day -> levels computed from the previous trading day in the data.
  // `firstDayHLC` optionally supplies the previous day's H/L/C for the first loaded day.
  function buildCPR(days, firstDayHLC) {
    const map = new Map();
    for (let k = 0; k < days.length; k++) {
      if (k > 0) { const p = days[k - 1]; map.set(days[k].day, cprFromHLC(p.h, p.l, p.c)); }
      else if (firstDayHLC && firstDayHLC.h > 0 && firstDayHLC.l > 0 && firstDayHLC.c > 0)
        map.set(days[k].day, cprFromHLC(firstDayHLC.h, firstDayHLC.l, firstDayHLC.c));
    }
    return map;
  }

  // ---------- Moving averages (MT5 methods: SMA, EMA, SMMA, LWMA) ----------
  function computeMA(type, period, closes, n) {
    const out = new Float64Array(n).fill(NaN);
    if (period < 1 || n < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    if (type === 'SMA') {
      out[period - 1] = sum / period;
      for (let i = period; i < n; i++) { sum += closes[i] - closes[i - period]; out[i] = sum / period; }
    } else if (type === 'EMA') {
      const k = 2 / (period + 1); let v = sum / period; out[period - 1] = v;
      for (let i = period; i < n; i++) { v += k * (closes[i] - v); out[i] = v; }
    } else if (type === 'SMMA') {
      let v = sum / period; out[period - 1] = v;
      for (let i = period; i < n; i++) { v = (v * (period - 1) + closes[i]) / period; out[i] = v; }
    } else { // LWMA
      const den = period * (period + 1) / 2;
      for (let i = period - 1; i < n; i++) { let s = 0; for (let j = 0; j < period; j++) s += closes[i - j] * (period - j); out[i] = s / den; }
    }
    return out;
  }
  // Value of the MA on candle i if its close were `close` (used for the still-forming candle in replay).
  function maLive(type, period, ma, closes, i, close) {
    if (i < period - 1) return NaN;
    if (type === 'EMA' || type === 'SMMA') {
      if (i === period - 1) { let s = close; for (let j = 1; j < period; j++) s += closes[i - j]; return s / period; }
      const prev = ma[i - 1];
      return type === 'EMA' ? prev + (2 / (period + 1)) * (close - prev) : (prev * (period - 1) + close) / period;
    }
    if (type === 'SMA') { let s = close; for (let j = 1; j < period; j++) s += closes[i - j]; return s / period; }
    let s = close * period; for (let j = 1; j < period; j++) s += closes[i - j] * (period - j);
    return s / (period * (period + 1) / 2);
  }

  // ---------- Merge several tick files (e.g. one per day) ----------
  // Files may be given in any order and may overlap; overlapping ticks are dropped.
  function mergeTicks(list) {
    list = list.filter(x => x && x.n > 0).sort((a, b) => a.t[0] - b.t[0]);
    if (list.length === 1) return list[0];
    let total = 0; for (const x of list) total += x.n;
    const T = new Float64Array(total), B = new Float64Array(total), A = new Float64Array(total), F = new Uint8Array(total);
    let n = 0, lastT = -Infinity, digits = 0;
    for (const x of list) {
      digits = Math.max(digits, x.digits);
      for (let i = 0; i < x.n; i++) {
        if (x.t[i] <= lastT && n > 0 && i === 0) { // overlap: skip until past what we already have
          while (i < x.n && x.t[i] <= lastT) i++;
          if (i >= x.n) break;
        }
        T[n] = x.t[i]; B[n] = x.bid[i]; A[n] = x.ask[i]; F[n] = x.flags[i]; n++;
        lastT = x.t[i];
      }
    }
    return { n, t: T.subarray(0, n), bid: B.subarray(0, n), ask: A.subarray(0, n), flags: F.subarray(0, n), digits, symbol: list[0].symbol, meta: list[0].meta };
  }

  global.TickData = {
    DAY_MS, decodeBuffer, parseTicks, mergeTicks, appendTicks, emptyTicks, createCandles, extendCandles, updateDays, makeDemoTicks, buildCandles, candleOfTick, tickAtOrAfter,
    buildDays, buildCPR, cprFromHLC, computeMA, maLive
  };
})(window);
