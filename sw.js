const CACHE = "njk-browser-v31";
const FILES = ["./", "./index.html", "./style.css", "./app.js?v=20261110-stability", "./keyboard-accessory.mjs?v=20261109-accessory", "./floating-menu.mjs?v=20261109-menu1", "./immersive.mjs?v=20261110-stability", "./gamepad.mjs?v=20261110-stability", "./typing.mjs?v=20261109-accessory", "./protocol.mjs?v=20261109-viewport", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./microphone-worklet.js"];
const urls = new Set(FILES.map((path) => new URL(path, self.registration.scope).href));
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("njk-browser-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !urls.has(event.request.url)) return;
  event.respondWith(fetch(event.request, { cache: "no-cache" }).then((response) => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy))); }
    return response;
  }).catch(() => caches.match(event.request)));
});
