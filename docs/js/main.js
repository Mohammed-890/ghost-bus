// Ghost Bus Detector: a live bus checker for Sheffield that also shows which buses never came.
//
// Data
//   board/<day>.json   today's timetable (from the site, once a day)
//   status.json        one status letter per departure + every departure with a bus on it (every ~2 min)
//   vehicles.json      every bus reporting now, matched to its departure where possible (every ~2 min)
//   summary.json, routes.json, routes/<id>.json, recent_ghosts.json, shapes.json, model.json, monitoring.json
// The two live files come from the `live` branch (updated every ~2 minutes); the copies on the site
// (updated every ~13 minutes) are the fallback.
import { createAssistant } from "./assistant.js?v=11";

const qs = new URLSearchParams(location.search);
const DATA = qs.get("data") || "data";
const LIVE = qs.get("live") ?? "https://raw.githubusercontent.com/Mohammed-890/ghost-bus/live/";
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const get = (p) => fetch(`${DATA}/${p}`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
// GitHub's raw file server caches a branch for 5 minutes, whatever the query string. So ask which commit
// is the latest on the live branch (a conditional request, which doesn't use up the API's hourly allowance
// when nothing changed), then fetch the files at that exact commit: a new address every update, never stale.
let liveBase = null;
async function resolveLive() {
  if (!LIVE) return null;
  const m = LIVE.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//);
  if (!m) return LIVE;
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/commits/${m[3]}`, { headers: { Accept: "application/vnd.github.sha" }, cache: "no-cache" });
    if (r.ok) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${(await r.text()).trim()}/`;
  } catch { /* offline or rate-limited: fall back to the branch address */ }
  return LIVE;
}
const getLive = (p) => (liveBase ? fetch(`${liveBase}${p}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null));
const num = (x) => (x ?? 0).toLocaleString("en-GB");
const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? "–" : `${(x * 100).toFixed(d)}%`);
const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "route";
const hhmm = (secs) => { const m = Math.floor((((secs % 86400) + 86400) % 86400) / 60); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const BAY = /^(.*)\/([A-Z]{1,3}\d{1,2}[A-Z]?)$/;
const shortStop = (n) => { const m = (n || "").match(BAY); return m ? m[1] : n || ""; };
const mode = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0]; };
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- state
let B = null, S = null, V = null, R = [], RI = {}, SUM = null;
let LIVEBY = new Map();             // departure index -> {delay, pos, lat, lon, age, how}
let index = [], byStopName = new Map();

const UK = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function ukParts(d = new Date()) { return Object.fromEntries(UK.formatToParts(d).map((p) => [p.type, p.value])); }
function nowSecs() {
  const p = ukParts();
  const today = `${p.year}-${p.month}-${p.day}`, secs = +p.hour * 3600 + +p.minute * 60 + +p.second;
  return !B || today === B.day ? secs : today > B.day ? secs + 86400 : secs - 86400;
}
const atSecs = (iso) => { const p = ukParts(new Date(iso)); return +p.hour * 3600 + +p.minute * 60; };

// ---------------------------------------------------------------- derived facts about a departure
const trip = (i) => B.trips[i];
const routeOf = (i) => B.routes[B.trips[i][0]];
const headsign = (i) => { const t = B.trips[i]; return shortStop(t[7] || t[5]); };
const calls = (i) => { const s = B.trips[i][6], out = []; for (let k = 0; k < s.length; k += 2) out.push({ stop: s[k], secs: B.trips[i][2] + s[k + 1] * 60, k: k / 2 }); return out; };
const live = (i) => LIVEBY.get(i);
const delayClass = (d) => (d == null ? "unk" : d <= -2 ? "early" : d <= 2 ? "ontime" : d < 10 ? "late" : "vlate");
const delayText = (d) => (d == null ? "" : d === 0 ? "on time" : d > 0 ? `${d} min late` : `${-d} min early`);
function expected(i, k, secs) {            // expected time at the k-th call, or null if the bus has passed it
  const L = live(i);
  if (!L) return { secs, live: false, passed: false };
  if (k <= Math.floor(L.pos)) return { secs: secs + L.delay * 60, live: true, passed: true };
  return { secs: secs + Math.max(L.delay, -1) * 60, live: true, passed: false };
}
function whereIs(i) {
  const L = live(i); if (!L) return "";
  const c = calls(i), k = Math.min(c.length - 1, Math.max(0, Math.round(L.pos)));
  return c.length ? `near ${shortStop(B.stops[c[k].stop][0])}` : "";
}
const STATUS = {
  O: ["o", "On the road"], P: ["p", "Due"], S: ["s", "Scheduled"], R: ["r", "Ran"], G: ["g", "Never came"], N: ["n", "No live data"],
};
const st = (i) => S?.status?.[i] || "N";
const reliab = (i) => { const r = routeOf(i); const x = RI[slug(`${r[0]}-${r[1]}`)]; return x && x.judged ? 1 - (x.rate || 0) : null; };

// ---------------------------------------------------------------- search index
function buildIndex() {
  byStopName = new Map();
  B.stops.forEach(([name], i) => { if (!byStopName.has(name)) byStopName.set(name, []); byStopName.get(name).push(i); });
  const groups = new Map();
  for (const [name, ids] of byStopName) { const m = name.match(BAY); if (m) { if (!groups.has(m[1])) groups.set(m[1], []); groups.get(m[1]).push(...ids); } }
  index = [];
  for (const [base, ids] of groups) if (ids.length > 1) index.push({ kind: "stop", key: `${base} (all stands)`, label: base, sub: `${ids.length} stands`, stops: ids });
  for (const [name, ids] of byStopName) index.push({ kind: "stop", key: name, label: name, sub: "Bus stop", stops: ids });
  B.routes.forEach(([route, op], ri) => index.push({ kind: "route", key: slug(`${route}-${op}`), label: `Route ${route}`, sub: op, ri, num: route.toLowerCase() }));
}
const findItem = (kind, key) => index.find((x) => x.kind === kind && x.key === key);
function search(q) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const words = q.split(/\s+/);
  const scored = [];
  for (const it of index) {
    let s = -1;
    if (it.kind === "route") { if (it.num === q || `route ${it.num}` === q) s = 100; else if (it.num.startsWith(q)) s = 75; }
    else {
      const l = it.label.toLowerCase();
      if (l === q) s = 90; else if (l.startsWith(q)) s = 70; else if (words.every((w) => l.includes(w))) s = 45;
      if (s >= 0 && it.sub.endsWith("stands")) s += 6;
    }
    if (s >= 0) scored.push([s, it]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].label.localeCompare(b[1].label, "en", { numeric: true })).slice(0, 9).map((x) => x[1]);
}

// ---------------------------------------------------------------- favourites & recents
const favs = () => store.get("gb:favs", []);
const isFav = (kind, key) => favs().some((f) => f.kind === kind && f.key === key);
function toggleFav(kind, key, label) {
  const f = favs(); const i = f.findIndex((x) => x.kind === kind && x.key === key);
  if (i >= 0) f.splice(i, 1); else f.unshift({ kind, key, label });
  store.set("gb:favs", f.slice(0, 12));
}
function remember(kind, key, label) {
  const r = store.get("gb:recent", []).filter((x) => !(x.kind === kind && x.key === key));
  r.unshift({ kind, key, label }); store.set("gb:recent", r.slice(0, 6));
}
const href = (kind, key) => `#/${kind}/${encodeURIComponent(key)}`;

// ---------------------------------------------------------------- map
let map = null, vehLayer = null, ctxLayer = null, darkMap = false;
function initMap() {
  if (!window.L) { $("#map").replaceChildren(el("p", { class: "map-off" }, "The map couldn’t load. Everything else still works.")); return; }
  darkMap = matchMedia("(prefers-color-scheme: dark)").matches;
  map = L.map("map", { zoomControl: false, zoomSnap: 0.25, preferCanvas: false }).setView([53.381, -1.47], 12);
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19, className: darkMap ? "tiles-dark" : "" }).addTo(map);
  ctxLayer = L.layerGroup().addTo(map);
  vehLayer = L.layerGroup().addTo(map);
}
function busIcon(route, bearing, cls, focus) {
  const arrow = bearing == null ? "" : `<i class="arr" style="transform:rotate(${bearing}deg)"></i>`;
  return L.divIcon({ className: "", iconSize: null, html: `<span class="bus ${cls}${focus ? " focus" : ""}">${arrow}<b>${route || "?"}</b></span>` });
}
function drawVehicles(focus) {          // focus: set of departure indices to highlight (others fade)
  if (!map || !V) return;
  vehLayer.clearLayers();
  for (const v of V.v) {
    const [lat, lon, bearing, route, i, delay, age] = v;
    const on = !focus || (i >= 0 && focus.has(i));
    if (focus && !on && focus.size) continue;
    const cls = i >= 0 ? delayClass(delay) : "unk";
    const m = L.marker([lat, lon], { icon: busIcon(route, bearing, cls, focus && on), zIndexOffset: on && focus ? 1000 : 0, keyboard: false });
    const what = i >= 0 ? `Route ${route} to ${headsign(i)} · ${delayText(delay)}` : `Route ${route || "?"} · not matched to a timetabled trip`;
    m.bindTooltip(`${what} · seen ${Math.round(age / 60)} min ago`, { direction: "top", offset: [0, -14] });
    if (i >= 0) m.on("click", () => { location.hash = `#/trip/${i}`; });
    m.addTo(vehLayer);
  }
}
function fit(points, maxZoom = 15) {
  if (!map || !points.length) return;
  requestAnimationFrame(() => {
    map.invalidateSize();
    if (points.length === 1) map.setView(points[0], Math.min(16, maxZoom)); else map.fitBounds(points, { padding: [40, 40], maxZoom });
  });
}
const ink = () => getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() || "#5B3FC4";

