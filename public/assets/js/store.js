/* Device-local persistence. Keys match the prototype's, so data saved by an
   earlier build of the app survives the upgrade. Every access is guarded:
   localStorage throws in private mode and when the quota is full. */

const KEY_POINTS = 'jl_points_v1';
const KEY_ROUTES = 'jl_routes_v1';
const KEY_TARGET = 'jl_target';
const KEY_PREFS = 'jl_prefs_v1';
const KEY_STATE = 'jl_state_v2';     // server state cache: { version, points, routes, groups }
const KEY_GROUP = 'jl_group_v1';     // this phone's group id (participant)
const KEY_DEVICE = 'jl_device_v1';   // this phone's random id
const KEY_QUEUE = 'jl_posq_v1';      // positions not yet delivered
const KEY_CCKEY = 'jl_cckey_v1';     // command-centre key, on that device only

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

/* ── shared state (server-backed) ─────────────────────────────────────── */

/**
 * The last program state this device saw: the server copy if it has ever
 * synced, otherwise whatever the standalone build kept in the older keys,
 * otherwise the program defaults. Always usable offline.
 */
export function loadState() {
  const cached = read(KEY_STATE, null);
  if (cached && Array.isArray(cached.points)) {
    return {
      version: Number(cached.version) || 0,
      points: cached.points.filter(isPoint),
      routes: Array.isArray(cached.routes) ? cached.routes : [],
      groups: Array.isArray(cached.groups) ? cached.groups : []
    };
  }
  return { version: 0, points: loadPoints(), routes: loadRoutes(), groups: [] };
}

export const saveState = (state) => write(KEY_STATE, {
  version: state.version, points: state.points, routes: state.routes, groups: state.groups
});

/* ── participant identity ─────────────────────────────────────────────── */

export function loadGroup() {
  try { return localStorage.getItem(KEY_GROUP) || ''; } catch { return ''; }
}

export function saveGroup(id) {
  try { localStorage.setItem(KEY_GROUP, id || ''); } catch { /* storage unavailable */ }
}

/** A random id minted once per phone, so the same group's fixes can be told apart by device. */
export function deviceId() {
  try {
    let id = localStorage.getItem(KEY_DEVICE);
    if (!id) {
      id = 'd_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(KEY_DEVICE, id);
    }
    return id;
  } catch {
    return 'd_' + Date.now().toString(36);
  }
}

/* ── undelivered positions ────────────────────────────────────────────── */

export function loadQueue() {
  const q = read(KEY_QUEUE, []);
  return Array.isArray(q) ? q : [];
}

export const saveQueue = (queue) => write(KEY_QUEUE, queue);

/* ── command-centre key ───────────────────────────────────────────────── */

export function loadCCKey() {
  try { return localStorage.getItem(KEY_CCKEY) || ''; } catch { return ''; }
}

export function saveCCKey(key) {
  try {
    if (key) localStorage.setItem(KEY_CCKEY, key);
    else localStorage.removeItem(KEY_CCKEY);
  } catch { /* storage unavailable */ }
}
