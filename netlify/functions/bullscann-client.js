/* ============================================================================
   BullScann 7 — front-end client helper
   ----------------------------------------------------------------------------
   Drop this into BullScann 7 (script tag or module). It calls the scan
   function and hands you back the structured results + copy blocks. It does
   NOT replace your UI — it just feeds it.

   Usage inside BullScann 7, after you've run Prompt A and have regime/news:

     import { runScan } from "./bullscann-client.js";
     const data = await runScan({ regime: "bullish", news: "clean", exclude: ["MU","AAPL"] });
     // data.results["NVDA"].daily      -> structured daily analysis
     // data.results["NVDA"].copyDaily  -> plain-text block for Prompt C
     // data.results["NVDA"].fiveMin / copyFiveMin -> 5-min for Prompt B
   ============================================================================ */

export async function runScan({ regime = "neutral", news = "clean", exclude = [], symbols = null } = {}) {
  const params = new URLSearchParams({ regime, news });
  if (exclude.length) params.set("exclude", exclude.join(","));
  if (symbols && symbols.length) params.set("symbols", symbols.join(","));

  const res = await fetch(`/.netlify/functions/scan?${params.toString()}`);
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Scan failed (${res.status}): ${msg}`);
  }
  return res.json();
}

/* Convenience: get all copy blocks ready to paste into Prompt B (5-min) or
   Prompt C (daily), sorted by setup score so the best setups are on top. */
export function rankByScore(data, timeframe = "daily") {
  const key = timeframe === "fiveMin" ? "fiveMin" : "daily";
  return Object.entries(data.results)
    .map(([sym, r]) => ({ sym, score: r[key]?.setup?.score ?? -1, copy: r[key === "fiveMin" ? "copyFiveMin" : "copyDaily"] }))
    .sort((a, b) => b.score - a.score);
}
