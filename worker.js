// MirrorChat edge worker: serves the static site (dist) and mints TURN credentials at /api/ice.
// Secrets (wrangler secret put): TURN_KEY_ID and TURN_API_TOKEN, from Cloudflare dashboard > Realtime > TURN.
// Without them /api/ice returns an empty list and the video page falls back to plain STUN.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ice") {
      const headers = { "content-type": "application/json", "cache-control": "no-store" };
      if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return new Response(JSON.stringify({ iceServers: [] }), { headers });
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.TURN_API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl: 3600 })
        });
        if (!r.ok) return new Response(JSON.stringify({ iceServers: [] }), { headers });
        const data = await r.json();
        return new Response(JSON.stringify({ iceServers: data.iceServers || [] }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ iceServers: [] }), { headers });
      }
    }
    return env.ASSETS.fetch(request);
  }
};
