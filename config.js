// Supabase > Project Settings > API > "anon public" key (safe to expose; RLS protects data)
window.SUPABASE_URL = "https://zxnjrcjpxkaefxvqnsjo.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_gRIxNH_mLA3NDCpE8wN5dw_lUbuP_64";

// WebRTC ICE servers. STUN alone works for most people; ~15-20% of networks
// (strict NAT / corporate / some mobile carriers) also need a TURN relay.
// Add one here (e.g. Metered, Twilio, Cloudflare Calls, or self-hosted coturn):
//   { urls: "turn:turn.example.com:443?transport=tcp", username: "...", credential: "..." }
window.ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