// ---------------------------------------------------------------- shared pieces
function badge(i) { const r = routeOf(i); return el("span", { class: "rt", title: r[1] }, r[0]); }
function pill(c) { const [cls, word] = STATUS[c] || STATUS.N; return el("span", { class: `pill ${cls}` }, word); }
function favButton(kind, key, label) {
  const b = el("button", { type: "button", class: "icon-btn", "aria-pressed": String(isFav(kind, key)) }, isFav(kind, key) ? "★ Saved" : "☆ Save");
  b.addEventListener("click", () => { toggleFav(kind, key, label); b.setAttribute("aria-pressed", String(isFav(kind, key))); b.textContent = isFav(kind, key) ? "★ Saved" : "☆ Save"; });
  return b;
}
function shareButton() {
  const b = el("button", { type: "button", class: "icon-btn" }, "Copy link");
  b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(location.href); b.textContent = "Link copied"; } catch { b.textContent = location.href; } setTimeout(() => (b.textContent = "Copy link"), 2500); });
  return b;
}
function tabs(items, active, onPick) {
  return el("div", { class: "seg", role: "tablist" }, items.map(([k, label]) =>
    el("button", { type: "button", role: "tab", "aria-selected": String(k === active), class: k === active ? "on" : "", onclick: () => onPick(k) }, label)));
}
function section(title, ...kids) { return el("section", { class: "sec" }, title ? el("h3", {}, title) : null, ...kids); }
function stat(value, label, cls) { return el("div", { class: `stat ${cls || ""}` }, el("b", {}, value), el("span", {}, label)); }

// ---------------------------------------------------------------- will it come? (warn before people wait)
// The big complaint about bus apps: "live" times that are really the timetable, and buses that vanish or
// never arrive with no warning. So every upcoming departure gets checked for signs it won't turn up.
let riskCache = { at: null };
function riskFacts() {
  if (riskCache.at === S.at && riskCache.day === B.day) return riskCache;
  const now = nowSecs(), ghosts2h = new Map(), reporting = new Set();
  B.trips.forEach((t, i) => { if (st(i) === "G" && t[3] >= now - 7200) ghosts2h.set(t[0], (ghosts2h.get(t[0]) || 0) + 1); });
  for (const [i] of S.live || []) reporting.add(routeOf(i)[1]);
  riskCache = { at: S.at, day: B.day, ghosts2h, reporting };
  return riskCache;
}
function riskOf(i) {
  const c = st(i);
  if (c !== "S" && c !== "P") return null;
  const t = trip(i), now = nowSecs(), r = routeOf(i), h = RI[slug(`${r[0]}-${r[1]}`)], f = riskFacts();
  const why = []; let score = 0;
  const late = Math.round((now - t[2]) / 60);
  if (c === "P" && late >= 8 && f.reporting.has(r[1])) { score += 3; why.push(`no bus has started it: it was due to leave ${shortStop(t[4])} ${late} min ago, and ${r[1]}’s other buses are being tracked`); }
  const g = f.ghosts2h.get(t[0]) || 0;
  if (g >= 2) { score += 2; why.push(`${g} buses on route ${r[0]} didn’t turn up in the last 2 hours`); }
  else if (g === 1) { score += 1; why.push(`a bus on route ${r[0]} didn’t turn up in the last 2 hours`); }
  if (h && h.judged >= 30 && h.rate >= 0.08) { score += h.rate >= 0.15 ? 2 : 1; why.push(`route ${r[0]} missed ${pct(h.rate, 0)} of its buses over the days checked`); }
  return score >= 3 ? { level: "high", why } : score >= 2 ? { level: "medium", why } : null;
}
// the next bus that would do instead: same route from the same stop (any stand), or any bus to the same place
function backupFor(i, stopIdx, afterSecs) {
  const base = shortStop(B.stops[stopIdx][0]), ri = trip(i)[0], dest = shortStop(trip(i)[5]);
  let same = null, other = null;
  B.trips.forEach((t, j) => {
    if (j === i || st(j) === "G" || st(j) === "R") return;
    const s0 = t[6];
    for (let k = 0; k < s0.length - 2; k += 2) {
      if (shortStop(B.stops[s0[k]][0]) !== base) continue;
      const secs = t[2] + s0[k + 1] * 60, ex = expected(j, k / 2, secs);
      if (ex.passed || ex.secs <= afterSecs) break;
      const cand = { j, secs: ex.secs, k: k / 2, raw: secs };
      if (t[0] === ri) { if (!same || cand.secs < same.secs) same = cand; }
      else if (shortStop(t[5]) === dest && (!other || cand.secs < other.secs)) other = cand;
      break;
    }
  });
  return same || other;
}
const ageText = (L) => { const m = Math.round(((L?.age || 0) + Math.max(0, (Date.now() - new Date(S.at).getTime()) / 1000)) / 60); return m <= 1 ? "just now" : `${m} min ago`; };

// one departure row, used by stops, routes and lists
function depRow(i, secs, k, now, extra) {
  const c = st(i), L = live(i), ex = expected(i, k, secs);
  const mins = Math.round((ex.secs - now) / 60);
  let big, small;
  if (c === "G") { big = hhmm(secs); small = "never came"; }
  else if (ex.passed) { big = hhmm(ex.secs); small = "departed"; }
  else if (mins <= 0 && (c === "O" || c === "P" || c === "S")) { big = "Due"; small = hhmm(ex.secs); }
  else if (mins < 60 && c !== "R" && c !== "N") { big = `${mins} min`; small = hhmm(ex.secs); }
  else { big = hhmm(secs); small = c === "R" ? "ran" : ""; }
  // under the destination: where the bus is and how late, for buses on the road; otherwise operator / stand
  const sub = c === "O" ? `${delayText(L?.delay)}${ex.live && L.delay ? ` (timetabled ${hhmm(secs)})` : ""} · ${whereIs(i)}` : extra || routeOf(i)[1];
  // say plainly where each time comes from: a bus's GPS, or only the timetable
  const risk = ex.passed ? null : riskOf(i);
  const note = risk ? (risk.level === "high" ? "⚠ may not come" : "⚠ unreliable lately")
    : c === "O" ? `GPS · seen ${ageText(L)}`
    : c === "S" ? `timetable${reliab(i) != null ? ` · runs ${Math.round(reliab(i) * 100)}%` : ""}`
    : c === "P" ? "timetable · no bus seen yet" : c === "R" ? "a bus was seen" : c === "G" ? "no bus seen" : c === "N" ? "not reporting" : "";
  const label = `${routeOf(i)[0]} to ${headsign(i)}, ${big}${small ? ` (${small})` : ""}. ${STATUS[c][1]}. ${note}`;
  return el("a", { class: `dep ${STATUS[c][0]}${ex.passed || (secs < now - 300 && c !== "O") ? " past" : ""}${risk ? ` risk-${risk.level}` : ""}`, href: `#/trip/${i}`, "aria-label": label, title: risk ? risk.why.join("; ") : null },
    el("span", { class: "when" }, el("b", { class: c === "O" ? `live ${delayClass(L?.delay)}` : "" }, big), el("small", {}, small)),
    badge(i),
    el("span", { class: "dest" }, el("b", {}, headsign(i)), el("small", { title: sub }, sub)),
    el("span", { class: "state" }, pill(c), el("small", {}, note)));
}

// ---------------------------------------------------------------- problems right now
// A route has a problem if buses have recently not turned up, or the buses on it are badly late.
function routeAlerts() {
  const now = nowSecs(), out = new Map();
  B.trips.forEach((t, i) => {
    const c = st(i), ri = t[0];
    if (!out.has(ri)) out.set(ri, { ri, ghosts2h: 0, ghostsToday: 0, judged: 0, late: 0, live: 0, maxLate: 0 });
    const a = out.get(ri);
    if (c === "G") { a.ghostsToday++; a.judged++; if (t[3] >= now - 7200) a.ghosts2h++; }
    else if (c === "R") a.judged++;
    const L0 = live(i);
    if (L0) { a.live++; if (L0.delay >= 10) a.late++; a.maxLate = Math.max(a.maxLate, L0.delay); }
  });
  return [...out.values()].map((a) => {
    const why = [];
    if (a.ghosts2h >= 2) why.push(`${a.ghosts2h} buses didn’t turn up in the last 2 hours`);
    else if (a.ghostsToday >= 3 && a.ghostsToday / Math.max(1, a.judged) >= 0.15) why.push(`${a.ghostsToday} of ${a.judged} buses today never came`);
    if (a.late >= 2 || (a.live && a.late === a.live && a.maxLate >= 15)) why.push(`${a.late} bus${a.late === 1 ? "" : "es"} running 10+ min late`);
    return { ...a, why };
  }).filter((a) => a.why.length).sort((x, y) => y.ghosts2h - x.ghosts2h || y.late - x.late || y.ghostsToday - x.ghostsToday);
}
// Buses on the same route and direction that have caught each other up: the gap behind them will be long.
function bunching(mine) {
  const on = mine.filter(([, i]) => live(i)).map(([t, i]) => ({ i, t, L: live(i) })), pairs = [];
  for (let a = 0; a < on.length; a++) for (let b = a + 1; b < on.length; b++) {
    const x = on[a], y = on[b];
    const kx = 111320 * Math.cos((x.L.lat * Math.PI) / 180);
    const d = Math.hypot((x.L.lon - y.L.lon) * kx, (x.L.lat - y.L.lat) * 110540);
    if (d < 450 && Math.abs(x.t[2] - y.t[2]) >= 8 * 60) pairs.push({ a: x, b: y, d });
  }
  return pairs;
}
function alertBox(a) {
  return el("div", { class: "alert", role: "status" }, el("b", {}, `Route ${B.routes[a.ri][0]}: problems right now`), el("span", {}, `${a.why.join(" and ")}.`));
}

// ---------------------------------------------------------------- reminders: tell me before my bus gets here
const reminders = [];
function addReminder(i, k, secs, stopName) {
  reminders.push({ i, k, secs, stopName, done: false });
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  toast(`I’ll tell you when the ${routeOf(i)[0]} is 5 minutes from ${shortStop(stopName)}. Keep this page open.`);
  checkReminders();
}
function checkReminders() {
  if (!B) return;
  const now = nowSecs();
  for (const r of reminders) {
    if (r.done) continue;
    const ex = expected(r.i, r.k, r.secs), mins = Math.round((ex.secs - now) / 60);
    if (ex.passed || mins <= 5) {
      r.done = true;
      const msg = ex.passed ? `The ${routeOf(r.i)[0]} has already passed ${shortStop(r.stopName)}.` : `The ${routeOf(r.i)[0]} to ${headsign(r.i)} is ${mins <= 0 ? "due now" : `${mins} min away`} at ${shortStop(r.stopName)}.`;
      toast(msg, true);
      try { if ("Notification" in window && Notification.permission === "granted") new Notification("Your bus", { body: msg }); } catch { /* not supported */ }
    }
  }
}
function toast(msg, loud) {
  const t = el("div", { class: `toast${loud ? " loud" : ""}`, role: loud ? "alert" : "status" }, msg, el("button", { type: "button", "aria-label": "Dismiss", onclick: () => t.remove() }, "×"));
  $("#toasts").append(t);
  setTimeout(() => t.remove(), loud ? 30000 : 6000);
}

const VIEWS = {};

