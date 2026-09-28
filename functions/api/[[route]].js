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

   Programs. Every event is a row in `programs`, and every point, route,
   group, position and check-in carries its program_id. One program is
   active (meta active_program): phones and marshals only ever see that one.
   Nothing is deleted when the next program starts; the command centre can
   look back at any earlier program read-only (?program=ID on GET state,
   positions and track). A program is closed at a time (ended_at): after it,
   logins, positions and check-ins are refused, and every phone logs out
   through the epoch.

   Checkpoints are revealed to a group one at a time: a participant phone
   (X-Group-Pin header) gets MULA, every checkpoint its group has reached,
   and the next one. "Reached" is a check-in only: by the marshal there, by
   the command centre relaying a radio call, or by the group's own phone with
   the point's code. GPS proximity does not reveal anything, so a group must
   report to the marshal (or scan the code) to get its next checkpoint.
   The command centre and marshals see everything; anyone else, MULA only.

   Every point also has a secret 6-character code, shown (as text and a QR)
   on the marshal phone standing there and printable from the command
   centre. A participant phone downloads every not-yet-revealed point as a
   `locked` blob, encrypted with the code of the point before it, so at a
   checkpoint with no signal the leader types or scans that checkpoint's
   code and the next one opens on the phone at once. The unlock is also
   queued as a check-in (source 'qr') and reaches the server when signal
   returns.

   Routes
     GET  /api/state[?program=ID]  { version, points, routes, groups, settings, area, progress?, locked? }
                                  points carry `code` and `etaMin` for CC / marshal only
                                  CC key / marshal PIN: all points · X-Group-Pin: revealed points · else MULA only
     PUT  /api/state              { points, routes:[{id,name,latlngs,from?,to?}] } → { version }   CC
     PUT  /api/groups             { groups }  → { version, groups:[{id,pin}] }    CC
     POST /api/groups/login       { pin }     → { id, name, startedAt }          public
     PUT  /api/settings           { smsNumber?, marshalPin? } → { version, settings }   CC
     GET  /api/programs           every program with counts, newest first        CC
     POST /api/programs           { name, place?, date?, notes?, copyPoints? } → { program }   CC
                                  creates it, makes it active (phones log out), copies the current
                                  checkpoints and routes with fresh codes when copyPoints
     PUT  /api/programs/:id       { name?, place?, date?, notes? } → { program }   CC
     POST /api/programs/:id/activate   make an earlier program the active one again   CC
     POST /api/programs/:id/day   { name?, date?, copyPoints? } → { program }   CC
                                  the next day of a multi-day program: same groups and PINs, its own
                                  checkpoints, routes, start times and records; becomes active
     POST /api/program/end        { endedAt?: ms | null } → { version, endedAt }   CC
                                  closes the active program at that time (default now; null reopens)
     POST /api/positions          { group, pin, device, items[] } → { version, saved, revealed }   group PIN or CC
     GET  /api/positions[?trail=N][&program=ID]  latest fix, check-ins and start per group   CC or marshal PIN
     GET  /api/track?group=ID[&since=ms][&program=ID]  every stored fix of one group, oldest first   CC
     POST /api/checkins           { device, items:[{group, point, at?, note?}] }  CC or marshal PIN
                                  { device, items:[{point, code, at?}] }         X-Group-Pin (source 'qr')
*/

const DEFAULT_START = { id: 'start', type: 'start', name: 'MULA', lat: 3.556879, lng: 101.632263 };

const MAX_BATCH = 200;      // positions or check-ins accepted in one POST
const MAX_TRAIL = 200;      // per-group trail points returned
const MAX_TRACK = 6000;     // fixes in one full-track answer: > 8 h at one a minute, several times over
const MAX_NAME = 120;
const MAX_NOTE = 200;
const MAX_NOTES = 1000;
const CLOCK_SLACK_MS = 7 * 24 * 3600 * 1000;
const AREA_PAD_M = 1500;    // margin around the program's points and routes for the offline map

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
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

const CODE_LEN = 6;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I — read aloud over radio, typed in rain
const isCode = (v) => typeof v === 'string' && v.length === CODE_LEN && [...v].every((c) => CODE_ALPHABET.includes(c));
const normCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LEN) : '');

/** A random checkpoint code not in `taken`. */
function newCode(taken) {
  const buf = new Uint8Array(CODE_LEN);
  for (;;) {
    crypto.getRandomValues(buf);
    const code = [...buf].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    if (!taken.has(code)) {
      taken.add(code);
      return code;
    }
  }
}

/* ── locking a point behind the previous point's code ─────────────────── */

