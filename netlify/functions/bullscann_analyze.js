/* ============================================================================
   BullScann — Compute Core (v0.1, daily-timeframe first)
   ----------------------------------------------------------------------------
   PURPOSE
   Point-in-time technical analysis from a fixed bar history. NO live feed,
   NO streaming. You call this once, when Prompt A fires, with whatever bars
   your provider returns. It computes the facts; the LLM (Prompt B/C) then
   INTERPRETS them. Code retrieves & computes; the model reasons. That split
   is the whole fix — the model is never asked to fetch a number it can't see.

   DESIGN PRIORITY (per your spec): momentum / reversal / trend-state FIRST.
   Chart-pattern NAMING is intentionally NOT done here — it's left as an
   optional descriptive label for the model to apply on top of these clean
   inputs. Horizontal + diagonal LEVELS are kept (they're your entry/stop
   structure, not a pattern).

   INPUT: bars = array oldest->newest of { t, o, h, l, c, v }
          (t = ISO date string or ms; o/h/l/c numbers; v volume number)
   OUTPUT: a structured object + a plain-text block matching your copy format.

   NO external dependencies. See the Netlify Function pattern near the bottom.

   TUNE-TO-YOUR-EYE knobs are in CONFIG. The S/R + swing windows are the
   things to calibrate against your own chart on the first eyeball-diff.
   ============================================================================ */

const CONFIG = {
  emaFast: 10,
  emaSlow: 20,
  rsiLen: 14,
  atrLen: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  volAvgLen: 20,
  swingWindow: 2,        // bars on each side that define a swing pivot (raise to 3 for cleaner, fewer pivots)
  srClusterATR: 0.6,     // S/R touches within this * ATR collapse into one zone
  srMinTouches: 2,       // a zone needs at least this many touches to count
  climaxRelVol: 2.0,     // volume climax flag threshold (x avg volume)
  extensionATR: 2.5,     // |price - emaSlow| beyond this * ATR = "stretched" (your extension check)
};

/* Setup-score weights. Deterministic buckets sum to 90 (80 TA + 10 regime).
   Options is a SEPARATE 10 that only applies when you pass an options chain,
   so we never fabricate the points we can't compute from daily bars.
   Tune these against your logged trades once you have a sample. */
const WEIGHTS = {
  trend: 25,        // EMA stack + slope + structure agreement with the thesis
  momentum: 25,     // RSI position + MACD histogram
  volume: 15,       // participation + bar-direction agreement
  level: 15,        // entry/target geometry (R:R from nearest S/R)
  regime: 10,       // Prompt A firewall verdict, direction-conditional
  options: 10,      // tradeability + IV fit — STUBBED, needs the options chain
  reversalPenaltyEach: 5,   // per opposing exhaustion flag
  reversalPenaltyMax: 15,
  newsCautionPenalty: 8,
};

/* ---------- small math helpers ---------- */
const sma = (arr, len, i) => {
  if (i < len - 1) return null;
  let s = 0;
  for (let k = i - len + 1; k <= i; k++) s += arr[k];
  return s / len;
};

function ema(values, len) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === len - 1) { prev = sma(values, len, i); out[i] = prev; }
    else if (i >= len) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}

function rsi(closes, len) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < len + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgG = gain / len, avgL = loss / len;
  out[len] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = len + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (len - 1) + g) / len;
    avgL = (avgL * (len - 1) + l) / len;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function atr(bars, len) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < len + 1) return out;
  const tr = bars.map((b, i) =>
    i === 0 ? b.h - b.l
            : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
  let prev = 0;
  for (let i = 1; i <= len; i++) prev += tr[i];
  prev /= len;
  out[len] = prev;
  for (let i = len + 1; i < bars.length; i++) {
    prev = (prev * (len - 1) + tr[i]) / len;
    out[i] = prev;
  }
  return out;
}

function macd(closes, f, s, sig) {
  const ef = ema(closes, f), es = ema(closes, s);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  // signal EMA over the valid (non-null) MACD region only — no zero-padding pollution
  const firstValid = line.findIndex(v => v != null);
  const signal = new Array(line.length).fill(null);
  if (firstValid !== -1) {
    const sub = ema(line.slice(firstValid), sig);
    for (let j = 0; j < sub.length; j++) signal[firstValid + j] = sub[j];
  }
  const hist = line.map((v, i) => (v != null && signal[i] != null) ? v - signal[i] : null);
  return { line, signal, hist };
}

