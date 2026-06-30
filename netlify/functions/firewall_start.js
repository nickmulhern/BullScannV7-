/* ============================================================================
   BullScann — Netlify Function: /.netlify/functions/firewall_start
   ----------------------------------------------------------------------------
   Creates a pending job in Netlify Blobs, then triggers the background
   function to do the actual Claude API work. Returns the jobId immediately
   so the frontend can start polling firewall_poll.
   ============================================================================ */

import { getStore } from "@netlify/blobs";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return respond(500, { error: "ANTHROPIC_API_KEY not set." });
  }

  // Generate a unique job ID for this session run
  const jobId = `fw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Write pending status to Blobs immediately
    const store = getStore("firewall-jobs");
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
