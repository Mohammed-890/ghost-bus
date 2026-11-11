// Live bus checker: find a stop or route, see today's buses and whether each one really came.
// Reads data/status.json (updated every collector round) and data/board/<day>.json (today's timetable).
const DATA = new URLSearchParams(location.search).get("data") || "data";
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "class" ? (n.className = v) : n.setAttribute(k, v);
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(k ?? ""));
  return n;
};
const get = (p) => fetch(`${DATA}/${p}`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const num = (x) => (x ?? 0).toLocaleString("en-GB");
const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "route";
const hhmm = (secs) => { const m = Math.floor(((secs % 86400) + 86400) % 86400 / 60); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const BAY = /^(.*)\/([A-Z]{1,3}\d{1,2}[A-Z]?)$/;

let B = null;          // today's timetable
let S = null;          // live status
let reliability = {};  // route slug -> share of judged trips that ran
let view = null;       // { kind: "stop" | "route", key, tab }
let map = null, layer = null;

// seconds since midnight of the board's service day, in UK time
function nowSecs() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const secs = +parts.hour * 3600 + +parts.minute * 60 + +parts.second;
  return today === B.day ? secs : today > B.day ? secs + 86400 : secs - 86400;
}

// ---------------------------------------------------------------- search index
let index = [];
function buildIndex() {
  const byName = new Map();
  B.stops.forEach(([name], i) => { if (!byName.has(name)) byName.set(name, []); byName.get(name).push(i); });
  const groups = new Map();
  for (const [name, ids] of byName) {
    const m = name.match(BAY);
    if (m) { if (!groups.has(m[1])) groups.set(m[1], []); groups.get(m[1]).push(...ids); }
  }
  index = [];
  for (const [base, ids] of groups) if (ids.length > 1) index.push({ kind: "stop", key: `${base} (all stands)`, label: base, sub: `All ${ids.length} stands`, stops: ids });
  for (const [name, ids] of byName) index.push({ kind: "stop", key: name, label: name, sub: "Bus stop", stops: ids });
  B.routes.forEach(([route, op], i) => index.push({ kind: "route", key: slug(`${route}-${op}`), label: `Route ${route}`, sub: op, route: i, num: route.toLowerCase() }));
}

function search(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const it of index) {
    let s = -1;
    if (it.kind === "route") {
      if (it.num === q) s = 100; else if (it.num.startsWith(q)) s = 80;
    } else {
      const l = it.label.toLowerCase();
      if (l === q) s = 90; else if (l.startsWith(q)) s = 70; else if (l.includes(q)) s = 40;
      if (s >= 0 && it.sub.startsWith("All")) s += 5;
    }
    if (s >= 0) scored.push([s, it]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].label.localeCompare(b[1].label, "en", { numeric: true })).slice(0, 8).map((x) => x[1]);
}

function setupSearch() {
  const q = $("#q"), list = $("#q-list");
  let items = [], active = -1;
  const close = () => { list.hidden = true; q.setAttribute("aria-expanded", "false"); active = -1; };
  const paint = () => {
    list.replaceChildren(...items.map((it, i) => {
      const li = el("li", { role: "option", id: `q-${i}`, "aria-selected": String(i === active), class: i === active ? "on" : "" },
        el("span", { class: `tag ${it.kind}` }, it.kind === "route" ? "Route" : "Stop"), el("b", {}, it.label), el("small", {}, it.sub));
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(it); });
      return li;
    }));
    if (!items.length) list.replaceChildren(el("li", { class: "none" }, "No stop or route with that name"));
    list.hidden = false;
    q.setAttribute("aria-expanded", "true");
    q.setAttribute("aria-activedescendant", active >= 0 ? `q-${active}` : "");
  };
  const choose = (it) => { q.value = it.label; close(); q.blur(); open(it.kind, it.key); };
  q.addEventListener("input", () => { items = search(q.value); active = items.length ? 0 : -1; q.value.trim() ? paint() : close(); });
  q.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); paint(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); paint(); e.preventDefault(); }
    else if (e.key === "Enter" && items[active]) { choose(items[active]); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  q.addEventListener("focus", () => q.select());
  q.addEventListener("blur", () => setTimeout(() => { close(); if (!q.value.trim() && current) q.value = current; }, 120));

  const picks = ["Meadowhall Interchange (all stands)", "Arundel Gate (all stands)", "52-stagecoach-yorkshire", "Sheffield Interchange (all stands)"]
    .map((k) => index.find((it) => it.key === k)).filter(Boolean);
  if (picks.length) {
    $("#try").replaceChildren("Try ", ...picks.flatMap((it, i) => {
      const b = el("button", { type: "button", class: "chip" }, it.label);
      b.addEventListener("click", () => { q.value = it.label; open(it.kind, it.key); });
      return i ? [" ", b] : [b];
    }));
    $("#try").hidden = false;
  }
}