/* ---------- swing pivots (fractals) ---------- */
function swings(bars, w) {
  const highs = [], lows = [];
  for (let i = w; i < bars.length - w; i++) {
    let isHigh = true, isLow = true;
    for (let k = i - w; k <= i + w; k++) {
      if (k === i) continue;
      if (bars[k].h >= bars[i].h) isHigh = false;
      if (bars[k].l <= bars[i].l) isLow = false;
    }
    if (isHigh) highs.push({ i, price: bars[i].h, t: bars[i].t });
    if (isLow)  lows.push({ i, price: bars[i].l, t: bars[i].t });
  }
  return { highs, lows };
}

/* ---------- horizontal S/R via clustering ---------- */
function srZones(pivots, atrNow, cfg) {
  const tol = atrNow * cfg.srClusterATR;
  const pts = [...pivots].sort((a, b) => a.price - b.price);
  const zones = [];
  for (const p of pts) {
    const z = zones[zones.length - 1];
    if (z && Math.abs(p.price - z.mean) <= tol) {
      z.prices.push(p.price);
      z.lastIdx = Math.max(z.lastIdx, p.i);
      z.mean = z.prices.reduce((a, b) => a + b, 0) / z.prices.length;
    } else {
      zones.push({ prices: [p.price], mean: p.price, lastIdx: p.i });
    }
  }
  return zones
    .filter(z => z.prices.length >= cfg.srMinTouches)
    .map(z => ({ level: +z.mean.toFixed(2), touches: z.prices.length, lastIdx: z.lastIdx }))
    .sort((a, b) => a.level - b.level);
}

/* ---------- candidate diagonal trendline (first-pass, honest) ---------- */
function diagonal(pivots, lastIdx, lastPrice, atrNow) {
  // use the two most recent pivots to define the line, then count touches
  if (pivots.length < 2) return null;
  const a = pivots[pivots.length - 2], b = pivots[pivots.length - 1];
  if (b.i === a.i) return null;
  const slope = (b.price - a.price) / (b.i - a.i);
  const tol = atrNow * 0.5;
  let touches = 0;
  for (const p of pivots) {
    const proj = a.price + slope * (p.i - a.i);
    if (Math.abs(p.price - proj) <= tol) touches++;
  }
  const projNow = a.price + slope * (lastIdx - a.i);
  return {
    slopePerBar: +slope.toFixed(3),
    touches,
    projectedLevelNow: +projNow.toFixed(2),
    priceVsLine: lastPrice > projNow ? "above" : "below",
    note: touches >= 2 ? "validated (2+ touches)" : "weak (single anchor)",
  };
}

/* ---------- divergence (the high-value reversal tell) ---------- */
function divergence(pivLows, pivHighs, rsiArr) {
  let bullish = null, bearish = null;
  const lastTwo = (arr) => arr.length >= 2 ? [arr[arr.length - 2], arr[arr.length - 1]] : null;
  const lo = lastTwo(pivLows);
  if (lo && rsiArr[lo[0].i] != null && rsiArr[lo[1].i] != null) {
    if (lo[1].price < lo[0].price && rsiArr[lo[1].i] > rsiArr[lo[0].i])
      bullish = { type: "bullish (price LL, RSI HL)", at: lo[1].t };
  }
  const hi = lastTwo(pivHighs);
  if (hi && rsiArr[hi[0].i] != null && rsiArr[hi[1].i] != null) {
    if (hi[1].price > hi[0].price && rsiArr[hi[1].i] < rsiArr[hi[0].i])
      bearish = { type: "bearish (price HH, RSI LH)", at: hi[1].t };
  }
  return { bullish, bearish };
}

/* ============================================================================
   MAIN
   ============================================================================ */
