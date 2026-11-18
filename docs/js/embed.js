// A small live departure widget for any stop, for other websites: embed.html?stop=<stop name or "X (all stands)">.
// It reads the same files as the main site: today's timetable, and the live status from the `live` branch
// (refreshed every ~2 minutes) or the site's own copy, whichever is newer.
const qs = new URLSearchParams(location.search);
const KEY = qs.get("stop") || "Arundel Gate (all stands)";
const LIVE = "https://raw.githubusercontent.com/Mohammed-890/ghost-bus/live/";
const BAY = /^(.*)\/([A-Z]{1,3}\d{1,2}[A-Z]?)$/;
const box = document.getElementById("w");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const getJ = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const shortStop = (s) => (s || "").replace(BAY, "$1");
const hhmm = (secs) => { const m = Math.floor((((secs % 86400) + 86400) % 86400) / 60); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
function ukNow(day) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const today = `${p.year}-${p.month}-${p.day}`, secs = +p.hour * 3600 + +p.minute * 60 + +p.second;
  return today === day ? secs : today > day ? secs + 86400 : secs - 86400;
}
async function draw() {
  const [ls, ss] = await Promise.all([getJ(`${LIVE}status.json`), getJ("data/status.json")]);
  const S = ls && ss ? (new Date(ls.at) >= new Date(ss.at) ? ls : ss) : ls || ss;
  if (!S) { box.innerHTML = '<p class="none">Live data isn’t available right now.</p>'; return; }
  const B = await getJ(`data/board/${S.day}.json`);
  if (!B) { box.innerHTML = '<p class="none">Today’s timetable is still loading.</p>'; return; }
  const live = new Map((S.live || []).map(([i, delay, pos]) => [i, { delay, pos }]));
  const base = KEY.endsWith(" (all stands)") ? KEY.slice(0, -13) : null;
  const want = new Set();
  B.stops.forEach(([name], i) => { if (name === KEY || (base && (name.match(BAY)?.[1] === base))) want.add(i); });
  const now = ukNow(B.day), rows = [];
  B.trips.forEach((t, i) => {
    const s = t[6];
    for (let k = 0; k < s.length - 2; k += 2) if (want.has(s[k])) {
      const st = S.status?.[i] || "N", L0 = live.get(i), sched = t[2] + s[k + 1] * 60;
      if (st === "R" || (L0 && L0.pos > k / 2 + 0.5)) break;
      const ex = sched + (L0 && L0.delay > 0 ? L0.delay * 60 : 0);
      if (ex < now - 60 || ex > now + 3 * 3600) break;
      rows.push({ i, ex, sched, st, L0 });
      break;
    }
  });
  rows.sort((a, b) => a.ex - b.ex);
  const label = base || KEY;
  const head = `<h1>${esc(label)}</h1><p class="sub"><i></i>Live buses · updated ${Math.max(0, Math.round((Date.now() - new Date(S.at)) / 60000))} min ago</p>`;
  const items = rows.slice(0, 6).map(({ i, ex, sched, st, L0 }) => {
    const r = B.routes[B.trips[i][0]], t = B.trips[i], m = Math.round((ex - now) / 60);
    const status = st === "G" ? '<span class="g">never came</span>' : L0 ? (L0.delay > 1 ? `<span class="late">● ${L0.delay} min late</span>` : '<span class="ok">● on time</span>') : `timetable ${hhmm(sched)}`;
    return `<li><span class="rt">${esc(r[0])}</span><span class="to"><b>${esc(shortStop(t[7] || t[5]))}</b><small>${status}</small></span><span class="due">${st === "G" ? "–" : m <= 0 ? "Due" : m < 60 ? `${m} min` : hhmm(ex)}<small>${esc(r[1].split(" ")[0])}</small></span></li>`;
  }).join("");
  const site = new URL(`./#/stop/${encodeURIComponent(KEY)}`, location.href).href;
  box.innerHTML = `${head}${items ? `<ul>${items}</ul>` : '<p class="none">No more buses here in the next 3 hours.</p>'}<div class="foot"><span>● = live GPS</span><a href="${esc(site)}" target="_blank" rel="noopener">Ghost Bus Detector ↗</a></div>`;
}
draw();
setInterval(draw, 60000);
