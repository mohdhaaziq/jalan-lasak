/* Command-centre editing tools, mounted onto the core handle: add, rename and
   delete checkpoints, and draw suggested routes. Every mutation goes through
   core.changed(), which is what pusat.js listens to for pushing to the server. */

import { pathKm } from './geo.js';
import { askText, askChoice, askConfirm, notify, toast } from './ui.js';
import { $, isStart, routeLabel } from './core.js';

export function mountEditing(core) {
  const { L, map, state } = core;

  /* ── add / rename / delete checkpoints ──────────────────────────────── */

  const btnAdd = $('btnAdd');
  const addBanner = $('addbanner');
  let addMode = false;

  function setAddMode(on) {
    addMode = on;
    btnAdd.classList.toggle('on', on);
    btnAdd.setAttribute('aria-pressed', String(on));
    addBanner.style.display = on ? 'block' : 'none';
    if (on) setDrawMode(false);
  }

  btnAdd.addEventListener('click', () => setAddMode(!addMode));

  async function addPointAt(latlng) {
    const suggested = 'Checkpoint ' + (state.points.filter((p) => !isStart(p)).length + 1);
    const name = await askText({
      title: 'Checkpoint baharu',
      body: latlng.lat.toFixed(6) + ', ' + latlng.lng.toFixed(6),
      value: suggested,
      label: 'Nama checkpoint',
      okLabel: 'Tambah'
    });
    if (name === null) return;
    state.points.push({
      id: 'cp_' + Date.now(),
      type: 'cp',
      name: name || suggested,
      lat: latlng.lat,
      lng: latlng.lng
    });
    core.changed();
    core.rebuildMarkers();
    core.updateStrip();
    toast('Checkpoint ditambah.');
  }

  async function renamePoint(id) {
    const point = state.points.find((p) => p.id === id);
    if (!point) return;
    const name = await askText({ title: 'Namakan semula', value: point.name, label: 'Nama titik' });
    if (name === null || !name) return;
    point.name = name;
    core.changed();
    core.rebuildMarkers();
    core.updateStrip();
  }

  async function deletePoint(id) {
    const point = state.points.find((p) => p.id === id);
    if (!point) return;
    const ok = await askConfirm({ title: 'Padam checkpoint?', body: point.name, okLabel: 'Padam' });
    if (!ok) return;
    state.points = state.points.filter((p) => p.id !== id);
    if (core.getTarget() === id) {
      const start = state.points.find(isStart);
      core.setTarget(start ? start.id : '');
    }
    core.changed();
    core.rebuildMarkers();
    core.updateStrip();
  }

  async function setEta(id) {
    const point = state.points.find((p) => p.id === id);
    if (!point) return;
    const answer = await askText({
      title: 'Jangkaan tiba — ' + point.name,
      body: 'Minit selepas kumpulan bertolak dari MULA. Kosongkan untuk buang dari jadual.',
      value: Number.isFinite(point.etaMin) ? String(point.etaMin) : '',
      placeholder: 'cth. 90',
      label: 'Minit',
      inputMode: 'numeric'
    });
    if (answer === null) return;
    if (answer === '') {
      point.etaMin = null;
    } else {
      const minutes = parseInt(answer, 10);
      if (!Number.isFinite(minutes) || minutes < 0) {
        notify({ title: 'Nilai tidak sah', body: 'Masukkan bilangan minit, contohnya 90.' });
        return;
      }
      point.etaMin = minutes;
    }
    core.changed();
    core.rerender();
  }

  /* ── draw a suggested route ─────────────────────────────────────────── */

  const btnDraw = $('btnDraw');
  const drawbar = $('drawbar');
  let drawMode = false;
  let drawPts = [];
  let drawLine = null;
  let drawDots = [];
  let drawFrom = null;   // the point the route starts at; its first vertex

  const pointLabel = (p) => (isStart(p) ? 'MULA' : p.name);
  const pointChoices = (points, selectedId) =>
    points.map((p) => ({ value: p.id, label: pointLabel(p), selected: p.id === selectedId }));

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
    drawFrom = null;
  }

  /** Where the route begins: MULA or a checkpoint. The first vertex snaps there. */
  async function chooseStart() {
    if (!state.points.length) {
      notify({ title: 'Tiada titik', body: 'Tambah MULA atau checkpoint dahulu.' });
      return null;
    }
    // Suggest continuing from where the last route ended.
    const last = state.routes[state.routes.length - 1];
    const suggested = (last && last.to) || (state.points.find(isStart) || state.points[0]).id;
    const id = await askChoice({
      title: 'Laluan bermula dari mana?',
      body: 'Titik pertama laluan ditambat ke titik ini. Kemudian ketik peta untuk titik seterusnya, dan Siap untuk pilih checkpoint tamat.',
      options: pointChoices(state.points, suggested),
      cancelLabel: 'Batal'
    });
    return id ? state.points.find((p) => p.id === id) : null;
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

  btnDraw.addEventListener('click', async () => {
    if (drawMode) {
      setDrawMode(false);
      return;
    }
    const from = await chooseStart();
    if (!from) return;
    setDrawMode(true);
    drawFrom = from;
    drawAddVertex(L.latLng(from.lat, from.lng));
    $('drawhint').textContent = 'Dari ' + pointLabel(from) + ' · ketik peta utk titik laluan · Siap utk pilih tamat';
  });

  $('drawUndo').addEventListener('click', () => {
    if (drawPts.length <= 1) return;   // the start vertex stays
    drawPts.pop();
    const dot = drawDots.pop();
    if (dot) map.removeLayer(dot);
    drawRefresh();
  });

  $('drawCancel').addEventListener('click', () => setDrawMode(false));

  $('drawDone').addEventListener('click', async () => {
    const cps = state.points.filter((p) => !isStart(p) && p.id !== (drawFrom && drawFrom.id));
    if (!cps.length) {
      notify({ title: 'Tiada checkpoint tamat', body: 'Laluan mesti berakhir di checkpoint. Tambah checkpoint dahulu.' });
      return;
    }
    // Suggest the point after the start in sequence.
    const fromIndex = drawFrom ? state.points.findIndex((p) => p.id === drawFrom.id) : -1;
    const nextCp = state.points.slice(fromIndex + 1).find((p) => !isStart(p));
    const toId = await askChoice({
      title: 'Laluan tamat di checkpoint mana?',
      body: 'Titik terakhir laluan ditambat ke checkpoint ini. Peserta hanya menerima laluan ini bila checkpoint itu didedahkan kepadanya.',
      options: pointChoices(cps, nextCp ? nextCp.id : cps[0].id),
      cancelLabel: 'Batal'
    });
    if (!toId) return;
    const to = state.points.find((p) => p.id === toId);
    const latlngs = drawPts.map((p) => [p.lat, p.lng]);
    const lastPt = latlngs[latlngs.length - 1];
    if (!lastPt || lastPt[0] !== to.lat || lastPt[1] !== to.lng) latlngs.push([to.lat, to.lng]);
    if (latlngs.length < 2) {
      notify({ title: 'Laluan terlalu pendek', body: 'Perlu sekurang-kurangnya 2 titik.' });
      return;
    }
    const route = { id: 'rt_' + Date.now(), from: drawFrom ? drawFrom.id : null, to: to.id, latlngs };
    route.name = routeLabel(route, state.points);
    state.routes.push(route);
    core.changed();
    setDrawMode(false);
    core.rebuildRoutes();
    toast('Laluan disimpan: ' + route.name + ' · ± ' + pathKm(latlngs).toFixed(2) + ' km');
  });

  async function deleteRoute(id) {
    const route = state.routes.find((r) => r.id === id);
    if (!route) return;
    const ok = await askConfirm({ title: 'Padam laluan?', body: route.name, okLabel: 'Padam' });
    if (!ok) return;
    state.routes = state.routes.filter((r) => r.id !== id);
    core.changed();
    map.closePopup();
    core.rebuildRoutes();
  }

  /* ── wire into the core ─────────────────────────────────────────────── */

  core.hooks.rename = renamePoint;
  core.hooks.remove = deletePoint;
  core.hooks.eta = setEta;
  core.hooks.removeRoute = deleteRoute;
  core.hooks.mapClick = (latlng) => {
    if (drawMode) {
      drawAddVertex(latlng);
    } else if (addMode) {
      setAddMode(false);
      addPointAt(latlng);
    }
  };
  core.hooks.mapHold = (latlng) => { if (!drawMode) addPointAt(latlng); };

  // Popups and route rows are built lazily by the core, so they pick up the
  // hooks above; anything already on screen just needs one redraw.
  core.rerender();
}
