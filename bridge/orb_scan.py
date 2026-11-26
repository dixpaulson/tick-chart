"""
OPENING RANGE BREAKOUT (ORB) study, with a volume filter, a hold-out test and tick-level verification.

For each trading day and session:
  opening range (OR) = high/low of the first N minutes after the session opens (M1 bars)
  entry  = first break of the OR within ENTRY_WINDOW minutes (buy above the high / sell below the low),
           like a stop order: one trade per session per day
  stop   = OR: the other side of the range   |  HALF: the middle of the range
  exit   = 1R / 2R / 3R target (R = entry-to-stop distance), or TIME: hold to the session's time exit
  costs  = spread from MT5 (bar data; real bid/ask in the tick test) + optional commission
Sessions use their own local time and daylight-saving rules (London / New York / Tokyo):
  TOKYO 09:00 Tokyo, LONDON 08:00 London (= XETRA 09:00 Frankfurt), COMEX 08:20 New York, NYSE 09:30 New York

1. Candle (M1) scan of all combinations: tune period vs the most recent hold-out days.
2. Volume filter: OR tick volume vs its own 20-day average; thresholds set on the TUNE period only.
3. Tick verification of the best robust combinations on real MT5 ticks (buy stop fills at the ask, etc.).

Run on the VPS with MT5 open:
    run_orb_scan.bat                                    (XAUUSD, 0.01 lot, 365 days)
    run_orb_scan.bat --commission 0.07                  (Raw account: commission per trade at your lot size)
    run_orb_scan.bat --symbol GER40 --lots 0.1 --sessions LONDON,NYSE
Saves data\\orb_scan_<symbol>.txt
"""
import argparse
import datetime as dt
import statistics
import sys
import time
from pathlib import Path

import numpy as np

from ema_study import _utc

SESSIONS = {   # name: (zone, open hh:mm, minutes until time exit)
    "TOKYO": ("JP", "09:00", 360),
    "LONDON": ("UK", "08:00", 270),
    "XETRA": ("UK", "08:00", 270),       # 09:00 Frankfurt is the same moment as 08:00 London
    "COMEX": ("US", "08:20", 310),       # to 13:30 New York
    "NYSE": ("US", "09:30", 390),        # to 16:00 New York
}
OR_MINUTES = [5, 15, 30, 60]
STOPS = ["OR", "HALF"]
TARGETS = ["1R", "2R", "3R", "TIME"]
ENTRY_WINDOW = 120


# ---------------------------------------------------------------- time zones (no tz database needed)
def nth_sunday(year, month, n):
    d = dt.date(year, month, 1)
    d += dt.timedelta(days=(6 - d.weekday()) % 7)
    return d + dt.timedelta(weeks=n - 1)


def last_sunday(year, month):
    d = dt.date(year, month + 1, 1) - dt.timedelta(days=1) if month < 12 else dt.date(year, 12, 31)
    return d - dt.timedelta(days=(d.weekday() + 1) % 7)


def utc_offset(zone, utc_dt):
    y = utc_dt.year
    if zone == "US":   # 2nd Sunday March 2:00 local -> 1st Sunday November 2:00 local
        start = dt.datetime.combine(nth_sunday(y, 3, 2), dt.time(7))
        end = dt.datetime.combine(nth_sunday(y, 11, 1), dt.time(6))
        return -4 if start <= utc_dt < end else -5
    if zone == "UK":   # last Sunday March 01:00 UTC -> last Sunday October 01:00 UTC
        start = dt.datetime.combine(last_sunday(y, 3), dt.time(1))
        end = dt.datetime.combine(last_sunday(y, 10), dt.time(1))
        return 1 if start <= utc_dt < end else 0
    return 9           # Japan


def session_open_server(zone, hhmm, date, server_minus_ny=7):
    """Server timestamp (s) of a session open on a given local date. Server time = New York time + 7h."""
    h, m = map(int, hhmm.split(":"))
    local = dt.datetime.combine(date, dt.time(h, m))
    guess = local - dt.timedelta(hours=utc_offset(zone, local))           # local -> UTC
    utc = local - dt.timedelta(hours=utc_offset(zone, guess))
    ny = utc + dt.timedelta(hours=utc_offset("US", utc))
    server = ny + dt.timedelta(hours=server_minus_ny)
    return int(server.replace(tzinfo=dt.timezone.utc).timestamp())


