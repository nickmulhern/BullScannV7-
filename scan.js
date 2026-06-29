/* ============================================================================
   BullScann — Netlify Function: /.netlify/functions/scan
   ----------------------------------------------------------------------------
   Orchestrates the pipeline:  fetch bars -> analyzeTicker (daily + 5-min) -> JSON

   Called by the BullScann 7 front-end AFTER Prompt A (the firewall) has run,
   so regime/news come in as query params:

     /.netlify/functions/scan?regime=bullish&news=clean&exclude=MU,AAPL
     /.netlify/functions/scan?symbols=NVDA,AAPL          (override universe)

   Query params (all optional):
     regime   = bullish | bearish | neutral   (from Prompt A)   default neutral
     news     = clean | caution | flag         (applies to all) default clean
     exclude  = comma list of flagged tickers to skip
     symbols  = comma list to override the default universe
   ============================================================================ */

import { analyzeTicker } from "./bullscann_analyze.js";
import { fetchBars } from "./tastytrade_fetch.js";

// Default universe (edit here to change it permanently)
const UNIVERSE = [
  "NVDA", "AMD", "AAPL", "MSFT", "PLTR", "TSLA", "META", "GOOGL", "AMZN", "MU",
  "SPY", "QQQ", "DIA", "XBI", "XLE", "XLV", "IBIT", "ETHA",
];

const LOOKBACK = { dailyMonths: 6, fiveMinSessions: 5 };

export async function handler(event) {
  try {
    const q = event.queryStringParameters || {};
    const regimeBias = (q.regime || "neutral").toLowerCase();
    const news = (q.news || "clean").toLowerCase();
    const exclude = new Set((q.exclude || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean));
    const base = (q.symbols ? q.symbols.split(",").map(s => s.trim().toUpperCase()) : UNIVERSE);
    const symbols = base.filter(s => !exclude.has(s));

    if (!process.env.TASTYTRADE_CLIENT_SECRET || !process.env.TASTYTRADE_REFRESH_TOKEN) {
      return json(500, { error: "Missing TASTYTRADE_CLIENT_SECRET / TASTYTRADE_REFRESH_TOKEN env vars" });
    }

    const bars = await fetchBars(symbols, LOOKBACK);
    const ctx = { regimeBias, news };

    const results = {};
    for (const s of symbols) {
      const daily = analyzeTicker(s, bars[s]?.daily || [], ctx);
      const fiveMin = analyzeTicker(s, bars[s]?.fiveMin || [], ctx);
      results[s] = {
        daily: daily.error ? daily : daily.structured,
        fiveMin: fiveMin.error ? fiveMin : fiveMin.structured,
        copyDaily: daily.copyBlock || null,
        copyFiveMin: fiveMin.copyBlock || null,
        barCounts: { daily: bars[s]?.daily?.length || 0, fiveMin: bars[s]?.fiveMin?.length || 0 },
      };
    }

    return json(200, {
      asOf: new Date().toISOString(),
      regimeBias, news,
      excluded: [...exclude],
      universe: symbols,
      results,
    });
  } catch (err) {
    return json(500, { error: String(err && err.message || err) });
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}
