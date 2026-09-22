/* The program area saves itself.

   Nobody should have to remember to press "save this area" before walking
   out of signal. Whenever the app knows the program's ground and has a line,
   it quietly fetches every tile of the chosen layers over that ground at the
   deepest zoom the tile budget allows, into the same cache the service worker
   reads from. Tiles already there are skipped, so a run that was cut short
   simply picks up where it stopped the next time the app opens.

   One job at a time; a request made while a job runs (a layer switch, the
   line coming back) is remembered and served when the job ends. */

import { planTiles, precacheTiles, deepestZoom, approxSize } from './offline.js';

export const AUTO_ZMIN = 11;          // an overview of the district
export const AUTO_TILE_BUDGET = 3500; // ≈ 70 MB; the deepest zoom is chosen to fit this

/**
 * createAutoCache({ getBounds, getSources, onStatus })
 *   getBounds  → L.LatLngBounds of the program, or null while unknown
 *   getSources → [{ template, subdomains, maxZoom }] the phone should hold
 *   onStatus   ← { phase, done, total, saved, failed, zMin, zMax, sizeText }
 *                phase: 'unsupported' | 'waiting' | 'offline' | 'running' | 'done' | 'failed'
 *
 * Returns { kick(force), running() }.
 */
export function createAutoCache({ getBounds, getSources, onStatus }) {
  const supported = typeof window !== 'undefined' && 'caches' in window;
  let job = null;          // promise of the job in flight
  let queued = false;      // a kick arrived while a job ran
  const complete = new Set(); // fingerprints finished without failures this session
  let last = { phase: 'waiting' };

  const emit = (status) => { last = status; if (onStatus) onStatus(status); };

  const fingerprint = (bounds, sources, zMax) => [
    bounds.getSouth().toFixed(4), bounds.getWest().toFixed(4),
    bounds.getNorth().toFixed(4), bounds.getEast().toFixed(4),
    zMax, ...sources.map((s) => s.template)
  ].join('|');

  async function run(force) {
    const bounds = getBounds();
    if (!bounds) { emit({ phase: 'waiting' }); return; }
    if (!navigator.onLine) { emit({ phase: 'offline' }); return; }

    const sources = getSources();
    const zMax = deepestZoom(bounds, AUTO_ZMIN, sources, AUTO_TILE_BUDGET);
    const key = fingerprint(bounds, sources, zMax);
    const urls = planTiles(bounds, AUTO_ZMIN, zMax, sources);
    if (!urls.length) { emit({ phase: 'waiting' }); return; }
    if (!force && complete.has(key)) {
      emit({ phase: 'done', done: urls.length, total: urls.length, saved: 0, failed: 0, zMin: AUTO_ZMIN, zMax, sizeText: approxSize(urls.length) });
      return;
    }

    emit({ phase: 'running', done: 0, total: urls.length, saved: 0, failed: 0, zMin: AUTO_ZMIN, zMax, sizeText: approxSize(urls.length) });
    let stats;
    try {
      stats = await precacheTiles(urls, {
        onProgress: (s) => emit({ phase: 'running', ...s, zMin: AUTO_ZMIN, zMax, sizeText: approxSize(s.total) })
      });
    } catch {
      emit({ phase: 'failed', done: 0, total: urls.length, saved: 0, failed: urls.length, zMin: AUTO_ZMIN, zMax, sizeText: approxSize(urls.length) });
      return;
    }
    if (stats.failed === 0) complete.add(key);
    emit({ phase: stats.failed ? 'failed' : 'done', ...stats, zMin: AUTO_ZMIN, zMax, sizeText: approxSize(stats.total) });
  }

  /** Start a job now, or remember to once the current one ends. */
  function kick(force = false) {
    if (!supported) { emit({ phase: 'unsupported' }); return; }
    if (job) { queued = true; return; }
    job = run(force).catch(() => {}).finally(() => {
      job = null;
      if (queued) { queued = false; kick(false); }
    });
  }

  // The line coming back, or the app coming back to the front, is the moment
  // to finish what was left.
  window.addEventListener('online', () => kick(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick(false);
  });

  return { kick, running: () => !!job, status: () => last };
}

/** One line for the offline panel describing where the download stands. */
export function autoStatusText(status) {
  switch (status.phase) {
    case 'unsupported': return 'Pelayar ini tidak menyokong peta offline';
    case 'waiting': return 'Menunggu maklumat kawasan program…';
    case 'offline': return 'Tiada talian — muat turun bersambung bila ada isyarat';
    case 'running': return `Memuat turun peta ${status.done}/${status.total} · ± ${status.sizeText}`;
    case 'failed': return `${status.failed} tile gagal — akan dicuba lagi bila ada isyarat`;
    case 'done': return `Peta kawasan siap offline · ${status.total} tile · zum ${status.zMin}–${status.zMax}`;
    default: return '';
  }
}
