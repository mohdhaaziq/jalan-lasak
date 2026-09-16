const SHELL = 'jl-shell-v2';
const TILES = 'jl-tiles-v1';
const TILE_HOSTS = ['tile.openstreetmap.org', 'opentopomap.org', 'arcgisonline.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const TILE_LIMIT = 1200;

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('jl-shell-') && k !== SHELL).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimCache(name, limit) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length > limit) await Promise.all(keys.slice(0, keys.length - limit).map(k => c.delete(k)));
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isTile = TILE_HOSTS.some(h => url.hostname.endsWith(h));
  const isShell = url.origin === self.location.origin;
  if (!isTile && !isShell) return;
  e.respondWith((async () => {
    const cacheName = isTile && !isShell ? TILES : SHELL;
    const cache = await caches.open(cacheName);
    if (cacheName === SHELL) {
      // network-first for app files; cache only as offline fallback
      try {
        const res = await fetch(e.request);
        if (res && res.ok) cache.put(e.request, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(e.request);
        return hit || new Response('', { status: 504 });
      }
    }
    const hit = await cache.match(e.request);
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(e.request, res.clone());
        trimCache(TILES, TILE_LIMIT);
      }
      return res;
    } catch (err) {
      return new Response('', { status: 504 });
    }
  })());
});
