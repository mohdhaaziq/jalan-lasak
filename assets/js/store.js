/* Device-local persistence. Keys match the prototype's, so data saved by an
   earlier build of the app survives the upgrade. Every access is guarded:
   localStorage throws in private mode and when the quota is full. */

const KEY_POINTS = 'jl_points_v1';
const KEY_ROUTES = 'jl_routes_v1';
const KEY_TARGET = 'jl_target';
const KEY_PREFS = 'jl_prefs_v1';

export const DEFAULT_POINTS = [
  { id: 'start', type: 'start', name: 'MULA — Parking Stesen KTM Kuala Kubu Bharu', lat: 3.556879, lng: 101.632263 },
  { id: 'cp1', type: 'cp', name: 'Checkpoint 1', lat: 3.494318, lng: 101.688912 },
  { id: 'cp2', type: 'cp', name: 'Checkpoint 2', lat: 3.567827, lng: 101.613620 }
];

const DEFAULT_PREFS = { base: 'osm', contour: false };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isPoint(p) {
  return p && typeof p === 'object' &&
    typeof p.id === 'string' &&
    Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

export function loadPoints() {
  const stored = read(KEY_POINTS, null);
  if (!Array.isArray(stored)) return DEFAULT_POINTS.map((p) => ({ ...p }));
  const clean = stored.filter(isPoint).map((p) => ({
    ...p,
    type: p.type === 'start' ? 'start' : 'cp',
    name: typeof p.name === 'string' ? p.name : 'Checkpoint'
  }));
  return clean.length ? clean : DEFAULT_POINTS.map((p) => ({ ...p }));
}

export const savePoints = (points) => write(KEY_POINTS, points);

export function loadRoutes() {
  const stored = read(KEY_ROUTES, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((r) =>
    r && typeof r.id === 'string' && Array.isArray(r.latlngs) && r.latlngs.length > 1);
}

export const saveRoutes = (routes) => write(KEY_ROUTES, routes);

export function loadTarget() {
  try { return localStorage.getItem(KEY_TARGET) || 'cp1'; } catch { return 'cp1'; }
}

export function saveTarget(id) {
  try { localStorage.setItem(KEY_TARGET, id); } catch { /* storage unavailable */ }
}

export function loadPrefs() {
  return { ...DEFAULT_PREFS, ...read(KEY_PREFS, {}) };
}

export const savePrefs = (prefs) => write(KEY_PREFS, prefs);
