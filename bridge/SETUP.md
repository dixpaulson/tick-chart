# Live setup: MT5 on your Windows VPS + phone

This connects the Tick Chart page to your running MetaTrader 5 so you get:

- live tick charts that update with every tick
- history for any date loaded straight from MT5 (no more CSV exports)
- trading your **demo** account from the chart: market orders, limit/stop orders by tapping the chart, and dragging S/L and T/P
- the same chart on your phone, privately, through Tailscale

```
MT5 terminal  ──>  Tick Chart bridge (Python, on the VPS)  ──>  browser on the VPS / your phone
```

Setup takes about 20 minutes and only needs to be done once.

---

## 1. Get the files onto the VPS

1. On the VPS, open https://github.com/dixpaulson/tick-chart → **Code → Download ZIP**.
2. Unzip it somewhere permanent, for example `C:\TickChart\`.
   You should then have `C:\TickChart\index.html` and `C:\TickChart\bridge\start_bridge.bat`.

## 2. Install Python (once)

1. Download **Python 3.12 (64-bit)** from https://www.python.org/downloads/windows/ ("Windows installer (64-bit)").
2. Run it. On the first screen tick **"Add python.exe to PATH"**, then click **Install Now**.

> The MetaTrader5 Python package needs 64-bit Python and 64-bit MT5. All current MT5 terminals are 64-bit.

## 3. Prepare MT5

1. Make sure MT5 is running and logged in to your **demo** account (File → Login to Trade Account).
2. **Tools → Options → Expert Advisors**: tick **Allow algorithmic trading**.
3. Make sure the **Algo Trading** button in the MT5 toolbar is switched on (green).
   Without it, MT5 refuses orders sent from Python. The chart still shows prices, and order buttons explain the problem.
4. In **Market Watch**, check that `GER40` and `XAUUSD` are listed under exactly those names.

## 4. Start the bridge

1. Double-click `C:\TickChart\bridge\start_bridge.bat`.
   The first time, it installs the Python packages, which takes a minute.
2. When it's ready, the window shows something like:

   ```
   Tick Chart bridge is running. Keep this window open.

     this PC:
       http://127.0.0.1:8765/?key=AbC123...
   ```
3. Open that link in a browser **on the VPS**. You should see the live GER40 tick chart, with **● Live** and **DEMO <your account number>** in the toolbar.

Keep the bridge window open (minimise it). Closing it stops live data.

**Optional: start automatically after a VPS restart.** Press `Win + R`, type `shell:startup`, press Enter, and put a shortcut to `start_bridge.bat` in that folder. Keep MT5 set to start with Windows too.

## 5. Phone access with Tailscale

Tailscale is a free private network that only your devices can join. Nothing is opened to the internet.

1. **On the VPS**: install Tailscale from https://tailscale.com/download/windows and sign in (Google, Microsoft or similar).
2. **On your phone**: install the **Tailscale** app (App Store / Google Play) and sign in with the **same account**. Switch it on.
3. **Restart the bridge** (close its window, double-click `start_bridge.bat` again). It now shows a second link:

   ```
     phone / other devices (Tailscale):
       http://100.x.y.z:8765/?key=AbC123...
   ```
4. **Allow it through Windows Firewall.** The first time, Windows may ask whether Python can use the network: click **Allow**.
   If the phone can't connect, open **Command Prompt as administrator** on the VPS and run this once. It allows the bridge's port only from your Tailscale devices:

   ```
   netsh advfirewall firewall add rule name="Tick Chart bridge" dir=in action=allow protocol=TCP localport=8765 remoteip=100.64.0.0/10
   ```
5. On the phone, with Tailscale switched on, open the `100.x.y.z` link. After the first visit the key is remembered, so you can bookmark `http://100.x.y.z:8765/` or use **Share → Add to Home Screen** to get an app-like icon.

The key in the link is a second lock on top of Tailscale. Don't post it anywhere. To change it, delete the `"access_key"` line from `bridge\config.json` and restart the bridge; a new key is created.

## 6. Using it

| | |
|---|---|
| **● Live / ○ Live** | Turns live mode on or off. The symbol box switches between GER40 and XAUUSD. |
| **History → Load** | Loads any trading days straight from MT5. Then use **⏪ Replay** to practise, with paper trading, on that data. |
| **BUY / SELL** | Market order with the lot size in the box. By default you're asked to confirm; tick **one-click** to skip that. |
| **Buy Limit / Sell Limit** | Then tap the chart at your price. On the wrong side of the market, it becomes a Stop order. |
| **Drag lines** | Drag S/L, T/P or a pending order to change it in MT5. Drag a **position's line** up or down to add a T/P or S/L. |
| **─ Line** (key H) | Draws a support/resistance line. Tap a line to recolour or delete it. Lines are saved on the bridge, so the phone and the VPS show the same lines. |
| **Next ⓘ** | Next-candle forecast: likely range (ghost box) and direction odds, learned from the last 30 days of MT5 history. The panel shows whether it has any real edge in testing. |
| **Times** | Shown in Kitchener time (⚙ Settings → Time). The broker's trading day, which is used for CPR and day separators, starts at 17:00 Kitchener time. |

The badge above the BUY/SELL buttons always tells you where orders go: **Paper (replay)**, **DEMO account**, or **LIVE account** (red).

## 7. Safety settings (`bridge\config.json`)

Open it with Notepad and restart the bridge after any change.

| Setting | Default | Meaning |
|---|---|---|
| `demo_only` | `true` | The bridge refuses to trade unless MT5 is logged in to a **demo** account. |
| `max_lots` | `2.0` | Largest order the bridge will send (also limited on the page). |
| `allow_trading` | `true` | `false` = view only, no orders at all. |
| `symbols` | `["GER40", "XAUUSD"]` | Must match the names in MT5's Market Watch exactly. |
| `deviation_points` | `30` | Maximum slippage accepted on market orders, in points. |
| `port` | `8765` | Change only if something else uses this port. |

**Moving to a live account later:** log MT5 in to the live account, set `"demo_only": false`, and restart the bridge. The page then shows a red **LIVE account** badge and red confirm buttons.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Python was not found" | Install Python (step 2) with "Add python.exe to PATH" ticked, then run `start_bridge.bat` again. |
| "Could not connect to MT5" | Start MT5 and log in first. If you run several MT5 terminals, set `"terminal_path"` in `config.json` to the right `terminal64.exe`. |
| "Symbol GER40 not found" | Edit `"symbols"` in `config.json` to the exact Market Watch names. |
| Orders say "Algo Trading is off" | Switch on the **Algo Trading** button in MT5's toolbar (step 3). |
| "Invalid S/L or T/P" | S/L and T/P must be at least the broker's stops level away from the price (GER40: 50 points = 0.50). |
| Phone can't open the page | Tailscale switched on on both devices? Same Tailscale account? Firewall rule from step 5.4? Use the `100.x.y.z` link, not `127.0.0.1`. |
| Times are off by an hour | ⚙ Settings → Time → **MT5 server clock**: choose the option that matches your broker. |

The bridge writes a log to `bridge\data\bridge.log`, including every order it sent and MT5's reply.
