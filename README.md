# Tick Chart

An MT5-style **historical tick chart** viewer with **replay** and **paper trading**. It runs in your browser from a single local page. Nothing is uploaded, and your tick data stays on your PC.

- N-tick candles (50 by default) that rebuild instantly when you change the tick count
- Each new day starts a fresh candle, like TickChart GenX's "Synchronize first bar's open on new day"
- 2 moving averages (SMA / EMA / SMMA / LWMA, the same methods as MT5)
- Daily CPR (P, TC, BC) plus floor pivots R1–R3 / S1–S3, with an info panel showing CPR width, price vs CPR, and the relationship to the previous day's CPR
- Replay one tick at a time, one candle at a time, or at a multiple of real time. You can also jump to any date/time
- Paper trading with bid/ask spread: market orders, plus limit/stop orders you place by clicking on the chart. S/L and T/P lines can be dragged, and you can export your trade log to CSV

## Live data and trading (MT5 bridge)

Run the small Python **bridge** on the PC or VPS where MT5 runs, and the same page becomes a live tick chart:
- history for any date loaded straight from MT5
- trading your demo account: market orders, limit/stop orders by tapping the chart, and draggable S/L and T/P
- phone access through Tailscale

Setup steps: **[bridge/SETUP.md](bridge/SETUP.md)**.

## Quick start (files, no bridge)

1. Download/clone this repo.
2. Double-click **`index.html`** (Chrome or Edge recommended). No install or server is needed.
3. Open your tick file with **📂 Open ticks**, or drag it onto the page.
   No file yet? Choose **Demo data** to try the app.

### Loading several days

- **📂 Open ticks** lets you select several files at once (Ctrl/Shift-click). For example, pick one MT5 export per day, and they're combined into one chart.
- Once data is loaded, **➕ Add days** (or dropping more files onto the chart) adds files to what is already there.
- Files can be in any order and may overlap; duplicate ticks are removed. All files must be for the same symbol.
- Load the day **before** the first day you want to study, so that day also gets its CPR.

## Getting tick data out of MT5

### Option A: ExportTicks script (recommended)

1. In MT5: **File → Open Data Folder → MQL5 → Scripts**. Copy `mql5/ExportTicks.mq5` there.
2. In MetaEditor, open it and press **Compile** (F7). Alternatively, right-click Scripts in the MT5 Navigator → Refresh.
3. Drag **ExportTicks** onto a GER40 or XAUUSD chart. Inputs:
   - `Trading days` – how many days to export, including today (for example 5)
   - `Also export the day before` – keep this **on** so the first day also gets its CPR
   - Or set an explicit start/end date instead
4. The file is saved to `MQL5\Files\SYMBOL_ticks_FROM_to_TO.csv`. A popup shows the full path.

### Option B: MT5 built-in export

**View → Symbols → Ticks** tab → pick the symbol and date range → **Request** → **Export ticks**.
The app reads this tab-separated format directly (UTF-16 or UTF-8).

> All times are your broker's **server time**, exactly as MT5 shows them. Days, and therefore CPR and the day-start candle sync, roll over at server midnight.

## Using the chart

| Action | How |
|---|---|
| Zoom / scroll | Mouse wheel / drag the chart. Drag the price axis to stretch it |
| Change ticks per candle | Box in the toolbar (presets 10…1000) |
| Indicators, colours, trading settings | **⚙ Settings** |
| Jump to a time | Date box → **Go** |
| Support / resistance lines | **─ Line** (key **H**), then click the chart. Drag to move; click a line to recolour or delete it (or press Del) |
| Time zone | Times are shown in Kitchener time by default. The broker's server is assumed to run at New York + 7h, as most brokers' do. Change this in ⚙ Settings → Time |

### Replay

1. Click **⏪ Replay**, then click a candle. Replay starts right after it. You can also enter a date/time and press **Go**.
2. **▶** / **Space** play/pause · **⏭** / **→** next candle · **+1** / **Shift+→** next tick.
3. Speed units: *ticks/s*, *candles/s*, or *× real time* (long gaps such as overnight are skipped).
4. **⏹ Stop replay** returns to the full history. Any open trades are closed at the current price.

### Paper trading (during replay)

- **BUY / SELL** buttons (top-left), or keys **B** / **S**: market order at ask / bid.
- **Buy Limit / Sell Limit**, then click the chart at your price. If you click on the "wrong" side of the market, it becomes a Stop order.
- **Drag** an order line to move it. Its S/L and T/P move with it.
- **Drag** S/L or T/P lines to adjust them.
- **Drag a position's entry line** up or down to create a T/P or S/L (like MT5).
- **+SL / +TP / ✕** buttons in the Trade tab. Default S/L and T/P distances can be set in Settings.
- Fills: buy orders fill at ask, sell orders at bid. Limit orders and T/P fill at your price; stop orders and S/L fill at the market price, so a gap causes slippage.
- **Value of 1 point for 1 lot** (Settings) converts points to money. It is saved per symbol, in USD, with defaults of GER40 = 11.6 USD (10 EUR per point per lot, converted at about 1.16 USD/EUR) and XAUUSD = 100 USD. With the bridge, the value comes from MT5. Check your broker's contract specification.
- The History tab has **Export CSV** and **Reset account**.

## Next-candle forecast (pattern matching)

At every candle close, the app describes the situation in numbers. It uses:
- the last 5 candle shapes
- momentum
- price against MA 1, MA 2 and the CPR levels
- volatility and candle speed
- the time of day

It then finds the most similar moments in history and shows what the **next** candle did after them.

- **Ghost box** over the forming (or next) candle: the inner box is where the next candle stayed half the time, the outer box 80% of the time. The thick line is the average move, and the label is the direction odds.
- **Panel** (**Next ⓘ**): up/down odds compared with the normal rate, the likely range in points, and how many past patterns it is based on. It only says "leans UP/DOWN" when the difference is statistically meaningful.
- **Test on unseen data**: the method learns from the first 70% of the history and is graded on the remaining 30%. If direction accuracy can't beat a coin flip, it says **no reliable edge**.
- **Scorecard**: during replay or live, it counts how often the forecast was right.
- **No peeking**: a forecast only learns from candles that had finished before it. In replay, the future is never used.
- **More history = better statistics.** With the bridge, it learns from the last 30 days of MT5 history (Settings: 10–60 days). With files, it uses the days you loaded.

Expect the direction odds to sit close to 50%: short-term direction is mostly noise. The range forecast is usually the more useful part, for placing S/L and T/P.

## How ticks are counted

*Every tick* (the default) counts every tick record from MT5, as most MT5 tick-chart tools do. *Only bid changes* ignores ticks where only the ask moved. Candles are always drawn from the **bid** price, like MT5 charts.

## Project layout

```
index.html            page
css/style.css         styles
js/data.js            parsing, tick candles (incremental), CPR, moving averages
js/time.js            server time -> local time
js/forecast.js        next-candle forecast (pattern matching + out-of-sample test)
js/app.js             chart, replay, paper + live trading, lines, UI
bridge/               Python bridge to MT5 (tickbridge.py, start_bridge.bat, SETUP.md)
js/lib/               TradingView Lightweight Charts v4.2.0 (Apache-2.0)
mql5/ExportTicks.mq5  MT5 export script
```

Charts are rendered with [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/) (Apache License 2.0; see `js/lib/LIGHTWEIGHT-CHARTS-LICENSE`).
