/* Geodesy and slippy-map tile maths. No dependencies. */

const R = 6371000;          // mean Earth radius, metres
const toRad = Math.PI / 180;

/** Great-circle distance in metres between two {lat, lng}. */
export function distM(a, b) {
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing in degrees (0–360) from a to b. */
export function bearing(a, b) {
  const dLng = (b.lng - a.lng) * toRad;
  const y = Math.sin(dLng) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
    Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Metres as "1.23 km" or "840 m". */
export function fmtDist(m) {
  return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
}

/** Total length in km of a [[lat, lng], …] path. */
export function pathKm(latlngs) {
  let total = 0;
  for (let i = 1; i < latlngs.length; i++) {
    total += distM(
      { lat: latlngs[i - 1][0], lng: latlngs[i - 1][1] },
      { lat: latlngs[i][0], lng: latlngs[i][1] }
    );
  }
  return total / 1000;
}

/* ── slippy map tiles ─────────────────────────────────────────────────── */

export function lngToTileX(lng, z) {
  return Math.floor((lng + 180) / 360 * 2 ** z);
}

export function latToTileY(lat, z) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin(clamped * toRad);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z);
}

/**
 * Every {z, x, y} covering `bounds` for zoom levels zMin…zMax inclusive.
 * `bounds` is anything with getSouth/getWest/getNorth/getEast (an L.LatLngBounds).
 */
export function tilesForBounds(bounds, zMin, zMax) {
  const tiles = [];
  for (let z = zMin; z <= zMax; z++) {
    const max = 2 ** z - 1;
    const x0 = Math.max(0, lngToTileX(bounds.getWest(), z));
    const x1 = Math.min(max, lngToTileX(bounds.getEast(), z));
    const y0 = Math.max(0, latToTileY(bounds.getNorth(), z));
    const y1 = Math.min(max, latToTileY(bounds.getSouth(), z));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) tiles.push({ z, x, y });
    }
  }
  return tiles;
}

/** How many tiles cover `bounds` at zoom `z`, without listing them. */
export function countTiles(bounds, z) {
  const max = 2 ** z - 1;
  const x0 = Math.max(0, lngToTileX(bounds.getWest(), z));
  const x1 = Math.min(max, lngToTileX(bounds.getEast(), z));
  const y0 = Math.max(0, latToTileY(bounds.getNorth(), z));
  const y1 = Math.min(max, latToTileY(bounds.getSouth(), z));
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

/** Fill {s}/{x}/{y}/{z} in a tile URL template. */
export function tileUrl(template, { z, x, y }, subdomains) {
  const s = subdomains && subdomains.length
    ? subdomains[Math.abs(x + y) % subdomains.length]
    : '';
  return template
    .replace('{s}', s)
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y);
}
