"""
EMA crossing study on your own MT5 history.

For each timeframe (H1, M15, M5) it finds every EMA 9 / EMA 21 crossing whose candle CLOSED
inside a time window (default 01:30-03:30 Toronto time), takes the close as the entry, and follows
the trade until the EMAs cross back the other way. It reports:
  - whether price reached +TARGET points in the cross direction before the opposite cross
  - how far it went AGAINST you before reaching the target (or before the opposite cross)
  - the best move in your favour

Run on the VPS (MT5 open and logged in):
    double-click run_ema_study.bat
or  .venv\\Scripts\\python ema_study.py --days 120 --target 100

Results are printed and saved to data\\ema_study_<symbol>.csv (open it in Excel).
"""
import argparse
import csv
import datetime as dt
import statistics
import sys
from pathlib import Path

TF_SECONDS = {"H1": 3600, "M15": 900, "M5": 300}

def _utc(ts):
    """Naive datetime for a UTC timestamp (no deprecation warnings on newer Python)."""
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).replace(tzinfo=None)



def ema(values, period):
    """Standard EMA, seeded with the simple average of the first `period` values (same as the web app)."""
    out = [float("nan")] * len(values)
    if len(values) < period:
        return out
    k = 2 / (period + 1)
    v = sum(values[:period]) / period
    out[period - 1] = v
    for i in range(period, len(values)):
        v += k * (values[i] - v)
        out[i] = v
    return out


def analyze(bars, tf_seconds, fast=9, slow=21, target=100.0, start_min=90, end_min=210, local_offset_h=-7,
            from_time=0):
    """bars: list of dicts {time (server epoch s, bar open), open, high, low, close}, oldest first.
    local_offset_h: hours to add to server time to get your local time (Toronto = server - 7 with most brokers).
    Returns a list of crossing results."""
    closes = [b["close"] for b in bars]
    ef, es = ema(closes, fast), ema(closes, slow)
    res = []
    n = len(bars)
    for i in range(1, n):
        prev, now = ef[i - 1] - es[i - 1], ef[i] - es[i]
        if prev != prev or now != now or now == 0 or (prev > 0) == (now > 0):
            continue
        close_t = bars[i]["time"] + tf_seconds                    # crossing confirmed when the candle closes
        if bars[i]["time"] < from_time:
            continue
        local = _utc(close_t + local_offset_h * 3600)
        m = local.hour * 60 + local.minute
        if not (start_min <= m <= end_min):
            continue
        d = 1 if now > 0 else -1
        entry = bars[i]["close"]
        mfe = mae = 0.0
        mae_before_hit = None
        hit_k = None
        end_k = None
        for k in range(i + 1, n):
            b = bars[k]
            fav = (b["high"] - entry) if d > 0 else (entry - b["low"])
            adv = (entry - b["low"]) if d > 0 else (b["high"] - entry)
            mae = max(mae, adv)            # includes this candle: within a candle we can't tell which came first
            mfe = max(mfe, fav)
            if hit_k is None and fav >= target:
                hit_k = k
                mae_before_hit = mae
            x = ef[k] - es[k]
            if x == x and (x > 0) != (d > 0) and x != 0:
                end_k = k
                break
        res.append({
            "i": i, "d": d, "fast": fast, "slow": slow, "close_t": close_t,
            "local_time": local,
            "direction": "BULL" if d > 0 else "BEAR",
            "entry": entry,
            "hit": hit_k is not None,
            "minutes_to_hit": round((bars[hit_k]["time"] + tf_seconds - close_t) / 60) if hit_k is not None else None,
            "against_before_hit": mae_before_hit,          # how far it went the other way before reaching the target
            "against_until_exit": mae,                      # ...or before the EMAs crossed back
            "best_move": mfe,
            "exit_local": _utc(bars[end_k]["time"] + tf_seconds + local_offset_h * 3600) if end_k is not None else None,
            "still_open": end_k is None,
        })
    return res


