/* Command centre: edits points and routes, manages groups and the schedule,
   watches every group's position and check-ins, raises the alarm when a group
   is late or sends SOS. Proven to the server by the CC_KEY, entered once and
   kept on this device. */

import { boot, $, el, isStart, groupLabel } from './core.js';
import { mountEditing } from './edit.js';
import { getState, putState, putGroups, putSettings, getPositions, postPositions, postCheckins } from './api.js';
import { loadCCKey, saveCCKey, saveState } from './store.js';
import { askText, askChoice, askConfirm, notify, toast } from './ui.js';
import { distM, fmtDist } from './geo.js';
import { scheduleFor, lateness, etaLabel, paceEstimate, paceLabel } from './schedule.js';
import { mountTabs } from './tabs.js';

const POSITIONS_POLL_MS = 15 * 1000;
const TRAIL_POINTS = 60;
const STALE_WARN_MS = 10 * 60 * 1000;
const STALE_BAD_MS = 20 * 60 * 1000;

const core = boot({ editable: true });
mountEditing(core);
const { L, map, state } = core;
mountTabs({ map, storageKey: 'jl_tab_pusat', defaultPane: 'kumpulan' });

let key = loadCCKey();
let positions = [];          // [{ id, name, startedAt, pin, last, checkins, trail }]
const pins = {};             // group id → its login PIN, as the server reports it
let serverNow = Date.now();
let selectedGroup = null;
const groupMarkers = {};
let trailLine = null;

const clock = (ms) => new Date(ms).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit' });
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'baru sahaja' : m + ' min lalu';
};
const minutes = (ms) => Math.round(Math.abs(ms) / 60000) + ' min';
const pointName = (p) => (isStart(p) ? 'MULA' : p.name);

/* ── key ────────────────────────────────────────────────────────────── */

async function ensureKey() {
  for (;;) {
    if (!key) {
      const entered = await askText({
        title: 'Pusat kawalan',
        body: 'Masukkan kunci pusat kawalan (CC_KEY yang ditetapkan pada pelayan).',
        label: 'Kunci',
        type: 'password',
        okLabel: 'Masuk',
        cancelLabel: 'Batal'
      });
      if (!entered) {
        await notify({ title: 'Kunci diperlukan', body: 'Pusat kawalan tidak boleh dibuka tanpa kunci.' });
        continue;
      }
      key = entered;
    }
    try {
      await getPositions(key);
      saveCCKey(key);
      return true;
    } catch (err) {
      if (err.status === 401) {
        key = '';
        saveCCKey('');
        await notify({ title: 'Kunci salah', body: 'Cuba lagi.' });
        continue;
      }
      // Server unreachable or CC_KEY unset: carry on with the cached map so the
      // operator can still see the program, and keep the key for the retry.
      setSync('bad', err.message);
      return false;
    }
  }
}

/** Run a server call; a 401 means the key changed, so re-ask and retry once. */
async function withKey(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status !== 401) throw err;
    key = '';
    saveCCKey('');
    if (!(await ensureKey())) throw err;
    return fn();
  }
}

/* ── pushing edits to the server ────────────────────────────────────── */

const syncStat = $('syncstat');
function setSync(kind, text) {
  syncStat.textContent = text;
  syncStat.className = 'stat ' + kind;
}

let pushTimer = null;
let dirty = false;
let pushing = false;

function schedulePush() {
  dirty = true;
  setSync('warn', 'Menyimpan…');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 600);
}

async function push() {
  if (pushing || !dirty) return;
  pushing = true;
  try {
    const { version } = await withKey(() => putState(key, { points: state.points, routes: state.routes }));
    state.version = version;
    saveState(state);
    dirty = false;
    setSync('ok', 'Disimpan ' + clock(Date.now()));
  } catch (err) {
    setSync('bad', 'Belum disimpan — ' + err.message);
  } finally {
    pushing = false;
  }
}

core.hooks.change = schedulePush;
window.addEventListener('online', () => { if (dirty) push(); });
setInterval(() => { if (dirty && !pushing) push(); }, 30 * 1000);