// ---------------------------------------------------------------- home & work, read aloud
const places = () => store.get("gb:places", {});
function placeButton(key, label) {
  const p = places(), now0 = p.home?.key === key ? "home" : p.work?.key === key ? "work" : null;
  const b = el("select", { class: "icon-btn place", "aria-label": "Save this stop as home or work" },
    el("option", { value: "" }, now0 ? `★ Your ${now0}` : "Set as home/work"), el("option", { value: "home" }, "Set as home"), el("option", { value: "work" }, "Set as work"),
    now0 ? el("option", { value: "clear" }, `Remove as ${now0}`) : null);
  b.addEventListener("change", () => {
    const q = places();
    if (b.value === "home" || b.value === "work") { q[b.value] = { key, label }; toast(`${shortStop(label)} saved as your ${b.value}.`); }
    else if (b.value === "clear" && now0) delete q[now0];
    store.set("gb:places", q); render();
  });
  return b;
}
function speakButton(text) {
  if (!("speechSynthesis" in window)) return null;
  return el("button", { type: "button", class: "icon-btn", onclick: () => { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text()); u.lang = "en-GB"; speechSynthesis.speak(u); } }, "🔊 Read aloud");
}
function spokenStop(it, up) {
  const now = nowSecs();
  const parts = up.slice(0, 4).map((d) => {
    const ex = expected(d.i, d.k, d.secs), m = Math.round((ex.secs - now) / 60), L0 = live(d.i), rk = riskOf(d.i);
    return `Route ${routeOf(d.i)[0]} to ${headsign(d.i).replace(/\//g, " ")}, ${m <= 0 ? "due now" : `in ${m} minutes`}${L0 ? `, tracked by GPS, ${delayText(L0.delay)}` : ", timetable only"}${rk?.level === "high" ? ". Warning: it may not come" : ""}.`;
  });
  return parts.length ? `Next buses from ${it.label}. ${parts.join(" ")}` : `No more buses from ${it.label} today.`;
}

// ---------------------------------------------------------------- journey planner
VIEWS.plan = (fromKey, toKey) => {
  const fromIt = fromKey ? findItem("stop", fromKey) : null, toIt = toKey ? findItem("stop", toKey) : null;
  const field = (id, label, it, other, which) => {
    const input = el("input", { id, type: "search", autocomplete: "off", placeholder: label, value: it ? it.label : "", "aria-label": label });
    const list = el("ul", { class: "q-list", role: "listbox", hidden: true });
    input.addEventListener("input", () => {
      const hits = search(input.value).filter((x) => x.kind === "stop").slice(0, 7);
      list.replaceChildren(...hits.map((h) => { const li = el("li", { role: "option" }, el("span", { class: "tag" }, "Stop"), el("b", {}, h.label), el("small", {}, h.sub));
        li.addEventListener("mousedown", (e) => { e.preventDefault(); location.hash = which === "from" ? `#/plan/${encodeURIComponent(h.key)}/${encodeURIComponent(other || "")}` : `#/plan/${encodeURIComponent(other || "")}/${encodeURIComponent(h.key)}`; });
        return li; }));
      list.hidden = !hits.length;
    });
    input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
    return el("div", { class: "plan-field" }, el("label", { for: id }, which === "from" ? "From" : "To"), el("div", { class: "search-box" }, input, list));
  };
  const p = places();
  const quick = el("div", { class: "chips" },
    el("button", { type: "button", class: "chip quiet", onclick: () => locateFrom(toKey) }, "📍 From where I am"),
    p.home ? el("a", { class: "chip quiet", href: `#/plan/${encodeURIComponent(fromKey || "")}/${encodeURIComponent(p.home.key)}` }, "To home") : null,
    p.work ? el("a", { class: "chip quiet", href: `#/plan/${encodeURIComponent(fromKey || "")}/${encodeURIComponent(p.work.key)}` }, "To work") : null,
    fromKey || toKey ? el("a", { class: "chip quiet", href: `#/plan/${encodeURIComponent(toKey || "")}/${encodeURIComponent(fromKey || "")}` }, "⇅ Swap") : null);
  let result = null;
  if (fromIt && toIt) {
    if (fromIt.key === toIt.key) result = el("p", { class: "muted" }, "That’s the same stop.");
    else { const a = bot.plan(fromIt, toIt); result = el("div", { class: "plan-result" }, answerNodes(a)); }
  } else result = el("p", { class: "muted" }, "Pick where you’re starting and where you’re going. Plans use live bus positions, so late buses are taken into account, and skip any bus that looks like it won’t come. One change is allowed, including a short walk between nearby stops.");
  if (map && fromIt && toIt) { ctxLayer.clearLayers(); for (const s0 of [...fromIt.stops, ...toIt.stops]) { const q = B.stops[s0]; L.circleMarker([q[1], q[2]], { radius: 8, color: ink(), weight: 3, fillColor: "#fff", fillOpacity: 1 }).bindTooltip(q[0]).addTo(ctxLayer); }
    if (!current.fitted) { fit([...fromIt.stops, ...toIt.stops].map((s0) => [B.stops[s0][1], B.stops[s0][2]]), 14); current.fitted = true; } drawVehicles(new Set()); }
  return [el("div", { class: "head" }, el("p", { class: "kicker" }, "Journey planner"), el("h2", {}, "Plan a bus journey")),
    el("div", { class: "plan-form" }, field("plan-from", "Starting stop", fromIt, toKey, "from"), field("plan-to", "Destination stop", toIt, fromKey, "to")), quick, result];
};
function locateFrom(toKey) {
  if (!navigator.geolocation) return toast("Your browser can’t share your location.");
  toast("Finding your nearest stop…");
  navigator.geolocation.getCurrentPosition((pos) => {
    const near = nearestStops(pos.coords.latitude, pos.coords.longitude, 1)[0];
    if (near) location.hash = `#/plan/${encodeURIComponent(near.name)}/${encodeURIComponent(toKey || "")}`;
  }, () => toast("Location is blocked. Type your stop instead."), { timeout: 10000 });
}

// ---------------------------------------------------------------- views
let current = { kind: "home" };

VIEWS.home = () => {
  const c = S.counts || {}, now = nowSecs();
  const ran = (c.R || 0) + (c.O || 0), ghosts = c.G || 0;
  const late = S.live.filter((x) => x[1] >= 5).length;
  const f = S.feed || {};
  const header = el("div", { class: "intro" },
    el("h1", {}, "Is your bus actually coming?"),
    el("p", {}, "Live times for every bus in Sheffield, from every operator, checked against the buses’ own GPS. Each time says whether a real bus is tracked or it’s only the timetable, and you’re warned when a bus looks like it won’t come."));
  const stats = el("div", { class: "stats" },
    stat(num(f.buses ?? V?.v?.length), "buses on the road now", "live"),
    stat(f.buses ? pct(((f.reported || 0) + (f.inferred || 0)) / f.buses, 0) : "–", "matched to their timetabled trip"),
    stat(num(ran), "buses ran today"),
    stat(num(ghosts), `never came today${ran + ghosts ? ` (${pct(ghosts / (ran + ghosts))})` : ""}`, "ghost"),
    stat(num(late), "running 5+ min late now", "late"));
  const fv = favs();
  const fav = fv.length ? section("Saved", el("div", { class: "chips" }, fv.map((x) => el("a", { class: "chip", href: href(x.kind, x.key) }, x.kind === "route" ? x.label : shortStop(x.label))))) : null;
  const rec = store.get("gb:recent", []).filter((x) => !isFav(x.kind, x.key));
  const recent = rec.length ? section("Recently viewed", el("div", { class: "chips" }, rec.map((x) => el("a", { class: "chip quiet", href: href(x.kind, x.key) }, x.kind === "route" ? x.label : shortStop(x.label))))) : null;
  const picks = ["Sheffield Interchange (all stands)", "Meadowhall Interchange (all stands)", "Arundel Gate (all stands)"].map((k) => findItem("stop", k)).filter(Boolean);
  const popular = section("Popular stops", el("div", { class: "chips" }, picks.map((x) => el("a", { class: "chip quiet", href: href("stop", x.key) }, x.label))));
  // ghost buses in the last 90 minutes
  const justGhosts = B.trips.map((t, i) => [t, i]).filter(([t, i]) => st(i) === "G" && t[3] <= now && t[3] >= now - 5400).sort((a, b) => b[0][3] - a[0][3]).slice(0, 6);
  const ghostSec = section("Never came, last 90 minutes", justGhosts.length
    ? el("div", { class: "list" }, justGhosts.map(([t, i]) => depRow(i, t[2], 0, now, `from ${shortStop(t[4])}`)))
    : el("p", { class: "muted" }, "None in the last 90 minutes."));
  const worst = [...S.live].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const lateSec = section("Most delayed right now", worst.length && worst[0][1] > 0
    ? el("div", { class: "list" }, worst.map(([i]) => { const k = Math.min(calls(i).length - 1, Math.max(0, Math.ceil(live(i).pos))); const cl = calls(i)[k]; return depRow(i, cl ? cl.secs : trip(i)[2], k, now, whereIs(i)); }))
    : el("p", { class: "muted" }, "Nothing is running late right now."));
  ctxLayer?.clearLayers(); drawVehicles(null);
  if (map && !current.fitted) { fit(V.v.map((v) => [v[0], v[1]]), 12.5); current.fitted = true; }
  const alerts = routeAlerts().slice(0, 6);
  const alertSec = section("Problems right now", alerts.length
    ? el("div", { class: "alerts" }, alerts.map((a) => el("a", { class: "alert-row", href: href("route", slug(`${B.routes[a.ri][0]}-${B.routes[a.ri][1]}`)) },
        el("span", { class: "rt" }, B.routes[a.ri][0]), el("span", {}, el("b", {}, B.routes[a.ri][1]), el("small", {}, `${a.why.join(" · ")}`)))))
    : el("p", { class: "muted" }, "No routes with problems right now."));
  const ask = el("button", { type: "button", class: "ask-card", onclick: () => openChat() },
    el("b", {}, "Not sure? Just ask."), el("span", {}, "“When’s the next 52 from Arundel Gate?” · “How do I get to Meadowhall?”"));
  const pl = places();
  const trips0 = el("div", { class: "chips" },
    el("a", { class: "chip", href: "#/plan" }, "Plan a journey"),
    pl.home ? el("a", { class: "chip quiet", href: `#/plan//${encodeURIComponent(pl.home.key)}` }, "🏠 Take me home") : null,
    pl.work ? el("a", { class: "chip quiet", href: `#/plan//${encodeURIComponent(pl.work.key)}` }, "💼 To work") : null,
    pl.home ? null : el("span", { class: "muted small" }, "Open your stop and choose “Set as home” for one-tap journeys."));
  return [header, ask, stats, section("Journeys", trips0), fav, recent, popular, alertSec, ghostSec, lateSec, legendNote()];
};