# ---------------------------------------------------------------- strategy test
def simulate(bars, ef, es, i, d, stop_pts, target, trail, spread):
    """One trade: entry at bars[i] close, stop `stop_pts` away; before +target it also exits if the EMAs cross back.
    After +target: trail = 'tp' (take profit at +target), a number (trailing stop that many points behind the best
    price), or 'cross' (stop to break-even, exit when the EMAs cross back).
    Candles only show high/low, so when one candle touches both the stop and a better price, the stop is assumed
    to come first (the cautious choice). Returns (points after spread, exit index, reason, reached_target)."""
    entry = bars[i]["close"]
    stop = entry - d * stop_pts
    reached = False
    n = len(bars)
    for k in range(i + 1, n):
        b = bars[k]
        if (d > 0 and b["low"] <= stop) or (d < 0 and b["high"] >= stop):
            return (stop - entry) * d - spread, k, ("trail" if reached else "stop"), reached
        fav = b["high"] if d > 0 else b["low"]
        if not reached and (fav - entry) * d >= target:
            reached = True
            if trail == "tp":
                return target - spread, k, "target", True
            if trail == "cross":
                stop = entry
        if reached and trail not in ("tp", "cross"):
            new = fav - d * float(trail)
            stop = max(stop, new) if d > 0 else min(stop, new)
        x = ef[k] - es[k]
        if x == x and x != 0 and (x > 0) != (d > 0) and (not reached or trail == "cross"):
            return (b["close"] - entry) * d - spread, k, "cross", reached
    return (bars[-1]["close"] - entry) * d - spread, n - 1, "open", reached


def stats(pnls):
    n = len(pnls)
    if not n:
        return None
    wins = [p for p in pnls if p > 0]
    loss = [p for p in pnls if p <= 0]
    eq = peak = dd = 0.0
    streak = worst_streak = 0
    for p in pnls:
        eq += p; peak = max(peak, eq); dd = max(dd, peak - eq)
        streak = streak + 1 if p <= 0 else 0
        worst_streak = max(worst_streak, streak)
    gl = -sum(loss)
    return {"n": n, "win": len(wins) / n, "total": sum(pnls), "avg": sum(pnls) / n, "dd": dd,
            "pf": (sum(wins) / gl) if gl > 0 else float("inf"), "streak": worst_streak,
            "best": max(pnls), "worst": min(pnls)}


def strategy_report(tf, bars, rows, stop_pts, target, spread, money_per_point, lots, open_min, offset_h):
    ef = ema([b["close"] for b in bars], rows[0]["fast"]) if rows else None
    lines = []
    if not rows:
        return f"\n--- {tf} strategy test: no crossings ---"
    es = ema([b["close"] for b in bars], rows[0]["slow"])
    usd = money_per_point * lots
    variants = [("TP at +%g" % target, "tp"), ("trail 30", 30), ("trail 50", 50), ("trail 75", 75), ("hold to cross-back", "cross")]
    lines.append(f"\n--- {tf} STRATEGY TEST: stop {stop_pts:g}, after +{target:g}: see each row; spread {spread:g} pts/trade; "
                 f"$ at {lots:g} lot ({money_per_point:g} per point per lot) ---")
    lines.append(f"  {'exit after +' + format(target, 'g'):<20}{'trades':>7}{'win%':>6}{'total pts':>11}{'avg/trade':>11}{'$ total':>10}"
                 f"{'max DD':>8}{'PF':>6}{'lose run':>9}   1st half avg | 2nd half avg")
    half = len(rows) // 2
    best = None
    for name, tr in variants:
        res = [simulate(bars, ef, es, r["i"], r["d"], stop_pts, target, tr, spread) for r in rows]
        p = [x[0] for x in res]
        st = stats(p)
        h1, h2 = stats(p[:half]), stats(p[half:])
        pf = "inf" if st["pf"] == float("inf") else f"{st['pf']:.2f}"
        lines.append(f"  {name:<20}{st['n']:>7}{st['win'] * 100:>5.0f}%{st['total']:>11.1f}{st['avg']:>11.1f}{st['total'] * usd:>10.0f}"
                     f"{st['dd']:>8.0f}{pf:>6}{st['streak']:>9}   {(h1['avg'] if h1 else float('nan')):>+11.1f} | {(h2['avg'] if h2 else float('nan')):+.1f}")
        if tr == 50:
            best = res
    # before vs after the Frankfurt open, for the trail-50 variant
    if best:
        pre = [x[0] for x, r in zip(best, rows) if (r["local_time"].hour * 60 + r["local_time"].minute) < open_min]
        post = [x[0] for x, r in zip(best, rows) if (r["local_time"].hour * 60 + r["local_time"].minute) >= open_min]
        for label, arr in (("before 03:00 open", pre), ("from 03:00 open", post)):
            st = stats(arr)
            if st:
                lines.append(f"  trail 50, {label:<18}: {st['n']} trades, win {st['win'] * 100:.0f}%, avg {st['avg']:+.1f} pts, total {st['total']:+.1f} pts")
    return "\n".join(lines)


# ---------------------------------------------------------------- filters
def cpr_levels(h, l, c):
    p = (h + l + c) / 3
    bc = (h + l) / 2
    tc = 2 * p - bc
    return p, max(tc, bc), min(tc, bc)


