/* Jalan Lasak service worker.

   Three caches, three jobs:
   - SHELL      the app itself, plus the last GET /api/state. Precached on
                install so a first-run offline launch works, then network-first
                so a deployed change is picked up on the next visit and the
                cache is only a fallback.
   - TILES_SAVED map tiles the user deliberately saved for an area. Never
                evicted here — only the "Kosongkan" button clears them.
   - TILES_AUTO  tiles that happened to be drawn while browsing. Cache-first
                and trimmed, so casual panning cannot fill the device. */

const VERSION = 'v39';
const SHELL = `jl-shell-${VERSION}`;
const TILES_SAVED = 'jl-tiles-v1';
const TILES_AUTO = 'jl-tiles-auto-v1';
const AUTO_LIMIT = 1500;

const TILE_HOSTS = ['tile.openstreetmap.org', 'opentopomap.org', 'arcgisonline.com'];

const SHELL_FILES = [
  './',
  'index.html',
  'pusat.html',
  'marshal.html',
  'manifest.webmanifest',
  'assets/css/modernist.css',
  'assets/css/app.css',
  'assets/js/core.js',
  'assets/js/edit.js',
  'assets/js/peserta.js',
  'assets/js/pusat.js',
  'assets/js/api.js',
  'assets/js/reporter.js',
  'assets/js/marshal.js',
  'assets/js/schedule.js',
  'assets/js/geo.js',
  'assets/js/store.js',
  'assets/js/ui.js',
  'assets/js/offline.js',
  'assets/js/lock.js',
  'assets/js/tabs.js',
  'assets/js/alarm.js',
  'vendor/qrcode/qrcode.js',
  'assets/icons/favicon.svg',
  'assets/icons/icon-180.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable-512.png',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/fonts/archivo-latin-400-normal.woff2',
  'vendor/fonts/archivo-latin-600-normal.woff2',
  'vendor/fonts/archivo-latin-800-normal.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // One miss must not fail the whole install.
    await Promise.all(SHELL_FILES.map((file) =>
      cache.add(new Request(file, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('jl-shell-') && key !== SHELL)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => /pusat|marshal/.test(c.url)) || all[0];
    if (open) return open.focus();
    return self.clients.openWindow('pusat.html');
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function trim(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}

/** App files: network first, cached copy when the network is gone. */
async function shellResponse(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const path = new URL(request.url).pathname;
    const page = path.includes('pusat') ? 'pusat.html' : path.includes('marshal') ? 'marshal.html' : 'index.html';
    const hit = await cache.match(request) ||
      (request.mode === 'navigate' ? await cache.match(page) : null);
    return hit || new Response('Tiada talian.', {
      status: 504,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/** Map tiles: saved copy, then browsed copy, then the network. */
async function tileResponse(request) {
  const options = { ignoreVary: true };
  const saved = await caches.open(TILES_SAVED);
  const hit = await saved.match(request, options);
  if (hit) return hit;

  const auto = await caches.open(TILES_AUTO);
  const autoHit = await auto.match(request, options);
  if (autoHit) return autoHit;

  try {
    const response = await fetch(request);
    // Only tiles the map actually drew (destination "image") go in the browsed
    // cache. The app's own "save this area" fetches are plain fetch() calls and
    // are stored by the page in TILES_SAVED instead — caching them here too
    // would keep two copies of every deliberately saved tile.
    const drawn = request.destination === 'image';
    // Cross-origin tiles come back opaque (status 0) and cannot be inspected;
    // storing them is still what makes the map work offline.
    if (drawn && response && (response.ok || response.type === 'opaque')) {
      await auto.put(request, response.clone());
      trim(TILES_AUTO, AUTO_LIMIT);
    }
    return response;
  } catch {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/api/')) {
      // Only the shared program state is worth a stale copy: it lets a phone
      // with no signal still open the map. Everything else is live-only.
      if (url.pathname.endsWith('/api/state')) event.respondWith(shellResponse(request));
      return;
    }
    event.respondWith(shellResponse(request));
    return;
  }
  if (TILE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) {
    event.respondWith(tileResponse(request));
  }
});
