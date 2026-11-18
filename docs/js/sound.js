// Hear the city: a soft drone that swells with the number of buses on the road, and a falling "wooo"
// every time a bus that was due never turns up. Web Audio only, no files. Off until someone presses it.
export function createSound() {
  let ctx = null, master = null, pad = null, padGain = null, last = 0, queue = 0;
  function start() {
    if (ctx) { ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor(); master.connect(comp).connect(ctx.destination);
    // the drone: two detuned saws through a slow low-pass
    padGain = ctx.createGain(); padGain.gain.value = 0.0;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 380; lp.Q.value = 6;
    const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.frequency.value = 0.07; lfoG.gain.value = 160; lfo.connect(lfoG).connect(lp.frequency); lfo.start();
    pad = [55, 82.4, 110.3].map((f, k) => { const o = ctx.createOscillator(); o.type = k === 2 ? "triangle" : "sawtooth"; o.frequency.value = f; o.detune.value = (k - 1) * 7; o.connect(lp); o.start(); return o; });
    lp.connect(padGain).connect(master);
  }
  function stop() { if (ctx) ctx.suspend(); }
  function level(x) {               // 0..1, how busy the roads are
    if (!ctx || ctx.state !== "running") return;
    padGain.gain.setTargetAtTime(0.02 + Math.min(1, x) * 0.11, ctx.currentTime, 0.4);
  }
  function ghost(seed = Math.random()) {
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    if (now - last < 0.12) { queue = Math.min(queue + 1, 3); return; }
    last = now;
    const f0 = 420 + (seed % 1) * 380;
    const o = ctx.createOscillator(), vib = ctx.createOscillator(), vg = ctx.createGain(), g = ctx.createGain(), pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    o.type = "sine"; vib.frequency.value = 6.5; vg.gain.value = 9; vib.connect(vg).connect(o.frequency);
    o.frequency.setValueAtTime(f0, now); o.frequency.exponentialRampToValueAtTime(f0 * 0.48, now + 1.1);
    g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.16, now + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
    const echo = ctx.createDelay(); echo.delayTime.value = 0.23; const fb = ctx.createGain(); fb.gain.value = 0.32; echo.connect(fb).connect(echo);
    let out = g; if (pan) { pan.pan.value = (seed * 2 % 2) - 1; g.connect(pan); out = pan; }
    o.connect(g); out.connect(master); out.connect(echo); echo.connect(master);
    o.start(now); vib.start(now); o.stop(now + 1.4); vib.stop(now + 1.4);
    if (queue > 0) { queue--; setTimeout(() => ghost(Math.random()), 140); }
  }
  return { start, stop, level, ghost, get on() { return !!ctx && ctx.state === "running"; } };
}
