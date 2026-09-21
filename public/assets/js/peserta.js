/* Participant phone: one device per group. Read-only map, position reporting,
   SOS, keep-screen-on. State (points, routes, groups) comes from the server
   and is cached on the phone so the map still opens without signal. */

import { boot, $, groupLabel } from './core.js';
import { getState, loginGroup, postCheckins } from './api.js';
import { loadGroup, saveGroup, loadGroupPin, saveGroupPin, deviceId, saveState,
  loadUnlocked, saveUnlocked, loadCodeQueue, saveCodeQueue } from './store.js';
import { askText, askConfirm, notify, toast } from './ui.js';
import { createReporter } from './reporter.js';
import { unlockPoint, normCode, codeFromText, CODE_LEN } from './lock.js';
import { mountTabs } from './tabs.js';

const STATE_POLL_MS = 5 * 60 * 1000;

const core = boot({ editable: false });
const device = deviceId();
let group = loadGroup();
let groupPin = loadGroupPin();
let syncing = false;
let unlocked = loadUnlocked();     // points opened offline with checkpoint codes
let codeQueue = loadCodeQueue();   // those unlocks, waiting to be reported as check-ins

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
    mergeUnlocked(next);
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
    flushCodes();
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

/* ── checkpoint codes: opening the next point with no signal ────────── */

/**
 * Fold what this phone unlocked offline into a server state: points the
 * server has not (yet) revealed, points it counts as reached, and whether
 * anything is still locked. The server's view wins once it catches up.
 */
function mergeUnlocked(next) {
  const byId = new Map((next.points || []).map((p) => [p.id, p]));
  for (const p of Object.values(unlocked.points)) if (!byId.has(p.id)) byId.set(p.id, p);
  next.points = [...byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const remaining = (next.locked || []).filter((l) => !byId.has(l.id));
  if (next.progress || unlocked.reached.length) {
    const reached = new Set([...((next.progress && next.progress.reached) || []), ...unlocked.reached]);
    next.progress = { reached: [...reached], more: remaining.length > 0 || !!(next.progress && next.progress.more && !next.locked) };
  }
  return next;
}

/** Try `raw` against every locked point; open the one it fits. */
async function enterCode(raw) {
  const code = normCode(raw);
  if (code.length !== CODE_LEN) {
    await notify({ title: 'Kod tidak lengkap', body: 'Kod checkpoint ialah ' + CODE_LEN + ' aksara, huruf dan nombor.' });
    return false;
  }
  const known = new Set(core.state.points.map((p) => p.id));
  const locked = (core.state.locked || []).filter((l) => !known.has(l.id)).sort((a, b) => a.seq - b.seq);
  if (!locked.length) {
    await notify({
      title: 'Tiada checkpoint terkunci',
      body: core.state.locked && core.state.locked.length
        ? 'Semua checkpoint sudah dibuka.'
        : 'Peta belum dimuat turun sepenuhnya. Buka app semasa ada isyarat selepas masuk dengan PIN.'
    });
    return false;
  }
  toast('Membuka kunci…');
  for (const l of locked) {
    const point = await unlockPoint(l.blob, code, l.id);
    if (!point) continue;
    // The code belongs to the point just before this one: that is where the group stands.
    const prev = core.state.points.filter((p) => (p.seq ?? 0) < point.seq).pop() || null;
    unlocked.points[point.id] = point;
    if (prev && !unlocked.reached.includes(prev.id)) unlocked.reached.push(prev.id);
    saveUnlocked(unlocked);
    if (prev) {
      codeQueue.push({ point: prev.id, code, at: Date.now() });
      saveCodeQueue(codeQueue);
    }
    core.applyState(mergeUnlocked({
      version: core.state.version, points: core.state.points, routes: core.state.routes, groups: core.state.groups,
      settings: core.state.settings, area: core.state.area, locked: core.state.locked, progress: core.state.progress
    }));
    core.setTarget(point.id);
    toast('Checkpoint seterusnya dibuka: ' + point.name, 5000);
    flushCodes();
    return true;
  }
  await notify({ title: 'Kod salah', body: 'Semak kod dengan marshal di checkpoint. Huruf besar kecil tidak penting.' });
  return false;
}

/** Deliver queued code check-ins; a marshal's record is not needed for these. */
let flushingCodes = false;
async function flushCodes() {
  if (flushingCodes || !codeQueue.length || !groupPin || !navigator.onLine) return;
  flushingCodes = true;
  try {
    await postCheckins({ groupPin, device, items: codeQueue });
    codeQueue = [];
    saveCodeQueue(codeQueue);
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      // The server will never take these (point gone, code rotated); stop retrying.
      codeQueue = [];
      saveCodeQueue(codeQueue);
    }
  } finally {
    flushingCodes = false;
  }
}