def annotate(rows, bars, h1_bars, daily, open_min=180, narrow=0.15, wide=0.35):
    """Add filter fields to each crossing. Everything uses only information available at the crossing."""
    # H1 trend: EMA 9 vs 21 on the last CLOSED H1 candle before the crossing
    h1_close = [b["close"] for b in h1_bars]
    h9, h21 = ema(h1_close, 9), ema(h1_close, 21)
    h1_end = [b["time"] + 3600 for b in h1_bars]
    j = 0
    # daily H/L/C keyed by server day -> CPR of the following trading day
    days = sorted(daily)
    prev_of = {days[k]: daily[days[k - 1]] for k in range(1, len(days))}
    seen_today = {}
    for r in rows:
        t = r["close_t"]
        while j + 1 < len(h1_end) and h1_end[j + 1] <= t:
            j += 1
        trend = 0
        if j < len(h1_end) and h1_end[j] <= t and h9[j] == h9[j] and h21[j] == h21[j]:
            trend = 1 if h9[j] > h21[j] else -1
        r["h1_agree"] = trend == r["d"]
        day = t // 86400
        pv = prev_of.get(day)
        if pv:
            p, tc, bc = cpr_levels(*pv)
            wpct = (tc - bc) / p * 100
            r["cpr_class"] = "narrow" if wpct < narrow else ("wide" if wpct > wide else "normal")
            r["cpr_side"] = (r["d"] > 0 and r["entry"] > tc) or (r["d"] < 0 and r["entry"] < bc)
            r["cpr_inside"] = bc <= r["entry"] <= tc
        else:
            r["cpr_class"], r["cpr_side"], r["cpr_inside"] = "unknown", False, False
        m = r["local_time"].hour * 60 + r["local_time"].minute
        k = r["local_time"].date()
        seen_today[k] = seen_today.get(k, 0) + 1
        r["nth_today"] = seen_today[k]
        r["slot"] = f"{(m // 30) * 30 // 60:02d}:{(m // 30) * 30 % 60:02d}"
        r["after_open"] = m >= open_min
    first_after = set()
    got = set()
    for r in rows:
        k = r["local_time"].date()
        if r["after_open"] and k not in got:
            got.add(k); first_after.add(id(r))
    for r in rows:
        r["first_after_open"] = id(r) in first_after
    return rows


def filter_report(tf, bars, rows, stop_pts, target, spread, holdout_from, extra_rows=None):
    if not rows:
        return ""
    ef = ema([b["close"] for b in bars], rows[0]["fast"])
    es = ema([b["close"] for b in bars], rows[0]["slow"])
    variants = [("TP+%g" % target, "tp"), ("trail75", 75), ("hold", "cross")]
    filters = [
        ("ALL", lambda r: True),
        ("slot 01:30", lambda r: r["slot"] == "01:30"), ("slot 02:00", lambda r: r["slot"] == "02:00"),
        ("slot 02:30", lambda r: r["slot"] == "02:30"), ("slot 03:00+", lambda r: r["after_open"]),
        ("1st crossing of day", lambda r: r["nth_today"] == 1),
        ("1st or 2nd of day", lambda r: r["nth_today"] <= 2),
        ("1st after 03:00", lambda r: r["first_after_open"]),
        ("H1 trend agrees", lambda r: r["h1_agree"]), ("H1 trend against", lambda r: not r["h1_agree"]),
        ("CPR narrow day", lambda r: r["cpr_class"] == "narrow"), ("CPR normal day", lambda r: r["cpr_class"] == "normal"),
        ("CPR wide day", lambda r: r["cpr_class"] == "wide"),
        ("price beyond CPR in trade dir", lambda r: r["cpr_side"]), ("price inside CPR", lambda r: r["cpr_inside"]),
        ("H1 agrees + beyond CPR", lambda r: r["h1_agree"] and r["cpr_side"]),
        ("H1 agrees + 1st/2nd of day", lambda r: r["h1_agree"] and r["nth_today"] <= 2),
        ("H1 agrees + after 03:00", lambda r: r["h1_agree"] and r["after_open"]),
    ]
    cache = {}
    def res(r, tr):
        key = (r["i"], tr)
        if key not in cache:
            cache[key] = simulate(bars, ef, es, r["i"], r["d"], stop_pts, target, tr, spread)[0]
        return cache[key]
    hd = _utc(holdout_from)
    lines = [f"\n--- {tf} FILTER TEST (stop {stop_pts:g}, spread {spread:g}). pts/trade: TUNE period | HOLD-OUT from {hd:%Y-%m-%d} (untouched). "
             f"A real edge should be positive in BOTH. ---",
             f"  {'filter':<30}{'n tune':>7}{'n hold':>7}" + "".join(f"{name:>20}" for name, _ in variants) + f"{'win% (trail75)':>16}"]
    for fname, f in filters:
        sel = [r for r in rows if f(r)]
        tune = [r for r in sel if r["close_t"] < holdout_from]
        hold = [r for r in sel if r["close_t"] >= holdout_from]
        if len(sel) < 8:
            continue
        cells = ""
        for _, tr in variants:
            a = sum(res(r, tr) for r in tune) / len(tune) if tune else float("nan")
            b = sum(res(r, tr) for r in hold) / len(hold) if hold else float("nan")
            flag = "*" if a > 0 and b > 0 else " "
            cells += f"{a:>+9.1f} |{b:>+7.1f}{flag}"
        wins = sum(1 for r in sel if res(r, 75) > 0)
        lines.append(f"  {fname:<30}{len(tune):>7}{len(hold):>7}{cells}{wins / len(sel) * 100:>15.0f}%")
    if extra_rows:
        lines.append("  Fresh window never used before (03:30-04:30): does the 'after the open' idea carry over?")
        for name, tr in variants:
            p = [res(r, tr) for r in extra_rows]
            lines.append(f"    {name:<10} {len(p)} trades, avg {sum(p) / len(p):+.1f} pts, total {sum(p):+.1f}")
    lines.append("  * = positive in both the tune period and the hold-out. Treat small groups (n < 40) as noise.")
    return "\n".join(lines)


