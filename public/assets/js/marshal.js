/* Marshal phone: stands at one checkpoint and records each group arriving.
   Proven by the marshal PIN the command centre set. Check-ins queue on the
   phone when there is no signal and go out when it returns — a marshal in a
   dead zone can still record, and the record carries the real arrival time.

   Recording a group at MULA is what starts that group's clock. */

import { getState, postCheckins, getPositions } from './api.js';
import { loadState, saveState, loadMarshal, saveMarshal, loadCheckinQueue, saveCheckinQueue, deviceId } from './store.js';
import { askText, askChoice, askConfirm, notify, toast } from './ui.js';
import { LAYERS, isStart, groupLabel } from './core.js';
import { distM, fmtDist } from './geo.js';
import { scheduleFor, paceEstimate, paceLabel } from './schedule.js';
import { watchViewport } from './tabs.js';

const POSITIONS_POLL_MS = 30 * 1000;
const STALE_WARN_MS = 10 * 60 * 1000;
const STALE_BAD_MS = 20 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const clock = (ms) => new Date(ms).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit' });

const state = loadState();
const device = deviceId();
let { pin, point } = loadMarshal();
let queue = loadCheckinQueue();
let sent = [];   // delivered this session, kept so ticks stay visible
let flushing = false;
let lastDelivered = null;
let lastError = '';
let positions = [];        // [{ id, name, startedAt, last, checkins }] from the server
let serverNow = Date.now();

const pointById = (id) => state.points.find((p) => p.id === id);
const pointName = (p) => (p.type === 'start' ? 'MULA (bertolak)' : p.name);
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'baru sahaja' : m + ' min lalu';
};

/* ── program state ──────────────────────────────────────────────────── */

async function syncState() {
  try {
    const next = await getState(pin ? { pin } : {});
    state.version = next.version;
    state.points = next.points;
    state.routes = next.routes || [];
    state.groups = next.groups;
    state.settings = next.settings || {};
    saveState(state);
    drawProgram();
    return true;
  } catch {
    return false;
  }
}

/* ── map: the program, and where every group is right now ───────────── */

const L = window.L;
const map = L.map('mmap', { zoomControl: false, attributionControl: true });
map.attributionControl.setPrefix(false);
L.tileLayer(LAYERS.osm.template, { maxZoom: LAYERS.osm.maxZoom, attribution: LAYERS.osm.attribution }).addTo(map);
map.setView([3.556879, 101.632263], 12);   // MULA, until the program has loaded
// Fill the whole screen (iOS home-screen quirk included) and keep the map drawn to its box.
watchViewport(() => setTimeout(() => map.invalidateSize({ pan: false }), 60));

const pointLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const groupMarkers = {};
let fitted = false;

function pointIcon(p, i) {
  const mine = p.id === point;
  const label = isStart(p) ? 'M' : String(i);
  return L.divIcon({
    className: '',
    html: `<div class="jl-marker${isStart(p) ? ' start' : ''}${mine ? ' mine' : ''}">${label}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function drawProgram() {
  pointLayer.clearLayers();
  routeLayer.clearLayers();
  let n = 0;
  for (const p of state.points) {
    if (!isStart(p)) n += 1;
    L.marker([p.lat, p.lng], { icon: pointIcon(p, n), zIndexOffset: p.id === point ? 400 : 100, alt: p.name })
      .bindPopup(`<div class="pop-name">${pointName(p)}</div>`)
      .addTo(pointLayer);
  }
  for (const r of state.routes || []) {
    L.polyline(r.latlngs, { color: '#ec3013', weight: 4, dashArray: '8 6', opacity: 0.9 }).addTo(routeLayer);
  }
  if (!fitted && state.points.length) fitAll();
}

function staleness(last) {
  if (!last) return 'none';
  const age = serverNow - last.at;
  if (age >= STALE_BAD_MS) return 'bad';
  if (age >= STALE_WARN_MS) return 'warn';
  return 'ok';
}

function drawGroups() {
  const seen = new Set();
  positions.forEach((g, i) => {
    if (!g.last) return;
    seen.add(g.id);
    const cls = (g.last.sos ? 'sos ' : '') + staleness(g.last);
    const icon = L.divIcon({
      className: '',
      html: `<div class="jl-grp ${cls}">${groupLabel(g, i)}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    const ll = [g.last.lat, g.last.lng];
    const here = pointById(point);
    const popup = `<div class="pop-name">${g.last.sos ? 'SOS — ' : ''}${g.name}</div>` +
      `<div class="pop-co">${ago(serverNow - g.last.at)}` +
      (here ? ' · ' + fmtDist(distM(g.last, here)) + ' dari sini' : '') +
      (g.last.source === 'sms' ? ' · via SMS' : '') + '</div>';
    if (groupMarkers[g.id]) {
      groupMarkers[g.id].setLatLng(ll).setIcon(icon).setPopupContent(popup);
    } else {
      groupMarkers[g.id] = L.marker(ll, { icon, zIndexOffset: 500, alt: g.name }).bindPopup(popup).addTo(map);
    }
  });
  for (const id of Object.keys(groupMarkers)) {
    if (!seen.has(id)) {
      map.removeLayer(groupMarkers[id]);
      delete groupMarkers[id];
    }
  }
}

