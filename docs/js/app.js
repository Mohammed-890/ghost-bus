// Ghost Bus Detector – reads the JSON the daily job publishes in /data.
const DATA = new URLSearchParams(location.search).get("data") || "data";
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "class" ? (n.className = v) : n.setAttribute(k, v);
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(k ?? ""));
  return n;
};
const get = (p) => fetch(`${DATA}/${p}`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const pct = (x, d = 1) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const num = (x) => (x ?? 0).toLocaleString("en-GB");
const day = (s) => new Date(s + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const time = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";

async function main() {
  const summary = await get("summary.json");
  if (!summary) return collecting(null);
  status(summary);
  if (summary.status !== "ready") return collecting(summary);

  const [routes, recent, shapes, model, daily] = await Promise.all([
    get("routes.json"), get("recent_ghosts.json"), get("shapes.json"), get("model.json"), get("daily.json"),
  ]);
  hero(summary, recent || []);
  routePicker(routes || []);
  league(routes || []);
  recentList(recent || []);
  drawMap(routes || [], shapes || []);
  facts(summary, daily || []);
  modelTable(model);
}

function status(s) {
  const h = s.health || {};
  const live = h.last_poll && Date.now() - new Date(h.last_poll).getTime() < 3 * 3600e3;
  $("#status").replaceChildren(
    el("span", { class: live ? "dot" : "dot off", "aria-hidden": "true" }),
    live ? `Watching about ${num(h.median_buses)} buses live · last checked ${time(h.last_poll)}`
         : h.last_poll ? `Last checked ${time(h.last_poll)}` : "Not collecting yet",
  );
}

function collecting(s) {
  const h = s?.health || {};
  $("#headline").textContent = "Counting Sheffield’s ghost buses.";
  $("#subline").textContent = h.first_poll
    ? `Watching every bus in the city since ${time(h.first_poll)}. The first full day is judged the next morning; reliable numbers need one to two weeks.`
    : "The collector starts as soon as the live data key is connected. The first full day is judged the next morning.";
  $("#board").replaceChildren(el("h4", {}, "What’s being recorded"),
    ...[["Polls of the live feed", num(h.polls)], ["Feed answered", pct(h.ok_share)],
        ["Buses in the city right now", num(h.median_buses)], ["Pings with a trip ID", pct(h.with_trip_share, 0)]]
      .map(([a, b]) => el("div", { class: "dep" }, el("span", { class: "t" }, b), el("span"), el("span", { class: "to" }, a), el("span"))));
  for (const id of ["#check", ".split", ".map-block"]) $(id).hidden = true;
  $("#model").textContent = "The model is trained once there are at least 7 judged days.";
}

function hero(s, recent) {
  const w = s.last7.judged ? s.last7 : s;
  $("#headline").textContent = `Last week, ${num(w.ghosts)} timetabled buses in Sheffield never turned up.`;
  const one = w.ghost_rate ? Math.round(1 / w.ghost_rate) : null;
  $("#subline").textContent = one
    ? `That’s 1 in ${one} of the ${num(w.judged)} trips we could check, measured from live bus GPS, trip by trip.`
    : `Out of ${num(w.judged)} trips we could check, measured from live bus GPS.`;
  const latest = recent.length ? recent[0].date : null;
  const rows = recent.filter((r) => r.date === latest).slice(0, 7);
  $("#board").replaceChildren(el("h4", {}, latest ? `Ghost buses, ${day(latest)}` : "No ghost buses yet"),
    ...rows.map((r) => el("div", { class: "dep ghost" }, el("span", { class: "t" }, r.time), el("span", { class: "r" }, r.route),
      el("span", { class: "to" }, r.to || ""), el("span", { class: "s" }, "never came"))));
}

function routePicker(routes) {
  const sel = $("#route-select");
  const sorted = [...routes].sort((a, b) => a.route.localeCompare(b.route, "en", { numeric: true }) || a.operator.localeCompare(b.operator));
  for (const r of sorted) sel.append(el("option", { value: r.id }, `${r.route} · ${r.operator}`));
  sel.addEventListener("change", () => showRoute(sel.value));
  const want = new URLSearchParams(location.search).get("route");
  if (want && routes.some((r) => r.id === want)) { sel.value = want; showRoute(want); }
}

async function showRoute(id) {
  const view = $("#route-view");
  if (!id) { view.hidden = true; return; }
  const r = await get(`routes/${id}.json`);
  if (!r) { view.hidden = true; $("#route-empty").hidden = false; $("#route-empty").textContent = "No data for this route yet."; return; }
  $("#route-empty").hidden = true;
  const deps = r.departures;
  const judged = deps.reduce((a, d) => a + d.days, 0), ghosts = deps.reduce((a, d) => a + d.ghosts, 0);
  const head = el("div", { class: "rv-head" },
    el("div", {}, el("div", { class: "big" }, pct(judged ? ghosts / judged : 0), el("small", {}, "never ran")), `${num(ghosts)} of ${num(judged)} checked trips · ${r.operator}`));
  const hours = new Map(r.by_hour.map(([h, n, g]) => [h, n ? g / n : 0]));
  const max = Math.max(0.05, ...hours.values());
  const chart = el("div", {}, el("div", { class: "dir" }, "When it happens"),
    el("div", { class: "hours", role: "img", "aria-label": "Ghost rate by hour of day" },
      ...Array.from({ length: 24 }, (_, h) => { const d = el("div"); d.style.height = `${((hours.get(h) || 0) / max) * 100}%`; d.title = `${String(h).padStart(2, "0")}:00 · ${pct(hours.get(h) || 0)}`; return d; })),
    el("div", { class: "hours-axis" }, el("span", {}, "00:00"), el("span", {}, "06:00"), el("span", {}, "12:00"), el("span", {}, "18:00"), el("span", {}, "23:00")));
  const dirs = [...new Set(deps.map((d) => String(d.direction_id)))];
  const grids = dirs.map((dir) => {
    const ds = deps.filter((d) => String(d.direction_id) === dir);
    const to = mode(ds.map((d) => d.to_stop));
    return el("div", {}, el("div", { class: "dir" }, `Towards ${to || "—"}`),
      el("div", { class: "grid" }, ...ds.map((d) => {
        const rate = d.days ? d.ghosts / d.days : 0;
        const cls = rate >= 0.3 ? "cell bad" : rate >= 0.1 ? "cell warn" : "cell";
        const ran = d.days - d.ghosts;
        const extra = d.p_runs_next != null ? ` · ${Math.round(d.p_runs_next * 100)}% chance next day` : "";
        const label = `${d.time} from ${d.from_stop}: ran ${ran} of ${d.days} checked days${extra}`;
        return el("button", { class: cls, type: "button", title: label, "aria-label": label }, d.time, el("span", {}, d.p_runs_next != null ? `${Math.round(d.p_runs_next * 100)}% next day` : `ran ${ran}/${d.days}`));
      })));
  });
  const legend = el("div", { class: "legend" }, el("span", {}, el("i"), "usually runs"), el("span", {}, el("i", { class: "warn" }), "misses 1 in 10 or more"), el("span", {}, el("i", { class: "bad" }), "misses 3 in 10 or more"));
  view.replaceChildren(head, chart, ...grids, legend);
  view.hidden = false;
  history.replaceState(null, "", `?route=${id}`);
}

const mode = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0]; };