const KDF_ITERATIONS = 30000;   // the phone must derive the same key; keep it quick on a mid-range Android
const textBytes = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function keyFromCode(code, pointId) {
  const base = await crypto.subtle.importKey('raw', textBytes(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: textBytes('jalan-lasak:' + pointId), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
}

/** AES-GCM(point) under the code, as base64(iv ‖ ciphertext). */
async function lockPoint(point, code) {
  const key = await keyFromCode(code, point.id);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = textBytes(JSON.stringify({ id: point.id, type: point.type, name: point.name, lat: point.lat, lng: point.lng, etaMin: point.etaMin, seq: point.seq }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

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

/** Phones compare this with the one they last synced; a change logs them out. */
const bumpEpoch = (db) => setMeta(db, 'epoch', String(Date.now()));

/* ── programs ─────────────────────────────────────────────────────────── */

const programOut = (r) => r && ({
  id: r.id, name: r.name, place: r.place || '', date: r.event_date || '', notes: r.notes || '',
  createdAt: r.created_at, endedAt: r.ended_at || null,
  // days of one event share a series; day counts from 1
  seriesId: r.series_id || r.id, day: r.day || 1
});

async function getProgram(db, id) {
  return db.prepare('SELECT * FROM programs WHERE id = ?').bind(id).first();
}

/**
 * The program phones and marshals work in. A fresh database gets one made
 * for it, with MULA to be moved to the real start.
 */
async function activeProgram(db) {
  const id = await getMeta(db, 'active_program');
  let row = id ? await getProgram(db, id) : null;
  if (row) return row;
  row = await db.prepare('SELECT * FROM programs ORDER BY seq DESC LIMIT 1').first();
  if (!row) {
    const pid = 'p_' + Date.now().toString(36);
    await db.batch([
      db.prepare('INSERT INTO programs (id, name, place, event_date, notes, created_at, ended_at, seq, series_id, day) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, 1)')
        .bind(pid, 'Program 1', '', '', '', Date.now(), pid),
      db.prepare('INSERT INTO points (program_id, id, type, name, lat, lng, seq) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .bind(pid, DEFAULT_START.id, 'start', DEFAULT_START.name, DEFAULT_START.lat, DEFAULT_START.lng)
    ]);
    row = await getProgram(db, pid);
  }
  await db.batch([setMeta(db, 'active_program', row.id)]);
  return row;
}

/**
 * Which program a read is about: the active one, or, for the command centre
 * only, any earlier one named by ?program=ID.
 */
async function programForRead(request, env, url) {
  const db = env.DB;
  const asked = url && url.searchParams.get('program');
  if (asked && isCC(request, env)) {
    if (!isId(asked)) throw new HttpError(400, 'ID program tidak sah.');
    const row = await getProgram(db, asked);
    if (!row) throw new HttpError(404, 'Program tidak wujud.');
    return row;
  }
  return activeProgram(db);
}

async function getSettings(db, program) {
  const [sms, pin, epoch] = await Promise.all([getMeta(db, 'sms_number'), getMeta(db, 'marshal_pin'), getMeta(db, 'epoch')]);
  return {
    smsNumber: sms || '',
    hasMarshalPin: !!pin,
    // epoch changes when a program is ended, created or switched; phones that saw an older one log out.
    epoch: Number(epoch) || 0,
    program: programOut(program),
    // kept for phones built against the earlier shape
    eventName: program.name || '',
    endedAt: program.ended_at || null
  };
}

/** Once the active program has been closed, phones may not log in or report any more. */
function assertOpen(program) {
  if (program.ended_at && Date.now() > program.ended_at) throw new HttpError(409, 'Program telah tamat.');
}

/**
 * Which of the ordered points a group has reached, and which it may see:
 * MULA, every point reached, and the first one not yet reached. Reaching a
 * point out of order still counts, but revealing walks the sequence.
 *
 * Only check-ins count. Walking past a checkpoint used to reveal the next
 * one through GPS; the organisers want every group to report to the marshal
 * (so heads are counted) or scan the code, and nothing else.
 */
async function progressFor(db, pid, groupId, points) {
  const checkins = await db.prepare('SELECT DISTINCT point_id FROM checkins WHERE program_id = ? AND group_id = ?').bind(pid, groupId).all();
  const reached = new Set(checkins.results.map((c) => c.point_id));
  const revealed = [];
  for (const p of points) {
    revealed.push(p);
    if (p.type !== 'start' && !reached.has(p.id)) break;
  }
  return {
    revealed,
    reached: points.filter((p) => reached.has(p.id)).map((p) => p.id),
    more: revealed.length < points.length   // whether any checkpoint is still to come — never how many
  };
}

/** A group of this program by its PIN, or null. */
const groupByPin = (db, pid, pin) =>
  isPin(pin) ? db.prepare('SELECT id, name, started_at, pin FROM groups WHERE program_id = ? AND pin = ?').bind(pid, pin).first() : null;

/** Who is asking for the program state, and therefore how much of it they get. */
async function stateRole(request, env, program) {
  if (isCC(request, env)) return { role: 'cc' };
  const mpin = (request.headers.get('X-Marshal-Pin') || '').trim();
  if (mpin) {
    const stored = await getMeta(env.DB, 'marshal_pin');
    if (stored && sameKey(mpin, stored)) return { role: 'marshal' };
    throw new HttpError(401, 'PIN marshal salah.');
  }
  const gpin = (request.headers.get('X-Group-Pin') || '').trim();
  if (gpin) {
    const g = await groupByPin(env.DB, program.id, gpin);
    if (g) return { role: 'group', group: g.id };
    throw new HttpError(401, 'PIN kumpulan salah — masuk semula.');
  }
  return { role: 'public' };
}

/**
 * The box every point and route falls in, padded. Sent to every role so a
 * participant phone can store the whole program's map before setting off,
 * without being told where the checkpoints it has not reached are.
 */
function programArea(points, routes) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  const take = (lat, lng) => {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lng < w) w = lng;
    if (lng > e) e = lng;
  };
  for (const p of points) take(p.lat, p.lng);
  for (const r of routes) for (const ll of r.latlngs) take(ll[0], ll[1]);
  if (!Number.isFinite(s)) return null;
  const dLat = AREA_PAD_M / 111320;
  const dLng = AREA_PAD_M / (111320 * Math.cos((s + n) / 2 * Math.PI / 180));
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  return { south: r5(s - dLat), west: r5(w - dLng), north: r5(n + dLat), east: r5(e + dLng) };
}

/* ── state ────────────────────────────────────────────────────────────── */

async function getState(request, env, url) {
  const db = env.DB;
  const program = await programForRead(request, env, url);
  const pid = program.id;
  const who = await stateRole(request, env, program);
  if (who.role !== 'public') await ensureCodes(db, pid);
  const [version, pointRows, routes, groups, settings] = await Promise.all([
    getVersion(db),
    db.prepare('SELECT id, type, name, lat, lng, eta_min, code FROM points WHERE program_id = ? ORDER BY seq').bind(pid).all(),
    db.prepare('SELECT id, name, latlngs, from_id, to_id FROM routes WHERE program_id = ? ORDER BY seq').bind(pid).all(),
    db.prepare('SELECT id, name, started_at FROM groups WHERE program_id = ? ORDER BY seq').bind(pid).all(),
    getSettings(db, program)
  ]);
  const all = pointRows.results.map((p, i) => ({
    id: p.id, type: p.type, name: p.name, lat: p.lat, lng: p.lng, etaMin: p.eta_min, seq: i, code: p.code
  }));
  const routeList = routes.results.map((r) => ({
    id: r.id, name: r.name, latlngs: JSON.parse(r.latlngs), from: r.from_id || null, to: r.to_id || null
  }));
  const area = programArea(all, routeList);
  // Routes are a command-centre tool (pace estimates, briefing marshals);
  // participant phones never receive them.
  let routesOut = routeList;
  // Only the command centre and marshals see a point's code and its place in
  // the schedule: a participant is meant to find the way and the pace, so the
  // expected time is not sent to their phone either.
  const strip = (p) => ({ ...p, code: undefined, etaMin: undefined });
  let points;
  let progress;
  let locked;
  if (who.role === 'group') {
    const pr = await progressFor(db, pid, who.group, all);
    points = pr.revealed.map(strip);
    progress = { reached: pr.reached, more: pr.more };
    routesOut = [];
    locked = [];
    for (let i = pr.revealed.length; i < all.length; i++) {
      const prev = all[i - 1];
      if (!prev || !isCode(prev.code)) continue;
      locked.push({ id: all[i].id, seq: all[i].seq, blob: await lockPoint(all[i], prev.code) });
    }
  } else if (who.role === 'public') {
    points = all.filter((p) => p.type === 'start').map(strip);
    progress = { reached: [], more: all.length > points.length };
    routesOut = [];
  } else {
    points = all;
  }
  return json({
    version,
    points,
    routes: routesOut,
    groups: groups.results.map((g) => ({ id: g.id, name: g.name, startedAt: g.started_at })),
    settings,
    area,
    ...(progress ? { progress } : {}),
    ...(locked ? { locked } : {})
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
  const pid = (await activeProgram(db)).id;
  // Codes survive an edit; a new point gets a fresh one.
  const existing = await db.prepare('SELECT id, code FROM points WHERE program_id = ?').bind(pid).all();
  const codeBefore = new Map(existing.results.map((p) => [p.id, p.code]));
  const takenCodes = new Set();
  const stmts = [
    db.prepare('DELETE FROM points WHERE program_id = ?').bind(pid),
    db.prepare('DELETE FROM routes WHERE program_id = ?').bind(pid)
  ];
  const seen = new Set();
  const pointIds = new Set(points.filter((p) => p && isId(p.id)).map((p) => p.id));
  const pointType = new Map(points.filter((p) => p && isId(p.id)).map((p) => [p.id, p.type === 'start' ? 'start' : 'cp']));

  points.forEach((p, i) => {
    if (!p || !isId(p.id) || !isLat(p.lat) || !isLng(p.lng)) throw new HttpError(400, `Titik #${i + 1} tidak sah.`);
    if (seen.has(p.id)) throw new HttpError(400, `ID titik berulang: ${p.id}`);
    seen.add(p.id);
    const kept = codeBefore.get(p.id);
    const code = isCode(kept) && !takenCodes.has(kept) ? (takenCodes.add(kept), kept) : newCode(takenCodes);
    stmts.push(db.prepare('INSERT INTO points (program_id, id, type, name, lat, lng, seq, eta_min, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(pid, p.id, p.type === 'start' ? 'start' : 'cp', cleanName(p.name, 'Checkpoint'), p.lat, p.lng, i,
        etaValue(p.etaMin, `Titik #${i + 1}`), code));
  });

  routes.forEach((r, i) => {
    const ok = r && isId(r.id) && Array.isArray(r.latlngs) && r.latlngs.length >= 2 &&
      r.latlngs.every((ll) => Array.isArray(ll) && isLat(ll[0]) && isLng(ll[1]));
    if (!ok) throw new HttpError(400, `Laluan #${i + 1} tidak sah.`);
    if (seen.has(r.id)) throw new HttpError(400, `ID berulang: ${r.id}`);
    seen.add(r.id);
    // Endpoints must be points of this program; the end must be a checkpoint.
    const from = r.from ? String(r.from) : null;
    const to = r.to ? String(r.to) : null;
    if (from && !pointIds.has(from)) throw new HttpError(400, `Laluan #${i + 1}: titik mula tidak wujud.`);
    if (to && (!pointIds.has(to) || pointType.get(to) !== 'cp')) throw new HttpError(400, `Laluan #${i + 1}: titik tamat mesti checkpoint.`);
    stmts.push(db.prepare('INSERT INTO routes (program_id, id, name, latlngs, seq, from_id, to_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(pid, r.id, cleanName(r.name, 'Laluan'), JSON.stringify(r.latlngs.map((ll) => [ll[0], ll[1]])), i, from, to));
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
 * A PIN only opens the active program, so an old sheet never opens a new one.
 * The response carries every group's PIN so the command centre can show it.
 */
async function putGroups(request, env) {
  requireCC(request, env);
  const body = await readJson(request);
  if (!Array.isArray(body.groups)) throw new HttpError(400, 'Perlukan senarai groups.');
  const db = env.DB;
  const pid = (await activeProgram(db)).id;
  const existing = await db.prepare('SELECT id, started_at, pin FROM groups WHERE program_id = ?').bind(pid).all();
  const startedBefore = new Map(existing.results.map((g) => [g.id, g.started_at]));
  const pinBefore = new Map(existing.results.map((g) => [g.id, g.pin]));

  const stmts = [db.prepare('DELETE FROM groups WHERE program_id = ?').bind(pid)];
  const seen = new Set();
  const taken = new Set();   // PINs are unique within a program; the days of one event share them
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
    stmts.push(db.prepare('INSERT INTO groups (program_id, id, name, seq, started_at, pin) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(pid, g.id, cleanName(g.name, 'Kumpulan ' + (i + 1)), i, startedAt, pin));
  });
  stmts.push(bumpVersion(db));
  await db.batch(stmts);
  return json({ version: await getVersion(db), groups: pins });
}

/** Groups created before PINs existed get one the first time the command centre looks. */
async function ensurePins(db, pid) {
  const rows = await db.prepare('SELECT id, pin FROM groups WHERE program_id = ?').bind(pid).all();
  const missing = rows.results.filter((g) => !isPin(g.pin));
  if (!missing.length) return;
  const taken = new Set(rows.results.map((g) => g.pin).filter(isPin));
  await db.batch(missing.map((g) =>
    db.prepare('UPDATE groups SET pin = ? WHERE program_id = ? AND id = ?').bind(newPin(taken), pid, g.id)));
}

/** Points created before codes existed get one the first time anyone needs them. */
async function ensureCodes(db, pid) {
  const rows = await db.prepare('SELECT id, code FROM points WHERE program_id = ?').bind(pid).all();
  const missing = rows.results.filter((p) => !isCode(p.code));
  if (!missing.length) return;
  const taken = new Set(rows.results.map((p) => p.code).filter(isCode));
  await db.batch(missing.map((p) =>
    db.prepare('UPDATE points SET code = ? WHERE program_id = ? AND id = ?').bind(newCode(taken), pid, p.id)));
}

/** A participant phone logs in with its group's PIN alone. */
async function loginGroup(request, env) {
  const body = await readJson(request);
  const pin = cleanText(body.pin, 16).replace(/\D/g, '');
  if (!isPin(pin)) throw new HttpError(400, `PIN kumpulan ialah ${PIN_DIGITS} digit.`);
  const program = await activeProgram(env.DB);
  assertOpen(program);
  const g = await groupByPin(env.DB, program.id, pin);
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
  return json({ version: await getVersion(db), settings: await getSettings(db, await activeProgram(db)) });
}

/* ── positions ────────────────────────────────────────────────────────── */

async function postPositions(request, env) {
  const body = await readJson(request);
  if (!isId(body.group) || !isId(body.device)) throw new HttpError(400, 'Perlukan group dan device.');
  const items = Array.isArray(body.items) ? body.items.slice(-MAX_BATCH) : [];

  const db = env.DB;
  const program = await activeProgram(db);
  const pid = program.id;
  const group = await db.prepare('SELECT id, pin FROM groups WHERE program_id = ? AND id = ?').bind(pid, body.group).first();
  if (!group) throw new HttpError(404, 'Kumpulan tidak wujud lagi — masuk semula.');
  // The phone proves it is this group with the group's PIN; the command centre
  // (typing in an SMS) proves itself with its key instead.
  if (!isCC(request, env) && !(isPin(group.pin) && sameKey(String(body.pin || ''), group.pin))) {
    throw new HttpError(401, 'PIN kumpulan salah — masuk semula.');
  }
  if (!isCC(request, env)) assertOpen(program);

  const now = Date.now();
  const stmts = [];
  for (const it of items) {
    if (!it || !isLat(it.lat) || !isLng(it.lng)) continue;
    stmts.push(db.prepare(
      'INSERT INTO positions (program_id, group_id, device, lat, lng, acc, battery, sos, source, recorded_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      pid, body.group, body.device, it.lat, it.lng,
      Number.isFinite(it.acc) ? Math.round(it.acc) : null,
      Number.isFinite(it.battery) ? Math.max(0, Math.min(1, it.battery)) : null,
      it.sos ? 1 : 0,
      it.source === 'sms' ? 'sms' : 'app',
      clientTime(it.at, now), now
    ));
  }
  if (stmts.length) await db.batch(stmts);
  const points = await db.prepare('SELECT id, type, lat, lng FROM points WHERE program_id = ? ORDER BY seq').bind(pid).all();
  const pr = await progressFor(db, pid, body.group, points.results);
  return json({ version: await getVersion(db), saved: stmts.length, revealed: pr.revealed.length });
}

async function getPositions(request, env, url) {
  const who = await requireCCOrMarshal(request, env);
  const db = env.DB;
  const pid = (await programForRead(request, env, url)).id;
  if (who === 'cc') await ensurePins(db, pid);
  const trail = Math.min(MAX_TRAIL, Math.max(0, parseInt(url.searchParams.get('trail') || '0', 10) || 0));

  // Latest fix per group, joined so deleted groups disappear.
  const latest = await db.prepare(`
    SELECT g.id AS group_id, g.name, g.seq, g.started_at, g.pin,
           p.lat, p.lng, p.acc, p.battery, p.sos, p.source, p.recorded_at, p.received_at, p.device
    FROM groups g
    LEFT JOIN positions p ON p.id = (
      SELECT id FROM positions WHERE program_id = g.program_id AND group_id = g.id ORDER BY recorded_at DESC, id DESC LIMIT 1
    )
    WHERE g.program_id = ?
    ORDER BY g.seq
  `).bind(pid).all();

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
    'SELECT group_id, point_id, source, note, recorded_at FROM checkins WHERE program_id = ? ORDER BY recorded_at'
  ).bind(pid).all();
  for (const c of checkins.results) {
    const g = byGroup.get(c.group_id);
    if (g) g.checkins.push({ point: c.point_id, at: c.recorded_at, source: c.source, note: c.note || '' });
  }

  if (trail > 0) {
    // One pass over the program's fixes. The earlier form ran a correlated
    // subquery per row (N × trail rows read per call, polled every 15 s),
    // which burned through D1's daily row-read allowance mid-event.
    const rows = await db.prepare(`
      SELECT group_id, lat, lng, sos, recorded_at FROM (
        SELECT group_id, lat, lng, sos, recorded_at,
               ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY recorded_at DESC, id DESC) AS rn
        FROM positions WHERE program_id = ?
      )
      WHERE rn <= ?
      ORDER BY group_id, recorded_at
    `).bind(pid, trail).all();
    for (const r of rows.results) {
      const g = byGroup.get(r.group_id);
      if (g) g.trail.push([r.lat, r.lng, r.recorded_at, r.sos ? 1 : 0]);
    }
  }

  return json({ now: Date.now(), groups });
}

/**
 * One group's whole recorded track, oldest first, for the full-route view and
 * the GPX / CSV export. Fixes are never deleted, so this is everything the
 * phone managed to deliver, offline queue included.
 */
async function getTrack(request, env, url) {
  requireCC(request, env);
  const id = url.searchParams.get('group');
  if (!isId(id)) throw new HttpError(400, 'Perlukan group.');
  const db = env.DB;
  const pid = (await programForRead(request, env, url)).id;
  const g = await db.prepare('SELECT id, name, started_at FROM groups WHERE program_id = ? AND id = ?').bind(pid, id).first();
  if (!g) throw new HttpError(404, 'Kumpulan tidak wujud lagi.');
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const [fixes, checkins] = await Promise.all([
    db.prepare(`SELECT lat, lng, acc, battery, sos, source, recorded_at FROM positions
                WHERE program_id = ? AND group_id = ? AND recorded_at >= ? ORDER BY recorded_at, id LIMIT ?`).bind(pid, id, since, MAX_TRACK).all(),
    db.prepare('SELECT point_id, source, recorded_at FROM checkins WHERE program_id = ? AND group_id = ? ORDER BY recorded_at').bind(pid, id).all()
  ]);
  return json({
    group: { id: g.id, name: g.name, startedAt: g.started_at },
    // [lat, lng, at, sos, acc, battery, source]
    fixes: fixes.results.map((r) => [r.lat, r.lng, r.recorded_at, r.sos ? 1 : 0, r.acc, r.battery, r.source]),
    checkins: checkins.results.map((c) => ({ point: c.point_id, source: c.source, at: c.recorded_at })),
    truncated: fixes.results.length >= MAX_TRACK
  });
}

/* ── check-ins ────────────────────────────────────────────────────────── */

async function postCheckins(request, env) {
  const db = env.DB;
  const program = await activeProgram(db);
  const pid = program.id;
  // A participant phone may also check in — for its own group only, and only
  // with the checkpoint's code as proof it stood there.
  const gpin = (request.headers.get('X-Group-Pin') || '').trim();
  let who;
  let ownGroup = null;
  if (gpin && !isCC(request, env)) {
    const g = await groupByPin(db, pid, gpin);
    if (!g) throw new HttpError(401, 'PIN kumpulan salah — masuk semula.');
    who = 'qr';
    ownGroup = g.id;
  } else {
    who = await requireCCOrMarshal(request, env);
  }
  const body = await readJson(request);
  if (body.verify) return json({ ok: true, role: who });   // a marshal phone checking its PIN
  if (who !== 'cc') assertOpen(program);
  const items = Array.isArray(body.items) ? body.items.slice(-MAX_BATCH) : [];
  if (!items.length) throw new HttpError(400, 'Tiada daftar masuk diberi.');
  const device = isId(body.device) ? body.device : null;

  const [groups, points] = await Promise.all([
    db.prepare('SELECT id, started_at FROM groups WHERE program_id = ?').bind(pid).all(),
    db.prepare('SELECT id, type, code FROM points WHERE program_id = ?').bind(pid).all()
  ]);
  const groupStart = new Map(groups.results.map((g) => [g.id, g.started_at]));
  const pointType = new Map(points.results.map((p) => [p.id, p.type]));
  const pointCode = new Map(points.results.map((p) => [p.id, p.code]));

  const now = Date.now();
  const stmts = [];
  const started = {};
  for (const it of items) {
    if (!it || !isId(it.point)) continue;
    if (ownGroup) it.group = ownGroup;
    if (!isId(it.group)) continue;
    if (!groupStart.has(it.group)) throw new HttpError(404, 'Kumpulan tidak wujud lagi.');
    if (!pointType.has(it.point)) throw new HttpError(404, 'Titik tidak wujud lagi.');
    if (who === 'qr' && !(isCode(pointCode.get(it.point)) && sameKey(normCode(it.code), pointCode.get(it.point)))) {
      throw new HttpError(400, 'Kod checkpoint salah.');
    }
    const at = clientTime(it.at, now);
    stmts.push(db.prepare(
      'INSERT INTO checkins (program_id, group_id, point_id, source, device, note, recorded_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(pid, it.group, it.point, who, device, cleanText(it.note, MAX_NOTE) || null, at, now));
    // Setting off from the start is what starts a group's clock.
    if (pointType.get(it.point) === 'start' && groupStart.get(it.group) === null && !(it.group in started)) {
      started[it.group] = at;
      stmts.push(db.prepare('UPDATE groups SET started_at = ? WHERE program_id = ? AND id = ? AND started_at IS NULL').bind(at, pid, it.group));
    }
  }
  if (!stmts.length) throw new HttpError(400, 'Tiada daftar masuk yang sah.');
  // Every check-in may reveal the next checkpoint to a group; a version bump
  // is what makes its phone fetch the state again.
  stmts.push(bumpVersion(db));
  await db.batch(stmts);
  return json({ version: await getVersion(db), saved: items.length, started });
}

/* ── programs: list, create, edit, switch, close ──────────────────────── */

async function listPrograms(request, env) {
  requireCC(request, env);
  const db = env.DB;
  const active = await activeProgram(db);
  const rows = await db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM groups g WHERE g.program_id = p.id) AS n_groups,
      (SELECT COUNT(*) FROM points x WHERE x.program_id = p.id AND x.type = 'cp') AS n_points,
      (SELECT COUNT(*) FROM positions x WHERE x.program_id = p.id) AS n_positions,
      (SELECT COUNT(*) FROM checkins x WHERE x.program_id = p.id) AS n_checkins
    FROM programs p ORDER BY p.seq DESC
  `).all();
  return json({
    active: active.id,
    programs: rows.results.map((r) => ({
      ...programOut(r), active: r.id === active.id,
      counts: { groups: r.n_groups, checkpoints: r.n_points, positions: r.n_positions, checkins: r.n_checkins }
    }))
  });
}

function programFields(body, current = {}) {
  const name = cleanName(body.name, current.name || '');
  if (!name) throw new HttpError(400, 'Program perlukan nama.');
  const place = 'place' in body ? cleanText(body.place, MAX_NAME) : (current.place || '');
  let date = 'date' in body ? cleanText(body.date, 10) : (current.event_date || '');
  if (date && !isDate(date)) throw new HttpError(400, 'Tarikh mesti dalam bentuk YYYY-MM-DD.');
  const notes = 'notes' in body ? cleanText(body.notes, MAX_NOTES) : (current.notes || '');
  return { name, place, date, notes };
}

/**
 * Start the next program. It becomes active at once, so every phone logs out
 * (the epoch); the last program keeps everything. With copyPoints the current
 * program's checkpoints and routes are copied over with fresh codes, for a
 * repeat at the same place.
 */
async function createProgram(request, env) {
  requireCC(request, env);
  const body = await readJson(request);
  const db = env.DB;
  const current = await activeProgram(db);
  const f = programFields(body);
  const pid = 'p_' + Date.now().toString(36);
  const seqRow = await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM programs').first();
  const stmts = [
    db.prepare('INSERT INTO programs (id, name, place, event_date, notes, created_at, ended_at, seq, series_id, day) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)')
      .bind(pid, f.name, f.place, f.date, f.notes, Date.now(), seqRow.seq, pid)
  ];
  if (body.copyPoints) {
    const [points, routes] = await Promise.all([
      db.prepare('SELECT * FROM points WHERE program_id = ? ORDER BY seq').bind(current.id).all(),
      db.prepare('SELECT * FROM routes WHERE program_id = ? ORDER BY seq').bind(current.id).all()
    ]);
    const taken = new Set();
    for (const p of points.results) {
      stmts.push(db.prepare('INSERT INTO points (program_id, id, type, name, lat, lng, seq, eta_min, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(pid, p.id, p.type, p.name, p.lat, p.lng, p.seq, p.eta_min, newCode(taken)));
    }
    for (const r of routes.results) {
      stmts.push(db.prepare('INSERT INTO routes (program_id, id, name, latlngs, seq, from_id, to_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(pid, r.id, r.name, r.latlngs, r.seq, r.from_id, r.to_id));
    }
  } else {
    const start = await db.prepare("SELECT * FROM points WHERE program_id = ? AND type = 'start'").bind(current.id).first();
    const s = start || DEFAULT_START;
    stmts.push(db.prepare('INSERT INTO points (program_id, id, type, name, lat, lng, seq) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .bind(pid, 'start', 'start', s.name, s.lat, s.lng));
  }
  stmts.push(setMeta(db, 'active_program', pid));
  stmts.push(bumpEpoch(db));
  stmts.push(bumpVersion(db));
  await db.batch(stmts);
  return json({ version: await getVersion(db), program: programOut(await getProgram(db, pid)) });
}

async function updateProgram(request, env, id) {
  requireCC(request, env);
  if (!isId(id)) throw new HttpError(400, 'ID program tidak sah.');
  const db = env.DB;
  const current = await getProgram(db, id);
  if (!current) throw new HttpError(404, 'Program tidak wujud.');
  const body = await readJson(request);
  const f = programFields(body, current);
  await db.batch([
    db.prepare('UPDATE programs SET name = ?, place = ?, event_date = ?, notes = ? WHERE id = ?').bind(f.name, f.place, f.date, f.notes, id),
    bumpVersion(db)
  ]);
  return json({ version: await getVersion(db), program: programOut(await getProgram(db, id)) });
}

/** "Jalan Lasak KKB — Hari 2" → "Jalan Lasak KKB". */
const baseName = (name) => name.replace(/\s+[—-]+\s+Hari\s+\d+$/i, '').trim();

/** YYYY-MM-DD plus n days, or '' when there is no date to count from. */
function shiftDate(date, n) {
  if (!isDate(date)) return '';
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The next day of a multi-day event. It is a program of its own (its own
 * checkpoints, routes, start times and records) in the same series as the
 * one given, with the same groups and PINs so the phones stay logged in.
 * It becomes active; copyPoints carries the checkpoints and routes over
 * with fresh codes, otherwise only MULA comes along, to be moved.
 */
async function addProgramDay(request, env, id) {
  requireCC(request, env);
  if (!isId(id)) throw new HttpError(400, 'ID program tidak sah.');
  const db = env.DB;
  const parent = await getProgram(db, id);
  if (!parent) throw new HttpError(404, 'Program tidak wujud.');
  const body = await readJson(request);
  const series = parent.series_id || parent.id;
  const last = await db.prepare('SELECT MAX(day) AS d FROM programs WHERE series_id = ? OR id = ?').bind(series, series).first();
  const day = (last && last.d ? last.d : 1) + 1;
  const name = cleanName(body.name, '') || `${baseName(parent.name)} — Hari ${day}`;
  let date = 'date' in body && body.date !== undefined ? cleanText(body.date, 10) : shiftDate(parent.event_date, day - (parent.day || 1));
  if (date && !isDate(date)) throw new HttpError(400, 'Tarikh mesti dalam bentuk YYYY-MM-DD.');
  const pid = 'p_' + Date.now().toString(36);
  const seqRow = await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM programs').first();
  const stmts = [
    db.prepare('INSERT INTO programs (id, name, place, event_date, notes, created_at, ended_at, seq, series_id, day) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)')
      .bind(pid, name, parent.place || '', date, parent.notes || '', Date.now(), seqRow.seq, series, day)
  ];
  const groups = await db.prepare('SELECT * FROM groups WHERE program_id = ? ORDER BY seq').bind(parent.id).all();
  for (const g of groups.results) {
    stmts.push(db.prepare('INSERT INTO groups (program_id, id, name, seq, started_at, pin) VALUES (?, ?, ?, ?, NULL, ?)')
      .bind(pid, g.id, g.name, g.seq, g.pin));
  }
  if (body.copyPoints) {
    const [points, routes] = await Promise.all([
      db.prepare('SELECT * FROM points WHERE program_id = ? ORDER BY seq').bind(parent.id).all(),
      db.prepare('SELECT * FROM routes WHERE program_id = ? ORDER BY seq').bind(parent.id).all()
    ]);
    const taken = new Set();
    for (const p of points.results) {
      stmts.push(db.prepare('INSERT INTO points (program_id, id, type, name, lat, lng, seq, eta_min, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(pid, p.id, p.type, p.name, p.lat, p.lng, p.seq, p.eta_min, newCode(taken)));
    }
    for (const r of routes.results) {
      stmts.push(db.prepare('INSERT INTO routes (program_id, id, name, latlngs, seq, from_id, to_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(pid, r.id, r.name, r.latlngs, r.seq, r.from_id, r.to_id));
    }
  } else {
    const start = await db.prepare("SELECT * FROM points WHERE program_id = ? AND type = 'start'").bind(parent.id).first();
    const s = start || DEFAULT_START;
    stmts.push(db.prepare('INSERT INTO points (program_id, id, type, name, lat, lng, seq) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .bind(pid, 'start', 'start', s.name, s.lat, s.lng));
  }
  stmts.push(setMeta(db, 'active_program', pid));
  stmts.push(bumpEpoch(db));
  stmts.push(bumpVersion(db));
  await db.batch(stmts);
  return json({ version: await getVersion(db), program: programOut(await getProgram(db, pid)) });
}

/** Make an earlier program the active one again (phones log out and re-enter). */
async function activateProgram(request, env, id) {
  requireCC(request, env);
  if (!isId(id)) throw new HttpError(400, 'ID program tidak sah.');
  const db = env.DB;
  const row = await getProgram(db, id);
  if (!row) throw new HttpError(404, 'Program tidak wujud.');
  await db.batch([setMeta(db, 'active_program', id), bumpEpoch(db), bumpVersion(db)]);
  return json({ version: await getVersion(db), program: programOut(row) });
}

/**
 * Close the active program at a time (default now) without touching its
 * records: phones log out through the epoch, and nothing may be reported
 * after it. endedAt null reopens it.
 */
async function endProgram(request, env) {
  requireCC(request, env);
  const body = await readJson(request);
  const db = env.DB;
  const program = await activeProgram(db);
  const endedAt = body.endedAt === null ? null : (Number.isFinite(body.endedAt) ? body.endedAt : Date.now());
  await db.batch([
    db.prepare('UPDATE programs SET ended_at = ? WHERE id = ?').bind(endedAt, program.id),
    bumpEpoch(db),
    bumpVersion(db)
  ]);
  return json({ version: await getVersion(db), endedAt });
}

/* ── router ───────────────────────────────────────────────────────────── */

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  try {
    if (!env.DB) throw new HttpError(503, 'Pangkalan data D1 belum diikat (binding DB).');

    if (route === 'state' && method === 'GET') return await getState(request, env, url);
    if (route === 'state' && method === 'PUT') return await putState(request, env);
    if (route === 'groups' && method === 'PUT') return await putGroups(request, env);
    if (route === 'groups/login' && method === 'POST') return await loginGroup(request, env);
    if (route === 'settings' && method === 'PUT') return await putSettings(request, env);
    if (route === 'positions' && method === 'POST') return await postPositions(request, env);
    if (route === 'positions' && method === 'GET') return await getPositions(request, env, url);
    if (route === 'track' && method === 'GET') return await getTrack(request, env, url);
    if (route === 'checkins' && method === 'POST') return await postCheckins(request, env);
    if (route === 'programs' && method === 'GET') return await listPrograms(request, env);
    if (route === 'programs' && method === 'POST') return await createProgram(request, env);
    const m = route.match(/^programs\/([\w-]+)(?:\/(activate|day))?$/);
    if (m && !m[2] && method === 'PUT') return await updateProgram(request, env, m[1]);
    if (m && m[2] === 'activate' && method === 'POST') return await activateProgram(request, env, m[1]);
    if (m && m[2] === 'day' && method === 'POST') return await addProgramDay(request, env, m[1]);
    if (route === 'program/end' && method === 'POST') return await endProgram(request, env);
    if (route === 'ping') return json({ ok: true, now: Date.now() });

    return fail(404, 'Laluan API tidak wujud.');
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message);
    console.error(err);
    return fail(500, 'Ralat pelayan.');
  }
}
