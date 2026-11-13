/* Tick Chart — time zones.
   Tick times are MT5 *server* wall-clock times (stored as if UTC). This converts them for display.
   Most brokers run the server at New York time + 7h (GMT+2 in winter, GMT+3 in summer), so server
   midnight = 17:00 New York, the daily close. */
(function (global) {
  'use strict';
  const HOUR = 3600000;
  const dtfCache = new Map();
  const offCache = new Map();

  function dtf(tz) {
    let f = dtfCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      dtfCache.set(tz, f);
    }
    return f;
  }
  // Offset (ms) of time zone `tz` from UTC at instant utcMs. Cached per 15 minutes.
  function tzOffset(tz, utcMs) {
    const key = tz + ':' + Math.floor(utcMs / 900000);
    let v = offCache.get(key);
    if (v !== undefined) return v;
    const base = Math.floor(utcMs / 900000) * 900000;
    const p = {};
    for (const x of dtf(tz).formatToParts(new Date(base))) p[x.type] = x.value;
    v = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - base;
    if (offCache.size > 20000) offCache.clear();
    offCache.set(key, v);
    return v;
  }
  const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } };

  // Server offset from UTC (ms) for a server wall-clock time.
  function serverOffset(serverMs, rule) {
    if (rule === 'ny7' || !rule) return tzOffset('America/New_York', serverMs - 2.5 * HOUR) + 7 * HOUR;
    return (+rule || 0) * HOUR; // fixed GMT+X
  }
  function displayZone(cfg) {
    if (!cfg || cfg.display === 'server') return null;
    return cfg.display === 'device' ? deviceTz() : cfg.display;
  }
  // server wall clock -> display wall clock (both "as if UTC")
  function toDisplay(serverMs, cfg) {
    const tz = displayZone(cfg);
    if (!tz) return serverMs;
    const utc = serverMs - serverOffset(serverMs, cfg.server);
    return utc + tzOffset(tz, utc);
  }
  function fromDisplay(dispMs, cfg) {
    if (!displayZone(cfg)) return dispMs;
    let s = dispMs - (toDisplay(dispMs, cfg) - dispMs);
    s = dispMs - (toDisplay(s, cfg) - s);
    return s;
  }
  function zoneLabel(cfg) {
    const tz = displayZone(cfg);
    if (!tz) return 'server time';
    if (tz === 'America/Toronto') return 'Kitchener time';
    return tz.split('/').pop().replace(/_/g, ' ') + ' time';
  }
  // Measured server offset (hours) from a live server timestamp, for checking the rule.
  function ruleMatches(serverNowMs, cfg) {
    const measured = Math.round((serverNowMs - Date.now()) / HOUR);
    return { measured, expected: Math.round(serverOffset(serverNowMs, cfg.server) / HOUR) };
  }

  global.TickTime = { toDisplay, fromDisplay, zoneLabel, serverOffset, tzOffset, ruleMatches, deviceTz };
})(window);
