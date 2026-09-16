/* Jalan Lasak — peta program.
   Titik mula, checkpoint, laluan cadangan dan peta topo/satelit yang
   berfungsi tanpa talian. */

import { distM, bearing, fmtDist, pathKm } from './geo.js';
import {
  DEFAULT_POINTS, loadPoints, savePoints, loadRoutes, saveRoutes,
  loadTarget, saveTarget, loadPrefs, savePrefs
} from './store.js';
import { askText, askConfirm, notify, toast } from './ui.js';
import { planTiles, precacheTiles, cachedTileCount, clearTiles, approxSize } from './offline.js';

const L = window.L;
if (!L) throw new Error('Leaflet tidak dimuatkan — semak vendor/leaflet/leaflet.js');

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* ── tile sources ─────────────────────────────────────────────────────── */

const LAYERS = {
  osm: {
    label: 'Denai OSM',
    template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: [],
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  },
  topo: {
    label: 'Topo',
    template: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    maxZoom: 17,
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)'
  },
  sat: {
    label: 'Satelit',
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    subdomains: [],
    maxZoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
  }
};
// Same source as the topo base, drawn translucent over another layer. It keeps
// topo's exact attribution string so Leaflet credits OpenTopoMap only once
// when both are on.
const CONTOUR = { ...LAYERS.topo, opacity: 0.45 };

/* ── state ────────────────────────────────────────────────────────────── */

let points = loadPoints();
let routes = loadRoutes();
let targetId = loadTarget();
const prefs = loadPrefs();

let myPos = null;
let myMarker = null;
let myCircle = null;
let follow = false;
let gpsWatch = null;
let deviceHeading = null;

let addMode = false;
let drawMode = false;
let drawPts = [];
let drawLine = null;
let drawDots = [];

const markers = {};
const routeLayers = {};

/* ── map ──────────────────────────────────────────────────────────────── */

const map = L.map('map', { zoomControl: false, attributionControl: true });
// Drop Leaflet's own prefix — on a phone the credits must fit one line, and
// the tile sources' attribution is the part that has to stay.
map.attributionControl.setPrefix(false);
L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 120 }).addTo(map);

const baseLayers = {};
for (const [key, source] of Object.entries(LAYERS)) {
  baseLayers[key] = L.tileLayer(source.template, {
    maxZoom: source.maxZoom,
    maxNativeZoom: source.maxZoom,
    attribution: source.attribution,
    subdomains: source.subdomains.length ? source.subdomains : 'abc'
  });
}
const contourOverlay = L.tileLayer(CONTOUR.template, {
  maxZoom: CONTOUR.maxZoom,
  maxNativeZoom: CONTOUR.maxZoom,
  opacity: CONTOUR.opacity,
  attribution: CONTOUR.attribution,
  subdomains: CONTOUR.subdomains
});

let currentBase = LAYERS[prefs.base] ? prefs.base : 'osm';
baseLayers[currentBase].addTo(map);
if (prefs.contour) contourOverlay.addTo(map);

function setBase(key) {
  if (!LAYERS[key] || key === currentBase) return;
  map.removeLayer(baseLayers[currentBase]);
  baseLayers[key].addTo(map);
  currentBase = key;
  prefs.base = key;
  savePrefs(prefs);
  syncLayerButtons();
}

function syncLayerButtons() {
  document.querySelectorAll('#layers button').forEach((button) => {
    const on = button.dataset.layer === currentBase;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  });
}

document.querySelectorAll('#layers button').forEach((button) => {
  button.addEventListener('click', () => setBase(button.dataset.layer));
});
syncLayerButtons();

const contourRow = $('contourrow');
function syncContour() {
  contourRow.classList.toggle('on', prefs.contour);
  contourRow.setAttribute('aria-pressed', String(prefs.contour));
}
contourRow.addEventListener('click', () => {
  prefs.contour = !prefs.contour;
  if (prefs.contour) contourOverlay.addTo(map);
  else map.removeLayer(contourOverlay);
  savePrefs(prefs);
  syncContour();
});
syncContour();

