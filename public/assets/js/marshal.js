/* Marshal phone: stands at one checkpoint and records each group arriving.
   Proven by the marshal PIN the command centre set. Check-ins queue on the
   phone when there is no signal and go out when it returns — a marshal in a
   dead zone can still record, and the record carries the real arrival time.

   Recording a group at MULA is what starts that group's clock. */

import { getState, postCheckins } from './api.js';
import { loadState, saveState, loadMarshal, saveMarshal, loadCheckinQueue, saveCheckinQueue, deviceId } from './store.js';
import { askText, askChoice, askConfirm, notify, toast } from './ui.js';

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

const pointById = (id) => state.points.find((p) => p.id === id);
const pointName = (p) => (p.type === 'start' ? 'MULA (bertolak)' : p.name);

/* ── program state ──────────────────────────────────────────────────── */

async function syncState() {
  try {
    const next = await getState();
    state.version = next.version;
    state.points = next.points;
    state.groups = next.groups;
    state.settings = next.settings || {};
    saveState(state);
    return true;
  } catch {
    return false;
  }
}

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

window.addEventListener('online', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { syncState().then(render); flush(); } });
setInterval(flush, 60 * 1000);
setInterval(() => syncState().then(render), 5 * 60 * 1000);

/* ── render ─────────────────────────────────────────────────────────── */

function render() {
  const p = pointById(point);
  $('pointname').textContent = p ? pointName(p) : 'Belum dipilih';
  $('btnPoint').textContent = p ? 'Tukar' : 'Pilih checkpoint';

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
  state.groups.forEach((g, i) => {
    const at = here.get(g.id);
    const row = el('div', 'row grp' + (at ? ' done' : ''));
    const m = /\d+/.exec(g.name || '');
    row.append(el('span', 'badge outline', m ? m[0] : String(i + 1)));
    const text = el('span', 'grow');
    text.append(el('span', 'nm', g.name), el('br'),
      el('span', 'co', at ? 'Tiba ' + clock(at) : 'Belum tiba'));
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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {});
  });
}

/* ── init ───────────────────────────────────────────────────────────── */

render();
(async () => {
  await syncState();
  await ensurePin();
  render();
  if (!point) await choosePoint();
  flush();
})();
