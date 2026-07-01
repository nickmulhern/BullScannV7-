/* ============================================================================
   BullScann — Netlify Function: /.netlify/functions/firewall_start
   ----------------------------------------------------------------------------
   Creates a pending job in Netlify Blobs, then triggers the background
   function to do the actual Claude API work. Returns the jobId immediately
   so the frontend can start polling firewall_poll.

   Blobs uses EXPLICIT credentials (siteID + token) via NETLIFY_SITE_ID and
   NETLIFY_BLOBS_TOKEN to bypass unreliable auto-injection.

   TRIGGER IS NOW VERIFIED: the background URL is built from the request host
   (more reliable than process.env.URL), and we confirm Netlify accepted the
   async invocation (HTTP 202). If the trigger fails, we surface the error
   IMMEDIATELY instead of letting the job hang until the poll stale-timeout.
   ============================================================================ */

import { getStore } from "@netlify/blobs";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return respond(500, { error: "ANTHROPIC_API_KEY not set." });
  }

  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_BLOBS_TOKEN) {
    return respond(500, { error: "Blobs creds missing: set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN." });
  }

  const jobId = `fw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const store = getStore({
      name: "firewall-jobs",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });

    // Write pending status to Blobs immediately
    await store.setJSON(jobId, {
      status: "pending",
      startedAt: Date.now(),
    });

    // Build background URL from the request host (reliable), fall back to URL.
    const host = event.headers.host || event.headers.Host;
    const base = host ? `https://${host}` : process.env.URL;
    const bgUrl = `${base}/.netlify/functions/firewall-background?jobId=${jobId}`;

    // Trigger the background function AND confirm Netlify accepted it.
    // Async background invocation returns HTTP 202 immediately (does NOT wait
    // for the 15-min job to finish), so this await is fast.
    try {
      const bgRes = await fetch(bgUrl, { method: "POST" });
      if (bgRes.status !== 202 && !bgRes.ok) {
        const bgErr = await bgRes.text().catch(() => "");
        await store.setJSON(jobId, {
          status: "error",
          error: `Background trigger failed (${bgRes.status}). ${bgErr}`.trim(),
        });
        return respond(502, {
          error: `Background trigger returned ${bgRes.status}. Confirm firewall-background.js is deployed in netlify/functions.`,
        });
      }
    } catch (triggerErr) {
      await store.setJSON(jobId, {
        status: "error",
        error: `Background trigger unreachable: ${triggerErr.message}`,
      });
      return respond(502, { error: `Could not reach background function: ${triggerErr.message}` });
    }

    return respond(200, { jobId });

  } catch (err) {
    return respond(500, { error: `Failed to start Firewall job: ${err.message}` });
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}