async function pullState() {
  try {
    const next = await getState({ key });
    if (dirty) return;                  // never overwrite edits still in flight
    const ids = (list) => (list || []).map((x) => x.id).join(',');
    const differs = next.version !== state.version ||
      ids(next.points) !== ids(state.points) || ids(next.routes) !== ids(state.routes);
    if (differs) core.applyState(next);
    else {
      state.groups = next.groups;
      state.settings = next.settings || state.settings;
      saveState(state);
    }
    renderGroups();
    renderPositions();
  } catch { /* keep the cached copy */ }
}

/* ── groups ─────────────────────────────────────────────────────────── */

/**
 * Send the group list. Only `starts` (id → ms | null) carries a start time;
 * every other group is sent without one so the server keeps what a marshal
 * may have set since this page last synced. Ids in `resetPins` get a fresh
 * login PIN. The server answers with every group's PIN. Resolves to true
 * when the save went through.
 */
async function saveGroups(starts = {}, resetPins = []) {
  const payload = state.groups.map((g) => {
    const item = { id: g.id, name: g.name };
    if (g.id in starts) item.startedAt = starts[g.id];
    if (resetPins.includes(g.id)) item.resetPin = true;
    return item;
  });
  let ok = false;
  try {
    const { version, groups } = await withKey(() => putGroups(key, payload));
    state.version = version;
    for (const g of state.groups) if (g.id in starts) g.startedAt = starts[g.id];
    for (const g of groups || []) pins[g.id] = g.pin;
    saveState(state);
    setSync('ok', 'Disimpan ' + clock(Date.now()));
    ok = true;
  } catch (err) {
    setSync('bad', 'Kumpulan belum disimpan — ' + err.message);
  }
  renderGroups();
  await pollPositions();
  return ok;
}

/** Show a group's PIN the way the leader must type it. */
function showPin(g, intro) {
  const body = el('div', 'dialog-body');
  body.append(
    el('div', null, (intro ? intro + ' ' : '') + 'Ketua kumpulan masukkan PIN ini di app peserta:'),
    el('div', 'pin-big', pins[g.id] || '—'),
    el('div', null, 'PIN ini hanya untuk kumpulan ini. Jangan kongsi dengan kumpulan lain.')
  );
  return notify({ title: 'PIN ' + g.name, body, okLabel: 'Tutup' });
}

$('btnAddGroup').addEventListener('click', async () => {
  const suggested = 'Kumpulan ' + (state.groups.length + 1);
  const name = await askText({ title: 'Kumpulan baharu', value: suggested, label: 'Nama kumpulan', okLabel: 'Tambah' });
  if (name === null) return;
  const g = { id: 'k_' + Date.now().toString(36), name: name || suggested, startedAt: null };
  state.groups.push(g);
  if (await saveGroups()) await showPin(g, 'Kumpulan ditambah.');
});

async function resetPin(id) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  const ok = await askConfirm({
    title: 'PIN baharu untuk ' + g.name + '?',
    body: 'PIN lama tidak sah serta-merta — telefon kumpulan ini perlu masuk semula dengan PIN baharu.',
    okLabel: 'Jana PIN baharu'
  });
  if (!ok) return;
  if (await saveGroups({}, [id])) await showPin(g, 'PIN baharu dijana.');
}

async function renameGroup(id) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  const name = await askText({ title: 'Namakan semula', value: g.name, label: 'Nama kumpulan' });
  if (name === null || !name) return;
  g.name = name;
  await saveGroups();
}

async function deleteGroup(id) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  const ok = await askConfirm({
    title: 'Padam kumpulan?',
    body: g.name + ' — telefon kumpulan ini akan diminta masuk semula, dan kedudukannya tidak lagi dipaparkan.',
    okLabel: 'Padam'
  });
  if (!ok) return;
  state.groups = state.groups.filter((x) => x.id !== id);
  await saveGroups();
}

async function startGroup(id, on) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  if (!on) {
    const ok = await askConfirm({ title: 'Set semula masa mula?', body: g.name + ' — jadualnya tidak akan dikira sehingga bertolak semula.', okLabel: 'Set semula' });
    if (!ok) return;
  }
  await saveGroups({ [id]: on ? Date.now() : null });
  toast(on ? g.name + ' bertolak ' + clock(Date.now()) : 'Masa mula ' + g.name + ' dibuang.');
}

