/* Jalan Lasak API — one Cloudflare Pages Function serving /api/*.

   Roles
   - Participant phones: read the program state, post their group's positions.
     No login; a group id plus a per-phone device id.
   - Command centre: everything above plus editing points, routes and groups,
     and reading positions. Proven by the CC_KEY secret sent as a Bearer token.

   Storage is D1 (binding DB); schema in schema.sql at the repo root.

   Routes
     GET  /api/state            { version, points, routes, groups }    public
     PUT  /api/state            { points, routes }  → { version }      CC
     PUT  /api/groups           { groups }          → { version }      CC
     POST /api/positions        { group, device, items[] } → { version, saved }
     GET  /api/positions[?trail=N]   latest fix per group (+ last N)   CC
*/

const DEFAULT_POINTS = [
  { id: 'start', type: 'start', name: 'MULA — Parking Stesen KTM Kuala Kubu Bharu', lat: 3.556879, lng: 101.632263 },
  { id: 'cp1', type: 'cp', name: 'Checkpoint 1', lat: 3.494318, lng: 101.688912 },
  { id: 'cp2', type: 'cp', name: 'Checkpoint 2', lat: 3.567827, lng: 101.613620 }
];

const MAX_BATCH = 200;      // positions accepted in one POST
const MAX_TRAIL = 200;      // per-group trail points returned
const MAX_NAME = 120;

/* ── helpers ──────────────────────────────────────────────────────────── */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

const fail = (status, error) => json({ error }, status);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Badan permintaan mesti JSON.');
  }
}

/** Constant-time-ish string compare; keys are short so this is enough. */
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireCC(request, env) {
  if (!env.CC_KEY) throw new HttpError(503, 'CC_KEY belum ditetapkan pada pelayan.');
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!sameKey(token, env.CC_KEY)) throw new HttpError(401, 'Kunci pusat kawalan salah.');
}

