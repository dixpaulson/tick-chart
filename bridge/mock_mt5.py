"""
Simulated MetaTrader5 module, used by `python tickbridge.py --mock` to test the bridge and the
web app without an MT5 terminal. It produces random-walk ticks in "server time" (UTC+2) and
simulates a DEMO hedging account with market/pending orders and S/L / T/P.
Only the parts of the MetaTrader5 API that the bridge uses are implemented.
"""
import bisect
import random
import threading
import time
from collections import namedtuple

import numpy as np

# ---- constants (same values as the real package)
COPY_TICKS_ALL = 1
TIMEFRAME_D1 = 16408
ACCOUNT_TRADE_MODE_DEMO, ACCOUNT_TRADE_MODE_REAL = 0, 2
ACCOUNT_MARGIN_MODE_RETAIL_NETTING, ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 0, 2
ORDER_TYPE_BUY, ORDER_TYPE_SELL, ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_SELL_LIMIT, ORDER_TYPE_BUY_STOP, ORDER_TYPE_SELL_STOP = range(6)
ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
ORDER_TIME_GTC = 0
TRADE_ACTION_DEAL, TRADE_ACTION_PENDING, TRADE_ACTION_SLTP, TRADE_ACTION_MODIFY, TRADE_ACTION_REMOVE = 1, 5, 6, 7, 8
TRADE_RETCODE_PLACED, TRADE_RETCODE_DONE, TRADE_RETCODE_DONE_PARTIAL = 10008, 10009, 10010

SERVER_OFFSET_MS = 2 * 3600 * 1000
TICK_DTYPE = np.dtype([("time", "i8"), ("bid", "f8"), ("ask", "f8"), ("last", "f8"), ("volume", "u8"),
                       ("time_msc", "i8"), ("flags", "u4"), ("volume_real", "f8")])

AccountInfo = namedtuple("AccountInfo", "login trade_mode leverage margin_mode balance equity margin margin_free profit name server currency")
TerminalInfo = namedtuple("TerminalInfo", "trade_allowed connected")
SymbolInfo = namedtuple("SymbolInfo", "name description digits point trade_contract_size trade_tick_value trade_tick_size "
                        "volume_min volume_step volume_max trade_stops_level filling_mode currency_profit")
Tick = namedtuple("Tick", "time bid ask last volume time_msc flags")
Position = namedtuple("Position", "ticket time_msc type volume price_open sl tp price_current profit swap magic comment symbol")
Order = namedtuple("Order", "ticket time_setup_msc type volume_current price_open sl tp magic comment symbol")
Result = namedtuple("Result", "retcode deal order volume price comment")

SYMBOLS = {
    "GER40": dict(start=26500.0, vol=0.6, spread=3.0, digits=2, contract=10, stops=50, interval=0.45),
    "XAUUSD": dict(start=2650.0, vol=0.05, spread=0.3, digits=2, contract=100, stops=0, interval=0.35),
}
_lock = threading.RLock()
_feeds = {}
_positions = {}
_orders = {}
_balance = 10000.0
_next_ticket = [5000001]
_last_error = (1, "Success")


def _server_now_ms():
    return int(time.time() * 1000) + SERVER_OFFSET_MS


