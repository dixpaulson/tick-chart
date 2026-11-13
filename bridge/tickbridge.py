"""
Tick Chart bridge: connects a running MetaTrader 5 terminal to the Tick Chart web app.

  - serves the web app (index.html, css/, js/)
  - /api/ticks   tick history for any date range (no more manual CSV exports)
  - /ws          live ticks + account, positions and orders
  - /api/trade   place / modify / close orders (demo-only and lot limit enforced here)
  - /api/lines   horizontal lines shared between your devices

Run:  python tickbridge.py          (start_bridge.bat does this for you)
Settings live in config.json next to this file (created on first run).
"""
import argparse
import asyncio
import json
import logging
import math
import os
import secrets
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from aiohttp import WSMsgType, web

VERSION = "1.0"
HERE = Path(__file__).resolve().parent
APP_ROOT = HERE.parent
CONFIG_PATH = HERE / "config.json"
DATA_DIR = HERE / "data"

DEFAULT_CONFIG = {
    "port": 8765,
    "host": "auto",            # auto = this PC (127.0.0.1) + its Tailscale address. Or an IP, or "0.0.0.0" (not recommended)
    "symbols": ["GER40", "XAUUSD"],
    "allow_trading": True,     # False = view only
    "demo_only": True,         # refuse orders unless the MT5 account is a DEMO account
    "max_lots": 2.0,           # largest order the bridge will send
    "deviation_points": 30,    # max slippage for market orders, in points
    "magic": 261126,           # tag on orders placed from Tick Chart
    "terminal_path": "",       # path to terminal64.exe if you run several MT5 terminals
    "access_key": "",          # generated on first run; needed to open the page
}

log = logging.getLogger("tickbridge")
mt5 = None                     # MetaTrader5 module (or the mock for testing)
EXEC = ThreadPoolExecutor(max_workers=1)  # the MetaTrader5 package is not thread-safe: one worker only
CFG = {}


# ---------------------------------------------------------------- helpers
def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception as e:  # noqa: BLE001
            log.error("config.json is not valid JSON (%s). Using defaults.", e)
    if not cfg.get("access_key"):
        cfg["access_key"] = secrets.token_urlsafe(18)
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        log.info("Created config.json with a new access key.")
    elif not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return cfg


