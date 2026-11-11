/* MirrorChat sounds: short tones made with the Web Audio API, no audio files.
   MCSound.play("message" | "matched" | "left" | "report" | "send"), MCSound.setMuted(bool). */
(function () {
  let ctx = null, muted = false;
  try { muted = localStorage.getItem("mc_muted") === "1"; } catch (e) {}

  function audio() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { ctx = new C(); } catch (e) { return null; }
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(freq, delay, dur, type, vol) {
    if (muted) return;
    const c = audio(); if (!c) return;
    const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol || 0.12, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.03);
  }

  const sounds = {
    message() { tone(880, 0, 0.12); tone(1175, 0.08, 0.18); },                       // a soft ping
    send()    { tone(700, 0, 0.07, "sine", 0.06); },                                 // your own message
    matched() { tone(523, 0, 0.16); tone(659, 0.12, 0.16); tone(784, 0.24, 0.3); },  // rising chime
    left()    { tone(659, 0, 0.14); tone(494, 0.12, 0.14); tone(392, 0.24, 0.26); }, // falling tone
    report()  { tone(440, 0, 0.1, "triangle"); tone(440, 0.16, 0.1, "triangle"); tone(660, 0.32, 0.22, "triangle"); }
  };

  window.MCSound = {
    play(name) { if (sounds[name]) sounds[name](); },
    unlock() { audio(); },
    get muted() { return muted; },
    setMuted(v) { muted = !!v; try { localStorage.setItem("mc_muted", muted ? "1" : "0"); } catch (e) {} },
    /* wires a button: aria-pressed true means sound is off */
    bindToggle(btn) {
      const paint = () => {
        btn.setAttribute("aria-pressed", String(muted));
        btn.setAttribute("aria-label", muted ? "Turn sound on" : "Turn sound off");
        btn.querySelector(".icon-btn__label").textContent = muted ? "Sound off" : "Sound on";
        btn.classList.toggle("is-off", muted);
      };
      btn.addEventListener("click", () => { this.setMuted(!muted); paint(); if (!muted) this.play("matched"); });
      paint();
    }
  };
})();