function legendNote() {
  return el("p", { class: "legend-note" },
    el("span", { class: "bus ontime mini" }, el("b", {}, "52")), " on time ",
    el("span", { class: "bus late mini" }, el("b", {}, "52")), " 3–9 min late ",
    el("span", { class: "bus vlate mini" }, el("b", {}, "52")), " 10+ late ",
    el("span", { class: "bus early mini" }, el("b", {}, "52")), " early ",
    el("span", { class: "bus unk mini" }, el("b", {}, "52")), " not matched to a trip");
}

VIEWS.stop = (key, sub) => {
  const it = findItem("stop", key);
  if (!it) return [el("p", {}, "That stop isn’t in today’s timetable.")];
  remember("stop", key, it.label);
  const now = nowSecs(), want = new Set(it.stops), all = [];
  B.trips.forEach((t, i) => { const s = t[6]; for (let k = 0; k < s.length - 2; k += 2) if (want.has(s[k])) { all.push({ i, secs: t[2] + s[k + 1] * 60, k: k / 2, stop: s[k] }); break; } });
  all.sort((a, b) => a.secs - b.secs);
  const routesHere = [...new Set(all.map((d) => routeOf(d.i)[0]))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const filter = current.filter && routesHere.includes(current.filter) ? current.filter : null;
  const rows = all.filter((d) => !filter || routeOf(d.i)[0] === filter);
  const tab = sub || "next";
  const up = rows.filter((d) => { const ex = expected(d.i, d.k, d.secs); return !ex.passed && ex.secs >= now - 120 && st(d.i) !== "G" && st(d.i) !== "R"; });
  const early = rows.filter((d) => !up.includes(d)).filter((d) => d.secs < now + 60).reverse();
  const multi = it.stops.length > 1;
  const extra = (d) => `${routeOf(d.i)[1]}${multi ? ` · stand ${B.stops[d.stop][0].split("/").pop()}` : ""}`;
  const ran = all.filter((d) => "RO".includes(st(d.i))).length, gh = all.filter((d) => st(d.i) === "G").length;
  const head = el("div", { class: "head" },
    el("p", { class: "kicker" }, multi ? `Bus station · ${it.stops.length} stands` : "Bus stop"),
    el("h2", {}, it.label),
    el("p", { class: "muted" }, `${num(all.length)} buses timetabled here today · ${num(ran)} ran so far · `, el("span", { class: "g" }, `${num(gh)} never came`)),
    el("div", { class: "actions" }, favButton("stop", key, it.label), shareButton(), speakButton(() => spokenStop(it, up)),
      el("a", { class: "icon-btn", href: `#/plan/${encodeURIComponent(key)}` }, "Plan from here"),
      el("a", { class: "icon-btn", href: `#/plan//${encodeURIComponent(key)}` }, "Plan to here"), placeButton(key, it.label)));
  const chips = routesHere.length > 1 ? el("div", { class: "chips filter" }, el("button", { type: "button", class: `chip${filter ? " quiet" : ""}`, onclick: () => { current.filter = null; render(); } }, "All routes"),
    routesHere.map((r) => el("button", { type: "button", class: `chip${filter === r ? "" : " quiet"}`, onclick: () => { current.filter = filter === r ? null : r; render(); } }, r))) : null;
  const seg = tabs([["next", `Next buses (${up.length})`], ["earlier", `Earlier today (${early.length})`], ["stats", "Stop stats"]], tab, (k) => { location.hash = `${href("stop", key)}/${k}`; });
  let body;
  if (tab === "stats") body = stopStats(all);
  else {
    const list = tab === "earlier" ? early : up.slice(0, 80);
    body = list.length ? el("div", { class: "list" }, list.map((d) => depRow(d.i, d.secs, d.k, now, extra(d))))
      : el("p", { class: "muted" }, tab === "earlier" ? "Nothing earlier today." : "No more buses from here today.");
    if (tab !== "earlier") {
      const firstRisky = up.slice(0, 6).find((d) => riskOf(d.i)?.level === "high");
      if (firstRisky) {
        const bk = backupFor(firstRisky.i, firstRisky.stop, expected(firstRisky.i, firstRisky.k, firstRisky.secs).secs);
        body = el("div", {}, el("div", { class: "riskbox high" }, el("p", {}, el("b", {}, `The ${hhmm(firstRisky.secs)} ${routeOf(firstRisky.i)[0]} may not come. `),
          riskOf(firstRisky.i).why[0], ".", bk ? el("span", {}, " Backup: ", el("a", { href: `#/trip/${bk.j}` }, `${routeOf(bk.j)[0]} at ${hhmm(bk.secs)}`), ".") : "")), body);
      }
    }
  }
  // map: the stop and the buses on their way to it
  const coming = new Set(up.slice(0, 30).map((d) => d.i).filter((i) => live(i)));
  if (map) {
    ctxLayer.clearLayers();
    for (const s of it.stops) { const p = B.stops[s]; L.circleMarker([p[1], p[2]], { radius: 9, color: ink(), weight: 3, fillColor: "#fff", fillOpacity: 1 }).bindTooltip(p[0]).addTo(ctxLayer); }
    drawVehicles(coming);
    if (current.key !== key || !current.fitted) {
      const pts = it.stops.map((s) => [B.stops[s][1], B.stops[s][2]]);
      for (const i of coming) { const L0 = live(i); if (L0) pts.push([L0.lat, L0.lon]); }
      fit(pts, 15); current.fitted = true;
    }
  }
  return [head, chips, seg, body, coming.size ? el("p", { class: "muted small" }, `Map: the stop and the ${coming.size} bus${coming.size === 1 ? "" : "es"} on the way that we can see live.`) : null];
};

function stopStats(all) {
  const by = new Map();
  for (const d of all) {
    const r = routeOf(d.i), k = `${r[0]}|${r[1]}`;
    if (!by.has(k)) by.set(k, { route: r[0], op: r[1], n: 0, ran: 0, g: 0, live: 0, nd: 0 });
    const x = by.get(k); x.n++; const c = st(d.i);
    if (c === "R") x.ran++; else if (c === "O") { x.ran++; x.live++; } else if (c === "G") x.g++; else if (c === "N") x.nd++;
  }
  const rows = [...by.values()].sort((a, b) => b.g - a.g || a.route.localeCompare(b.route, "en", { numeric: true }));
  return el("div", {}, el("table", { class: "tbl" },
    el("thead", {}, el("tr", {}, el("th", {}, "Route"), el("th", { class: "n" }, "Today"), el("th", { class: "n" }, "Ran"), el("th", { class: "n" }, "Never came"), el("th", { class: "n" }, "Usually runs"))),
    el("tbody", {}, rows.map((x) => { const h = RI[slug(`${x.route}-${x.op}`)]; return el("tr", {},
      el("td", {}, el("a", { href: href("route", slug(`${x.route}-${x.op}`)) }, x.route), el("small", { class: "muted" }, ` ${x.op}`)),
      el("td", { class: "n" }, num(x.n)), el("td", { class: "n" }, num(x.ran)), el("td", { class: `n${x.g ? " g" : ""}` }, num(x.g)),
      el("td", { class: "n" }, h && h.judged ? pct(1 - h.rate, 0) : "–")); }))),
    el("p", { class: "muted small" }, "“Usually runs” is the share of this route’s departures that ran over all the days checked so far."));
}

VIEWS.route = (key, sub) => {
  const it = findItem("route", key);
  if (!it) return [el("p", {}, "That route isn’t in today’s timetable.")];
  remember("route", key, it.label);
  const now = nowSecs();
  const trips = B.trips.map((t, i) => [t, i]).filter(([t]) => t[0] === it.ri);
  const dirs = [...new Set(trips.map(([t]) => t[1]))].sort();
  const label = Object.fromEntries(dirs.map((d) => [d, `To ${shortStop(mode(trips.filter(([t]) => t[1] === d).map(([t]) => t[7] || t[5]))) || "—"}`]));
  const dir = dirs.includes(sub) ? sub : dirs[0];
  const mine = trips.filter(([t]) => t[1] === dir).sort((a, b) => a[0][2] - b[0][2]);
  const ran = trips.filter(([, i]) => "RO".includes(st(i))).length, gh = trips.filter(([, i]) => st(i) === "G").length;
  const hist = RI[key];
  const head = el("div", { class: "head" },
    el("p", { class: "kicker" }, it.sub),
    el("h2", {}, it.label),
    el("p", { class: "muted" }, `${num(trips.length)} departures today · ${num(ran)} ran · `, el("span", { class: "g" }, `${num(gh)} never came`),
      hist && hist.judged ? ` · usually runs ${pct(1 - hist.rate, 0)} (${num(hist.judged)} checked)` : ""),
    el("div", { class: "actions" }, favButton("route", key, it.label), shareButton()));
  const seg = tabs([...dirs.map((d) => [d, label[d]]), ["history", "History"]], sub === "history" ? "history" : dir, (k) => { location.hash = `${href("route", key)}/${k}`; });
  if (sub === "history") { const box = el("div", {}, el("p", { class: "muted" }, "Loading…")); routeHistory(key, box); drawRouteMap(mine, new Set(), false); return [head, seg, box]; }
  const onRoad = mine.filter(([, i]) => live(i));
  const liveSec = section(`On the road now (${onRoad.length})`, onRoad.length
    ? el("div", { class: "list" }, onRoad.map(([t, i]) => { const k = Math.min(calls(i).length - 1, Math.max(0, Math.ceil(live(i).pos))); const cl = calls(i)[k]; return depRow(i, cl ? cl.secs : t[2], k, now, whereIs(i)); }))
    : el("p", { class: "muted" }, "No bus is running this direction right now."));
  const nextIdx = mine.findIndex(([t]) => t[2] >= now - 300);
  const list = el("div", { class: "list" }, mine.map(([t, i]) => depRow(i, t[2], 0, now, `from ${shortStop(t[4])}`)));
  // start the timetable at the next departure, scrolling only inside its own box
  if (nextIdx > 0) setTimeout(() => { const box = list.parentElement, row = list.children[Math.max(0, nextIdx - 1)]; if (box && row) box.scrollTop = row.offsetTop - list.offsetTop; }, 60);
  drawRouteMap(mine, new Set(onRoad.map(([, i]) => i)), current.key !== key || current.sub !== sub || !current.fitted);
  current.fitted = true;
  const al = routeAlerts().find((a) => a.ri === it.ri);
  const bun = bunching(mine);
  const bunSec = bun.length ? el("p", { class: "note" }, el("b", {}, "Buses bunched: "),
    bun.slice(0, 2).map((p) => `the ${hhmm(p.a.t[2])} and ${hhmm(p.b.t[2])} departures are only ${Math.round(p.d / 10) * 10} m apart ${whereIs(p.a.i)}`).join("; "),
    ". Expect a longer wait after them.") : null;
  return [head, al ? alertBox(al) : null, seg, liveSec, bunSec, section("Today’s timetable from the first stop", el("div", { class: "scroll" }, list))];
};

function drawRouteMap(mine, focus, refit) {
  if (!map) return;
  ctxLayer.clearLayers();
  const longest = mine.map(([, i]) => i).sort((a, b) => trip(b)[6].length - trip(a)[6].length)[0];
  const pts = longest != null ? calls(longest).map((c) => [B.stops[c.stop][1], B.stops[c.stop][2]]) : [];
  if (pts.length > 1) L.polyline(pts, { color: ink(), weight: 5, opacity: 0.75 }).addTo(ctxLayer);
  if (longest != null) for (const c of calls(longest)) L.circleMarker([B.stops[c.stop][1], B.stops[c.stop][2]], { radius: 3, color: ink(), weight: 1, fillColor: "#fff", fillOpacity: 1 }).bindTooltip(B.stops[c.stop][0]).addTo(ctxLayer);
  drawVehicles(focus);
  if (refit) fit(pts, 14);
}

async function routeHistory(key, box) {
  const r = await get(`routes/${key}.json`);
  if (!r) { box.replaceChildren(el("p", { class: "muted" }, "No history for this route yet.")); return; }
  const deps = r.departures, judged = deps.reduce((a, d) => a + d.days, 0), ghosts = deps.reduce((a, d) => a + d.ghosts, 0);
  const hours = new Map(r.by_hour.map(([h, n, g]) => [h, n ? g / n : 0])), max = Math.max(0.05, ...hours.values());
  const chart = el("div", { class: "hours", role: "img", "aria-label": "Share of departures that never ran, by hour" },
    Array.from({ length: 24 }, (_, h) => { const d = el("div", { title: `${String(h).padStart(2, "0")}:00 · ${pct(hours.get(h) || 0)} never ran` }); d.style.height = `${((hours.get(h) || 0) / max) * 100}%`; return d; }));
  const dirs = [...new Set(deps.map((d) => String(d.direction_id)))];
  box.replaceChildren(
    el("div", { class: "stats" }, stat(pct(judged ? ghosts / judged : 0), "never ran", "ghost"), stat(num(judged), "departures checked"), stat(num(ghosts), "ghost buses")),
    section("When it happens", chart, el("div", { class: "hours-axis" }, ["00", "06", "12", "18", "23"].map((h) => el("span", {}, `${h}:00`)))),
    ...dirs.map((dir) => { const ds = deps.filter((d) => String(d.direction_id) === dir);
      return section(`Towards ${shortStop(mode(ds.map((d) => d.to_stop))) || "—"}`, el("div", { class: "grid" }, ds.map((d) => {
        const rate = d.days ? d.ghosts / d.days : 0;
        const tip = `${d.time} from ${d.from_stop}: ran ${d.days - d.ghosts} of ${d.days} days${d.p_runs_next != null ? `; model: ${Math.round(d.p_runs_next * 100)}% chance it runs next time` : ""}`;
        return el("span", { class: `cell${rate >= 0.3 ? " bad" : rate >= 0.1 ? " warn" : ""}`, title: tip, "aria-label": tip }, d.time,
          el("small", {}, d.p_runs_next != null ? `${Math.round(d.p_runs_next * 100)}%` : `${d.days - d.ghosts}/${d.days}`)); })));
    }),
    el("p", { class: "muted small" }, "Each box is a timetabled departure. The percentage is the model’s chance that it runs next time; amber misses 1 in 10 or more, purple 3 in 10 or more."));
}

VIEWS.trip = (key) => {
  const i = Number(key);
  if (!B.trips[i]) return [el("p", {}, "That departure isn’t in today’s timetable.")];
  const t = trip(i), r = routeOf(i), c = st(i), L0 = live(i), now = nowSecs(), cs = calls(i);
  const rkey = slug(`${r[0]}-${r[1]}`);
  const big = c === "O" ? `${delayText(L0.delay)[0].toUpperCase()}${delayText(L0.delay).slice(1)}` : STATUS[c][1];
  const why = {
    O: `${L0?.how === "r" ? "The bus is reporting this trip" : "Matched to this trip from the bus’s route and its last few positions"}; last seen ${Math.round((L0?.age || 0) / 60)} min ago, ${whereIs(i)}.`,
    P: "It should be running, but no bus has been matched to it yet. Some operators only show up once the trip is over.",
    S: `Not due to leave until ${hhmm(t[2])}.`,
    R: "A bus was seen doing this trip.",
    G: "No bus was seen anywhere on this trip, while the live feed was answering and the operator was reporting its other buses.",
    N: "We can’t tell: the operator wasn’t reporting its buses, the feed had a gap, or too little of the trip is in Sheffield.",
  }[c];
  const head = el("div", { class: "head" },
    el("p", { class: "kicker" }, el("a", { href: href("route", rkey) }, `Route ${r[0]}`), ` · ${r[1]}`),
    el("h2", {}, `To ${headsign(i)}`),
    el("p", { class: "muted" }, `Leaves ${shortStop(t[4])} at ${hhmm(t[2])}, arrives ${shortStop(t[5])} at ${hhmm(t[3])}.`),
    el("div", { class: `verdict ${STATUS[c][0]} ${c === "O" ? delayClass(L0.delay) : ""}` }, el("b", {}, big), el("span", {}, why)));
  const pos = L0 ? L0.pos : null;
  const tl = el("ol", { class: "timeline" }, cs.map((x, k) => {
    const ex = expected(i, k, x.secs), passed = c === "R" || (pos != null && k <= Math.floor(pos)) || (c === "G");
    const here = pos != null && k === Math.floor(pos);
    return el("li", { class: `${passed ? "passed" : ""}${here ? " here" : ""}` },
      el("span", { class: "tt" }, hhmm(x.secs), ex.live && !ex.passed && L0.delay ? el("small", { class: delayClass(L0.delay) }, hhmm(ex.secs)) : null),
      el("span", { class: "dot", "aria-hidden": "true" }),
      el("a", { href: href("stop", B.stops[x.stop][0]) }, B.stops[x.stop][0]),
      here ? el("span", { class: "bus-here" }, "Bus is here") : null);
  }));
  const histBox = el("div", {}, el("p", { class: "muted" }, "Loading this departure’s history…"));
  get(`routes/${rkey}.json`).then((rr) => {
    const d = rr?.departures?.find((x) => String(x.direction_id) === t[1] && x.time === hhmm(t[2]) && x.from_stop === t[4]);
    histBox.replaceChildren(d
      ? el("div", { class: "stats" }, stat(`${d.days - d.ghosts}/${d.days}`, "days this exact bus ran"), stat(num(d.ghosts), "times it never came", d.ghosts ? "ghost" : ""),
        stat(d.p_runs_next != null ? pct(d.p_runs_next, 0) : "–", "model’s chance it runs next time"))
      : el("p", { class: "muted" }, "No history for this exact departure yet."));
  });
  if (map) {
    ctxLayer.clearLayers();
    const pts = cs.map((x) => [B.stops[x.stop][1], B.stops[x.stop][2]]);
    if (pts.length > 1) L.polyline(pts, { color: ink(), weight: 5, opacity: 0.8 }).addTo(ctxLayer);
    cs.forEach((x, k) => L.circleMarker(pts[k], { radius: k === 0 || k === cs.length - 1 ? 6 : 3.5, color: ink(), weight: 2, fillColor: pos != null && k <= pos ? ink() : "#fff", fillOpacity: 1 }).bindTooltip(`${hhmm(x.secs)} ${B.stops[x.stop][0]}`).addTo(ctxLayer));
    drawVehicles(new Set([i]));
    if (current.key !== key || !current.fitted) { fit(L0 ? [...pts, [L0.lat, L0.lon]] : pts, 15); current.fitted = true; }
  }
  let riskBox = null;
  const rk = riskOf(i);
  if (rk || c === "G" || c === "P") {
    const fromK = cs.findIndex((x) => x.secs >= now - 120);
    const at = cs[Math.max(0, fromK)] || cs[0];
    const bk = at ? backupFor(i, at.stop, Math.max(now, at.secs)) : null;
    const lines = [];
    if (rk) lines.push(el("p", {}, el("b", {}, rk.level === "high" ? "This bus may not come." : "This route has been unreliable lately."), ` ${rk.why.map((w) => w[0].toUpperCase() + w.slice(1)).join(". ")}.`));
    if (bk) lines.push(el("p", {}, "Backup: ", el("a", { href: `#/trip/${bk.j}` }, `the ${routeOf(bk.j)[0]} to ${headsign(bk.j)} from ${shortStop(B.stops[at.stop][0])} at ${hhmm(bk.secs)}`), ` (${Math.max(0, Math.round((bk.secs - now) / 60))} min).`));
    if (lines.length) riskBox = el("div", { class: `riskbox ${rk?.level || "info"}` }, lines);
  }
  let remind = null;
  const ahead = cs.map((x, k) => ({ ...x, k })).filter((x) => { const ex = expected(i, x.k, x.secs); return !ex.passed && ex.secs > now + 300 && c !== "G" && c !== "R"; });
  if (ahead.length) {
    const sel = el("select", { "aria-label": "Your stop" }, ahead.map((x) => el("option", { value: x.k }, `${hhmm(x.secs)} ${B.stops[x.stop][0]}`)));
    remind = section("Remind me", el("div", { class: "remind" }, sel, el("button", { type: "button", class: "icon-btn", onclick: () => {
      const x = ahead.find((y) => String(y.k) === sel.value); if (x) addReminder(i, x.k, x.secs, B.stops[x.stop][0]); } }, "Tell me 5 min before")),
      el("p", { class: "muted small" }, "Uses the live position of the bus, so it adjusts if the bus is running late."));
  }
  return [head, riskBox, remind, section("Stops and times", tl), section("This departure on other days", histBox)];
};

VIEWS.network = () => {
  const c = S.counts || {}, f = S.feed || {}, chk = f.check || {}, now = nowSecs();
  const age = Math.max(0, Math.round((Date.now() - new Date(S.at).getTime()) / 60000));
  const total = Object.values(c).reduce((a, b) => a + b, 0) || 1;
  const order = [["R", "Ran"], ["O", "On the road"], ["G", "Never came"], ["P", "Due"], ["N", "No live data"], ["S", "Scheduled"]];
  const bar = el("div", { class: "stack", role: "img", "aria-label": order.map(([k, w]) => `${w} ${c[k] || 0}`).join(", ") },
    order.map(([k]) => { const d = el("i", { class: STATUS[k][0], title: `${STATUS[k][1]}: ${num(c[k] || 0)}` }); d.style.flexGrow = c[k] || 0; return d; }));
  const legend = el("div", { class: "stack-key" }, order.map(([k, w]) => el("span", {}, el("i", { class: STATUS[k][0] }), `${w} ${num(c[k] || 0)}`)));
  // by operator
  const ops = new Map();
  B.trips.forEach((t, i) => { const op = B.routes[t[0]][1]; if (!ops.has(op)) ops.set(op, { n: 0, R: 0, O: 0, G: 0, N: 0, P: 0, S: 0 }); const x = ops.get(op); x.n++; x[st(i)]++; });
  const opRows = [...ops].sort((a, b) => b[1].n - a[1].n);
  const opTable = el("table", { class: "tbl" },
    el("thead", {}, el("tr", {}, el("th", {}, "Operator"), el("th", { class: "n" }, "Today"), el("th", { class: "n" }, "Ran"), el("th", { class: "n" }, "On road"), el("th", { class: "n" }, "Never came"), el("th", { class: "n" }, "Can’t check"))),
    el("tbody", {}, opRows.map(([op, x]) => el("tr", {}, el("td", {}, op), el("td", { class: "n" }, num(x.n)), el("td", { class: "n" }, num(x.R)), el("td", { class: "n" }, num(x.O)),
      el("td", { class: `n${x.G ? " g" : ""}` }, num(x.G)), el("td", { class: "n" }, x.N ? pct(x.N / x.n, 0) : "0%")))));
  // delays of buses on the road
  const bins = [[-99, -2, "early"], [-1, 2, "on time"], [3, 5, "3–5"], [6, 9, "6–9"], [10, 19, "10–19"], [20, 999, "20+"]];
  const dl = S.live.map((x) => x[1]);
  const counts = bins.map(([a, b]) => dl.filter((d) => d >= a && d <= b).length), mx = Math.max(1, ...counts);
  const hist = el("div", { class: "bars" }, bins.map(([, , lab], k) => el("div", { class: "barrow" }, el("span", {}, lab), el("i", { style: `width:${(counts[k] / mx) * 100}%`, class: ["early", "ontime", "late", "late", "vlate", "vlate"][k] }), el("b", {}, num(counts[k])))));
  // ghosts by hour today
  const byH = Array.from({ length: 24 }, () => [0, 0]);
  B.trips.forEach((t, i) => { const h = Math.floor((t[2] % 86400) / 3600), s0 = st(i); if (s0 === "R" || s0 === "O") byH[h][0]++; else if (s0 === "G") byH[h][1]++; });
  const hm = Math.max(1, ...byH.map(([a, b]) => a + b));
  const hours = el("div", { class: "hours dual", role: "img", "aria-label": "Departures that ran and never came, by hour today" },
    byH.map(([a, b], h) => el("div", { title: `${String(h).padStart(2, "0")}:00 · ran ${a} · never came ${b}` },
      el("i", { class: "g", style: `height:${(b / hm) * 100}%` }), el("i", { style: `height:${(a / hm) * 100}%` }))));
  const worst = new Map();
  B.trips.forEach((t, i) => { if (st(i) === "G") { const k = t[0]; worst.set(k, (worst.get(k) || 0) + 1); } });
  const worstRows = [...worst].sort((a, b) => b[1] - a[1]).slice(0, 8);
  ctxLayer?.clearLayers(); drawVehicles(null);
  if (map && !current.fitted) { fit(V.v.map((v) => [v[0], v[1]]), 12.5); current.fitted = true; }
  return [
    el("div", { class: "head" }, el("p", { class: "kicker" }, "Network"), el("h2", {}, "Sheffield’s buses today"),
      el("p", { class: "muted" }, `Live data from ${age <= 1 ? "just now" : `${age} min ago`} · timetable for ${dayName(B.day)}`)),
    section("The live feed", el("div", { class: "stats" },
      stat(num(f.buses), "buses reporting now", "live"),
      stat(num(f.reported), "report their own trip"),
      stat(num(f.inferred), "matched by route and position"),
      stat(chk.n ? pct(chk.right / chk.n, 0) : "–", `self-check: right${chk.n ? ` on ${chk.n} buses (${pct(chk.wrong / chk.n, 0)} wrong)` : ""}`)),
      el("p", { class: "muted small" }, "Self-check: every update, the trip of each bus that reports one is hidden and worked out again from its route and position alone. The share it gets right is a live measure of how good the matching is.")),
    section(`Every departure today (${num(total)})`, bar, legend),
    section("How late are the buses on the road?", hist),
    section("By hour: ran and never came", hours, el("div", { class: "hours-axis" }, ["00", "06", "12", "18", "23"].map((h) => el("span", {}, `${h}:00`)))),
    section("Most ghost buses today", worstRows.length ? el("div", { class: "chips" }, worstRows.map(([ri, n]) => el("a", { class: "chip quiet", href: href("route", slug(`${B.routes[ri][0]}-${B.routes[ri][1]}`)) }, `${B.routes[ri][0]} · ${n}`))) : el("p", { class: "muted" }, "None yet today.")),
    section("Average delay by route right now", delayByRoute()),
    section("By operator", el("div", { class: "scroll-x" }, opTable)),
  ];
};

function delayByRoute() {
  const by = new Map();
  for (const [i, d] of S.live.map((x) => [x[0], x[1]])) { const ri = trip(i)[0]; if (!by.has(ri)) by.set(ri, []); by.get(ri).push(d); }
  const rows = [...by].filter(([, ds]) => ds.length >= 2).map(([ri, ds]) => [ri, ds.reduce((a, b) => a + b, 0) / ds.length, ds.length]).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!rows.length) return el("p", { class: "muted" }, "Not enough buses on the road to compare routes.");
  const mx = Math.max(1, ...rows.map((r) => Math.abs(r[1])));
  return el("div", { class: "bars" }, rows.map(([ri, avg, n]) => el("a", { class: "barrow link", href: href("route", slug(`${B.routes[ri][0]}-${B.routes[ri][1]}`)) },
    el("span", {}, el("b", {}, B.routes[ri][0]), el("small", {}, ` ${n} buses`)), el("i", { class: delayClass(Math.round(avg)), style: `width:${(Math.abs(avg) / mx) * 100}%` }),
    el("b", {}, `${avg >= 0 ? "+" : "−"}${Math.abs(avg).toFixed(1)}`))));
}