export function analyzeTicker(symbol, bars, ctx = {}, userCfg = {}) {
  const cfg = { ...CONFIG, ...userCfg };
  if (!Array.isArray(bars) || bars.length < cfg.macdSlow + cfg.macdSignal + 5)
    return { symbol, error: "NOT ENOUGH BARS", barsReceived: bars?.length ?? 0 };

  const closes = bars.map(b => b.c);
  const vols = bars.map(b => b.v);
  const i = bars.length - 1;            // current bar
  const last = bars[i];

  const emaF = ema(closes, cfg.emaFast);
  const emaS = ema(closes, cfg.emaSlow);
  const rsiArr = rsi(closes, cfg.rsiLen);
  const atrArr = atr(bars, cfg.atrLen);
  const m = macd(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const atrNow = atrArr[i] ?? (last.h - last.l);

  const { highs, lows } = swings(bars, cfg.swingWindow);

  /* ---- EMA stack / slope ---- */
  const emaStack = (emaF[i] > emaS[i]) ? "bullish (10>20)" : "bearish (10<20)";
  const emaSlope = (emaS[i] != null && emaS[i - 3] != null)
    ? (emaS[i] > emaS[i - 3] ? "rising" : "falling") : "n/a";
  const sep = (emaF[i] != null && emaS[i] != null)
    ? +(((emaF[i] - emaS[i]) / emaS[i]) * 100).toFixed(2) : null;

  /* ---- trend structure (HH/HL vs LH/LL) ---- */
  const lastHighs = highs.slice(-2).map(h => h.price);
  const lastLows = lows.slice(-2).map(l => l.price);
  let structure = "indeterminate";
  if (lastHighs.length === 2 && lastLows.length === 2) {
    const hh = lastHighs[1] > lastHighs[0], hl = lastLows[1] > lastLows[0];
    const lh = lastHighs[1] < lastHighs[0], ll = lastLows[1] < lastLows[0];
    if (hh && hl) structure = "uptrend (HH/HL)";
    else if (lh && ll) structure = "downtrend (LH/LL)";
    else structure = "transition / range";
  }

  /* ---- extension / stretch (your ATR-extension check) ---- */
  const distATR = (emaS[i] != null) ? +(((last.c - emaS[i]) / atrNow)).toFixed(2) : null;
  const stretched = distATR != null && Math.abs(distATR) >= cfg.extensionATR;

  /* ---- volume ---- */
  const volAvg = sma(vols, cfg.volAvgLen, i);
  const relVol = volAvg ? +(last.v / volAvg).toFixed(2) : null;
  const climax = relVol != null && relVol >= cfg.climaxRelVol;
  const upBar = last.c >= last.o;

  /* ---- wicks ---- */
  const range = last.h - last.l || 1;
  const upperWick = +(((last.h - Math.max(last.o, last.c)) / range) * 100).toFixed(0);
  const lowerWick = +(((Math.min(last.o, last.c) - last.l) / range) * 100).toFixed(0);

  /* ---- S/R zones + nearest ---- */
  const allPivots = [...highs, ...lows];
  const zones = srZones(allPivots, atrNow, cfg);
  const support = zones.filter(z => z.level < last.c).slice(-1)[0] || null;
  const resistance = zones.filter(z => z.level > last.c)[0] || null;

  /* ---- diagonal lines ---- */
  const diagSupport = diagonal(lows, i, last.c, atrNow);
  const diagResistance = diagonal(highs, i, last.c, atrNow);

  /* ---- divergence ---- */
  const div = divergence(lows, highs, rsiArr);

  /* ---- MACD histogram state ---- */
  const histNow = m.hist[i], histPrev = m.hist[i - 1];
  const histState = (histNow != null && histPrev != null)
    ? (Math.abs(histNow) > Math.abs(histPrev) ? "expanding" : "contracting")
    : "n/a";

  /* ---- DETERMINISTIC VERDICTS (regime-conditional — gate in Prompt A) ---- */
  let momentumScore = 0;
  if (emaStack.startsWith("bullish")) momentumScore++; else momentumScore--;
  if (emaSlope === "rising") momentumScore++; else if (emaSlope === "falling") momentumScore--;
  if (structure.startsWith("uptrend")) momentumScore++; else if (structure.startsWith("downtrend")) momentumScore--;
  if (rsiArr[i] != null) { if (rsiArr[i] > 55) momentumScore++; else if (rsiArr[i] < 45) momentumScore--; }
  if (histState === "expanding" && histNow > 0) momentumScore++;
  if (histState === "expanding" && histNow < 0) momentumScore--;

  const momentum =
    momentumScore >= 2 ? "BULLISH momentum" :
    momentumScore <= -2 ? "BEARISH momentum" : "MIXED / no clear momentum";

  /* ---- reversal signals: computed ONCE as booleans (text + scorer both read these) ---- */
  const reversalSignals = {
    bullishDivergence: !!div.bullish,
    bearishDivergence: !!div.bearish,
    stretchedAbove: stretched && distATR > 0,
    stretchedBelow: stretched && distATR < 0,
    climaxUpperWickRejection: climax && upperWick > 50,
    climaxLowerWickRejection: climax && lowerWick > 50,
  };
  const labelMap = {
    bullishDivergence: "bullish divergence",
    bearishDivergence: "bearish divergence",
    stretchedAbove: "stretched above mean (pullback risk)",
    stretchedBelow: "stretched below mean (bounce risk)",
    climaxUpperWickRejection: "vol climax + upper-wick rejection",
    climaxLowerWickRejection: "vol climax + lower-wick rejection",
  };
  const reversalLabels = Object.keys(reversalSignals).filter(k => reversalSignals[k]).map(k => labelMap[k]);
  const reversal = reversalLabels.length
    ? "EXHAUSTION/REVERSAL watch: " + reversalLabels.join("; ")
    : "no reversal signal";

  /* ---- structured output ---- */
  const structured = {
    symbol,
    asOf: last.t,
    note: "Point-in-time read from last completed bar. Levels are durable; price location is as-of-pull.",
    price: last.c,
    ohlc: { o: last.o, h: last.h, l: last.l, c: last.c },
    wicksPct: { upper: upperWick, lower: lowerWick },
    ema: { fast: round(emaF[i]), slow: round(emaS[i]), stack: emaStack, slope: emaSlope, separationPct: sep },
    rsi: round(rsiArr[i]),
    macdHist: { value: round(histNow), state: histState },
    atr: round(atrNow),
    distanceFromEMA20_inATR: distATR,
    stretched,
    structure,
    volume: { last: last.v, avg: round(volAvg), relVol, climax, direction: upBar ? "up" : "down" },
    horizontalLevels: { nearestSupport: support, nearestResistance: resistance, allZones: zones },
    diagonal: { support: diagSupport, resistance: diagResistance },
    divergence: div,
    reversalSignals,
    verdict: { momentum, momentumScore, reversal },
  };

  /* ---- setup score (consumes the facts above; recomputes nothing) ---- */
  const setup = scoreSetup(structured, ctx, cfg);
  structured.setup = setup;

  return { structured, copyBlock: toCopyBlock(structured) };
}

function round(v) { return v == null ? null : +v.toFixed(2); }

/* ============================================================================
   scoreSetup — weighted 0-100 conviction score for ranking setups.

   HOW IT AVOIDS CONFLICT/REDUNDANCY WITH THE CORE:
   - It DERIVES DIRECTION from the core's momentum verdict, then grades how well
     the setup supports THAT direction. So a strong downtrend scores high for a
     SHORT, not a long — no double meaning, no fight with momentumScore (which
     stays the raw directional signal; this is the quality grade on top).
   - Every input is read from `structured` — nothing is recomputed.
   - Liquidity and "options quality" (ChatGPT's two overlapping buckets) are
     MERGED into ONE `options` bucket, and it's STUBBED: it only scores when you
     pass ctx.options (from the chain). Until then totalScore is null and we
     report normalizedCore so you can still rank on TA alone — we don't invent
     the 10 points.
   - News is NOT a positive bucket (it's the softest input). It's a penalty/veto,
     consistent with your firewall's existing FLAG mechanism.
   - Reversal flags from the core PENALIZE a continuation thesis (don't score a
     blow-off top as an A+ long).

   GRADE CUTOFF (v2): grades below C collapse to "—" and the setup is marked
   tradeable:false. No one places a D/F trade — the dashboard shows tradeable
   setups (A/B/C) or no-trade, nothing in between. The score is still returned
   so you can see how close a near-miss was.

   ctx = {
     regimeBias: "bullish" | "bearish" | "neutral",   // from Prompt A firewall
     news: "clean" | "caution" | "flag",              // from Prompt A
     options: { spreadPct, openInterest, ivRank }     // OPTIONAL, from chain
   }
   ============================================================================ */
function scoreSetup(s, ctx = {}, cfg = CONFIG) {
  const W = WEIGHTS;
  const dir = s.verdict.momentum.startsWith("BULLISH") ? "long"
            : s.verdict.momentum.startsWith("BEARISH") ? "short" : "none";

  if (dir === "none") {
    return { direction: "none", grade: "NO-TRADE", tradeable: false,
             reason: "no directional thesis (mixed momentum)",
             normalizedCore: 0, totalScore: null, buckets: null };
  }
  const long = dir === "long";
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* TREND (25): stack 10 + slope 7 + structure 8 */
  let trend = 0;
  if (s.ema.stack.startsWith(long ? "bullish" : "bearish")) trend += 10;
  if (s.ema.slope === (long ? "rising" : "falling")) trend += 7;
  if (s.structure.startsWith(long ? "uptrend" : "downtrend")) trend += 8;
  else if (s.structure.startsWith("transition")) trend += 4;

  /* MOMENTUM (25): RSI 12 + MACD 13 */
  let mom = 0;
  const r = s.rsi;
  if (r != null) {
    if (long)  mom += r >= 55 && r <= 70 ? 12 : r > 70 && r <= 80 ? 8 : r >= 50 ? 8 : r > 80 ? 4 : 0;
    else       mom += r <= 45 && r >= 30 ? 12 : r < 30 && r >= 20 ? 8 : r <= 50 ? 8 : r < 20 ? 4 : 0;
  }
  const h = s.macdHist.value, exp = s.macdHist.state === "expanding";
  if (h != null) {
    if (long)  mom += h > 0 && exp ? 13 : h > 0 ? 8 : h < 0 && !exp ? 4 : 0;
    else       mom += h < 0 && exp ? 13 : h < 0 ? 8 : h > 0 && !exp ? 4 : 0;
  }

  /* VOLUME (15): participation 10 + bar-direction agreement 5 */
  let vol = 0;
  const rv = s.volume.relVol;
  if (rv != null) vol += rv < 0.8 ? 2 : rv < 1.2 ? 6 : rv < 1.8 ? 9 : 10;
  if (s.volume.direction === (long ? "up" : "down")) vol += 5;

  /* LEVEL (15): R:R geometry from nearest S/R */
  let level = 7.5; // neutral fallback when a level is missing
  const px = s.price, atrV = s.atr || 1;
  const sup = s.horizontalLevels.nearestSupport?.level;
  const res = s.horizontalLevels.nearestResistance?.level;
  if (long && sup != null && res != null) {
    const risk = Math.max(px - sup, atrV * 0.25);
    const reward = Math.max(res - px, 0);
    const rr = reward / risk;
    level = rr >= 2 ? 15 : rr >= 1.5 ? 12 : rr >= 1 ? 9 : rr >= 0.5 ? 5 : 2;
    if (res - px < atrV * 0.5) level = Math.min(level, 4); // buying right into resistance
  } else if (!long && sup != null && res != null) {
    const risk = Math.max(res - px, atrV * 0.25);
    const reward = Math.max(px - sup, 0);
    const rr = reward / risk;
    level = rr >= 2 ? 15 : rr >= 1.5 ? 12 : rr >= 1 ? 9 : rr >= 0.5 ? 5 : 2;
    if (px - sup < atrV * 0.5) level = Math.min(level, 4); // shorting right into support
  }

  /* REGIME (10): direction-conditional, from Prompt A */
  const rb = ctx.regimeBias || "neutral";
  const regime = rb === (long ? "bullish" : "bearish") ? 10 : rb === "neutral" ? 5 : 0;

  /* RISK PROFILE: opposing exhaustion flags (read as booleans — no string parsing) */
  const f = s.reversalSignals;
  const opposingFlags = [];
  if (long) {
    if (f.bearishDivergence) opposingFlags.push("bearish divergence");
    if (f.stretchedAbove) opposingFlags.push("stretched above mean");
    if (f.climaxUpperWickRejection) opposingFlags.push("climax + upper-wick rejection");
  } else {
    if (f.bullishDivergence) opposingFlags.push("bullish divergence");
    if (f.stretchedBelow) opposingFlags.push("stretched below mean");
    if (f.climaxLowerWickRejection) opposingFlags.push("climax + lower-wick rejection");
  }
  const reversalPenalty = Math.min(opposingFlags.length * W.reversalPenaltyEach, W.reversalPenaltyMax);

  /* NEWS: penalty / veto, never a positive */
  const news = ctx.news || "clean";
  const newsPenalty = news === "caution" ? W.newsCautionPenalty : 0;

  /* assemble */
  const coreRaw = trend + mom + vol + level + regime - reversalPenalty - newsPenalty; // out of 90
  const coreClamped = clamp(coreRaw, 0, 90);
  const normalizedCore = Math.round((coreClamped / 90) * 100);

  /* OPTIONS bucket (10) — only when chain provided */
  let optionsScore = null, totalScore = null;
  if (ctx.options) {
    const { spreadPct, openInterest, ivRank } = ctx.options;
    let o = 0;
    if (spreadPct != null)    o += spreadPct <= 2 ? 4 : spreadPct <= 5 ? 2 : 0;          // tight spread
    if (openInterest != null) o += openInterest >= 1000 ? 3 : openInterest >= 250 ? 2 : 0; // depth
    if (ivRank != null)       o += ivRank <= 50 ? 3 : ivRank <= 70 ? 1 : 0;              // your "no spreads unless IV elevated" lean
    optionsScore = o;
    totalScore = clamp(coreClamped + o, 0, 100);
  }

  /* news veto overrides everything */
  let grade, score = totalScore != null ? totalScore : normalizedCore;
  if (news === "flag") { grade = "VETO (news flag)"; score = Math.min(score, 20); }
  else grade = score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "C" : "—";
  const tradeable = grade === "A" || grade === "B" || grade === "C";

  return {
    direction: dir,
    score,
    grade,
    tradeable,                      // false below C or on news veto — dashboard shows no-trade
    normalizedCore,                 // 0-100 from TA+regime only (use to rank before chain is wired)
    totalScore,                     // 0-100 incl. options, or null until ctx.options provided
    optionsScore,                   // null until chain provided
    buckets: { trend, momentum: mom, volume: vol, level, regime,
               reversalPenalty: -reversalPenalty, newsPenalty: -newsPenalty },
    risk: {                         // risk profile — what's firing against the thesis
      opposingFlags,
      reversalPenalty: -reversalPenalty,
      regimeOpposing: regime === 0,
      news,
      stretched: s.stretched,
    },
    note: ctx.options ? "full score" : "options UNSCORED (no chain) — ranking on normalizedCore",
  };
}

/* ---------- plain-text block for piping into Prompt B/C ---------- */
function toCopyBlock(s) {
  const lv = s.horizontalLevels;
  const sup = lv.nearestSupport ? `${lv.nearestSupport.level} (${lv.nearestSupport.touches}x)` : "none below";
  const res = lv.nearestResistance ? `${lv.nearestResistance.level} (${lv.nearestResistance.touches}x)` : "none above";
  return [
    `${s.symbol} | as of ${s.asOf} | last ${s.price}`,
    `EMA: 10=${s.ema.fast} 20=${s.ema.slow} | stack ${s.ema.stack} | slope ${s.ema.slope} | sep ${s.ema.separationPct}%`,
    `RSI ${s.rsi} | MACD hist ${s.macdHist.value} ${s.macdHist.state} | ATR ${s.atr} | dist from 20EMA ${s.distanceFromEMA20_inATR} ATR${s.stretched ? " STRETCHED" : ""}`,
    `Structure: ${s.structure}`,
    `Volume: last ${s.volume.last} vs avg ${s.volume.avg} | relVol ${s.volume.relVol}x | ${s.volume.direction} bar${s.volume.climax ? " | CLIMAX" : ""} | wicks U${s.wicksPct.upper}%/L${s.wicksPct.lower}%`,
    `Horizontal: support ${sup} | resistance ${res}`,
    `Diagonal support: ${s.diagonal.support ? s.diagonal.support.projectedLevelNow + " (" + s.diagonal.support.note + ", price " + s.diagonal.support.priceVsLine + ")" : "n/a"}`,
    `Diagonal resistance: ${s.diagonal.resistance ? s.diagonal.resistance.projectedLevelNow + " (" + s.diagonal.resistance.note + ", price " + s.diagonal.resistance.priceVsLine + ")" : "n/a"}`,
    `MOMENTUM: ${s.verdict.momentum} (score ${s.verdict.momentumScore})`,
    `REVERSAL: ${s.verdict.reversal}`,
    `SETUP SCORE: ${s.setup.direction === "none" ? "NO-TRADE (no thesis)" :
      !s.setup.tradeable ? `${s.setup.score}/100 — below tradeable threshold (NO-TRADE)` :
      `${s.setup.score}/100 grade ${s.setup.grade} (${s.setup.direction.toUpperCase()}) — ${s.setup.note}`}`,
    s.setup.buckets ? `  buckets: trend ${s.setup.buckets.trend} | mom ${s.setup.buckets.momentum} | vol ${s.setup.buckets.volume} | level ${s.setup.buckets.level} | regime ${s.setup.buckets.regime} | revPen ${s.setup.buckets.reversalPenalty} | newsPen ${s.setup.buckets.newsPenalty}` : "",
    s.setup.risk ? `RISK: ${s.setup.risk.opposingFlags.length ? s.setup.risk.opposingFlags.join("; ") : "none"}${s.setup.risk.regimeOpposing ? " | regime opposing" : ""}${s.setup.risk.news !== "clean" ? " | news " + s.setup.risk.news : ""}` : "",
  ].filter(Boolean).join("\n");
}

/* ============================================================================
   PROVIDER ADAPTERS — the missing link between a raw fetch and analyzeTicker.
   The core expects bars = [{t,o,h,l,c,v}] oldest->newest, numeric. These map
   real provider JSON into that contract. The core itself never changes.
   ============================================================================ */

// Generic: accepts array OR single object, remaps common key names,
// coerces strings to numbers, drops junk rows, sorts ASCENDING by time.
export function normalizeBars(raw) {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);  // <- Tradier XML->JSON quirk
  const bars = arr.map(d => ({
    t: d.t ?? d.date ?? d.datetime ?? d.timestamp,
    o: +(d.o ?? d.open),
    h: +(d.h ?? d.high),
    l: +(d.l ?? d.low),
    c: +(d.c ?? d.close),
    v: +(d.v ?? d.volume ?? 0),
  })).filter(b => [b.o, b.h, b.l, b.c].every(Number.isFinite));
  bars.sort((a, b) => new Date(a.t) - new Date(b.t));         // <- guarantee oldest->newest
  return bars;
}