function league(routes) {
  const top = routes.filter((r) => r.judged >= 50 && r.rate != null).sort((a, b) => b.rate - a.rate).slice(0, 10);
  const max = Math.max(0.01, ...top.map((r) => r.rate));
  $("#league").replaceChildren(...(top.length ? top.map((r) => {
    const b = el("b"); b.style.width = `${(r.rate / max) * 100}%`;
    const li = el("li", {}, el("span", { class: "rt" }, r.route), el("div", {}, el("div", { class: "op" }, `${r.operator} · ${num(r.ghosts)} of ${num(r.judged)}`), el("div", { class: "barw" }, b)), el("span", { class: "pc" }, pct(r.rate)));
    li.style.cursor = "pointer";
    li.addEventListener("click", () => { $("#route-select").value = r.id; showRoute(r.id); $("#check").scrollIntoView(); });
    return li;
  }) : [el("li", {}, "Not enough judged trips yet.")]));
}

function recentList(recent) {
  $("#recent").replaceChildren(...(recent.length ? recent.slice(0, 12).map((r) =>
    el("li", {}, el("span", { class: "when" }, `${day(r.date)} ${r.time}`), el("span", { class: "rt" }, r.route), el("span", {}, `${r.from || ""} → ${r.to || ""}`)))
    : [el("li", {}, "None found yet.")]));
}

