const CACHE = "njk-browser-v13";
const FILES = ["./", "./index.html", "./style.css", "./app.js?v=20261108-controls", "./immersive.mjs?v=20261108-controls", "./gamepad.mjs?v=20261108-controls", "./typing.mjs?v=20261108-controls", "./protocol.mjs?v=20261108-playback", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./microphone-worklet.js"];
const urls = new Set(FILES.map((path) => new URL(path, self.registration.scope).href));
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES))));
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("njk-browser-") && key !== CACHE).map((key) => caches.delete(key))))
));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !urls.has(event.request.url)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy))); }
    return response;
  }).catch(() => caches.match(event.request)));
});
