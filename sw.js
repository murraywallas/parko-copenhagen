// sw.js — Service worker: cachea el shell de la app y el respaldo de zonas
// para que funcione sin conexión (las teselas del mapa requieren red).
const CACHE = 'parkkbh-v10';
const SHELL = [
  'index.html',
  'css/styles.css',
  'js/rules.js',
  'js/municipalities.js',
  'js/app.js',
  'data/zones-cph.json',
  'data/zones-frb.json',
  'data/parking-facilities.json',
  'data/parkomat.json',
  'icons/icon.svg',
  'manifest.webmanifest',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // El GeoJSON en vivo: red primero, cae al caché si falla.
  if (url.includes('wfs-kbhkort.kk.dk')) {
    e.respondWith(fetch(e.request).catch(() => caches.match('data/zones-cph.json')));
    return;
  }
  // Resto: caché primero (shell), red si no está.
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
