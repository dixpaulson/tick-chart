/* Tick Chart — next-candle forecast by pattern matching (k nearest neighbours).
   For every candle we describe "the situation at its close" as a vector of numbers, then for the
   current situation we find the most similar past situations and look at what the NEXT candle did.

   Honest by construction:
   - a forecast for candle T only learns from candles whose outcome was known before T (no peeking)
   - every number comes with its sample size and a comparison to the normal (unconditional) rate
   - validate() tests the method on candles it did not learn from */
(function (global) {
  'use strict';
  const DAY = 86400000;
  const SHAPE = 5;      // candles of shape in the pattern
  const WARM = 110;     // candles needed before features are valid
  const NAMES = [];
  for (let k = SHAPE - 1; k >= 0; k--) NAMES.push(`body-${k}`, `upwick-${k}`, `lowick-${k}`);
  NAMES.push('mom5', 'mom20', 'vsMA1', 'vsMA2', 'MA1slope', 'vsP', 'vsTC', 'vsBC', 'volRegime', 'speed', 'hourSin', 'hourCos');
  const DIM = NAMES.length;
  // relative importance of each feature group in the distance
  const WEIGHT = NAMES.map(n => /wick|body/.test(n) ? 0.55 : /hour/.test(n) ? 0.7 : /vs[PTB]/.test(n) ? 0.8 : 1);

  const clip = (x, a) => x > a ? a : x < -a ? -a : x;

  function rollingMean(src, n, len) {
    const out = new Float64Array(n); let s = 0;
    for (let i = 0; i < n; i++) { s += src[i]; if (i >= len) s -= src[i - len]; out[i] = i >= len - 1 ? s / len : NaN; }
    return out;
  }

  /* data: { n, o, h, l, c, t, dur } candles (oldest first), t = open time (server ms), dur = ms.
     cfg:  { ma1: {type, period}, ma2: {type, period} } */
  function prepare(data, cfg) {
    const { n, o, h, l, c, t, dur } = data;
    const D = global.TickData;
    const rng = new Float64Array(n), logDur = new Float64Array(n), day = new Int32Array(n);
    for (let i = 0; i < n; i++) { rng[i] = h[i] - l[i]; logDur[i] = Math.log(1 + Math.max(0, dur[i]) / 1000); day[i] = Math.floor(t[i] / DAY); }
    const atr = rollingMean(rng, n, 20), atrLong = rollingMean(rng, n, 100), durMean = rollingMean(logDur, n, 50);
    const m1 = D.computeMA(cfg.ma1.type, Math.max(1, +cfg.ma1.period | 0), c, n);
    const m2 = D.computeMA(cfg.ma2.type, Math.max(1, +cfg.ma2.period | 0), c, n);

    // daily CPR from the candles themselves (previous day's H/L/C)
    const cprOfDay = new Map();
    let prev = null, cur = null;
    for (let i = 0; i < n; i++) {
      if (!cur || cur.day !== day[i]) {
        if (cur) prev = cur;
        cur = { day: day[i], h: h[i], l: l[i], c: c[i] };
        if (prev) cprOfDay.set(day[i], D.cprFromHLC(prev.h, prev.l, prev.c));
      }
      if (h[i] > cur.h) cur.h = h[i]; if (l[i] < cur.l) cur.l = l[i]; cur.c = c[i];
    }

    const F = new Float32Array(n * DIM), valid = new Uint8Array(n);
    for (let i = WARM; i < n; i++) {
      const A = atr[i];
      if (!(A > 0) || !(atrLong[i] > 0)) continue;
      let k = i * DIM;
      for (let j = i - SHAPE + 1; j <= i; j++) {
        const top = Math.max(o[j], c[j]), bot = Math.min(o[j], c[j]);
        F[k++] = clip((c[j] - o[j]) / A, 6); F[k++] = clip((h[j] - top) / A, 6); F[k++] = clip((bot - l[j]) / A, 6);
      }
      F[k++] = clip((c[i] - c[i - 5]) / A, 12);
      F[k++] = clip((c[i] - c[i - 20]) / A, 25);
      F[k++] = isFinite(m1[i]) ? clip((c[i] - m1[i]) / A, 12) : 0;
      F[k++] = isFinite(m2[i]) ? clip((c[i] - m2[i]) / A, 15) : 0;
      F[k++] = isFinite(m1[i]) && isFinite(m1[i - 3]) ? clip((m1[i] - m1[i - 3]) / A, 6) : 0;
      const lv = cprOfDay.get(day[i]);
      F[k++] = lv ? clip((c[i] - lv.P) / A, 10) : 0;
      F[k++] = lv ? clip((c[i] - lv.TC) / A, 10) : 0;
      F[k++] = lv ? clip((c[i] - lv.BC) / A, 10) : 0;
      F[k++] = clip(Math.log(A / atrLong[i]), 2);
      F[k++] = isFinite(durMean[i]) ? clip(logDur[i] - durMean[i], 3) : 0;
      const hr = (t[i] % DAY) / 3600000 * Math.PI / 12;
      F[k++] = Math.sin(hr); F[k++] = Math.cos(hr);
      valid[i] = 1;
    }

    // outcomes of the NEXT candle, in units of the current ATR (adapts to quiet / busy markets)
    const has = new Uint8Array(n), up = new Uint8Array(n);
    const mv = new Float32Array(n), ux = new Float32Array(n), dx = new Float32Array(n), rg = new Float32Array(n);
    for (let i = WARM; i < n - 1; i++) {
      if (!valid[i] || day[i + 1] !== day[i]) continue;     // skip day boundaries (overnight gaps)
      const A = atr[i];
      has[i] = 1;
      up[i] = c[i + 1] > c[i] ? 1 : 0;
      mv[i] = (c[i + 1] - c[i]) / A;
      ux[i] = Math.max(0, h[i + 1] - c[i]) / A;
      dx[i] = Math.max(0, c[i] - l[i + 1]) / A;
      rg[i] = (h[i + 1] - l[i + 1]) / A;
    }
    // prefix sums for the normal (unconditional) up-rate before any index
    const cumN = new Int32Array(n + 1), cumUp = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) { cumN[i + 1] = cumN[i] + (has[i] && valid[i] ? 1 : 0); cumUp[i + 1] = cumUp[i] + (has[i] && valid[i] ? up[i] : 0); }

    // standardise features, then apply group weights
    const mean = new Float64Array(DIM), sd = new Float64Array(DIM);
    let cnt = 0;
    for (let i = 0; i < n; i++) if (valid[i]) { cnt++; for (let d = 0; d < DIM; d++) mean[d] += F[i * DIM + d]; }
    for (let d = 0; d < DIM; d++) mean[d] /= Math.max(1, cnt);
    for (let i = 0; i < n; i++) if (valid[i]) for (let d = 0; d < DIM; d++) { const x = F[i * DIM + d] - mean[d]; sd[d] += x * x; }
    for (let d = 0; d < DIM; d++) sd[d] = Math.sqrt(sd[d] / Math.max(1, cnt - 1)) || 1;
    for (let i = 0; i < n; i++) if (valid[i]) for (let d = 0; d < DIM; d++) F[i * DIM + d] = (F[i * DIM + d] - mean[d]) / sd[d] * WEIGHT[d];

    return { n, F, valid, has, up, mv, ux, dx, rg, atr, cumN, cumUp, close: c, day, scratch: { dist: new Float32Array(n), idx: new Int32Array(n) } };
  }

  // quickselect: move the k smallest dist values (by index list) to the front
  function selectK(idx, dist, len, k) {
    let lo = 0, hi = len - 1;
    while (lo < hi) {
      const pv = dist[idx[(lo + hi) >> 1]];
      let i = lo, j = hi;
      while (i <= j) {
        while (dist[idx[i]] < pv) i++;
        while (dist[idx[j]] > pv) j--;
        if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
      }
      if (k - 1 <= j) hi = j; else if (k - 1 >= i) lo = i; else break;
    }
  }
  function quantile(arr, q) {
    const a = Array.from(arr).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const pos = (a.length - 1) * q, b = Math.floor(pos);
    return a[b] + (a[Math.min(a.length - 1, b + 1)] - a[b]) * (pos - b);
  }

  /* Forecast the candle after index i, learning only from samples j <= jMax
     (sample j's outcome is candle j+1, so jMax must be <= i-1 to avoid peeking). */
  function predict(M, i, jMax, opts) {
    if (i < 0 || i >= M.n || !M.valid[i]) return { ok: false, reason: 'not enough candles yet for a pattern' };
    jMax = Math.min(jMax, M.n - 2);
    const { F, valid, has } = M, { dist, idx } = M.scratch;
    let N = 0;
    const base = i * DIM;
    for (let j = WARM; j <= jMax; j++) {
      if (!valid[j] || !has[j]) continue;
      let s = 0; const b = j * DIM;
      for (let d = 0; d < DIM; d++) { const x = F[b + d] - F[base + d]; s += x * x; }
      dist[j] = s; idx[N++] = j;
    }
    const minN = (opts && opts.minSamples) || 300;
    if (N < minN) return { ok: false, reason: `only ${N} past patterns to learn from (need ${minN})`, N };
    const K = Math.max(40, Math.min(250, Math.round(Math.sqrt(N) * 1.3)));
    selectK(idx, dist, N, K);
    let ups = 0, mvs = 0;
    const uxs = new Float32Array(K), dxs = new Float32Array(K), rgs = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      const j = idx[k];
      ups += M.up[j]; mvs += M.mv[j]; uxs[k] = M.ux[j]; dxs[k] = M.dx[j]; rgs[k] = M.rg[j];
    }
    const pUp = ups / K;
    const baseUp = M.cumUp[jMax + 1] / Math.max(1, M.cumN[jMax + 1]);
    const se = Math.sqrt(Math.max(0.01, baseUp * (1 - baseUp)) / K);
    const A = M.atr[i];
    return {
      ok: true, N, K, pUp, baseUp, se, z: (pUp - baseUp) / se,
      move: mvs / K * A,
      up50: quantile(uxs, 0.5) * A, up80: quantile(uxs, 0.8) * A,
      dn50: quantile(dxs, 0.5) * A, dn80: quantile(dxs, 0.8) * A,
      range50: quantile(rgs, 0.5) * A, atr: A,
      // normalised versions (for validation)
      _ux80: quantile(uxs, 0.8), _dx80: quantile(dxs, 0.8), _ux50: quantile(uxs, 0.5), _dx50: quantile(dxs, 0.5), _rg50: quantile(rgs, 0.5)
    };
  }

  /* Out-of-sample test: learn from the first 70% of samples (before endIdx), test on the rest. */
  async function validate(M, endIdx, onProgress) {
    const list = [];
    for (let j = WARM; j < Math.min(endIdx, M.n - 1); j++) if (M.valid[j] && M.has[j]) list.push(j);
    if (list.length < 800) return { ok: false, reason: `needs at least 800 patterns, have ${list.length}. Load more days.` };
    const split = list[Math.floor(list.length * 0.7)];
    const testsAll = list.filter(j => j > split);
    const step = Math.max(1, Math.floor(testsAll.length / 500));
    const tests = testsAll.filter((_, k) => k % step === 0);
    let n = 0, hit = 0, baseHit = 0, confN = 0, confHit = 0, brier = 0, brierBase = 0, cov80 = 0, cov50 = 0, errModel = 0, errNaive = 0;
    for (let k = 0; k < tests.length; k++) {
      const j = tests[k];
      const p = predict(M, j, split - 1, { minSamples: 100 });
      if (!p.ok) continue;
      const y = M.up[j];
      n++;
      if ((p.pUp > 0.5 ? 1 : 0) === y) hit++;
      if ((p.baseUp > 0.5 ? 1 : 0) === y) baseHit++;
      if (Math.abs(p.z) >= 2) { confN++; if ((p.pUp > p.baseUp ? 1 : 0) === y) confHit++; }
      brier += (p.pUp - y) ** 2; brierBase += (p.baseUp - y) ** 2;
      cov80 += (M.ux[j] <= p._ux80 ? 0.5 : 0) + (M.dx[j] <= p._dx80 ? 0.5 : 0);
      cov50 += (M.ux[j] <= p._ux50 ? 0.5 : 0) + (M.dx[j] <= p._dx50 ? 0.5 : 0);
      errModel += Math.abs(p._rg50 - M.rg[j]); errNaive += Math.abs(1 - M.rg[j]);   // naive: next range = recent average
      if (k % 20 === 0) { if (onProgress) onProgress(k / tests.length); await new Promise(r => setTimeout(r, 0)); }
    }
    if (!n) return { ok: false, reason: 'not enough data for a test' };
    const acc = hit / n, ci = 1.96 * Math.sqrt(0.25 / n);
    return {
      ok: true, n, acc, ci, baseAcc: baseHit / n, skill: 1 - brier / brierBase,
      confN, confAcc: confN ? confHit / confN : NaN,
      cov80: cov80 / n, cov50: cov50 / n,
      rangeGain: 1 - errModel / errNaive,
      edge: acc - 0.5 > ci && brier < brierBase,
      trainedOn: list.length - testsAll.length
    };
  }

  global.TickForecast = { prepare, predict, validate, WARM, DIM, NAMES };
})(window);
