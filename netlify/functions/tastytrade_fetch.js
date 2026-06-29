/* ============================================================================
   BullScann — Tastytrade Fetch Layer
   ----------------------------------------------------------------------------
   Pulls historical candles (daily + 5-min) for the universe via Tastytrade's
   DXLink/DXFeed stream, and returns plain { t,o,h,l,c,v } arrays that drop
   straight into normalizeBars() + analyzeTicker(). The compute core never changes.

   AUTH: OAuth2. Reads from environment — NEVER hardcode these:
       TASTYTRADE_CLIENT_SECRET
       TASTYTRADE_REFRESH_TOKEN

   ⚠️ ONE THING TO VERIFY ON FIRST RUN ⚠️
   DXFeed candle events arrive over a stream and the exact field names aren't
   fully pinned in Tastytrade's public docs. The mapping is isolated in
   mapCandleEvent() below, and DEBUG_LOG_FIRST_EVENT will print one raw event
   so you can confirm/adjust the field names. This is the only uncertain spot.

   Requires:  npm i @tastytrade/api ws
   ============================================================================ */

// --- Node polyfill: the SDK's streaming stack (cometd/dxlink) expects a browser
//     `window` + `WebSocket`. Set these BEFORE the streamer connects. ----------
import WebSocket from "ws";
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;
if (!globalThis.window) globalThis.window = { WebSocket, setTimeout, clearTimeout };

import TastytradeClient, { CandleType } from "@tastytrade/api";

const SETTLE_MS = 1800;   // resolve once no new candle events arrive for this long
const MAX_MS = 22000;     // hard ceiling (stay under serverless timeout)
const DEBUG_LOG_FIRST_EVENT = true;  // set false once you've confirmed the mapping

/* Map ONE raw DXFeed candle event -> { t,o,h,l,c,v } + which symbol/timeframe.
   VERIFY these field names against the debug log on first run and adjust if needed.
   DXFeed Candle events are typically keyed by an eventSymbol like "AAPL{=5m}"
   or "AAPL{=1d}", with numeric open/high/low/close/volume and a ms `time`. */
function mapCandleEvent(e) {
  const sym = e.eventSymbol ?? e.symbol ?? "";
  const base = sym.split("{")[0];                 // "AAPL{=5m}" -> "AAPL"
  const isDaily = /\{=\d*d/i.test(sym);            // {=1d} / {=d} -> daily, else intraday
  const bar = {
    t: e.time ?? e.index ?? e.t,                   // ms epoch
    o: +(e.open ?? e.o),
    h: +(e.high ?? e.h),
    l: +(e.low ?? e.l),
    c: +(e.close ?? e.c),
    v: +(e.volume ?? e.v ?? 0),
  };
  return { base, timeframe: isDaily ? "daily" : "fiveMin", bar };
}

function isCandle(e) {
  // candle events carry OHLC; quotes don't. Accept if it looks like a candle.
  const t = e.eventType ?? e.type;
  if (t) return /candle/i.test(t);
  return e.open != null || e.o != null;
}

/**
 * fetchBars
 * @param {string[]} symbols  e.g. ["NVDA","SPY",...]
 * @param {object} opts { dailyMonths=6, fiveMinSessions=5 }
 * @returns {Promise<{ [symbol]: { daily: bar[], fiveMin: bar[] } }>}
 */
export async function fetchBars(symbols, opts = {}) {
  const dailyMonths = opts.dailyMonths ?? 6;
  const fiveMinSessions = opts.fiveMinSessions ?? 5;

  // lookback start timestamps (ms). Calendar buffers so we never under-fetch sessions.
  const now = Date.now();
  const dailyFrom = new Date(now);
  dailyFrom.setMonth(dailyFrom.getMonth() - dailyMonths);
  // 5 trading sessions ~= 9 calendar days (buffer for weekends/holiday)
  const fiveMinCalDays = Math.ceil(fiveMinSessions * 1.7) + 2;
  const fiveMinFrom = now - fiveMinCalDays * 24 * 60 * 60 * 1000;

  const client = new TastytradeClient({
    ...TastytradeClient.ProdConfig,
    clientSecret: process.env.TASTYTRADE_CLIENT_SECRET,
    refreshToken: process.env.TASTYTRADE_REFRESH_TOKEN,
    oauthScopes: ["read"],
  });

  // result accumulator
  const out = {};
  for (const s of symbols) out[s] = { daily: [], fiveMin: [] };

  let firstLogged = false;
  let lastEventAt = Date.now();

  const streamer = client.quoteStreamer;
  streamer.addEventListener((events) => {
    const list = Array.isArray(events) ? events : [events];
    for (const e of list) {
      if (!isCandle(e)) continue;
      if (DEBUG_LOG_FIRST_EVENT && !firstLogged) {
        console.log("RAW CANDLE EVENT (verify field names):", JSON.stringify(e));
        firstLogged = true;
      }
      const { base, timeframe, bar } = mapCandleEvent(e);
      if (out[base] && Number.isFinite(bar.o) && Number.isFinite(bar.c)) {
        out[base][timeframe].push(bar);
        lastEventAt = Date.now();
      }
    }
  });

  // connect MUST come before subscribe
  await streamer.connect();

  for (const s of symbols) {
    streamer.subscribeCandles(s, dailyFrom.getTime(), 1, CandleType.Day);
    streamer.subscribeCandles(s, fiveMinFrom, 5, CandleType.Minute);
  }

  // collect until the stream goes quiet (settle) or we hit the hard ceiling
  const startedAt = Date.now();
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const quiet = Date.now() - lastEventAt > SETTLE_MS;
      const expired = Date.now() - startedAt > MAX_MS;
      if (quiet || expired) { clearInterval(iv); resolve(); }
    }, 250);
  });

  try { await streamer.disconnect(); } catch { /* ignore */ }

  // dedupe + sort ascending (stream can repeat the live-forming bar)
  for (const s of symbols) {
    for (const tf of ["daily", "fiveMin"]) {
      const seen = new Map();
      for (const b of out[s][tf]) seen.set(b.t, b);   // last write wins
      out[s][tf] = [...seen.values()].sort((a, b) => a.t - b.t);
    }
  }
  return out;
}
