// Service worker: app en kaartdata werken offline; kaartachtergrond wordt bewaard voor wat je bekeken hebt.
const VERSION = 'v22';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;
const TILES = `tiles-${VERSION}`;
const MAX_TILES = 3000;

const SHELL_FILES = [
  './',
  'index.html',
  'style.css',
  'js/app.js',
  'js/graph.js',
  'js/native.js',
  'js/share.js',
  'js/stats.js',
  'js/trip.js',
  'js/voice.js',
  'js/filter.js',
  'js/cloud.js',
  'js/place.js',
  'js/firebase-adapter.js',
  'js/firebase-config.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet-rotate.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/layers.png',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'data/index.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA, TILES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max + 200).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    const isData = (url.pathname.includes('/data/t_') || url.pathname.endsWith('/data/water.json'));
    if (isData || url.pathname.includes('/vendor/')) {
      // kaartdata en bibliotheken: eerst cache
      e.respondWith(
        caches.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) {
                const copy = res.clone();
                caches.open(isData ? DATA : SHELL).then((c) => c.put(req, copy));
              }
              return res;
            }),
        ),
      );
      return;
    }
    // de rest van de app: eerst netwerk (zodat updates doorkomen), anders cache
    e.respondWith(
      fetch(req, { cache: 'no-cache' }) // altijd controleren bij de server, anders blijft een oude versie hangen
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
    );
    return;
  }

  // kaartachtergrond van PDOK / OpenStreetMap
  if (/(pdok\.nl|tile\.openstreetmap\.org)$/.test(url.hostname) && url.hostname !== 'api.pdok.nl') {
    e.respondWith(
      caches.open(TILES).then((cache) =>
        cache.match(req).then(
          (hit) =>
            hit ||
            fetch(req)
              .then((res) => {
                if (res.ok || res.type === 'opaque') {
                  cache.put(req, res.clone());
                  trim(TILES, MAX_TILES);
                }
                return res;
              })
              .catch(() => hit || Response.error()),
        ),
      ),
    );
  }
});
