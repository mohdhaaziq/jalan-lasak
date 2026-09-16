/* Participant phone: one device per group. Read-only map, position reporting,
   SOS, keep-screen-on. State (points, routes, groups) comes from the server
   and is cached on the phone so the map still opens without signal. */

import { boot, $, groupLabel } from './core.js';
import { getState } from './api.js';
import { loadGroup, saveGroup, deviceId, saveState } from './store.js';
import { askChoice, askConfirm, notify, toast } from './ui.js';
import { createReporter } from './reporter.js';

const STATE_POLL_MS = 5 * 60 * 1000;

const core = boot({ editable: false });
const device = deviceId();
let group = loadGroup();
let syncing = false;

const groupName = (id) => {
  const g = core.state.groups.find((x) => x.id === id);
  return g ? g.name : '';
};

const clock = (ms) => new Date(ms).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit' });

/* ── program state from the server ──────────────────────────────────── */

async function syncState() {
  if (syncing) return false;
  syncing = true;
  try {
    const next = await getState();
    if (next.version !== core.state.version) {
      core.applyState(next);
      toast('Peta dikemas kini oleh pusat kawalan.');
    } else {
      core.state.groups = next.groups;
      saveState(core.state);
    }
    $('statestat').textContent = 'Peta dikemas kini ' + clock(Date.now());
    return true;
  } catch {
    $('statestat').textContent = 'Guna salinan dalam peranti';
    return false;
  } finally {
    syncing = false;
    renderGroup();
  }
}

/* ── group identity ─────────────────────────────────────────────────── */

async function chooseGroup() {
  const groups = core.state.groups;
  if (!groups.length) {
    await notify({
      title: 'Tiada kumpulan lagi',
      body: 'Pusat kawalan belum menetapkan senarai kumpulan. Buka semula sebentar lagi.'
    });
    return;
  }
  const id = await askChoice({
    title: 'Kumpulan anda',
    body: 'Pilih kumpulan yang telefon ini wakili. Kedudukan telefon ini akan dihantar ke pusat kawalan.',
    options: groups.map((g) => ({ value: g.id, label: g.name, selected: g.id === group })),
    cancelLabel: group ? 'Batal' : null
  });
  if (!id) return;
  group = id;
  saveGroup(id);
  renderGroup();
  reporter.start();
  toast('Telefon ini kini ' + groupName(id) + '.');
}

function renderGroup() {
  const mine = core.state.groups.find((g) => g.id === group) || null;
  const known = !!mine;
  $('grpname').textContent = known ? mine.name : (group ? 'Kumpulan dipadam — pilih semula' : 'Belum dipilih');
  $('btnGroup').textContent = group ? 'Tukar kumpulan' : 'Pilih kumpulan';
  $('btnSend').disabled = !known;
  $('btnSOS').disabled = !known;
  const smsNumber = (core.state.settings || {}).smsNumber;
  $('btnSms').disabled = !known || !smsNumber;
  $('btnSms').title = smsNumber ? 'SMS ke ' + smsNumber : 'Pusat kawalan belum tetapkan nombor SMS';
  // ETAs in the checkpoint list become clock times once this group has set off.
  core.setScheduleStart(mine ? mine.startedAt : null);
}

/* ── SMS fallback: works on far weaker signal than data ─────────────── */

$('btnSms').addEventListener('click', async () => {
  const smsNumber = (core.state.settings || {}).smsNumber;
  const mine = core.state.groups.find((g) => g.id === group);
  if (!smsNumber || !mine) return;
  let fix = reporter.lastFix();
  if (!fix) {
    toast('Mencari GPS…');
    fix = await reporter.sendNow();
    if (!fix) {
      notify({ title: 'GPS belum dapat', body: 'Cuba di kawasan terbuka, kemudian tekan sekali lagi.' });
      return;
    }
  }
  const index = core.state.groups.indexOf(mine);
  const body = 'JL K' + groupLabel(mine, index) + ' ' + fix.lat.toFixed(5) + ',' + fix.lng.toFixed(5) +
    ' ' + clock(fix.at) + (reporter.isSOS() ? ' SOS' : '');
  // iOS wants "&body=", Android "?body=".
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  window.location.href = 'sms:' + smsNumber + (ios ? '&' : '?') + 'body=' + encodeURIComponent(body);
});

