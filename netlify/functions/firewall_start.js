/* ============================================================================
   BullScann — Netlify Function: /.netlify/functions/firewall_start
   ----------------------------------------------------------------------------
   Creates a pending job in Netlify Blobs, then triggers the background
   function to do the actual Claude API work. Returns the jobId immediately
   so the frontend can start polling firewall_poll.

   NOTE: Blobs is configured with EXPLICIT credentials (siteID + token) to
   bypass Netlify's auto-injection, which is unreliable on some sites and was
   throwing MissingBlobsEnvironmentError despite a correct setup. Requires two
   site env vars: NETLIFY_SITE_ID (= Project ID in the Netlify UI) and
   NETLIFY_BLOBS_TOKEN (= a Netlify Personal Access Token).
   ============================================================================ */

import { getStore } from "@netlify/blobs";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return respond(500, { error: "ANTHROPIC_API_KEY not set." });
  }

  // Fail loud and clear if the Blobs creds aren't wired up
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_BLOBS_TOKEN) {
    return respond(500, { error: "Blobs creds missing: set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN." });
  }

  // Generate a unique job ID for this session run
  const jobId = `fw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Write pending status to Blobs immediately (explicit creds)
    const store = getStore({
      name: "firewall-jobs",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
    await store.setJSON(jobId, {
      status: "pending",
      startedAt: Date.now(),
    });

    // Trigger the background function asynchronously
    const bgUrl = `${process.env.URL}/.netlify/functions/firewall-background?jobId=${jobId}`;
    fetch(bgUrl, { method: "POST" }).catch(() => {
      // Background trigger fire-and-forget — errors handled inside background fn
    });

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