# ---------------------------------------------------------------- building the setups
def build_setups(bars, sessions, days_from, server_minus_ny=7):
    """One setup per (day, session, OR length): OR high/low/volume and the bars after it."""
    t = np.array([b["time"] for b in bars], dtype=np.int64)
    setups = []
    first_day = _utc(max(int(t[0]), days_from)).date()
    last_day = _utc(int(t[-1])).date()
    d = first_day
    while d <= last_day:
        for s in sessions:
            zone, hhmm, exit_min = SESSIONS[s]
            local_date = d
            o = session_open_server(zone, hhmm, local_date, server_minus_ny)
            if o < days_from or o > t[-1]:
                continue
            i0 = int(np.searchsorted(t, o))
            if i0 >= len(t) or t[i0] - o > 120:          # market closed at the open (weekend / holiday)
                continue
            for n in OR_MINUTES:
                i1 = int(np.searchsorted(t, o + n * 60))
                if i1 - i0 < max(3, n * 0.6):
                    continue
                hi = max(bars[k]["high"] for k in range(i0, i1))
                lo = min(bars[k]["low"] for k in range(i0, i1))
                vol = sum(bars[k]["vol"] for k in range(i0, i1))
                if hi <= lo:
                    continue
                setups.append({"date": local_date, "session": s, "n": n, "open": o, "i_end": i1, "hi": hi, "lo": lo,
                               "vol": vol, "deadline": o + (n + ENTRY_WINDOW) * 60, "exit_t": o + exit_min * 60})
        d += dt.timedelta(days=1)
    # relative volume: OR volume / average of the same session+length over the previous 20 setups (past only)
    hist = {}
    for su in setups:
        key = (su["session"], su["n"])
        h = hist.setdefault(key, [])
        su["relvol"] = su["vol"] / (sum(h[-20:]) / len(h[-20:])) if len(h) >= 10 else None
        h.append(su["vol"])
    return setups


def run_candles(bars, su, stop_mode, target_mode, commission):
    """Simulate one setup on M1 candles (cautious when a candle touches stop and target). Returns
    (profit in price units after costs, R in price units, direction) or None if no breakout."""
    hi, lo = su["hi"], su["lo"]
    n = len(bars)
    k = su["i_end"]
    d = 0
    entry = None
    while k < n and bars[k]["time"] < su["deadline"]:
        b = bars[k]
        up, dn = b["high"] > hi, b["low"] < lo
        if up and dn:
            return None                                   # both sides in one minute: ambiguous, skip
        if up:
            d, entry = 1, max(hi, b["open"]); break
        if dn:
            d, entry = -1, min(lo, b["open"]); break
        k += 1
    if not d:
        return None
    stop = (lo if d > 0 else hi) if stop_mode == "OR" else (hi + lo) / 2
    risk = (entry - stop) * d
    if risk <= 0:
        return None
    tgt = None if target_mode == "TIME" else entry + d * risk * int(target_mode[0])
    cost = (bars[k]["spread"] or 0) + commission
    # entry candle: only the stop counts (we can't know the order inside it)
    if (d > 0 and bars[k]["low"] <= stop) or (d < 0 and bars[k]["high"] >= stop):
        return (-risk - cost, risk, d)
    for j in range(k + 1, n):
        b = bars[j]
        if b["time"] >= su["exit_t"]:
            return ((b["open"] - entry) * d - cost, risk, d)
        if (d > 0 and b["low"] <= stop) or (d < 0 and b["high"] >= stop):
            return (-risk - cost, risk, d)
        if tgt is not None and ((d > 0 and b["high"] >= tgt) or (d < 0 and b["low"] <= tgt)):
            return (risk * int(target_mode[0]) - cost, risk, d)
    return ((bars[-1]["close"] - entry) * d - cost, risk, d)