def summarize(tf, rows, target):
    lines = []
    n = len(rows)
    hits = [r for r in rows if r["hit"]]
    miss = [r for r in rows if not r["hit"]]
    lines.append(f"\n=== {tf} ===  crossings: {n}   reached +{target:g}: {len(hits)}"
                 + (f"  ({len(hits) / n * 100:.0f}%)" if n else ""))
    if hits:
        a = [r["against_before_hit"] for r in hits]
        t = [r["minutes_to_hit"] for r in hits]
        lines.append(f"  winners went against you first: median {statistics.median(a):.1f}, worst {max(a):.1f} pts; "
                     f"time to +{target:g}: median {statistics.median(t):.0f} min")
    if miss:
        a = [r["against_until_exit"] for r in miss]
        b = [r["best_move"] for r in miss]
        lines.append(f"  losers went against you: median {statistics.median(a):.1f}, worst {max(a):.1f} pts; "
                     f"their best move: median {statistics.median(b):.1f} pts")
    lines.append(f"  {'Toronto time':<17}{'cross':<6}{'entry':>10}  {'+' + format(target, 'g') + '?':<6}{'against':>9}{'best':>9}  exit (opposite cross)")
    for r in rows:
        ag = r["against_before_hit"] if r["hit"] else r["against_until_exit"]
        ex = "still open" if r["still_open"] else r["exit_local"].strftime("%m-%d %H:%M")
        hit = f"YES {r['minutes_to_hit']}m" if r["hit"] else "no"
        lines.append(f"  {r['local_time']:%a %m-%d %H:%M}  {r['direction']:<6}{r['entry']:>10.1f}  {hit:<9}{ag:>6.1f}{r['best_move']:>9.1f}  {ex}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="EMA crossing study on MT5 history")
    ap.add_argument("--symbol", default="GER40")
    ap.add_argument("--days", type=int, default=120, help="calendar days of history to study")
    ap.add_argument("--fast", type=int, default=9)
    ap.add_argument("--slow", type=int, default=21)
    ap.add_argument("--target", type=float, default=100.0, help="points of continuation to count as a win")
    ap.add_argument("--start", default="01:30", help="window start, your local time (HH:MM)")
    ap.add_argument("--end", default="03:30", help="window end, your local time (HH:MM)")
    ap.add_argument("--offset", type=float, default=-7, help="hours from server time to your time (Toronto: -7)")
    ap.add_argument("--timeframes", default="H1,M15,M5")
    ap.add_argument("--stop", type=float, default=20, help="stop loss in points for the strategy test")
    ap.add_argument("--spread", type=float, default=3.0, help="cost per trade in points (your typical spread)")
    ap.add_argument("--money-per-point", type=float, default=11.6, help="account currency per point for 1 lot (GER40 ~11.6 USD)")
    ap.add_argument("--lots", type=float, default=0.1)
    ap.add_argument("--holdout-days", type=int, default=90, help="most recent days kept aside to check filters")
    args = ap.parse_args()

    try:
        import MetaTrader5 as mt5
    except ImportError:
        sys.exit("MetaTrader5 package missing: run start_bridge.bat once first (it installs it).")
    if not mt5.initialize():
        sys.exit(f"Could not connect to MT5: {mt5.last_error()}. Is MT5 open and logged in?")
    mt5.symbol_select(args.symbol, True)
    tick = mt5.symbol_info_tick(args.symbol)
    if tick is None:
        sys.exit(f"No data for {args.symbol}. Check the symbol name in Market Watch.")
    from_time = int(tick.time) - args.days * 86400
    sh, sm = map(int, args.start.split(":"))
    eh, em = map(int, args.end.split(":"))
    tfs = {"H1": mt5.TIMEFRAME_H1, "M15": mt5.TIMEFRAME_M15, "M5": mt5.TIMEFRAME_M5}

    out = [f"EMA {args.fast}/{args.slow} crossings on {args.symbol}, candle close between {args.start} and {args.end} "
           f"(your time = server {args.offset:+g}h), last {args.days} days. Entry = close of the crossing candle; "
           f"win = +{args.target:g} pts before the EMAs cross back."]
    all_rows = []
    # data for the filters: H1 bars (trend) and daily bars (CPR)
    h1r = mt5.copy_rates_from_pos(args.symbol, mt5.TIMEFRAME_H1, 0, int(args.days * 24 + 600))
    h1_bars = [{"time": int(r["time"]), "close": float(r["close"])} for r in (h1r if h1r is not None else [])]
    d1r = mt5.copy_rates_from_pos(args.symbol, mt5.TIMEFRAME_D1, 0, int(args.days + 20))
    daily = {int(r["time"]) // 86400: (float(r["high"]), float(r["low"]), float(r["close"])) for r in (d1r if d1r is not None else [])}
    holdout_from = int(tick.time) - args.holdout_days * 86400
    for tf in [t.strip().upper() for t in args.timeframes.split(",")]:
        secs = TF_SECONDS[tf]
        count = args.days * 86400 // secs + 600            # + warm-up bars for the EMAs
        rates = mt5.copy_rates_from_pos(args.symbol, tfs[tf], 0, int(count))
        if rates is None or len(rates) == 0:
            out.append(f"\n=== {tf} ===  no bars returned ({mt5.last_error()})")
            continue
        bars = [{"time": int(r["time"]), "open": float(r["open"]), "high": float(r["high"]),
                 "low": float(r["low"]), "close": float(r["close"])} for r in rates]
        first = _utc(max(bars[0]["time"], from_time) + args.offset * 3600)
        rows = analyze(bars, secs, args.fast, args.slow, args.target, sh * 60 + sm, eh * 60 + em, args.offset, from_time)
        out.append(summarize(tf, rows, args.target) + f"\n  (history used from {first:%Y-%m-%d})")
        out.append(strategy_report(tf, bars, rows, args.stop, args.target, args.spread, args.money_per_point, args.lots,
                                   3 * 60, args.offset))
        if tf in ("M5", "M15") and rows:
            annotate(rows, bars, h1_bars, daily)
            extra = analyze(bars, secs, args.fast, args.slow, args.target, 210 + 1, 270, args.offset, from_time)
            out.append(filter_report(tf, bars, rows, args.stop, args.target, args.spread, holdout_from, extra))
        for r in rows:
            all_rows.append({"timeframe": tf, **r})
    mt5.shutdown()

    report = "\n".join(out)
    print(report)
    data = Path(__file__).resolve().parent / "data"
    data.mkdir(exist_ok=True)
    csv_path = data / f"ema_study_{args.symbol}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["timeframe", "local_time", "direction", "entry", "hit_target", "minutes_to_hit",
                    "against_before_hit", "against_until_exit", "best_move", "exit_local"])
        for r in all_rows:
            w.writerow([r["timeframe"], f"{r['local_time']:%Y-%m-%d %H:%M}", r["direction"], r["entry"], r["hit"],
                        r["minutes_to_hit"] if r["hit"] else "", f"{r['against_before_hit']:.1f}" if r["hit"] else "",
                        f"{r['against_until_exit']:.1f}", f"{r['best_move']:.1f}",
                        f"{r['exit_local']:%Y-%m-%d %H:%M}" if r["exit_local"] else "still open"])
    (data / f"ema_study_{args.symbol}.txt").write_text(report, encoding="utf-8")
    print(f"\nSaved: {csv_path}")


if __name__ == "__main__":
    main()
