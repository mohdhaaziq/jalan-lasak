/* Jalan Lasak — the map screen both roles share.

   boot() builds the map, layers, markers, routes, compass strip, lists and
   offline tools, and returns a handle the role modules (peserta.js,
   pusat.js) drive. Editing tools live in edit.js and mount onto that handle
   only for the command centre. */

import { distM, bearing, fmtDist, pathKm } from './geo.js';

/** Compass point in Malay for a bearing: 351° → "Barat Laut". */
export function cardinal(deg) {
  const names = ['Utara', 'Timur Laut', 'Timur', 'Tenggara', 'Selatan', 'Barat Daya', 'Barat', 'Barat Laut'];
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
import { DEFAULT_POINTS, loadState, saveState, loadTarget, saveTarget, loadPrefs, savePrefs } from './store.js';
import { notify, toast, askConfirm } from './ui.js';
import { cachedTileCount, clearTiles, approxSize } from './offline.js';
import { createAutoCache, autoStatusText } from './autocache.js';
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
    maxZoom: 18,   // Esri has no imagery past 18 over rural Malaysia; the map locks at the layer's cap
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

/**
 * Keep an open popup out from under the app's own chrome. Leaflet pans a popup
 * into the map element, but the alert bar, banners and the target card float
 * over that element, so a popup near an edge can open behind them.
 */
export function keepPopupClear(map) {
  const overlaysTop = ['ccalert', 'sosbanner', 'addbanner', 'drawbar', 'selchip'];
  const overlaysBottom = ['strip', 'mcard'];
  const visible = (id) => {
    const node = document.getElementById(id);
    if (!node || node.hidden || node.offsetParent === null) return null;
    const box = node.getBoundingClientRect();
    return box.height ? box : null;
  };
  map.on('popupopen', (event) => {
    const node = event.popup.getElement();
    if (!node) return;
    setTimeout(() => {
      const box = node.getBoundingClientRect();
      const area = map.getContainer().getBoundingClientRect();
      let top = area.top;
      let bottom = area.bottom;
      for (const id of overlaysTop) {
        const o = visible(id);
        if (o && o.bottom > top && o.top < bottom) top = Math.max(top, o.bottom);
      }
      for (const id of overlaysBottom) {
        const o = visible(id);
        if (o && o.top < bottom && o.bottom > top) bottom = Math.min(bottom, o.top);
      }
      const pad = 8;
      let dy = 0;
      if (box.top < top + pad) dy = box.top - (top + pad);
      else if (box.bottom > bottom - pad) dy = Math.min(box.bottom - (bottom - pad), box.top - (top + pad));
      if (Math.abs(dy) > 1) map.panBy([0, dy], { animate: true });
    }, 30);
  });
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
  // The locate button: 'off' (no live GPS), 'follow' (map keeps me centred) or
  // 'free' (GPS on, dot shown, map left alone). Following never locks the map:
  // any pan, zoom or selection drops it to 'free'.
  let locState = 'off';
  let gpsWatch = null;
  let deviceHeading = null;   // where the phone points, from its compass (degrees clockwise from north)
  let gpsCourse = null;       // where the phone is moving, from GPS, when walking fast enough

  const markers = {};
  const routeLayers = {};
  const hooks = { change: null, rename: null, remove: null, eta: null, coords: null, mapClick: null, mapHold: null };
  let scheduleStart = null;   // this group's start time, for showing ETAs as clock times

  const findPoint = (id) => state.points.find((p) => p.id === id);
  const startPoint = () => state.points.find(isStart);

  /* ── map ────────────────────────────────────────────────────────────── */

  const map = L.map('map', { zoomControl: false, attributionControl: true });
  // Drop Leaflet's own prefix — on a phone the credits must fit one line, and
  // the tile sources' attribution is the part that has to stay.
  map.attributionControl.setPrefix(false);
  L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 120 }).addTo(map);

  keepPopupClear(map);
  // Banners above the map change its height; Leaflet must be told, or tiles and
  // markers drift and an open popup is clipped.
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(map.getContainer());

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
    autoCache.kick();
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
    autoCache.kick();
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

  /**
   * The popup, grouped the way the actions differ: what this point is, the one
   * thing anyone does with it (aim the compass), the edits, and — kept apart
   * below a rule — the one action that cannot be undone.
   */
  function popupContent(point) {
    const wrap = el('div');
    wrap.append(el('div', 'pop-name', point.name), el('div', 'pop-co', coordText(point)));

    if (editable) {
      const bits = [];
      if (point.code) bits.push('Kod ' + point.code);
      if (!isStart(point)) bits.push(Number.isFinite(point.etaMin) ? 'Dijangka +' + point.etaMin + ' min' : 'Masa belum ditetapkan');
      if (bits.length) wrap.append(el('div', 'pop-meta', bits.join(' · ')));
    }

    const button = (label, cls, handler) => {
      const b = el('button', 'jl-btn sm ' + cls, label);
      b.type = 'button';
      b.addEventListener('click', handler);
      return b;
    };

    const primary = el('div', 'pop-actions');
    primary.append(button('Sasar kompas ke sini', 'acc', () => setTarget(point.id)));
    wrap.append(primary);

    if (editable) {
      const edits = el('div', 'pop-edit');
      edits.append(button('Nama', '', () => hooks.rename && hooks.rename(point.id)));
      edits.append(button('Koordinat', '', () => hooks.coords && hooks.coords(point.id)));
      if (!isStart(point)) edits.append(button('Masa', '', () => hooks.eta && hooks.eta(point.id)));
      wrap.append(edits);

      if (!isStart(point)) {
        const danger = el('div', 'pop-danger');
        danger.append(button('Padam checkpoint', 'danger', () => hooks.remove && hooks.remove(point.id)));
        wrap.append(danger);
      }
    }
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
      marker.bindPopup(() => popupContent(point), { maxWidth: 260, minWidth: 210 });
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

  $('strip').addEventListener('click', () => {
    releaseFollow();
    if (hooks.stripClick && hooks.stripClick()) return;
    const target = findPoint(targetId);
    if (!target) return;
    if (myPos) map.fitBounds(L.latLngBounds([myPos, target]).pad(0.35), { maxZoom: 16 });
    else map.setView([target.lat, target.lng], Math.max(map.getZoom(), 15));
    if (markers[target.id]) markers[target.id].openPopup();
  });

  function updateStrip() {
    // A role may show something else in the card (the command centre: the selected group).
    if (hooks.strip && hooks.strip()) return;
    const target = findPoint(targetId);
    const nameEl = $('tgtname');
    const distEl = $('tgtdist');
    const brgEl = $('tgtbrg');

    const cardEl = $('tgtcard');
    if (!target) {
      nameEl.textContent = 'Tiada sasaran';
      distEl.textContent = '— km';
      brgEl.textContent = '—°';
      if (cardEl) cardEl.textContent = '';
      aimArrow(NaN);
      return;
    }
    nameEl.textContent = target.name;

    const origin = myPos || startPoint();
    if (!origin || origin === target) {
      distEl.textContent = myPos ? 'Anda di sini' : '— km';
      brgEl.textContent = '—°';
      if (cardEl) cardEl.textContent = '';
      return;
    }
    // The number stays big; where it is measured from rides on the name line.
    if (!myPos) nameEl.textContent = target.name + ' · dari MULA';
    distEl.textContent = fmtDist(distM(origin, target));
    const brg = bearing(origin, target);
    brgEl.textContent = Math.round(brg) + '°';
    if (cardEl) cardEl.textContent = cardinal(brg);
    aimArrow(brg);
  }

  /**
   * Turn the card's arrow towards a bearing. With a compass the arrow is
   * relative to where the phone points, so it swings as the phone turns and
   * stands straight up when the phone faces the target; the tile then lights
   * up (and the phone ticks once) to say "that way". Without a compass the
   * arrow is simply the bearing on a north-up map.
   */
  let wasAimed = false;
  let shownAngle = 0;
  function aimArrow(brg) {
    const tile = document.querySelector('#strip .arrow');
    if (!Number.isFinite(brg)) {
      if (tile) tile.classList.remove('aimed', 'live');
      wasAimed = false;
      return;
    }
    const live = deviceHeading !== null;
    const relative = live ? brg - deviceHeading : brg;
    // Turn the short way round: 179° → −179° is a 2° nudge, not a full spin.
    shownAngle += ((relative - shownAngle) % 360 + 540) % 360 - 180;
    $('arrowsvg').style.transform = `rotate(${shownAngle}deg)`;
    const off = Math.abs(((relative % 360) + 540) % 360 - 180);   // 0° when dead ahead
    const aimed = live && off <= 12;
    if (tile) {
      tile.classList.toggle('live', live);
      tile.classList.toggle('aimed', aimed);
    }
    if (aimed && !wasAimed && navigator.vibrate) navigator.vibrate(25);
    wasAimed = aimed;
  }

  /* ── GPS ────────────────────────────────────────────────────────────── */

  const btnLocate = $('btnLocate');

  /**
   * The blue dot, with a beam showing which way the phone faces — the
   * compass when the phone has one, the direction of travel from GPS while
   * walking, nothing when neither is known. The map stays north-up, so the
   * beam's rotation is the heading itself.
   */
  const meIcon = L.divIcon({
    className: '',
    html: '<div class="jl-me"><div class="beam"></div><div class="dot"></div></div>',
    iconSize: [0, 0],
    iconAnchor: [0, 0]
  });

  function facing() {
    if (deviceHeading !== null) return deviceHeading;
    if (gpsCourse !== null) return gpsCourse;
    return null;
  }

  function updateBeam() {
    if (!myMarker) return;
    const root = myMarker.getElement();
    if (!root) return;
    const beam = root.querySelector('.beam');
    const heading = facing();
    if (heading === null) {
      beam.style.display = 'none';
      return;
    }
    beam.style.display = '';
    beam.style.transform = `rotate(${Math.round(heading)}deg)`;
  }

  function setMyPos(latlng, accuracy) {
    myPos = { lat: latlng.lat, lng: latlng.lng };
    const acc = accuracy || 30;
    if (!myMarker) {
      myCircle = L.circle(myPos, {
        radius: acc, color: '#2a78d6', weight: 1,
        fillColor: '#2a78d6', fillOpacity: 0.12, interactive: false
      }).addTo(map);
      myMarker = L.marker(myPos, { icon: meIcon, interactive: false, zIndexOffset: 900, keyboard: false }).addTo(map);
    } else {
      myMarker.setLatLng(myPos);
      myCircle.setLatLng(myPos).setRadius(acc);
    }
    updateBeam();
    if (locState === 'follow') {
      if (firstFollowFix) {
        firstFollowFix = false;
        centreOnMe(Math.max(map.getZoom(), 15));
      } else {
        map.panTo(centreFor(myPos, map.getZoom()));
      }
    }
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
      const c = position.coords;
      // A GPS course is only meaningful while moving; below walking pace it is noise.
      gpsCourse = Number.isFinite(c.heading) && Number.isFinite(c.speed) && c.speed >= 0.5 ? c.heading : gpsCourse;
      setMyPos({ lat: c.latitude, lng: c.longitude }, c.accuracy);
    }, (error) => {
      // Only a refusal ends it. A timeout or "unavailable" under trees is normal; the watch keeps trying.
      if (error.code === 1) {
        notify({ title: 'Lokasi tidak dibenarkan', body: 'Benarkan akses lokasi untuk pelayar ini dalam tetapan telefon, kemudian tekan butang lokasi sekali lagi.' });
        setLocState('off');
      } else if (!myPos) {
        toast('Masih mencari isyarat GPS…');
      }
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    return true;
  }

  let firstFollowFix = false;

  /** The map centre that puts `latlng` in the middle of what is visible: the target card covers the map's foot. */
  function centreFor(latlng, zoom) {
    const strip = $('strip');
    const covered = strip ? strip.offsetHeight : 0;
    return map.unproject(map.project(latlng, zoom).add([0, covered / 2]), zoom);
  }
  function centreOnMe(zoom) {
    map.invalidateSize({ pan: false });
    map.setView(centreFor(myPos, zoom), zoom);
  }

  function setLocState(next) {
    locState = next;
    btnLocate.classList.remove('on');
    btnLocate.classList.toggle('follow', next === 'follow');
    btnLocate.classList.toggle('free', next === 'free');
    btnLocate.setAttribute('aria-pressed', String(next !== 'off'));
    btnLocate.title = next === 'follow' ? 'Mengikut lokasi saya — ketik untuk matikan'
      : next === 'free' ? 'Lokasi hidup — ketik untuk kembali ke lokasi saya' : 'Lokasi saya';
    if (next === 'off' && gpsWatch !== null) {
      navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = null;
      // Where nothing else supplies a position (the command centre), the dot goes too.
      if (editable) {
        if (myMarker) { map.removeLayer(myMarker); myMarker = null; }
        if (myCircle) { map.removeLayer(myCircle); myCircle = null; }
        myPos = null;
        renderPointList();
        updateStrip();
      }
    }
  }

  /** The user looked elsewhere: keep the dot, stop steering the map. */
  function releaseFollow() {
    if (locState === 'follow') setLocState('free');
  }

  btnLocate.addEventListener('click', () => {
    if (locState === 'follow') {            // already on me: this tap switches location off
      setLocState('off');
      return;
    }
    if (!startGPS()) return;
    setLocState('follow');                  // from 'off' or 'free': go to me, and follow until the user looks elsewhere
    if (myPos) centreOnMe(Math.max(map.getZoom(), 15));
    else {
      firstFollowFix = true;
      toast('Mencari isyarat GPS…');
    }
  });

  // Any hand on the map means "I am looking at something else now".
  map.on('dragstart', releaseFollow);
  map.getContainer().addEventListener('wheel', releaseFollow, { passive: true });
  map.getContainer().addEventListener('dblclick', releaseFollow);
  map.getContainer().addEventListener('touchstart', (event) => { if (event.touches.length > 1) releaseFollow(); }, { passive: true });

  /* ── device compass ─────────────────────────────────────────────────── */

  function onOrientation(event) {
    let heading = null;
    if (typeof event.webkitCompassHeading === 'number') heading = event.webkitCompassHeading;
    else if (event.absolute && typeof event.alpha === 'number') heading = 360 - event.alpha;
    if (heading !== null) {
      deviceHeading = heading;
      updateStrip();
      updateBeam();
    }
  }

  if (window.DeviceOrientationEvent) {
    // Listen from the start: without permission the events simply never come.
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      // iOS (and newer Chrome) only grant the sensor from inside a user gesture.
      const request = () => {
        document.body.removeEventListener('click', request);
        DeviceOrientationEvent.requestPermission().catch(() => { /* declined — the beam follows GPS travel instead */ });
      };
      document.body.addEventListener('click', request);
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
        releaseFollow();
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
        releaseFollow();
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
  $('btnFit').addEventListener('click', () => { releaseFollow(); fitAll(hooks.fitExtra ? hooks.fitExtra() : []); });

  /* ── peta offline: the program area saves itself ─────────────────── */

  const btnCache = $('btnCache');
  const btnCacheClear = $('btnCacheClear');
  const offStat = $('offstat');
  const offBar = $('offbar');
  const offBarFill = $('offbarfill');
  let autoStatus = { phase: 'waiting' };

  async function refreshOfflineStatus() {
    if (autoStatus.phase === 'running') return;
    const count = await cachedTileCount();
    if (autoStatus.phase === 'done') return;   // the auto-cache line says more
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

  // Downloads start on their own as soon as the area is known and there is a
  // line: nobody has to remember a button before walking out of signal. The
  // chosen base layer (and contour, if on) is what gets saved; switching
  // layers saves the new one too.
  let announced = false;
  const autoCache = createAutoCache({
    getBounds: programBounds,
    getSources: activeSources,
    onStatus: (status) => {
      autoStatus = status;
      const running = status.phase === 'running';
      offBar.classList.toggle('on', running);
      if (running && status.total) offBarFill.style.width = Math.round(status.done / status.total * 100) + '%';
      btnCache.disabled = running;
      btnCacheClear.disabled = running;
      offStat.textContent = autoStatusText(status);
      netUI();
      if (status.phase === 'done' && status.saved > 100 && !announced) {
        announced = true;
        toast('Peta kawasan program siap disimpan untuk offline.');
      }
      if (status.phase === 'done' || status.phase === 'failed') refreshOfflineStatus();
    }
  });

  btnCache.addEventListener('click', () => {
    if (!navigator.onLine) {
      notify({ title: 'Tiada talian', body: 'Muat turun akan bersambung sendiri bila ada isyarat.' });
      return;
    }
    const bounds = programBounds();
    if (bounds) map.fitBounds(bounds, { padding: [10, 10] });
    autoCache.kick(true);
  });

  btnCacheClear.addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Kosongkan peta offline?',
      body: 'Semua tile yang disimpan akan dibuang. Peta kawasan akan dimuat turun semula sendiri bila app dibuka lagi. Checkpoint dan laluan tidak terjejas.',
      okLabel: 'Kosongkan'
    });
    if (!ok) return;
    await clearTiles();
    autoStatus = { phase: 'waiting' };
    toast('Tile dikosongkan.');
    refreshOfflineStatus();
  });

  /* ── online / offline ───────────────────────────────────────────────── */

  function netUI() {
    const off = !navigator.onLine;
    $('netdot').classList.toggle('off', off);
    const loading = !off && autoStatus.phase === 'running' && autoStatus.total;
    $('netlabel').textContent = off ? 'Offline'
      : loading ? `Peta ${Math.round(autoStatus.done / autoStatus.total * 100)}%`
      : 'Online';
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
    autoCache.kick();
  }

  /* ── init ───────────────────────────────────────────────────────────── */

  rerender();
  fitAll();
  refreshOfflineStatus();
  autoCache.kick();
  setInterval(updateStrip, 3000);

  return {
    L, map, state, hooks, markers, routeLayers,
    editable,
    getTarget: () => targetId,
    setTarget,
    myPos: () => myPos,
    setMyPos,
    setCourse: (deg) => { gpsCourse = Number.isFinite(deg) ? deg : null; updateBeam(); },
    aimArrow,
    releaseFollow,
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