function fitAll() {
  const pts = state.points.map((p) => [p.lat, p.lng])
    .concat(positions.filter((g) => g.last).map((g) => [g.last.lat, g.last.lng]));
  if (!pts.length) return;
  fitted = true;
  map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15 });
}

$('btnMFit').addEventListener('click', fitAll);

let polling = false;
async function pollPositions() {
  if (polling || !pin || !navigator.onLine) return;
  polling = true;
  try {
    const data = await getPositions(null, 30, { pin });   // a short trail, for the pace estimate
    serverNow = data.now;
    const first = !positions.length && data.groups.some((g) => g.last);
    positions = data.groups;
    if (first) fitted = false;   // the first fixes widen the picture; frame them once
    const sos = positions.filter((g) => g.last && g.last.sos);
    $('mposstat').textContent = (sos.length ? 'SOS ' + sos.map((g) => g.name).join(', ') + ' · ' : '') +
      'Kedudukan ' + clock(Date.now());
    $('mposstat').classList.toggle('bad', sos.length > 0);
    drawGroups();
    if (!fitted) fitAll();
    render();
  } catch (err) {
    $('mposstat').textContent = 'Kedudukan: ' + err.message;
  } finally {
    polling = false;
  }
}
setInterval(pollPositions, POSITIONS_POLL_MS);
// Silence is measured against the server clock; keep it moving between polls.
setInterval(() => { serverNow += 30 * 1000; drawGroups(); }, 30 * 1000);

/* ── PIN + point ────────────────────────────────────────────────────── */

async function ensurePin() {
  for (;;) {
    if (!pin) {
      const entered = await askText({
        title: 'Marshal',
        body: 'Masukkan PIN marshal yang diberi pusat kawalan.',
        label: 'PIN',
        type: 'password',
        okLabel: 'Masuk',
        cancelLabel: 'Batal'
      });
      if (!entered) {
        await notify({ title: 'PIN diperlukan', body: 'Paparan marshal tidak boleh dibuka tanpa PIN.' });
        continue;
      }
      pin = entered;
    }
    try {
      await postCheckins({ pin, device, items: [], verify: true });
      saveMarshal({ pin });
      return true;
    } catch (err) {
      if (err.status === 401) {
        pin = '';
        saveMarshal({ pin: '' });
        await notify({ title: 'PIN salah', body: 'Cuba lagi.' });
        continue;
      }
      // No signal or PIN not set yet: keep the PIN and work from the cache.
      lastError = err.message;
      return false;
    }
  }
}

async function choosePoint() {
  if (!state.points.length) {
    await notify({ title: 'Tiada titik', body: 'Peta program belum dimuat turun. Cuba bila ada isyarat.' });
    return;
  }
  const id = await askChoice({
    title: 'Anda di checkpoint mana?',
    body: 'Setiap kumpulan yang tiba di sini akan dicatat di titik ini.',
    options: state.points.map((p) => ({ value: p.id, label: pointName(p), selected: p.id === point })),
    cancelLabel: point ? 'Batal' : null
  });
  if (!id) return;
  point = id;
  saveMarshal({ point });
  drawProgram();
  drawGroups();
  render();
}

$('btnPoint').addEventListener('click', choosePoint);

/* ── check-ins ──────────────────────────────────────────────────────── */

/** Which groups this phone has recorded at the current point, latest first. */
function recordedHere() {
  const map = new Map();
  for (const c of queue.concat(sent)) {
    if (c.point === point && (!map.has(c.group) || c.at > map.get(c.group))) map.set(c.group, c.at);
  }
  return map;
}

async function record(groupId) {
  const g = state.groups.find((x) => x.id === groupId);
  const p = pointById(point);
  if (!g || !p) return;
  const already = recordedHere().get(groupId);
  if (already) {
    const ok = await askConfirm({
      title: 'Catat sekali lagi?',
      body: g.name + ' sudah dicatat di sini pada ' + clock(already) + '.',
      okLabel: 'Catat lagi'
    });
    if (!ok) return;
  }
  queue.push({ group: groupId, point, at: Date.now() });
  saveCheckinQueue(queue);
  render();
  toast(g.name + ' — ' + pointName(p) + ' ' + clock(Date.now()));
  flush();
}

