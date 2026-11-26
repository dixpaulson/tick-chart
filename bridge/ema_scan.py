"""
EMA crossover SCAN: which timeframe, which stop/target, which hours?

For each timeframe it finds every EMA fast/slow crossing (whole day by default), enters at the close of
the crossing candle, and simulates a grid of stop / target / exit choices:
  exits: TP  = take profit at the target
         TRL = once at the target, trail a stop half the target behind the best price
         HOLD= once at the target, stop to break-even and hold until the EMAs cross back
  Before the target, every trade also exits if the EMAs cross back.
Costs: the spread of each trade comes from MT5's bar data at the crossing (bar spread x point).
Money: MT5's tick value for the symbol, times your lot size.

Every result is shown for the TUNE period and for the most recent HOLD-OUT days, which no choice was
based on. A combination is only interesting if it is positive in BOTH (marked *).

Run on the VPS with MT5 open:
    run_ema_scan.bat                       (XAUUSD, 0.01 lot, M1..H1, whole day, 365 days)
    run_ema_scan.bat --symbol GER40 --lots 0.1
Saves data\\ema_scan_<symbol>.txt
"""
import argparse
import datetime as dt
import statistics
import sys
from pathlib import Path

from ema_study import _utc, analyze, ema

TF = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600}


def simulate(bars, ef, es, i, d, stop_pts, target, mode, spread):
    """Same rules as ema_study.simulate (cautious: stop first when a candle touches both)."""
    entry = bars[i]["close"]
    stop = entry - d * stop_pts
    reached = False
    trail = target * 0.5
    n = len(bars)
    for k in range(i + 1, n):
        b = bars[k]
        if (d > 0 and b["low"] <= stop) or (d < 0 and b["high"] >= stop):
            return (stop - entry) * d - spread
        fav = b["high"] if d > 0 else b["low"]
        if not reached and (fav - entry) * d >= target:
            reached = True
            if mode == "TP":
                return target - spread
            if mode == "HOLD":
                stop = entry
        if reached and mode == "TRL":
            new = fav - d * trail
            stop = max(stop, new) if d > 0 else min(stop, new)
        x = ef[k] - es[k]
        if x == x and x != 0 and (x > 0) != (d > 0) and (not reached or mode == "HOLD"):
            return (b["close"] - entry) * d - spread
    return (bars[-1]["close"] - entry) * d - spread


def stats(p):
    n = len(p)
    if not n:
        return None
    eq = peak = dd = 0.0
    run = worst = 0
    for x in p:
        eq += x; peak = max(peak, eq); dd = max(dd, peak - eq)
        run = run + 1 if x <= 0 else 0
        worst = max(worst, run)
    wins = sum(x for x in p if x > 0); loss = -sum(x for x in p if x <= 0)
    return {"n": n, "avg": sum(p) / n, "total": sum(p), "win": sum(1 for x in p if x > 0) / n,
            "pf": wins / loss if loss > 0 else float("inf"), "dd": dd, "run": worst}