/* ── markers ──────────────────────────────────────────────────────────── */

const isStart = (p) => p.type === 'start';
const findPoint = (id) => points.find((p) => p.id === id);
const startPoint = () => points.find(isStart);
const coordText = (p) => p.lat.toFixed(6) + ', ' + p.lng.toFixed(6);

function markerIcon(point, index) {
  const label = isStart(point) ? 'M' : String(index);
  return L.divIcon({
    className: '',
    html: `<div class="jl-marker${isStart(point) ? ' start' : ''}">${label}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function popupContent(point) {
  const wrap = el('div');
  wrap.append(el('div', 'pop-name', point.name), el('div', 'pop-co', coordText(point)));

  const actions = el('div', 'pop-actions');
  const action = (label, accent, handler) => {
    const button = el('button', 'jl-btn sm' + (accent ? ' acc' : ''), label);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  };
  actions.append(action('Sasar', true, () => setTarget(point.id)));
  actions.append(action('Nama', false, () => renamePoint(point.id)));
  if (!isStart(point)) actions.append(action('Padam', false, () => deletePoint(point.id)));
  wrap.append(actions);
  return wrap;
}

function rebuildMarkers() {
  for (const key of Object.keys(markers)) {
    map.removeLayer(markers[key]);
    delete markers[key];
  }
  let cpIndex = 0;
  points.forEach((point) => {
    if (!isStart(point)) cpIndex++;
    const marker = L.marker([point.lat, point.lng], {
      icon: markerIcon(point, cpIndex),
      draggable: true,
      keyboard: true,
      alt: point.name
    });
    marker.bindPopup(() => popupContent(point));
    marker.on('dragend', () => {
      const ll = marker.getLatLng();
      point.lat = ll.lat;
      point.lng = ll.lng;
      savePoints(points);
      renderPointList();
      updateStrip();
    });
    marker.addTo(map);
    markers[point.id] = marker;
  });
  renderPointList();
}

/* ── target + compass strip ───────────────────────────────────────────── */

function setTarget(id) {
  targetId = id;
  saveTarget(id);
  map.closePopup();
  updateStrip();
  renderPointList();
}

function updateStrip() {
  const target = findPoint(targetId);
  const nameEl = $('tgtname');
  const distEl = $('tgtdist');
  const brgEl = $('tgtbrg');

  if (!target) {
    nameEl.textContent = 'Sasaran: —';
    distEl.textContent = '— km';
    brgEl.textContent = '—°';
    return;
  }
  nameEl.textContent = 'Sasaran: ' + target.name;

  const origin = myPos || startPoint();
  if (!origin || origin === target) {
    distEl.textContent = myPos ? '0 m' : '— km';
    brgEl.textContent = '—°';
    return;
  }
  distEl.textContent = fmtDist(distM(origin, target)) + (myPos ? '' : ' (dari MULA)');
  const brg = bearing(origin, target);
  brgEl.textContent = Math.round(brg) + '°';
  const rotation = deviceHeading === null ? brg : brg - deviceHeading;
  $('arrowsvg').style.transform = `rotate(${rotation}deg)`;
}

/* ── GPS ──────────────────────────────────────────────────────────────── */

const btnLocate = $('btnLocate');

function startGPS() {
  if (gpsWatch !== null) return true;
  if (!navigator.geolocation) {
    notify({ title: 'GPS tidak disokong', body: 'Peranti atau pelayar ini tidak menyediakan lokasi.' });
    return false;
  }
  gpsWatch = navigator.geolocation.watchPosition((position) => {
    myPos = { lat: position.coords.latitude, lng: position.coords.longitude };
    const accuracy = position.coords.accuracy || 30;
    if (!myMarker) {
      myMarker = L.circleMarker(myPos, {
        radius: 8, color: '#fff', weight: 2,
        fillColor: '#2a78d6', fillOpacity: 1, interactive: false
      }).addTo(map);
      myCircle = L.circle(myPos, {
        radius: accuracy, color: '#2a78d6', weight: 1,
        fillColor: '#2a78d6', fillOpacity: 0.12, interactive: false
      }).addTo(map);
    } else {
      myMarker.setLatLng(myPos);
      myCircle.setLatLng(myPos).setRadius(accuracy);
    }
    if (follow) map.panTo(myPos);
    renderPointList();
    updateStrip();
  }, (error) => {
    notify({ title: 'Gagal dapatkan lokasi', body: error.message });
    stopFollow();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  return true;
}

function stopFollow() {
  follow = false;
  btnLocate.classList.remove('on');
  btnLocate.setAttribute('aria-pressed', 'false');
}

btnLocate.addEventListener('click', () => {
  if (follow) {
    stopFollow();
    return;
  }
  if (!startGPS()) return;
  follow = true;
  btnLocate.classList.add('on');
  btnLocate.setAttribute('aria-pressed', 'true');
  if (myPos) map.panTo(myPos);
  else toast('Mencari isyarat GPS…');
});

/* ── device compass ───────────────────────────────────────────────────── */

function onOrientation(event) {
  let heading = null;
  if (typeof event.webkitCompassHeading === 'number') heading = event.webkitCompassHeading;
  else if (event.absolute && typeof event.alpha === 'number') heading = 360 - event.alpha;
  if (heading !== null) {
    deviceHeading = heading;
    updateStrip();
  }
}

if (window.DeviceOrientationEvent) {
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS only grants the sensor from inside a user gesture.
    const request = () => {
      document.body.removeEventListener('click', request);
      DeviceOrientationEvent.requestPermission()
        .then((result) => {
          if (result === 'granted') window.addEventListener('deviceorientation', onOrientation);
        })
        .catch(() => { /* declined — bearing still shows, arrow stays north-up */ });
    };
    document.body.addEventListener('click', request);
  } else {
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
  }
}

/* ── add / rename / delete checkpoints ────────────────────────────────── */

const btnAdd = $('btnAdd');
const addBanner = $('addbanner');

function setAddMode(on) {
  addMode = on;
  btnAdd.classList.toggle('on', on);
  btnAdd.setAttribute('aria-pressed', String(on));
  addBanner.style.display = on ? 'block' : 'none';
  if (on) setDrawMode(false);
}

btnAdd.addEventListener('click', () => setAddMode(!addMode));

async function addPointAt(latlng) {
  const suggested = 'Checkpoint ' + (points.filter((p) => !isStart(p)).length + 1);
  const name = await askText({
    title: 'Checkpoint baharu',
    body: latlng.lat.toFixed(6) + ', ' + latlng.lng.toFixed(6),
    value: suggested,
    label: 'Nama checkpoint',
    okLabel: 'Tambah'
  });
  if (name === null) return;
  points.push({
    id: 'cp_' + Date.now(),
    type: 'cp',
    name: name || suggested,
    lat: latlng.lat,
    lng: latlng.lng
  });
  savePoints(points);
  rebuildMarkers();
  updateStrip();
  toast('Checkpoint ditambah.');
}

async function renamePoint(id) {
  const point = findPoint(id);
  if (!point) return;
  const name = await askText({
    title: 'Namakan semula',
    value: point.name,
    label: 'Nama titik'
  });
  if (name === null || !name) return;
  point.name = name;
  savePoints(points);
  rebuildMarkers();
  updateStrip();
}

async function deletePoint(id) {
  const point = findPoint(id);
  if (!point) return;
  const ok = await askConfirm({
    title: 'Padam checkpoint?',
    body: point.name,
    okLabel: 'Padam'
  });
  if (!ok) return;
  points = points.filter((p) => p.id !== id);
  if (targetId === id) {
    const start = startPoint();
    targetId = start ? start.id : '';
    saveTarget(targetId);
  }
  savePoints(points);
  rebuildMarkers();
  updateStrip();
}

map.on('click', (event) => {
  if (drawMode) {
    drawAddVertex(event.latlng);
    return;
  }
  if (addMode) {
    setAddMode(false);
    addPointAt(event.latlng);
  }
});
// Long press on a touch screen, right click on a desktop.
map.on('contextmenu', (event) => {
  if (!drawMode) addPointAt(event.latlng);
});

/* ── laluan cadangan ──────────────────────────────────────────────────── */

function rebuildRoutes() {
  for (const key of Object.keys(routeLayers)) {
    map.removeLayer(routeLayers[key]);
    delete routeLayers[key];
  }
  routes.forEach((route) => {
    const line = L.polyline(route.latlngs, {
      color: '#ec3013', weight: 4, dashArray: '8 6', opacity: 0.9
    });
    line.bindPopup(() => {
      const wrap = el('div');
      wrap.append(
        el('div', 'pop-name', route.name),
        el('div', 'pop-co', '± ' + pathKm(route.latlngs).toFixed(2) + ' km · ' + route.latlngs.length + ' titik')
      );
      const actions = el('div', 'pop-actions');
      const del = el('button', 'jl-btn sm', 'Padam');
      del.type = 'button';
      del.addEventListener('click', () => deleteRoute(route.id));
      actions.append(del);
      wrap.append(actions);
      return wrap;
    });
    line.addTo(map);
    routeLayers[route.id] = line;
  });
  renderRouteList();
}

async function deleteRoute(id) {
  const route = routes.find((r) => r.id === id);
  if (!route) return;
  const ok = await askConfirm({ title: 'Padam laluan?', body: route.name, okLabel: 'Padam' });
  if (!ok) return;
  routes = routes.filter((r) => r.id !== id);
  saveRoutes(routes);
  map.closePopup();
  rebuildRoutes();
}

const btnDraw = $('btnDraw');
const drawbar = $('drawbar');

function drawRefresh() {
  const latlngs = drawPts.map((p) => [p.lat, p.lng]);
  if (!drawLine) {
    drawLine = L.polyline([], { color: '#ec3013', weight: 4, dashArray: '8 6' }).addTo(map);
  }
  drawLine.setLatLngs(latlngs);
  $('drawkm').textContent = pathKm(latlngs).toFixed(2) + ' km';
}

function drawAddVertex(latlng) {
  drawPts.push(latlng);
  drawDots.push(L.circleMarker(latlng, {
    radius: 5, color: '#fff', weight: 2,
    fillColor: '#ec3013', fillOpacity: 1, interactive: false
  }).addTo(map));
  drawRefresh();
}

function drawClear() {
  if (drawLine) {
    map.removeLayer(drawLine);
    drawLine = null;
  }
  drawDots.forEach((dot) => map.removeLayer(dot));
  drawDots = [];
  drawPts = [];
}

function setDrawMode(on) {
  drawMode = on;
  btnDraw.classList.toggle('on', on);
  btnDraw.setAttribute('aria-pressed', String(on));
  drawbar.style.display = on ? 'flex' : 'none';
  if (on) {
    addMode = false;
    btnAdd.classList.remove('on');
    btnAdd.setAttribute('aria-pressed', 'false');
    addBanner.style.display = 'none';
    $('drawkm').textContent = '0.00 km';
  } else {
    drawClear();
  }
}

btnDraw.addEventListener('click', () => setDrawMode(!drawMode));

$('drawUndo').addEventListener('click', () => {
  drawPts.pop();
  const dot = drawDots.pop();
  if (dot) map.removeLayer(dot);
  drawRefresh();
});

$('drawCancel').addEventListener('click', () => setDrawMode(false));

$('drawDone').addEventListener('click', async () => {
  if (drawPts.length < 2) {
    notify({ title: 'Laluan terlalu pendek', body: 'Perlu sekurang-kurangnya 2 titik.' });
    return;
  }
  const latlngs = drawPts.map((p) => [p.lat, p.lng]);
  const suggested = 'Laluan ' + (routes.length + 1);
  const name = await askText({
    title: 'Simpan laluan',
    body: '± ' + pathKm(latlngs).toFixed(2) + ' km · ' + latlngs.length + ' titik',
    value: suggested,
    label: 'Nama laluan'
  });
  if (name === null) return;
  routes.push({ id: 'rt_' + Date.now(), name: name || suggested, latlngs });
  saveRoutes(routes);
  setDrawMode(false);
  rebuildRoutes();
  toast('Laluan disimpan.');
});

/* ── lists ────────────────────────────────────────────────────────────── */

function renderPointList() {
  const origin = myPos || startPoint();
  const wrap = $('pointlist');
  wrap.textContent = '';
  let cpIndex = 0;

  points.forEach((point) => {
    if (!isStart(point)) cpIndex++;
    const row = el('button', 'row' + (isStart(point) ? ' start' : ''));
    row.type = 'button';
    row.append(el('span', 'badge', isStart(point) ? 'M' : String(cpIndex)));

    const text = el('span');
    const name = el('span', 'nm', point.name + (point.id === targetId ? ' ◀' : ''));
    text.append(name, el('br'), el('span', 'co', coordText(point)));
    row.append(text);

    const dist = el('span', 'dist');
    const same = origin === point;
    dist.append(document.createTextNode(origin && !same ? fmtDist(distM(origin, point)) : '—'));
    dist.append(el('small', null, myPos ? 'dari saya' : 'dari mula'));
    row.append(dist);

    row.addEventListener('click', () => {
      map.setView([point.lat, point.lng], Math.max(map.getZoom(), 15));
      if (markers[point.id]) markers[point.id].openPopup();
    });
    wrap.append(row);
  });

  const count = points.filter((p) => !isStart(p)).length;
  $('cpcount').textContent = count + ' checkpoint · tekan lama peta utk tambah';
}

function renderRouteList() {
  const wrap = $('routelist');
  wrap.textContent = '';

  if (!routes.length) {
    wrap.append(el('div', 'empty', 'Tiada laluan lagi — tekan butang garis putus utk lukis.'));
  }

  routes.forEach((route) => {
    const row = el('div', 'row');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.append(el('span', 'rline'));

    const text = el('span');
    text.append(
      el('span', 'nm', route.name), el('br'),
      el('span', 'co', route.latlngs.length + ' titik')
    );
    row.append(text);
    row.append(el('span', 'dist', '± ' + pathKm(route.latlngs).toFixed(2) + ' km'));

    const del = el('button', 'jl-btn sm del', 'Padam');
    del.type = 'button';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteRoute(route.id);
    });
    row.append(del);

    const zoomTo = () => {
      map.fitBounds(L.latLngBounds(route.latlngs).pad(0.2));
      if (routeLayers[route.id]) routeLayers[route.id].openPopup();
    };
    row.addEventListener('click', zoomTo);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        zoomTo();
      }
    });
    wrap.append(row);
  });

  $('rtcount').textContent = routes.length ? '· ' + routes.length : '';
}

/* ── sheet + fit ──────────────────────────────────────────────────────── */

const sheet = $('sheet');
const sheetHead = $('sheethead');
sheetHead.addEventListener('click', () => {
  const open = sheet.classList.toggle('open');
  sheetHead.setAttribute('aria-expanded', String(open));
  // The map's usable height changed with the sheet.
  setTimeout(() => map.invalidateSize({ pan: false }), 210);
});

function fitAll() {
  const coords = points.map((p) => [p.lat, p.lng]);
  if (!coords.length) {
    map.setView([DEFAULT_POINTS[0].lat, DEFAULT_POINTS[0].lng], 13);
    return;
  }
  const bounds = L.latLngBounds(coords);
  if (myPos) bounds.extend(myPos);
  map.fitBounds(bounds.pad(0.15), { maxZoom: 16 });
}
$('btnFit').addEventListener('click', fitAll);

/* ── peta offline ─────────────────────────────────────────────────────── */

const btnCache = $('btnCache');
const btnCacheClear = $('btnCacheClear');
const offStat = $('offstat');
const offBar = $('offbar');
const offBarFill = $('offbarfill');

async function refreshOfflineStatus() {
  const count = await cachedTileCount();
  offStat.textContent = count
    ? `${count} tile disimpan · ± ${approxSize(count)}`
    : 'Belum ada tile disimpan';
}

function activeSources() {
  const sources = [LAYERS[currentBase]];
  if (prefs.contour && currentBase !== 'topo') sources.push(CONTOUR);
  return sources;
}

btnCache.addEventListener('click', async () => {
  if (!('caches' in window)) {
    notify({ title: 'Tidak disokong', body: 'Pelayar ini tidak menyokong storan peta offline.' });
    return;
  }
  const zMin = Math.max(10, Math.round(map.getZoom()));
  const zMax = Math.min(zMin + 2, 17);
  const urls = planTiles(map.getBounds(), zMin, zMax, activeSources());

  if (!urls.length) {
    notify({ title: 'Tiada tile', body: 'Zum masuk sedikit dahulu, kemudian cuba lagi.' });
    return;
  }
  const ok = await askConfirm({
    title: 'Simpan kawasan ini?',
    body: `${urls.length} tile (zum ${zMin}–${zMax}, lapisan ${LAYERS[currentBase].label}) — lebih kurang ${approxSize(urls.length)}. Perlukan talian sekarang.`,
    okLabel: 'Simpan'
  });
  if (!ok) return;

  btnCache.disabled = true;
  btnCacheClear.disabled = true;
  offBar.classList.add('on');
  offBarFill.style.width = '0%';

  try {
    const stats = await precacheTiles(urls, {
      onProgress: ({ done, total }) => {
        offBarFill.style.width = Math.round(done / total * 100) + '%';
        offStat.textContent = `Memuat turun ${done}/${total}`;
      }
    });
    toast(stats.failed
      ? `Selesai — ${stats.saved} tile disimpan, ${stats.failed} gagal.`
      : `Selesai — ${stats.saved} tile disimpan.`);
  } catch {
    toast('Gagal menyimpan tile.');
  } finally {
    btnCache.disabled = false;
    btnCacheClear.disabled = false;
    offBar.classList.remove('on');
    refreshOfflineStatus();
  }
});

btnCacheClear.addEventListener('click', async () => {
  const ok = await askConfirm({
    title: 'Kosongkan peta offline?',
    body: 'Semua tile yang disimpan akan dibuang. Checkpoint dan laluan tidak terjejas.',
    okLabel: 'Kosongkan'
  });
  if (!ok) return;
  await clearTiles();
  toast('Tile dikosongkan.');
  refreshOfflineStatus();
});

/* ── online / offline ─────────────────────────────────────────────────── */

function netUI() {
  const off = !navigator.onLine;
  $('netdot').classList.toggle('off', off);
  $('netlabel').textContent = off ? 'Offline' : 'Online';
}
window.addEventListener('online', netUI);
window.addEventListener('offline', netUI);
netUI();

/* ── service worker ───────────────────────────────────────────────────── */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((registration) => {
      registration.update();
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Versi baharu tersedia — muat semula untuk kemas kini.', 6000);
          }
        });
      });
    }).catch(() => { /* offline storage simply stays unavailable */ });
  });
}

/* ── init ─────────────────────────────────────────────────────────────── */

rebuildMarkers();
rebuildRoutes();
fitAll();
updateStrip();
refreshOfflineStatus();
setInterval(updateStrip, 3000);