$('btnStartAll').addEventListener('click', async () => {
  const waiting = state.groups.filter((g) => !Number.isFinite(g.startedAt));
  if (!waiting.length) {
    toast('Semua kumpulan sudah bertolak.');
    return;
  }
  const ok = await askConfirm({
    title: 'Mula semua sekarang?',
    body: waiting.length + ' kumpulan yang belum bertolak akan dicatat bertolak pada ' + clock(Date.now()) + '.',
    okLabel: 'Mula semua'
  });
  if (!ok) return;
  const now = Date.now();
  const starts = {};
  waiting.forEach((g) => { starts[g.id] = now; });
  await saveGroups(starts);
});

function renderGroups() {
  const wrap = $('grouplist');
  wrap.textContent = '';
  if (!state.groups.length) {
    wrap.append(el('div', 'empty', 'Tiada kumpulan lagi — tambah satu untuk setiap telefon ketua kumpulan.'));
  }
  state.groups.forEach((g, i) => {
    const row = el('div', 'row grp');
    row.append(el('span', 'badge outline', groupLabel(g, i)));
    const text = el('span');
    text.append(el('span', 'nm', g.name), el('br'),
      el('span', 'co', (Number.isFinite(g.startedAt) ? 'Bertolak ' + clock(g.startedAt) : 'Belum bertolak') +
        ' · PIN ' + (pins[g.id] || '…')));
    row.append(text);
    const pin = el('button', 'jl-btn sm', 'PIN');
    pin.type = 'button';
    pin.title = 'Papar atau jana semula PIN kumpulan';
    pin.addEventListener('click', async () => {
      if (!pins[g.id]) await pollPositions();
      const action = await askChoice({
        title: 'PIN ' + g.name,
        body: 'PIN semasa: ' + (pins[g.id] || '—'),
        options: [
          { value: 'show', label: 'Papar untuk ketua kumpulan' },
          { value: 'reset', label: 'Jana PIN baharu' }
        ],
        cancelLabel: 'Tutup'
      });
      if (action === 'show') showPin(g, '');
      else if (action === 'reset') resetPin(g.id);
    });
    const rename = el('button', 'jl-btn sm', 'Nama');
    rename.type = 'button';
    rename.addEventListener('click', () => renameGroup(g.id));
    const del = el('button', 'jl-btn sm del', 'Padam');
    del.type = 'button';
    del.addEventListener('click', () => deleteGroup(g.id));
    row.append(pin, rename, del);
    wrap.append(row);
  });
  const s = state.settings || {};
  $('setstat').textContent = (s.smsNumber ? 'SMS ke ' + s.smsNumber : 'Nombor SMS belum ditetapkan') +
    ' · ' + (s.hasMarshalPin ? 'PIN marshal ditetapkan' : 'PIN marshal belum ditetapkan');
}

/* ── settings: SMS number + marshal PIN ─────────────────────────────── */

$('btnSettings').addEventListener('click', async () => {
  const s = state.settings || {};
  const sms = await askText({
    title: 'Nombor SMS pusat kawalan',
    body: 'Telefon peserta akan hantar SMS ke nombor ini bila data tiada. Kosongkan untuk buang.',
    value: s.smsNumber || '',
    placeholder: '+60123456789',
    label: 'Nombor',
    inputMode: 'tel',
    okLabel: 'Seterusnya'
  });
  if (sms === null) return;
  const pin = await askText({
    title: 'PIN marshal',
    body: (s.hasMarshalPin ? 'PIN sedia ada dikekalkan jika dikosongkan.' : 'Belum ada PIN.') +
      ' Marshal di setiap checkpoint masukkan PIN ini di /marshal.html. Sekurang-kurangnya 4 aksara.',
    placeholder: s.hasMarshalPin ? '(kekalkan)' : 'cth. 4821',
    label: 'PIN',
    okLabel: 'Simpan'
  });
  if (pin === null) return;
  const payload = { smsNumber: sms };
  if (pin) payload.marshalPin = pin;
  try {
    const result = await withKey(() => putSettings(key, payload));
    state.version = result.version;
    state.settings = result.settings;
    saveState(state);
    renderGroups();
    toast('Tetapan disimpan.');
  } catch (err) {
    notify({ title: 'Gagal simpan tetapan', body: err.message });
  }
});

