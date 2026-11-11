// MirrorChat edge worker: serves the static site (dist) and mints TURN credentials at /api/ice.
// Secrets (wrangler secret put): TURN_KEY_ID and TURN_API_TOKEN, from Cloudflare dashboard > Realtime > TURN.
// Without them /api/ice returns an empty list and the video page falls back to plain STUN.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ice") {
      const headers = { "content-type": "application/json", "cache-control": "no-store" };
      // only answer fetches made by this site's own pages (browsers send Sec-Fetch-Site; this deters casual abuse, it is not authentication)
      if (request.headers.get("sec-fetch-site") !== "same-origin") return new Response(JSON.stringify({ iceServers: [], reason: "same-origin only" }), { status: 403, headers });
      if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return new Response(JSON.stringify({ iceServers: [], reason: "secrets missing" }), { headers });
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.TURN_API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl: 3600 })
        });
        if (!r.ok) {
          let msg = ""; try { const e = await r.json(); msg = (e.errors && e.errors[0] && e.errors[0].message) || e.error || ""; } catch (_) {}
          return new Response(JSON.stringify({ iceServers: [], reason: "turn api " + r.status + " " + String(msg).slice(0, 120) }), { headers });
        }
        const data = await r.json();
        return new Response(JSON.stringify({ iceServers: data.iceServers || [] }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ iceServers: [], reason: "fetch failed" }), { headers });
      }
    }
    return env.ASSETS.fetch(request);
  }
};
