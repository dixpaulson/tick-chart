"""
TICK-LEVEL verification of EMA crossover candidates.

Signals come from candles exactly as in ema_scan.py (EMA fast/slow crossing, confirmed at the candle close),
but every trade is then replayed on REAL MT5 ticks:
  - entry at the first tick after the crossing candle closes: buys at the ASK, sells at the BID (real spread)
  - stop / target / trailing stop are checked tick by tick, in the order they really happened
  - a buy closes at the BID, a sell at the ASK; stops fill at the tick that hit them (slippage on jumps included)
  - targets fill at the target price; the cross-back exit fills at the first tick after that candle closes
Exits: TP   = take profit at +target
       TRL  = once at +target, trail a stop half the target behind the best price
       HOLD = once at +target, stop to break-even and hold until the EMAs cross back
Before reaching the target every trade also closes if the EMAs cross back.

For comparison it also shows what the candle simulation (ema_scan.py) said for the same trades.

Run on the VPS with MT5 open:
    run_ema_verify.bat
    run_ema_verify.bat --days 180 --timeframes M15 --combos 5/3/TRL,5/5/TRL --start 08:00 --end 11:00
Saves data\\ema_verify_<symbol>.txt
"""
import argparse
import datetime as dt
import statistics
import sys
import time
from pathlib import Path

import numpy as np

from ema_study import _utc, analyze, ema
import ema_scan

TF = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600}
DEFAULT_COMBOS = "5/3/TRL,5/5/TRL,3/3/TRL,2/3/TRL,5/10/TRL,5/15/HOLD,5/20/HOLD"


class TickStore:
    """Loads ticks one server day at a time and keeps only a few recent days in memory."""

    def __init__(self, mt5, symbol, keep_days=6):
        self.mt5, self.symbol, self.keep = mt5, symbol, keep_days
        self.days = {}
        self.loaded = 0

    def day(self, d):
        if d not in self.days:
            arr = None
            for _ in range(10):
                arr = self.mt5.copy_ticks_range(self.symbol, d * 86400, (d + 1) * 86400, self.mt5.COPY_TICKS_ALL)
                if arr is not None:
                    break
                time.sleep(0.5)
            if arr is None or len(arr) == 0:
                t = np.zeros(0, dtype=np.int64); b = a = np.zeros(0)
            else:
                ok = (arr["bid"] > 0) & (arr["ask"] > 0)
                t = arr["time_msc"][ok].astype(np.int64); b = arr["bid"][ok].astype(float); a = arr["ask"][ok].astype(float)
            self.days[d] = (t, b, a)
            self.loaded += len(t)
            for old in sorted(self.days)[:-self.keep]:
                if old < d - 2:
                    del self.days[old]
        return self.days[d]

    def window(self, start_ms, max_days):
        """Ticks from start_ms onwards over growing spans (2h, 8h, 1 day, 2 days ... max_days).
        Most trades finish within the first span, so little data is scanned."""
        spans = [2 * 3600000, 8 * 3600000] + [k * 86400000 for k in range(1, max_days + 1)]
        for span in spans:
            end = start_ms + span
            parts = []
            d = start_ms // 86400000
            while d * 86400000 < end:
                t, b, a = self.day(d)
                i0 = int(np.searchsorted(t, start_ms, side="left")); i1 = int(np.searchsorted(t, end, side="left"))
                parts.append((t[i0:i1], b[i0:i1], a[i0:i1]))
                d += 1
            yield (np.concatenate([x[0] for x in parts]), np.concatenate([x[1] for x in parts]),
                   np.concatenate([x[2] for x in parts]))


def first(mask):
    """Index of the first True, or len(mask) if none."""
    if len(mask) == 0:
        return 0
    i = int(np.argmax(mask))
    return i if mask[i] else len(mask)


