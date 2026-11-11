// Offline support: the app still opens with no signal and shows the last bus data it saw.
// Pages and data: network first, falling back to the last copy. Versioned files (?v=) and fonts: cache first.
const CACHE = "ghostbus-v14";
const SHELL = ["./", "index.html", "css/app.css?v=14", "js/main.js?v=14", "js/assistant.js?v=14", "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
  "fonts/atkinson-hyperlegible-latin-400-normal.woff2", "fonts/atkinson-hyperlegible-latin-700-normal.woff2", "icon.svg", "manifest.webmanifest"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "tile.openstreetmap.org" || url.hostname === "api.github.com") return;   // map tiles and the commit lookup: always live
  const versioned = url.search.includes("v=") || url.pathname.includes("/fonts/") || url.pathname.includes("/vendor/");
  if (versioned && url.origin === location.origin) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  // everything else (the page, data/*.json, live data): network first, keep a copy, use it when offline
  const key = url.hostname === "raw.githubusercontent.com" ? new Request(url.pathname.replace(/\/[0-9a-f]{40}\//, "/live/"), { method: "GET" }) : req;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))));
});

// Alerts: open (or focus) Ghost Bus when one is tapped. The push handler is ready for the push server
// (see AUDIT.md): it shows whatever {title, body, tag, url} the server sends.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => x.url.includes("/ghost-bus/") || x.url.includes("localhost"));
    return c ? c.focus() : self.clients.openWindow(url);
  }));
});
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Ghost Bus", { body: d.body || "", tag: d.tag, icon: "icon.svg", data: { url: d.url || "./" } }));
});