async function flush() {
  if (flushing || !queue.length || !pin) return;
  if (!navigator.onLine) {
    lastError = 'Tiada talian — ' + queue.length + ' dlm giliran';
    render();
    return;
  }
  flushing = true;
  try {
    const items = queue.slice(0, 200);
    await postCheckins({ pin, device, items });
    sent = sent.concat(items);
    queue = queue.slice(items.length);
    saveCheckinQueue(queue);
    lastDelivered = Date.now();
    lastError = '';
  } catch (err) {
    if (err.status === 401) {
      pin = '';
      saveMarshal({ pin: '' });
      lastError = err.message;
      flushing = false;
      render();
      if (await ensurePin()) return flush();
      return;
    }
    lastError = err.message;
  } finally {
    flushing = false;
    render();
  }
}

window.addEventListener('online', () => { flush(); pollPositions(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { syncState().then(render); flush(); pollPositions(); }
});
setInterval(flush, 60 * 1000);
setInterval(() => syncState().then(render), 5 * 60 * 1000);

/* ── render ─────────────────────────────────────────────────────────── */

/** This checkpoint's code, big, and as a QR of the participant URL. */
function renderCode(p) {
  const box = $('mcode');
  if (!p || !p.code) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('mcodetext').textContent = p.code;
  const qr = $('mqr');
  qr.textContent = '';
  if (typeof window.qrcode !== 'function') return;
  try {
    const q = window.qrcode(0, 'M');
    q.addData(new URL('./?kod=' + p.code, location.href).href);
    q.make();
    qr.innerHTML = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch { /* leave the code as text */ }
}

function render() {
  const p = pointById(point);
  $('pointname').textContent = p ? pointName(p) : 'Belum dipilih';
  $('btnPoint').textContent = p ? 'Tukar' : 'Pilih checkpoint';
  renderCode(p);

  const bits = [];
  bits.push(lastDelivered ? 'Dihantar ' + clock(lastDelivered) : 'Belum ada dihantar');
  if (queue.length) bits.push(queue.length + ' dlm giliran');
  if (lastError) bits.push(lastError);
  $('mstat').textContent = bits.join(' · ');
  $('mstat').classList.toggle('bad', !!lastError);

  const wrap = $('mlist');
  wrap.textContent = '';
  if (!p) {
    wrap.append(el('div', 'empty', 'Pilih checkpoint anda dahulu.'));
    return;
  }
  if (!state.groups.length) {
    wrap.append(el('div', 'empty', 'Pusat kawalan belum menetapkan kumpulan.'));
    return;
  }
  const here = recordedHere();
  const seen = new Map(positions.map((g) => [g.id, g.last]));
  state.groups.forEach((g, i) => {
    const at = here.get(g.id);
    const last = seen.get(g.id);
    const row = el('div', 'row grp' + (at ? ' done' : '') + (last && last.sos ? ' sos' : ''));
    row.append(el('span', 'badge outline', groupLabel(g, i)));
    const text = el('span', 'grow');
    const where = last
      ? fmtDist(distM(last, p)) + ' dari sini · ' + ago(serverNow - last.at) + (last.sos ? ' · SOS' : '')
      : 'Belum ada kedudukan';
    text.append(el('span', 'nm', (last && last.sos ? 'SOS — ' : '') + g.name), el('br'),
      el('span', 'co', (at ? 'Tiba ' + clock(at) : 'Belum tiba') + ' · ' + where));
    // How long until they get here, at the pace they are actually walking.
    const pg = positions.find((x) => x.id === g.id);
    if (pg && pg.last && !at) {
      const est = paceEstimate(pg, state.points, state.routes || [], scheduleFor(pg, state.points, serverNow), serverNow, p);
      if (est) text.append(el('br'), el('span', 'pace' + (est.moving ? '' : ' still'), paceLabel(est, () => 'sini')));
    }
    row.append(text);
    const button = el('button', 'jl-btn' + (at ? ' sm' : ' acc big'), at ? 'Lagi' : 'Tiba');
    button.type = 'button';
    button.addEventListener('click', () => record(g.id));
    row.append(button);
    wrap.append(row);
  });
}

function netUI() {
  const off = !navigator.onLine;
  $('netdot').classList.toggle('off', off);
  $('netlabel').textContent = off ? 'Offline' : 'Online';
}
window.addEventListener('online', netUI);
window.addEventListener('offline', netUI);
netUI();

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    toast('Versi baharu dipasang — memuat semula…', 2000);
    setTimeout(() => window.location.reload(), 600);
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((r) => {
      r.update();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') r.update().catch(() => {}); });
    }).catch(() => {});
  });
}

/* ── init ───────────────────────────────────────────────────────────── */

render();
drawProgram();
(async () => {
  await ensurePin();
  await syncState();     // with the PIN: every checkpoint, not just MULA
  render();
  if (!point) await choosePoint();
  flush();
  pollPositions();
})();
