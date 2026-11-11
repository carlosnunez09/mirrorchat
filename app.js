/* Passerby (internal name: MirrorChat) – random 1:1 video chat.
 *
 * Supabase Realtime is used only as a matchmaker + signaling channel:
 *   - "lobby" channel  : Presence (who is searching) + Broadcast (invite/accept handshake)
 *   - "pair:<room>"    : private per-call channel carrying SDP offer/answer + ICE
 * Media and text chat then flow peer-to-peer over WebRTC (RTCPeerConnection + DataChannel).
 * There are no accounts: every page load gets a random throwaway id.
 */
(() => {
  const $ = id => document.getElementById(id);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  const pick = a => a[Math.floor(Math.random() * a.length)];

  const myId = uid();
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { realtime: { params: { eventsPerSecond: 20 } } });
  const rtcConfig = { iceServers: window.ICE_SERVERS || [{ urls: "stun:stun.l.google.com:19302" }] };

  const BRAND = window.BRAND || { name: "Passerby" };
  document.title = BRAND.name + " – meet someone new";
  $("brand").textContent = BRAND.name;
  document.querySelectorAll(".brandname").forEach(e => { e.textContent = BRAND.name; });
  $("myid").textContent = "anon-" + myId.slice(0, 6);

  // ---- state -------------------------------------------------------------
  let ageOk = true;
  let active = false;            // user intent: false after Stop, so late async work can't resurrect a search
  let state = "idle";            // idle | searching | connecting | connected
  let localStream = null;
  let lobby = null, lobbyReady = false;
  let pending = null;            // outgoing invite {to, room, timer}
  let pair = null, pc = null, dc = null;
  let partnerId = null, room = null;
  let session = 0;               // bumps on every teardown; guards stale async continuations
  let connectTimer = null, discTimer = null, matchTimer = null;
  let iceQueue = [];
  const blocked = new Set();     // reported ids – never match again this session
  const recent = new Set();      // last partners – avoid instant rematch
  const skipUntil = new Map();   // peer id -> timestamp: didn't answer / couldn't connect, leave alone for a while
  const lastSeen = new Map();    // peer id -> {t, at}: presence heartbeat tracking to spot ghosts (closed tabs)
  let slowTimer = null, heartbeat = null;
  const skip = (id, ms) => id && skipUntil.set(id, Date.now() + ms);

  // ---- ui helpers --------------------------------------------------------
  const log = $("log");
  function addMsg(text, cls = "") {
    const d = document.createElement("div");
    d.className = "msg " + cls;
    d.textContent = text;
    log.append(d);
    log.scrollTop = log.scrollHeight;
  }
  function setStatus(html, spinning, title = "") {
    $("status").innerHTML = html;
    $("title").textContent = title;
    $("title").style.display = title ? "" : "none";
    $("spin").classList.toggle("off", !spinning);
    $("overlay").classList.remove("hidden");
  }
  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    document.body.append(t); setTimeout(() => t.remove(), 3500);
  }
  // tiny synth cues – no audio files needed
  let actx = null;
  function blip(freqs) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      freqs.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime + i * 0.12;
        o.frequency.value = f; o.type = "sine";
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + 0.2);
      });
    } catch {}
  }
  function hideStatus() { $("overlay").classList.add("hidden"); }
  function updateUI() {
    const inCall = state === "connected", active = state !== "idle";
    $("start").disabled = active || !ageOk;
    $("start2").style.display = active ? "none" : "";
    $("start2").disabled = !ageOk;
    $("start").style.display = active ? "none" : "";
    $("next").style.display = active ? "" : "none";
    $("stop").style.display = active ? "" : "none";
    $("next").disabled = !active;
    $("stop").disabled = !active;
    $("report").disabled = !inCall;
    $("mic").disabled = $("cam").disabled = !localStream;
    $("t").disabled = $("send").disabled = !inCall;
  }
  function setState(s) { state = s; updateUI(); }

  // ---- lobby (presence + matchmaking) ------------------------------------
  function onlineCount() { return lobby ? Object.keys(lobby.presenceState()).length : 0; }

  async function joinLobby() {
    if (lobbyReady) return;
    lobby = sb.channel("lobby", { config: { presence: { key: myId }, broadcast: { self: false } } });
    lobby.on("presence", { event: "sync" }, () => {
      const n = onlineCount();
      $("online").textContent = n === 1 ? "just you online" : `${n} online`;
      tryMatch();
    });
    lobby.on("broadcast", { event: "invite" }, ({ payload: p }) => onInvite(p));
    lobby.on("broadcast", { event: "accept" }, ({ payload: p }) => onAccept(p));
    lobby.on("broadcast", { event: "cancel" }, ({ payload: p }) => {
      if (p.to === myId && state === "connecting" && room === p.room) { addMsg("Match fell through, retrying…", "sys"); restart(); }
    });
    await new Promise((res, rej) => lobby.subscribe(s => {
      if (s === "SUBSCRIBED") res();
      else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") rej(new Error("Could not reach Supabase Realtime (" + s + ")"));
    }));
    lobbyReady = true;
    matchTimer = setInterval(tryMatch, 2000);
    // Searching clients re-announce every 8s; peers that stop doing so are ghosts (closed tab, presence not yet expired).
    heartbeat = setInterval(() => { if (state === "searching" && active) track("searching").catch(() => {}); }, 8000);
  }

  const track = status => lobby.track({ status, t: Date.now() });

  function clearPending() { if (pending) { clearTimeout(pending.timer); pending = null; } }

  function tryMatch() {
    if (state !== "searching" || pending || !lobbyReady) return;
    const now = Date.now(), st = lobby.presenceState();
    let c = Object.keys(st).filter(k => {
      if (k === myId || blocked.has(k) || (skipUntil.get(k) || 0) > now) return false;
      const m = st[k][st[k].length - 1] || {};
      if (m.status !== "searching") return false;
      const seen = lastSeen.get(k);
      if (!seen || seen.t !== m.t) lastSeen.set(k, { t: m.t, at: now });
      return now - lastSeen.get(k).at < 25000;   // heartbeat seen recently
    });
    const fresh = c.filter(k => !recent.has(k));
    if (fresh.length) c = fresh;
    if (!c.length) return;
    const to = pick(c), r = uid();
    pending = { to, room: r, timer: setTimeout(() => { skip(to, 20000); pending = null; tryMatch(); }, 2500 + Math.random() * 1000) };
    lobby.send({ type: "broadcast", event: "invite", payload: { to, from: myId, room: r } });
  }

  async function onInvite(p) {
    if (p.to !== myId || state !== "searching" || blocked.has(p.from)) return;
    // Both sides invited each other: lower id keeps its invite, higher id accepts.
    if (pending && myId < p.from) return;
    clearPending();
    lock(p.from, p.room);
    const tok = session;
    try {
      await track("busy");
      await joinPair(p.room, tok);
      if (tok !== session) return;
      lobby.send({ type: "broadcast", event: "accept", payload: { to: p.from, from: myId, room: p.room } });
    } catch (e) { if (tok === session) fail(e); }
  }

  async function onAccept(p) {
    if (p.to !== myId) return;
    if (state === "searching" && pending && pending.to === p.from && pending.room === p.room) {
      clearPending();
      lock(p.from, p.room);
      const tok = session;
      try {
        await track("busy");
        await joinPair(p.room, tok);
        if (tok !== session) return;
        await startOffer(tok);
      } catch (e) { if (tok === session) fail(e); }
    } else {
      lobby.send({ type: "broadcast", event: "cancel", payload: { to: p.from, from: myId, room: p.room } });
    }
  }

  function lock(peer, r) {
    partnerId = peer; room = r;
    recent.add(peer); setTimeout(() => recent.delete(peer), 60000);
    setState("connecting");
    setStatus("Found someone – connecting…", true, "Connecting");
    clearTimeout(connectTimer); clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      if (state === "connecting") setStatus("Still connecting… the other person's network may be slow.", true, "Connecting");
    }, 6000);
    connectTimer = setTimeout(() => {
      if (isLinked()) return markConnected();       // it actually worked, a browser event just never fired
      skip(peer, 120000);                           // don't loop with someone we can't reach
      addMsg("Couldn't connect to that person, finding someone else…", "sys");
      restart();
    }, 15000);
  }

  const isLinked = () => !!pc && (pc.connectionState === "connected" ||
    pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed");

  // Single, idempotent "we're live" transition, fed by several independent signals
  function markConnected() {
    clearTimeout(connectTimer); clearTimeout(slowTimer); clearTimeout(discTimer);
    if (state === "connected" || state !== "connecting") return;
    setState("connected"); hideStatus(); $("tag").style.display = ""; blip([660, 880]);
    $("remote").classList.add("flash"); setTimeout(() => $("remote").classList.remove("flash"), 600);
    $("remoteVideo").play().catch(() => {});
    addMsg("You're connected. Say hi! 👋", "sys"); $("t").focus();
  }

  // ---- per-call signaling channel ----------------------------------------
  async function joinPair(r, tok) {
    const ch = sb.channel("pair:" + r, { config: { broadcast: { self: false } } });
    ch.on("broadcast", { event: "sig" }, ({ payload }) => { if (tok === session) onSignal(payload, tok); });
    ch.on("broadcast", { event: "bye" }, () => { if (tok === session) partnerLeft(); });
    pair = ch;
    await new Promise((res, rej) => ch.subscribe(s => {
      if (s === "SUBSCRIBED") res();
      else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") rej(new Error("signaling " + s));
    }));
  }
  const sig = (type, data) => pair && pair.send({ type: "broadcast", event: "sig", payload: { type, data } });

  // ---- WebRTC ------------------------------------------------------------
  function makePc(tok) {
    pc = new RTCPeerConnection(rtcConfig);
    iceQueue = [];
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pc.ontrack = e => {
      const v = $("remoteVideo");
      v.srcObject = e.streams[0];
      v.onplaying = () => { if (tok === session) markConnected(); };   // video is really on screen
    };
    pc.onicecandidate = e => { if (e.candidate && tok === session) sig("ice", e.candidate.toJSON()); };
    pc.oniceconnectionstatechange = () => {
      if (tok !== session || !pc) return;
      if (isLinked()) markConnected();
    };
    pc.onconnectionstatechange = () => {
      if (tok !== session || !pc) return;
      const s = pc.connectionState;
      if (s === "connected") { clearTimeout(discTimer); markConnected(); }
      else if (s === "disconnected") {
        clearTimeout(discTimer); discTimer = setTimeout(() => tok === session && !isLinked() && partnerLeft(), 6000);
      } else if (s === "failed") {
        if (state === "connecting") { skip(partnerId, 120000); addMsg("Couldn't connect to that person, finding someone else…", "sys"); restart(); }
        else partnerLeft();
      }
    };
    return pc;
  }

  function setupDc(ch) {
    dc = ch;
    ch.onopen = () => markConnected();
    ch.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        if (m.t === "msg" && typeof m.body === "string") { showTyping(false); addMsg(m.body.slice(0, 500), ""); if (document.hidden) blip([520]); }
        else if (m.t === "typ") showTyping(true);
      } catch {}
    };
  }

  let typingTimer = null, lastTyp = 0;
  function showTyping(on) {
    $("typing").textContent = on ? "Stranger is typing…" : "";
    clearTimeout(typingTimer); if (on) typingTimer = setTimeout(() => showTyping(false), 2500);
  }

  async function startOffer(tok) {
    makePc(tok);
    setupDc(pc.createDataChannel("chat"));
    await pc.setLocalDescription(await pc.createOffer());
    if (tok === session) sig("offer", pc.localDescription.toJSON());
  }

  async function onSignal({ type, data }, tok) {
    try {
      if (type === "offer") {
        makePc(tok);
        pc.ondatachannel = e => setupDc(e.channel);
        await pc.setRemoteDescription(data);
        await flushIce();
        await pc.setLocalDescription(await pc.createAnswer());
        if (tok === session) sig("answer", pc.localDescription.toJSON());
      } else if (type === "answer" && pc) {
        await pc.setRemoteDescription(data);
        await flushIce();
      } else if (type === "ice") {
        if (pc && pc.remoteDescription) await pc.addIceCandidate(data).catch(() => {});
        else iceQueue.push(data);
      }
    } catch (e) { if (tok === session) fail(e); }
  }
  async function flushIce() {
    const q = iceQueue; iceQueue = [];
    for (const c of q) await pc.addIceCandidate(c).catch(() => {});
  }

  // ---- lifecycle ---------------------------------------------------------
  async function teardown(notify) {
    session++; $("tag").style.display = "none";
    clearTimeout(connectTimer); clearTimeout(discTimer); clearTimeout(slowTimer); clearPending();
    const p = pair, d = dc, c = pc;
    pair = dc = pc = null; partnerId = room = null; iceQueue = [];
    try { d && d.close(); } catch {}
    try { c && c.close(); } catch {}
    $("remoteVideo").srcObject = null;
    if (p) {
      try { if (notify) await p.send({ type: "broadcast", event: "bye", payload: {} }); } catch {}
      sb.removeChannel(p);
    }
  }

  async function startSearching() {
    if (!active) return;
    setState("searching");
    setStatus("Looking for someone to chat with…<br><small style=\"color:var(--dim)\">Tip: open a second tab to test it yourself</small>", true, "Searching");
    try { await track("searching"); } catch (e) { return fail(e); }
    if (!active) { try { await lobby.untrack(); } catch {} return; }
    tryMatch();
  }

  async function restart() { await teardown(true); startSearching(); }

  async function partnerLeft() {
    if (!active || state === "idle") return;
    addMsg("Stranger disconnected.", "sys"); blip([440, 330]); showTyping(false);
    await teardown(false);
    startSearching();
  }

  function fail(e) {
    console.error(e);
    addMsg("Something went wrong – retrying…", "sys");
    setTimeout(() => active && restart(), 1500);
  }

  async function getMedia() {
    if (localStream) return true;
    if (!navigator.mediaDevices || !window.isSecureContext) {
      setStatus("Camera access needs <b>https://</b> (or localhost).", false, "Secure connection needed"); return false;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      $("localVideo").srcObject = localStream;
      $("pip").style.display = "block";
      return true;
    } catch (e) {
      setStatus(BRAND.name + " needs your camera and microphone. Allow access in your browser's address bar, then press Start again.", false, "Camera blocked");
      return false;
    }
  }

  // ---- buttons -----------------------------------------------------------
  $("start2").onclick = () => $("start").click();
  $("start").onclick = async () => {
    if (!(await getMedia())) return;
    try { await joinLobby(); } catch (e) { setStatus("Can't reach the server right now. Check your connection and try again.", false, "Offline"); return; }
    active = true;
    log.innerHTML = "";
    startSearching();
  };
  $("next").onclick = async () => {
    if (!active) return;
    log.innerHTML = "";
    await restart();
  };
  $("stop").onclick = async () => {
    active = false;
    setState("idle");
    setStatus("A stranger, a camera, a conversation. No sign-up, no accounts.", false, "Meet someone new");
    showTyping(false);
    await teardown(true);
    try { if (lobbyReady && !active) await lobby.untrack(); } catch {}
  };
  const toggle = (btn, kind, label) => btn.onclick = () => {
    const t = localStream && localStream[kind === "audio" ? "getAudioTracks" : "getVideoTracks"]()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    btn.classList.toggle("off", !t.enabled);
    btn.textContent = t.enabled ? label[0] : label[1];
    if (kind === "video") $("pip").classList.toggle("camoff", !t.enabled);
  };
  toggle($("mic"), "audio", ["🎤", "🔇"]);
  toggle($("cam"), "video", ["📷", "🚫"]);

  $("t").addEventListener("input", () => {
    if (dc && dc.readyState === "open" && Date.now() - lastTyp > 1500) { lastTyp = Date.now(); dc.send('{"t":"typ"}'); }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && active && !document.querySelector("dialog[open]")) { e.preventDefault(); $("next").click(); }
  });

  $("chat").onsubmit = e => {
    e.preventDefault();
    const body = $("t").value.trim();
    if (!body || !dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify({ t: "msg", body }));
    addMsg(body, "me");
    $("t").value = "";
  };

  // ---- report ------------------------------------------------------------
  $("report").onclick = () => $("rep").showModal();
  $("repCancel").onclick = () => $("rep").close();
  $("repSend").onclick = async () => {
    const reported = partnerId, reason = $("repReason").value;
    $("rep").close();
    if (!reported) return;
    blocked.add(reported);
    sb.from("reports").insert({ reporter: myId, reported, reason }).then(r => r.error && console.warn("report failed", r.error));
    log.innerHTML = "";
    toast("Reported – thanks. Finding someone new."); 
    await restart();
  };

  // ---- 18+ gate ----------------------------------------------------------
  const gate = $("gate");
  let ok = false;
  try { ok = localStorage.getItem("mc_18") === "1"; } catch {}
  ageOk = ok;
  if (!ok) {
    updateUI();
    gate.addEventListener("cancel", e => e.preventDefault());
    gate.showModal();
    $("gateYes").onclick = () => { try { localStorage.setItem("mc_18", "1"); } catch {} gate.close(); ageOk = true; updateUI(); };
    $("gateNo").onclick = () => { location.href = "about:blank"; };
  }

  window.addEventListener("pagehide", () => { if (pair) pair.send({ type: "broadcast", event: "bye", payload: {} }); });
  updateUI();
  joinLobby().catch(() => { $("online").textContent = "offline"; }); // subscribe early so the online count is live before Start
})();