/* ── checkpoint codes: see them, print them for the marshals ────────── */

function qrSvg(text, cellSize = 4) {
  if (typeof window.qrcode !== 'function') return '';
  try {
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize, margin: 2, scalable: true });
  } catch {
    return '';
  }
}

$('btnCodes').addEventListener('click', async () => {
  await pullState();
  const withCodes = state.points.filter((p) => p.code);
  if (!withCodes.length) {
    notify({ title: 'Tiada kod lagi', body: 'Kod dijana bila pusat kawalan bersambung. Cuba sebentar lagi.' });
    return;
  }
  const body = el('div', 'dialog-body');
  body.append(el('div', null, 'Setiap marshal memaparkan kod checkpoint-nya kepada ketua kumpulan. Cetak satu helai untuk setiap checkpoint sebagai sandaran — jangan letak semua kod pada satu helai di trek.'));
  const list = el('div', 'codelist');
  withCodes.forEach((p) => {
    const row = el('div', 'coderow');
    row.append(el('span', 'nm', pointName(p)), el('span', 'code', p.code));
    list.append(row);
  });
  body.append(list);
  const print = await askConfirm({ title: 'Kod checkpoint', body, okLabel: 'Cetak', cancelLabel: 'Tutup' });
  if (!print) return;
  const base = new URL('./', location.href).href;
  const pages = withCodes.map((p) => `
    <section class="sheet">
      <div class="brand">JALAN LASAK</div>
      <h1>${pointName(p).replace(/[<>&]/g, '')}</h1>
      <div class="qr">${qrSvg(base + '?kod=' + p.code, 8)}</div>
      <div class="code">${p.code}</div>
      <p>Ketua kumpulan: taip kod ini dalam app Jalan Lasak, atau imbas QR, untuk membuka checkpoint seterusnya.</p>
    </section>`).join('');
  const w = window.open('', '_blank');
  if (!w) {
    notify({ title: 'Tetingkap disekat', body: 'Benarkan pop-up untuk mencetak.' });
    return;
  }
  w.document.write(`<!DOCTYPE html><html lang="ms"><head><meta charset="utf-8"><title>Kod checkpoint — Jalan Lasak</title>
    <style>
      body { font-family: Archivo, system-ui, sans-serif; margin: 0; color: #201e1d; }
      .sheet { page-break-after: always; min-height: 96vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; box-sizing: border-box; }
      .brand { font-weight: 800; letter-spacing: .12em; font-size: 18px; }
      h1 { font-size: 34px; margin: 8px 0 18px; }
      .qr svg { width: 62vw; max-width: 420px; height: auto; }
      .code { font-weight: 800; font-size: 64px; letter-spacing: .22em; margin: 18px 0 8px; }
      p { max-width: 460px; font-size: 16px; }
    </style></head><body>${pages}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
});

/* ── manual check-in (radio call) and SMS entry ─────────────────────── */

async function checkInGroup(id) {
  const g = positions.find((x) => x.id === id) || state.groups.find((x) => x.id === id);
  if (!g) return;
  const status = scheduleFor(g, state.points, serverNow);
  const point = await askChoice({
    title: 'Tiba di mana? — ' + g.name,
    body: 'Catat kumpulan ini sampai di titik (contohnya dari panggilan radio marshal).',
    options: state.points.map((p) => ({
      value: p.id,
      label: (status.reached.has(p.id) ? '✓ ' : '') + pointName(p) + (isStart(p) ? ' (bertolak)' : ''),
      selected: status.next && status.next.point.id === p.id
    })),
    cancelLabel: 'Batal'
  });
  if (!point) return;
  try {
    await withKey(() => postCheckins({ key, device: 'cc', items: [{ group: id, point, at: Date.now() }] }));
    toast(g.name + ' dicatat tiba.');
    await pullState();
    await pollPositions();
  } catch (err) {
    notify({ title: 'Gagal catat', body: err.message });
  }
}

/** "JL K3 3.54012,101.65123 12:04 SOS" — or anything with a lat,lng in it. */
function parseSms(text) {
  const coord = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/.exec(text);
  if (!coord) return null;
  const lat = parseFloat(coord[1]);
  const lng = parseFloat(coord[2]);
  const sos = /\bSOS\b/i.test(text);
  const rest = text.replace(coord[0], ' ').replace(/\bSOS\b/i, ' ').replace(/\bJL\b/i, ' ');
  const tokens = rest.split(/\s+/).filter(Boolean);
  let group = null;
  state.groups.forEach((g, i) => {
    if (group) return;
    const label = groupLabel(g, i).toLowerCase();
    if (tokens.some((t) => t.toLowerCase() === label || t.toLowerCase() === 'k' + label)) group = g;
    else if (rest.toLowerCase().includes(g.name.toLowerCase())) group = g;
  });
  return { lat, lng, sos, group };
}

$('btnSmsIn').addEventListener('click', async () => {
  const text = await askText({
    title: 'Masukkan SMS',
    body: 'Tampal teks SMS dari ketua kumpulan, atau taip sendiri: nombor kumpulan, lat,lng dan SOS jika ada.',
    placeholder: 'JL K3 3.54012,101.65123 12:04 SOS',
    label: 'Teks SMS',
    okLabel: 'Seterusnya'
  });
  if (!text) return;
  const parsed = parseSms(text);
  if (!parsed) {
    notify({ title: 'Koordinat tidak dijumpai', body: 'Perlukan bentuk lat,lng — contohnya 3.54012,101.65123.' });
    return;
  }
  let groupId = parsed.group ? parsed.group.id : null;
  if (!groupId) {
    groupId = await askChoice({
      title: 'Kumpulan mana?',
      body: parsed.lat.toFixed(5) + ', ' + parsed.lng.toFixed(5) + (parsed.sos ? ' · SOS' : ''),
      options: state.groups.map((g, i) => ({ value: g.id, label: groupLabel(g, i) + ' — ' + g.name })),
      cancelLabel: 'Batal'
    });
    if (!groupId) return;
  }
  try {
    await withKey(() => postPositions(groupId, 'cc',
      [{ lat: parsed.lat, lng: parsed.lng, sos: parsed.sos, source: 'sms', at: Date.now() }], { key }));
    toast('Kedudukan SMS dicatat' + (parsed.sos ? ' — SOS.' : '.'));
    await pollPositions();
  } catch (err) {
    notify({ title: 'Gagal catat', body: err.message });
  }
});

/* ── positions ──────────────────────────────────────────────────────── */

function staleness(last) {
  if (!last) return 'none';
  const age = serverNow - last.at;
  if (age >= STALE_BAD_MS) return 'bad';
  if (age >= STALE_WARN_MS) return 'warn';
  return 'ok';
}

function nearestPoint(ll) {
  let best = null;
  for (const p of state.points) {
    const d = distM(ll, p);
    if (!best || d < best.d) best = { p, d };
  }
  return best;
}

function groupIcon(label, cls) {
  return L.divIcon({
    className: '',
    html: `<div class="jl-grp ${cls}">K${label}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0]
  });
}