$('btnCode').addEventListener('click', async () => {
  if (!groupPin) {
    await notify({ title: 'Masuk dahulu', body: 'Masuk dengan PIN kumpulan sebelum memasukkan kod checkpoint.' });
    return;
  }
  const raw = await askText({
    title: 'Kod checkpoint',
    body: 'Taip kod yang dipaparkan marshal di checkpoint ini. Checkpoint seterusnya akan dibuka serta-merta, walaupun tanpa isyarat.',
    placeholder: 'cth. K7PX2M',
    label: 'Kod checkpoint',
    okLabel: 'Buka'
  });
  if (raw) enterCode(raw);
});

/* — QR scan, where the browser can read barcodes (Android Chrome) — */
const scanUI = $('scan');
let scanStream = null;
let scanTimer = null;

function stopScan() {
  clearTimeout(scanTimer);
  scanTimer = null;
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $('scanvideo').srcObject = null;
  scanUI.hidden = true;
}

async function startScan() {
  if (!groupPin) {
    await notify({ title: 'Masuk dahulu', body: 'Masuk dengan PIN kumpulan sebelum mengimbas kod.' });
    return;
  }
  let detector;
  try {
    detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    notify({ title: 'Kamera tidak tersedia', body: 'Taip kod checkpoint sebagai ganti.' });
    return;
  }
  const video = $('scanvideo');
  video.srcObject = scanStream;
  scanUI.hidden = false;
  const tick = async () => {
    if (!scanStream) return;
    try {
      const found = await detector.detect(video);
      for (const b of found) {
        const code = codeFromText(b.rawValue);
        if (code) {
          stopScan();
          enterCode(code);
          return;
        }
      }
    } catch { /* frame not ready */ }
    scanTimer = setTimeout(tick, 250);
  };
  tick();
}

if ('BarcodeDetector' in window && navigator.mediaDevices) {
  $('btnScan').hidden = false;
  $('btnScan').addEventListener('click', startScan);
}
$('btnScanClose').addEventListener('click', stopScan);

window.addEventListener('online', flushCodes);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flushCodes(); });
setInterval(flushCodes, 60 * 1000);

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
  unlocked = { points: {}, reached: [] };
  saveUnlocked(unlocked);
  codeQueue = [];
  saveCodeQueue(codeQueue);
  // Without a PIN the phone may only see MULA; drop the checkpoints it held.
  const start = core.state.points.find((p) => p.type === 'start');
  core.applyState({ version: core.state.version, points: start ? [start] : [], progress: null, locked: [] });
  renderGroup();
}

function renderGroup() {
  const mine = core.state.groups.find((g) => g.id === group) || null;
  const known = !!mine && !!groupPin;
  $('grpname').textContent = known ? mine.name : (group ? 'Masuk semula dengan PIN' : 'Belum masuk');
  $('btnLogin').hidden = known;
  $('btnLogin').textContent = group && !known ? 'Masuk semula dengan PIN' : 'Masuk dengan PIN';
  $('btnSend').hidden = !known;
  $('btnGroup').hidden = !known;
  $('btnGroup').textContent = known ? 'Bukan ' + mine.name + '? Tukar' : '';
  $('btnSOS').disabled = !known;
  renderNet();
  // ETAs in the checkpoint list become clock times once this group has set off.
  core.setScheduleStart(mine ? mine.startedAt : null);
}

/* ── one emergency flow: data when there is a line, SMS when there is not ── */

const smsNumber = () => (core.state.settings || {}).smsNumber || '';
const smsReady = () => !!smsNumber() && !!groupPin && core.state.groups.some((g) => g.id === group);