def trade_on_ticks(t, bid, ask, d, cross_ms, stop_pts, target, mode):
    """One trade on ticks. t/bid/ask start at the entry tick. cross_ms = close time (ms) of the opposite-cross
    candle (or None). Returns (profit in price units, exit time ms, reason, spread at entry) or None if no data."""
    if len(t) < 2:
        return None
    if d > 0:
        entry = ask[0]; px = bid[1:]
    else:
        entry = bid[0]; px = ask[1:]
    tt = t[1:]
    p = (px - entry) * d                       # open profit on every tick (exit side of the spread)
    spread0 = ask[0] - bid[0]
    n = len(p)
    ic = int(np.searchsorted(tt, cross_ms, side="left")) if cross_ms is not None else n   # first tick after cross-back
    i_stop = first(p <= -stop_pts)
    i_reach = first(p >= target)
    # before the target: stop, or cross-back
    pre_end = min(i_stop, ic, n)
    if i_reach >= pre_end:
        if pre_end >= n:
            return (p[-1], int(tt[-1]), "open", spread0) if n else None
        if i_stop <= ic:
            return (p[i_stop], int(tt[i_stop]), "stop", spread0)
        return (p[ic], int(tt[ic]), "cross", spread0)
    if mode == "TP":
        return (target, int(tt[i_reach]), "target", spread0)
    rest = p[i_reach:]
    if mode == "TRL":
        trail = target * 0.5
        level = np.maximum(np.maximum.accumulate(rest) - trail, target - trail)   # trailing stop in profit terms
        j = first(rest <= level)
        if j >= len(rest):
            return (rest[-1], int(tt[-1]), "open", spread0)
        return (rest[j], int(tt[i_reach + j]), "trail", spread0)
    # HOLD: break-even stop, exit at the cross-back
    j_be = first(rest <= 0.0)
    j_c = max(0, ic - i_reach) if ic < n else len(rest)
    j = min(j_be, j_c)
    if j >= len(rest):
        return (rest[-1], int(tt[-1]), "open", spread0)
    return (rest[j], int(tt[i_reach + j]), "breakeven" if j_be <= j_c else "cross", spread0)


def stats(p):
    if not p:
        return None
    eq = peak = dd = 0.0; run = worst = 0
    for x in p:
        eq += x; peak = max(peak, eq); dd = max(dd, peak - eq)
        run = run + 1 if x <= 0 else 0; worst = max(worst, run)
    w = sum(x for x in p if x > 0); l = -sum(x for x in p if x <= 0)
    return {"n": len(p), "avg": sum(p) / len(p), "total": sum(p), "win": sum(1 for x in p if x > 0) / len(p),
            "pf": w / l if l > 0 else float("inf"), "dd": dd, "run": worst}


def fmt_pf(x):
    return "inf" if x == float("inf") else f"{x:.2f}"