VIEWS.reliability = () => {
  const box = el("div", {}, el("p", { class: "muted" }, "Loading…"));
  reliabilityInto(box);
  return [el("div", { class: "head" }, el("p", { class: "kicker" }, "Reliability"), el("h2", { id: "rel-h" }, "Which buses don’t turn up?"), el("p", { class: "muted", id: "rel-sub" })), box];
};

async function reliabilityInto(box) {
  const [recent, shapes] = await Promise.all([get("recent_ghosts.json"), get("shapes.json")]);
  const s = SUM;
  if (s && s.status === "ready") {
    const w = s.last7?.judged ? s.last7 : s, n = w.ghosts || 0;
    $("#rel-h").textContent = `${(s.days || 0) >= 7 ? "In the last 7 days" : `In ${s.days} days`}, ${num(n)} timetabled buses in Sheffield never turned up.`;
    $("#rel-sub").textContent = w.ghost_rate ? `About 1 in ${Math.round(1 / w.ghost_rate)} of the ${num(w.judged)} trips we could check.` : "";
  }
  const top = R.filter((r) => r.judged >= 50 && r.rate != null).sort((a, b) => b.rate - a.rate).slice(0, 12), mx = Math.max(0.01, ...top.map((r) => r.rate));
  const league = el("div", { class: "bars" }, top.map((r) => el("a", { class: "barrow link", href: href("route", r.id) },
    el("span", {}, el("b", {}, r.route), el("small", {}, ` ${r.operator}`)), el("i", { class: "g", style: `width:${(r.rate / mx) * 100}%` }), el("b", {}, pct(r.rate)))));
  const rec = (recent || []).slice(0, 12);
  const recentList = el("div", { class: "plain" }, rec.map((r) => el("p", {}, el("span", { class: "muted" }, `${dayName(r.date)} ${r.time} `), el("b", {}, r.route), ` ${r.from || ""} → ${r.to || ""}`)));
  const facts = s ? el("div", { class: "stats" }, stat(num(s.scheduled), "timetabled trips recorded"), stat(num(s.judged), "judged fairly"), stat(num(s.ghosts), "ghost buses", "ghost"),
    stat(pct(s.ghost_rate), "never ran"), stat(pct(s.unknown / Math.max(1, s.scheduled), 0), "not judged (no data)")) : null;
  box.replaceChildren(facts || "", section("Least reliable routes", el("p", { class: "muted small" }, "Share of judged departures that never ran; routes with fewer than 50 judged left out."), league),
    section("Recent ghost buses", recentList.childNodes.length ? recentList : el("p", { class: "muted" }, "None yet.")),
    el("p", { class: "muted small" }, "Map: every route, darker purple means more ghost buses. Tap a route for its full history."));
  if (map && shapes?.length) {
    ctxLayer.clearLayers(); vehLayer.clearLayers();
    const rate = new Map(R.map((r) => [r.id, r])), pts = [];
    for (const sh of shapes.map((x) => ({ x, r: rate.get(x.id) })).filter((y) => y.r).sort((a, b) => (a.r.rate || 0) - (b.r.rate || 0))) {
      const k = Math.min(1, (sh.r.rate || 0) / 0.15);
      L.polyline(sh.x.path, { color: k > 0.05 ? ink() : "#8A94A3", weight: 2 + k * 5, opacity: 0.25 + k * 0.75 })
        .bindTooltip(`${sh.r.route} · ${sh.r.operator}: ${pct(sh.r.rate)} never ran`).on("click", () => { location.hash = `${href("route", sh.r.id)}/history`; }).addTo(ctxLayer);
      pts.push(...sh.x.path);
    }
    fit(pts, 13);
  }
}

