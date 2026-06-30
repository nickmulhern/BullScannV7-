/* ============================================================================
   BullScann — Netlify Function: /.netlify/functions/trade_desk
   ----------------------------------------------------------------------------
   Three-stage Trade Desk pipeline — one stage per call to stay under
   Netlify's 10-second function timeout.

   stage = "trader"  : Persona 1 — builds trade recommendation
   stage = "risk"    : Persona 2 — adversarial review of Trader output
   stage = "master"  : Persona 3 — final synthesis + Trade Master ticket

   Each call receives only what it needs. The frontend sequences the three
   calls and passes prior output forward.
   ============================================================================ */

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS   = 650; // tight per-stage limit — keeps each call fast

const SHARED_HEADER = (ticker, mode) => {
  const dteRange  = mode === "short" ? "3–7 DTE"   : "28–42 DTE";
  const modeLabel = mode === "short" ? "Prompt B (Short Term)" : "Prompt C (Swing)";
  return { dteRange, modeLabel };
};

function promptTrader(ticker, mode, firewallOutput, scanBlock) {
  const { dteRange, modeLabel } = SHARED_HEADER(ticker, mode);
  return `You are the Trader on the BullScann Trade Desk for ${ticker}. Mode: ${modeLabel} · ${dteRange}. Long calls or puts only — no spreads.

Reason only from the data below. Do not fetch anything.

FIREWALL (today's session):
${firewallOutput}

SCAN BLOCK — ${ticker}:
${scanBlock}

Build a complete trade recommendation. Be direct. Fill every field:

Trade Direction: [CALL or PUT]
Grade: [A / B / C]
Confidence: [0-100%]
Entry Trigger: [price that confirms the trade]
Strike: [specific strike]
Expiration: [date · DTE]
T1: [first target — underlying price]
T2: [extended target — underlying price]
Stop: [bail-out price]
R/R: [X:1]
Rationale: [2 sentences max — why this setup works now]`;
}

function promptRisk(ticker, mode, firewallOutput, scanBlock, traderOutput) {
  const { dteRange, modeLabel } = SHARED_HEADER(ticker, mode);
  return `You are the Risk Desk on the BullScann Trade Desk for ${ticker}. Mode: ${modeLabel} · ${dteRange}.

Your job: stress-test the Trader's recommendation below. Be skeptical but fair. Check for macro conflicts, level validity, and R/R integrity.

FIREWALL (today's session):
${firewallOutput}

SCAN BLOCK — ${ticker}:
${scanBlock}

TRADER RECOMMENDATION:
${traderOutput}

Review:
Assessment: [APPROVED / CONDITIONALLY APPROVED / REJECTED]
Regime Conflict: [yes/no — does the Firewall conflict with the trade direction?]
Level Validity: [are entry, stop, and targets structurally sound?]
R/R Review: [does the R/R hold up? adjust if not]
Flags:
- [flag 1 or "None"]
- [flag 2 if applicable]
Risk Desk Note: [2 sentences max — net judgment]`;
}

function promptMaster(ticker, mode, traderOutput, riskOutput) {
  const { dteRange, modeLabel } = SHARED_HEADER(ticker, mode);
  return `You are the Trade Master on the BullScann Trade Desk for ${ticker}. Mode: ${modeLabel} · ${dteRange}.

Synthesize the Trader and Risk Desk outputs into a final verdict. If the Risk Desk flagged issues, incorporate them — do not just average. Issue the final ticket using this exact format:

TRADER OUTPUT:
${traderOutput}

RISK DESK OUTPUT:
${riskOutput}

═══════════════════════════════════════
TRADE MASTER — FINAL VERDICT · ${ticker}
═══════════════════════════════════════
TICKER        | ${ticker}
MODE          | ${modeLabel} · ${dteRange}
DIRECTION     | [CALL or PUT]
FINAL GRADE   | [A / B / C]
CONFIDENCE    | [0-100%]
VERDICT       | [GO / NO-GO / CONDITIONAL]
═══════════════════════════════════════
TRADE PARAMETERS
───────────────────────────────────────
Trigger Price | $[entry trigger]
Strike        | $[strike]
Expiration    | [MM/DD/YY] ([X] DTE)
───────────────────────────────────────
TARGETS & RISK
───────────────────────────────────────
T1            | $[target 1]
T2            | $[target 2]
Stop          | $[stop level]
R/R Ratio     | [X.X]:1
═══════════════════════════════════════
RATIONALE
[2 sentences. Why this trade survives both desks.]
═══════════════════════════════════════
RISK DESK FLAGS
[bullet each flag, or "None — clean approval"]
═══════════════════════════════════════`;
}

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

  // Shared validation
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
      // Extract clean ticket block
      const marker = "TRADE MASTER — FINAL VERDICT";
      const idx = output.indexOf(marker);
      const ticket = idx !== -1 ? output.slice(idx - 4).trim() : output;
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
