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
   ============================================================================ */

import { getStore } from "@netlify/blobs";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS   = 2000;

const FIREWALL_PROMPT = `SCAN SETUP — FIREWALL (BullScann 7)
You are a market analyst with web search enabled. Use search for every data point.
Do not fabricate or estimate — if a value isn't found after searching, write NOT AVAILABLE.
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
Only FLAG on a real, session-relevant catalyst — not routine noise.

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

  const store = getStore("firewall-jobs");

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

  } catch (err) {
    await store.setJSON(jobId, {
      status: "error",
      error: String(err.message || err),
    });
  }

  return { statusCode: 200 };
}
