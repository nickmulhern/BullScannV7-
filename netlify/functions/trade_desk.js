/* ============================================================================
   BullScann — Netlify Function: /.netlify/functions/trade_desk
   ----------------------------------------------------------------------------
   Three-persona Trade Desk pipeline.

   Receives:
     - firewallOutput : plain-text Prompt A result (session go/no-go, regime, flags)
     - scanBlock      : copyBlock string from analyzeTicker() for selected ticker
     - mode           : "short" (Prompt B, 3-7 DTE) | "swing" (Prompt C, 28-42 DTE)
     - ticker         : symbol string (for labeling only)

   Pipeline (single Claude call, sequential personas):
     Persona 1 — The Trader      : builds full trade recommendation
     Persona 2 — The Risk Desk   : adversarial review of Persona 1
     Persona 3 — The Trade Master: synthesizes both, issues final verdict + ticket

   Returns: { ticket, full } where ticket is the clean Trade Master output
   and full includes all three persona outputs for debug/audit.
   ============================================================================ */

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS   = 2048;

function buildPrompt(ticker, mode, firewallOutput, scanBlock) {
  const dteRange   = mode === "short" ? "3–7 DTE" : "28–42 DTE";
  const modeLabel  = mode === "short" ? "Prompt B (Short Term)" : "Prompt C (Swing)";
  const optionType = mode === "short" ? "long call or long put" : "long call or long put";

  return `You are running the BullScann Trade Desk for ${ticker}. This analysis was initiated from ${modeLabel}, targeting ${dteRange} options (${optionType} only — no spreads unless IV is elevated).

The following data has been pre-computed by the BullScann engine. Do not fetch external data. Reason only from what is provided.

═══════════════════════════════════════
FIREWALL OUTPUT (Prompt A — today's session)
───────────────────────────────────────
${firewallOutput}

═══════════════════════════════════════
SCAN BLOCK — ${ticker}
───────────────────────────────────────
${scanBlock}
═══════════════════════════════════════

You will now produce three sequential outputs. Complete each fully before moving to the next. Use the exact section headers shown.

---
## PERSONA 1 — THE TRADER

You are a professional options trader. Your job is to find the best possible setup in this data and build a complete trade recommendation. Be direct and confident. Identify the thesis, then fill every field below.

Trade Direction: [CALL or PUT]
Overall Grade: [A / B / C]
Confidence Score: [0-100%]
Entry Trigger: [price level that confirms the trade is on]
Strike Price: [specific strike]
Expiration: [date and DTE]
Target 1 (T1): [first profit target — underlying price]
Target 2 (T2): [extended target — underlying price]
Stop Level: [bail-out price on the underlying]
Risk/Reward: [X:1]
Rationale: [2-3 sentences max — why this setup works right now]

---
## PERSONA 2 — THE RISK DESK

You are a senior risk officer reviewing the Trader's recommendation above. Your job is to stress-test it. Look for what the Trader missed, what the macro context (Firewall) says that conflicts, and whether the R/R holds up under scrutiny. Be skeptical but fair.

Risk Assessment: [APPROVED / CONDITIONALLY APPROVED / REJECTED]
Flags:
- [flag 1 — or "none" if clean]
- [flag 2]
Regime Conflict: [yes/no — does the Firewall output conflict with the trade direction?]
Level Validity: [are the entry, stop, and targets structurally sound given the S/R zones?]
R/R Review: [does the stated R/R hold up? adjust if not]
Risk Desk Note: [2-3 sentences max — net judgment]

---
## PERSONA 3 — THE TRADE MASTER

You have reviewed both the Trader's recommendation and the Risk Desk's assessment. Synthesize everything into a final verdict. If the Risk Desk flagged issues, incorporate them into the final parameters — do not just average the two. Issue the final trade ticket below using this exact format:

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
[2-3 sentences. Why this trade survives both desks.]
═══════════════════════════════════════
RISK DESK FLAGS
[bullet each flag from Persona 2, or "None — clean approval"]
═══════════════════════════════════════`;
}

function parseTicket(fullText) {
  // Extract just the Trade Master block from the full response
  const marker = "TRADE MASTER — FINAL VERDICT";
  const idx = fullText.indexOf(marker);
  if (idx === -1) return fullText; // fallback: return everything
  return fullText.slice(idx - 4).trim(); // include the ═══ border above it
}

function splitPersonas(fullText) {
  const p1Start = fullText.indexOf("## PERSONA 1");
  const p2Start = fullText.indexOf("## PERSONA 2");
  const p3Start = fullText.indexOf("## PERSONA 3");

  const persona1 = p1Start !== -1 && p2Start !== -1
    ? fullText.slice(p1Start, p2Start).trim() : "";
  const persona2 = p2Start !== -1 && p3Start !== -1
    ? fullText.slice(p2Start, p3Start).trim() : "";
  const persona3 = p3Start !== -1
    ? fullText.slice(p3Start).trim() : fullText;

  return { persona1, persona2, persona3 };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON body" });
  }

  const { firewallOutput, scanBlock, mode, ticker } = body;

  // Input validation
  if (!firewallOutput || typeof firewallOutput !== "string" || firewallOutput.trim().length < 20) {
    return respond(400, { error: "firewallOutput is missing or too short. Run and save Prompt A first." });
  }
  if (!scanBlock || typeof scanBlock !== "string" || scanBlock.trim().length < 20) {
    return respond(400, { error: "scanBlock is missing. Select a ticker from the scan results." });
  }
  if (!["short", "swing"].includes(mode)) {
    return respond(400, { error: "mode must be 'short' (Prompt B) or 'swing' (Prompt C)." });
  }
  if (!ticker || typeof ticker !== "string") {
    return respond(400, { error: "ticker is required." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return respond(500, { error: "ANTHROPIC_API_KEY env var not set." });
  }

  const prompt = buildPrompt(ticker.toUpperCase(), mode, firewallOutput.trim(), scanBlock.trim());

  let claudeRes;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
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
  } catch (err) {
    return respond(502, { error: `Claude API unreachable: ${err.message}` });
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text().catch(() => "");
    return respond(502, { error: `Claude API error ${claudeRes.status}: ${errText}` });
  }

  let claudeData;
  try {
    claudeData = await claudeRes.json();
  } catch {
    return respond(502, { error: "Claude API returned unparseable response." });
  }

  const fullText = (claudeData.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  if (!fullText) {
    return respond(502, { error: "Claude returned an empty response." });
  }

  const { persona1, persona2, persona3 } = splitPersonas(fullText);
  const ticket = parseTicket(fullText);

  return respond(200, {
    ticker: ticker.toUpperCase(),
    mode,
    ticket,       // Trade Master output only — what the UI displays
    personas: {   // full breakdown — available for debug/audit
      trader:    persona1,
      riskDesk:  persona2,
      tradeMaster: persona3,
    },
  });
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}