VIEWS.about = () => {
  const f = S.feed || {}, chk = f.check || {};
  const box = el("div", {});
  Promise.all([get("model.json"), get("monitoring.json")]).then(([m, mon]) => box.replaceChildren(modelBlock(m, mon)));
  ctxLayer?.clearLayers(); drawVehicles(null);
  const files = ["status.json", "vehicles.json", `board/${B.day}.json`, "summary.json", "routes.json", "recent_ghosts.json", "model.json", "monitoring.json"];
  return [
    el("div", { class: "head" }, el("p", { class: "kicker" }, "Under the hood"), el("h2", {}, "How it works")),
    section("1. Collect", el("p", {}, "Every 60 seconds, around the clock, the government’s Bus Open Data Service is asked where every bus in the Sheffield area is. Each answer is saved. The day’s timetable comes from the same service.")),
    section("2. Track live", el("p", {}, `Every two minutes, each bus is matched to the timetabled trip it’s running. ${num(f.reported)} buses right now report their trip themselves. The other ${num(f.inferred)} only report their route, so their last few positions are laid along every trip of that route that’s under way. The one where the bus moves forward and its lateness holds steady wins. That gives a delay and a position for every matched bus, which is where the arrival estimates come from.`),
      el("p", { class: "muted" }, chk.n ? `Self-check right now: hiding the trip of the ${chk.n} buses that report one, the matching finds ${pct(chk.right / chk.n, 0)} of them again and names the wrong trip for ${pct(chk.wrong / chk.n, 0)}.` : "")),
    section("3. Judge every departure", el("p", {}, "Once a departure’s time is over, it’s checked: a bus reported that exact trip, or a bus passed its stops in order and on time. One bus can’t run two trips at once. A departure only counts as a ghost bus if the feed was answering for its whole run and the operator was visibly reporting its other buses. Otherwise it’s “no live data”, never counted against anyone.")),
    section("4. Learn and predict", el("p", {}, "Each morning the full day is judged again, and a model learns which departures tend not to run, by route, time and recent history. A new model only replaces the live one if it does better on days it has never seen. The data is checked every day for drift."), box),
    section("5. Ask Ghost Bus", el("p", {}, "The assistant (bottom right) understands questions in plain English, typos included: when your bus is coming, where it is, whether it’s late, whether a bus turned up, how reliable a route is, and how to get from one stop to another, direct or with one change and a short walk. It runs entirely in your browser on the same live data as the map, so its answers are as fresh as the map and nothing you type leaves your device."),
      el("button", { type: "button", class: "icon-btn", onclick: () => openChat() }, "Ask a question")),
    section("Open data", el("p", {}, "Everything this page shows is plain JSON you can use:"), el("ul", { class: "files" }, files.map((x) => el("li", {}, el("a", { href: `${x.startsWith("status") || x.startsWith("vehicles") ? LIVE || `${DATA}/` : `${DATA}/`}${x}` }, x))))),
    el("p", { class: "muted small" }, "“Never came” means no bus was seen. Causes include cancellations, driver shortages and trackers that were switched off. Not affiliated with any bus operator or the Department for Transport. Contains public sector information licensed under the Open Government Licence v3.0. ",
      el("a", { href: "https://github.com/Mohammed-890/ghost-bus" }, "Code and method on GitHub"), "."),
  ];
};

