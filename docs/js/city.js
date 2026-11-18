// Ghost City: Sheffield at night in 3D. Every route is a neon line coloured by how often its buses vanish,
// every stop is a tower as tall as the number of buses that never came there, and a whole day replays on top:
// yellow lights for the buses that drove, floating ghosts for the ones that never came.
import * as THREE from "../vendor/three/three.module.min.js";
import { OrbitControls } from "../vendor/three/addons/controls/OrbitControls.js";
import { EffectComposer } from "../vendor/three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "../vendor/three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "../vendor/three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "../vendor/three/addons/postprocessing/OutputPass.js";

const LAT0 = 53.385, LON0 = -1.47, KX = Math.cos((LAT0 * Math.PI) / 180) * 111.32, KZ = 110.57;
const xy = (lat, lon) => [(lon - LON0) * KX, -(lat - LAT0) * KZ];
const C_OK = new THREE.Color("#2BE4C8"), C_MID = new THREE.Color("#ff4fa3"), C_BAD = new THREE.Color("#a855f7");
function rateColor(r) {
  const c = new THREE.Color();
  if (r <= 0.06) c.lerpColors(C_OK, C_MID, Math.max(0, r) / 0.06); else c.lerpColors(C_MID, C_BAD, Math.min(1, (r - 0.06) / 0.09));
  return c;
}