def run_ticks(store, su, stop_mode, target_mode, commission):
    """Same trade on real ticks: a buy stop fills at the ask when ask >= OR high, a sell stop at the bid when bid <= OR low;
    a buy closes at the bid, a sell at the ask; stops fill at the tick that hits them; targets at the target price."""
    start = (su["open"] + su["n"] * 60) * 1000
    end = su["exit_t"] * 1000
    parts = []
    d0 = start // 86400000
    d = d0
    while d * 86400000 < end:
        t, b, a = store.day(d)
        i0, i1 = int(np.searchsorted(t, start)), int(np.searchsorted(t, end))
        parts.append((t[i0:i1], b[i0:i1], a[i0:i1])); d += 1
    t = np.concatenate([p[0] for p in parts]); b = np.concatenate([p[1] for p in parts]); a = np.concatenate([p[2] for p in parts])
    if len(t) < 2:
        return None
    dl = su["deadline"] * 1000
    up = np.nonzero((a >= su["hi"]) & (t < dl))[0]
    dn = np.nonzero((b <= su["lo"]) & (t < dl))[0]
    iu = up[0] if len(up) else None
    idn = dn[0] if len(dn) else None
    if iu is None and idn is None:
        return None
    if idn is None or (iu is not None and iu < idn):
        dirn, i = 1, iu; entry = a[i]
    else:
        dirn, i = -1, idn; entry = b[i]
    hi, lo = su["hi"], su["lo"]
    stop = (lo if dirn > 0 else hi) if stop_mode == "OR" else (hi + lo) / 2
    risk = (entry - stop) * dirn
    if risk <= 0:
        return None
    px = b[i + 1:] if dirn > 0 else a[i + 1:]
    if len(px) == 0:
        return None
    p = (px - entry) * dirn
    ist = np.nonzero(p <= -risk)[0]
    ist = ist[0] if len(ist) else len(p)
    if target_mode == "TIME":
        itg = len(p)
    else:
        m = int(target_mode[0])
        itg = np.nonzero(p >= risk * m)[0]
        itg = itg[0] if len(itg) else len(p)
    if ist < itg and ist < len(p):
        return (p[ist] - commission, risk, dirn)
    if itg < len(p):
        return (risk * int(target_mode[0]) - commission, risk, dirn)
    return (p[-1] - commission, risk, dirn)            # time exit: last tick before the session's exit time


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


def pf(x):
    return "inf" if x == float("inf") else f"{x:.2f}"


