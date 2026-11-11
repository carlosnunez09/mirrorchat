# MirrorChat

Omegle-style random video chat. **No sign-up**: open the page, press Start, and you're paired with a random stranger. Static HTML/JS, no build step, powered by Supabase Realtime.

## How it works

| Piece | Role |
|---|---|
| Supabase Realtime **Presence** (`lobby` channel) | Tracks who is online and who is "searching" |
| Supabase Realtime **Broadcast** | `invite` / `accept` handshake to pair two searchers; per-call `pair:<room>` channel carries WebRTC offer/answer/ICE |
| **WebRTC** | Video, audio and text chat flow peer-to-peer (nothing is recorded or stored) |
| `reports` table | Insert-only abuse report log |

Each page load gets a random throwaway id (`anon-xxxxxx`); nothing is stored about you.

## Setup

1. `config.js` holds your project URL and **publishable** key (safe in client code; never put the secret/service key or access token here).
2. Run `schema.sql` in the Supabase SQL editor (only creates the `reports` table; Realtime needs no tables).
3. Serve over **HTTPS or localhost** (browsers block the camera otherwise):
   `python3 -m http.server 8000` → http://localhost:8000
   For public hosting use Netlify / Vercel / Cloudflare Pages / GitHub Pages.
4. Open it in two tabs/devices, press **Start** in both.

## Deploy

It's a static site (`index.html`, `app.js`, `config.js`), so any HTTPS static host works. Easiest: GitHub repo → Settings → Pages → Source "Deploy from a branch" → pick the branch, folder `/ (root)`. Or drag the folder into Netlify Drop, or connect the repo to Cloudflare Pages / Vercel (publish directory `/`, no build command). WebRTC and camera access need HTTPS, which these all provide.

## Features

- Random 1:1 matching, **Next** to skip, **Stop** to leave
- Mic / camera toggles, picture-in-picture self-view, mobile-friendly layout, `Esc` for Next
- Typing indicator and sound cues
- Peer-to-peer text chat during calls
- 18+ gate, **Report** button (skips + blocks that person, logs to `reports`)
- Avoids re-matching the person you just skipped

## Roadmap / known limits

- **TURN server**: STUN alone fails for ~15-20% of networks. Add a TURN entry to `ICE_SERVERS` in `config.js` before going public.
- **Scale**: one `lobby` presence channel is fine for hundreds of concurrent users; beyond that, shard into `lobby-0..N` channels or move matching to an Edge Function.
- **Moderation**: random video chat attracts abuse. Before a public launch consider server-side bans on report counts, rate limiting, and a terms/privacy page. Reports are logged but nothing acts on them automatically yet.
- Interest tags, country filter, and text-only mode are natural next steps.
