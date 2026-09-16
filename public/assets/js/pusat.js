/* Command centre: edits points and routes, manages groups, watches every
   group's position. Proven to the server by the CC_KEY, entered once and
   kept on this device. */

import { boot, $, el, isStart } from './core.js';
import { mountEditing } from './edit.js';
import { getState, putState, putGroups, getPositions } from './api.js';
import { loadCCKey, saveCCKey, saveState } from './store.js';
import { askText, askConfirm, notify, toast } from './ui.js';
import { distM, fmtDist } from './geo.js';

const POSITIONS_POLL_MS = 15 * 1000;
const TRAIL_POINTS = 60;
const STALE_WARN_MS = 10 * 60 * 1000;
const STALE_BAD_MS = 20 * 60 * 1000;

const core = boot({ editable: true });
mountEditing(core);
const { L, map, state } = core;

let key = loadCCKey();
let positions = [];          // [{ id, name, last, trail }]
let serverNow = Date.now();
let selectedGroup = null;
const groupMarkers = {};
let trailLine = null;

const clock = (ms) => new Date(ms).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit' });
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'baru sahaja' : m + ' min lalu';
};

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
    const { version } = await putState(key, { points: state.points, routes: state.routes });
    state.version = version;
    saveState(state);
    dirty = false;
    setSync('ok', 'Disimpan ' + clock(Date.now()));
  } catch (err) {
    if (err.status === 401) {
      key = '';
      saveCCKey('');
      pushing = false;
      if (await ensureKey()) return push();
      return;
    }
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
    const next = await getState();
    if (dirty) return;                  // never overwrite edits still in flight
    if (next.version !== state.version) core.applyState(next);
    else {
      state.groups = next.groups;
      saveState(state);
    }
    renderGroups();
  } catch { /* keep the cached copy */ }
}

/* ── groups ─────────────────────────────────────────────────────────── */

async function saveGroups() {
  try {
    const { version } = await putGroups(key, state.groups);
    state.version = version;
    saveState(state);
    setSync('ok', 'Disimpan ' + clock(Date.now()));
  } catch (err) {
    setSync('bad', 'Kumpulan belum disimpan — ' + err.message);
  }
  renderGroups();
  pollPositions();
}

$('btnAddGroup').addEventListener('click', async () => {
  const suggested = 'Kumpulan ' + (state.groups.length + 1);
  const name = await askText({ title: 'Kumpulan baharu', value: suggested, label: 'Nama kumpulan', okLabel: 'Tambah' });
  if (name === null) return;
  state.groups.push({ id: 'k_' + Date.now().toString(36), name: name || suggested });
  await saveGroups();
});

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
    body: g.name + ' — telefon kumpulan ini akan diminta pilih semula, dan kedudukannya tidak lagi dipaparkan.',
    okLabel: 'Padam'
  });
  if (!ok) return;
  state.groups = state.groups.filter((x) => x.id !== id);
  await saveGroups();
}

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
    text.append(el('span', 'nm', g.name));
    row.append(text);
    const rename = el('button', 'jl-btn sm', 'Nama');
    rename.type = 'button';
    rename.addEventListener('click', () => renameGroup(g.id));
    const del = el('button', 'jl-btn sm del', 'Padam');
    del.type = 'button';
    del.addEventListener('click', () => deleteGroup(g.id));
    row.append(rename, del);
    wrap.append(row);
  });
}

/** Short label for a marker: the number in the name if it has one, else initials. */
function groupLabel(g, index) {
  const m = /\d+/.exec(g.name || '');
  if (m) return m[0];
  const words = (g.name || '').trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return initials || String(index + 1);
}

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
    html: `<div class="jl-grp ${cls}">${label}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
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

  // List: SOS first, then the quietest groups, so trouble sits at the top.
  const order = { sos: 0, bad: 1, warn: 2, ok: 3, none: 4 };
  const rank = (g) => (g.last && g.last.sos) ? 0 : order[staleness(g.last)];
  const sorted = positions.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g));

  const wrap = $('poslist');
  wrap.textContent = '';
  if (!positions.length) wrap.append(el('div', 'empty', 'Tiada kumpulan lagi.'));

  sorted.forEach(({ g, i }) => {
    const st = staleness(g.last);
    const row = el('div', 'row pos ' + st + (g.last && g.last.sos ? ' sos' : '') + (g.id === selectedGroup ? ' sel' : ''));
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.append(el('span', 'badge outline', groupLabel(g, i)));

    const text = el('span');
    text.append(el('span', 'nm', (g.last && g.last.sos ? 'SOS — ' : '') + g.name), el('br'));
    if (g.last) {
      const bits = [ago(serverNow - g.last.at)];
      if (Number.isFinite(g.last.acc)) bits.push('± ' + Math.round(g.last.acc) + ' m');
      if (typeof g.last.battery === 'number') bits.push('bateri ' + Math.round(g.last.battery * 100) + '%');
      text.append(el('span', 'co', bits.join(' · ')));
    } else {
      text.append(el('span', 'co', 'Belum ada kedudukan'));
    }
    row.append(text);

    if (g.last) {
      const near = nearestPoint(g.last);
      const dist = el('span', 'dist', near ? fmtDist(near.d) : '—');
      dist.append(el('small', null, near ? 'dari ' + (isStart(near.p) ? 'MULA' : near.p.name) : ''));
      row.append(dist);
    }

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

  renderAlert();
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

/* ── SOS alert ──────────────────────────────────────────────────────── */

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

function renderAlert() {
  const sos = positions.filter((g) => g.last && g.last.sos);
  if (!sos.length) {
    alertBar.style.display = 'none';
    return;
  }
  const parts = sos.map((g) => {
    const near = nearestPoint(g.last);
    return g.name + ' · ' + ago(serverNow - g.last.at) + (near ? ' · ' + fmtDist(near.d) + ' dari ' + (isStart(near.p) ? 'MULA' : near.p.name) : '');
  });
  alertBar.textContent = 'SOS — ' + parts.join(' | ');
  alertBar.style.display = 'block';
  if (Date.now() - lastBeep > 60 * 1000) {
    beep();
    lastBeep = Date.now();
  }
}

alertBar.addEventListener('click', () => {
  const g = positions.find((x) => x.last && x.last.sos);
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
})();
