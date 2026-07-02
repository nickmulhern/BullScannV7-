/* ============================================================================
   BullScann — Netlify Function: /.netlify/functions/trade_desk
   ----------------------------------------------------------------------------
   Three-stage Trade Desk pipeline — one stage per call so each stays well
   under Netlify's function timeout.

   stage = "trader"  : Persona 1 — builds trade recommendation (or NO-TRADE)
   stage = "risk"    : Persona 2 — adversarial review of Trader output
   stage = "master"  : Persona 3 — final synthesis + Trade Master ticket

   Each call receives only what it needs. The frontend sequences the three
   calls and passes prior output forward.

   v2 changes:
   - NO-TRADE is a first-class Trader answer (kills the action bias)
   - Today's date (ET) injected into every prompt — no hallucinated expirations
   - Dual stop rule restored: underlying price stop + premium stop
   - Earnings / scheduled-event gate in the Risk review (NOT AVAILABLE > guess)
   - Strike is a ZONE to verify against the live chain, not fake precision
   - R/R explicitly labeled as UNDERLYING R/R until the chain is wired
   - "Prompt B/C" internal naming removed from user-facing ticket
   ============================================================================ */

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS   = 1000;

/* Today's date in market time (ET) — injected into every prompt so the model
   can compute real calendar expirations instead of inventing them. */
function marketDateString() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

const MODE_INFO = (mode) => mode === "short"
  ? { dteRange: "3–7 DTE",   modeLabel: "Short Term" }
  : { dteRange: "28–42 DTE", modeLabel: "Swing" };

/* ---------------------------------------------------------------------------
   STAGE 1 — TRADER
   --------------------------------------------------------------------------- */
function promptTrader(ticker, mode, firewallOutput, scanBlock) {
  const { dteRange, modeLabel } = MODE_INFO(mode);
  const today = marketDateString();
  return `You are the Trader on the BullScann Trade Desk for ${ticker}. Mode: ${modeLabel} · ${dteRange}. Long calls or puts only — no spreads.

TODAY'S DATE: ${today} (US market time). All expiration math must start from this date.

Reason only from the data below. Do not fetch anything. You have NO options
chain data — no IV, no greeks, no spreads. Do not pretend otherwise.

NO-TRADE IS A VALID ANSWER. A professional trader passes on most setups.
If the data below does not justify risking option premium — mixed signals,
poor level geometry, opposing reversal flags, regime conflict — your answer
is NO-TRADE. Do not force a trade to fill the form.

FIREWALL (today's session):
${firewallOutput}

SCAN BLOCK — ${ticker}:
${scanBlock}

Output in exactly this format. If Direction is NO-TRADE, fill only Direction
and Rationale and put "—" in every other field.

Trade Direction: [CALL / PUT / NO-TRADE]
Grade: [A / B / C]
Confidence: [0-100%]
Entry Trigger: [underlying price that confirms the trade]
Strike Zone: [$X–$Y range — no chain data provided; user must verify against the live chain before entry]
Expiration: [MM/DD/YY — must be a standard Friday expiry within ${dteRange} counted from today's date above; user must verify it is listed]
T1: [first target — underlying price]
T2: [extended target — underlying price]
Stop (Underlying): [bail-out price on the stock]
Stop (Premium): [exit if the option loses this % of paid premium — BullScann system rule is 35–50% for Short Term; state the number you recommend]
Underlying R/R: [X:1 — this is the STOCK move ratio, not option P/L]
Rationale: [2 sentences max — why this setup works now, or why NO-TRADE]`;
}

/* ---------------------------------------------------------------------------
   STAGE 2 — RISK DESK
   --------------------------------------------------------------------------- */
function promptRisk(ticker, mode, firewallOutput, scanBlock, traderOutput) {
  const { dteRange, modeLabel } = MODE_INFO(mode);
  const today = marketDateString();
  return `You are the Risk Desk on the BullScann Trade Desk for ${ticker}. Mode: ${modeLabel} · ${dteRange}.

TODAY'S DATE: ${today} (US market time).

Your job: stress-test the Trader's recommendation below. Be skeptical but fair.
You have NO options chain data. Never invent data — if something cannot be
verified from the inputs below, say "NOT AVAILABLE — verify before entry."

If the Trader answered NO-TRADE: either CONCUR (and say why the pass is right)
or CHALLENGE it (only if the data clearly supports a trade the Trader missed).

FIREWALL (today's session):
${firewallOutput}

SCAN BLOCK — ${ticker}:
${scanBlock}

TRADER RECOMMENDATION:
${traderOutput}

Review in exactly this format:

Assessment: [APPROVED / CONDITIONALLY APPROVED / REJECTED / CONCUR NO-TRADE]
Regime Conflict: [yes/no — does the Firewall conflict with the trade direction?]
Event Risk: [Does an earnings report or major scheduled event fall before the
  proposed expiration? Answer ONLY from the Firewall data above. If the
  Firewall does not state it, write exactly: "NOT AVAILABLE — verify earnings
  date before entry." Never guess an earnings date.]
Level Validity: [are entry trigger, stops, and targets structurally sound
  against the scan block's support/resistance?]
Stop Check: [are BOTH stops present — underlying price AND premium % — and
  is the premium stop within the 35–50% system rule for Short Term mode?]
R/R Review: [does the UNDERLYING R/R hold up? Note explicitly that option
  P/L will differ due to theta/IV — no chain data to quantify it.]
Flags:
- [flag 1 or "None"]
- [flag 2 if applicable]
Risk Desk Note: [2 sentences max — net judgment]`;
}