/** The text the command centre's SMS parser reads: group, position, time, SOS. */
function smsText(fix, sos) {
  const mine = core.state.groups.find((g) => g.id === group);
  const index = core.state.groups.indexOf(mine);
  return 'JL K' + groupLabel(mine, index) + ' ' + fix.lat.toFixed(5) + ',' + fix.lng.toFixed(5) +
    ' ' + clock(fix.at) + (sos ? ' SOS' : '');
}

/** Open the phone's messaging app with the position (and SOS) filled in. */
async function openSms(sos) {
  if (!smsReady()) {
    notify({ title: 'SMS tidak tersedia', body: 'Pusat kawalan belum menetapkan nombor SMS.' });
    return false;
  }
  let fix = reporter.lastFix();
  if (!fix) {
    toast('Mencari GPS…');
    fix = await reporter.sendNow();
    if (!fix) {
      notify({ title: 'GPS belum dapat', body: 'Cuba di kawasan terbuka, kemudian tekan sekali lagi.' });
      return false;
    }
  }
  // iOS wants "&body=", Android "?body=".
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  window.location.href = 'sms:' + smsNumber() + (ios ? '&' : '?') + 'body=' + encodeURIComponent(smsText(fix, sos));
  return true;
}

$('btnSms').addEventListener('click', () => openSms(reporter.isSOS()));
$('btnSosSms').addEventListener('click', () => openSms(true));

/* — status line: what the phone has managed to deliver, and what to do about it — */

let lastStatus = { sos: false, queued: 0, lastDeliveredAt: null, error: '' };
let sosAt = null;          // when SOS was raised on this phone
let sosSmsOffered = false; // the SMS app was opened for this SOS already

const noLine = () => !navigator.onLine || (!!lastStatus.error && !lastStatus.error.startsWith('GPS'));

function renderNet() {
  const s = lastStatus;
  const el = $('repstat');
  let cls = '';
  let text;
  if (s.error && s.error.startsWith('GPS')) {
    cls = 'bad';
    text = s.error + ' — pergi ke kawasan terbuka';
  } else if (noLine()) {
    cls = 'warn';
    text = (s.queued ? s.queued + ' kedudukan dalam giliran · ' : '') + 'tiada talian';
    if (s.lastDeliveredAt) text += ' · terakhir dihantar ' + clock(s.lastDeliveredAt);
  } else if (s.lastDeliveredAt) {
    cls = 'ok';
    text = 'Kedudukan dihantar ' + clock(s.lastDeliveredAt) + (s.queued ? ' · ' + s.queued + ' dalam giliran' : '');
  } else {
    text = groupPin ? 'Belum ada kedudukan dihantar' : 'Masuk dengan PIN untuk mula menghantar kedudukan';
  }
  el.className = 'status ' + cls;
  el.querySelector('.t').textContent = text;
  $('smsrow').hidden = !(noLine() && smsReady());
  syncSOS();
}

window.addEventListener('online', renderNet);
window.addEventListener('offline', renderNet);

/* ── reporter ───────────────────────────────────────────────────────── */