/** One line: what the group has done and what it is due for. */
function scheduleLine(g, status) {
  const parts = [];
  for (const p of state.points) {
    const r = status.reached.get(p.id);
    if (r) parts.push('✓ ' + pointName(p) + ' ' + clock(r.at));
  }
  // Check-ins can exist before anyone recorded the start; never hide them.
  if (!status.started) {
    parts.push('belum bertolak');
    return { text: parts.join(' · '), cls: '' };
  }
  if (status.done) {
    parts.push('selesai jadual');
    return { text: parts.join(' · '), cls: '' };
  }
  if (status.next && status.next.expectedAt !== null) {
    const late = status.lateMs > 0;
    parts.push(pointName(status.next.point) + ' dijangka ' + clock(status.next.expectedAt) +
      (late ? ' — LEWAT ' + minutes(status.lateMs) : ' — dalam ' + minutes(status.lateMs)));
    return { text: parts.join(' · '), cls: lateness(status) || '' };
  }
  return { text: parts.join(' · ') || 'Bertolak ' + clock(g.startedAt), cls: '' };
}

function renderPositions() {
  const seen = new Set();
  positions.forEach((g, i) => {
    if (!g.last) return;
    seen.add(g.id);
    const cls = (g.last.sos ? 'sos ' : '') + staleness(g.last);
    const icon = groupIcon(groupLabel(g, i), cls);
    const ll = [g.last.lat, g.last.lng];
    if (groupMarkers[g.id]) {
      groupMarkers[g.id].setLatLng(ll).setIcon(icon);
    } else {
      groupMarkers[g.id] = L.marker(ll, { icon, zIndexOffset: 500, alt: g.name })
        .on('click', () => selectGroup(g.id))
        .addTo(map);
    }
  });
  for (const id of Object.keys(groupMarkers)) {
    if (!seen.has(id)) {
      map.removeLayer(groupMarkers[id]);
      delete groupMarkers[id];
    }
  }

  // Trouble first: SOS, then badly late, then long silent, then a little late…
  const statuses = new Map(positions.map((g) => [g.id, scheduleFor(g, state.points, serverNow)]));
  const rank = (g) => {
    if (g.last && g.last.sos) return 0;
    const late = lateness(statuses.get(g.id));
    const stale = staleness(g.last);
    if (late === 'bad') return 1;
    if (stale === 'bad') return 2;
    if (late === 'warn') return 3;
    if (stale === 'warn') return 4;
    if (stale === 'ok') return 5;
    return 6;
  };
  const sorted = positions.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g));

  const wrap = $('poslist');
  wrap.textContent = '';
  if (!positions.length) wrap.append(el('div', 'empty', 'Tiada kumpulan lagi.'));

  sorted.forEach(({ g, i }) => {
    const st = staleness(g.last);
    const status = statuses.get(g.id);
    const late = lateness(status);
    const row = el('div', 'row pos ' + st + (late ? ' late-' + late : '') +
      (g.last && g.last.sos ? ' sos' : '') + (g.id === selectedGroup ? ' sel' : ''));
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.append(el('span', 'badge outline', groupLabel(g, i)));

    const text = el('span', 'grow');
    text.append(el('span', 'nm', (g.last && g.last.sos ? 'SOS — ' : '') + g.name), el('br'));
    if (g.last) {
      const bits = [ago(serverNow - g.last.at)];
      if (Number.isFinite(g.last.acc)) bits.push('± ' + Math.round(g.last.acc) + ' m');
      if (typeof g.last.battery === 'number') bits.push('bateri ' + Math.round(g.last.battery * 100) + '%');
      if (g.last.source === 'sms') bits.push('via SMS');
      text.append(el('span', 'co', bits.join(' · ')), el('br'));
    } else {
      text.append(el('span', 'co', 'Belum ada kedudukan'), el('br'));
    }
    const sched = scheduleLine(g, status);
    text.append(el('span', 'sched ' + sched.cls, sched.text));
    // The plan says when they should arrive; their own pace says when they will.
    const est = paceEstimate(g, state.points, state.routes, status, serverNow);
    if (est) text.append(el('br'), el('span', 'pace' + (est.moving ? '' : ' still'), paceLabel(est, pointName)));
    row.append(text);

    if (g.last) {
      const near = nearestPoint(g.last);
      const dist = el('span', 'dist', near ? fmtDist(near.d) : '—');
      dist.append(el('small', null, near ? 'dari ' + pointName(near.p) : ''));
      row.append(dist);
    }

    const acts = el('span', 'rowacts');
    const stop = (fn) => (event) => { event.stopPropagation(); fn(); };
    if (!status.started) {
      const start = el('button', 'jl-btn sm acc', 'Mula');
      start.type = 'button';
      start.addEventListener('click', stop(() => startGroup(g.id, true)));
      acts.append(start);
    } else {
      const reset = el('button', 'jl-btn sm', 'Set semula');
      reset.type = 'button';
      reset.title = 'Buang masa mula';
      reset.addEventListener('click', stop(() => startGroup(g.id, false)));
      acts.append(reset);
    }
    const arrive = el('button', 'jl-btn sm', 'Tiba');
    arrive.type = 'button';
    arrive.addEventListener('click', stop(() => checkInGroup(g.id)));
    acts.append(arrive);
    row.append(acts);

    const open = () => selectGroup(g.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    wrap.append(row);
  });

  renderAlert(statuses);
}