function drawMap(routes, shapes) {
  if (!window.L || !shapes.length) { $(".map-block").hidden = true; return; }
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const map = L.map("map", { scrollWheelZoom: false, attributionControl: true }).setView([53.381, -1.47], 12);
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`, {
    attribution: "© OpenStreetMap contributors © CARTO", maxZoom: 17 }).addTo(map);
  const rate = new Map(routes.map((r) => [r.id, r]));
  const lines = shapes.map((s) => ({ s, r: rate.get(s.id) })).filter((x) => x.r).sort((a, b) => (a.r.rate || 0) - (b.r.rate || 0));
  const bounds = [];
  for (const { s, r } of lines) {
    const k = Math.min(1, (r.rate || 0) / 0.15);
    const color = mix(dark ? [60, 72, 88] : [190, 199, 210], dark ? [185, 166, 240] : [108, 74, 182], k);
    const pl = L.polyline(s.path, { color, weight: 2 + k * 4, opacity: 0.55 + k * 0.45 }).addTo(map);
    pl.bindTooltip(`${r.route} · ${r.operator}: ${pct(r.rate)} never ran`);
    pl.on("click", () => { $("#route-select").value = r.id; showRoute(r.id); $("#check").scrollIntoView(); });
    bounds.push(...s.path);
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [20, 20] });
}
const mix = (a, b, k) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(",")})`;

function facts(s, daily) {
  const items = [
    [num(s.scheduled), "timetabled trips recorded"],
    [num(s.judged), "judged fairly"],
    [num(s.ghosts), "ghost buses"],
    [pct(s.ghost_rate), "never ran"],
    [pct(s.ran_matched / Math.max(1, s.judged - s.ghosts), 0), "of runs found by position, not trip ID"],
    [pct(s.unknown / Math.max(1, s.scheduled), 0), "not judged (feed gaps, operators not reporting)"],
  ];
  $("#facts").replaceChildren(...items.map(([a, b]) => el("div", {}, el("b", {}, a), el("span", {}, b))));
}

function modelTable(m) {
  const box = $("#model");
  if (!m || m.status !== "ready") {
    box.replaceChildren(el("p", {}, `Not yet: the model needs ${m?.needs || "more data"}. So far: ${num(m?.days)} days, ${num(m?.ghosts)} ghost buses.`));
    return;
  }
  const rows = [["Everyone runs (overall rate)", m.constant], ["This departure’s own history", m.history], ["Model", m.model]];
  box.replaceChildren(
    el("p", {}, `Trained on ${day(m.train_days[0])}–${day(m.train_days[1])}, tested on later days it never saw (${day(m.test_days[0])}–${day(m.test_days[1])}, ${num(m.n_test)} trips).`),
    el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Method"), el("th", { class: "n" }, "Ghosts caught in riskiest 10%"), el("th", { class: "n" }, "Ranking (AUC)"), el("th", { class: "n" }, "Brier (lower is better)"))),
      el("tbody", {}, ...rows.map(([n, x]) => el("tr", {}, el("td", {}, n), el("td", { class: "n" }, pct(x.ghosts_in_riskiest_10pct, 0)), el("td", { class: "n" }, x.roc_auc ?? "–"), el("td", { class: "n" }, x.brier))))));
}

main();