const reporter = createReporter({
  getGroup: () => group,
  getPin: () => groupPin,
  getDevice: () => device,
  onFix: (fix) => {
    // Facing beam: the direction of travel counts only at walking pace or faster.
    if (fix.heading !== null && fix.speed !== null && fix.speed >= 0.5) core.setCourse(fix.heading);
    core.setMyPos(fix, fix.acc);
  },
  onStatus: (s) => {
    lastStatus = s;
    renderNet();
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
  else if (noLine()) toast(smsReady() ? 'Tiada talian — kedudukan beratur. Guna SMS di bawah jika perlu.' : 'Tiada talian — kedudukan beratur dan dihantar bila ada isyarat.', 5000);
});

$('btnGroup').addEventListener('click', chooseGroup);
$('btnLogin').addEventListener('click', chooseGroup);

/* ── SOS: one button; the phone picks the channel ───────────────────── */

const btnSOS = $('btnSOS');
const sosBanner = $('sosbanner');

function syncSOS() {
  const on = lastStatus.sos;
  btnSOS.classList.toggle('on', on);
  btnSOS.setAttribute('aria-pressed', String(on));
  sosBanner.style.display = on ? 'flex' : 'none';
  document.body.classList.toggle('sos-on', on);
  if (!on) return;
  const delivered = lastStatus.lastDeliveredAt && sosAt && lastStatus.lastDeliveredAt >= sosAt;
  let text;
  if (delivered) text = 'SOS dihantar ' + clock(lastStatus.lastDeliveredAt) + ' · pusat kawalan dimaklumkan · tekan SOS untuk batal';
  else if (noLine()) text = smsReady() ? 'SOS aktif · tiada talian data · hantar melalui SMS' : 'SOS aktif · tiada talian · dihantar sebaik ada isyarat · gunakan wisel';
  else text = 'SOS aktif · menghantar…';
  $('sostext').textContent = text;
  $('btnSosSms').hidden = !(noLine() && smsReady() && !delivered);
}

btnSOS.addEventListener('click', async () => {
  if (reporter.isSOS()) {
    const ok = await askConfirm({
      title: 'Batalkan SOS?',
      body: 'Pusat kawalan akan dimaklumkan yang keadaan sudah selamat.',
      okLabel: 'Ya, keadaan selamat',
      cancelLabel: 'Kekalkan SOS'          // never a second button that also reads "batal"
    });
    if (!ok) return;
    sosAt = null;
    sosSmsOffered = false;
    await reporter.setSOS(false);
    if (noLine() && smsReady()) toast('Tiada talian — beritahu pusat kawalan melalui SMS atau radio yang keadaan selamat.', 5000);
    return;
  }
  const ok = await askConfirm({
    title: 'Hantar SOS?',
    body: 'Lokasi telefon ini dihantar serta-merta dan ditanda SOS di pusat kawalan — melalui internet, atau melalui SMS jika tiada talian data. Gunakan bila ada kecemasan sebenar.',
    okLabel: 'Hantar SOS',
    cancelLabel: 'Jangan hantar'
  });
  if (!ok) return;
  sosAt = Date.now();
  sosSmsOffered = false;
  await reporter.setSOS(true);
  const delivered = lastStatus.lastDeliveredAt && lastStatus.lastDeliveredAt >= sosAt;
  if (delivered) {
    toast('SOS dihantar. Kekalkan app terbuka.', 6000);
  } else if (smsReady()) {
    // No line for data: fall straight through to SMS with the same fix.
    sosSmsOffered = true;
    toast('Tiada talian data — membuka SMS untuk SOS…', 5000);
    await openSms(true);
  } else {
    toast('Tiada talian — SOS beratur dan dihantar sebaik ada isyarat. Gunakan wisel.', 7000);
  }
  syncSOS();
});

/* ── bottom tab bar ─────────────────────────────────────────────────── */

mountTabs({ map: core.map, storageKey: 'jl_tab_peserta', defaultPane: 'kumpulan' });

/* ── keep the screen on: automatic, for as long as the app is open ──── */

// A dark screen suspends the page and with it the position reports, so the
// app holds a screen wake lock by itself: on launch, again whenever it comes
// back to the front (the lock is released when the page is hidden), and on the
// first tap in case the browser wants a gesture. Nothing to switch on or off.
let wakeLock = null;
let wakeWarned = false;

async function holdWake() {
  if (wakeLock || document.visibilityState !== 'visible') return;
  const note = $('wakestat');
  if (!('wakeLock' in navigator)) {
    note.hidden = false;
    note.textContent = 'Pelayar ini tidak boleh kekalkan skrin hidup — tetapkan Auto-Lock telefon kepada "Never" semasa program.';
    if (!wakeWarned) {
      wakeWarned = true;
      toast('Skrin boleh padam sendiri pada pelayar ini — tetapkan Auto-Lock kepada Never.', 7000);
    }
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    note.hidden = true;
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed right now (battery saver, no gesture yet): the next tap or return retries */ }
}

holdWake();
document.addEventListener('visibilitychange', holdWake);
document.addEventListener('click', holdWake);

/* ── init ───────────────────────────────────────────────────────────── */

renderGroup();
// A checkpoint QR carries our own URL with ?kod=…; the camera app lands here.
const kodFromUrl = new URLSearchParams(location.search).get('kod');
if (kodFromUrl) history.replaceState(null, '', location.pathname);
syncState().then(async () => {
  const known = group && groupPin && core.state.groups.some((g) => g.id === group);
  if (known) reporter.start();
  else await chooseGroup();
  if (kodFromUrl && groupPin) enterCode(kodFromUrl);
});
setInterval(syncState, STATE_POLL_MS);
window.addEventListener('online', syncState);