function selectGroup(id) {
  const g = positions.find((x) => x.id === id);
  if (!g || !g.last) return;
  selectedGroup = id;
  if (trailLine) map.removeLayer(trailLine);
  trailLine = null;
  if (g.trail.length > 1) {
    trailLine = L.polyline(g.trail.map((t) => [t[0], t[1]]), {
      color: '#201e1d', weight: 3, opacity: 0.8, dashArray: '2 6'
    }).addTo(map);
    map.fitBounds(trailLine.getBounds().pad(0.3), { maxZoom: 16 });
  } else {
    map.setView([g.last.lat, g.last.lng], Math.max(map.getZoom(), 15));
  }
  renderPositions();
}

/* ── alert bar: SOS and badly late groups ───────────────────────────── */

const alertBar = $('ccalert');
let audio = null;
let lastBeep = 0;

function beep() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.3, t + i * 0.25 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.25 + 0.18);
      osc.connect(gain).connect(audio.destination);
      osc.start(t + i * 0.25);
      osc.stop(t + i * 0.25 + 0.2);
    }
  } catch { /* no audio available */ }
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
}

function renderAlert(statuses) {
  const parts = [];
  for (const g of positions) {
    if (g.last && g.last.sos) {
      const near = nearestPoint(g.last);
      parts.push('SOS ' + g.name + ' · ' + ago(serverNow - g.last.at) +
        (near ? ' · ' + fmtDist(near.d) + ' dari ' + pointName(near.p) : ''));
    }
  }
  for (const g of positions) {
    const st = statuses.get(g.id);
    if (lateness(st) === 'bad') {
      parts.push('LEWAT ' + g.name + ' · ' + pointName(st.next.point) + ' dijangka ' + clock(st.next.expectedAt) +
        ' · ' + minutes(st.lateMs) + (g.last ? ' · dilihat ' + ago(serverNow - g.last.at) : ' · tiada kedudukan'));
    }
  }
  if (!parts.length) {
    alertBar.style.display = 'none';
    return;
  }
  alertBar.textContent = parts.join(' | ');
  alertBar.style.display = 'block';
  if (Date.now() - lastBeep > 60 * 1000) {
    beep();
    lastBeep = Date.now();
  }
}

