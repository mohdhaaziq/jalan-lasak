/* Jalan Lasak API — one Cloudflare Pages Function serving /api/*.

   Roles
   - Participant phones: read the program state, post their group's positions.
     Each group has its own random 6-digit PIN, minted by the server when the
     command centre creates the group. The phone logs in with the PIN alone
     (POST /api/groups/login) and sends it with every batch of positions, so
     one phone cannot report as another group.
   - Marshals at checkpoints: post check-ins, proven by the marshal PIN the
     command centre set (X-Marshal-Pin header).
   - Command centre: everything, proven by the CC_KEY secret as a Bearer token.

   Storage is D1 (binding DB); schema in schema.sql at the repo root.

   Routes
     GET  /api/state              { version, points, routes, groups, settings }   public
     PUT  /api/state              { points, routes }  → { version }               CC
     PUT  /api/groups             { groups }  → { version, groups:[{id,pin}] }    CC
     POST /api/groups/login       { pin }     → { id, name, startedAt }          public
     PUT  /api/settings           { smsNumber?, marshalPin? } → { version }       CC
     POST /api/positions          { group, pin, device, items[] } → { version, saved }   group PIN or CC
     GET  /api/positions[?trail=N]  latest fix, check-ins and start per group     CC or marshal PIN (PINs only for CC)
     POST /api/checkins           { device, items:[{group, point, at?, note?}] }  CC or marshal PIN
*/

const DEFAULT_POINTS = [
  { id: 'start', type: 'start', name: 'MULA — Parking Stesen KTM Kuala Kubu Bharu', lat: 3.556879, lng: 101.632263 },
  { id: 'cp1', type: 'cp', name: 'Checkpoint 1', lat: 3.494318, lng: 101.688912 },
  { id: 'cp2', type: 'cp', name: 'Checkpoint 2', lat: 3.567827, lng: 101.613620 }
];

const MAX_BATCH = 200;      // positions or check-ins accepted in one POST
const MAX_TRAIL = 200;      // per-group trail points returned
const MAX_NAME = 120;
const MAX_NOTE = 200;
const CLOCK_SLACK_MS = 7 * 24 * 3600 * 1000;

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
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function isCC(request, env) {
  return !!env.CC_KEY && sameKey(bearerToken(request), env.CC_KEY);
}

function requireCC(request, env) {
  if (!env.CC_KEY) throw new HttpError(503, 'CC_KEY belum ditetapkan pada pelayan.');
  if (!isCC(request, env)) throw new HttpError(401, 'Kunci pusat kawalan salah.');
}

/** Command centre key, or the marshal PIN the command centre configured. */
async function requireCCOrMarshal(request, env) {
  if (isCC(request, env)) return 'cc';
  const pin = (request.headers.get('X-Marshal-Pin') || '').trim();
  const stored = await getMeta(env.DB, 'marshal_pin');
  if (!stored) throw new HttpError(503, 'PIN marshal belum ditetapkan oleh pusat kawalan.');
  if (!sameKey(pin, stored)) throw new HttpError(401, 'PIN marshal salah.');
  return 'marshal';
}

const isId = (v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
const isLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const isLng = (v) => Number.isFinite(v) && v >= -180 && v <= 180;
const cleanText = (v, max, fallback = '') => {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return s || fallback;
};
const cleanName = (v, fallback) => cleanText(v, MAX_NAME, fallback);

const PIN_DIGITS = 6;
const isPin = (v) => typeof v === 'string' && new RegExp(`^\\d{${PIN_DIGITS}}$`).test(v);

/** A random PIN not in `taken`. Adds it to `taken` so one batch stays unique. */
function newPin(taken) {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const pin = String(buf[0] % 10 ** PIN_DIGITS).padStart(PIN_DIGITS, '0');
    if (!taken.has(pin)) {
      taken.add(pin);
      return pin;
    }
  }
}

/** A phone's timestamp, if it is within reason of ours; otherwise now. */
function clientTime(value, now) {
  return Number.isFinite(value) && Math.abs(now - value) < CLOCK_SLACK_MS ? Math.round(value) : now;
}

async function getMeta(db, key) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value);

const delMeta = (db, key) => db.prepare('DELETE FROM meta WHERE key = ?').bind(key);

