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
        local = dt.datetime.utcfromtimestamp(close_t + local_offset_h * 3600)
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
            "local_time": local,
            "direction": "BULL" if d > 0 else "BEAR",
            "entry": entry,
            "hit": hit_k is not None,
            "minutes_to_hit": round((bars[hit_k]["time"] + tf_seconds - close_t) / 60) if hit_k is not None else None,
            "against_before_hit": mae_before_hit,          # how far it went the other way before reaching the target
            "against_until_exit": mae,                      # ...or before the EMAs crossed back
            "best_move": mfe,
            "exit_local": dt.datetime.utcfromtimestamp(bars[end_k]["time"] + tf_seconds + local_offset_h * 3600) if end_k is not None else None,
            "still_open": end_k is None,
        })
    return res


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
    for tf in [t.strip().upper() for t in args.timeframes.split(",")]:
        secs = TF_SECONDS[tf]
        count = args.days * 86400 // secs + 600            # + warm-up bars for the EMAs
        rates = mt5.copy_rates_from_pos(args.symbol, tfs[tf], 0, int(count))
        if rates is None or len(rates) == 0:
            out.append(f"\n=== {tf} ===  no bars returned ({mt5.last_error()})")
            continue
        bars = [{"time": int(r["time"]), "open": float(r["open"]), "high": float(r["high"]),
                 "low": float(r["low"]), "close": float(r["close"])} for r in rates]
        first = dt.datetime.utcfromtimestamp(max(bars[0]["time"], from_time) + args.offset * 3600)
        rows = analyze(bars, secs, args.fast, args.slow, args.target, sh * 60 + sm, eh * 60 + em, args.offset, from_time)
        out.append(summarize(tf, rows, args.target) + f"\n  (history used from {first:%Y-%m-%d})")
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