alertBar.addEventListener('click', () => {
  const g = positions.find((x) => x.last && x.last.sos) ||
    positions.find((x) => lateness(scheduleFor(x, state.points, serverNow)) === 'bad' && x.last);
  if (g) selectGroup(g.id);
});

/* ── polling ────────────────────────────────────────────────────────── */

let polling = false;
async function pollPositions() {
  if (polling || !key) return;
  polling = true;
  try {
    const data = await getPositions(key, TRAIL_POINTS);
    serverNow = data.now;
    positions = data.groups;
    // Start times may have been set by a marshal; keep our copy current.
    let pinsChanged = false;
    for (const g of positions) {
      const mine = state.groups.find((x) => x.id === g.id);
      if (mine && mine.startedAt !== g.startedAt) mine.startedAt = g.startedAt;
      if (g.pin && pins[g.id] !== g.pin) { pins[g.id] = g.pin; pinsChanged = true; }
    }
    if (pinsChanged) renderGroups();
    $('posstat').textContent = 'Dikemas kini ' + clock(Date.now());
    renderPositions();
  } catch (err) {
    $('posstat').textContent = 'Kedudukan: ' + err.message;
    if (err.status === 401) {
      key = '';
      saveCCKey('');
      await ensureKey();
    }
  } finally {
    polling = false;
  }
}

core.hooks.fitExtra = () => positions.filter((g) => g.last).map((g) => [g.last.lat, g.last.lng]);

/* ── init ───────────────────────────────────────────────────────────── */

renderGroups();
setSync('warn', 'Menyambung…');
(async () => {
  const ok = await ensureKey();
  if (ok) setSync('ok', 'Bersambung');
  await pullState();
  await pollPositions();
  setInterval(pollPositions, POSITIONS_POLL_MS);
  setInterval(pullState, 60 * 1000);
  // Lateness is a function of the clock, so redraw even when nothing arrived.
  setInterval(() => { serverNow += 30 * 1000; renderPositions(); }, 30 * 1000);
})();
