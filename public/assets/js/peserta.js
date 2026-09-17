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

/** The newest checkpoint this phone can see — the one the group is walking to. */
const lastPoint = () => core.state.points[core.state.points.length - 1] || null;

async function syncState() {
  if (syncing) return false;
  syncing = true;
  try {
    // With the group's PIN the server reveals checkpoints as the group reaches them.
    const next = await getState(groupPin ? { groupPin } : {});
    const before = core.state.points.map((p) => p.id);
    const after = (next.points || []).map((p) => p.id);
    const versionChanged = next.version !== core.state.version;
    const pointsChanged = before.join(',') !== after.join(',');
    const progressChanged = JSON.stringify(next.progress || null) !== JSON.stringify(core.state.progress || null);
    if (versionChanged || pointsChanged || progressChanged) {
      const wasLast = lastPoint();
      core.applyState(next);
      const nowLast = lastPoint();
      if (nowLast && (!wasLast || wasLast.id !== nowLast.id) && after.length > before.length) {
        // A new checkpoint was revealed: aim the compass at it.
        core.setTarget(nowLast.id);
        toast('Checkpoint seterusnya didedahkan: ' + nowLast.name, 5000);
      } else if (versionChanged || pointsChanged) {
        toast('Peta dikemas kini oleh pusat kawalan.');
      }
    } else {
      core.state.groups = next.groups;
      saveState(core.state);
    }
    $('statestat').textContent = 'Peta dikemas kini ' + clock(Date.now());
    return true;
  } catch (err) {
    if (err.status === 401 && groupPin) {
      // The PIN was reset or the group deleted; the cached map may show more than allowed.
      logoutGroup();
      notify({ title: 'Masuk semula', body: 'PIN kumpulan ini tidak lagi sah. Minta PIN baharu dari pusat kawalan.' })
        .then(chooseGroup);
    }
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
    // Fetch the state as this group: its name, and the checkpoints revealed to it.
    await syncState();
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
  // Without a PIN the phone may only see MULA; drop the checkpoints it held.
  const start = core.state.points.find((p) => p.type === 'start');
  core.applyState({ version: core.state.version, points: start ? [start] : [], progress: null });
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
  onVersion: (version, result) => {
    // A new version, or the server now reveals more points than we hold.
    if (version !== core.state.version || (result && result.revealed > core.state.points.length)) syncState();
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

/* ── bottom tab bar: one pane at a time, so menu and content share a screen ── */

const TAB_KEY = 'jl_tab_v1';
const tabs = [...document.querySelectorAll('#tabbar [role="tab"]')];
const sheet = $('sheet');

function showPane(name) {
  // name === null closes the panel and gives the map the whole screen.
  for (const tab of tabs) {
    const on = tab.dataset.pane === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on || (name === null && tab === tabs[0]) ? 0 : -1;
    $('pane-' + tab.dataset.pane).hidden = !on;
  }
  sheet.classList.toggle('open', name !== null);
  try { localStorage.setItem(TAB_KEY, name || ''); } catch { /* storage unavailable */ }
  // The map's usable height changed with the panel.
  setTimeout(() => core.map.invalidateSize({ pan: false }), 210);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    const open = tab.getAttribute('aria-selected') === 'true';
    showPane(open ? null : tab.dataset.pane);
  });
  tab.addEventListener('keydown', (event) => {
    const i = tabs.indexOf(tab);
    let next = null;
    if (event.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    if (next) {
      event.preventDefault();
      next.focus();
      showPane(next.dataset.pane);
    }
  });
}

{
  let saved = 'kumpulan';
  try { saved = localStorage.getItem(TAB_KEY) ?? 'kumpulan'; } catch { /* storage unavailable */ }
  showPane(saved && tabs.some((t) => t.dataset.pane === saved) ? saved : (saved === '' ? null : 'kumpulan'));
}

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
