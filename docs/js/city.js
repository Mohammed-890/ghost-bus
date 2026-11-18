// Ghost City: a whole day of Sheffield's buses on a dark 3D map of the city.
// The floor is the real map (OpenStreetMap, darkened) with every route drawn on it as a glowing line,
// coloured by how often its buses vanish, and a pink glow where buses go missing most. On top, the day
// replays: yellow lights for the buses that drove, floating ghosts for the ones that never came, and a
// labelled beam over the ten stops with the worst record.
import * as THREE from "../vendor/three/three.module.min.js";
import { OrbitControls } from "../vendor/three/addons/controls/OrbitControls.js";
import { EffectComposer } from "../vendor/three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "../vendor/three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "../vendor/three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "../vendor/three/addons/postprocessing/OutputPass.js";

const LAT0 = 53.381, LON0 = -1.47, KX = Math.cos((LAT0 * Math.PI) / 180) * 111.32, KZ = 110.57;
const xy = (lat, lon) => [(lon - LON0) * KX, -(lat - LAT0) * KZ];
const AREA = { n: 53.475, s: 53.3, w: -1.62, e: -1.3 };          // the floor
const PLACES = [["City Centre", 53.3811, -1.4701], ["Meadowhall", 53.4146, -1.4121], ["Hillsborough", 53.4035, -1.5115], ["Crystal Peaks", 53.3426, -1.3459],
  ["Rotherham", 53.4302, -1.3568], ["Crookes", 53.3878, -1.5133], ["Firth Park", 53.4133, -1.4422], ["Gleadless", 53.3517, -1.4369], ["Ecclesall", 53.3615, -1.5036],
  ["Dore", 53.3271, -1.5332], ["Parson Cross", 53.4271, -1.4818], ["Darnall", 53.3843, -1.4091], ["Woodhouse", 53.3601, -1.3778]];
const C_OK = new THREE.Color("#2BE4C8"), C_MID = new THREE.Color("#ff4fa3"), C_BAD = new THREE.Color("#b26bff");
function rateColor(r) {
  const c = new THREE.Color();
  if (r <= 0.03) c.copy(C_OK); else if (r <= 0.08) c.lerpColors(C_OK, C_MID, (r - 0.03) / 0.05); else c.lerpColors(C_MID, C_BAD, Math.min(1, (r - 0.08) / 0.08));
  return c;
}

