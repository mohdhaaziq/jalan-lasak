/* Deliberate offline tile storage.

   The service worker caches every tile the map happens to draw, which only
   helps for ground you have already panned across. This module lets the user
   say "save this area" before walking into it: it works out exactly which
   tiles cover the current view across a span of zoom levels and fetches them
   into the same cache the service worker reads from.

   Requests are made in no-cors mode, the way Leaflet's <img> tiles are, so the
   cached entries match what the map asks for later. */

import { tilesForBounds, tileUrl } from './geo.js';

/** Tiles the user deliberately saved. The service worker reads this first. */
export const TILE_CACHE = 'jl-tiles-v1';
/** Tiles the service worker picked up while the map was being browsed. */
export const TILE_CACHE_AUTO = 'jl-tiles-auto-v1';
const CONCURRENCY = 6;

/** How many tiles are stored, saved and browsed together. */
export async function cachedTileCount() {
  if (!('caches' in window)) return 0;
  try {
    const counts = await Promise.all([TILE_CACHE, TILE_CACHE_AUTO].map(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).length;
    }));
    return counts.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

/** Average bytes per map tile, used for the size estimates shown to the user. */
export const TILE_BYTES = 20 * 1024;

/**
 * A rough size for `count` tiles.
 *
 * navigator.storage.estimate() is deliberately not used: browsers pad the
 * recorded size of opaque cross-origin responses (several MB each) to avoid
 * leaking their real length, so it reports hundreds of MB for a few hundred
 * tiles and would badly mislead anyone deciding what to store.
 */
export function approxSize(count) {
  const bytes = count * TILE_BYTES;
  return bytes >= 1024 ** 3
    ? (bytes / 1024 ** 3).toFixed(1) + ' GB'
    : Math.max(1, Math.round(bytes / 1024 ** 2)) + ' MB';
}

/** Throw away every stored tile. The app shell is in a separate cache. */
export async function clearTiles() {
  if (!('caches' in window)) return false;
  try {
    const results = await Promise.all(
      [TILE_CACHE, TILE_CACHE_AUTO].map((name) => caches.delete(name)));
    return results.some(Boolean);
  } catch {
    return false;
  }
}

/**
 * Tile URLs covering `bounds` over zoom zMin…zMax for each of `sources`
 * ({ template, subdomains }). Duplicates are removed.
 */
export function planTiles(bounds, zMin, zMax, sources) {
  const coords = tilesForBounds(bounds, zMin, zMax);
  const urls = new Set();
  for (const source of sources) {
    for (const coord of coords) {
      if (coord.z > source.maxZoom) continue;
      urls.add(tileUrl(source.template, coord, source.subdomains));
    }
  }
  return [...urls];
}

/**
 * Fetch `urls` into the tile cache, skipping any already there.
 * Calls onProgress({ done, total, saved, skipped, failed }) as it goes.
 */
export async function precacheTiles(urls, { onProgress, signal } = {}) {
  if (!('caches' in window)) throw new Error('unsupported');
  const cache = await caches.open(TILE_CACHE);
  const auto = await caches.open(TILE_CACHE_AUTO);
  const stats = { done: 0, total: urls.length, saved: 0, skipped: 0, failed: 0 };
  let next = 0;

  const worker = async () => {
    while (next < urls.length) {
      if (signal && signal.aborted) return;
      const url = urls[next++];
      try {
        const hit = await cache.match(url, { ignoreVary: true });
        const browsed = hit ? null : await auto.match(url, { ignoreVary: true });
        if (hit) {
          stats.skipped++;
        } else if (browsed) {
          // Already downloaded while browsing — promote it so trimming
          // the browsed cache cannot take it away.
          await cache.put(url, browsed.clone());
          stats.saved++;
        } else {
          const response = await fetch(url, { mode: 'no-cors', cache: 'no-store' });
          // An opaque response has status 0 and cannot be inspected; a real
          // failure surfaces as a rejected fetch instead.
          if (response.type === 'opaque' || response.ok) {
            await cache.put(url, response.clone());
            stats.saved++;
          } else {
            stats.failed++;
          }
        }
      } catch {
        stats.failed++;
      }
      stats.done++;
      if (onProgress) onProgress(stats);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return stats;
}