def main():
    ap = argparse.ArgumentParser(description="Opening range breakout study")
    ap.add_argument("--symbol", default="XAUUSD")
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--holdout-days", type=int, default=90)
    ap.add_argument("--lots", type=float, default=0.01)
    ap.add_argument("--sessions", default="", help="e.g. TOKYO,LONDON,COMEX,NYSE (default depends on symbol)")
    ap.add_argument("--commission", type=float, default=0.0, help="commission per trade in account currency at your lot size")
    ap.add_argument("--verify-top", type=int, default=6, help="how many robust combinations to re-test on ticks")
    ap.add_argument("--verify-days", type=int, default=180)
    args = ap.parse_args()
    gold = "XAU" in args.symbol.upper()
    sessions = [s.strip().upper() for s in (args.sessions or ("TOKYO,LONDON,COMEX,NYSE" if gold else "XETRA,NYSE")).split(",")]

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
    comm_px = args.commission / money if money else 0.0           # commission expressed in price units
    cur = getattr(mt5.account_info(), "currency", "USD")
    now = int(tick.time); from_time = now - args.days * 86400; hold_from = now - args.holdout_days * 86400
    t0 = time.time()
    rates = mt5.copy_rates_from_pos(args.symbol, mt5.TIMEFRAME_M1, 0, int(args.days * 1440 + 2000))
    if rates is None or len(rates) < 1000:
        sys.exit("Not enough M1 bars. In MT5 set Tools > Options > Charts > Max bars in chart = Unlimited, restart MT5.")
    bars = [{"time": int(r["time"]), "open": float(r["open"]), "high": float(r["high"]), "low": float(r["low"]),
             "close": float(r["close"]), "vol": float(r["tick_volume"]), "spread": float(r["spread"]) * si.point} for r in rates]
    print(f"  {len(bars):,} M1 bars loaded, building setups...", flush=True)
    setups = build_setups(bars, sessions, from_time)
    tl = lambda ts: _utc(ts - 7 * 3600)  # noqa: E731  server -> Toronto (server = New York + 7h)

    out = [f"OPENING RANGE BREAKOUT on {args.symbol}, {args.lots:g} lot (1.0 move = {money:.2f} {cur}), last {args.days} days, "
           f"hold-out = last {args.holdout_days} days (from {tl(hold_from):%Y-%m-%d}). Commission per trade: {args.commission:g} {cur}.",
           f"Sessions: " + ", ".join(f"{s} ({SESSIONS[s][1]} {SESSIONS[s][0]} time)" for s in sessions)
           + f". Entry window {ENTRY_WINDOW} min after the range. Results in {cur} per trade."]

    # 1. candle scan
    combos = []
    for s in sessions:
        for n in OR_MINUTES:
            sel = [su for su in setups if su["session"] == s and su["n"] == n]
            for sm in STOPS:
                for tm in TARGETS:
                    trades = []
                    for su in sel:
                        r = run_candles(bars, su, sm, tm, comm_px)
                        if r:
                            trades.append((su, r[0] * money, r[1], r[0] / r[1]))
                    tune = [x for x in trades if x[0]["open"] < hold_from]
                    hold = [x for x in trades if x[0]["open"] >= hold_from]
                    combos.append({"s": s, "n": n, "stop": sm, "tgt": tm, "trades": trades,
                                   "tune": stats([x[1] for x in tune]), "hold": stats([x[1] for x in hold]),
                                   "tuneR": stats([x[3] for x in tune]), "holdR": stats([x[3] for x in hold])})
    robust = [c for c in combos if c["tune"] and c["hold"] and c["tune"]["avg"] > 0 and c["hold"]["avg"] > 0
              and c["tune"]["n"] >= 40 and c["hold"]["n"] >= 15]
    out.append(f"\n===== 1. CANDLE SCAN (M1): {len(combos)} combinations, {len(robust)} positive in BOTH periods "
               f"(with at least 40 / 15 trades) =====")
    out.append(f"  {'session':<8}{'OR':>4}{'stop':>6}{'exit':>6} | {'tune n':>6}{'avg':>8}{'avg R':>7}{'win%':>6}{'PF':>6} | "
               f"{'hold n':>6}{'avg':>8}{'avg R':>7}{'win%':>6}{'PF':>6}")
    for s in sessions:
        cs = sorted([c for c in combos if c["s"] == s and c["tune"]], key=lambda c: c["tune"]["avg"], reverse=True)[:6]
        for c in cs:
            a, b, ar, br = c["tune"], c["hold"], c["tuneR"], c["holdR"]
            star = "*" if c in robust else " "
            out.append(f"  {c['s']:<8}{c['n']:>4}{c['stop']:>6}{c['tgt']:>6} | {a['n']:>6}{a['avg']:>+8.2f}{ar['avg']:>+7.2f}{a['win'] * 100:>5.0f}%{pf(a['pf']):>6} | "
                       + (f"{b['n']:>6}{b['avg']:>+8.2f}{br['avg']:>+7.2f}{b['win'] * 100:>5.0f}%{pf(b['pf']):>6}" if b else f"{'-':>33}") + star)
        out.append("")
    out.append("  (top 6 per session by the tune period; * = positive in both periods with enough trades)")

    # 2. volume filter on the robust combinations (thresholds from the tune period only)
    out.append("\n===== 2. VOLUME FILTER: opening-range tick volume vs its own 20-day average =====")
    out.append("  Thresholds are the tune period's 33rd / 67th percentiles, applied unchanged to the hold-out.")
    out.append(f"  {'combination':<26}{'volume group':<14}{'tune n':>7}{'avg':>8}{'hold n':>7}{'avg':>8}")
    vol_rows = []
    for c in sorted(robust, key=lambda c: c["tune"]["avg"], reverse=True)[:8] or sorted(
            [c for c in combos if c["tune"]], key=lambda c: c["tune"]["avg"], reverse=True)[:4]:
        tv = sorted(x[0]["relvol"] for x in c["trades"] if x[0]["relvol"] is not None and x[0]["open"] < hold_from)
        if len(tv) < 30:
            continue
        lo_t, hi_t = tv[len(tv) // 3], tv[2 * len(tv) // 3]
        name = f"{c['s']} {c['n']}m {c['stop']} {c['tgt']}"
        for gname, f in (("low", lambda v: v < lo_t), ("middle", lambda v: lo_t <= v < hi_t), ("HIGH", lambda v: v >= hi_t)):
            g = [x for x in c["trades"] if x[0]["relvol"] is not None and f(x[0]["relvol"])]
            a = stats([x[1] for x in g if x[0]["open"] < hold_from]); b = stats([x[1] for x in g if x[0]["open"] >= hold_from])
            star = "*" if a and b and a["avg"] > 0 and b["avg"] > 0 else " "
            out.append(f"  {name:<26}{gname + f' (x{lo_t:.2f}-{hi_t:.2f})' if gname == 'middle' else gname:<14}"
                       f"{(a['n'] if a else 0):>7}{(a['avg'] if a else 0):>+8.2f}{(b['n'] if b else 0):>7}{(b['avg'] if b else 0):>+8.2f}{star}")
            vol_rows.append((c, gname, a, b))
        out.append("")

    # 3. tick verification
    from ema_verify import TickStore
    store = TickStore(mt5, args.symbol, keep_days=3)
    vfrom = now - args.verify_days * 86400
    pick = sorted(robust, key=lambda c: c["tune"]["avg"], reverse=True)[:args.verify_top]
    out.append(f"\n===== 3. TICK VERIFICATION of the top {len(pick)} robust combinations, last {args.verify_days} days =====")
    if not pick:
        out.append("  No combination was robust in the candle scan, so there is nothing worth verifying.")
    else:
        out.append(f"  {'combination':<26}{'trades':>7} | {'tune ticks':>10}{'candles':>9}{'win%':>6}{'PF':>6} | "
                   f"{'HOLD ticks':>10}{'candles':>9}{'win%':>6}{'PF':>6} | {'max DD':>7}{'lose run':>9}")
        for c in pick:
            rows = []
            for su, cand, risk, rr in c["trades"]:
                if su["open"] < vfrom:
                    continue
                r = run_ticks(store, su, c["stop"], c["tgt"], comm_px)
                if r:
                    rows.append((su, r[0] * money, cand))
            if not rows:
                continue
            a = stats([x[1] for x in rows if x[0]["open"] < hold_from]); ac = stats([x[2] for x in rows if x[0]["open"] < hold_from])
            b = stats([x[1] for x in rows if x[0]["open"] >= hold_from]); bc = stats([x[2] for x in rows if x[0]["open"] >= hold_from])
            al = stats([x[1] for x in rows])
            star = "*" if a and b and a["avg"] > 0 and b["avg"] > 0 else " "
            f = lambda s: f"{s['avg']:+.2f}" if s else "-"  # noqa: E731
            out.append(f"  {c['s'] + ' ' + str(c['n']) + 'm ' + c['stop'] + ' ' + c['tgt']:<26}{al['n']:>7} | "
                       f"{f(a):>10}{f(ac):>9}{(a['win'] * 100 if a else 0):>5.0f}%{pf(a['pf']) if a else '-':>6} | "
                       f"{f(b):>10}{f(bc):>9}{(b['win'] * 100 if b else 0):>5.0f}%{pf(b['pf']) if b else '-':>6} | "
                       f"{al['dd']:>7.0f}{al['run']:>9}{star}")
            print(f"  verified {c['s']} {c['n']}m {c['stop']} {c['tgt']} ({time.time() - t0:.0f}s)", flush=True)
    mt5.shutdown()
    out.append("\nWorth paper trading only if a combination is positive on TICKS in both the tune period and the hold-out,"
               " with enough trades (40+ in the hold-out is better) and a drawdown you can survive.")
    out.append(f"Finished in {time.time() - t0:.0f}s.")
    report = "\n".join(out)
    print(report)
    data = Path(__file__).resolve().parent / "data"
    data.mkdir(exist_ok=True)
    (data / f"orb_scan_{args.symbol}.txt").write_text(report, encoding="utf-8")
    print(f"\nSaved: {data / f'orb_scan_{args.symbol}.txt'}")


if __name__ == "__main__":
    main()