/* ---------------------------------------------------------------------------
   STAGE 3 — TRADE MASTER
   --------------------------------------------------------------------------- */
function promptMaster(ticker, mode, traderOutput, riskOutput) {
  const { dteRange, modeLabel } = MODE_INFO(mode);
  const today = marketDateString();
  return `You are the Trade Master on the BullScann Trade Desk for ${ticker}. Mode: ${modeLabel} · ${dteRange}.

TODAY'S DATE: ${today} (US market time).

Synthesize the Trader and Risk Desk outputs into a final verdict. If the Risk
Desk flagged issues, incorporate them — do not just average. If the Trader
said NO-TRADE and the Risk Desk concurred, the verdict is NO-GO. Never invent
data neither desk provided; carry "NOT AVAILABLE" items forward as flags.

TRADER OUTPUT:
${traderOutput}

RISK DESK OUTPUT:
${riskOutput}

Issue the final ticket using this exact format:

═══════════════════════════════════════
TRADE MASTER — FINAL VERDICT · ${ticker}
═══════════════════════════════════════
TICKER        | ${ticker}
MODE          | ${modeLabel} · ${dteRange}
DIRECTION     | [CALL / PUT / NO-TRADE]
FINAL GRADE   | [A / B / C / —]
CONFIDENCE    | [0-100%]
VERDICT       | [GO / NO-GO / CONDITIONAL]
═══════════════════════════════════════
TRADE PARAMETERS
───────────────────────────────────────
Trigger Price | $[entry trigger or —]
Strike Zone   | $[X–Y or —] (verify vs live chain)
Expiration    | [MM/DD/YY] ([X] DTE) (verify listed)
───────────────────────────────────────
TARGETS & RISK
───────────────────────────────────────
T1            | $[target 1 or —]
T2            | $[target 2 or —]
Stop (Stock)  | $[underlying stop or —]
Stop (Prem)   | [XX% of premium or —]
Underlying R/R| [X.X]:1 (stock move, not option P/L)
Event Risk    | [clear / flagged / NOT AVAILABLE — verify]
═══════════════════════════════════════
RATIONALE
[2 sentences. Why this trade survives both desks — or why it dies.]
═══════════════════════════════════════
RISK DESK FLAGS
[bullet each flag, or "None — clean approval"]
═══════════════════════════════════════`;
}

/* ---------------------------------------------------------------------------
   Claude API call
   --------------------------------------------------------------------------- */
async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Claude API ${res.status}: ${txt}`);
  }

  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  if (!text) throw new Error("Claude returned empty response");
  return text;
}

/* ---------------------------------------------------------------------------
   Handler
   --------------------------------------------------------------------------- */
export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return respond(500, { error: "ANTHROPIC_API_KEY not set." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return respond(400, { error: "Invalid JSON body" }); }

  const { stage, ticker, mode, firewallOutput, scanBlock, traderOutput, riskOutput } = body;

  if (!ticker || !mode || !["short","swing"].includes(mode)) {
    return respond(400, { error: "ticker and valid mode required." });
  }

  const sym = ticker.toUpperCase();

  try {
    if (stage === "trader") {
      if (!firewallOutput || firewallOutput.trim().length < 20)
        return respond(400, { error: "firewallOutput missing or too short." });
      if (!scanBlock || scanBlock.trim().length < 20)
        return respond(400, { error: "scanBlock missing." });

      const output = await callClaude(promptTrader(sym, mode, firewallOutput.trim(), scanBlock.trim()));
      return respond(200, { stage: "trader", ticker: sym, output });
    }

    if (stage === "risk") {
      if (!firewallOutput || !scanBlock || !traderOutput)
        return respond(400, { error: "firewallOutput, scanBlock, and traderOutput required for risk stage." });

      const output = await callClaude(promptRisk(sym, mode, firewallOutput.trim(), scanBlock.trim(), traderOutput.trim()));
      return respond(200, { stage: "risk", ticker: sym, output });
    }

    if (stage === "master") {
      if (!traderOutput || !riskOutput)
        return respond(400, { error: "traderOutput and riskOutput required for master stage." });

      const output = await callClaude(promptMaster(sym, mode, traderOutput.trim(), riskOutput.trim()));
      // Extract clean ticket block (guard against marker near start of string)
      const marker = "TRADE MASTER — FINAL VERDICT";
      const idx = output.indexOf(marker);
      const ticket = idx !== -1 ? output.slice(Math.max(0, idx - 4)).trim() : output;
      return respond(200, { stage: "master", ticker: sym, ticket, output });
    }

    return respond(400, { error: "stage must be trader | risk | master" });

  } catch (err) {
    return respond(502, { error: String(err.message || err) });
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}