// Tradier /v1/markets/history?interval=daily  ->  history.day[]
export function fromTradierHistory(json) {
  return normalizeBars(json?.history?.day);
}

/* Netlify Function pattern (server-side: key stays secret, no CORS):

   // netlify/functions/scan.js
   import { analyzeTicker, fromTradierHistory } from "./bullscann_analyze.js";
   export async function handler(event) {
     const symbol = event.queryStringParameters.symbol;
     const res = await fetch(
       `https://api.tradier.com/v1/markets/history?symbol=${symbol}&interval=daily`,
       { headers: { Authorization: `Bearer ${process.env.TRADIER_TOKEN}`, Accept: "application/json" } }
     );
     const bars = fromTradierHistory(await res.json());
     // regimeBias + news come from Prompt A; options stays unscored until you pull the chain
     const result = analyzeTicker(symbol, bars, { regimeBias: "bullish", news: "clean" });
     return { statusCode: 200, body: JSON.stringify(result.structured) };
   }
*/


/* ============================================================================
   LOCAL SMOKE TEST
   Real testing goes through the adapter (fromTradierHistory) with live bars.
   To self-check the math offline:
       node -e "import('./bullscann_analyze.js').then(m => {
         const bars = [...your { t,o,h,l,c,v } array...];
         console.log(m.analyzeTicker('TEST', bars, { regimeBias:'bullish', news:'clean' }).copyBlock);
       })"
   ============================================================================ */
