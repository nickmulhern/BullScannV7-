/* ============================================================================
   BullScann — Netlify Function: /.netlify/functions/firewall_poll
   ----------------------------------------------------------------------------
   Checks Netlify Blobs for the result of a Firewall job.
   Called by the frontend every 3 seconds with ?jobId=...
   Returns: { status: "pending" | "done" | "error", fullText?, parsed?, error? }

   NOTE: Blobs uses EXPLICIT credentials (siteID + token) to bypass Netlify's
   unreliable auto-injection. Requires site env vars NETLIFY_SITE_ID and
   NETLIFY_BLOBS_TOKEN.
   ============================================================================ */

import { getStore } from "@netlify/blobs";

// Max age for a pending job before we consider it stale (3 minutes)
const STALE_MS = 3 * 60 * 1000;

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Method not allowed" });
  }

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId || !jobId.startsWith("fw_")) {
    return respond(400, { error: "Valid jobId required." });
  }

  try {
    const store = getStore({
      name: "firewall-jobs",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    const job = await store.get(jobId, { type: "json" });

    if (!job) {
      return respond(404, { error: "Job not found." });
    }

    // Detect stale pending jobs — background fn may have crashed silently
    if (job.status === "pending") {
      const age = Date.now() - (job.startedAt || 0);
      if (age > STALE_MS) {
        return respond(200, { status: "error", error: "Firewall job timed out — please try again." });
      }
    }

    // Clean up completed/errored jobs from Blobs after returning result
    if (job.status === "done" || job.status === "error") {
      store.delete(jobId).catch(() => {}); // fire-and-forget cleanup
    }

    return respond(200, job);

  } catch (err) {
    return respond(500, { error: `Poll failed: ${err.message}` });
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}