// ---------------------------------------------------------------- statuses
const PILL = { O: ["o", "On the road"], P: ["p", "Due"], S: ["s", "Scheduled"], R: ["r", "Ran"], G: ["g", "Never came"], N: ["n", "No live data"] };
const liveOf = () => new Map((S?.live || []).map(([i, lat, lon, age]) => [i, { lat, lon, age }]));

function rowFor(i, secs, now, live, extra) {
  const t = B.trips[i];
  const [route, op] = B.routes[t[0]];
  const c = S?.status?.[i] || "N";
  const [cls, word] = PILL[c] || PILL.N;
  let note = "";
  if (c === "O") { const l = live.get(i); note = l ? (l.age <= 1 ? "reporting now" : `seen ${l.age} min ago`) : ""; }
  else if (c === "P") note = secs >= now ? "not confirmed yet" : "should have passed, not confirmed yet";
  else if (c === "S") { const r = reliability[slug(`${route}-${op}`)]; note = r != null ? `usually runs ${Math.round(r * 100)}%` : ""; }
  else if (c === "R") note = "a bus was seen";
  else if (c === "G") note = "no bus seen";
  const li = el("li", { class: `dep-row ${cls}${secs < now - 300 ? " past" : ""}` },
    el("span", { class: "t" }, hhmm(secs)),
    el("span", { class: "rt" }, route),
    el("span", { class: "dest" }, el("b", {}, `to ${t[5] || "—"}`), el("small", {}, extra || op)),
    el("span", { class: "st" }, el("span", { class: `pill ${cls}` }, word), note ? el("small", {}, note) : ""));
  return li;
}

// ---------------------------------------------------------------- views
function stopTrips(stopIds) {
  const want = new Set(stopIds), out = [];
  B.trips.forEach((t, i) => {
    const seq = t[6];
    for (let k = 0; k < seq.length - 2; k += 2) {           // the trip's last stop is where it ends: nothing to catch there
      if (want.has(seq[k])) { out.push({ i, secs: t[2] + seq[k + 1] * 60, stop: seq[k] }); break; }
    }
  });
  return out.sort((a, b) => a.secs - b.secs);
}

function render() {
  if (!view || !B) return;
  const now = nowSecs(), live = liveOf();
  const list = $("#live-list");
  let rows = [], pts = [], buses = [], signRows = [];
  if (view.kind === "stop") {
    const it = index.find((x) => x.kind === "stop" && x.key === view.key);
    if (!it) return;
    const multi = it.stops.length > 1;
    const all = stopTrips(it.stops);
    const up = all.filter((d) => d.secs >= now - 300);
    const early = all.filter((d) => d.secs < now - 300).reverse();
    tabs([["up", `Coming up (${up.length})`], ["early", `Earlier today (${early.length})`]]);
    const pick = view.tab === "early" ? early : up.slice(0, 60);
    signRows = all;
    rows = pick.map((d) => rowFor(d.i, d.secs, now, live, multi ? `${B.routes[B.trips[d.i][0]][1]} · stand ${B.stops[d.stop][0].split("/").pop()}` : null));
    $("#live-kind").textContent = "Bus stop";
    $("#live-title").textContent = it.label;
    const ran = all.filter((d) => S.status[d.i] === "R" || S.status[d.i] === "O").length, ghost = all.filter((d) => S.status[d.i] === "G").length;
    $("#live-meta").textContent = `${num(all.length)} buses timetabled here today: ${num(ran)} ran so far, ${num(ghost)} never came. Updated ${hhmm(nowFromAt())} UK time.`;
    if (!pick.length) rows = [el("li", { class: "none" }, view.tab === "early" ? "No buses earlier today." : "No more buses from here today.")];
    pts = it.stops.map((s) => B.stops[s]);
    for (const d of all) if (live.has(d.i)) buses.push([d.i, live.get(d.i)]);
  } else {
    const r = index.find((x) => x.kind === "route" && x.key === view.key);
    if (!r) return;
    const trips = B.trips.map((t, i) => [t, i]).filter(([t]) => t[0] === r.route);
    const dirs = [...new Set(trips.map(([t]) => t[1]))].sort();
    const mode = (a) => { const c = new Map(); a.forEach((x) => c.set(x, (c.get(x) || 0) + 1)); return [...c].sort((x, y) => y[1] - x[1])[0]?.[0]; };
    const label = Object.fromEntries(dirs.map((d) => [d, `To ${mode(trips.filter(([t]) => t[1] === d).map(([t]) => t[5])) || "—"}`]));
    tabs(dirs.map((d) => [d, label[d]]));
    if (!dirs.includes(view.tab)) view.tab = dirs[0];
    const mine = trips.filter(([t]) => t[1] === view.tab).sort((a, b) => a[0][2] - b[0][2]);
    const next = mine.findIndex(([t]) => t[2] >= now - 300);
    rows = mine.map(([t, i]) => rowFor(i, t[2], now, live, `from ${t[4]}`));
    signRows = mine.map(([t, i]) => ({ i, secs: t[2] }));
    $("#live-kind").textContent = r.sub;
    $("#live-title").textContent = r.label;
    const ran = trips.filter(([, i]) => "RO".includes(S.status[i])).length, ghost = trips.filter(([, i]) => S.status[i] === "G").length;
    $("#live-meta").replaceChildren(`${num(trips.length)} departures today: ${num(ran)} ran so far, ${num(ghost)} never came. Updated ${hhmm(nowFromAt())} UK time. `,
      el("a", { href: `?route=${r.key}#check` }, "See this route’s history"));
    if (next > 0) setTimeout(() => list.children[next]?.scrollIntoView({ block: "nearest" }), 50);
    const longest = mine.map(([t]) => t[6]).sort((a, b) => b.length - a.length)[0] || [];
    for (let k = 0; k < longest.length; k += 2) pts.push(B.stops[longest[k]]);
    for (const [, i] of trips) if (live.has(i)) buses.push([i, live.get(i)]);
  }
  list.replaceChildren(...rows);
  drawLive(view.kind, pts, buses);
  sign(signRows, now, live);
}