async def call(fn, *args, **kwargs):
    """Run a MetaTrader5 call on the single MT5 worker thread."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(EXEC, lambda: fn(*args, **kwargs))


def mt5_error():
    try:
        code, msg = mt5.last_error()
        return f"{msg} ({code})"
    except Exception:  # noqa: BLE001
        return "unknown error"


def tailscale_ip():
    exe = shutil.which("tailscale") or r"C:\Program Files\Tailscale\tailscale.exe"
    try:
        out = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=5)
        ip = out.stdout.strip().splitlines()[0].strip() if out.returncode == 0 and out.stdout.strip() else ""
        return ip if ip.startswith("100.") else ""
    except Exception:  # noqa: BLE001
        return ""


def sym_info_dict(name):
    si = mt5.symbol_info(name)
    if si is None:
        return None
    tick_size = si.trade_tick_size or si.point
    return {
        "name": si.name, "description": getattr(si, "description", ""),
        "digits": si.digits, "point": si.point,
        "contract_size": si.trade_contract_size,
        # money per 1.0 price move per 1 lot, in account currency
        "value_per_point": (si.trade_tick_value / tick_size) if tick_size else si.trade_contract_size,
        "volume_min": si.volume_min, "volume_step": si.volume_step, "volume_max": si.volume_max,
        "stops_level": si.trade_stops_level, "currency_profit": si.currency_profit,
    }


def account_dict():
    a = mt5.account_info()
    if a is None:
        return None
    return {
        "login": a.login, "server": a.server, "name": a.name, "currency": a.currency,
        "balance": a.balance, "equity": a.equity, "margin": a.margin, "free_margin": a.margin_free,
        "profit": a.profit, "leverage": a.leverage,
        "demo": a.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO,
        "hedging": a.margin_mode == mt5.ACCOUNT_MARGIN_MODE_RETAIL_HEDGING,
    }


def trading_status():
    """(enabled, reason) for placing orders right now."""
    if not CFG.get("allow_trading"):
        return False, "Trading is switched off in the bridge's config.json (allow_trading)."
    a = mt5.account_info()
    if a is None:
        return False, "Not connected to an MT5 account."
    if CFG.get("demo_only") and a.trade_mode != mt5.ACCOUNT_TRADE_MODE_DEMO:
        return False, "This is a LIVE account and the bridge is set to demo only (demo_only in config.json)."
    ti = mt5.terminal_info()
    if ti is not None and not ti.trade_allowed:
        return False, "Algo Trading is off in MT5. Click the 'Algo Trading' button in the MT5 toolbar."
    return True, ""


def positions_list(symbol):
    out = []
    for p in mt5.positions_get(symbol=symbol) or ():
        out.append({
            "ticket": p.ticket, "time_msc": p.time_msc, "side": "buy" if p.type == mt5.ORDER_TYPE_BUY else "sell",
            "lots": p.volume, "entry": p.price_open, "sl": p.sl or None, "tp": p.tp or None,
            "current": p.price_current, "profit": p.profit, "swap": p.swap, "magic": p.magic, "comment": p.comment,
        })
    return out


ORDER_KIND = {}  # filled after mt5 import


def orders_list(symbol):
    out = []
    for o in mt5.orders_get(symbol=symbol) or ():
        kind = ORDER_KIND.get(o.type)
        if not kind:
            continue
        out.append({
            "ticket": o.ticket, "time_msc": o.time_setup_msc, "side": kind[0], "type": kind[1],
            "lots": o.volume_current, "price": o.price_open, "sl": o.sl or None, "tp": o.tp or None,
            "magic": o.magic, "comment": o.comment,
        })
    return out


def ticks_to_rows(arr):
    """numpy structured array (or list of records) -> list of [time_msc, bid, ask, flags]."""
    if arr is None or len(arr) == 0:
        return []
    try:
        return [[int(t), float(b), float(a), int(f)] for t, b, a, f in
                zip(arr["time_msc"], arr["bid"], arr["ask"], arr["flags"])]
    except (TypeError, IndexError, ValueError):
        return [[int(x.time_msc), float(x.bid), float(x.ask), int(x.flags)] for x in arr]


# ---------------------------------------------------------------- auth
@web.middleware
async def auth_mw(request, handler):
    key = CFG["access_key"]
    given = request.query.get("key") or request.headers.get("X-Access-Key") or request.cookies.get("tc_key") or ""
    if not secrets.compare_digest(given, key):
        return web.Response(status=401, content_type="text/html", text=(
            "<h3>Tick Chart bridge</h3><p>Access key missing or wrong. Open the full link shown in the "
            "bridge window (it ends with <code>?key=...</code>).</p>"))
    if request.query.get("key") and request.path == "/":
        resp = web.HTTPFound("/")
        resp.set_cookie("tc_key", key, max_age=365 * 86400, httponly=True, samesite="Strict")
        raise resp
    resp = await handler(request)
    return resp


# ---------------------------------------------------------------- HTTP handlers
async def index(request):
    return web.FileResponse(APP_ROOT / "index.html", headers={"Cache-Control": "no-cache"})


async def api_info(request):
    def work():
        acc = account_dict()
        syms = []
        for s in CFG["symbols"]:
            mt5.symbol_select(s, True)
            d = sym_info_dict(s)
            if d:
                syms.append(d)
            else:
                log.warning("Symbol %s not found in MT5 (check the exact name in Market Watch)", s)
        enabled, reason = trading_status()
        server_ms = 0
        for s in syms:
            t = mt5.symbol_info_tick(s["name"])
            if t is not None:
                server_ms = max(server_ms, int(t.time_msc))
        return {"version": VERSION, "account": acc, "symbols": syms, "trading": {"enabled": enabled, "reason": reason},
                "limits": {"max_lots": CFG["max_lots"], "demo_only": CFG["demo_only"]},
                "server_time_ms": server_ms, "now_ms": int(time.time() * 1000)}
    return web.json_response(await call(work))


async def api_ticks(request):
    symbol = request.query.get("symbol", "")
    if symbol not in CFG["symbols"]:
        raise web.HTTPBadRequest(text=f"Unknown symbol {symbol}")
    try:
        frm = int(request.query["from"])   # server-time ms
        to = int(request.query["to"])
    except (KeyError, ValueError):
        raise web.HTTPBadRequest(text="from and to (server time, ms) are required")
    if to <= frm or to - frm > 40 * 86400000:
        raise web.HTTPBadRequest(text="Choose a range of at most 40 days")

    def work():
        mt5.symbol_select(symbol, True)
        si = mt5.symbol_info(symbol)
        parts = [f"#symbol={symbol},digits={si.digits},point={si.point}\n", "time_msc,bid,ask,flags\n"]
        fmt = "{:d},{:.%df},{:.%df},{:d}\n" % (si.digits, si.digits)
        total = 0
        day = 86400000
        cs = frm
        while cs < to:
            ce = min(cs + day, to)
            arr = None
            for _ in range(10):
                arr = mt5.copy_ticks_range(symbol, cs // 1000, ce // 1000 + 1, mt5.COPY_TICKS_ALL)
                if arr is not None:
                    break
                time.sleep(0.4)  # history still downloading
            rows = [r for r in ticks_to_rows(arr) if cs <= r[0] < ce]
            parts.append("".join(fmt.format(*r) for r in rows))
            total += len(rows)
            cs = ce
        log.info("History %s: %d ticks", symbol, total)
        return "".join(parts)
    text = await call(work)
    resp = web.Response(text=text, content_type="text/csv")
    resp.enable_compression()
    return resp


async def api_prevday(request):
    """Previous trading day's H/L/C (MT5 D1 bar) before server time `before` (ms): used for CPR."""
    symbol = request.query.get("symbol", "")
    if symbol not in CFG["symbols"]:
        raise web.HTTPBadRequest(text=f"Unknown symbol {symbol}")
    before = int(request.query.get("before", "0"))

    def work():
        rates = mt5.copy_rates_range(symbol, mt5.TIMEFRAME_D1, (before - 15 * 86400000) // 1000, (before - 1) // 1000)
        if rates is None or len(rates) == 0:
            return None
        bars = [r for r in rates if int(r["time"]) * 1000 < before]
        if not bars:
            return None
        b = bars[-1]
        return {"time": int(b["time"]) * 1000, "h": float(b["high"]), "l": float(b["low"]), "c": float(b["close"])}
    return web.json_response(await call(work))


def lines_path(symbol):
    safe = "".join(ch for ch in symbol if ch.isalnum() or ch in "._-")
    return DATA_DIR / f"lines_{safe}.json"


async def api_lines_get(request):
    p = lines_path(request.query.get("symbol", ""))
    data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
    return web.json_response(data)


async def api_lines_put(request):
    symbol = request.query.get("symbol", "")
    data = await request.json()
    if not isinstance(data, list) or len(data) > 500:
        raise web.HTTPBadRequest(text="Expected a list of lines")
    clean = [{"id": str(x.get("id"))[:40], "price": float(x["price"]), "color": str(x.get("color", "#ffffff"))[:20]}
             for x in data if isinstance(x, dict) and "price" in x]
    DATA_DIR.mkdir(exist_ok=True)
    lines_path(symbol).write_text(json.dumps(clean), encoding="utf-8")
    return web.json_response({"ok": True, "count": len(clean)})


# ---------------------------------------------------------------- trading
RETCODE_TEXT = {
    10004: "Requote", 10006: "Request rejected", 10013: "Invalid request", 10014: "Invalid volume",
    10015: "Invalid price", 10016: "Invalid S/L or T/P (too close to the price? check the stops level)",
    10017: "Trading is disabled for this symbol", 10018: "Market is closed", 10019: "Not enough money",
    10020: "Prices changed", 10021: "No quotes", 10022: "Invalid expiration", 10024: "Too many requests",
    10026: "Auto trading disabled by the server", 10027: "Algo Trading is off in MT5 (toolbar button)",
    10030: "Unsupported filling mode", 10031: "No connection to the trade server",
}


def round_volume(si, lots):
    step = si.volume_step or 0.01
    v = math.floor(lots / step + 1e-9) * step
    return round(max(si.volume_min, min(v, si.volume_max)), 8)


def filling_for(si, pending=False):
    if pending:
        return mt5.ORDER_FILLING_RETURN
    fm = si.filling_mode or 0
    if fm & 1:
        return mt5.ORDER_FILLING_FOK
    if fm & 2:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


def do_trade(req):
    enabled, reason = trading_status()
    if not enabled:
        return {"ok": False, "message": reason}
    action = req.get("action")
    symbol = req.get("symbol", "")
    if symbol not in CFG["symbols"]:
        return {"ok": False, "message": f"Symbol {symbol} is not in the bridge's symbol list"}
    si = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if si is None or tick is None:
        return {"ok": False, "message": f"No price for {symbol}: {mt5_error()}"}
    d = si.digits
    rp = lambda x: round(float(x), d) if x not in (None, "", 0) else 0.0  # noqa: E731
    base = {"symbol": symbol, "magic": CFG["magic"], "comment": "TickChart", "type_time": mt5.ORDER_TIME_GTC}

    if action in ("market", "pending"):
        lots = float(req.get("lots", 0))
        if lots <= 0:
            return {"ok": False, "message": "Lot size must be above 0"}
        if lots > CFG["max_lots"] + 1e-9:
            return {"ok": False, "message": f"Lot size {lots} is above the limit of {CFG['max_lots']} lots"}
        vol = round_volume(si, lots)
        side = req.get("side")
        if side not in ("buy", "sell"):
            return {"ok": False, "message": "side must be buy or sell"}
        if action == "market":
            r = dict(base, action=mt5.TRADE_ACTION_DEAL, volume=vol,
                     type=mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
                     price=tick.ask if side == "buy" else tick.bid,
                     sl=rp(req.get("sl")), tp=rp(req.get("tp")),
                     deviation=int(CFG["deviation_points"]), type_filling=filling_for(si))
        else:
            kind = req.get("type")
            types = {("buy", "limit"): mt5.ORDER_TYPE_BUY_LIMIT, ("sell", "limit"): mt5.ORDER_TYPE_SELL_LIMIT,
                     ("buy", "stop"): mt5.ORDER_TYPE_BUY_STOP, ("sell", "stop"): mt5.ORDER_TYPE_SELL_STOP}
            if (side, kind) not in types:
                return {"ok": False, "message": "type must be limit or stop"}
            r = dict(base, action=mt5.TRADE_ACTION_PENDING, volume=vol, type=types[(side, kind)],
                     price=rp(req.get("price")), sl=rp(req.get("sl")), tp=rp(req.get("tp")),
                     type_filling=filling_for(si, pending=True))
    elif action == "modify_position":
        pos = (mt5.positions_get(ticket=int(req["ticket"])) or [None])[0]
        if pos is None:
            return {"ok": False, "message": "Position not found (already closed?)"}
        r = {"action": mt5.TRADE_ACTION_SLTP, "symbol": symbol, "position": pos.ticket,
             "sl": rp(req.get("sl")), "tp": rp(req.get("tp")), "magic": CFG["magic"]}
    elif action == "modify_order":
        o = (mt5.orders_get(ticket=int(req["ticket"])) or [None])[0]
        if o is None:
            return {"ok": False, "message": "Order not found (filled or cancelled?)"}
        r = {"action": mt5.TRADE_ACTION_MODIFY, "symbol": symbol, "order": o.ticket,
             "price": rp(req.get("price", o.price_open)), "sl": rp(req.get("sl")), "tp": rp(req.get("tp")),
             "type_time": mt5.ORDER_TIME_GTC}
    elif action == "close":
        pos = (mt5.positions_get(ticket=int(req["ticket"])) or [None])[0]
        if pos is None:
            return {"ok": False, "message": "Position not found (already closed?)"}
        buy = pos.type == mt5.ORDER_TYPE_BUY
        r = dict(base, action=mt5.TRADE_ACTION_DEAL, position=pos.ticket, volume=pos.volume,
                 type=mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY,
                 price=tick.bid if buy else tick.ask, deviation=int(CFG["deviation_points"]),
                 type_filling=filling_for(si))
    elif action == "cancel":
        r = {"action": mt5.TRADE_ACTION_REMOVE, "order": int(req["ticket"])}
    else:
        return {"ok": False, "message": f"Unknown action {action}"}

    res = mt5.order_send(r)
    if res is None:
        msg = f"MT5 refused the request: {mt5_error()}"
        log.warning("%s %s -> %s", action, r, msg)
        return {"ok": False, "message": msg}
    ok = res.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, mt5.TRADE_RETCODE_DONE_PARTIAL)
    text = RETCODE_TEXT.get(res.retcode, res.comment or "")
    log.info("TRADE %s %s -> %s %s %s", action, {k: v for k, v in r.items() if k != "comment"}, res.retcode, res.comment, "OK" if ok else "FAILED")
    return {"ok": ok, "retcode": res.retcode, "message": ("Done" if ok else f"{text} [{res.retcode}]"),
            "order": getattr(res, "order", 0), "deal": getattr(res, "deal", 0), "price": getattr(res, "price", 0)}


