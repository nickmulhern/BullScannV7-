/* ============================================================================
   BullScann — Netlify Background Function: /.netlify/functions/firewall-background
   ----------------------------------------------------------------------------
   Runs the full Prompt A (Firewall) pipeline with web search.
   No timeout pressure — background functions run up to 15 minutes.

   Flow:
   1. firewall_start.js creates a pending job in Blobs + triggers this function
   2. This function runs the Claude API call with web_search tool
   3. Writes completed result (or error) back to Blobs under the job ID
   4. firewall_poll.js reads Blobs until status = done | error

   Blobs uses EXPLICIT credentials (siteID + token) via NETLIFY_SITE_ID and
   NETLIFY_BLOBS_TOKEN.

   COST NOTE: the search budget in the prompt caps web searches to a small
   number of BROAD queries instead of one-per-ticker. This is the main lever
   on per-run input-token cost, because every search round re-bills the whole
   accumulated context as input. Data integrity is preserved: the NOT AVAILABLE
   rule is intact and the model is told never to guess a value to fill a field.
   ============================================================================ */

import { getStore } from "@netlify/blobs";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS   = 2000;

const FIREWALL_PROMPT = `SCAN SETUP — FIREWALL (BullScann 7)
You are a market analyst with web search enabled.

SEARCH BUDGET — this controls cost, follow it strictly:
Use a SMALL number of BROAD searches. Aim for 3–5 searches TOTAL, never one-per-ticker.
  1) One search for index/regime status: SPY, QQQ, and VIX levels and direction for today's session.
  2) One to two searches for today's market-moving news, sector leadership/laggards, and any major catalysts across the universe (a single "stock market movers today" style query catches most of it).
  3) Additional searches ONLY to confirm a specific ticker catalyst that a broad search already surfaced. Do not pre-emptively search every ticker.

DATA INTEGRITY — non-negotiable:
Do not fabricate or estimate. If a value isn't found after your searches, write NOT AVAILABLE.
Never guess a number to fill a field. A blank/NOT AVAILABLE is always better than an invented value.
Today's date: auto-detect from current date. Cover only the current/most recent US session.

UNIVERSE: NVDA AMD AAPL MSFT PLTR TSLA META GOOGL AMZN MU SPY QQQ DIA XBI XLE XLV IBIT ETHA

SECTION 1 — MARKET REGIME
SPY: price | trend (bull/bear/mixed) | vs 50SMA & 200SMA
QQQ: price | trend | vs 50SMA & 200SMA
VIX: level | direction (rising/falling) | regime (low/moderate/elevated/extreme)
Breadth/leadership: one line (broad vs narrow, which sectors leading/lagging)
Macro events today: [list scheduled Fed speakers, data releases, or NONE] | event risk (LOW/MOD/HIGH)

SECTION 2 — UNIVERSE NEWS CHECK
For each ticker, one line: CLEAN, or FLAG — reason (earnings, halt, gap, major headline).
Base this on your broad news searches. Only FLAG on a real, session-relevant catalyst — not routine noise.
If you have no session-relevant information on a ticker after your searches, mark it CLEAN (no catalyst found) rather than searching it individually.

SECTION 3 — DASHBOARD INPUTS (what I enter into BullScann)
REGIME BIAS: [BULLISH / BEARISH / NEUTRAL] — one-line justification
NEWS STATE: [CLEAN / CAUTION / FLAG] — caution if mixed/uncertain tape, flag if a universe name has a major catalyst
EXCLUDE (flagged tickers): [comma list, or NONE]

SECTION 4 — ONE-LINE SUMMARY
Directional bias + primary theme (momentum / rotation / defense / vol) in one sentence.

---
IMPORTANT: After Section 4, output a JSON block in this exact format (no markdown fences):
BULLSCANN_JSON_START
{
  "regime": "bullish",
  "newsState": "clean",
  "exclude": [],
  "summary": "one-line summary here"
}
BULLSCANN_JSON_END

regime must be exactly: bullish | bearish | neutral
newsState must be exactly: clean | caution | flag
exclude must be an array of ticker strings (empty array if none)
summary must be a single string`;

function parseStructured(fullText) {
  const start = fullText.indexOf("BULLSCANN_JSON_START");
  const end   = fullText.indexOf("BULLSCANN_JSON_END");
  if (start === -1 || end === -1) return null;
  const raw = fullText.slice(start + "BULLSCANN_JSON_START".length, end).trim();
  try {
    const parsed    = JSON.parse(raw);
    const regime    = ["bullish","bearish","neutral"].includes(parsed.regime?.toLowerCase())
      ? parsed.regime.toLowerCase() : "neutral";
    const newsState = ["clean","caution","flag"].includes(parsed.newsState?.toLowerCase())
      ? parsed.newsState.toLowerCase() : "clean";
    const exclude   = Array.isArray(parsed.exclude)
      ? parsed.exclude.map(t => String(t).toUpperCase().trim()).filter(Boolean) : [];
    const summary   = typeof parsed.summary === "string" ? parsed.summary : "";
    return { regime, newsState, exclude, summary };
  } catch { return null; }
}

function cleanFullText(fullText) {
  const start = fullText.indexOf("BULLSCANN_JSON_START");
  if (start === -1) return fullText.trim();
  return fullText.slice(0, start).trim();
}

export async function handler(event) {
  // Read jobId from query string (passed by firewall_start)
  const jobId = new URL(event.rawUrl).searchParams.get("jobId");
  if (!jobId) return { statusCode: 400 };

  // Observability: background functions only stream logs in real time, so log
  // entry/exit to confirm the function actually fired.
  console.log(`[firewall-background] START jobId=${jobId}`);

  const store = getStore({
    name: "firewall-jobs",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });

  try {
    // Call Claude API with web_search tool
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: FIREWALL_PROMPT }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text().catch(() => "");
      console.log(`[firewall-background] Claude API error ${claudeRes.status} jobId=${jobId}`);
      await store.setJSON(jobId, {
        status: "error",
        error: `Claude API error ${claudeRes.status}: ${errText}`,
      });
      return { statusCode: 200 };
    }

    const claudeData = await claudeRes.json();
    const fullText = (claudeData.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    if (!fullText) {
      console.log(`[firewall-background] empty response jobId=${jobId}`);
      await store.setJSON(jobId, { status: "error", error: "Claude returned empty response." });
      return { statusCode: 200 };
    }

    const parsed  = parseStructured(fullText);
    const display = cleanFullText(fullText);

    await store.setJSON(jobId, {
      status: "done",
      fullText: display,
      parsed,
      completedAt: Date.now(),
    });
    console.log(`[firewall-background] DONE jobId=${jobId}`);

  } catch (err) {
    console.log(`[firewall-background] EXCEPTION jobId=${jobId}: ${err.message || err}`);
    await store.setJSON(jobId, {
      status: "error",
      error: String(err.message || err),
    });
  }

  return { statusCode: 200 };
}
