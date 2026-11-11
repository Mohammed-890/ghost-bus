// "Ask Ghost Bus": a question-answering assistant that runs entirely in the browser.
//
// It doesn't send anything anywhere. A question is read for what it's about (a stop, a route,
// a time, "me") and what it wants (next buses, where a bus is, whether it came, how reliable a
// route is, how to get somewhere, ...). The answer is built from the same live data as the page,
// so it's exactly as current as the map. Spelling mistakes are fine: stop names are matched
// letter by letter, allowing for a missing, extra or swapped letter.
//
// createAssistant(ctx) -> { ask(text) => answer }
// answer = { say: [paragraph], rows: [{ i, secs, k, extra }], actions: [{ label, href }], chips: [question], intent, geo }
// Paragraphs may use **bold**.

const STOPWORDS = new Set(("a an the to from at of in on for is are was were be been do does did can could would will i me my we you it its this that " +
  "what whats when whens where wheres which who why how hows please pls plz tell show give find get any there here about bus buses " +
  "route routes number no stop stops station going go goes come comes coming came today now right just still yet and or with by " +
  "time times next first last leave leaves leaving arrive arrives arriving left late early delay delayed running run ran runs " +
  "on time ontime whats up hey hi hello thanks thank you mate bro okay ok so like know want need take reliable reliability worst best " +
  "ghost never often usually chance nearby near closest nearest much many show map track tonight morning evening afternoon minutes " +
  "min mins hour hours after before then more one ones other again coming around into through via change got gonna should would " +
  "late delayed early cancelled canceled turn turned up didnt doesnt dont isnt wasnt has have had till until long problems problem issues " +
  "issue disruption disruptions trouble wrong delays home journey trip quickest fastest best way say said ago leave departs depart departing " +
  "arrival arrivals ghosts happened happen least most which all every buses city" ).split(" "));
const ALIASES = [[/^(the )?(interchange|bus station|town|city centre|city center|town centre|centre|center)$/, "Sheffield Interchange (all stands)"]];
const GENERIC = new Set(["road", "rd", "street", "st", "lane", "ln", "avenue", "ave", "close", "drive", "way", "place", "terrace",
  "crescent", "gardens", "green", "park", "hill", "view", "centre", "center", "square", "sq", "interchange", "stand", "corner"]);