function modelBlock(m, mon) {
  if (!m || m.status !== "ready") return el("p", { class: "muted" }, "The model is trained once there are at least 7 judged days.");
  const rows = [["Everyone runs (overall rate)", m.constant], ["This departure’s own history", m.history], ["Model", m.model]];
  const parts = [el("p", { class: "muted small" }, `Trained on ${dayName(m.train_days[0])}–${dayName(m.train_days[1])}, tested on days it never saw (${dayName(m.test_days[0])}–${dayName(m.test_days[1])}, ${num(m.n_test)} departures).`),
    el("div", { class: "scroll-x" }, el("table", { class: "tbl" }, el("thead", {}, el("tr", {}, el("th", {}, "Method"), el("th", { class: "n" }, "Ghosts in riskiest 10%"), el("th", { class: "n" }, "AUC"), el("th", { class: "n" }, "Brier"))),
      el("tbody", {}, rows.map(([n, x]) => el("tr", {}, el("td", {}, n), el("td", { class: "n" }, pct(x.ghosts_in_riskiest_10pct, 0)), el("td", { class: "n" }, x.roc_auc == null ? "–" : Number(x.roc_auc).toFixed(2)), el("td", { class: "n" }, x.brier == null ? "–" : Number(x.brier).toFixed(4)))))))];
  const last = mon?.last_decision;
  if (last) parts.push(el("p", { class: "muted small" }, `Latest daily check (${dayName(last.day)}): ${last.action === "keep" && last.triggers?.length ? "the data has shifted, so a new model will be trained and tested once there are enough new days to compare fairly" : last.action === "keep" ? "the live model is still accurate" : last.promoted ? "a retrained model did better and replaced the live one" : last.action === "skip" ? "still collecting data" : "a retrained model was tested but didn’t beat the live one"}.`));
  return el("div", {}, parts);
}

// ---------------------------------------------------------------- router
function parseHash() {
  const [, kind = "home", key = "", sub = ""] = (location.hash.replace(/^#\/?/, "#/").match(/^#\/([^/]*)\/?([^/]*)\/?([^/]*)/) || []);
  return { kind: kind || "home", key: decodeURIComponent(key), sub: decodeURIComponent(sub) };
}
function render(reset) {
  if (!B || !S) return;
  const h = parseHash();
  const same = h.kind === current.kind && h.key === current.key && h.sub === current.sub;
  if (!same) current = { ...h, fitted: false, filter: h.kind === current.kind && h.key === current.key ? current.filter : null };
  const fn = VIEWS[h.kind] || VIEWS.home;
  const panel = $("#view"), top = panel.scrollTop;
  panel.replaceChildren(...fn(h.key, h.sub).filter(Boolean));
  if (same && !reset) panel.scrollTop = top; else panel.scrollTop = 0;
  for (const a of document.querySelectorAll(".nav a")) a.setAttribute("aria-current", a.dataset.v === (["stop", "route", "trip"].includes(h.kind) ? "home" : h.kind) ? "page" : "false");
  document.title = `${h.kind === "home" ? "" : `${$("#view h2")?.textContent || ""} · `}Ghost Bus Detector – Sheffield`;
  if (!same) { $("#main").focus?.({ preventScroll: true }); if (innerWidth < 900 && h.kind !== "home") $("#view").scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" }); }
}

// ---------------------------------------------------------------- search box
function setupSearch() {
  const q = $("#q"), list = $("#q-list");
  let items = [], active = -1;
  const close = () => { list.hidden = true; q.setAttribute("aria-expanded", "false"); active = -1; };
  const choose = (it) => { close(); q.value = ""; q.blur(); location.hash = href(it.kind, it.key); };
  const paint = () => {
    list.replaceChildren(...(items.length ? items.map((it, i) => {
      const li = el("li", { role: "option", id: `q-${i}`, "aria-selected": String(i === active), class: i === active ? "on" : "" },
        el("span", { class: `tag ${it.kind}` }, it.kind === "route" ? "Route" : "Stop"), el("b", {}, it.label), el("small", {}, it.sub));
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(it); });
      return li;
    }) : [el("li", { class: "none" }, "No stop or route with that name")]));
    list.hidden = false; q.setAttribute("aria-expanded", "true"); q.setAttribute("aria-activedescendant", active >= 0 ? `q-${active}` : "");
  };
  q.addEventListener("input", () => { items = search(q.value); active = items.length ? 0 : -1; q.value.trim() ? paint() : close(); });
  q.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); paint(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); paint(); e.preventDefault(); }
    else if (e.key === "Enter" && items[active]) { choose(items[active]); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  q.addEventListener("blur", () => setTimeout(close, 120));
  document.addEventListener("keydown", (e) => { if (e.key === "/" && document.activeElement !== q && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); } });
  $("#near").addEventListener("click", nearMe);
}

function nearestStops(la, lo, n = 8) {
  const kx = 111320 * Math.cos((la * Math.PI) / 180);
  return [...byStopName].map(([name, ids]) => ({ name, d: Math.min(...ids.map((s) => Math.hypot((B.stops[s][2] - lo) * kx, (B.stops[s][1] - la) * 110540))) }))
    .sort((a, b) => a.d - b.d).slice(0, n);
}
function nearMe() {
  const btn = $("#near");
  if (!navigator.geolocation) { btn.textContent = "Location not available"; return; }
  btn.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition((p) => {
    btn.textContent = "Near me";
    const { latitude: la, longitude: lo } = p.coords;
    const near = nearestStops(la, lo);
    const now = nowSecs();
    $("#view").replaceChildren(el("div", { class: "head" }, el("p", { class: "kicker" }, "Near you"), el("h2", {}, "Closest stops")),
      near[0].d > 20000 ? el("p", { class: "muted" }, "You’re a long way from Sheffield, so these are the nearest stops in the city anyway.") : null,
      el("div", { class: "list" }, near.map((x) => {
        const ids = new Set(byStopName.get(x.name));
        const deps = [];
        B.trips.forEach((t, i) => { const s = t[6]; for (let k = 0; k < s.length - 2; k += 2) if (ids.has(s[k])) { const secs = t[2] + s[k + 1] * 60; if (secs >= now && st(i) !== "G") deps.push([secs, i]); break; } });
        deps.sort((a, b) => a[0] - b[0]); const next = deps.slice(0, 3);
        return el("a", { class: "dep near", href: href("stop", x.name) }, el("span", { class: "when" }, el("b", {}, x.d < 1000 ? `${Math.round(x.d / 10) * 10} m` : `${(x.d / 1000).toFixed(1)} km`), el("small", {}, `${Math.round(x.d / 80)} min walk`)),
          el("span", { class: "dest wide" }, el("b", {}, x.name), el("small", {}, next.length ? next.map(([s0, i]) => `${routeOf(i)[0]} ${Math.round((s0 - now) / 60)} min`).join(" · ") : "No more buses today")));
      })));
    if (map) { ctxLayer.clearLayers(); L.circleMarker([la, lo], { radius: 8, color: "#fff", weight: 3, fillColor: "#2563EB", fillOpacity: 1 }).bindTooltip("You").addTo(ctxLayer); fit([[la, lo], ...near.slice(0, 4).map((x) => { const s = byStopName.get(x.name)[0]; return [B.stops[s][1], B.stops[s][2]]; })], 16); }
    current = { kind: "near" };
  }, () => { btn.textContent = "Location blocked"; setTimeout(() => (btn.textContent = "Near me"), 3000); }, { enableHighAccuracy: true, timeout: 10000 });
}