// the LED sign: the next buses, plus any that should have come in the last half hour and didn't
const narrow = () => matchMedia("(max-width: 600px)").matches;
const shortStop = (name) => { const m = (name || "").match(BAY); return m ? m[1] : name || ""; };
function sign(items, now, live) {
  const ghosts = items.filter((d) => S.status[d.i] === "G" && d.secs < now && d.secs >= now - 1800).slice(-2);
  const next = items.filter((d) => d.secs >= now - 60 && S.status[d.i] !== "G").slice(0, 7 - ghosts.length);
  const show = [...ghosts, ...next].sort((a, b) => a.secs - b.secs);
  const rows = show.map((d) => {
    const t = B.trips[d.i], c = S.status[d.i];
    const mins = Math.round((d.secs - now) / 60);
    const when = c === "G" ? "Ghost" : mins <= 0 ? "Due" : mins < 60 ? `${mins} min` : hhmm(d.secs);
    const label = c === "G" ? `Route ${B.routes[t[0]][0]} to ${shortStop(t[5])}, due ${hhmm(d.secs)}: never came`
      : `Route ${B.routes[t[0]][0]} to ${shortStop(t[5])}, ${mins <= 0 ? "due now" : `in ${mins} minutes`}${c === "O" ? ", tracked live" : ""}`;
    return el("li", { class: `sign-row${c === "G" ? " ghost" : ""}${c === "O" && live.has(d.i) ? " live" : ""}`, "aria-label": label },
      el("span", { class: "rt" }, B.routes[t[0]][0]), el("span", { class: "dest" }, narrow() ? shortStop(t[5]).split("/")[0] : shortStop(t[5])), el("span", { class: "when" }, when));
  });
  if (!rows.length) rows.push(el("li", { class: "sign-row" }, el("span", { class: "rt" }, ""), el("span", { class: "dest" }, "No more buses today"), el("span", { class: "when" }, "")));
  $("#sign-rows").replaceChildren(...rows);
}

function nowFromAt() {
  const d = new Date(S.at);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return +p.hour * 3600 + +p.minute * 60;
}

function tabs(items) {
  if (!items.some(([k]) => k === view.tab)) view.tab = items[0]?.[0];
  $("#live-tabs").replaceChildren(...items.map(([k, label]) => {
    const b = el("button", { type: "button", role: "tab", "aria-selected": String(k === view.tab), class: k === view.tab ? "on" : "" }, label);
    b.addEventListener("click", () => { view.tab = k; render(); });
    return b;
  }));
}