class _Feed:
    def __init__(self, name, cfg):
        self.name, self.cfg = name, cfg
        self.rng = random.Random(hash(name) & 0xFFFF)
        self.t, self.b, self.a = [], [], []
        self.price = cfg["start"]
        start = _server_now_ms() - 3 * 86400000
        self._gen(start, _server_now_ms())

    def _gen(self, t, until):
        c = self.cfg
        while t < until:
            t += max(20, int(self.rng.expovariate(1 / c["interval"]) * 1000))
            if t > until:
                break
            dow = time.gmtime(t / 1000).tm_wday
            hour = (t // 3600000) % 24
            if dow >= 5 or hour >= 23:      # weekend / daily break: no ticks
                continue
            self.price += self.rng.gauss(0, c["vol"])
            bid = round(self.price, c["digits"])
            ask = round(bid + c["spread"] * (0.9 + self.rng.random() * 0.3), c["digits"])
            self.t.append(t); self.b.append(bid); self.a.append(ask)
            _process_tick(self.name, bid, ask, t)

    def extend(self):
        start = self.t[-1] if self.t else _server_now_ms() - 1000
        self._gen(start, _server_now_ms())

    def array(self, i0, i1):
        n = max(0, i1 - i0)
        arr = np.zeros(n, dtype=TICK_DTYPE)
        if n:
            tm = np.array(self.t[i0:i1], dtype="i8")
            arr["time_msc"] = tm; arr["time"] = tm // 1000
            arr["bid"] = self.b[i0:i1]; arr["ask"] = self.a[i0:i1]; arr["flags"] = 6
        return arr


def _feed(sym):
    with _lock:
        if sym not in SYMBOLS:
            return None
        if sym not in _feeds:
            _feeds[sym] = _Feed(sym, SYMBOLS[sym])
        f = _feeds[sym]
        f.extend()
        return f


def _process_tick(sym, bid, ask, t):
    global _balance
    for tk, o in list(_orders.items()):
        if o["symbol"] != sym:
            continue
        typ, p = o["type"], o["price"]
        hit = ((typ == ORDER_TYPE_BUY_LIMIT and ask <= p) or (typ == ORDER_TYPE_SELL_LIMIT and bid >= p) or
               (typ == ORDER_TYPE_BUY_STOP and ask >= p) or (typ == ORDER_TYPE_SELL_STOP and bid <= p))
        if hit:
            del _orders[tk]
            side = ORDER_TYPE_BUY if typ in (ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_BUY_STOP) else ORDER_TYPE_SELL
            _positions[tk] = dict(ticket=tk, symbol=sym, type=side, volume=o["volume"], price=p, sl=o["sl"], tp=o["tp"], time=t, magic=o["magic"])
    for tk, ps in list(_positions.items()):
        if ps["symbol"] != sym:
            continue
        buy = ps["type"] == ORDER_TYPE_BUY
        px = bid if buy else ask
        if ps["sl"] and ((buy and bid <= ps["sl"]) or (not buy and ask >= ps["sl"])):
            _close(tk, px)
        elif ps["tp"] and ((buy and bid >= ps["tp"]) or (not buy and ask <= ps["tp"])):
            _close(tk, px)


def _profit(ps, bid, ask):
    buy = ps["type"] == ORDER_TYPE_BUY
    cur = bid if buy else ask
    return ((cur - ps["price"]) if buy else (ps["price"] - cur)) * ps["volume"] * SYMBOLS[ps["symbol"]]["contract"]


def _close(tk, px):
    global _balance
    ps = _positions.pop(tk)
    _balance += _profit(ps, px, px)


# ---- API
def initialize(**kw):
    for s in SYMBOLS:
        _feed(s)
    return True


def shutdown():
    return True


def last_error():
    return _last_error


def terminal_info():
    return TerminalInfo(True, True)


def account_info():
    with _lock:
        prof = 0.0
        for ps in _positions.values():
            f = _feeds.get(ps["symbol"])
            if f and f.t:
                prof += _profit(ps, f.b[-1], f.a[-1])
        return AccountInfo(12345678, ACCOUNT_TRADE_MODE_DEMO, 100, ACCOUNT_MARGIN_MODE_RETAIL_HEDGING,
                           round(_balance, 2), round(_balance + prof, 2), 0.0, round(_balance + prof, 2), round(prof, 2),
                           "Demo User", "Mock-Demo", "EUR")


def symbol_select(sym, enable=True):
    return sym in SYMBOLS


def symbol_info(sym):
    c = SYMBOLS.get(sym)
    if not c:
        return None
    pt = 10 ** -c["digits"]
    return SymbolInfo(sym, sym, c["digits"], pt, c["contract"], c["contract"] * pt, pt, 0.01, 0.01, 100.0, c["stops"], 1 | 2,
                      "EUR" if sym == "GER40" else "USD")


def symbol_info_tick(sym):
    f = _feed(sym)
    if not f or not f.t:
        return None
    return Tick(f.t[-1] // 1000, f.b[-1], f.a[-1], 0.0, 0, f.t[-1], 6)


def copy_ticks_range(sym, frm, to, flags):
    f = _feed(sym)
    if not f:
        return None
    with _lock:
        i0 = bisect.bisect_left(f.t, int(frm) * 1000)
        i1 = bisect.bisect_left(f.t, int(to) * 1000)
        return f.array(i0, i1)


def copy_ticks_from(sym, frm, count, flags):
    f = _feed(sym)
    if not f:
        return None
    with _lock:
        i0 = bisect.bisect_left(f.t, int(frm) * 1000)
        return f.array(i0, min(len(f.t), i0 + count))


def copy_rates_range(sym, frm, to, timeframe):
    """Daily bars (server days) built from the simulated ticks."""
    f = _feed(sym)
    if not f:
        return None
    with _lock:
        days = {}
        i0 = bisect.bisect_left(f.t, int(frm) * 1000)
        i1 = bisect.bisect_left(f.t, int(to) * 1000 + 1000)
        for i in range(i0, i1):
            d = f.t[i] // 86400000
            b = f.b[i]
            if d not in days:
                days[d] = [b, b, b, b]
            r = days[d]
            r[1] = max(r[1], b); r[2] = min(r[2], b); r[3] = b
        dt = np.dtype([("time", "i8"), ("open", "f8"), ("high", "f8"), ("low", "f8"), ("close", "f8")])
        arr = np.zeros(len(days), dtype=dt)
        for k, d in enumerate(sorted(days)):
            arr[k] = (d * 86400, *days[d])
        return arr


def positions_get(symbol=None, ticket=None):
    with _lock:
        out = []
        for ps in _positions.values():
            if (symbol and ps["symbol"] != symbol) or (ticket and ps["ticket"] != ticket):
                continue
            f = _feeds[ps["symbol"]]
            cur = f.b[-1] if ps["type"] == ORDER_TYPE_BUY else f.a[-1]
            out.append(Position(ps["ticket"], ps["time"], ps["type"], ps["volume"], ps["price"], ps["sl"], ps["tp"], cur,
                                round(_profit(ps, f.b[-1], f.a[-1]), 2), 0.0, ps["magic"], "", ps["symbol"]))
        return tuple(out)


def orders_get(symbol=None, ticket=None):
    with _lock:
        return tuple(Order(o["ticket"], o["time"], o["type"], o["volume"], o["price"], o["sl"], o["tp"], o["magic"], "", o["symbol"])
                     for o in _orders.values()
                     if not (symbol and o["symbol"] != symbol) and not (ticket and o["ticket"] != ticket))


def order_send(r):
    with _lock:
        a = r.get("action")
        sym = r.get("symbol")
        f = _feeds.get(sym) if sym else None
        tk = _next_ticket[0]
        stops = SYMBOLS[sym]["stops"] * 10 ** -SYMBOLS[sym]["digits"] if sym in SYMBOLS else 0
        bid, ask = (f.b[-1], f.a[-1]) if f else (0, 0)

        def bad_stops(side_buy, ref, sl, tp):
            if sl and ((side_buy and sl > ref - stops) or (not side_buy and sl < ref + stops)):
                return True
            if tp and ((side_buy and tp < ref + stops) or (not side_buy and tp > ref - stops)):
                return True
            return False

        if a == TRADE_ACTION_DEAL and "position" in r:
            if r["position"] not in _positions:
                return Result(10013, 0, 0, 0, 0, "Invalid request")
            px = bid if _positions[r["position"]]["type"] == ORDER_TYPE_BUY else ask
            _close(r["position"], px)
            return Result(TRADE_RETCODE_DONE, tk, tk, r["volume"], px, "Request executed")
        if a == TRADE_ACTION_DEAL:
            buy = r["type"] == ORDER_TYPE_BUY
            px = ask if buy else bid
            if bad_stops(buy, bid if buy else ask, r.get("sl"), r.get("tp")):
                return Result(10016, 0, 0, 0, 0, "Invalid stops")
            _next_ticket[0] += 1
            _positions[tk] = dict(ticket=tk, symbol=sym, type=r["type"], volume=r["volume"], price=px,
                                  sl=r.get("sl") or 0.0, tp=r.get("tp") or 0.0, time=f.t[-1], magic=r.get("magic", 0))
            return Result(TRADE_RETCODE_DONE, tk, tk, r["volume"], px, "Request executed")
        if a == TRADE_ACTION_PENDING:
            _next_ticket[0] += 1
            _orders[tk] = dict(ticket=tk, symbol=sym, type=r["type"], volume=r["volume"], price=r["price"],
                               sl=r.get("sl") or 0.0, tp=r.get("tp") or 0.0, time=f.t[-1], magic=r.get("magic", 0))
            return Result(TRADE_RETCODE_PLACED, 0, tk, r["volume"], r["price"], "Request placed")
        if a == TRADE_ACTION_SLTP:
            ps = _positions.get(r["position"])
            if not ps:
                return Result(10013, 0, 0, 0, 0, "Invalid request")
            buy = ps["type"] == ORDER_TYPE_BUY
            if bad_stops(buy, bid if buy else ask, r.get("sl"), r.get("tp")):
                return Result(10016, 0, 0, 0, 0, "Invalid stops")
            ps["sl"], ps["tp"] = r.get("sl") or 0.0, r.get("tp") or 0.0
            return Result(TRADE_RETCODE_DONE, 0, 0, 0, 0, "Request executed")
        if a == TRADE_ACTION_MODIFY:
            o = _orders.get(r["order"])
            if not o:
                return Result(10013, 0, 0, 0, 0, "Invalid request")
            o["price"], o["sl"], o["tp"] = r["price"], r.get("sl") or 0.0, r.get("tp") or 0.0
            return Result(TRADE_RETCODE_DONE, 0, o["ticket"], 0, 0, "Request executed")
        if a == TRADE_ACTION_REMOVE:
            if _orders.pop(r["order"], None) is None:
                return Result(10013, 0, 0, 0, 0, "Invalid request")
            return Result(TRADE_RETCODE_DONE, 0, r["order"], 0, 0, "Request executed")
        return Result(10013, 0, 0, 0, 0, "Invalid request")