/* ── reporter ───────────────────────────────────────────────────────── */

const reporter = createReporter({
  getGroup: () => group,
  getDevice: () => device,
  onFix: (fix) => core.setMyPos(fix, fix.acc),
  onStatus: (s) => {
    const bits = [];
    if (s.lastDeliveredAt) bits.push('Dihantar ' + clock(s.lastDeliveredAt));
    else bits.push('Belum dihantar');
    if (s.queued) bits.push(s.queued + ' dlm giliran');
    if (s.error) bits.push(s.error);
    $('repstat').textContent = bits.join(' · ');
    $('repstat').classList.toggle('bad', !!s.error);
    syncSOS(s.sos);
  },
  onGroupMissing: async () => {
    group = '';
    saveGroup('');
    // The list we hold still names the deleted group; fetch the current one
    // before asking, so the operator's change is what the leader sees.
    await syncState();
    renderGroup();
    chooseGroup();
  },
  onVersion: (version) => {
    if (version !== core.state.version) syncState();
  }
});

$('btnSend').addEventListener('click', async () => {
  toast('Menghantar kedudukan…');
  const fix = await reporter.sendNow();
  if (!fix) toast('GPS belum dapat — cuba di kawasan terbuka.');
});

$('btnGroup').addEventListener('click', chooseGroup);

/* ── SOS ────────────────────────────────────────────────────────────── */

const btnSOS = $('btnSOS');
const sosBanner = $('sosbanner');

function syncSOS(on) {
  btnSOS.classList.toggle('on', on);
  btnSOS.setAttribute('aria-pressed', String(on));
  sosBanner.style.display = on ? 'block' : 'none';
}

btnSOS.addEventListener('click', async () => {
  if (reporter.isSOS()) {
    const ok = await askConfirm({ title: 'Batalkan SOS?', body: 'Pusat kawalan akan dimaklumkan yang keadaan sudah selamat.', okLabel: 'Batalkan SOS' });
    if (ok) reporter.setSOS(false);
    return;
  }
  const ok = await askConfirm({
    title: 'Hantar SOS?',
    body: 'Lokasi telefon ini akan dihantar serta-merta dan ditanda SOS di pusat kawalan. Gunakan bila ada kecemasan sebenar.',
    okLabel: 'Hantar SOS'
  });
  if (!ok) return;
  reporter.setSOS(true);
  toast('SOS dihantar. Kekalkan app terbuka.', 6000);
});

/* ── keep the screen on ─────────────────────────────────────────────── */

const btnWake = $('btnWake');
let wakeLock = null;
let wantWake = false;

async function acquireWake() {
  if (!('wakeLock' in navigator)) {
    notify({ title: 'Tidak disokong', body: 'Pelayar ini tidak boleh kekalkan skrin hidup. Tetapkan sendiri dalam tetapan telefon.' });
    return false;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; syncWake(); });
    return true;
  } catch {
    return false;
  }
}

function syncWake() {
  const on = !!wakeLock;
  btnWake.classList.toggle('on', on);
  btnWake.setAttribute('aria-pressed', String(on));
  btnWake.textContent = on ? 'Skrin kekal hidup' : 'Kekalkan skrin hidup';
}

btnWake.addEventListener('click', async () => {
  if (wakeLock) {
    wantWake = false;
    await wakeLock.release();
    wakeLock = null;
  } else {
    wantWake = await acquireWake();
  }
  syncWake();
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wantWake && !wakeLock) {
    await acquireWake();
    syncWake();
  }
});
syncWake();

/* ── init ───────────────────────────────────────────────────────────── */

renderGroup();
syncState().then(() => {
  const known = group && core.state.groups.some((g) => g.id === group);
  if (known) reporter.start();
  else chooseGroup();
});
setInterval(syncState, STATE_POLL_MS);
window.addEventListener('online', syncState);