const isId = (v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
const isLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const isLng = (v) => Number.isFinite(v) && v >= -180 && v <= 180;
const cleanName = (v, fallback) => {
  const s = typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '';
  return s || fallback;
};

async function getVersion(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'version'").first();
  return row ? Number(row.value) : 0;
}

const bumpVersion = (db) =>
  db.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'version'");

/** First run on an empty database: the program's own points. */
async function seedIfEmpty(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM points').first();
  if (row && row.n > 0) return;
  const stmts = DEFAULT_POINTS.map((p, i) =>
    db.prepare('INSERT OR IGNORE INTO points (id, type, name, lat, lng, seq) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(p.id, p.type, p.name, p.lat, p.lng, i));
  await db.batch(stmts);
}

/* ── handlers ─────────────────────────────────────────────────────────── */

async function getState(env) {
  const db = env.DB;
  await seedIfEmpty(db);
  const [version, points, routes, groups] = await Promise.all([
    getVersion(db),
    db.prepare('SELECT id, type, name, lat, lng FROM points ORDER BY seq').all(),
    db.prepare('SELECT id, name, latlngs FROM routes ORDER BY seq').all(),
    db.prepare('SELECT id, name FROM groups ORDER BY seq').all()
  ]);
  return json({
    version,
    points: points.results,
    routes: routes.results.map((r) => ({ ...r, latlngs: JSON.parse(r.latlngs) })),
    groups: groups.results
  });
}

async function putState(request, env) {
  requireCC(request, env);
  const body = await readJson(request);
  const points = Array.isArray(body.points) ? body.points : null;
  const routes = Array.isArray(body.routes) ? body.routes : null;
  if (!points || !routes) throw new HttpError(400, 'Perlukan senarai points dan routes.');
  if (!points.some((p) => p && p.type === 'start')) throw new HttpError(400, 'Titik MULA mesti ada.');

  const db = env.DB;
  const stmts = [db.prepare('DELETE FROM points'), db.prepare('DELETE FROM routes')];
  const seen = new Set();

  points.forEach((p, i) => {
    if (!p || !isId(p.id) || !isLat(p.lat) || !isLng(p.lng)) throw new HttpError(400, `Titik #${i + 1} tidak sah.`);
    if (seen.has(p.id)) throw new HttpError(400, `ID titik berulang: ${p.id}`);
    seen.add(p.id);
    stmts.push(db.prepare('INSERT INTO points (id, type, name, lat, lng, seq) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(p.id, p.type === 'start' ? 'start' : 'cp', cleanName(p.name, 'Checkpoint'), p.lat, p.lng, i));
  });

  routes.forEach((r, i) => {
    const ok = r && isId(r.id) && Array.isArray(r.latlngs) && r.latlngs.length >= 2 &&
      r.latlngs.every((ll) => Array.isArray(ll) && isLat(ll[0]) && isLng(ll[1]));
    if (!ok) throw new HttpError(400, `Laluan #${i + 1} tidak sah.`);
    if (seen.has(r.id)) throw new HttpError(400, `ID berulang: ${r.id}`);
    seen.add(r.id);
    stmts.push(db.prepare('INSERT INTO routes (id, name, latlngs, seq) VALUES (?, ?, ?, ?)')
      .bind(r.id, cleanName(r.name, 'Laluan'), JSON.stringify(r.latlngs.map((ll) => [ll[0], ll[1]])), i));
  });

  stmts.push(bumpVersion(db));
  await db.batch(stmts);
  return json({ version: await getVersion(db) });
}

async function putGroups(request, env) {
  requireCC(request, env);
  const body = await readJson(request);
  if (!Array.isArray(body.groups)) throw new HttpError(400, 'Perlukan senarai groups.');
  const db = env.DB;
  const stmts = [db.prepare('DELETE FROM groups')];
  const seen = new Set();
  body.groups.forEach((g, i) => {
    if (!g || !isId(g.id)) throw new HttpError(400, `Kumpulan #${i + 1} tidak sah.`);
    if (seen.has(g.id)) throw new HttpError(400, `ID kumpulan berulang: ${g.id}`);
    seen.add(g.id);
    stmts.push(db.prepare('INSERT INTO groups (id, name, seq) VALUES (?, ?, ?)')
      .bind(g.id, cleanName(g.name, 'Kumpulan ' + (i + 1)), i));
  });
  stmts.push(bumpVersion(db));
  await db.batch(stmts);
  return json({ version: await getVersion(db) });
}

async function postPositions(request, env) {
  const body = await readJson(request);
  if (!isId(body.group) || !isId(body.device)) throw new HttpError(400, 'Perlukan group dan device.');
  const items = Array.isArray(body.items) ? body.items.slice(-MAX_BATCH) : [];

  const db = env.DB;
  const group = await db.prepare('SELECT id FROM groups WHERE id = ?').bind(body.group).first();
  if (!group) throw new HttpError(404, 'Kumpulan tidak wujud lagi — pilih semula.');

  const now = Date.now();
  const stmts = [];
  for (const it of items) {
    if (!it || !isLat(it.lat) || !isLng(it.lng)) continue;
    // Trust the phone's clock only within reason; otherwise use ours.
    const at = Number.isFinite(it.at) && Math.abs(now - it.at) < 7 * 24 * 3600 * 1000 ? Math.round(it.at) : now;
    stmts.push(db.prepare(
      'INSERT INTO positions (group_id, device, lat, lng, acc, battery, sos, recorded_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      body.group, body.device, it.lat, it.lng,
      Number.isFinite(it.acc) ? Math.round(it.acc) : null,
      Number.isFinite(it.battery) ? Math.max(0, Math.min(1, it.battery)) : null,
      it.sos ? 1 : 0, at, now
    ));
  }
  if (stmts.length) await db.batch(stmts);
  return json({ version: await getVersion(db), saved: stmts.length });
}

async function getPositions(request, env, url) {
  requireCC(request, env);
  const db = env.DB;
  const trail = Math.min(MAX_TRAIL, Math.max(0, parseInt(url.searchParams.get('trail') || '0', 10) || 0));

  // Latest fix per group, joined so deleted groups disappear.
  const latest = await db.prepare(`
    SELECT g.id AS group_id, g.name, g.seq,
           p.lat, p.lng, p.acc, p.battery, p.sos, p.recorded_at, p.received_at, p.device
    FROM groups g
    LEFT JOIN positions p ON p.id = (
      SELECT id FROM positions WHERE group_id = g.id ORDER BY recorded_at DESC, id DESC LIMIT 1
    )
    ORDER BY g.seq
  `).all();

  const groups = latest.results.map((r) => ({
    id: r.group_id,
    name: r.name,
    last: r.lat === null ? null : {
      lat: r.lat, lng: r.lng, acc: r.acc, battery: r.battery, sos: !!r.sos,
      at: r.recorded_at, receivedAt: r.received_at, device: r.device
    },
    trail: []
  }));

  if (trail > 0) {
    const rows = await db.prepare(`
      SELECT group_id, lat, lng, sos, recorded_at FROM positions
      WHERE id IN (
        SELECT id FROM positions p2
        WHERE p2.group_id = positions.group_id
        ORDER BY recorded_at DESC LIMIT ?
      )
      ORDER BY group_id, recorded_at
    `).bind(trail).all();
    const byGroup = new Map(groups.map((g) => [g.id, g]));
    for (const r of rows.results) {
      const g = byGroup.get(r.group_id);
      if (g) g.trail.push([r.lat, r.lng, r.recorded_at, r.sos ? 1 : 0]);
    }
  }

  return json({ now: Date.now(), groups });
}

/* ── router ───────────────────────────────────────────────────────────── */

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  try {
    if (!env.DB) throw new HttpError(503, 'Pangkalan data D1 belum diikat (binding DB).');

    if (route === 'state' && method === 'GET') return await getState(env);
    if (route === 'state' && method === 'PUT') return await putState(request, env);
    if (route === 'groups' && method === 'PUT') return await putGroups(request, env);
    if (route === 'positions' && method === 'POST') return await postPositions(request, env);
    if (route === 'positions' && method === 'GET') return await getPositions(request, env, url);
    if (route === 'ping') return json({ ok: true, now: Date.now() });

    return fail(404, 'Laluan API tidak wujud.');
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message);
    console.error(err);
    return fail(500, 'Ralat pelayan.');
  }
}
