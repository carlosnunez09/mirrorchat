/* MirrorChat – random 1:1 video chat.
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

  $("myid").textContent = "anon-" + myId.slice(0, 6);

  // ---- state -------------------------------------------------------------
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

  // ---- ui helpers --------------------------------------------------------
  const log = $("log");
  function addMsg(text, cls = "") {
    const d = document.createElement("div");
    d.className = "msg " + cls;
    d.textContent = text;
    log.append(d);
    log.scrollTop = log.scrollHeight;
  }
  function setStatus(html, spinning) {
    $("status").innerHTML = html;
    $("spin").classList.toggle("off", !spinning);
    $("overlay").classList.toggle("hidden", html === null);
  }
  function hideStatus() { $("overlay").classList.add("hidden"); }
  function updateUI() {
    const inCall = state === "connected", active = state !== "idle";
    $("start").disabled = active;
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
      $("online").innerHTML = `<b>●</b> ${n} online`;
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
  }

  const track = status => lobby.track({ status, t: Date.now() });

  function clearPending() { if (pending) { clearTimeout(pending.timer); pending = null; } }

  function tryMatch() {
    if (state !== "searching" || pending || !lobbyReady) return;
    const st = lobby.presenceState();
    let c = Object.keys(st).filter(k => k !== myId && !blocked.has(k) &&
      (st[k][st[k].length - 1] || {}).status === "searching");
    const fresh = c.filter(k => !recent.has(k));
    if (fresh.length) c = fresh;
    if (!c.length) return;
    const to = pick(c), r = uid();
    pending = { to, room: r, timer: setTimeout(() => { pending = null; tryMatch(); }, 2500 + Math.random() * 1000) };
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
    setStatus("Found someone – connecting…", true);
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => { addMsg("Connection timed out, finding someone else…", "sys"); restart(); }, 15000);
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
    pc.ontrack = e => { $("remoteVideo").srcObject = e.streams[0]; };
    pc.onicecandidate = e => { if (e.candidate && tok === session) sig("ice", e.candidate.toJSON()); };
    pc.onconnectionstatechange = () => {
      if (tok !== session || !pc) return;
      const s = pc.connectionState;
      if (s === "connected") {
        clearTimeout(connectTimer); clearTimeout(discTimer);
        if (state !== "connected") { setState("connected"); hideStatus(); addMsg("You're connected. Say hi! 👋", "sys"); }
      } else if (s === "disconnected") {
        clearTimeout(discTimer); discTimer = setTimeout(() => tok === session && partnerLeft(), 6000);
      } else if (s === "failed") partnerLeft();
    };
    return pc;
  }

  function setupDc(ch) {
    dc = ch;
    ch.onmessage = e => {
      try { const m = JSON.parse(e.data); if (m.t === "msg" && typeof m.body === "string") addMsg(m.body.slice(0, 500), ""); } catch {}
    };
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
    session++;
    clearTimeout(connectTimer); clearTimeout(discTimer); clearPending();
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
    setState("searching");
    setStatus("Looking for someone to chat with…", true);
    try { await track("searching"); } catch (e) { return fail(e); }
    tryMatch();
  }

  async function restart() { await teardown(true); if (state !== "idle") startSearching(); }

  async function partnerLeft() {
    if (state === "idle") return;
    addMsg("Stranger disconnected.", "sys");
    await teardown(false);
    startSearching();
  }

  function fail(e) {
    console.error(e);
    addMsg("Error: " + (e && e.message || e), "sys");
    restart();
  }

  async function getMedia() {
    if (localStream) return true;
    if (!navigator.mediaDevices || !window.isSecureContext) {
      setStatus("Camera access needs <b>https://</b> (or localhost).", false); return false;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      $("localVideo").srcObject = localStream;
      return true;
    } catch (e) {
      setStatus("Couldn't access your camera/mic. Allow permission in your browser and press Start again.", false);
      return false;
    }
  }

  // ---- buttons -----------------------------------------------------------
  $("start").onclick = async () => {
    if (!(await getMedia())) return;
    try { await joinLobby(); } catch (e) { setStatus("Can't reach the server: " + e.message, false); return; }
    log.innerHTML = "";
    startSearching();
  };
  $("next").onclick = async () => {
    if (state === "idle") return;
    log.innerHTML = "";
    await restart();
  };
  $("stop").onclick = async () => {
    await teardown(true);
    setState("idle");
    try { if (lobbyReady) await lobby.untrack(); } catch {}
    setStatus("Press <b>Start</b> to meet someone random.", false);
  };
  const toggle = (btn, kind, label) => btn.onclick = () => {
    const t = localStream && localStream[kind === "audio" ? "getAudioTracks" : "getVideoTracks"]()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    btn.classList.toggle("off", !t.enabled);
    btn.textContent = (t.enabled ? "" : "🚫 ") + label;
  };
  toggle($("mic"), "audio", "🎤 Mic");
  toggle($("cam"), "video", "📷 Cam");

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
    addMsg("Reported. Thanks – finding someone new.", "sys");
    await restart();
  };

  // ---- 18+ gate ----------------------------------------------------------
  const gate = $("gate");
  let ok = false;
  try { ok = localStorage.getItem("mc_18") === "1"; } catch {}
  if (!ok) {
    $("start").disabled = true;
    gate.addEventListener("cancel", e => e.preventDefault());
    gate.showModal();
    $("gateYes").onclick = () => { try { localStorage.setItem("mc_18", "1"); } catch {} gate.close(); $("start").disabled = false; };
    $("gateNo").onclick = () => { location.href = "about:blank"; };
  }

  window.addEventListener("pagehide", () => { if (pair) pair.send({ type: "broadcast", event: "bye", payload: {} }); });
  updateUI();
})();