def main():
    ap = argparse.ArgumentParser(description="EMA crossover scan over timeframes and stop/target grids")
    ap.add_argument("--symbol", default="XAUUSD")
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--holdout-days", type=int, default=90)
    ap.add_argument("--fast", type=int, default=9)
    ap.add_argument("--slow", type=int, default=21)
    ap.add_argument("--lots", type=float, default=0.01)
    ap.add_argument("--timeframes", default="M1,M5,M15,M30,H1")
    ap.add_argument("--start", default="00:00", help="window start, your local time")
    ap.add_argument("--end", default="23:59", help="window end, your local time")
    ap.add_argument("--offset", type=float, default=-7, help="hours from server time to your time (Toronto: -7)")
    ap.add_argument("--stops", default="", help="comma list in price units, e.g. 1,2,3,5 (gold dollars)")
    ap.add_argument("--targets", default="", help="comma list in price units, e.g. 3,5,10,15,20")
    args = ap.parse_args()

    gold = "XAU" in args.symbol.upper()
    stops = [float(x) for x in (args.stops or ("1,2,3,5" if gold else "15,20,30,50")).split(",")]
    targets = [float(x) for x in (args.targets or ("3,5,10,15,20" if gold else "50,100,150,200")).split(",")]

    try:
        import MetaTrader5 as mt5
    except ImportError:
        sys.exit("MetaTrader5 package missing: run start_bridge.bat once first (it installs it).")
    if not mt5.initialize():
        sys.exit(f"Could not connect to MT5: {mt5.last_error()}. Is MT5 open and logged in?")
    mt5.symbol_select(args.symbol, True)
    si = mt5.symbol_info(args.symbol)
    tick = mt5.symbol_info_tick(args.symbol)
    if si is None or tick is None:
        sys.exit(f"No data for {args.symbol}. Check the symbol name in Market Watch.")
    per_unit = (si.trade_tick_value / si.trade_tick_size) if si.trade_tick_size else si.trade_contract_size
    money = per_unit * args.lots                    # account currency per 1.0 price move at your lot size
    now = int(tick.time)
    from_time = now - args.days * 86400
    hold_from = now - args.holdout_days * 86400
    sh, sm = map(int, args.start.split(":")); eh, em = map(int, args.end.split(":"))
    cur = "USD"
    try:
        cur = mt5.account_info().currency
    except Exception:  # noqa: BLE001
        pass

    out = [f"EMA {args.fast}/{args.slow} SCAN on {args.symbol}, {args.lots:g} lot (1.0 price move = {money:.2f} {cur}), "
           f"crossings closing {args.start}-{args.end} your time, last {args.days} days; hold-out = last {args.holdout_days} days "
           f"(from {_utc(hold_from + args.offset * 3600):%Y-%m-%d}).",
           f"Stops: {stops}  Targets: {targets}  Exits: TP / TRL (trail half the target) / HOLD (to cross-back). "
           f"Spread per trade from MT5 bar data. Results in {cur} per trade."]
    tf_summary = []
    tfmap = {"M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1}
    for tf in [t.strip().upper() for t in args.timeframes.split(",")]:
        secs = TF[tf]
        rates = mt5.copy_rates_from_pos(args.symbol, tfmap[tf], 0, int(args.days * 86400 // secs + 600))
        if rates is None or len(rates) < 200:
            out.append(f"\n===== {tf}: no bars ({mt5.last_error()})"); continue
        bars = [{"time": int(r["time"]), "open": float(r["open"]), "high": float(r["high"]), "low": float(r["low"]),
                 "close": float(r["close"]), "spread": float(r["spread"]) * si.point} for r in rates]
        fallback = (tick.ask - tick.bid)
        start_used = max(bars[0]["time"], from_time)
        rows = analyze(bars, secs, args.fast, args.slow, 1e9, sh * 60 + sm, eh * 60 + em, args.offset, from_time)
        if not rows:
            out.append(f"\n===== {tf}: no crossings"); continue
        closes = [b["close"] for b in bars]
        ef, es = ema(closes, args.fast), ema(closes, args.slow)
        sp = [bars[r["i"]]["spread"] or fallback for r in rows]
        days_span = max(1, (now - start_used) / 86400)
        tune_idx = [k for k, r in enumerate(rows) if r["close_t"] < hold_from]
        hold_idx = [k for k, r in enumerate(rows) if r["close_t"] >= hold_from]
        out.append(f"\n===== {tf}: {len(rows)} crossings ({len(rows) / days_span * 7 / 5:.1f} per trading day), "
                   f"history from {_utc(start_used + args.offset * 3600):%Y-%m-%d}, "
                   f"median spread {statistics.median(sp):.2f} =====")
        if not tune_idx or not hold_idx:
            out.append("  not enough history for a hold-out test (MT5 'Max bars in chart' may limit this timeframe)")
        combos = []
        for s in stops:
            for t in targets:
                for mode in ("TP", "TRL", "HOLD"):
                    p = [simulate(bars, ef, es, r["i"], r["d"], s, t, mode, sp[k]) * money for k, r in enumerate(rows)]
                    a = stats([p[k] for k in tune_idx]); b = stats([p[k] for k in hold_idx]); al = stats(p)
                    combos.append({"s": s, "t": t, "mode": mode, "p": p, "tune": a, "hold": b, "all": al})
        robust = [c for c in combos if c["tune"] and c["hold"] and c["tune"]["avg"] > 0 and c["hold"]["avg"] > 0]
        out.append(f"  {len(robust)} of {len(combos)} combinations were positive in BOTH tune and hold-out.")
        out.append(f"  Best 10 by the TUNE period (what you'd have picked), and how they did afterwards:")
        out.append(f"  {'stop':>6}{'target':>7} exit {'tune avg':>9}{'win%':>6}{'PF':>6} | {'HOLD avg':>9}{'win%':>6}{'PF':>6} | "
                   f"{'year total':>10}{'max DD':>8}{'lose run':>9}")
        best = sorted([c for c in combos if c["tune"]], key=lambda c: c["tune"]["avg"], reverse=True)[:10]
        for c in best:
            a, b, al = c["tune"], c["hold"], c["all"]
            star = "*" if b and a["avg"] > 0 and b["avg"] > 0 else " "
            pf = lambda x: "inf" if x == float("inf") else f"{x:.2f}"  # noqa: E731
            out.append(f"  {c['s']:>6g}{c['t']:>7g} {c['mode']:<4}{a['avg']:>+9.2f}{a['win'] * 100:>5.0f}%{pf(a['pf']):>6} | "
                       + (f"{b['avg']:>+9.2f}{b['win'] * 100:>5.0f}%{pf(b['pf']):>6}" if b else f"{'-':>21}")
                       + f" | {al['total']:>+10.0f}{al['dd']:>8.0f}{al['run']:>9}{star}")
        pick = best[0]
        # hour of day for the combination you'd have picked
        out.append(f"  By hour (your time) for {pick['s']:g}/{pick['t']:g} {pick['mode']}: trades, avg tune | avg hold-out")
        hours = {}
        for k, r in enumerate(rows):
            hours.setdefault(r["local_time"].hour, []).append(k)
        line = []
        for h in sorted(hours):
            ks = hours[h]
            tu = [pick["p"][k] for k in ks if rows[k]["close_t"] < hold_from]
            ho = [pick["p"][k] for k in ks if rows[k]["close_t"] >= hold_from]
            f = lambda v: f"{sum(v) / len(v):+.2f}" if v else "  -  "  # noqa: E731
            flag = "*" if tu and ho and sum(tu) > 0 and sum(ho) > 0 and len(ks) >= 30 else " "
            line.append(f"  {h:02d}h n={len(ks):<4} {f(tu):>7} | {f(ho):<7}{flag}")
        for k in range(0, len(line), 3):
            out.append("".join(line[k:k + 3]))
        tf_summary.append((tf, len(rows), len(robust), len(combos), pick))
    mt5.shutdown()

    out.append("\n===== SUMMARY: which timeframe? =====")
    out.append(f"  {'TF':<5}{'crossings':>10}{'robust combos':>15}   pick by tune -> hold-out avg per trade")
    for tf, n, rb, nc, pk in tf_summary:
        h = pk["hold"]
        out.append(f"  {tf:<5}{n:>10}{rb:>9} / {nc:<4}   {pk['s']:g}/{pk['t']:g} {pk['mode']}: tune {pk['tune']['avg']:+.2f} -> "
                   + (f"hold-out {h['avg']:+.2f} ({h['n']} trades)" if h else "no hold-out data"))
    out.append("  A timeframe deserves attention only if many combinations are robust AND the tune pick stays positive in the hold-out.")
    report = "\n".join(out)
    print(report)
    data = Path(__file__).resolve().parent / "data"
    data.mkdir(exist_ok=True)
    (data / f"ema_scan_{args.symbol}.txt").write_text(report, encoding="utf-8")
    print(f"\nSaved: {data / f'ema_scan_{args.symbol}.txt'}")


if __name__ == "__main__":
    main()