// ---------------------------------------------------------------- the floor: dark map + glowing routes
const TW = 2048, TH = Math.round(TW * ((AREA.n - AREA.s) * KZ) / ((AREA.e - AREA.w) * KX));
const px = (lat, lon) => [((lon - AREA.w) / (AREA.e - AREA.w)) * TW, ((AREA.n - lat) / (AREA.n - AREA.s)) * TH];
const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const tileLat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(Math.sinh(n)); };
function loadTile(src) {
  return new Promise((ok) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; setTimeout(() => ok(null), 8000); });
}
async function drawMap(ctx) {
  const z = 13, x0 = Math.floor(tileX(AREA.w, z)), x1 = Math.floor(tileX(AREA.e, z)), y0 = Math.floor(tileY(AREA.n, z)), y1 = Math.floor(tileY(AREA.s, z));
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(loadTile(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`).then((img) => {
      if (!img) return 0;
      const lonW = (x / 2 ** z) * 360 - 180, lonE = ((x + 1) / 2 ** z) * 360 - 180, latN = tileLat(y, z), latS = tileLat(y + 1, z);
      const [ax, ay] = px(latN, lonW), [bx, by] = px(latS, lonE);
      ctx.drawImage(img, ax, ay, bx - ax + 0.6, by - ay + 0.6);
      return 1;
    }));
  }
  const got = (await Promise.all(jobs)).reduce((a, b) => a + b, 0);
  if (!got) return false;
  try {                                   // turn the light map into a dark one: invert, then tint
    ctx.globalCompositeOperation = "difference"; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, TW, TH);
    ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = "#4a4280"; ctx.fillRect(0, 0, TW, TH);
    ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "rgba(6,4,20,.35)"; ctx.fillRect(0, 0, TW, TH);
    ctx.getImageData(0, 0, 1, 1);         // throws if the tiles tainted the canvas
  } catch { return false; }
  return true;
}
function drawRoutes(ctx, shapes, rates) {
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const list = (shapes || []).map((s) => ({ s, r: rates.get(s.id) })).sort((a, b) => (a.r ?? 0) - (b.r ?? 0));   // worst on top
  for (const pass of [0, 1]) for (const { s, r } of list) {
    if (!s.path || s.path.length < 2) continue;
    const c = "#" + rateColor(r ?? 0.02).getHexString();
    ctx.beginPath();
    s.path.forEach(([la, lo], k) => { const [x, y] = px(la, lo); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    if (pass === 0) { ctx.strokeStyle = c; ctx.globalAlpha = r == null ? 0.05 : 0.12; ctx.lineWidth = 8; ctx.shadowBlur = 0; }
    else { ctx.strokeStyle = c; ctx.globalAlpha = r == null ? 0.25 : (r > 0.08 ? 0.95 : 0.6); ctx.lineWidth = r > 0.08 ? 3 : 2; ctx.shadowColor = c; ctx.shadowBlur = r > 0.08 ? 10 : 4; }
    ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}
function drawHotspots(ctx, stops) {
  ctx.globalCompositeOperation = "lighter";
  for (const s of stops) {
    if (s.n < 80 || !s.g) continue;
    const rate = s.g / s.n;
    if (rate < 0.04) continue;
    const [x, y] = px(s.lat, s.lon), rad = 10 + Math.min(34, Math.sqrt(s.g) * 2.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(255,79,163,${Math.min(0.5, rate * 2.2)})`); g.addColorStop(1, "rgba(255,79,163,0)");
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  ctx.globalCompositeOperation = "source-over";
}

export function mountCity(host, { replay, posAt, shapes, routeRates, stops, onTick, onPick, onHover }) {
  const W = () => host.clientWidth, H = () => host.clientHeight;
  const small = Math.min(W(), H()) < 600;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.setSize(W(), H());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.append(renderer.domElement);
  const labels = document.createElement("div"); labels.className = "city-labels"; host.append(labels);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#04030c");
  scene.fog = new THREE.Fog("#04030c", 16, 42);
  const camera = new THREE.PerspectiveCamera(42, W() / H(), 0.05, 400);
  camera.position.set(0.5, small ? 15 : 12, small ? 14 : 11);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.autoRotate = !matchMedia("(prefers-reduced-motion: reduce)").matches; controls.autoRotateSpeed = 0.18;
  controls.maxPolarAngle = 1.32; controls.minDistance = 1.6; controls.maxDistance = 30; controls.target.set(0, 0, 0.4);
  controls.addEventListener("start", () => { controls.autoRotate = false; });

  // the floor
  const cv = document.createElement("canvas"); cv.width = TW; cv.height = TH;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#0b0920"; ctx.fillRect(0, 0, TW, TH);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const [fx0, fz0] = xy(AREA.n, AREA.w), [fx1, fz1] = xy(AREA.s, AREA.e);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(fx1 - fx0, fz1 - fz0), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  floor.rotation.x = -Math.PI / 2; floor.position.set((fx0 + fx1) / 2, 0, (fz0 + fz1) / 2); scene.add(floor);
  const paintFloor = (withMap) => {
    if (!withMap) { ctx.fillStyle = "#0b0920"; ctx.fillRect(0, 0, TW, TH); }
    drawHotspots(ctx, stops || []); drawRoutes(ctx, shapes, routeRates); tex.needsUpdate = true;
  };
  paintFloor(false);
  const mapReady = drawMap(ctx).then((ok) => { paintFloor(ok); return ok; });

  // stars, far away
  const sp = new Float32Array(1400 * 3);
  for (let k = 0; k < 1400; k++) { const th = Math.random() * Math.PI * 2, ph = Math.random() * 1.1, r = 150; sp[3 * k] = r * Math.sin(ph) * Math.cos(th); sp[3 * k + 1] = r * Math.cos(ph) * 0.6 + 10; sp[3 * k + 2] = r * Math.sin(ph) * Math.sin(th); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: "#cfc6ff", size: 0.5, fog: false, transparent: true, opacity: 0.6 })));

  // beams over the ten stops with the worst record (one per record, so a route's stops don't all repeat)
  const seen = new Set(), worst = [];
  for (const s of (stops || []).filter((s) => s.n >= 200).sort((a, b) => b.g / b.n - a.g / a.n)) {
    const k = `${s.n}|${s.g}`, base = s.name.split("/")[0];
    if (seen.has(k) || seen.has(base)) continue; seen.add(k); seen.add(base); worst.push(s); if (worst.length >= 8) break;
  }
  const beamGeo = new THREE.CylinderGeometry(0.035, 0.09, 1, 12, 1, true).translate(0, 0.5, 0);
  const tops = worst.map((s, rank) => {
    const [x, z] = xy(s.lat, s.lon), rate = s.g / s.n, h = 0.9 + rate * 9, col = rateColor(rate);
    const m = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.set(x, 0, z); m.scale.y = h; scene.add(m);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.16, 32), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.01, z); scene.add(ring);
    const lab = document.createElement("div"); lab.className = rank < 5 ? "city-lab hot" : "city-lab hot minor";
    const b = document.createElement("b"); b.textContent = `${Math.round(rate * 100)}%`;
    const sp2 = document.createElement("span"); sp2.textContent = s.name.split("/")[0];
    lab.append(b, sp2); labels.append(lab);
    return { s, x, z, h, lab, ring };
  });
  const places = PLACES.map(([name, la, lo]) => { const [x, z] = xy(la, lo); const d = document.createElement("div"); d.className = "city-lab place"; d.textContent = name; labels.append(d); return { x, z, d }; });

  // buses and ghosts
  const buses = replay?.buses || [], ghosts = replay?.ghosts || [];
  const busMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: "#ffd25a", toneMapped: false }), Math.max(1, buses.length));
  const prof = [];
  for (let k = 0; k <= 12; k++) { const a = (k / 12) * (Math.PI / 2); prof.push(new THREE.Vector2(Math.cos(a) * 0.17, 0.24 + Math.sin(a) * 0.17)); }
  prof.unshift(new THREE.Vector2(0.185, 0), new THREE.Vector2(0.17, 0.03));
  const gMesh = new THREE.InstancedMesh(new THREE.LatheGeometry(prof, 28), new THREE.MeshBasicMaterial({ color: "#f5f0ff", transparent: true, opacity: 0.92, side: THREE.DoubleSide, toneMapped: false }), Math.max(1, ghosts.length));
  const eyes = new THREE.InstancedMesh(new THREE.SphereGeometry(0.032, 8, 6), new THREE.MeshBasicMaterial({ color: "#1b0b3a" }), Math.max(1, ghosts.length * 2));
  const beams = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.02, 0.07, 1, 10, 1, true).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: "#ff4fa3", transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }), Math.max(1, ghosts.length));
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const m of [busMesh, gMesh, eyes, beams]) { m.frustumCulled = false; for (let k = 0; k < m.count; k++) m.setMatrixAt(k, hide); scene.add(m); }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(W(), H()).multiplyScalar(small ? 0.5 : 1), 0.6, 0.45, 0.7));
  composer.addPass(new OutputPass());

  const state = { t: 6.5 * 3600, playing: true, speed: 900, start: 4.5 * 3600, end: 24 * 3600 };
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3();
  const toCam = new THREE.Vector3(), side = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), v3 = new THREE.Vector3();
  const GS = 1.1;                                      // ghost size
  let raf = 0, last = 0, live = [];
  const screen = (x, y, z) => { v3.set(x, y, z).project(camera); return [((v3.x + 1) / 2) * W(), ((1 - v3.y) / 2) * H(), v3.z]; };
  function placeLabels() {
    const dist = camera.position.distanceTo(controls.target);
    for (const p of places) {
      const [sx, sy, sz] = screen(p.x, 0.02, p.z);
      const show = sz < 1 && sx > -50 && sx < W() + 50 && sy > 60 && sy < H() - 40;
      p.d.style.display = show ? "" : "none";
      if (show) { p.d.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -50%)`; p.d.style.opacity = dist > 16 ? "0.55" : "0.85"; }
    }
    for (const t of tops) {
      const [sx, sy, sz] = screen(t.x, t.h, t.z);
      const show = sz < 1 && sx > -80 && sx < W() + 80 && sy > 40 && sy < H();
      t.lab.style.display = show ? "" : "none";
      if (show) t.lab.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px) translate(-50%, -110%)`;
    }
  }
  function frame(ts) {
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0; last = ts;
    if (state.playing) { state.t += dt * state.speed; if (state.t > state.end) state.t = state.start; }
    const t = state.t;
    let on = 0;
    buses.forEach((b, k) => {
      const p = posAt(b, t, 600);
      if (!p) { busMesh.setMatrixAt(k, hide); return; }
      const ll = replay.toLL(p[0], p[1]), [x, z] = xy(ll[0], ll[1]);
      M.compose(P.set(x, 0.07, z), Q.identity(), S.set(1, 1, 1)); busMesh.setMatrixAt(k, M); on++;
    });
    busMesh.instanceMatrix.needsUpdate = true;
    let started = 0; live = [];
    camera.getWorldDirection(toCam); toCam.y = 0; toCam.normalize().negate(); side.crossVectors(UP, toCam).normalize();
    ghosts.forEach((g, k) => {
      const st = g.t[0], end = g.t[g.t.length - 1];
      const off = () => { gMesh.setMatrixAt(k, hide); eyes.setMatrixAt(2 * k, hide); eyes.setMatrixAt(2 * k + 1, hide); beams.setMatrixAt(k, hide); };
      if (t < st || t > end + 900) return off();
      started++;
      const p = t <= end ? posAt(g, t, 3600) : [g.la[g.la.length - 1], g.lo[g.lo.length - 1]];
      if (!p) return off();
      const ll = replay.toLL(p[0], p[1]), [x, z] = xy(ll[0], ll[1]);
      const fade = t <= end ? 1 : 1 - (t - end) / 900, sc = GS * (0.5 + 0.5 * fade), y = 0.3 + Math.sin(ts / 450 + k) * 0.07 + (1 - fade) * 1.4;
      M.compose(P.set(x, y, z), Q.identity(), S.set(sc, sc, sc)); gMesh.setMatrixAt(k, M);
      live.push([k, x, y + 0.22 * sc, z]);
      for (const [e, s] of [[0, -1], [1, 1]]) {
        M.compose(P.set(x + side.x * 0.06 * s * sc + toCam.x * 0.15 * sc, y + 0.3 * sc, z + side.z * 0.06 * s * sc + toCam.z * 0.15 * sc), Q.identity(), S.set(sc, sc * 1.4, sc));
        eyes.setMatrixAt(2 * k + e, M);
      }
      const age = t - st;
      if (age < 600) { const [bx, bz] = xy(...replay.toLL(g.la[0], g.lo[0])); M.compose(P.set(bx, 0, bz), Q.identity(), S.set(1.2, 2.2 * (1 - age / 600), 1.2)); beams.setMatrixAt(k, M); }
      else beams.setMatrixAt(k, hide);
    });
    gMesh.instanceMatrix.needsUpdate = true; eyes.instanceMatrix.needsUpdate = true; beams.instanceMatrix.needsUpdate = true;
    const pulse = 1 + Math.sin(ts / 500) * 0.25;
    for (const tp of tops) tp.ring.scale.set(pulse, pulse, pulse);
    controls.update();
    composer.render();
    placeLabels();
    onTick?.(t, on, started, buses.length);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // hover a ghost for its bus, or a beam for its stop
  let downAt = null;
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    let best = null, bd = 22 * 22;
    for (const [k, x, y, z] of live) { const [sx, sy, sz] = screen(x, y, z); const d = (sx - mx) ** 2 + (sy - my) ** 2; if (sz < 1 && d < bd) { bd = d; best = { kind: "ghost", g: ghosts[k] }; } }
    if (best) return best;
    for (const tp of tops) {
      const [ax, ay] = screen(tp.x, 0, tp.z), [bx, by] = screen(tp.x, tp.h, tp.z);
      const t2 = Math.max(0, Math.min(1, ((mx - ax) * (bx - ax) + (my - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
      const d = (ax + t2 * (bx - ax) - mx) ** 2 + (ay + t2 * (by - ay) - my) ** 2;
      if (d < bd) { bd = d; best = { kind: "stop", s: tp.s }; }
    }
    return best;
  }
  const onMove = (ev) => { const h = pick(ev); renderer.domElement.style.cursor = h ? "pointer" : "grab"; onHover?.(h, ev.clientX, ev.clientY); };
  const onDown = (ev) => { downAt = [ev.clientX, ev.clientY]; };
  const onUp = (ev) => { if (downAt && Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) < 6) { const h = pick(ev); if (h) onPick?.(h); } downAt = null; };
  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);
  const onResize = () => { camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); composer.setSize(W(), H()); };
  addEventListener("resize", onResize);

  return {
    state, mapReady,
    dispose() {
      cancelAnimationFrame(raf); removeEventListener("resize", onResize); controls.dispose();
      scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); });
      composer.dispose?.(); renderer.dispose(); renderer.domElement.remove(); labels.remove();
    },
    fly(lat, lon) {
      const [x, z] = xy(lat, lon); controls.autoRotate = false;
      const from = controls.target.clone(), to = new THREE.Vector3(x, 0, z), cFrom = camera.position.clone(), cTo = new THREE.Vector3(x + 1.2, 2.6, z + 3.2);
      const t0 = performance.now();
      const step = (now) => { const k = Math.min(1, (now - t0) / 1200), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; controls.target.lerpVectors(from, to, e); camera.position.lerpVectors(cFrom, cTo, e); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    },
  };
}
