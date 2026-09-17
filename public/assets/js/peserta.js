/* Participant phone: one device per group. Read-only map, position reporting,
   SOS, keep-screen-on. State (points, routes, groups) comes from the server
   and is cached on the phone so the map still opens without signal. */

import { boot, $, groupLabel } from './core.js';
import { getState, loginGroup } from './api.js';
import { loadGroup, saveGroup, loadGroupPin, saveGroupPin, deviceId, saveState } from './store.js';
import { askText, askConfirm, notify, toast } from './ui.js';
import { createReporter } from './reporter.js';

const STATE_POLL_MS = 5 * 60 * 1000;

const core = boot({ editable: false });
const device = deviceId();
let group = loadGroup();
let groupPin = loadGroupPin();
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

/**
 * Log in with the group's PIN (6 digits, given by the command centre to
 * each group leader). The phone keeps the PIN so it stays logged in, and
 * sends it with every position so no other phone can report as this group.
 */
async function chooseGroup() {
  for (;;) {
    const entered = await askText({
      title: 'Masuk kumpulan',
      body: 'Masukkan PIN 6 digit kumpulan anda yang diberi oleh pusat kawalan. Kedudukan telefon ini akan dihantar sebagai kumpulan itu.',
      placeholder: '123456',
      label: 'PIN kumpulan',
      inputMode: 'numeric',
      okLabel: 'Masuk',
      cancelLabel: group ? 'Batal' : 'Nanti'
    });
    if (entered === null) return;
    const pin = entered.replace(/\D/g, '');
    if (pin.length !== 6) {
      await notify({ title: 'PIN tidak lengkap', body: 'PIN kumpulan ialah 6 digit.' });
      continue;
    }
    toast('Menyemak PIN…');
    let found;
    try {
      found = await loginGroup(pin);
    } catch (err) {
      await notify({
        title: err.status === 401 ? 'PIN salah' : 'Tidak dapat masuk',
        body: err.status === 401 ? 'Semak semula PIN dengan pusat kawalan.' : err.message + ' Perlukan talian untuk masuk kali pertama.'
      });
      if (err.status === 401) continue;
      return;
    }
    if (group && group !== found.id) reporter.stop();
    group = found.id;
    groupPin = pin;
    saveGroup(group);
    saveGroupPin(pin);
    // The list on this phone may predate the group; make sure it is named.
    if (!core.state.groups.some((g) => g.id === group)) await syncState();
    renderGroup();
    reporter.start();
    toast('Telefon ini kini ' + (groupName(group) || found.name) + '.');
    return;
  }
}

function logoutGroup() {
  reporter.stop();
  group = '';
  groupPin = '';
  saveGroup('');
  saveGroupPin('');
  renderGroup();
}

function renderGroup() {
  const mine = core.state.groups.find((g) => g.id === group) || null;
  const known = !!mine && !!groupPin;
  $('grpname').textContent = known ? mine.name : (group ? 'Masuk semula dengan PIN' : 'Belum masuk');
  $('btnGroup').textContent = known ? 'Tukar kumpulan' : 'Masuk dengan PIN';
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
  getPin: () => groupPin,
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
    // Deleted, or its PIN was reset, at the command centre.
    logoutGroup();
    await syncState();
    notify({ title: 'Masuk semula', body: 'Kumpulan ini dipadam atau PIN-nya ditukar oleh pusat kawalan. Minta PIN baharu dan masuk semula.' })
      .then(chooseGroup);
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
  const known = group && groupPin && core.state.groups.some((g) => g.id === group);
  if (known) reporter.start();
  else chooseGroup();
});
setInterval(syncState, STATE_POLL_MS);
window.addEventListener('online', syncState);