export function mountCity(host, { replay, posAt, shapes, routeRates, stops, onTick, onPick, onHover }) {
  const W = () => host.clientWidth, H = () => host.clientHeight;
  const small = Math.min(W(), H()) < 600;
  const renderer = new THREE.WebGLRenderer({ antialias: !small, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.setSize(W(), H());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#05030f");
  scene.fog = new THREE.FogExp2("#05030f", 0.028);
  const camera = new THREE.PerspectiveCamera(45, W() / H(), 0.05, 400);
  camera.position.set(-6, 9, 15);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.autoRotate = !matchMedia("(prefers-reduced-motion: reduce)").matches; controls.autoRotateSpeed = 0.35;
  controls.maxPolarAngle = 1.42; controls.minDistance = 2.5; controls.maxDistance = 45; controls.target.set(0, 0, 0);

  // ground, grid and stars
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshBasicMaterial({ color: "#090619" }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const grid = new THREE.GridHelper(60, 60, "#2a1f5c", "#140d30"); grid.position.y = 0.002; scene.add(grid);
  const sp = new Float32Array(1800 * 3);
  for (let k = 0; k < 1800; k++) { const th = Math.random() * Math.PI * 2, ph = Math.random() * 1.2, r = 120; sp[3 * k] = r * Math.sin(ph) * Math.cos(th); sp[3 * k + 1] = r * Math.cos(ph) * 0.6 + 6; sp[3 * k + 2] = r * Math.sin(ph) * Math.sin(th); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: "#cfc6ff", size: 0.35, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.7 })));

  // routes: neon lines, coloured by how often their buses vanish
  const lines = new THREE.Group();
  for (const s of shapes || []) {
    if (!s.path || s.path.length < 2) continue;
    const pts = s.path.map(([la, lo]) => { const [x, z] = xy(la, lo); return new THREE.Vector3(x, 0.04, z); });
    const r = routeRates.get(s.id);
    const m = new THREE.LineBasicMaterial({ color: rateColor(r ?? 0.02), transparent: true, opacity: r == null ? 0.25 : 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    lines.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), m));
  }
  scene.add(lines);

  // towers: one per stop, as tall as the number of buses that never came there
  const tstops = (stops || []).filter((s) => s.n >= 150 && s.g >= 3);
  const maxG = Math.max(1, ...tstops.map((s) => s.g));
  const towers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 1, 0.06).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: "#ffffff" }), tstops.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3();
  tstops.forEach((s, k) => {
    const [x, z] = xy(s.lat, s.lon), h = 0.04 + Math.pow(s.g / maxG, 0.8) * 2.6;
    M.compose(P.set(x, 0, z), Q.identity(), S.set(1, h, 1)); towers.setMatrixAt(k, M);
    towers.setColorAt(k, rateColor(s.g / s.n).multiplyScalar(0.3 + Math.min(0.35, s.g / s.n * 2.5)));
  });
  scene.add(towers);

  // buses: small warm lights
  const buses = replay?.buses || [], ghosts = replay?.ghosts || [];
  const busMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 8, 6), new THREE.MeshBasicMaterial({ color: "#ffc43d" }), Math.max(1, buses.length));
  scene.add(busMesh);
  // ghosts: a lathe-turned sheet with a wavy hem, two eyes, and a beam where each one went missing
  const prof = [];
  for (let k = 0; k <= 10; k++) { const a = (k / 10) * (Math.PI / 2); prof.push(new THREE.Vector2(Math.cos(a) * 0.17, 0.24 + Math.sin(a) * 0.17)); }
  prof.unshift(new THREE.Vector2(0.17, 0.02), new THREE.Vector2(0.185, 0));
  const gGeo = new THREE.LatheGeometry(prof.reverse(), 24);
  const gMesh = new THREE.InstancedMesh(gGeo, new THREE.MeshBasicMaterial({ color: "#f3edff", transparent: true, opacity: 0.88, side: THREE.DoubleSide }), Math.max(1, ghosts.length));
  const eyes = new THREE.InstancedMesh(new THREE.SphereGeometry(0.03, 8, 6), new THREE.MeshBasicMaterial({ color: "#1b0b3a" }), Math.max(1, ghosts.length * 2));
  const beams = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.025, 0.06, 1, 8, 1, true).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: "#ff4fa3", transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }), Math.max(1, ghosts.length));
  scene.add(gMesh, eyes, beams);
  for (const m of [towers, busMesh, gMesh, eyes, beams]) m.frustumCulled = false;
  for (const m of [busMesh, gMesh, eyes, beams]) for (let k = 0; k < m.count; k++) m.setMatrixAt(k, new THREE.Matrix4().makeScale(0, 0, 0));

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()).multiplyScalar(small ? 0.5 : 1), 0.85, 0.45, 0.32);
  composer.addPass(bloom); composer.addPass(new OutputPass());

  const state = { t: 5.5 * 3600, playing: true, speed: 1200, start: 4.5 * 3600, end: 24 * 3600 };
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);
  const toCam = new THREE.Vector3(), side = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  let raf = 0, last = 0, bounds = [];
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
    let started = 0; bounds = [];
    camera.getWorldDirection(toCam); toCam.y = 0; toCam.normalize().negate(); side.crossVectors(UP, toCam).normalize();
    ghosts.forEach((g, k) => {
      const st = g.t[0], end = g.t[g.t.length - 1];
      if (t < st || t > end + 900) { gMesh.setMatrixAt(k, hide); eyes.setMatrixAt(2 * k, hide); eyes.setMatrixAt(2 * k + 1, hide); beams.setMatrixAt(k, hide); return; }
      started++;
      const p = t <= end ? posAt(g, t, 3600) : [g.la[g.la.length - 1], g.lo[g.lo.length - 1]];
      if (!p) { gMesh.setMatrixAt(k, hide); eyes.setMatrixAt(2 * k, hide); eyes.setMatrixAt(2 * k + 1, hide); beams.setMatrixAt(k, hide); return; }
      const ll = replay.toLL(p[0], p[1]), [x, z] = xy(ll[0], ll[1]);
      const fade = t <= end ? 1 : 1 - (t - end) / 900, sc = 0.55 + 0.45 * fade, y = 0.35 + Math.sin(ts / 420 + k) * 0.06 + (1 - fade) * 1.2;
      M.compose(P.set(x, y, z), Q.identity(), S.set(sc, sc, sc)); gMesh.setMatrixAt(k, M);
      bounds.push([k, x, y + 0.2 * sc, z]);
      for (const [e, s] of [[0, -1], [1, 1]]) {
        const ex = x + side.x * 0.06 * s * sc + toCam.x * 0.15 * sc, ez = z + side.z * 0.06 * s * sc + toCam.z * 0.15 * sc;
        M.compose(P.set(ex, y + 0.3 * sc, ez), Q.identity(), S.set(sc, sc * 1.4, sc)); eyes.setMatrixAt(2 * k + e, M);
      }
      const age = t - st;
      if (age < 600) { const [bx, bz] = xy(...replay.toLL(g.la[0], g.lo[0])); M.compose(P.set(bx, 0, bz), Q.identity(), S.set(1, 2.6 * (1 - age / 600), 1)); beams.setMatrixAt(k, M); }
      else beams.setMatrixAt(k, hide);
    });
    gMesh.instanceMatrix.needsUpdate = true; eyes.instanceMatrix.needsUpdate = true; beams.instanceMatrix.needsUpdate = true;
    controls.update();
    composer.render();
    onTick?.(t, on, started, buses.length);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // hover a tower for its stop, or a ghost for its bus
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(), proj = new THREE.Vector3();
  let downAt = null;
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    // ghosts first: nearest on screen within 18px
    let best = null, bd = 18 * 18;
    for (const [k, x, y, z] of bounds) {
      proj.set(x, y, z).project(camera);
      const dx = ((proj.x + 1) / 2) * r.width - (ev.clientX - r.left), dy = ((1 - proj.y) / 2) * r.height - (ev.clientY - r.top), d = dx * dx + dy * dy;
      if (d < bd && proj.z < 1) { bd = d; best = k; }
    }
    if (best != null) return { kind: "ghost", g: ghosts[best] };
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObject(towers)[0];
    return hit ? { kind: "stop", s: tstops[hit.instanceId] } : null;
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
    state,
    dispose() {
      cancelAnimationFrame(raf); removeEventListener("resize", onResize); controls.dispose();
      scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      composer.dispose?.(); renderer.dispose(); renderer.domElement.remove();
    },
    fly(lat, lon) { const [x, z] = xy(lat, lon); controls.target.set(x, 0, z); camera.position.set(x - 2.5, 3.2, z + 4); controls.autoRotate = false; },
  };
}