async function getVersion(db) {
  const v = await getMeta(db, 'version');
  return v ? Number(v) : 0;
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

async function getSettings(db) {
  const [sms, pin] = await Promise.all([getMeta(db, 'sms_number'), getMeta(db, 'marshal_pin')]);
  return { smsNumber: sms || '', hasMarshalPin: !!pin };
}

/* ── state ────────────────────────────────────────────────────────────── */

async function getState(env) {
  const db = env.DB;
  await seedIfEmpty(db);
  const [version, points, routes, groups, settings] = await Promise.all([
    getVersion(db),
    db.prepare('SELECT id, type, name, lat, lng, eta_min FROM points ORDER BY seq').all(),
    db.prepare('SELECT id, name, latlngs FROM routes ORDER BY seq').all(),
    db.prepare('SELECT id, name, started_at FROM groups ORDER BY seq').all(),
    getSettings(db)
  ]);
  return json({
    version,
    points: points.results.map((p) => ({ ...p, etaMin: p.eta_min, eta_min: undefined })),
    routes: routes.results.map((r) => ({ ...r, latlngs: JSON.parse(r.latlngs) })),
    groups: groups.results.map((g) => ({ id: g.id, name: g.name, startedAt: g.started_at })),
    settings
  });
}

function etaValue(v, label) {
  if (v === null || v === undefined || v === '') return null;
  if (!Number.isFinite(v) || v < 0 || v > 24 * 60) throw new HttpError(400, `${label}: jangkaan minit tidak sah.`);
  return Math.round(v);
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
    stmts.push(db.prepare('INSERT INTO points (id, type, name, lat, lng, seq, eta_min) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(p.id, p.type === 'start' ? 'start' : 'cp', cleanName(p.name, 'Checkpoint'), p.lat, p.lng, i,
        etaValue(p.etaMin, `Titik #${i + 1}`)));
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

/**
 * Replace the group list. A group's startedAt is kept unless the request
 * names it: absent → keep what the database has (a marshal may have set it
 * since this client last synced), null → clear, number → set.
 * Each group's PIN is kept too; a new group gets a fresh one, and
 * `resetPin: true` mints a new one for an existing group (e.g. a leaked PIN).
 * The response carries every group's PIN so the command centre can show it.
 */
async function putGroups(request, env) {
  requireCC(request, env);
  const body = await readJson(request);
  if (!Array.isArray(body.groups)) throw new HttpError(400, 'Perlukan senarai groups.');
  const db = env.DB;
  const existing = await db.prepare('SELECT id, started_at, pin FROM groups').all();
  const startedBefore = new Map(existing.results.map((g) => [g.id, g.started_at]));
  const pinBefore = new Map(existing.results.map((g) => [g.id, g.pin]));

  const stmts = [db.prepare('DELETE FROM groups')];
  const seen = new Set();
  const taken = new Set();
  const pins = [];
  const now = Date.now();
  body.groups.forEach((g, i) => {
    if (!g || !isId(g.id)) throw new HttpError(400, `Kumpulan #${i + 1} tidak sah.`);
    if (seen.has(g.id)) throw new HttpError(400, `ID kumpulan berulang: ${g.id}`);
    seen.add(g.id);
    let startedAt;
    if (!('startedAt' in g)) startedAt = startedBefore.get(g.id) ?? null;
    else if (g.startedAt === null) startedAt = null;
    else if (Number.isFinite(g.startedAt)) startedAt = clientTime(g.startedAt, now);
    else throw new HttpError(400, `Kumpulan #${i + 1}: masa mula tidak sah.`);
    const kept = g.resetPin ? null : pinBefore.get(g.id);
    const pin = isPin(kept) && !taken.has(kept) ? (taken.add(kept), kept) : newPin(taken);
    pins.push({ id: g.id, pin });
    stmts.push(db.prepare('INSERT INTO groups (id, name, seq, started_at, pin) VALUES (?, ?, ?, ?, ?)')
      .bind(g.id, cleanName(g.name, 'Kumpulan ' + (i + 1)), i, startedAt, pin));
  });
  stmts.push(bumpVersion(db));
  await db.batch(stmts);
  return json({ version: await getVersion(db), groups: pins });
}

/** Groups created before PINs existed get one the first time the command centre looks. */
async function ensurePins(db) {
  const rows = await db.prepare('SELECT id, pin FROM groups').all();
  const missing = rows.results.filter((g) => !isPin(g.pin));
  if (!missing.length) return;
  const taken = new Set(rows.results.map((g) => g.pin).filter(isPin));
  await db.batch(missing.map((g) =>
    db.prepare('UPDATE groups SET pin = ? WHERE id = ?').bind(newPin(taken), g.id)));
}

/** A participant phone logs in with its group's PIN alone. */
async function loginGroup(request, env) {
  const body = await readJson(request);
  const pin = cleanText(body.pin, 16).replace(/\D/g, '');
  if (!isPin(pin)) throw new HttpError(400, `PIN kumpulan ialah ${PIN_DIGITS} digit.`);
  const g = await env.DB.prepare('SELECT id, name, started_at FROM groups WHERE pin = ?').bind(pin).first();
  if (!g) throw new HttpError(401, 'PIN kumpulan salah.');
  return json({ id: g.id, name: g.name, startedAt: g.started_at });
}

async function putSettings(request, env) {
  requireCC(request, env);
  const body = await readJson(request);
  const db = env.DB;
  const stmts = [];
  if ('smsNumber' in body) {
    const sms = cleanText(body.smsNumber, 32).replace(/[^\d+]/g, '');
    stmts.push(sms ? setMeta(db, 'sms_number', sms) : delMeta(db, 'sms_number'));
  }
  if ('marshalPin' in body) {
    const pin = cleanText(body.marshalPin, 32);
    if (pin && pin.length < 4) throw new HttpError(400, 'PIN marshal sekurang-kurangnya 4 aksara.');
    stmts.push(pin ? setMeta(db, 'marshal_pin', pin) : delMeta(db, 'marshal_pin'));
  }
  if (!stmts.length) throw new HttpError(400, 'Tiada tetapan diberi.');
  stmts.push(bumpVersion(db));
  await db.batch(stmts);
  return json({ version: await getVersion(db), settings: await getSettings(db) });
}

/* ── positions ────────────────────────────────────────────────────────── */

async function postPositions(request, env) {
  const body = await readJson(request);
  if (!isId(body.group) || !isId(body.device)) throw new HttpError(400, 'Perlukan group dan device.');
  const items = Array.isArray(body.items) ? body.items.slice(-MAX_BATCH) : [];

  const db = env.DB;
  const group = await db.prepare('SELECT id, pin FROM groups WHERE id = ?').bind(body.group).first();
  if (!group) throw new HttpError(404, 'Kumpulan tidak wujud lagi — masuk semula.');
  // The phone proves it is this group with the group's PIN; the command centre
  // (typing in an SMS) proves itself with its key instead.
  if (!isCC(request, env) && !(isPin(group.pin) && sameKey(String(body.pin || ''), group.pin))) {
    throw new HttpError(401, 'PIN kumpulan salah — masuk semula.');
  }

  const now = Date.now();
  const stmts = [];
  for (const it of items) {
    if (!it || !isLat(it.lat) || !isLng(it.lng)) continue;
    stmts.push(db.prepare(
      'INSERT INTO positions (group_id, device, lat, lng, acc, battery, sos, source, recorded_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      body.group, body.device, it.lat, it.lng,
      Number.isFinite(it.acc) ? Math.round(it.acc) : null,
      Number.isFinite(it.battery) ? Math.max(0, Math.min(1, it.battery)) : null,
      it.sos ? 1 : 0,
      it.source === 'sms' ? 'sms' : 'app',
      clientTime(it.at, now), now
    ));
  }
  if (stmts.length) await db.batch(stmts);
  return json({ version: await getVersion(db), saved: stmts.length });
}

async function getPositions(request, env, url) {
  const who = await requireCCOrMarshal(request, env);
  const db = env.DB;
  if (who === 'cc') await ensurePins(db);
  const trail = Math.min(MAX_TRAIL, Math.max(0, parseInt(url.searchParams.get('trail') || '0', 10) || 0));

  // Latest fix per group, joined so deleted groups disappear.
  const latest = await db.prepare(`
    SELECT g.id AS group_id, g.name, g.seq, g.started_at, g.pin,
           p.lat, p.lng, p.acc, p.battery, p.sos, p.source, p.recorded_at, p.received_at, p.device
    FROM groups g
    LEFT JOIN positions p ON p.id = (
      SELECT id FROM positions WHERE group_id = g.id ORDER BY recorded_at DESC, id DESC LIMIT 1
    )
    ORDER BY g.seq
  `).all();

  const groups = latest.results.map((r) => ({
    id: r.group_id,
    name: r.name,
    startedAt: r.started_at,
    ...(who === 'cc' ? { pin: r.pin } : {}),   // a marshal phone never sees group PINs
    last: r.lat === null ? null : {
      lat: r.lat, lng: r.lng, acc: r.acc, battery: r.battery, sos: !!r.sos, source: r.source,
      at: r.recorded_at, receivedAt: r.received_at, device: r.device
    },
    checkins: [],
    trail: []
  }));
  const byGroup = new Map(groups.map((g) => [g.id, g]));

  const checkins = await db.prepare(
    'SELECT group_id, point_id, source, note, recorded_at FROM checkins ORDER BY recorded_at'
  ).all();
  for (const c of checkins.results) {
    const g = byGroup.get(c.group_id);
    if (g) g.checkins.push({ point: c.point_id, at: c.recorded_at, source: c.source, note: c.note || '' });
  }

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
    for (const r of rows.results) {
      const g = byGroup.get(r.group_id);
      if (g) g.trail.push([r.lat, r.lng, r.recorded_at, r.sos ? 1 : 0]);
    }
  }

  return json({ now: Date.now(), groups });
}

/* ── check-ins ────────────────────────────────────────────────────────── */

async function postCheckins(request, env) {
  const who = await requireCCOrMarshal(request, env);
  const body = await readJson(request);
  if (body.verify) return json({ ok: true, role: who });   // a marshal phone checking its PIN
  const items = Array.isArray(body.items) ? body.items.slice(-MAX_BATCH) : [];
  if (!items.length) throw new HttpError(400, 'Tiada daftar masuk diberi.');
  const device = isId(body.device) ? body.device : null;

  const db = env.DB;
  const [groups, points] = await Promise.all([
    db.prepare('SELECT id, started_at FROM groups').all(),
    db.prepare('SELECT id, type FROM points').all()
  ]);
  const groupStart = new Map(groups.results.map((g) => [g.id, g.started_at]));
  const pointType = new Map(points.results.map((p) => [p.id, p.type]));

  const now = Date.now();
  const stmts = [];
  const started = {};
  for (const it of items) {
    if (!it || !isId(it.group) || !isId(it.point)) continue;
    if (!groupStart.has(it.group)) throw new HttpError(404, 'Kumpulan tidak wujud lagi.');
    if (!pointType.has(it.point)) throw new HttpError(404, 'Titik tidak wujud lagi.');
    const at = clientTime(it.at, now);
    stmts.push(db.prepare(
      'INSERT INTO checkins (group_id, point_id, source, device, note, recorded_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(it.group, it.point, who, device, cleanText(it.note, MAX_NOTE) || null, at, now));
    // Setting off from the start is what starts a group's clock.
    if (pointType.get(it.point) === 'start' && groupStart.get(it.group) === null && !(it.group in started)) {
      started[it.group] = at;
      stmts.push(db.prepare('UPDATE groups SET started_at = ? WHERE id = ? AND started_at IS NULL').bind(at, it.group));
    }
  }
  if (!stmts.length) throw new HttpError(400, 'Tiada daftar masuk yang sah.');
  if (Object.keys(started).length) stmts.push(bumpVersion(db));
  await db.batch(stmts);
  return json({ version: await getVersion(db), saved: items.length, started });
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
    if (route === 'groups/login' && method === 'POST') return await loginGroup(request, env);
    if (route === 'settings' && method === 'PUT') return await putSettings(request, env);
    if (route === 'positions' && method === 'POST') return await postPositions(request, env);
    if (route === 'positions' && method === 'GET') return await getPositions(request, env, url);
    if (route === 'checkins' && method === 'POST') return await postCheckins(request, env);
    if (route === 'ping') return json({ ok: true, now: Date.now() });

    return fail(404, 'Laluan API tidak wujud.');
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message);
    console.error(err);
    return fail(500, 'Ralat pelayan.');
  }
}