async def api_trade(request):
    try:
        req = await request.json()
    except Exception:  # noqa: BLE001
        raise web.HTTPBadRequest(text="Expected JSON")
    try:
        result = await call(do_trade, req)
    except Exception as e:  # noqa: BLE001
        log.exception("trade failed")
        result = {"ok": False, "message": f"Bridge error: {e}"}
    return web.json_response(result)


# ---------------------------------------------------------------- live websocket
async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    state = {"symbol": None, "last_msc": 0, "n_at_last": 0}

    def subscribe(symbol, since, since_n):
        # since = time of the client's last tick, since_n = how many ticks it has at exactly that time
        state.update(symbol=symbol, last_msc=int(since or 0), n_at_last=int(since_n or 0))
        if not state["last_msc"]:
            t = mt5.symbol_info_tick(symbol)
            state["last_msc"] = int(t.time_msc) if t is not None else int(time.time() * 1000)
            state["n_at_last"] = 1

    def poll_ticks():
        sym = state["symbol"]
        rows_out = []
        for _ in range(20):  # catch up in chunks of 10000
            arr = mt5.copy_ticks_from(sym, state["last_msc"] // 1000, 10000, mt5.COPY_TICKS_ALL)
            rows = ticks_to_rows(arr)
            seen_at_last = 0
            fresh = []
            for r in rows:
                if r[0] < state["last_msc"]:
                    continue
                if r[0] == state["last_msc"]:
                    seen_at_last += 1
                    if seen_at_last <= state["n_at_last"]:
                        continue
                fresh.append(r)
            if not fresh:
                break
            last = fresh[-1][0]
            same = sum(1 for r in rows if r[0] == last)
            state["last_msc"], state["n_at_last"] = last, same
            rows_out.extend(fresh)
            if len(rows) < 10000:
                break
        return rows_out

    def snapshot():
        sym = state["symbol"]
        enabled, reason = trading_status()
        return {"type": "account", "account": account_dict(), "positions": positions_list(sym),
                "orders": orders_list(sym), "trading": {"enabled": enabled, "reason": reason}}

    async def pump():
        last_snap = 0.0
        while not ws.closed:
            if state["symbol"]:
                rows = await call(poll_ticks)
                if rows:
                    await ws.send_json({"type": "ticks", "symbol": state["symbol"], "rows": rows})
                now = time.monotonic()
                if now - last_snap > 0.5:
                    last_snap = now
                    await ws.send_json(await call(snapshot))
            await asyncio.sleep(0.12)

    task = asyncio.create_task(pump())
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                if m.get("type") == "subscribe" and m.get("symbol") in CFG["symbols"]:
                    await call(subscribe, m["symbol"], m.get("since"), m.get("since_n"))
                    await ws.send_json({"type": "subscribed", "symbol": m["symbol"]})
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        task.cancel()
    return ws


# ---------------------------------------------------------------- startup
def connect_mt5():
    kw = {"path": CFG["terminal_path"]} if CFG.get("terminal_path") else {}
    for attempt in range(1, 6):
        if mt5.initialize(**kw):
            break
        log.error("Could not connect to MT5 (attempt %d): %s. Is the MT5 terminal running and logged in?", attempt, mt5_error())
        time.sleep(3)
    else:
        sys.exit("Giving up: could not connect to MetaTrader 5.")
    a = mt5.account_info()
    if a:
        log.info("Connected to MT5: %s, account %s (%s, %s)", a.server, a.login,
                 "DEMO" if a.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO else "LIVE",
                 "hedging" if a.margin_mode == mt5.ACCOUNT_MARGIN_MODE_RETAIL_HEDGING else "netting")
    for s in CFG["symbols"]:
        if not mt5.symbol_select(s, True):
            log.warning("Symbol %s not found. Edit 'symbols' in config.json to match MT5's Market Watch names.", s)


def main():
    global mt5, CFG
    ap = argparse.ArgumentParser(description="Tick Chart bridge for MetaTrader 5")
    ap.add_argument("--mock", action="store_true", help="use a simulated MT5 (for testing without MetaTrader)")
    ap.add_argument("--port", type=int)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S",
                        handlers=[logging.StreamHandler(sys.stdout)])
    DATA_DIR.mkdir(exist_ok=True)
    fh = logging.FileHandler(DATA_DIR / "bridge.log", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s  %(message)s"))
    log.addHandler(fh)

    if args.mock:
        import mock_mt5 as module  # noqa: PLC0415
    else:
        try:
            import MetaTrader5 as module  # noqa: PLC0415
        except ImportError:
            sys.exit("The MetaTrader5 package is missing. Run:  pip install -r requirements.txt")
    mt5 = module
    ORDER_KIND.update({mt5.ORDER_TYPE_BUY_LIMIT: ("buy", "limit"), mt5.ORDER_TYPE_SELL_LIMIT: ("sell", "limit"),
                       mt5.ORDER_TYPE_BUY_STOP: ("buy", "stop"), mt5.ORDER_TYPE_SELL_STOP: ("sell", "stop")})

    CFG = load_config()
    if args.port:
        CFG["port"] = args.port
    connect_mt5()

    app = web.Application(middlewares=[auth_mw], client_max_size=2 * 1024 * 1024)
    app.router.add_get("/", index)
    app.router.add_get("/index.html", index)
    app.router.add_static("/css", APP_ROOT / "css")
    app.router.add_static("/js", APP_ROOT / "js")
    app.router.add_get("/api/info", api_info)
    app.router.add_get("/api/ticks", api_ticks)
    app.router.add_get("/api/prevday", api_prevday)
    app.router.add_get("/api/lines", api_lines_get)
    app.router.add_put("/api/lines", api_lines_put)
    app.router.add_post("/api/trade", api_trade)
    app.router.add_get("/ws", ws_handler)

    host = CFG["host"]
    hosts = ["127.0.0.1"]
    if host == "auto":
        ts = tailscale_ip()
        if ts:
            hosts.append(ts)
        else:
            log.warning("Tailscale not found: the chart is only reachable on this PC. Install Tailscale to use your phone.")
    elif host:
        hosts = [host]

    async def run():
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        for h in hosts:
            await web.TCPSite(runner, h, CFG["port"]).start()
        key = CFG["access_key"]
        print("\n" + "=" * 72)
        print("  Tick Chart bridge is running. Keep this window open.\n")
        for h in hosts:
            label = "this PC" if h == "127.0.0.1" else ("phone / other devices (Tailscale)" if h.startswith("100.") else h)
            print(f"  {label}:\n    http://{h}:{CFG['port']}/?key={key}\n")
        print("  Trading:", "ON" if CFG["allow_trading"] else "OFF",
              f"| demo only: {CFG['demo_only']} | max lots: {CFG['max_lots']}")
        print("=" * 72 + "\n", flush=True)
        while True:
            await asyncio.sleep(3600)

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