// ---------------------------------------------------------------- the assistant
let bot = null;
const ctx = {
  get B() { return B; }, get S() { return S; }, get R() { return R; }, get RI() { return RI; }, get SUM() { return SUM; }, get index() { return index; },
  now: nowSecs, calls, live, expected, st, headsign, routeOf, reliab, whereIs, delayText, hhmm, shortStop, slug, pct, num, href, search,
  current: () => current,
  places: () => places(),
  risk: (i) => riskOf(i),
};
function md(text) {        // **bold** only
  const out = []; text.split(/(\*\*[^*]+\*\*)/).forEach((p) => out.push(p.startsWith("**") ? el("b", {}, p.slice(2, -2)) : p));
  return out;
}
function say(who, ...kids) {
  const m = el("div", { class: `msg ${who}` }, ...kids);
  $("#chat-log").append(m);
  m.scrollIntoView({ block: "end", behavior: reduced ? "auto" : "smooth" });
  return m;
}
function answerNodes(a, inChat) {
  const now = nowSecs();
  const parts = (a.say || []).map((p) => el("p", {}, md(p)));
  if (a.rows?.length) parts.push(el("div", { class: "list mini" }, a.rows.map((r) => { const row = depRow(r.i, r.secs, r.k, now, r.extra); if (inChat) row.addEventListener("click", maybeCloseChat); return row; })));
  if (a.actions?.length) parts.push(el("div", { class: "chat-actions" }, a.actions.map((x) => el("a", { class: "chip quiet", href: x.href, onclick: inChat ? maybeCloseChat : null }, x.label))));
  return parts;
}
function botAnswer(a) {
  say("bot", ...answerNodes(a, true));
  chips(a.chips || []);
}
function chips(list) {
  $("#chat-chips").replaceChildren(...list.map((c) => el("button", { type: "button", class: "chip quiet", onclick: () => askBot(c) }, c)));
}
function maybeCloseChat() { if (innerWidth < 900) closeChat(); }
function askBot(text) {
  if (!B || !S) return;
  text = String(text).trim(); if (!text) return;
  say("you", el("p", {}, text));
  const typing = say("bot typing", el("i"), el("i"), el("i"));
  setTimeout(() => {
    typing.remove();
    let a;
    try { a = bot.ask(text); } catch (e) { console.error(e); a = { say: ["Sorry, something went wrong working that out. Try asking another way?"] }; }
    if (a.geo) {
      botAnswer(a);
      if (!navigator.geolocation) return botAnswer({ say: ["Your browser can’t share your location. Tell me the name of your stop instead."] });
      navigator.geolocation.getCurrentPosition((p) => {
        const near = nearestStops(p.coords.latitude, p.coords.longitude, 3);
        const first = bot.nextFor(near[0].name);
        botAnswer({ say: [`Closest stops: ${near.map((x) => `**${x.name}** (${x.d < 1000 ? `${Math.round(x.d / 10) * 10} m` : `${(x.d / 1000).toFixed(1)} km`})`).join(", ")}.`, ...(near[0].d > 20000 ? ["You look a long way from Sheffield, so these are just the nearest stops in the city."] : []), ...(first?.say || [])],
          rows: first?.rows, actions: near.map((x) => ({ label: x.name, href: href("stop", x.name) })) });
      }, () => botAnswer({ say: ["I couldn’t get your location. Tell me the name of your stop instead, for example “next bus from Arundel Gate”."] }), { timeout: 10000 });
      return;
    }
    botAnswer(a);
  }, reduced ? 0 : 220);
}
function openChat() {
  const box = $("#chat");
  box.hidden = false; document.body.classList.add("chatting");
  $("#chat-open").setAttribute("aria-expanded", "true");
  if (!$("#chat-log").children.length) {
    const page = current.kind === "stop" ? findItem("stop", current.key) : current.kind === "route" ? findItem("route", current.key) : null;
    botAnswer({ say: ["Hi! I can tell you when your bus is coming, where it is, if it’s late, whether a bus turned up, and how to get somewhere. I use the same live data as the map."],
      chips: page?.kind === "stop" ? ["When’s the next bus here?", "How reliable is this stop?", "Buses near me"]
        : page?.kind === "route" ? [`Where is the ${B.routes[page.ri][0]} now?`, `Is the ${B.routes[page.ri][0]} reliable?`, `Last ${B.routes[page.ri][0]} tonight`]
        : ["Buses near me", "Where is the 52 right now?", "How do I get from Meadowhall to Crystal Peaks?", "What’s a ghost bus?", "How are the buses today?"] });
  }
  setTimeout(() => $("#chat-q").focus(), 50);
}
function closeChat() {
  $("#chat").hidden = true; document.body.classList.remove("chatting");
  $("#chat-open").setAttribute("aria-expanded", "false"); $("#chat-open").focus({ preventScroll: true });
}
function setupChat() {
  bot = createAssistant(ctx);
  window.__ghostBusAssistant = bot;           // handy for testing from the console
  $("#chat-open").addEventListener("click", () => ($("#chat").hidden ? openChat() : closeChat()));
  $("#chat-close").addEventListener("click", closeChat);
  $("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#chat-q"); askBot(q.value); q.value = ""; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#chat").hidden) closeChat(); });
}

// ---------------------------------------------------------------- full-screen map, easy view
function setupViewModes() {
  const app = $(".app");
  if (window.L && map) {
    const Full = L.Control.extend({ options: { position: "topleft" }, onAdd() {
      const b = L.DomUtil.create("button", "map-btn"); b.type = "button"; b.textContent = "⤢ Full map"; b.setAttribute("aria-pressed", "false");
      L.DomEvent.disableClickPropagation(b);
      b.addEventListener("click", () => { const on = app.classList.toggle("mapfull"); b.textContent = on ? "☰ Show list" : "⤢ Full map"; b.setAttribute("aria-pressed", String(on)); setTimeout(() => map.invalidateSize(), 50); });
      return b; } });
    map.addControl(new Full());
  }
  const easy = $("#easy");
  const apply = (on) => { document.body.classList.toggle("easy", on); easy.setAttribute("aria-pressed", String(on)); };
  apply(store.get("gb:easy", false));
  easy.addEventListener("click", () => { const on = !document.body.classList.contains("easy"); store.set("gb:easy", on); apply(on); });
}

// ---------------------------------------------------------------- offline
function setupOffline() {
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  addEventListener("offline", () => toast(`You’re offline. Showing the last data${S ? ` from ${hhmm(atSecs(S.at))}` : ""}; it updates again when you reconnect.`, true));
  addEventListener("online", () => { toast("Back online. Updating…"); refresh(); });
}

// ---------------------------------------------------------------- light / dark
function setupTheme() {
  const btn = $("#theme"), order = ["auto", "light", "dark"], names = { auto: "Theme: auto", light: "Theme: light", dark: "Theme: dark" };
  let mode0 = store.get("gb:theme", "auto");
  const apply = () => {
    if (mode0 === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", mode0);
    btn.textContent = { auto: "◐", light: "☀", dark: "☾" }[mode0]; btn.title = names[mode0]; btn.setAttribute("aria-label", names[mode0]);
    const dark = mode0 === "dark" || (mode0 === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.querySelectorAll(".leaflet-tile-pane .leaflet-layer").forEach((l) => l.classList.toggle("tiles-dark", dark));
  };
  btn.addEventListener("click", () => { mode0 = order[(order.indexOf(mode0) + 1) % 3]; store.set("gb:theme", mode0); apply(); render(); });
  apply();
}

// ---------------------------------------------------------------- live data
function setLive(s, v) {
  S = s; V = v;
  LIVEBY = new Map((S.live || []).map(([i, delay, pos, lat, lon, age, how]) => [i, { delay, pos, lat, lon, age, how }]));
}
async function loadLive() {
  liveBase = await resolveLive();
  const [ls, lv, ss, sv] = await Promise.all([getLive("status.json"), getLive("vehicles.json"), get("status.json"), get("vehicles.json")]);
  const pick = (a, b) => (a && b ? (new Date(a.at) >= new Date(b.at) ? a : b) : a || b);
  const s = pick(ls, ss), v = pick(lv, sv) || { at: s?.at, v: [] };
  return s ? [s, v] : null;
}
function freshness() {
  if (!S) return;
  const mins = Math.max(0, Math.round((Date.now() - new Date(S.at).getTime()) / 60000));
  $("#fresh").className = `fresh${mins > 20 ? " stale" : ""}`;
  $("#fresh-age").textContent = mins <= 1 ? "updated just now" : `updated ${mins} min ago`;
}
async function refresh() {
  const got = await loadLive();
  if (!got) return;
  const [s, v] = got;
  if (S && s.at === S.at) return;
  if (!B || s.day !== B.day || s.version !== B.version) { const b = await get(`board/${s.day}.json`); if (!b) return; B = b; buildIndex(); }
  setLive(s, v); freshness(); render(); checkReminders();
}

async function main() {
  initMap();
  // old links: ?stop= / ?line= / ?route=
  if (!location.hash) {
    if (qs.get("stop")) location.replace(`#/stop/${encodeURIComponent(qs.get("stop"))}`);
    else if (qs.get("line")) location.replace(`#/route/${qs.get("line")}`);
    else if (qs.get("route")) location.replace(`#/route/${qs.get("route")}/history`);
  }
  const [got, routes, summary] = await Promise.all([loadLive(), get("routes.json"), get("summary.json")]);
  R = routes || []; RI = Object.fromEntries(R.map((r) => [r.id, r])); SUM = summary;
  if (!got) { $("#view").replaceChildren(el("p", {}, "Live data isn’t available right now. Try again in a few minutes.")); return; }
  const b = await get(`board/${got[0].day}.json`);
  if (!b) { $("#view").replaceChildren(el("p", {}, "Today’s timetable is still loading. Try again in a few minutes.")); return; }
  B = b; buildIndex(); setLive(...got);
  setupSearch(); setupChat(); setupTheme(); setupViewModes(); setupOffline(); freshness(); render(true);
  if (qs.get("ask")) { openChat(); askBot(qs.get("ask")); }
  addEventListener("hashchange", () => render(true));
  setInterval(refresh, 75000);   // the live branch updates every ~2 minutes
  setInterval(freshness, 15000);
  setInterval(() => { render(); checkReminders(); }, 60000);   // countdowns move on even between data updates
}

main();