def main():
    ap = argparse.ArgumentParser(description="Tick-level verification of EMA crossover candidates")
    ap.add_argument("--symbol", default="XAUUSD")
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--holdout-days", type=int, default=90)
    ap.add_argument("--fast", type=int, default=9)
    ap.add_argument("--slow", type=int, default=21)
    ap.add_argument("--lots", type=float, default=0.01)
    ap.add_argument("--timeframes", default="M5,M15,M30")
    ap.add_argument("--combos", default=DEFAULT_COMBOS, help="stop/target/exit list, e.g. 5/3/TRL,5/5/TRL")
    ap.add_argument("--start", default="00:00"); ap.add_argument("--end", default="23:59")
    ap.add_argument("--offset", type=float, default=-7, help="hours from server time to your time (Toronto: -7)")
    ap.add_argument("--max-trade-days", type=int, default=4, help="give up on a trade after this many days")
    args = ap.parse_args()
    combos = []
    for c in args.combos.split(","):
        s, t, m = c.strip().split("/")
        combos.append((float(s), float(t), m.upper()))

    try:
        import MetaTrader5 as mt5
    except ImportError:
        sys.exit("MetaTrader5 package missing: run start_bridge.bat once first (it installs it).")
    if not mt5.initialize():
        sys.exit(f"Could not connect to MT5: {mt5.last_error()}. Is MT5 open and logged in?")
    mt5.symbol_select(args.symbol, True)
    si = mt5.symbol_info(args.symbol); tick = mt5.symbol_info_tick(args.symbol)
    if si is None or tick is None:
        sys.exit(f"No data for {args.symbol}.")
    money = ((si.trade_tick_value / si.trade_tick_size) if si.trade_tick_size else si.trade_contract_size) * args.lots
    cur = getattr(mt5.account_info(), "currency", "USD")
    now = int(tick.time); from_time = now - args.days * 86400; hold_from = now - args.holdout_days * 86400
    sh, sm = map(int, args.start.split(":")); eh, em = map(int, args.end.split(":"))
    tfmap = {"M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1}
    store = TickStore(mt5, args.symbol)
    t_start = time.time()

    out = [f"TICK-LEVEL VERIFICATION, EMA {args.fast}/{args.slow} on {args.symbol}, {args.lots:g} lot (1.0 move = {money:.2f} {cur}), "
           f"crossings {args.start}-{args.end} your time, last {args.days} days; hold-out = last {args.holdout_days} days "
           f"(from {_utc(hold_from + args.offset * 3600):%Y-%m-%d}).",
           "Entry at the first tick after the candle close (buy at ask / sell at bid); stops, targets and trails checked tick by tick.",
           f"Results in {cur} per trade. 'candles' = what the candle simulation said for the same trades."]
    summary = []
    for tf in [x.strip().upper() for x in args.timeframes.split(",")]:
        secs = TF[tf]
        rates = mt5.copy_rates_from_pos(args.symbol, tfmap[tf], 0, int(args.days * 86400 // secs + 600))
        if rates is None or len(rates) < 200:
            out.append(f"\n===== {tf}: no bars"); continue
        bars = [{"time": int(r["time"]), "open": float(r["open"]), "high": float(r["high"]), "low": float(r["low"]),
                 "close": float(r["close"]), "spread": float(r["spread"]) * si.point} for r in rates]
        rows = analyze(bars, secs, args.fast, args.slow, 1e9, sh * 60 + sm, eh * 60 + em, args.offset, from_time)
        closes = [b["close"] for b in bars]
        ef, es = ema(closes, args.fast), ema(closes, args.slow)
        # close time of the opposite cross for each signal
        cross_ms = []
        for r in rows:
            cm = None
            for k in range(r["i"] + 1, len(bars)):
                x = ef[k] - es[k]
                if x == x and x != 0 and (x > 0) != (r["d"] > 0):
                    cm = (bars[k]["time"] + secs) * 1000; break
            cross_ms.append(cm)
        res = {c: [] for c in combos}          # list of (signal index, tick profit, candle profit, spread)
        missing = 0
        for k, r in enumerate(rows):
            start_ms = r["close_t"] * 1000
            got = {}
            for t, b, a in store.window(start_ms, args.max_trade_days):
                pending = [c for c in combos if c not in got]
                for c in pending:
                    tr = trade_on_ticks(t, b, a, r["d"], cross_ms[k], c[0], c[1], c[2])
                    if tr and tr[2] != "open":
                        got[c] = tr
                if len(got) == len(combos):
                    break
            if not got and not len(t):
                missing += 1; continue
            for c in combos:
                tr = got.get(c) or trade_on_ticks(t, b, a, r["d"], cross_ms[k], c[0], c[1], c[2])
                if tr is None:
                    continue
                candle = ema_scan.simulate(bars, ef, es, r["i"], r["d"], c[0], c[1], c[2], bars[r["i"]]["spread"] or tr[3])
                res[c].append((k, tr[0] * money, candle * money, tr[3]))
            if k % 200 == 0:
                print(f"  {tf}: {k}/{len(rows)} signals, {store.loaded:,} ticks read, {time.time() - t_start:.0f}s", flush=True)
        n_sig = len(rows)
        sp = [x[3] for x in next(iter(res.values()))] if res else []
        out.append(f"\n===== {tf}: {n_sig} signals, {missing} without tick data, real spread at entry: median "
                   f"{statistics.median(sp) if sp else float('nan'):.2f}, 90th pct {np.percentile(sp, 90) if sp else float('nan'):.2f} =====")
        out.append(f"  {'combo':<12}{'trades':>7} | {'TUNE ticks':>10}{'candles':>9}{'win%':>6}{'PF':>6} | "
                   f"{'HOLD-OUT ticks':>14}{'candles':>9}{'win%':>6}{'PF':>6} | {'total':>8}{'max DD':>8}{'lose run':>9}")
        best = None
        for c in combos:
            L = res[c]
            tune = [x for x in L if rows[x[0]]["close_t"] < hold_from]
            hold = [x for x in L if rows[x[0]]["close_t"] >= hold_from]
            a, ac = stats([x[1] for x in tune]), stats([x[2] for x in tune])
            b, bc = stats([x[1] for x in hold]), stats([x[2] for x in hold])
            al = stats([x[1] for x in L])
            if not al:
                continue
            star = "*" if a and b and a["avg"] > 0 and b["avg"] > 0 else " "
            f = lambda s, key="avg": f"{s[key]:+.2f}" if s else "-"  # noqa: E731
            out.append(f"  {'%g/%g %s' % c:<12}{al['n']:>7} | {f(a):>10}{f(ac):>9}{(a['win'] * 100 if a else 0):>5.0f}%{fmt_pf(a['pf']) if a else '-':>6} | "
                       f"{f(b):>14}{f(bc):>9}{(b['win'] * 100 if b else 0):>5.0f}%{fmt_pf(b['pf']) if b else '-':>6} | "
                       f"{al['total']:>+8.0f}{al['dd']:>8.0f}{al['run']:>9}{star}")
            if b and (best is None or b["avg"] > best[1]["avg"]):
                best = (c, b, L)
        if best:
            c, b, L = best
            out.append(f"  By hour (your time) for {'%g/%g %s' % c}, ticks: trades, avg tune | avg hold-out")
            hours = {}
            for x in L:
                hours.setdefault(rows[x[0]]["local_time"].hour, []).append(x)
            line = []
            for h in sorted(hours):
                xs = hours[h]
                tu = [x[1] for x in xs if rows[x[0]]["close_t"] < hold_from]
                ho = [x[1] for x in xs if rows[x[0]]["close_t"] >= hold_from]
                g = lambda v: f"{sum(v) / len(v):+.2f}" if v else "  -  "  # noqa: E731
                flag = "*" if tu and ho and sum(tu) > 0 and sum(ho) > 0 and len(xs) >= 30 else " "
                line.append(f"  {h:02d}h n={len(xs):<4} {g(tu):>7} | {g(ho):<7}{flag}")
            for k in range(0, len(line), 3):
                out.append("".join(line[k:k + 3]))
            summary.append((tf, c, b))
    mt5.shutdown()

    out.append("\n===== SUMMARY (best hold-out per timeframe, ticks) =====")
    for tf, c, b in summary:
        out.append(f"  {tf:<5}{'%g/%g %s' % c:<12} hold-out {b['avg']:+.2f} {cur}/trade over {b['n']} trades, win {b['win'] * 100:.0f}%, "
                   f"PF {fmt_pf(b['pf'])}, max DD {b['dd']:.0f}")
    out.append("  Worth paper trading only if the tick result stays clearly positive in the hold-out (and the tune period).")
    out.append(f"  Ticks read: {store.loaded:,} in {time.time() - t_start:.0f}s.")
    report = "\n".join(out)
    print(report)
    data = Path(__file__).resolve().parent / "data"
    data.mkdir(exist_ok=True)
    (data / f"ema_verify_{args.symbol}.txt").write_text(report, encoding="utf-8")
    print(f"\nSaved: {data / f'ema_verify_{args.symbol}.txt'}")


if __name__ == "__main__":
    main()
