/* Jalan Lasak — the map screen both roles share.

   boot() builds the map, layers, markers, routes, compass strip, lists and
   offline tools, and returns a handle the role modules (peserta.js,
   pusat.js) drive. Editing tools live in edit.js and mount onto that handle
   only for the command centre. */

import { distM, bearing, fmtDist, pathKm } from './geo.js';
import { DEFAULT_POINTS, loadState, saveState, loadTarget, saveTarget, loadPrefs, savePrefs } from './store.js';
import { notify, toast, askConfirm } from './ui.js';
import { planTiles, precacheTiles, cachedTileCount, clearTiles, approxSize, deepestZoom } from './offline.js';
import { etaLabel } from './schedule.js';

export const $ = (id) => document.getElementById(id);
export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* ── tile sources ─────────────────────────────────────────────────────── */

export const LAYERS = {
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
// topo's exact attribution string so Leaflet credits OpenTopoMap only once.
const CONTOUR = { ...LAYERS.topo, opacity: 0.45 };

export const isStart = (p) => p.type === 'start';

/** "MULA → Checkpoint 2" from a route's endpoints, or its stored name. */
export function routeLabel(route, points) {
  const name = (id) => {
    const p = points.find((x) => x.id === id);
    return p ? (isStart(p) ? 'MULA' : p.name) : null;
  };
  const a = route.from ? name(route.from) : null;
  const b = route.to ? name(route.to) : null;
  if (a && b) return a + ' → ' + b;
  if (b) return '→ ' + b;
  return route.name;
}
export const coordText = (p) => p.lat.toFixed(6) + ', ' + p.lng.toFixed(6);

/** Short label for a group: the number in its name if it has one, else initials. */
export function groupLabel(group, index = 0) {
  const m = /\d+/.exec(group.name || '');
  if (m) return m[0];
  const words = (group.name || '').trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return initials || String(index + 1);
}

export function boot({ editable = false } = {}) {
  const L = window.L;
  if (!L) throw new Error('Leaflet tidak dimuatkan — semak vendor/leaflet/leaflet.js');

  /* ── state ──────────────────────────────────────────────────────────── */

  const state = loadState();           // { version, points, routes, groups }
  let targetId = loadTarget();
  const prefs = loadPrefs();

  let myPos = null;
  let myMarker = null;
  let myCircle = null;
  let follow = false;
  let gpsWatch = null;
  let deviceHeading = null;

  const markers = {};
  const routeLayers = {};
  const hooks = { change: null, rename: null, remove: null, eta: null, mapClick: null, mapHold: null };
  let scheduleStart = null;   // this group's start time, for showing ETAs as clock times

  const findPoint = (id) => state.points.find((p) => p.id === id);
  const startPoint = () => state.points.find(isStart);

  /* ── map ────────────────────────────────────────────────────────────── */

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

  map.on('click', (event) => { if (hooks.mapClick) hooks.mapClick(event.latlng); });
  // Long press on a touch screen, right click on a desktop.
  map.on('contextmenu', (event) => { if (hooks.mapHold) hooks.mapHold(event.latlng); });

  /* ── markers ────────────────────────────────────────────────────────── */

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
    if (editable) {
      actions.append(action('Nama', false, () => hooks.rename && hooks.rename(point.id)));
      if (!isStart(point)) {
        actions.append(action('Masa', false, () => hooks.eta && hooks.eta(point.id)));
        actions.append(action('Padam', false, () => hooks.remove && hooks.remove(point.id)));
      }
    }
    wrap.append(actions);
    return wrap;
  }

  function rebuildMarkers() {
    for (const key of Object.keys(markers)) {
      map.removeLayer(markers[key]);
      delete markers[key];
    }
    let cpIndex = 0;
    state.points.forEach((point) => {
      if (!isStart(point)) cpIndex++;
      const marker = L.marker([point.lat, point.lng], {
        icon: markerIcon(point, cpIndex),
        draggable: editable,
        keyboard: true,
        alt: point.name
      });
      marker.bindPopup(() => popupContent(point));
      if (editable) {
        marker.on('dragend', () => {
          const ll = marker.getLatLng();
          point.lat = ll.lat;
          point.lng = ll.lng;
          changed();
          renderPointList();
          updateStrip();
        });
      }
      marker.addTo(map);
      markers[point.id] = marker;
    });
    renderPointList();
  }

  /* ── routes ─────────────────────────────────────────────────────────── */

  function rebuildRoutes() {
    for (const key of Object.keys(routeLayers)) {
      map.removeLayer(routeLayers[key]);
      delete routeLayers[key];
    }
    state.routes.forEach((route) => {
      const line = L.polyline(route.latlngs, {
        color: '#ec3013', weight: 4, dashArray: '8 6', opacity: 0.9
      });
      line.bindPopup(() => {
        const wrap = el('div');
        wrap.append(
          el('div', 'pop-name', routeLabel(route, state.points)),
          el('div', 'pop-co', '± ' + pathKm(route.latlngs).toFixed(2) + ' km · ' + route.latlngs.length + ' titik')
        );
        if (editable) {
          const actions = el('div', 'pop-actions');
          const del = el('button', 'jl-btn sm', 'Padam');
          del.type = 'button';
          del.addEventListener('click', () => hooks.removeRoute && hooks.removeRoute(route.id));
          actions.append(del);
          wrap.append(actions);
        }
        return wrap;
      });
      line.addTo(map);
      routeLayers[route.id] = line;
    });
    renderRouteList();
  }

  /* ── target + compass strip ─────────────────────────────────────────── */

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
      nameEl.textContent = '—';
      distEl.textContent = '— km';
      brgEl.textContent = '—°';
      return;
    }
    nameEl.textContent = target.name;

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

  /* ── GPS ────────────────────────────────────────────────────────────── */

  const btnLocate = $('btnLocate');

  function setMyPos(latlng, accuracy) {
    myPos = { lat: latlng.lat, lng: latlng.lng };
    const acc = accuracy || 30;
    if (!myMarker) {
      myMarker = L.circleMarker(myPos, {
        radius: 8, color: '#fff', weight: 2,
        fillColor: '#2a78d6', fillOpacity: 1, interactive: false
      }).addTo(map);
      myCircle = L.circle(myPos, {
        radius: acc, color: '#2a78d6', weight: 1,
        fillColor: '#2a78d6', fillOpacity: 0.12, interactive: false
      }).addTo(map);
    } else {
      myMarker.setLatLng(myPos);
      myCircle.setLatLng(myPos).setRadius(acc);
    }
    if (follow) map.panTo(myPos);
    renderPointList();
    updateStrip();
  }

  function startGPS() {
    if (gpsWatch !== null) return true;
    if (!navigator.geolocation) {
      notify({ title: 'GPS tidak disokong', body: 'Peranti atau pelayar ini tidak menyediakan lokasi.' });
      return false;
    }
    gpsWatch = navigator.geolocation.watchPosition((position) => {
      setMyPos({ lat: position.coords.latitude, lng: position.coords.longitude }, position.coords.accuracy);
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

  /* ── device compass ─────────────────────────────────────────────────── */

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

  /* ── lists ──────────────────────────────────────────────────────────── */

  function renderPointList() {
    const origin = myPos || startPoint();
    const wrap = $('pointlist');
    wrap.textContent = '';
    let cpIndex = 0;
    const reached = new Set((state.progress && state.progress.reached) || []);

    state.points.forEach((point) => {
      if (!isStart(point)) cpIndex++;
      const done = !isStart(point) && reached.has(point.id);
      const row = el('button', 'row' + (isStart(point) ? ' start' : '') + (done ? ' done' : ''));
      row.type = 'button';
      row.append(el('span', 'badge', isStart(point) ? 'M' : (done ? '✓' : String(cpIndex))));

      const text = el('span');
      const name = el('span', 'nm', point.name + (point.id === targetId ? ' ◀' : ''));
      const eta = etaLabel(point, scheduleStart);
      // Only the command centre holds codes; there they are worth a glance.
      const code = editable && point.code ? ' · kod ' + point.code : '';
      text.append(name, el('br'), el('span', 'co', coordText(point) + (eta ? ' · dijangka ' + eta : '') + code));
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

    // Participants see checkpoints one at a time; say that more follow, never how many.
    if (state.progress && state.progress.more) {
      const last = state.points[state.points.length - 1];
      wrap.append(el('div', 'empty hidden-cp', last && !isStart(last)
        ? 'Tiba di ' + last.name + '? Masukkan kod yang dipaparkan marshal di situ untuk membuka checkpoint seterusnya — berfungsi tanpa isyarat.'
        : 'Checkpoint pertama didedahkan bila anda masuk dengan PIN kumpulan.'));
    }

    const count = state.points.filter((p) => !isStart(p)).length;
    $('cpcount').textContent = String(count);   // sits in the tab bar on both pages
  }

  function renderRouteList() {
    const wrap = $('routelist');
    if (!wrap) return;   // the participant page has no route list
    wrap.textContent = '';

    if (!state.routes.length) {
      wrap.append(el('div', 'empty', editable
        ? 'Tiada laluan lagi — tekan butang garis putus utk lukis.'
        : 'Tiada laluan cadangan lagi.'));
    }

    state.routes.forEach((route) => {
      const row = el('div', 'row');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.append(el('span', 'rline'));

      const text = el('span');
      text.append(
        el('span', 'nm', routeLabel(route, state.points)), el('br'),
        el('span', 'co', route.latlngs.length + ' titik')
      );
      row.append(text);
      row.append(el('span', 'dist', '± ' + pathKm(route.latlngs).toFixed(2) + ' km'));

      if (editable) {
        const del = el('button', 'jl-btn sm del', 'Padam');
        del.type = 'button';
        del.addEventListener('click', (event) => {
          event.stopPropagation();
          if (hooks.removeRoute) hooks.removeRoute(route.id);
        });
        row.append(del);
      }

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

    $('rtcount').textContent = state.routes.length ? '· ' + state.routes.length : '';
  }

  /* ── sheet + fit ────────────────────────────────────────────────────── */

  const sheet = $('sheet');
  const sheetHead = $('sheethead');   // command centre only; the participant page uses tabs
  if (sheetHead) {
    sheetHead.addEventListener('click', () => {
      const open = sheet.classList.toggle('open');
      sheetHead.setAttribute('aria-expanded', String(open));
      // The map's usable height changed with the sheet.
      setTimeout(() => map.invalidateSize({ pan: false }), 210);
    });
  }

  function fitAll(extra = []) {
    const coords = state.points.map((p) => [p.lat, p.lng]).concat(extra);
    if (!coords.length) {
      map.setView([DEFAULT_POINTS[0].lat, DEFAULT_POINTS[0].lng], 13);
      return;
    }
    const bounds = L.latLngBounds(coords);
    if (myPos) bounds.extend(myPos);
    map.fitBounds(bounds.pad(0.15), { maxZoom: 16 });
  }
  $('btnFit').addEventListener('click', () => fitAll(hooks.fitExtra ? hooks.fitExtra() : []));

  /* ── peta offline ───────────────────────────────────────────────────── */

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

  /**
   * The whole program's ground: the server's padded box around every point
   * and route (so a participant gets the area before later checkpoints are
   * revealed), or, failing that, a box around the points this phone holds.
   */
  function programBounds() {
    const a = state.area;
    if (a && Number.isFinite(a.south)) return L.latLngBounds([a.south, a.west], [a.north, a.east]);
    if (!state.points.length) return null;
    return L.latLngBounds(state.points.map((p) => [p.lat, p.lng])).pad(0.25);
  }

  const OFFLINE_ZMIN = 11;          // an overview of the district
  const OFFLINE_TILE_BUDGET = 3500; // ≈ 70 MB; the deepest zoom is chosen to fit this

  btnCache.addEventListener('click', async () => {
    if (!('caches' in window)) {
      notify({ title: 'Tidak disokong', body: 'Pelayar ini tidak menyokong storan peta offline.' });
      return;
    }
    const bounds = programBounds();
    if (!bounds) {
      notify({ title: 'Tiada kawasan', body: 'Peta program belum dimuat turun. Cuba bila ada isyarat.' });
      return;
    }
    // Always the program area, never whatever happens to be on screen, and
    // as deep as the tile budget allows — trail detail matters more than reach.
    const sources = activeSources();
    const zMin = OFFLINE_ZMIN;
    const zMax = deepestZoom(bounds, zMin, sources, OFFLINE_TILE_BUDGET);
    const urls = planTiles(bounds, zMin, zMax, sources);

    if (!urls.length) {
      notify({ title: 'Tiada tile', body: 'Tiada apa untuk disimpan bagi kawasan ini.' });
      return;
    }
    const ok = await askConfirm({
      title: 'Simpan peta kawasan program?',
      body: `Seluruh kawasan checkpoint dan laluan, zum ${zMin}–${zMax} (paling dalam yang muat), lapisan ${LAYERS[currentBase].label}${sources.length > 1 ? ' + kontur' : ''} — ${urls.length} tile, lebih kurang ${approxSize(urls.length)}. Perlukan talian sekarang.`,
      okLabel: 'Simpan'
    });
    if (!ok) return;
    map.fitBounds(bounds, { padding: [10, 10] });

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

  /* ── online / offline ───────────────────────────────────────────────── */

  function netUI() {
    const off = !navigator.onLine;
    $('netdot').classList.toggle('off', off);
    $('netlabel').textContent = off ? 'Offline' : 'Online';
  }
  window.addEventListener('online', netUI);
  window.addEventListener('offline', netUI);
  netUI();

  /* ── service worker ─────────────────────────────────────────────────── */

  if ('serviceWorker' in navigator) {
    // A home-screen app has no reload button: when a new version takes over,
    // reload once so the phone runs it. Everything that matters is in
    // localStorage, so nothing is lost. (Not on the very first install, when
    // there was no previous version and a dialog may be open.)
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      toast('Versi baharu dipasang — memuat semula…', 2000);
      setTimeout(() => window.location.reload(), 600);
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((registration) => {
        registration.update();
        // Look again whenever the app comes back to the front, and hourly.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') registration.update().catch(() => {});
        });
        setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
      }).catch(() => { /* offline storage simply stays unavailable */ });
    });
  }

  /* ── state in / out ─────────────────────────────────────────────────── */

  function rerender() {
    rebuildMarkers();
    rebuildRoutes();
    updateStrip();
  }

  /** Something local edited the state: persist and tell the role module. */
  function changed() {
    saveState(state);
    if (hooks.change) hooks.change(state);
  }

  /** The server has a newer state: adopt it and redraw. */
  function applyState(next) {
    state.version = Number(next.version) || 0;
    state.points = Array.isArray(next.points) ? next.points : state.points;
    state.routes = Array.isArray(next.routes) ? next.routes : state.routes;
    state.groups = Array.isArray(next.groups) ? next.groups : state.groups;
    state.settings = next.settings && typeof next.settings === 'object' ? next.settings : state.settings;
    state.progress = next.progress && typeof next.progress === 'object' ? next.progress : null;
    if ('area' in next) state.area = next.area && typeof next.area === 'object' ? next.area : null;
    if ('locked' in next) state.locked = Array.isArray(next.locked) ? next.locked : [];
    if (!findPoint(targetId)) {
      const start = startPoint();
      targetId = start ? start.id : '';
      saveTarget(targetId);
    }
    saveState(state);
    rerender();
  }

  /* ── init ───────────────────────────────────────────────────────────── */

  rerender();
  fitAll();
  refreshOfflineStatus();
  setInterval(updateStrip, 3000);

  return {
    L, map, state, hooks, markers, routeLayers,
    editable,
    getTarget: () => targetId,
    setTarget,
    myPos: () => myPos,
    setMyPos,
    changed,
    applyState,
    setScheduleStart: (ms) => { scheduleStart = Number.isFinite(ms) ? ms : null; renderPointList(); },
    rerender,
    rebuildMarkers,
    rebuildRoutes,
    renderPointList,
    renderRouteList,
    updateStrip,
    fitAll
  };
}