const TYPOS = { wen: "when", wn: "when", wat: "what", wot: "what", nxt: "next", nex: "next", buss: "bus", busses: "buses", bu: "bus",
  comin: "coming", cmoing: "coming", tme: "time", tiem: "time", stp: "stop", whre: "where", wher: "where", were: "where", hw: "how",
  lat: "late", realiable: "reliable", relaible: "reliable", reliabel: "reliable", u: "you", r: "are", ur: "your", gona: "going",
  ghosts: "ghost", ghostbus: "ghost", ghostbuses: "ghost", tmrw: "tomorrow", tmr: "tomorrow", pls: "please", interchnage: "interchange",
  intercahnge: "interchange", interhcange: "interchange", sheffeild: "sheffield", sheffied: "sheffield", shef: "sheffield", rd: "road",
  frm: "from", fr: "from", thru: "through", til: "till", whens: "when", wheres: "where", whats: "what", hows: "how", im: "i", nd: "and",
  realible: "reliable", reliabile: "reliable", trams: "tram", trains: "train" };

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function numberWords(ws) {             // "fifty two" -> "52", "one twenty" -> "120"
  const out = [];
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k], n = ws[k + 1];
    if (w in TENS && n in ONES && ONES[n] < 10) { out.push(String(TENS[w] + ONES[n])); k++; }
    else if (w in ONES && ONES[w] < 10 && (n in TENS) && !(ws[k + 2] in ONES)) { out.push(`${ONES[w]}${TENS[n]}`); k++; }
    else if (w in TENS && !["minutes", "mins", "min"].includes(n)) out.push(String(TENS[w]));
    else out.push(w);
  }
  return out;
}
function norm(s) {
  return String(s || "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/(\d)[.](\d\d)\b/g, "$1:$2")
    .replace(/[^a-z0-9:\s/-]/g, " ").replace(/[/-]/g, " ").replace(/\s+/g, " ").trim();
}
const words = (s) => numberWords(norm(s).split(" ").filter(Boolean).map((w) => TYPOS[w] || w));

function edits(a, b, max) {             // optimal string alignment distance, giving up past `max`
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}
function wordMatch(q, t) {              // how well a typed word q matches a word t of a stop name (0..1)
  if (q === t) return 1;
  if (q.length >= 4 && t.startsWith(q)) return 0.9;
  if (t.length >= 4 && q.length >= 4) { const e = edits(q, t, t.length >= 8 ? 2 : 1); if (e <= (t.length >= 8 ? 2 : 1)) return 0.8; }
  return 0;
}

export function createAssistant(ctx) {
  const memo = { stop: null, route: null, list: null, offset: 0, lastIntent: null };
  let stopDocs = null, routeNums = null, stopDeps = null, operators = null;

  // ------------------------------------------------------------ what's in the question
  function prepare() {
    if (stopDocs && stopDocs.day === ctx.B.day) return;
    stopDocs = [];
    stopDeps = new Map();
    for (const t of ctx.B.trips) for (let k = 0; k < t[6].length; k += 2) stopDeps.set(t[6][k], (stopDeps.get(t[6][k]) || 0) + 1);
    for (const it of ctx.index) {
      if (it.kind !== "stop" || it.area) continue;
      const label = it.label;
      const toks = words(label).filter((w) => !/^[a-z]{1,3}\d{1,2}[a-z]?$/.test(w));   // drop stand codes like ag6
      if (!toks.length) continue;
      stopDocs.push({ it, toks, group: it.sub.endsWith("stands"), n: it.stops.length, deps: it.stops.reduce((a, x) => a + (stopDeps.get(x) || 0), 0) });
    }
    stopDocs.day = ctx.B.day;
    routeNums = new Map();
    ctx.B.routes.forEach(([r], ri) => { const k = r.toLowerCase(); if (!routeNums.has(k)) routeNums.set(k, []); routeNums.get(k).push(ri); });
    operators = [...new Set(ctx.B.routes.map((r) => r[1]))].map((name) => {
      const key = words(name).filter((w) => !["yorkshire", "travel", "coaches", "coach", "bus", "buses", "ltd", "limited", "and", "the", "of", "south", "services"].includes(w));
      return { name, key: key.length ? key : words(name).slice(0, 1) };
    });
  }

  function findStop(text, area = false) {
    const q = words(text).filter((w) => !STOPWORDS.has(w) && !routeNums.has(w) && !/^\d/.test(w));
    if (!q.length) return null;
    const joined = q.join(" ");
    for (const [re, key] of ALIASES) if (re.test(joined)) { const it = ctx.index.find((x) => x.kind === "stop" && x.key === key); if (it) return { score: 99, it, cover: 1 }; }
    let best = null;
    for (const d of stopDocs) {
      let have = 0, total = 0, specific = 0, used = new Set();
      for (const t of d.toks) {
        const w = GENERIC.has(t) ? 0.2 : 1;
        total += w;
        let m = 0, mi = -1;
        q.forEach((x, qi) => { const s = wordMatch(x, t); if (s > m && !used.has(qi)) { m = s; mi = qi; } });
        if (m) { used.add(mi); have += w * m; if (!GENERIC.has(t)) specific++; }
      }
      if (!specific) continue;
      const cover = have / total;                         // how much of the stop's name was typed
      const extra = q.filter((_, qi) => !used.has(qi)).length;
      if (cover < 0.55) continue;
      const score = cover * 10 - extra * 0.15 + (d.group ? 0.6 : 0) + Math.min(d.n, 5) * 0.02 - d.toks.length * 0.01;
      if (!best || score > best.score) best = { score, it: d.it, cover };
    }
    if (best || !area) return best;
    // an area rather than a stop ("Fulwood", "Ecclesall Road"): every word typed is in the stop's name; take the busiest
    const sig = q.filter((w) => w.length >= 4 && !GENERIC.has(w));
    if (!sig.length) return null;
    let pick = null;
    for (const d of stopDocs) {
      if (!sig.every((x) => d.toks.some((t) => wordMatch(x, t) >= 0.8))) continue;
      const sc = d.deps + (d.group ? 1000 : 0);
      if (!pick || sc > pick.sc) pick = { sc, it: d.it };
    }
    return pick ? { score: 1, it: pick.it, cover: 0.5, area: true } : null;
  }
  function findOperator(t) {
    if (/\bfirst (bus|one|departure|service|52|x\d)/.test(t) && !/\bfirst (bus|buses) (company|operator|group)\b/.test(t)) return null;
    for (const o of operators) if (o.key.every((k) => t.split(" ").some((w) => wordMatch(w, k) >= 0.8))) return o.name;
    return null;
  }

  function findRoutes(text) {
    const ws0 = words(text), ws = [];
    for (let k = 0; k < ws0.length; k++) {
      if (/^[a-z]$/.test(ws0[k]) && /^\d{1,3}[a-z]?$/.test(ws0[k + 1] || "") && routeNums.has(ws0[k] + ws0[k + 1])) { ws.push(ws0[k] + ws0[k + 1]); k++; }
      else ws.push(ws0[k]);
    }
    const found = [];
    ws.forEach((w, k) => {
      if (!routeNums.has(w)) return;
      const prev = ws[k - 1] || "", next = ws[k + 1] || "";
      const hasLetter = /[a-z]/.test(w);
      const cue = /^(route|bus|number|no|the|line|service|a|an|catch|take|get|my)$/.test(prev) || hasLetter;
      const timey = /^(am|pm|oclock|o)$/.test(next) || /^(at|by|around|before|after|till|until|from|past)$/.test(prev) && !hasLetter;
      const minutes = !cue && /^(min|mins|minute|minutes|hour|hours|hrs|stops|people|times)$/.test(next);
      if (timey || minutes) return;
      if (cue || Number(w) > 24 || ws.length <= 3) found.push(w);
      else if (!/:/.test(text)) found.push(w);
    });
    return [...new Set(found)];
  }

  function findTime(text) {
    const t = norm(text);
    let m = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/) || t.match(/\b(?:at|by|around)\s+(\d{1,2})(\d{2})\b(?!\s*(?:bus|to|from))/);
    let h, mi, ap;
    if (m) { h = +m[1]; mi = +m[2]; ap = m[3]; }
    else if ((m = t.match(/\b(\d{1,2})\s*(am|pm)\b/))) { h = +m[1]; mi = 0; ap = m[2]; }
    else if ((m = t.match(/\b(?:at|around|by|after|before)\s+(\d{1,2})\b(?!\s*(?:min|mins|minutes|stops|bus|buses))/))) { h = +m[1]; mi = 0; }
    else return null;
    if (h > 24 || mi > 59) return null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 6 && !/morning|early|am\b/.test(t) && ctx.now() > 12 * 3600) h += 12;   // "at 5" in the afternoon means 17:00
    return h * 3600 + mi * 60;
  }

  // "by 9am", "after 6", "least walking", "my usual bus is delayed": what the journey has to fit
  const WHEN_RE = /\b(?:by|before|for|at|around|after|from|leaving|leave|arriving|arrive|arrival|depart\w*|be there by|get there by)\s+(?:about\s+|around\s+)?\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|oclock)?\b|\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b|\b(?:tonight|this (?:morning|afternoon|evening)|right now|now|asap|today)\b/g;
  const PREF_RE = /\b(?:with |by |using |on )?(?:the )?(?:fastest|quickest|shortest|most reliable|reliable|safest|least walking|less walking|minimal walking|no walking|without walking|fewest changes|least changes|fewer changes|no changes|without changing|directly|direct|cheapest)\b(?:\s+(?:way|route|journey|option|bus|trip))?/g;
  const ALT_RE = /\b(?:an? )?(?:alternative|another way|other way|instead)\b|\b(?:because|as|since|cos|cause)\b.*$|\bmy (?:usual|normal|regular) bus\b.*$/g;
  function tripOpts(raw) {
    const t = norm(raw), o = {};
    const tm = findTime(raw);
    if (tm != null) {
      if (/\b(by|before|be there|get there|arriv\w*|for)\s+(?:about\s+|around\s+)?\d/.test(t) || /\barrive\b/.test(t)) o.by = tm;
      else o.after = tm;
    }
    if (/\b(least|less|minimal|no|without) walk/.test(t)) o.pref = "walk";
    else if (/\b(fewest|least|fewer|no) changes?\b|\bwithout changing\b|\bdirect(ly)?\b/.test(t)) o.pref = "changes";
    else if (/\b(most )?reliable\b|\bsafest\b|\bwont let me down\b/.test(t)) o.pref = "reliable";
    else if (/\b(fastest|quickest|shortest)\b/.test(t)) o.pref = "fast";
    if (/\b(alternative|another way|other way|instead|delayed|cancelled|late|not coming|didnt come)\b/.test(t)) { o.alt = true; o.pref = o.pref || "reliable"; }
    return o;
  }
  const tripText = (raw) => norm(raw).replace(ALT_RE, " ").replace(WHEN_RE, " ").replace(PREF_RE, " ").replace(/\b(i need|i want|i have|i must|i would like|id like|need|want|please)\b/g, " ").replace(/\s+/g, " ").trim();
  // places people name that aren't stop names: campuses, the city centre, and whole streets or districts
  // ("Crookes" means any Crookes/… stop). An area is all its stops, so a plan can use any of them.
  const LANDMARKS = [
    [/^(the )?(university of sheffield|uni of sheffield|sheffield uni|sheffield university|tuos|firth court|the diamond|diamond|students union)$/, "University of Sheffield", /^Western Bank\/|^Glossop Road\/(Clarkson Street|Gell Street)$/],
    [/^(the )?(sheffield hallam( uni| university)?|hallam( uni| university)?|shu|city campus|hallam city campus)$/, "Sheffield Hallam City Campus", /^Arundel Gate\/(AG\d+|Howard Street|Furnival Street|Charles Street)$|^Howard Street\//],
    [/^(the )?(collegiate( campus| crescent)?|hallam collegiate)$/, "Collegiate Campus", /^Ecclesall Road\/Collegiate Crescent$/],
    [/^(the )?(northern general( hospital)?|ngh)$/, "Northern General Hospital", /^Northern General Hospital\//],
    [/^(sheffield )?(the )?(interchange|bus station)$/, "Sheffield Interchange", /^Sheffield Interchange\//],
    [/^(sheffield )?(city centre|city center|town centre|town center|town|centre|center)$/, "Sheffield city centre", /^(Sheffield Interchange|Arundel Gate|Flat Street|Pond Street|Haymarket|Commercial Street|Snig Hill|Castle Street|Angel Street|Exchange Place|Paternoster Row|Rockingham Street|Waingate|Eyre Street|Moor Market|Charter Row|Furnival Gate)\/|\/(HS|CG|FS|SS|RS|AG)\d+[A-Z]?$|^Eyre Street\/Moor Market/],
  ];
  function areaItem(label, ids) {
    const key = `area:${label}`;
    let it = ctx.index.find((x) => x.key === key);
    if (!it && ids.length) { it = { kind: "stop", key, label, sub: `${ids.length} stops`, stops: ids, area: true }; ctx.index.push(it); }
    return it || null;
  }
  function stopsMatching(re) { const ids = []; ctx.B.stops.forEach(([n], i) => { if (re.test(n)) ids.push(i); }); return ids; }
  function streetArea(text) {           // "crookes" -> every Crookes/… stop, if they're close together
    const t = norm(text);
    if (!t || t.split(" ").length > 4) return null;
    const ids = []; let label = null;
    ctx.B.stops.forEach(([n], i) => { const pre = n.split("/")[0]; if (norm(pre) === t) { ids.push(i); label = pre; } });
    if (ids.length < 2) return null;
    let far = 0; for (const a of ids) for (const b of ids) far = Math.max(far, metres(a, b));
    return far <= 900 ? areaItem(label, ids) : null;
  }
  function areaByKey(key) {
    prepare();
    const label = key.replace(/^area:/, "");
    const lm = LANDMARKS.find((x) => x[1] === label);
    return lm ? areaItem(lm[1], stopsMatching(lm[2])) : streetArea(label);
  }
  function resolvePlace(text) {
    const t = norm(text).replace(/^(the|my) /, "").trim();
    for (const [re, label, stopsRe] of LANDMARKS) if (re.test(t)) { const it = areaItem(label, stopsMatching(stopsRe)); if (it) return { it, cover: 1 }; }
    const exact = ctx.index.find((x) => x.kind === "stop" && !x.area && norm(x.label) === t);
    if (exact) return { it: exact, cover: 1 };
    const st0 = streetArea(t);
    if (st0) return { it: st0, cover: 1 };
    return findStop(text, true);
  }
  const UNI_RE = /^(the )?(uni|university|college|campus)$/;

  function journeyParts(text) {
    const t = tripText(text);
    const back = t.match(/\bto\s+(.+?)\s+from\s+(.+)$/);
    if (back) { const a = resolvePlace(back[2]), b = resolvePlace(back[1]); if (a && b && a.it.key !== b.it.key) return { from: a.it, to: b.it }; }
    const m = t.match(/\bfrom\s+(.+?)\s+to\s+(.+)$/) || t.match(/^(?:how (?:do|can|would) i (?:get|go)|get|go|getting|going|travel|route|bus|buses)\s+(?:from\s+)?(.+?)\s+to\s+(.+)$/)
      || t.match(/^(.+?)\s+to\s+(.+?)$/);
    if (!m) return null;
    const a = resolvePlace(m[1]), b = resolvePlace(m[2]);
    return a && b && a.it.key !== b.it.key ? { from: a.it, to: b.it } : null;
  }
  function destinationOnly(text) {      // "how do i get to crystal peaks", "bus to meadowhall", "get to the city centre by 9am"
    const t = tripText(text);
    if (/\b(get|go|getting|going)\s+(back\s+)?home\b/.test(t)) return { home: "home" };
    const m = t.match(/\b(?:get|go|getting|going|travel|take me|way|route|journey|bus|buses|be|reach)\s+(?:back\s+)?(?:to|at|in)\s+(.+)$/) || t.match(/^to\s+(.+)$/);
    if (!m) return null;
    const place0 = m[1].replace(/^(the|my) /, "");
    if (/^(home|my house|house)\b/.test(place0)) return { home: "home" };
    if (/^(work|my work|the office|office|job)\b/.test(place0)) return { home: "work" };
    if (UNI_RE.test(place0)) return { uni: true };
    const b = resolvePlace(m[1]);
    return b ? { to: b.it } : null;
  }

  const has = (t, re) => re.test(t);
  function intentOf(t) {
    const s = {};
    const add = (k, v) => (s[k] = (s[k] || 0) + v);
    if (has(t, /^(hi|hello|hey|hiya|salam|salaam|assalam\w*|good (morning|afternoon|evening)|morning|evening|afternoon|yo|sup)\b/)) add("hello", 1);
    if (has(t, /\b(thanks|thank you|thank u|cheers|ta|nice one|great|perfect|appreciate\w*|legend)\b/)) add("thanks", 1);
    if (has(t, /\b(help|what can you do|how do i use|how to use|commands|examples?|what can i ask)\b/)) add("help", 2);
    if (has(t, /\b(next|when|what time|how long|coming|come|comes|due|arriv\w*|leav\w*|depart\w*|times?|timetable|schedule|wait\w*|soon|minutes? away|catch)\b/)) add("next", 2);
    if (has(t, /\b(where|location|located|find|track\w*|map|whereabouts|how far|far away|stops? away)\b/)) add("where", 2.2);
    if (has(t, /\b(late|lateness|delay\w*|on time|ontime|early|behind)\b/) || (has(t, /\brunning\b/) && !has(t, /\bhow many\b/))) add("late", 2.1);
    if (has(t, /\b(did|didnt|came|ran|turn(ed)? up|show(ed)? up|cancel\w*|missed|never came|no show|happened to)\b/)) add("came", 1.6);
    if (has(t, /\b(ghost\w*|never came|didnt (come|turn up|show)|no shows?)\b/)) add("ghost", 1.5);
    if (has(t, /\b(reliab\w*|unreliab\w*|worst|best|often|usually|trust\w*|chance|likely|probability|percentage|how good|how bad|record|history|ranking)\b/)) add("reliable", 2.3);
    if (has(t, /\b(problems?|issues?|disrupt\w*|trouble|anything wrong|whats wrong|what is wrong|alerts?)\b/)) add("problems", 2.5);
    if (has(t, /\bfirst\b/)) add("first", 2.6);
    if (has(t, /\blast\b/) && !has(t, /\blast (hour|hours|few|couple|week|night|\d+ (min|mins|minutes|hours|days))\b/)) add("last", 2.6);
    if (has(t, /\b(near|nearby|closest|nearest|around me|close to me|my location|where am i)\b/)) add("near", 3);
    if (has(t, /\b(today|network|overall|city|summary|status|how many|how are the buses|how is it going|stats|statistics)\b/)) add("today", 1.2);
    if (has(t, /\b(where does|where do|goes to|stops on|which stops|what stops|stops does|route of|path|stops)\b/)) add("info", 1.5);
    if (has(t, /\b(get to|go to|get from|get home|go home|travel|journey|how do i get|how can i get|take me|from .+ to|way to|route to|journey to|fastest|quickest|least walking|fewest changes|alternative)\b/)) add("plan", 2.2);
    if (has(t, /^(and )?(more|show me more|show more|after that|then|the one after|next one|later ones?|any more|others?)\b/) && t.split(" ").length <= 5) add("more", 3);
    if (has(t, /\b(tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekend|sundays|saturdays|next week|christmas|bank holiday)\b/)) add("future", 1);
    if (has(t, /\b(what is|what are|what does|what do|explain|meaning|mean|why|how does|how do you|how is|who|is this|are you|is it|can i|can you|does it|do you|how accurate)\b/)) add("faq", 1);
    return s;
  }

  // ------------------------------------------------------------ the data
  const now = () => ctx.now();
  const routeLabel = (ri) => `${ctx.B.routes[ri][0]}${opsFor(ctx.B.routes[ri][0]) > 1 ? ` (${ctx.B.routes[ri][1]})` : ""}`;
  const opsFor = (num) => (routeNums.get(num.toLowerCase()) || []).length;
  const tripsOf = (ris) => { const set = new Set(ris); return ctx.B.trips.map((t, i) => [t, i]).filter(([t]) => set.has(t[0])); };
  const whenText = (secs) => { const m = Math.round((secs - now()) / 60); return m <= 0 ? "due now" : m < 60 ? `in ${m} min` : `at ${ctx.hhmm(secs)}`; };
  const stopName = (it) => it.label;

  function callsAt(stopIds, ris) {         // every departure calling at a set of stops (not where it ends)
    const want = new Set(stopIds), routes = ris ? new Set(ris) : null, out = [];
    ctx.B.trips.forEach((t, i) => {
      if (routes && !routes.has(t[0])) return;
      const s = t[6];
      for (let k = 0; k < s.length - 2; k += 2) if (want.has(s[k])) { out.push({ i, secs: t[2] + s[k + 1] * 60, k: k / 2, stop: s[k] }); break; }
    });
    return out.sort((a, b) => a.secs - b.secs);
  }
  function upcoming(list) {
    return list.filter((d) => { const ex = ctx.expected(d.i, d.k, d.secs); const c = ctx.st(d.i); return !ex.passed && ex.secs >= now() - 60 && c !== "G" && c !== "R"; });
  }
  function describeDep(d, withRoute = true) {
    const ex = ctx.expected(d.i, d.k, d.secs), L = ctx.live(d.i), c = ctx.st(d.i);
    const r = ctx.routeOf(d.i)[0];
    let s = `${withRoute ? `the **${r}** to ${ctx.headsign(d.i)} ` : ""}${whenText(ex.secs)}`;
    if (c === "O" && L) s += L.delay > 1 ? ` (tracked by GPS, ${L.delay} min late, timetabled ${ctx.hhmm(d.secs)})` : L.delay < -1 ? ` (tracked by GPS, ${-L.delay} min early)` : " (tracked by GPS, on time)";
    else if (ctx.risk?.(d.i)?.level === "high") s += ` (**may not come**: ${ctx.risk(d.i).why[0]})`;
    else if (c === "P") s += " (timetable only, no bus seen on it yet)";
    else s += " (timetable)";
    return s;
  }
  const extraFor = (it) => (d) => (it && it.stops.length > 1 ? `${ctx.routeOf(d.i)[1]} · stand ${ctx.B.stops[d.stop][0].split("/").pop()}` : ctx.routeOf(d.i)[1]);
  const stopAction = (it) => ({ label: `Open ${stopName(it)}`, href: ctx.href("stop", it.key) });
  const routeAction = (ri) => ({ label: `Open route ${ctx.B.routes[ri][0]}`, href: ctx.href("route", ctx.slug(`${ctx.B.routes[ri][0]}-${ctx.B.routes[ri][1]}`)) });

  // ------------------------------------------------------------ answers
  function answerNext(stop, ris, offset = 0) {
    const all = callsAt(stop.stops, ris);
    const up = upcoming(all);
    memo.list = { kind: "next", stop, ris, up }; memo.offset = offset;
    if (!all.length && ris) {
      const serving = [...new Set(callsAt(stop.stops).map((d) => ctx.routeOf(d.i)[0]))];
      return { say: [`Route ${ris.map(routeLabel).join(" / ")} doesn’t stop at **${stopName(stop)}** today.${serving.length ? ` Routes that do: ${serving.slice(0, 14).join(", ")}.` : ""}`], actions: [stopAction(stop)] };
    }
    if (!up.length) {
      const last = all.at(-1);
      return { say: [`No more ${ris ? `route ${ris.map(routeLabel).join("/")} ` : ""}buses from **${stopName(stop)}** today.${last ? ` The last one was due at ${ctx.hhmm(last.secs)}.` : ""}`], actions: [stopAction(stop)] };
    }
    const show = up.slice(offset, offset + 5);
    if (!show.length) return { say: ["That’s all for today from there."], actions: [stopAction(stop)] };
    const first = show[0];
    const lines = [`${offset ? "After that" : "Next"} from **${stopName(stop)}**: ${describeDep(first, true)}.`];
    if (show[1]) lines.push(`Then ${show.slice(1, 3).map((d) => describeDep(d, true)).join(", and ")}.`);
    const ghostsToday = all.filter((d) => ctx.st(d.i) === "G").length;
    if (!offset && ghostsToday) lines.push(`Heads up: ${ghostsToday} bus${ghostsToday === 1 ? "" : "es"} timetabled here today never came.`);
    return { say: lines, rows: show.map((d) => ({ i: d.i, secs: d.secs, k: d.k, extra: extraFor(stop)(d) })), actions: [stopAction(stop)],
      chips: ["Show me more", ris ? `Where is the ${ctx.B.routes[ris[0]][0]} now?` : `How reliable is this stop?`] };
  }

  function answerWhere(ris, stop) {
    const trips = tripsOf(ris);
    const onRoad = trips.filter(([, i]) => ctx.live(i));
    const name = ris.map(routeLabel).join(" / ");
    if (stop) {
      const coming = upcoming(callsAt(stop.stops, ris)).filter((d) => ctx.live(d.i));
      if (!coming.length) {
        const next = upcoming(callsAt(stop.stops, ris))[0];
        return { say: [`None of the **${name}** buses on the road right now is on its way to **${stopName(stop)}**.${next ? ` The next one is timetabled there ${whenText(next.secs)} (${ctx.hhmm(next.secs)}).` : " There are no more there today."}`],
          rows: next ? [{ i: next.i, secs: next.secs, k: next.k }] : [], actions: [stopAction(stop)] };
      }
      if (coming.length) {
        const d = coming[0], L = ctx.live(d.i), away = Math.max(0, d.k - Math.ceil(L.pos));
        const far = away === 0 ? "just about there" : `about ${away} stop${away === 1 ? "" : "s"} away`;
        return { say: [`The next **${name}** to **${stopName(stop)}** is ${ctx.whereIs(d.i)}, ${far}, ${ctx.delayText(L.delay)}. It should reach ${stopName(stop)} ${whenText(ctx.expected(d.i, d.k, d.secs).secs)}.`],
          rows: coming.slice(0, 3).map((x) => ({ i: x.i, secs: x.secs, k: x.k, extra: ctx.whereIs(x.i) })), actions: [{ label: "Follow it on the map", href: `#/trip/${d.i}` }, stopAction(stop)] };
      }
    }
    if (!onRoad.length) {
      const next = trips.filter(([t, i]) => t[2] >= now() && ctx.st(i) !== "G").sort((a, b) => a[0][2] - b[0][2])[0];
      return { say: [`No **${name}** is on the road right now that we can see.${next ? ` The next one leaves ${ctx.shortStop(next[0][4])} ${whenText(next[0][2])}.` : " There are no more today."}`],
        actions: ris.slice(0, 2).map(routeAction) };
    }
    const list = onRoad.sort((a, b) => ctx.live(b[1]).delay - ctx.live(a[1]).delay);
    const say = [`${onRoad.length} **${name}** bus${onRoad.length === 1 ? " is" : "es are"} on the road right now:`,
      ...list.slice(0, 4).map(([, i]) => `• to ${ctx.headsign(i)}: ${ctx.whereIs(i)}, ${ctx.delayText(ctx.live(i).delay)}.`)];
    return { say, rows: list.slice(0, 5).map(([t, i]) => ({ i, secs: t[2], k: 0, extra: ctx.whereIs(i) })), actions: ris.slice(0, 2).map(routeAction), chips: [`Is the ${ctx.B.routes[ris[0]][0]} reliable?`] };
  }

  function answerRouteNext(ris) {
    const trips = tripsOf(ris), n = now();
    const dirs = new Map();
    for (const [t, i] of trips) { const c = ctx.st(i); if (t[2] < n - 60 || c === "G" || c === "R") continue; if (!dirs.has(t[1])) dirs.set(t[1], []); dirs.get(t[1]).push([t, i]); }
    const name = ris.map(routeLabel).join(" / ");
    if (!dirs.size) return { say: [`There are no more **${name}** departures today.`], actions: ris.slice(0, 2).map(routeAction) };
    const say = [`Next **${name}** departures:`], rows = [];
    for (const list of dirs.values()) {
      list.sort((a, b) => a[0][2] - b[0][2]);
      const [t, i] = list[0];
      say.push(`• towards ${ctx.headsign(i)}: leaves ${ctx.shortStop(t[4])} ${whenText(t[2])}${list[1] ? `, then ${ctx.hhmm(list[1][0][2])}` : ""}.`);
      rows.push({ i, secs: t[2], k: 0, extra: `from ${ctx.shortStop(t[4])}` });
    }
    const on = trips.filter(([, i]) => ctx.live(i)).length;
    if (on) say.push(`${on} ${name} bus${on === 1 ? " is" : "es are"} on the road now. Tell me your stop and I’ll tell you when one reaches it.`);
    return { say, rows: rows.slice(0, 4), actions: ris.slice(0, 2).map(routeAction), chips: [`Where is the ${ctx.B.routes[ris[0]][0]} now?`] };
  }

  function answerGhosts(ris, stop) {
    let list = ctx.B.trips.map((t, i) => [t, i]).filter(([, i]) => ctx.st(i) === "G");
    if (ris) { const set = new Set(ris); list = list.filter(([t]) => set.has(t[0])); }
    let rows;
    if (stop) rows = callsAt(stop.stops, ris).filter((d) => ctx.st(d.i) === "G").map((d) => ({ i: d.i, secs: d.secs, k: d.k }));
    else rows = list.map(([t, i]) => ({ i, secs: t[2], k: 0, extra: `from ${ctx.shortStop(t[4])}` }));
    const where = stop ? ` at **${stopName(stop)}**` : ris ? ` on route **${ris.map(routeLabel).join(" / ")}**` : " in Sheffield";
    if (!rows.length) return { say: [`No ghost buses${where} so far today. Every bus that was due and could be checked has turned up.`] };
    rows.sort((a, b) => b.secs - a.secs);
    const say = [`${rows.length} bus${rows.length === 1 ? "" : "es"}${where} never came so far today. Latest: ${rows.slice(0, 3).map((r) => `the ${ctx.hhmm(r.secs)} ${ctx.routeOf(r.i)[0]} to ${ctx.headsign(r.i)}`).join(", ")}.`];
    if (!ris && !stop) {
      const by = new Map(); for (const [t] of list) by.set(t[0], (by.get(t[0]) || 0) + 1);
      const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 4);
      say.push(`Most ghost buses today: ${top.map(([ri, k]) => `${ctx.B.routes[ri][0]} ${ctx.B.routes[ri][1].split(" ")[0]} (${k})`).join(", ")}.`);
    }
    return { say, rows: rows.slice(0, 5), actions: stop ? [stopAction(stop)] : ris ? ris.slice(0, 2).map(routeAction) : [{ label: "Network page", href: "#/network" }] };
  }

  function answerProblems(ris) {
    const n = now();
    const scan = ris || [...new Set(ctx.B.trips.map((t) => t[0]))];
    const found = [];
    for (const ri of scan) {
      const trips = tripsOf([ri]);
      const g2 = trips.filter(([t, i]) => ctx.st(i) === "G" && t[3] >= n - 7200).length;
      const gT = trips.filter(([, i]) => ctx.st(i) === "G").length;
      const live = trips.filter(([, i]) => ctx.live(i));
      const late = live.filter(([, i]) => ctx.live(i).delay >= 10).length;
      const why = [];
      if (g2) why.push(`${g2} bus${g2 === 1 ? "" : "es"} didn’t turn up in the last 2 hours`);
      if (late) why.push(`${late} of ${live.length} on the road are 10+ min late`);
      if (why.length || ris) found.push({ ri, why, gT, live: live.length });
    }
    if (ris) {
      return { say: found.map((f) => (f.why.length ? `Route **${routeLabel(f.ri)}**: ${f.why.join(", and ")}.`
        : `No problems on route **${routeLabel(f.ri)}** right now: ${f.live} bus${f.live === 1 ? "" : "es"} on the road, ${f.gT ? `${f.gT} missed earlier today` : "none missed today"}.`)),
        actions: ris.slice(0, 2).map(routeAction) };
    }
    const bad = found.filter((f) => f.why.length).sort((a, b) => b.why.length - a.why.length);
    return { say: bad.length ? ["Routes with problems right now:", ...bad.slice(0, 6).map((f) => `• **${routeLabel(f.ri)}**: ${f.why.join(", ")}.`)] : ["No routes have problems right now. Buses are turning up and nothing is badly late."],
      actions: bad.slice(0, 3).map((f) => routeAction(f.ri)) };
  }

  function answerOperator(op, t) {
    const ris = ctx.B.routes.map((r, ri) => [r, ri]).filter(([r]) => r[1] === op).map(([, ri]) => ri);
    const trips = tripsOf(ris);
    const ran = trips.filter(([, i]) => "RO".includes(ctx.st(i))).length, gh = trips.filter(([, i]) => ctx.st(i) === "G").length;
    const live = trips.filter(([, i]) => ctx.live(i)).map(([, i]) => ctx.live(i).delay);
    const hist = ctx.R.filter((r) => r.operator === op && r.judged);
    const judged = hist.reduce((a, r) => a + r.judged, 0), ghosts = hist.reduce((a, r) => a + r.ghosts, 0);
    const avg = live.length ? live.reduce((a, b) => a + b, 0) / live.length : null;
    const say = [`**${op}** runs ${ris.length} route${ris.length === 1 ? "" : "s"} here.${judged ? ` Over the days checked, ${ctx.pct(1 - ghosts / judged)} of its buses ran (${ctx.num(ghosts)} of ${ctx.num(judged)} never came).` : ""}`,
      `Today: ${ctx.num(ran)} ran, ${ctx.num(gh)} never came.${avg != null ? ` ${live.length} on the road now, ${avg >= 0 ? `${avg.toFixed(1)} min late` : `${(-avg).toFixed(1)} min early`} on average.` : ""}`];
    const worst = hist.filter((r) => r.judged >= 50).sort((a, b) => b.rate - a.rate).slice(0, 3);
    if (worst.length) say.push(`Its least reliable routes: ${worst.map((r) => `${r.route} (${ctx.pct(r.rate)} never ran)`).join(", ")}.`);
    return { say, actions: [{ label: "Network page", href: "#/network" }] };
  }

  function answerLate(ris, stop) {
    if (stop && !ris) {
      const coming = upcoming(callsAt(stop.stops)).filter((d) => ctx.live(d.i)).slice(0, 6);
      if (!coming.length) return answerNext(stop);
      return { say: [`Buses on their way to **${stopName(stop)}**:`, ...coming.map((d) => `• ${ctx.routeOf(d.i)[0]} to ${ctx.headsign(d.i)}: ${ctx.delayText(ctx.live(d.i).delay)}, ${whenText(ctx.expected(d.i, d.k, d.secs).secs)}.`)],
        rows: coming.map((d) => ({ i: d.i, secs: d.secs, k: d.k })), actions: [stopAction(stop)] };
    }
    if (!ris) {
      const L = ctx.S.live || [];
      const late = L.filter((x) => x[1] >= 5).sort((a, b) => b[1] - a[1]);
      const avg = L.length ? L.reduce((a, x) => a + x[1], 0) / L.length : 0;
      return { say: [`Of the ${L.length} buses we’re tracking right now, ${late.length} are 5 or more minutes late. On average buses are ${avg >= 0 ? `${avg.toFixed(1)} min late` : `${(-avg).toFixed(1)} min early`}.`,
        late.length ? `Most delayed: ${late.slice(0, 3).map((x) => `${ctx.routeOf(x[0])[0]} to ${ctx.headsign(x[0])} (${x[1]} min)`).join(", ")}.` : ""].filter(Boolean),
        rows: late.slice(0, 4).map((x) => ({ i: x[0], secs: ctx.B.trips[x[0]][2], k: 0, extra: ctx.whereIs(x[0]) })) };
    }
    const onRoad = tripsOf(ris).filter(([, i]) => ctx.live(i));
    if (!onRoad.length) return answerWhere(ris, stop);
    const d = onRoad.map(([, i]) => ctx.live(i).delay), avg = d.reduce((a, x) => a + x, 0) / d.length;
    const verdict = avg > 5 ? "running late" : avg > 2 ? "a little late" : avg < -2 ? "running early" : "running about on time";
    return { say: [`Route **${ris.map(routeLabel).join(" / ")}** is ${verdict}: ${onRoad.length} bus${onRoad.length === 1 ? "" : "es"} on the road, ${avg >= 0 ? `${avg.toFixed(1)} min late` : `${(-avg).toFixed(1)} min early`} on average (from ${Math.min(...d)} to ${Math.max(...d)} min).`],
      rows: onRoad.slice(0, 5).map(([t, i]) => ({ i, secs: t[2], k: 0, extra: ctx.whereIs(i) })), actions: ris.slice(0, 2).map(routeAction) };
  }

  const VERDICT = { R: "ran: a bus was seen doing it", O: "is on the road right now", G: "**never came**: no bus was seen anywhere on the trip, while the operator was reporting its other buses",
    P: "should be running but hasn’t been confirmed yet (some operators only show up once the trip is over)", S: "isn’t due yet", N: "can’t be checked: the operator wasn’t reporting its buses then" };
  function answerCame(ris, stop, time) {
    let cands;
    if (stop) cands = callsAt(stop.stops, ris);
    else if (ris) cands = tripsOf(ris).map(([t, i]) => ({ i, secs: t[2], k: 0 }));
    else return { say: ["Which bus do you mean? Tell me the route and roughly when, for example “did the 7:15 52 come?” or “did the 52 come at Arundel Gate?”"], chips: ["Did the last 52 come?"] };
    if (!cands.length) return { say: ["I couldn’t find that bus in today’s timetable."] };
    let pick;
    if (time != null) pick = [...cands].sort((a, b) => Math.abs(a.secs - time) - Math.abs(b.secs - time))[0];
    else pick = cands.filter((d) => d.secs <= now()).at(-1) || cands[0];
    const c = ctx.st(pick.i);
    const near = time != null && Math.abs(pick.secs - time) > 600 ? ` (the closest one I can find to ${ctx.hhmm(time)})` : "";
    const where = stop ? ` at ${stopName(stop)}` : ` from ${ctx.shortStop(ctx.B.trips[pick.i][4])}`;
    const say = [`The **${ctx.routeOf(pick.i)[0]}** to ${ctx.headsign(pick.i)}, due${where} at ${ctx.hhmm(pick.secs)}${near}, ${VERDICT[c]}.`];
    if (c === "O") say.push(`It’s ${ctx.delayText(ctx.live(pick.i).delay)}, ${ctx.whereIs(pick.i)}.`);
    const route = tripsOf([ctx.B.trips[pick.i][0]]), gh = route.filter(([, i]) => ctx.st(i) === "G").length;
    if (gh) say.push(`Route ${ctx.routeOf(pick.i)[0]} has had ${gh} ghost bus${gh === 1 ? "" : "es"} today.`);
    return { say, rows: [{ i: pick.i, secs: pick.secs, k: pick.k }], actions: [{ label: "Open this trip", href: `#/trip/${pick.i}` }] };
  }

  function answerReliable(ris, stop) {
    if (ris) {
      const say = [];
      for (const ri of ris.slice(0, 3)) {
        const [num, op] = ctx.B.routes[ri], h = ctx.RI[ctx.slug(`${num}-${op}`)];
        const today = tripsOf([ri]), ran = today.filter(([, i]) => "RO".includes(ctx.st(i))).length, gh = today.filter(([, i]) => ctx.st(i) === "G").length;
        say.push(h && h.judged ? `Route **${num}** (${op}) ran **${ctx.pct(1 - h.rate)}** of the ${ctx.num(h.judged)} departures checked so far: ${ctx.num(h.ghosts)} never came.${rank(h)} Today: ${ran} ran, ${gh} never came.`
          : `Route **${num}** (${op}) doesn’t have enough checked departures yet to say. Today: ${ran} ran, ${gh} never came.`);
      }
      return { say, actions: ris.slice(0, 2).map((ri) => ({ ...routeAction(ri), href: `${routeAction(ri).href}/history`, label: `History of the ${ctx.B.routes[ri][0]}` })) };
    }
    if (stop) {
      const all = callsAt(stop.stops), done = all.filter((d) => "ROG".includes(ctx.st(d.i)));
      const gh = all.filter((d) => ctx.st(d.i) === "G").length;
      const byRoute = new Map(); for (const d of all) { const r = ctx.routeOf(d.i); byRoute.set(`${r[0]}|${r[1]}`, r); }
      const scored = [...byRoute.values()].map((r) => [r, ctx.RI[ctx.slug(`${r[0]}-${r[1]}`)]]).filter(([, h]) => h && h.judged >= 30).sort((a, b) => b[1].rate - a[1].rate);
      return { say: [`At **${stopName(stop)}** today, ${done.length - gh} of ${done.length} buses that are due so far have run and ${gh} never came.`,
        scored.length ? `Least reliable routes here: ${scored.slice(0, 3).map(([r, h]) => `${r[0]} (${ctx.pct(h.rate)} never ran)`).join(", ")}. Most reliable: ${scored.slice(-2).reverse().map(([r, h]) => `${r[0]} (${ctx.pct(1 - h.rate, 0)} ran)`).join(", ")}.` : ""].filter(Boolean),
        actions: [{ label: "Stop stats", href: `${ctx.href("stop", stop.key)}/stats` }] };
    }
    const top = ctx.R.filter((r) => r.judged >= 50 && r.rate != null).sort((a, b) => b.rate - a.rate);
    const s = ctx.SUM, w = s?.last7?.judged ? s.last7 : s;
    return { say: [w ? `Across Sheffield, ${ctx.pct(w.ghost_rate)} of checked buses never came over the last ${s.days >= 7 ? "7 days" : `${s.days} days`} (${ctx.num(w.ghosts)} of ${ctx.num(w.judged)}).` : "",
      `Least reliable routes: ${top.slice(0, 5).map((r) => `${r.route} ${r.operator.split(" ")[0]} (${ctx.pct(r.rate)})`).join(", ")}.`,
      `Most reliable: ${top.slice(-3).reverse().map((r) => `${r.route} (${ctx.pct(1 - r.rate, 0)} ran)`).join(", ")}.`].filter(Boolean),
      actions: [{ label: "Reliability page", href: "#/reliability" }] };
  }
  function rank(h) {
    const all = ctx.R.filter((r) => r.judged >= 50 && r.rate != null).sort((a, b) => b.rate - a.rate);
    const k = all.findIndex((r) => r.id === h.id);
    return k >= 0 && k < 10 ? ` That makes it the ${["", "2nd ", "3rd ", "4th ", "5th ", "6th ", "7th ", "8th ", "9th ", "10th "][k]}least reliable route in Sheffield.` : "";
  }

  function answerFirstLast(which, ris, stop) {
    let list = stop ? callsAt(stop.stops, ris) : ris ? tripsOf(ris).map(([t, i]) => ({ i, secs: t[2], k: 0 })).sort((a, b) => a.secs - b.secs) : null;
    if (!list) return { say: ["First or last bus on which route, or from which stop? For example “last 52 from Arundel Gate”."], chips: ["Last bus from Sheffield Interchange"] };
    if (!list.length) return { say: ["I couldn’t find that in today’s timetable."] };
    const d = which === "first" ? list[0] : list.at(-1);
    const soon = d.secs > now() && d.secs - now() < 3600 ? ` That’s ${whenText(d.secs)}.` : d.secs < now() ? " It has already gone." : "";
    const lead = stop ? `The ${which} ${ris ? `**${ris.map(routeLabel).join("/")}** ` : "bus "}from **${stopName(stop)}** today is the ${ctx.routeOf(d.i)[0]} to ${ctx.headsign(d.i)} at **${ctx.hhmm(d.secs)}**.`
      : `The ${which} **${ris.map(routeLabel).join("/")}** today leaves ${ctx.shortStop(ctx.B.trips[d.i][4])} at **${ctx.hhmm(d.secs)}**, towards ${ctx.headsign(d.i)}.`;
    return { say: [lead + soon],
      rows: [{ i: d.i, secs: d.secs, k: d.k }] };
  }

  function answerInfo(ris) {
    const say = [];
    for (const ri of ris.slice(0, 2)) {
      const trips = tripsOf([ri]);
      const dirs = new Map();
      for (const [t, i] of trips) { if (!dirs.has(t[1])) dirs.set(t[1], []); dirs.get(t[1]).push([t, i]); }
      const parts = [...dirs.values()].map((ts) => {
        const longest = ts.sort((a, b) => b[0][6].length - a[0][6].length)[0];
        const cs = ctx.calls(longest[1]);
        const via = cs.length > 4 ? cs.filter((_, k) => k && k < cs.length - 1).filter((_, k, a) => k % Math.ceil(a.length / 3) === 0).map((c) => ctx.shortStop(ctx.B.stops[c.stop][0])) : [];
        const n = ts.filter(([t]) => t[2] >= now() - 1800 && t[2] <= now() + 1800).length;
        return `from ${ctx.shortStop(longest[0][4])} to ${ctx.shortStop(longest[0][5])}${via.length ? `, via ${via.join(", ")}` : ""} (${cs.length} stops in the city; ${n ? `about ${n} an hour right now` : `${ts.length} a day`})`;
      });
      say.push(`Route **${ctx.B.routes[ri][0]}** (${ctx.B.routes[ri][1]}) runs ${parts.join("; and back ")}.`);
    }
    return { say, actions: ris.slice(0, 2).map(routeAction) };
  }

  // journey planning: direct, or with one change
  const place = (x) => ctx.shortStop(ctx.B.stops[x][0]);
  const cellOf = (x) => `${Math.round(ctx.B.stops[x][1] / 0.0027)}:${Math.round(ctx.B.stops[x][2] / 0.0045)}`;   // ~300 m squares
  function metres(x, y) {
    const [, la1, lo1] = ctx.B.stops[x], [, la2, lo2] = ctx.B.stops[y];
    return Math.hypot((lo1 - lo2) * 111320 * Math.cos((la1 * Math.PI) / 180), (la1 - la2) * 110540);
  }
  // Journey planning. Every journey from A to B in the window, direct or with one change (at the same stop or
  // a short walk away: up to 300 m at 1.2 m/s, plus a minute to find the stop). Then the best few, each for a
  // different reason: fastest (or leave latest, for "arrive by"), most reliable, least walking, fewest changes.
  // Nothing is made up: times come from the timetable and the buses' GPS. Delay estimates for buses that
  // aren't tracked yet are labelled as estimates.
  function legP(i) {                      // how likely this bus is to run: GPS-tracked, or its route's record
    if (ctx.st(i) === "O") return 0.99;
    const r = ctx.reliab(i); let p = r == null ? 0.95 : Math.max(0.5, r);
    if (ctx.risk?.(i)?.level === "medium") p *= 0.85;
    return p;
  }
  function estDelay(i) {
    const L = ctx.live(i);
    if (L) return { d: Math.max(0, L.delay), live: true };
    const e = ctx.routeDelay?.(i);
    return e && e.d >= 3 ? { d: e.d, live: false, n: e.n } : { d: 0, live: false };
  }
  function journeys(from, to, opt = {}) {
    const tNow = now(), by = opt.by ?? null;
    const t0 = opt.after != null ? Math.max(opt.after, tNow - 60) : by != null ? Math.max(tNow - 60, by - 3 * 3600) : tNow - 60;
    const tMax = by != null ? by : t0 + 3 * 3600;
    const A = new Set(from.stops), Bset = new Set(to.stops);
    const out = [], firstLeg = new Map(), cells = new Map();
    const usable = (i) => { const c = ctx.st(i); return c !== "G" && c !== "R" && ctx.risk?.(i)?.level !== "high"; };
    const legOf = (i, ka, secsA, dep, kb, arr, dl) => ({ i, kA: ka, secsA, dep, kB: kb, arr, est: !dl.live && dl.d > 0, estN: dl.n || 0, estD: dl.d });
    const mk = (legs, walk = 0, buffer = null) => {
      let p = legs.reduce((a, l) => a * legP(l.i), 1);
      if (legs.length > 1) p *= buffer < 120 ? 0.75 : buffer < 300 ? 0.9 : 1;
      return { legs, dep: legs[0].dep, arr: legs.at(-1).arr, walk, changes: legs.length - 1, buffer, p, key: legs.map((l) => l.i).join("+") };
    };
    ctx.B.trips.forEach((t, i) => {
      if (!usable(i)) return;
      const s = t[6]; let ka = -1, depA = 0, secsA = 0, dl = null;
      for (let k = 0; k < s.length; k += 2) {
        const secs = t[2] + s[k + 1] * 60;
        if (ka < 0) {
          if (!A.has(s[k]) || k >= s.length - 2) continue;
          const ex = ctx.expected(i, k / 2, secs);
          if (ex.passed || ex.secs < t0 || ex.secs > tMax) break;
          ka = k; depA = ex.secs; secsA = secs; dl = estDelay(i);
          continue;
        }
        const arr = secs + dl.d * 60;
        if (Bset.has(s[k])) { if (by == null || arr <= by) out.push(mk([legOf(i, ka / 2, secsA, depA, k / 2, arr, dl)])); break; }
        if (!firstLeg.has(s[k])) { firstLeg.set(s[k], []); const c = cellOf(s[k]); if (!cells.has(c)) cells.set(c, new Set()); cells.get(c).add(s[k]); }
        firstLeg.get(s[k]).push({ ...legOf(i, ka / 2, secsA, depA, k / 2, arr, dl), stop: s[k] });
      }
    });
    const near = (x) => {
      const [a, b] = cellOf(x).split(":").map(Number), res = [];
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (const y of cells.get(`${a + da}:${b + db}`) || []) res.push(y);
      return res;
    };
    ctx.B.trips.forEach((t, i) => {
      if (!usable(i)) return;
      const s = t[6]; let best = null;
      for (let k = 0; k < s.length - 2; k += 2) {
        if (Bset.has(s[k])) break;
        const secs = t[2] + s[k + 1] * 60;
        if (secs < t0 - 3600 || secs > tMax + 3600) continue;
        const ex = ctx.expected(i, k / 2, secs);
        if (ex.passed) continue;
        for (const y of near(s[k])) {
          const legs = firstLeg.get(y); if (!legs) continue;
          const walk = y === s[k] ? 0 : metres(y, s[k]);
          if (walk > 300) continue;
          // of the first buses that make this connection, the one that lets you leave latest (least waiting)
          for (const leg of legs) {
            if (leg.i === i || ctx.B.trips[leg.i][0] === t[0]) continue;
            const ready = leg.arr + (walk ? walk / 1.2 + 60 : 60);
            if (ex.secs < ready || ex.secs > leg.arr + 40 * 60) continue;
            if (!best || leg.dep > best.leg.dep || (leg.dep === best.leg.dep && walk < best.walk)) best = { leg, k, dep: ex.secs, secs, walk, buffer: ex.secs - ready };
          }
        }
        if (best) break;
      }
      if (!best) return;
      const dl = estDelay(i);
      for (let j = best.k + 2; j < s.length; j += 2) if (Bset.has(s[j])) {
        const arr = t[2] + s[j + 1] * 60 + dl.d * 60;
        if (by == null || arr <= by) out.push(mk([best.leg, { ...legOf(i, best.k / 2, best.secs, best.dep, j / 2, arr, dl), at: s[best.k] }], best.walk, best.buffer));
        break;
      }
    });
    return { list: out, by, t0 };
  }

  // the few journeys worth showing, each with the reason it's there
  function pickOptions(list, by) {
    if (!list.length) return [];
    const picks = new Map();
    const add = (j, tag, why) => { if (!j) return; const o = picks.get(j.key) || { j, tags: [], why: [] }; o.tags.push(tag); o.why.push(why); picks.set(j.key, o); };
    const byArr = [...list].sort((a, b) => a.arr - b.arr || b.dep - a.dep);
    const first = byArr[0];
    let lead;
    if (by != null) {
      const safe = list.filter((j) => j.p >= 0.9 && by - j.arr >= 120);
      lead = [...(safe.length ? safe : list)].sort((a, b) => b.dep - a.dep || a.arr - b.arr)[0];
      add(lead, "Leave latest", `The latest you can leave and still get there by ${ctx.hhmm(by)} (about ${Math.round((by - lead.arr) / 60)} min to spare).`);
    } else {
      lead = first;
      add(lead, "Fastest", `Gets you there first, at about ${ctx.hhmm(lead.arr)}.`);
    }
    const cap = (m) => (by != null ? list : list.filter((j) => j.arr <= first.arr + m * 60));
    const rel = [...cap(20)].sort((a, b) => b.p - a.p || a.arr - b.arr)[0];
    if (rel && rel.p > lead.p + 0.03) add(rel, "Most reliable", `${pctOf(rel.p)} likely to work out, against ${pctOf(lead.p)} for the ${by != null ? "latest" : "fastest"} option.`);
    else add(lead, "Most reliable", `Also the most reliable choice right now (${pctOf(lead.p)} likely to work out).`);
    if (list.some((j) => j.walk > 0)) {
      const w = [...cap(30)].sort((a, b) => a.walk - b.walk || a.arr - b.arr)[0];
      add(w, "Least walking", w.walk ? `Only about ${roundM(w.walk)} m of walking.` : "No walking between stops.");
    }
    if (list.some((j) => j.changes > 0)) {
      const c = [...cap(45)].sort((a, b) => a.changes - b.changes || a.arr - b.arr)[0];
      add(c, "Fewest changes", c.changes ? "Only one change." : "A direct bus, no changes.");
    }
    return [...picks.values()];
  }
  const pctOf = (p) => `${Math.round(p * 100)}%`;
  const roundM = (m) => Math.max(50, Math.round(m / 50) * 50);

  function warnings(j, by) {
    const w = [];
    if (j.changes && j.buffer != null && j.buffer < 180) w.push(`Tight change: about ${Math.max(0, Math.round(j.buffer / 60))} min at ${place(j.legs[1].at)}. If the ${ctx.routeOf(j.legs[0].i)[0]} is late you could miss the ${ctx.routeOf(j.legs[1].i)[0]}.`);
    for (const l of j.legs) if (l.est) w.push(`The ${ctx.routeOf(l.i)[0]} isn’t tracked yet. Arrival includes about ${l.estD} min, because the other ${ctx.routeOf(l.i)[0]}s on the road are running that late (estimate).`);
    for (const l of j.legs) { const rk = ctx.risk?.(l.i); if (rk?.level === "medium") w.push(`The ${ctx.routeOf(l.i)[0]} has been unreliable: ${rk.why[0]}.`); }
    if (by != null && by - j.arr < 180) w.push(`Only ${Math.max(0, Math.round((by - j.arr) / 60))} min to spare before ${ctx.hhmm(by)}.`);
    return w;
  }
  function legState(l) {
    const L = ctx.live(l.i);
    if (L) return L.delay > 1 ? `GPS: ${L.delay} min late` : L.delay < -1 ? `GPS: ${-L.delay} min early` : "GPS: on time";
    const r = ctx.reliab(l.i);
    return `timetable${r != null ? `, runs ${Math.round(r * 100)}%` : ""}`;
  }
  const leaveText = (l) => (l.dep - now() >= 3600 ? `at ${ctx.hhmm(l.dep)} (${legState(l)})` : `${whenText(l.dep)} (${ctx.hhmm(l.dep)}, ${legState(l)})`);
  const callStop = (l, k) => ctx.B.trips[l.i][6][k * 2];
  function journeyText(j, fromN0, toN0, from, to) {
    const a = j.legs[0], r1 = ctx.routeOf(a.i)[0];
    const fromN = from?.area ? `${fromN0} (${ctx.B.stops[callStop(a, a.kA)][0]})` : fromN0;
    const toN = to?.area ? `${toN0} (${ctx.B.stops[callStop(j.legs.at(-1), j.legs.at(-1).kB)][0]})` : toN0;
    if (!j.changes) return `Take the **${r1}** to ${ctx.headsign(a.i)} from ${fromN} ${leaveText(a)}. It gets to ${toN} at about **${ctx.hhmm(j.arr)}**, ${Math.round((j.arr - a.dep) / 60)} min on the bus.`;
    const b = j.legs[1], off = place(ctx.B.trips[a.i][6][a.kB * 2]), on = place(b.at);
    const walkText = j.walk ? `, walk about ${roundM(j.walk)} m to ${ctx.B.stops[b.at][0]}` : "";
    return `Take the **${r1}** from ${fromN} ${leaveText(a)} to **${off}** (about ${ctx.hhmm(a.arr)})${walkText}, then the **${ctx.routeOf(b.i)[0]}** from ${on} at ${ctx.hhmm(b.dep)}. You’d reach ${toN} at about **${ctx.hhmm(j.arr)}**, ${Math.round((j.arr - a.dep) / 60)} min in all.`;
  }
  function legRows(j, toN) {
    return j.legs.map((l, n) => ({ i: l.i, secs: l.secsA, k: l.kA, extra: n === j.legs.length - 1 ? `arrives ${toN || place(callStop(l, l.kB))} ${ctx.hhmm(l.arr)}` : `get off at ${place(ctx.B.trips[l.i][6][l.kB * 2])} ${ctx.hhmm(l.arr)}` }));
  }
  const PREF_TAG = { fast: "Fastest", reliable: "Most reliable", walk: "Least walking", changes: "Fewest changes" };
  function options(from, to, opt = {}) {
    const { list, by } = journeys(from, to, opt);
    const fromN = stopName(from), toN = stopName(to);
    const opts = pickOptions(list, by).map((o) => ({ ...o, text: journeyText(o.j, fromN, toN, from, to), warn: warnings(o.j, by), rows: legRows(o.j, to.area ? null : toN) }));
    return { opts, by, fromN, toN, from, to };
  }

  function plan(from, to, opt = {}) {
    const r = options(from, to, opt), { opts, fromN, toN, by } = r;
    if (!opts.length) {
      if (by != null) {
        const any = options(from, to, { after: opt.after });
        const e = any.opts.find((o) => o.tags.includes("Fastest"));
        if (e) return { say: [`You can’t get from **${fromN}** to **${toN}** by ${ctx.hhmm(by)} by bus now. The earliest you’d get there is about **${ctx.hhmm(e.j.arr)}**.`, e.text], rows: e.rows, options: any.opts, actions: [stopAction(from), stopAction(to)] };
      }
      return { say: [`I can’t find a bus from **${fromN}** to **${toN}** ${opt.after != null ? `after ${ctx.hhmm(opt.after)}` : "in the next few hours"}, direct or with one change. Try a nearby stop, or open the stop to see where its buses go.`], actions: [stopAction(from)] };
    }
    const want = PREF_TAG[opt.pref];
    const main = (want && opts.find((o) => o.tags.includes(want))) || opts[0];
    const say = [];
    if (opt.alt) say.push("Here are your options, best first. Buses that look like they won’t come are already left out.");
    if (opt.pref === "changes" && main.j.changes) say.push("There’s no direct bus in this window, so this one has a single change.");
    say.push(`${main.tags.join(" · ")}: ${main.text}`);
    if (main.why.length) say.push(main.why.join(" "));
    for (const w of main.warn) say.push(`⚠ ${w}`);
    for (const o of opts) if (o !== main) say.push(`${o.tags.join(" · ")}: the ${o.j.legs.map((l) => `**${ctx.routeOf(l.i)[0]}**`).join(" then ")} leaving ${ctx.hhmm(o.j.dep)}, arriving about ${ctx.hhmm(o.j.arr)}. ${o.why.join(" ")}`);
    return { say, rows: main.rows, options: opts, main, actions: [stopAction(from), stopAction(to), { label: "Compare options", href: `#/plan/${encodeURIComponent(from.key)}/${encodeURIComponent(to.key)}${by != null ? `/by-${ctx.hhmm(by).replace(":", "")}` : opt.after != null ? `/at-${ctx.hhmm(opt.after).replace(":", "")}` : ""}` }] };
  }

  function answerToday() {
    const c = ctx.S.counts || {}, f = ctx.S.feed || {}, ran = (c.R || 0) + (c.O || 0), gh = c.G || 0;
    const worst = new Map(); ctx.B.trips.forEach((t, i) => { if (ctx.st(i) === "G") worst.set(t[0], (worst.get(t[0]) || 0) + 1); });
    const top = [...worst].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const late = (ctx.S.live || []).filter((x) => x[1] >= 5).length;
    return { say: [`Right now ${ctx.num(f.buses)} buses are on Sheffield’s roads and ${ctx.num((f.reported || 0) + (f.inferred || 0))} of them are matched to their timetabled trip; ${late} are running 5+ min late.`,
      `So far today ${ctx.num(ran)} buses have run and **${ctx.num(gh)} never came**${ran + gh ? ` (${ctx.pct(gh / (ran + gh))})` : ""}.${top.length ? ` Most ghost buses: ${top.map(([ri, n]) => `${ctx.B.routes[ri][0]} (${n})`).join(", ")}.` : ""}`],
      actions: [{ label: "Network page", href: "#/network" }] };
  }

  const FAQ = [
    [/ghost/, "A **ghost bus** is one that’s on the timetable but never turns up: no bus was seen anywhere on the trip, while the live feed was working and the operator was reporting its other buses. If we can’t be sure, it says “no live data” instead and doesn’t count it against anyone."],
    [/delay .*(worked out|calculated|work)|how .*(know|work out) .*late|how .*late.* calculated|how is the delay/, "Each bus’s position is laid along its trip’s path to see which timetabled point it has reached. The difference between now and the timetabled time at that point is how late it is. That delay is added to the timetabled times at the stops still ahead."],
    [/how (does|do) (it|this|you|the site|the app) work|where .* data|data (come|from)|source/, "Every bus in England reports its position to the government’s **Bus Open Data Service**. This site asks for Sheffield’s buses every 60 seconds, matches each bus to the timetabled trip it’s running, and works out how late it is. Once a trip’s time has passed, it’s marked ran or never came. Full details are on the How it works page."],
    [/accura\w*|how good is (this|it|the site|the app)|trust (it|this|the)|correct|mistake/, "Arrival times come from where each bus actually is, so they’re as good as the GPS (updated every couple of minutes). For buses that don’t say which trip they’re on, the matching is checked every update by hiding the trip of buses that do: right now it gets **{check}**. “Never came” is only used when the feed and the operator were both reporting."],
    [/how often .*(update|refresh)|updat\w*|refresh\w*|real ?time|how fresh|how old|how current|up to date/, "Bus positions are refreshed about **every 2 minutes**; the page checks for new data every minute or so. The time at the top shows how fresh the data is."],
    [/colou?r|green|amber|orange|red|blue|grey|gray|marker|dot/, "On the map: **green** on time, **amber** 3–9 min late, **red** 10+ min late, **blue** early, **grey** a bus we couldn’t match to a trip. The little arrow shows which way it’s heading."],
    [/\bdue\b|scheduled|no live data|on the road|what .* mean|meaning/, "**On the road**: a bus is on that trip right now. **Due**: it should be running but no bus has been matched yet. **Scheduled**: not due yet. **Ran**: a bus was seen doing it. **Never came**: a ghost bus. **No live data**: the operator wasn’t reporting, so we can’t tell."],
    [/said .* never came|but it came|it did come|wrong .* ghost|i saw/, "Sorry about that. “Never came” means no bus with a working tracker was seen on the trip. If a bus ran with its tracker switched off, it can look like a ghost. That’s why the page also shows how sure it is, and operators that don’t report at all are never marked."],
    [/model|predict|machine learning|ml\b|ai\b|chance|probab/, "A model learns from past days which departures tend not to run (by route, time of day, day of week and recent history). It gives each departure a chance of running, shown in each route’s History tab. A new model only replaces the live one if it does better on days it has never seen."],
    [/who (made|built|created)|author|creator|mohammed|contact/, "It was built by **Mohammed Banabilh**, a Computer Science with AI student at Sheffield Hallam. The code is open on GitHub."],
    [/official|first bus company|stagecoach|operator|council|government|affiliat/, "It’s an independent project, not affiliated with any bus operator or the Department for Transport. It uses open government data (Open Government Licence)."],
    [/privacy|track me|location|gps of me|cookie|data about me/, "Nothing about you is collected. “Near me” uses your location only inside your browser to find close stops; saved stops are kept on your device."],
    [/save|favourite|favorite|star|bookmark/, "Open a stop or route and press **☆ Save**. Saved ones appear on the Live page."],
    [/time ?zone|uk time|what time/, "All times are **UK time** (Sheffield)."],
    [/tomorrow|weekend|next week|future/, "I only have **today’s** timetable and live data. For future days, the route History tab shows how reliable each departure has been."],
    [/grey|gray/, "A **grey** bus is one we can see on the map but couldn’t match to a timetabled trip yet: it might be just starting, on a school or private run, or not reporting its route. Once it’s matched, it turns green, amber or red depending on how late it is."],
    [/arabic|عربي|language/, "I answer in English for now. اكتب سؤالك بالإنجليزية من فضلك."],
    [/(are you|is this) (a )?(bot|ai|human|chatgpt|real)|who are you|what are you/, "I’m the Ghost Bus assistant. I run inside your browser and answer from the same live bus data as the map. I don’t send your questions anywhere."],
    [/arrows?\b|direction|heading|pointing/, "The little arrow on each bus points the way it’s driving, from the bus’s own compass reading."],
    [/(know|work out|tell) which (trip|bus)|trip a bus is on|self ?check|matched by position/, "About half of Sheffield’s buses report which trip they’re running. For the rest, the bus’s last few positions are laid along every trip of its route that’s under way; the one where it moves forward and its lateness stays steady wins. The self-check hides the trip of buses that do report one and works it out again: right now it gets **{check}**."],
    [/why .*(not turn up|never came|ghost|cancel|missing|dont come|not come)|why do buses/, "Buses go missing for lots of reasons: driver shortages, breakdowns, a late bus being turned short, or a bus running with its tracker switched off. This site can’t see the reason, only that no bus was seen on the trip."],
    [/\btram|supertram/, "I only cover buses, not Supertram. For trams, check Stagecoach Supertram’s own app."],
    [/\btrain|railway|\brail\b/, "I only cover buses, not trains. For trains, National Rail Enquiries has live times."],
    [/weather|\brain\b|snow|temperature/, "I only know about the buses, not the weather. Sorry!"],
    [/taxi|uber|\bwalk\w*|\bbike|cycle|\bcar\b|parking/, "I only cover buses. I can tell you which stop is nearest though: try “buses near me”."],
    [/what time is it|what time it is|whats the time|what the time|what is the time|current time|time now/, "It’s **{now}** in Sheffield (UK time)."],
  ];
  const STRONG = /\btram|supertram|\btrain|railway|\brail\b|weather|\brain\b|snow|temperature|taxi|uber|what time is it|whats the time|what the time|what is the time|current time|time now|chatgpt|are you a bot|who are you|arabic/;
  function answerFaq(t) {
    for (const [re, a] of FAQ) if (re.test(t)) {
      const chk = ctx.S.feed?.check;
      return { say: [a.replace("{check}", chk?.n ? `${ctx.pct(chk.right / chk.n, 0)} right and ${ctx.pct(chk.wrong / chk.n, 0)} wrong` : "most of them right").replace("{now}", ctx.hhmm(now()))] };
    }
    return null;
  }

  const HELP = { say: ["I can answer questions about Sheffield’s buses using live data. Try:", "• “When’s the next bus from Arundel Gate?”", "• “Where is the 52 right now?”",
    "• “How do I get from Meadowhall to Crystal Peaks?”", "• “Did the 7:15 X1 come?”", "• “Is the 120 running late?”", "• “Which routes are least reliable?”", "• “Last bus from Sheffield Interchange”"],
    chips: ["Buses near me", "How are the buses today?", "What’s a ghost bus?"] };

  // ------------------------------------------------------------ the conversation
  const FUTURE = "I only have **today’s** timetable and live buses, so I can’t say for other days. Each route’s History tab shows how reliable it has been.";
  function ask(text) {
    prepare();
    const raw = String(text || "").trim();
    if (!raw) return HELP;
    const t = words(raw).join(" ");
    const sc = intentOf(t);
    const nums = findRoutes(raw);
    let ris = nums.length ? [...new Set(nums.flatMap((n) => routeNums.get(n)))] : null;
    const op = ris ? null : findOperator(t);
    const faq0 = answerFaq(t);
    const wantsSomething = sc.next || sc.where || sc.late || sc.came || sc.reliable || sc.first || sc.last || sc.plan || sc.ghost || sc.problems;
    const journey = !sc.came && / to /.test(` ${t} `) ? journeyParts(raw) : null;
    const dest = !journey && sc.plan ? destinationOnly(raw) : null;
    let stopHit = journey || dest || (op && !/\b(at|from)\b/.test(t)) ? null : findStop(raw, Boolean((wantsSomething || ris) && !op && !(faq0 && sc.faq)));
    const page = ctx.current?.();
    if (!stopHit && page?.kind === "stop" && /\b(here|this stop|this station|my stop)\b/.test(t)) { const it = ctx.index.find((x) => x.kind === "stop" && x.key === page.key); if (it) stopHit = { it, cover: 1 }; }
    if (!ris && page?.kind === "route" && /\b(this route|this bus|this one)\b/.test(t)) { const it = ctx.index.find((x) => x.kind === "route" && x.key === page.key); if (it) ris = [it.ri]; }
    const time = findTime(raw);
    const topt = tripOpts(raw);
    const n = t.split(" ").length;
    const vague = /\b(it|its|that|this|they|them|one|there|same)\b/.test(t) || n <= 3;   // a follow-up about what we just discussed
    // a vague question on a stop or route page is about that stop or route
    if (vague && !ris && !stopHit && !journey && !dest && !op && (wantsSomething || sc.today)) {
      if (page?.kind === "route") { const it = ctx.index.find((x) => x.kind === "route" && x.key === page.key); if (it) ris = [it.ri]; }
      else if (page?.kind === "stop") { const it = ctx.index.find((x) => x.kind === "stop" && x.key === page.key); if (it) stopHit = { it, cover: 1 }; }
    }
    const stop = stopHit?.it || null;
    const done = (a, k) => {
      memo.lastIntent = k;
      if (stop) memo.stop = stop;
      if (ris) memo.route = ris;
      if (stop || ris) memo.focus = stop && ris ? "both" : stop ? "stop" : "route";
      if (k !== "ask-from") memo.pendingTo = null;
      return { intent: k, ...a };
    };

    if (sc.near) return done({ say: ["Finding the stops closest to you…"], geo: true }, "near");
    if (memo.pendingTo && stop && !ris && !journey) return done(plan(stop, memo.pendingTo, memo.pendingOpt || {}), "plan");
    if (journey) return done(plan(journey.from, journey.to, topt), "plan");
    if (dest?.uni) return done({ say: ["Which uni? University of Sheffield (Western Bank) or Sheffield Hallam (City Campus)?"], chips: ["Get to the University of Sheffield", "Get to Sheffield Hallam"] }, "clarify");
    if (dest?.home || /\b(take me|get me|go|going|get)\s+(back\s+)?(home|to work)\b/.test(t)) {
      const which = dest?.home === "work" || /\bto work\b/.test(t) ? "work" : "home", saved = ctx.places?.()[which];
      const target = saved && ctx.index.find((x) => x.kind === "stop" && x.key === saved.key);
      if (!target) return done({ say: [`I don’t know where your ${which} is yet. Open your ${which} stop and choose “Set as ${which}”, or tell me the stop, for example “how do I get from Arundel Gate to Hillsborough”.`] }, "clarify");
      const from = stop || (page?.kind === "stop" ? ctx.index.find((x) => x.kind === "stop" && x.key === page.key) : memo.stop);
      if (from && from.key !== target.key) return done(plan(from, target, topt), "plan");
      memo.pendingTo = target; memo.pendingOpt = topt;
      return done({ say: [`Where are you now? Type your stop (or tap “Buses near me”) and I’ll plan the way to your ${which}, **${stopName(target)}**.`], chips: ["Buses near me"] }, "ask-from");
    }
    if (dest?.to && !ris && memo.route && memo.focus !== "stop" && /\b(it|its|they|that one|this one)\b/.test(t)) return done(answerWhere(memo.route, dest.to), "where");
    if (dest?.to) {
      const from = page?.kind === "stop" ? ctx.index.find((x) => x.kind === "stop" && x.key === page.key) : memo.stop;
      if (from && from.key !== dest.to.key) return done(plan(from, dest.to, topt), "plan");
      memo.pendingTo = dest.to; memo.pendingOpt = topt;
      return done({ say: [`Where are you starting from? Type the stop name (or tap “Buses near me”) and I’ll plan the way to **${stopName(dest.to)}**.`], chips: ["Buses near me"] }, "ask-from");
    }
    if (sc.more && memo.list?.kind === "next") return done(answerNext(memo.list.stop, memo.list.ris, memo.offset + 5), "more");
    // general questions about the site go first when no bus or stop is named
    if (faq0 && !ris && (STRONG.test(t) || (!stop && !op && (sc.faq || (!wantsSomething && !sc.today))) || (sc.faq && stopHit?.area) || (/\bwhy\b/.test(t) && !stop))) return done(faq0, "faq");
    if (op && !stop && !ris) return done(answerOperator(op, t), "operator");
    if (sc.future && !time && !(sc.first || sc.last)) {
      const today = ris ? answerReliable(ris, null) : stop ? answerNext(stop, null) : null;
      return done({ say: [FUTURE, ...(today?.say || [])], actions: today?.actions, rows: today?.rows }, "future");
    }
    if (sc.ghost && !time && !(sc.came && (ris || stop) && /\b(did|was|has)\b/.test(t) && !/\b(any|how many|which|list|show)\b/.test(t))) return done(answerGhosts(ris, stop), "ghosts");
    if ((sc.first || sc.last) && (ris || stop || (vague && (memo.route || memo.stop)))) {
      const a = answerFirstLast(sc.last >= (sc.first || 0) && sc.last ? "last" : "first", ris || (!stop ? memo.route : null), stop || (!ris ? memo.stop : null));
      if (sc.future) a.say = [FUTURE.split(",")[0] + ". Today’s was:", ...a.say];
      return done(a, "firstlast");
    }
    if (sc.came && (ris || stop) && !(sc.reliable > sc.came)) return done(answerCame(ris, stop, time), "came");
    if (sc.problems && !stop) return done(answerProblems(ris), "problems");
    if (op && !stop) return done(answerOperator(op, t), "operator");
    if (sc.reliable && (ris || stop)) return done(answerReliable(ris, stop), "reliable");
    if (sc.info && ris && !stop && !sc.late) return done(answerInfo(ris), "info");
    if (sc.late && (ris || stop) && !(sc.next > sc.late && stop && !ris)) return done(answerLate(ris, stop), "late");
    if (sc.where && ris) return done(answerWhere(ris, stop), "where");
    if (stop) return done(answerNext(stop, ris), "next");
    if (ris) {
      if (vague && memo.stop && /\b(there|same|that stop)\b/.test(t)) return done(answerNext(memo.stop, ris), "next");
      return done(sc.next && !sc.where ? answerRouteNext(ris) : answerWhere(ris, null), sc.next ? "route-next" : "where");
    }
    // nothing named: a follow-up, or a question about the whole city
    if (vague && !/\b(buses|today|sheffield|all|any|which|most)\b/.test(t)) {
      const r = memo.focus === "stop" ? null : memo.route, st0 = memo.focus === "route" ? null : memo.stop;
      if (sc.reliable && (r || st0)) return done(answerReliable(r, r ? null : st0), "followup");
      if ((sc.late || sc.where || sc.came) && r) return done(sc.late ? answerLate(r, st0) : sc.came ? answerCame(r, st0, time) : answerWhere(r, st0), "followup");
      if ((sc.next || sc.where || sc.late) && st0) return done(sc.late ? answerLate(r, st0) : answerNext(st0, r), "followup");
      if (sc.next && r) return done(answerRouteNext(r), "followup");
    }
    if (sc.problems) return done(answerProblems(null), "problems");
    if (sc.today && !sc.reliable) return done(answerToday(), "today");
    if (sc.late) return done(answerLate(null, null), "late");
    if (sc.reliable) return done(answerReliable(null, null), "reliable");
    const faq = answerFaq(t);
    if (faq) return done(faq, "faq");
    if (sc.thanks) return done({ say: ["You’re welcome. Anything else about the buses, just ask."] }, "thanks");
    if (sc.hello) return done({ say: ["Hi! Ask me about any bus or stop in Sheffield: when it’s coming, where it is, whether it’s late, or how to get somewhere."], chips: HELP.chips }, "hello");
    if (sc.help) return done(HELP, "help");
    if (sc.next || sc.where || sc.came) return done({ say: ["Which stop or route? You can type part of the name, for example “next bus from Arundel Gate” or “where is the 52”."], chips: ["Buses near me", "Next bus from Sheffield Interchange"] }, "clarify");
    const close = ctx.search(raw).slice(0, 3);
    if (close.length) return done({ say: ["I’m not sure what you’re asking. Did you mean one of these?"], actions: close.map((x) => ({ label: x.label, href: ctx.href(x.kind, x.key) })), chips: HELP.chips }, "unsure");
    return done({ ...HELP, say: ["I didn’t catch that. " + HELP.say[0], ...HELP.say.slice(1)] }, "fallback");
  }

  function planKeys(a, b, opt) { prepare(); return plan(a, b, opt || {}); }
  function optionsFor(a, b, opt) { prepare(); return options(a, b, opt || {}); }
  function nextFor(key) { prepare(); const it = ctx.index.find((x) => x.kind === "stop" && x.key === key); return it ? answerNext(it) : null; }

  return { ask, nextFor, plan: planKeys, options: optionsFor, area: areaByKey, _debug: { findStop: (s) => { prepare(); return findStop(s)?.it?.label; }, findRoutes: (s) => { prepare(); return findRoutes(s); }, findTime, intentOf: (s) => intentOf(words(s).join(" ")) } };
}