function drawLive(kind, pts, buses) {
  if (!window.L) return;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  if (!map) {
    map = L.map("live-map", { scrollWheelZoom: false, zoomSnap: 0.25 });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 18, className: dark ? "tiles-dark" : "" }).addTo(map);
  }
  layer?.remove();
  layer = L.layerGroup().addTo(map);
  const ghost = getComputedStyle(document.documentElement).getPropertyValue("--ghost").trim() || "#6C4AB6";
  if (kind === "route" && pts.length > 1) L.polyline(pts.map((p) => [p[1], p[2]]), { color: ghost, weight: 4, opacity: 0.7 }).addTo(layer);
  for (const p of pts) {
    L.circleMarker([p[1], p[2]], kind === "stop" ? { radius: 8, color: ghost, weight: 3, fillColor: "#fff", fillOpacity: 1 } : { radius: 3, color: ghost, weight: 1, fillColor: ghost, fillOpacity: 1 })
      .bindTooltip(p[0]).addTo(layer);
  }
  for (const [i, b] of buses) {
    const t = B.trips[i];
    L.circleMarker([b.lat, b.lon], { radius: 7, weight: 2, color: "#0C0D0B", fillColor: "#FFB31A", fillOpacity: 1 })
      .bindTooltip(`Route ${B.routes[t[0]][0]} to ${t[5]}, due ${hhmm(t[2])} · seen ${b.age} min ago`).addTo(layer);
  }
  const all = [...pts.map((p) => [p[1], p[2]]), ...buses.map(([, b]) => [b.lat, b.lon])];
  requestAnimationFrame(() => {
    map.invalidateSize();
    if (all.length === 1) map.setView(all[0], 15);
    else if (all.length) map.fitBounds(all, { padding: [24, 24], maxZoom: 15 });
  });
}

let current = "";
function open(kind, key, quiet) {
  view = { kind, key, tab: kind === "stop" ? "up" : null };
  const it = index.find((x) => x.kind === kind && x.key === key);
  current = it ? it.label : "";
  $("#q").value = current;
  $("#live").hidden = false;
  render();
  if (!quiet) history.replaceState(null, "", kind === "stop" ? `?stop=${encodeURIComponent(key)}` : `?line=${key}`);
}

function clock() {
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date());
  $("#sign-clock").replaceChildren(t.slice(0, 5), el("span", { class: "sec" }, t.slice(5)));
}

function today() {
  const c0 = S.counts || {};
  $("#ticker").textContent = `Sheffield today: ${num((c0.R || 0) + (c0.O || 0))} buses ran · ${num(c0.G || 0)} never came · ${num((S.live || []).length)} on the road now · times are UK time · updated ${hhmm(nowFromAt())}`;
  const c = S.counts || {};
  const live = (S.live || []).length;
  $("#today").replaceChildren(
    el("span", { class: "dot", "aria-hidden": "true" }),
    `Today in Sheffield so far: `, el("b", {}, num((c.R || 0) + (c.O || 0))), ` buses ran, `,
    el("b", { class: "g" }, num(c.G || 0)), ` never came, `, el("b", {}, num(live)), ` tracked on the road right now. Updated ${hhmm(nowFromAt())} UK time.`);
}

async function refresh() {
  const s = await get("status.json");
  if (!s) return;
  if (!B || s.day !== B.day || s.version !== B.version) {
    const b = await get(`board/${s.day}.json`);
    if (!b) return;
    B = b;
    buildIndex();
  }
  S = s;
  today();
  render();
}

async function main() {
  const [s, routes] = await Promise.all([get("status.json"), get("routes.json")]);
  for (const r of routes || []) if (r.judged) reliability[r.id] = 1 - (r.rate || 0);
  if (!s) { $("#today").textContent = "The live board starts with the next collector update."; return; }
  const b = await get(`board/${s.day}.json`);
  if (!b) { $("#today").textContent = "Today’s timetable is still loading. Try again in a few minutes."; return; }
  B = b; S = s;
  buildIndex();
  setupSearch();
  today();
  const qs = new URLSearchParams(location.search);
  if (qs.get("stop") && index.some((x) => x.kind === "stop" && x.key === qs.get("stop"))) open("stop", qs.get("stop"));
  else if (qs.get("line") && index.some((x) => x.kind === "route" && x.key === qs.get("line"))) open("route", qs.get("line"));
  else open("stop", "Sheffield Interchange (all stands)", true);   // the sign is never blank: start at the city's main bus station
  clock();
  setInterval(clock, 1000);
  setInterval(refresh, 120000);
  setInterval(render, 30000);
}

main();
