import { Graph, tileKeysForBounds, routeProgress, routeToGPX, formatDistance, haversine, googleMapsUrl } from './graph.js?v=25';
import { isNative, startNativeWatch, stopNativeWatch, ensureNotificationPermission, nativeNotify } from './native.js?v=25';
import { createCloud, validateTitle } from './cloud.js?v=25';
import { PROVINCES, lookupPlace, formatKm } from './place.js?v=25';
import { configured, firebaseConfig } from './firebase-config.js?v=25';
import { routeSteps, routeText, routeTitle, estimateMinutes, formatDuration, readRoutes, writeRoutes, makeSavedRoute, defaultRouteName } from './share.js?v=25';
import { stepsFor, kcalFor, formatSteps, waterAlong } from './stats.js?v=25';
import { CATS, CAT_KEYS, badgeHtml, svg as poiSvg, loadPrefs, savePrefs, fetchCat, describe as poiDescribe, countLabel } from './poi.js?v=25';
import { createTrip, tripUpdate, liveKmh, avgKmh, legDone, fmtKmh, fmtMoveTime } from './trip.js?v=25';
import { dutchVoices, bestVoice, speakText, say, loadClips } from './voice.js?v=25';

const L = window.L;
const $ = (id) => document.getElementById(id);
const cssVar = (n, fallback) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fallback;

// ------------------------------------------------------------------ toestand
const state = {
  net: 'w', // 'w' wandelen, 'f' fietsen
  started: false, // route is gestart (Start-knop): GPS volgt en meldt knooppunten
  waypoints: [], // knooppunt-sleutels
  wpMeta: new Map(), // sleutel -> {lat, lon, ref}  (om na herstart tegels te kunnen laden)
  route: null,
  peek: null, // knooppunt dat bekeken wordt zonder het toe te voegen
  navigating: false, // GPS aan en er is een route: toon navigatie in plaats van buurknooppunten
  gps: { on: false, watchId: null, pos: null, acc: null, follow: false, lastAlong: 0, announced: new Set(), lastNext: null, zoomOnFix: null, progress: null },
  trip: createTrip(),
  index: null,
};
const graph = new Graph();
const TILE_SIZE = 0.5;
const MIN_ZOOM_NODES = 11;

// ------------------------------------------------------------------ kaart
// Tijdens twee-vinger draaien/knijpen herberekent de draai-plugin het lijnenvlak verkeerd, waardoor routelijnen
// tijdelijk wegschuiven van de kaart. Tijdens het gebaar volgen we daarom alleen de kaartbeweging; na afloop wordt het vlak opnieuw opgebouwd.
const pluginRendererEvents = L.Renderer.prototype.getEvents;
L.Renderer.include({
  getEvents() {
    const ev = pluginRendererEvents.call(this);
    const onRotate = ev.rotate;
    if (onRotate) {
      ev.rotate = () => {
        const g = this._map && this._map.touchGestures;
        if (g && (g._rotating || g._zooming) && this._topLeft) {
          this._updateTransform(this._map.getCenter(), this._map.getZoom());
          return;
        }
        onRotate.call(this);
      };
    }
    return ev;
  },
});

const map = L.map('map', { rotate: true, touchRotate: true, rotateControl: false, bearing: 0, zoomControl: false, renderer: L.canvas({ padding: 0.5 }), center: [52.1, 5.3], zoom: 8, minZoom: 6, maxZoom: 18 });
L.control.zoom({ position: 'topleft' }).addTo(map);
window.knooppuntenMap = map; // voor tests en foutopsporing
window.knooppuntenState = state;

const PDOK_ATTR = 'Kaart: <a href="https://www.pdok.nl">PDOK/Kadaster</a>';
const pdokUrl = (style) => `https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/${style}/EPSG:3857/{z}/{x}/{y}.png`;
const pastel = L.tileLayer(pdokUrl('pastel'), { maxZoom: 19, attribution: PDOK_ATTR });
const pdok = L.tileLayer(pdokUrl('standaard'), { maxZoom: 19, attribution: PDOK_ATTR });
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap-bijdragers',
});
pastel.addTo(map);
L.control.layers({ 'Pastel (rustig)': pastel, 'Standaard': pdok, OpenStreetMap: osm }, null, { position: 'topleft', collapsed: true }).addTo(map);
let tileErrors = 0;
pastel.on('tileload', () => (tileErrors = -1000)); // de pastellaag werkt: geen terugval nodig
pastel.on('tileerror', () => {
  if (++tileErrors === 4 && map.hasLayer(pastel)) {
    // pastellaag niet beschikbaar: terug naar de standaardlaag
    map.removeLayer(pastel);
    pdok.addTo(map);
  }
});
pdok.on('tileerror', () => {
  if (++tileErrors === 4 && map.hasLayer(pdok)) {
    toast('Kaartachtergrond laadt niet. Probeer de OpenStreetMap-laag (knop linksboven).');
  }
});

// Buiten Nederland heeft PDOK geen kaart: schakel dan vanzelf over op OpenStreetMap (en terug).
// Grove omtrek van Nederland inclusief de Noordzee (lat, lon); nauwkeurig genoeg om de kaartlaag te kiezen.
const NL_OUTLINE = [
  [55.0, 2.0], [55.0, 7.2], [53.33, 7.2], [53.2, 7.1], [52.9, 7.07], [52.6, 7.06], [52.45, 7.07], [52.22, 7.04],
  [51.97, 6.86], [51.9, 6.68], [51.85, 6.4], [51.87, 6.1], [51.78, 6.0], [51.6, 6.1], [51.4, 6.2], [51.2, 6.15], [50.95, 6.03], [50.76, 6.02], [50.75, 5.9],
  [50.85, 5.68], [51.0, 5.75], [51.25, 5.7], [51.31, 5.12], [51.4, 5.05], [51.43, 4.78], [51.47, 4.45], [51.37, 4.22], [51.25, 3.85],
  [51.27, 3.58], [51.37, 3.36], [51.37, 2.0],
];
function inNL(lat, lon) {
  let inside = false;
  for (let i = 0, j = NL_OUTLINE.length - 1; i < NL_OUTLINE.length; j = i++) {
    const [yi, xi] = NL_OUTLINE[i];
    const [yj, xj] = NL_OUTLINE[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
let baseManual = false; // zodra jij zelf een kaartlaag kiest, schakelen we niet meer automatisch
let baseSwitching = false;
let lastNlBase = pastel;
map.on('baselayerchange', () => {
  if (!baseSwitching) baseManual = true;
});
function autoBaseLayer() {
  if (baseManual) return;
  const c = map.getCenter();
  const nl = inNL(c.lat, c.lng);
  const onNl = map.hasLayer(pastel) || map.hasLayer(pdok);
  baseSwitching = true;
  try {
    if (!nl && onNl) {
      lastNlBase = map.hasLayer(pdok) ? pdok : pastel;
      map.removeLayer(pastel);
      map.removeLayer(pdok);
      osm.addTo(map);
      toast('Buiten Nederland: kaart van OpenStreetMap', 2500);
    } else if (nl && map.hasLayer(osm)) {
      map.removeLayer(osm);
      lastNlBase.addTo(map);
    }
  } finally {
    baseSwitching = false;
  }
}
map.on('moveend', autoBaseLayer);
window.knooppuntenInNL = inNL; // voor tests
window.knooppuntenBaseManual = () => baseManual;

const edgeLayer = L.layerGroup().addTo(map);
const nodeLayer = L.layerGroup().addTo(map);
const focusLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const gpsLayer = L.layerGroup().addTo(map);

// ------------------------------------------------------------------ meldingen
let toastTimer;
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// Info-kaartje (knooppunt bereikt, aangetikt punt) met een balkje dat laat zien wanneer het vanzelf verdwijnt
const CARD_MS = 4000;
let cardTimer;
function showCard({ title, sub = '', stats = '' }, ms = CARD_MS) {
  const c = $('nodecard');
  $('nc-title').textContent = title;
  $('nc-sub').textContent = sub;
  $('nc-sub').hidden = !sub;
  $('nc-stats').textContent = stats;
  $('nc-stats').hidden = !stats;
  $('toast').hidden = true;
  const bar = $('nc-bar');
  bar.style.animation = 'none';
  c.hidden = false;
  void bar.offsetWidth; // animatie opnieuw laten beginnen
  bar.style.animation = `ncbar ${ms}ms linear forwards`;
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => (c.hidden = true), ms);
}
$('nodecard').onclick = () => {
  clearTimeout(cardTimer);
  $('nodecard').hidden = true;
};

// Info bij het aantikken van een punt tijdens het lopen of fietsen
function infoNode(key, ref, lat, lon) {
  const parts = [];
  const pos = state.gps.pos;
  if (pos) parts.push(`${formatDistance(haversine(pos, [lat, lon]))} van je vandaan`);
  const na = state.route?.nodeAt;
  const along = state.gps.progress?.along;
  const i = na ? na.findIndex((n) => n.key === key) : -1;
  if (i >= 0 && along != null && na[i].cum > along) parts.push(`${formatDistance(na[i].cum - along)} over de route`);
  else if (i >= 0) parts.push('al gepasseerd');
  showCard({ title: `Knooppunt ${ref}`, sub: parts.join(' · ') });
}

// ------------------------------------------------------------------ data laden
const tilePromises = new Map();
// Laadindicator (ring linksonder): telt lopende downloads van tegels en punten.
let busyCount = 0;
function busy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const el = document.getElementById('busy');
  if (el) el.hidden = busyCount === 0;
}
async function loadTile(key) {
  if (!state.index || !state.index.tiles[key]) return;
  if (!tilePromises.has(key)) {
    busy(true);
    tilePromises.set(
      key,
      fetch(`data/t_${key}.json`)
        .then((r) => {
          if (!r.ok) throw new Error(`tegel ${key}: ${r.status}`);
          return r.json();
        })
        .then((t) => graph.addTile(key, t))
        .catch((e) => {
          tilePromises.delete(key);
          console.warn(e);
          toast('Kaartdata laden mislukt. Ben je offline en is dit gebied nog niet opgeslagen?');
        })
        .finally(() => busy(false)),
    );
  }
  return tilePromises.get(key);
}

async function loadBounds(b, pad = 0.05) {
  const keys = tileKeysForBounds(b.getSouth() - pad, b.getWest() - pad, b.getNorth() + pad, b.getEast() + pad, TILE_SIZE);
  await Promise.all(keys.map(loadTile));
}

function updateDataInfo() {
  if (!state.index) return;
  const total = Object.keys(state.index.tiles).length;
  $('data-info').textContent = `Data van ${state.index.built} · ${graph.loadedTiles.size}/${total} tegels geladen`;
}

// ------------------------------------------------------------------ tekenen
let drawSeq = 0;
async function redraw() {
  const seq = ++drawSeq;
  const z = map.getZoom();
  if (!state.index || z < MIN_ZOOM_NODES) {
    nodeLayer.clearLayers();
    edgeLayer.clearLayers();
    if (state.index && z < MIN_ZOOM_NODES) $('data-info').textContent = 'Zoom verder in om knooppunten te zien';
    return;
  }
  await loadBounds(map.getBounds());
  if (seq !== drawSeq) return;
  updateDataInfo();

  const b = map.getBounds().pad(0.15);
  nodeLayer.clearLayers();
  edgeLayer.clearLayers();

  // verbindingen (dun) vanaf zoom 12
  if (z >= 12) {
    for (const e of graph.edges.values()) {
      if (e.net !== state.net) continue;
      const g0 = e.geom[0];
      const g1 = e.geom[e.geom.length - 1];
      if (!b.contains(g0) && !b.contains(g1)) continue;
      L.polyline(e.geom, { color: state.net === 'w' ? '#2e7d32' : '#c62828', weight: 2, opacity: 0.55, interactive: false }).addTo(edgeLayer);
    }
  }

  const visible = [];
  for (const n of graph.nodes.values()) {
    if (n.net === state.net && b.contains([n.lat, n.lon])) visible.push(n);
  }
  const labels = z >= 13 && visible.length <= 700;
  for (const n of visible) {
    if (state.wpMeta.has(n.key) && state.waypoints.includes(n.key)) continue; // waypoints worden apart getekend
    let m;
    if (labels) {
      m = L.marker([n.lat, n.lon], {
        icon: L.divIcon({ className: '', html: `<div class="nodepin ${n.net}">${n.ref}</div>`, iconSize: [30, 22], iconAnchor: [15, 11] }),
        keyboard: false,
      });
    } else {
      m = L.circleMarker([n.lat, n.lon], { radius: 6, weight: 2, color: '#fff', fillColor: n.net === 'w' ? '#2e7d32' : '#c62828', fillOpacity: 1 });
    }
    m.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (state.started) return infoNode(n.key, n.ref, n.lat, n.lon); // onderweg: info in plaats van de route aanpassen
      addWaypoint(n.key);
    });
    m.on('contextmenu', (ev) => {
      L.DomEvent.stop(ev); // lang indrukken: alleen bekijken waar je heen kunt
      setPeek(n.key);
    });
    m.addTo(nodeLayer);
  }
}

function drawRoute() {
  routeLayer.clearLayers();
  state.waypoints.forEach((k, i) => {
    const n = graph.nodes.get(k) || state.wpMeta.get(k);
    if (!n) return;
    const m = L.marker([n.lat, n.lon], {
      icon: L.divIcon({ className: '', html: `<div class="wp">${n.ref}</div>`, iconSize: [34, 32], iconAnchor: [17, 16] }),
      zIndexOffset: 1000,
      title: `Stop ${i + 1}: knooppunt ${n.ref}`,
    });
    m.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (state.started) return infoNode(k, n.ref, n.lat, n.lon);
      const lastWp = state.waypoints[state.waypoints.length - 1];
      if (i === 0 && state.waypoints.length >= 2 && lastWp !== k) {
        addWaypoint(k); // het beginpunt aantikken sluit het rondje
        toast('Rondje gesloten: terug bij het beginpunt');
        return;
      }
      setPeek(k); // per ongeluk aantikken verwijdert niets; gebruik 'Terug' om de laatste stop te wissen
    });
    m.addTo(routeLayer);
  });
  if (state.route && !state.route.error) {
    L.polyline(state.route.coords, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
    L.polyline(state.route.coords, { color: cssVar('--route', '#e65100'), weight: 5, opacity: 0.95, interactive: false }).addTo(routeLayer);
  }
}

// ------------------------------------------------------------------ route
let planSeq = 0;
async function recompute({ fit = false } = {}) {
  const seq = ++planSeq;
  state.route = null;
  state.gps.announced.clear();
  state.gps.lastNext = null;
  if (state.waypoints.length >= 2) {
    const pts = state.waypoints.map((k) => graph.nodes.get(k) || state.wpMeta.get(k)).filter(Boolean);
    const b = L.latLngBounds(pts.map((p) => [p.lat, p.lon])).pad(0.6);
    await loadBounds(b, 0.1);
    if (seq !== planSeq) return;
    const r = graph.planRoute(state.waypoints);
    if (r.error) {
      toast(r.error, 6000);
    } else {
      state.route = r;
      state.gps.lastAlong = 0;
    }
  }
  drawRoute();
  renderSummary();
  renderChoices();
  persist();
  if (fit && state.route) map.fitBounds(L.latLngBounds(state.route.coords), { padding: [60, 60], maxZoom: 16 });
  updateGpsPanel();
  redraw();
}

function addWaypoint(key) {
  const n = graph.nodes.get(key);
  if (!n) return;
  const last = state.waypoints[state.waypoints.length - 1];
  if (last === key) return;
  state.wpMeta.set(key, { lat: n.lat, lon: n.lon, ref: n.ref, net: n.net });
  state.waypoints.push(key);
  state.peek = null;
  recompute();
}

function removeWaypointAt(i) {
  state.waypoints.splice(i, 1);
  recompute();
}

function renderSummary() {
  const n = state.waypoints.length;
  const r = state.route;
  const seqEl = $('sum-seq');
  const title = $('sum-title');
  if (n === 0) {
    title.textContent = 'Tik knooppunten op de kaart om een route te maken';
    seqEl.textContent = 'Houd een knooppunt ingedrukt om te zien waar je vandaar heen kunt.';
    $('sum-len').textContent = '';
  } else if (!r) {
    title.textContent = n === 1 ? 'Kies nog een knooppunt' : 'Geen route gevonden';
    seqEl.textContent = state.waypoints.map((k) => (graph.nodes.get(k) || state.wpMeta.get(k)).ref).join(' → ');
    $('sum-len').textContent = '';
  } else {
    const steps = r.nodeAt.length - 1;
    title.textContent = `${steps} ${steps === 1 ? 'stap' : 'stappen'}`;
    seqEl.textContent = r.nodeAt.map((x) => x.ref).join(' → ');
    $('sum-len').textContent = formatDistance(r.length);
  }
  $('btn-undo').disabled = n === 0;
  $('btn-clear').disabled = n === 0;
  $('btn-share').disabled = !r;
  $('btn-save').disabled = !r;
  if (!r && state.started) stopRoute(); // route weg: niets meer om te volgen
  renderStats();
  renderStart();
  sizeSheet();
}

$('btn-undo').onclick = () => removeWaypointAt(state.waypoints.length - 1);
$('btn-clear').onclick = () => {
  state.waypoints = [];
  state.wpMeta.clear();
  recompute();
};
function gpxFile() {
  const gpx = routeToGPX(state.route, `Knooppuntroute ${state.route.nodeAt.map((n) => n.ref).join('-')}`);
  const d = new Date().toISOString().slice(0, 10);
  return { gpx, filename: `${d}-knooppuntroute.gpx` };
}

function downloadGpx() {
  const { gpx, filename } = gpxFile();
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

const shareDlg = $('share-dialog');
$('btn-share').onclick = () => {
  if (state.route) shareDlg.showModal();
};
$('share-close').onclick = () => shareDlg.close();

// GPX via het deelmenu van de telefoon (Komoot, Organic Maps, WhatsApp, Drive, ...); anders GPX opslaan
$('share-gpx').onclick = async () => {
  if (!state.route) return;
  shareDlg.close();
  const { gpx, filename } = gpxFile();
  const title = `Knooppuntroute ${state.route.nodeAt.map((n) => n.ref).join('-')}`;
  if (navigator.share && navigator.canShare) {
    for (const type of ['application/gpx+xml', 'text/xml', 'text/plain']) {
      const file = new File([gpx], filename, { type });
      if (!navigator.canShare({ files: [file] })) continue;
      try {
        await navigator.share({ files: [file], title, text: `${title} (${formatDistance(state.route.length)})` });
      } catch (e) {
        if (e && e.name === 'AbortError') return; // gebruiker sloot het deelmenu
        continue;
      }
      return;
    }
  }
  downloadGpx();
  toast('Delen wordt hier niet ondersteund: het GPX-bestand is opgeslagen. Open het vanuit Downloads in je route-app.', 7000);
};

$('share-gmaps').onclick = () => {
  if (!state.route) return;
  shareDlg.close();
  const { url, used, total } = googleMapsUrl(state.route, state.net === 'w' ? 'walking' : 'bicycling');
  if (used < total) toast(`Google Maps neemt maximaal 9 tussenstops: ${used} van de ${total} knooppunten doorgegeven.`, 6000);
  window.open(url, '_blank', 'noopener');
};

// ------------------------------------------------------------------ netwerk wisselen
function setNet(net) {
  if (state.net === net) return;
  state.net = net;
  state.peek = null;
  $('net-w').classList.toggle('on', net === 'w');
  $('net-f').classList.toggle('on', net === 'f');
  $('net-w').setAttribute('aria-selected', net === 'w');
  $('net-f').setAttribute('aria-selected', net === 'f');
  if (state.waypoints.length) {
    state.waypoints = [];
    state.wpMeta.clear();
    recompute();
  } else {
    redraw();
  }
  updateGpsPanel();
}
$('net-w').onclick = () => setNet('w');
$('net-f').onclick = () => setNet('f');

// ------------------------------------------------------------------ GPS
function startGps() {
  if (!isNative && !('geolocation' in navigator)) return toast('Deze browser ondersteunt geen locatie.');
  state.gps.on = true;
  state.gps.announced.clear();
  state.gps.lastNext = null;
  $('btn-gps').setAttribute('aria-pressed', 'true');
  $('btn-follow').hidden = false;
  if (isNative) {
    // Android-app: positie via een achtergronddienst, dus ook met uitgeschakeld scherm
    ensureNotificationPermission();
    startNativeWatch(onPos, onPosError).then((id) => {
      if (state.gps.on) state.gps.watchId = id;
      else stopNativeWatch(id); // intussen alweer uitgezet
    }).catch((e) => onPosError({ code: 2, native: e }));
  } else {
    state.gps.watchId = navigator.geolocation.watchPosition(onPos, onPosError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  requestWakeLock();
}
function stopGps() {
  state.gps.on = false;
  if (state.started) {
    state.started = false;
    renderStart();
    renderChoices();
  }
  if (state.gps.watchId != null) {
    if (isNative) stopNativeWatch(state.gps.watchId);
    else navigator.geolocation.clearWatch(state.gps.watchId);
  }
  state.gps.watchId = null;
  state.gps.pos = null;
  state.gps.follow = false;
  $('btn-gps').setAttribute('aria-pressed', 'false');
  $('btn-follow').hidden = true;
  $('btn-follow').setAttribute('aria-pressed', 'false');
  gpsLayer.clearLayers();
  releaseWakeLock();
  updateGpsPanel();
}
$('btn-gps').onclick = () => {
  ensureAudio(); // geluid mag pas na een tik van de gebruiker
  if (state.gps.on) stopGps();
  else startGps();
};
$('btn-follow').onclick = () => {
  state.gps.follow = !state.gps.follow;
  $('btn-follow').setAttribute('aria-pressed', state.gps.follow);
  if (state.gps.follow && state.gps.pos) map.setView(state.gps.pos, Math.max(map.getZoom(), 16));
};
map.on('dragstart', () => {
  if (state.gps.follow) {
    state.gps.follow = false;
    $('btn-follow').setAttribute('aria-pressed', 'false');
  }
});

// ------------------------------------------------------------------ start / stop
function renderStart() {
  const b = $('btn-start');
  b.hidden = !state.route;
  b.textContent = state.started ? 'Stop' : 'Start';
  b.classList.toggle('stop', state.started);
}
function startRoute() {
  if (!state.route) return;
  ensureAudio();
  state.started = true;
  state.peek = null;
  state.gps.announced.clear();
  state.gps.lastNext = null;
  state.gps.lastAlong = 0;
  if (!state.gps.on) startGps();
  state.gps.follow = true;
  $('btn-follow').setAttribute('aria-pressed', 'true');
  state.trip = createTrip();
  try { map.setBearing(0); } catch { /* geen draaiplugin: niet erg */ }
  const navZoom = state.net === 'f' ? 16 : 17; // inzoomen zoals bij een navigatie
  if (state.gps.pos) map.setView(state.gps.pos, navZoom);
  else state.gps.zoomOnFix = navZoom;
  $('sheet').classList.add('collapsed', 'navmode');
  $('grab').setAttribute('aria-expanded', 'false');
  const first = state.route.nodeAt[1] || state.route.nodeAt[0];
  notifyNode({ ref: first.ref, start: true });
  renderStart();
  renderChoices();
  updateGpsPanel();
}
function stopRoute() {
  if (!state.started) return;
  $('sheet').classList.remove('navmode');
  stopGps(); // zet ook state.started uit
  renderStart();
}
$('btn-start').onclick = () => (state.started ? stopRoute() : startRoute());

let meMarker, meCircle, firstFix = true;
function onPos(p) {
  const pos = [p.coords.latitude, p.coords.longitude];
  state.gps.pos = pos;
  state.gps.lastFixAt = Date.now();
  state.gps.acc = p.coords.accuracy;
  state.gps.speed = Number.isFinite(p.coords.speed) ? p.coords.speed : null; // m/s, als het toestel die geeft
  if (!meMarker) {
    meMarker = L.marker(pos, { icon: L.divIcon({ className: '', html: '<div class="me"><i></i></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 2000 });
    meCircle = L.circle(pos, { radius: p.coords.accuracy, weight: 1, color: '#1976d2', fillOpacity: 0.08, interactive: false });
    meCircle.addTo(gpsLayer);
    meMarker.addTo(gpsLayer);
  }
  if (!gpsLayer.hasLayer(meMarker)) {
    meCircle.addTo(gpsLayer);
    meMarker.addTo(gpsLayer);
  }
  meMarker.setLatLng(pos);
  meCircle.setLatLng(pos).setRadius(p.coords.accuracy);
  if (state.gps.zoomOnFix) {
    map.setView(pos, state.gps.zoomOnFix);
    state.gps.zoomOnFix = null;
    firstFix = false;
  } else if (firstFix) {
    firstFix = false;
    map.setView(pos, Math.max(map.getZoom(), 15));
  } else if (state.gps.follow) {
    map.panTo(pos, { animate: true });
  }
  updateGpsPanel();
}
function onPosError(err) {
  // tijdelijke haperingen (tunnel, bomen) niet melden zolang de laatste positie recent is
  if (err.code !== 1 && state.gps.pos && Date.now() - (state.gps.lastFixAt || 0) < 15000) return;
  const msg = { 1: isNative ? 'Locatietoegang geweigerd. Zet locatie (ook op de achtergrond) aan voor Knooppunten in de Android-instellingen.' : 'Locatietoegang geweigerd. Zet locatie aan voor deze site in je browserinstellingen.', 2: 'Locatie niet beschikbaar.', 3: 'Locatie duurt te lang.' }[err.code] || 'Locatiefout.';
  toast(msg, 6000);
  if (err.code === 1) stopGps();
}

function setNavigating(v) {
  if (state.navigating === v) return;
  state.navigating = v;
  renderChoices();
}

let nearbySeq = 0;
async function updateGpsPanel() {
  const pos = state.gps.pos;
  const nav = $('nav');
  const nearby = $('nearby');
  if (state.started && state.gps.on && !pos && state.route) {
    nav.hidden = false;
    nearby.hidden = true;
    setNavigating(true);
    $('nav-ref').textContent = '…';
    $('nav-dist').textContent = 'wachten op GPS';
    $('nav-rem').textContent = formatDistance(state.route.length);
    $('nav-warn').hidden = true;
    sizeSheet();
    return;
  }
  if (!state.gps.on || !pos) {
    nav.hidden = true;
    nearby.hidden = true;
    setNavigating(false);
    sizeSheet();
    return;
  }
  if (state.route) {
    nearbySeq++; // lopende "dichtstbijzijnde knooppunt"-zoekopdrachten ongeldig maken
    const p = routeProgress(state.route, pos, state.gps.lastAlong);
    if (p) {
      if (p.off < 60) state.gps.lastAlong = Math.max(state.gps.lastAlong, p.along);
      state.gps.progress = p;
      nav.hidden = false;
      nearby.hidden = true;
      setNavigating(true);
      $('nav-ref').textContent = p.arrived ? 'Aankomst' : p.next.ref;
      $('nav-dist').textContent = p.arrived ? '' : formatDistance(p.next.dist);
      $('nav-rem').textContent = formatDistance(p.remaining);
      const limit = Math.max(50, (state.gps.acc || 0) * 1.5);
      const warn = $('nav-warn');
      warn.hidden = p.off < limit;
      if (!warn.hidden) warn.textContent = `Je zit ongeveer ${formatDistance(p.off)} van de route af.`;
      if (p.off < limit && state.started) tripUpdate(state.trip, state.gps.lastFixAt || Date.now(), p.along);
      renderSpeed();
      if (p.off < limit) handleAnnouncements(p);
      sizeSheet();
      return;
    }
  }
  // geen route: toon het dichtstbijzijnde knooppunt
  nav.hidden = true;
  setNavigating(false);
  const seq = ++nearbySeq;
  await loadBounds(L.latLng(pos).toBounds(4000));
  if (seq !== nearbySeq || state.route) return;
  const [first] = graph.nearestNodes(pos, state.net, 1);
  nearby.hidden = !first;
  if (first) {
    $('nearby-ref').textContent = first.node.ref;
    $('nearby-dist').textContent = formatDistance(first.dist);
  }
  sizeSheet();
}

function renderSpeed() {
  const box = $('nav-speed-box');
  box.hidden = !state.started;
  if (!state.started) return;
  const g = state.gps.speed;
  const live = g != null && g >= 0.4 ? g * 3.6 : liveKmh(state.trip); // snelheid van het toestel, anders zelf berekend
  $('nav-speed').textContent = fmtKmh(live);
  const avg = avgKmh(state.trip);
  $('nav-avg').textContent = avg != null ? `Ø ${fmtKmh(avg)}` : '';
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* niet erg */ }
}
function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.gps.on) requestWakeLock();
});

// ------------------------------------------------------------------ paneel
function sizeSheet() {
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--sheet-h', `${$('sheet').offsetHeight}px`);
  });
}
$('grab').onclick = () => {
  const sh = $('sheet');
  if (state.started) {
    sh.classList.toggle('navmode'); // onderweg: compacte navigatie of het volledige paneel
    $('grab').setAttribute('aria-expanded', String(!sh.classList.contains('navmode')));
  } else {
    sh.classList.toggle('collapsed');
    $('grab').setAttribute('aria-expanded', String(!sh.classList.contains('collapsed')));
  }
  sizeSheet();
};
window.addEventListener('resize', sizeSheet);

// ------------------------------------------------------------------ buurknooppunten
let choicesSeq = 0;
function setPeek(key) {
  state.peek = key;
  renderChoices();
}
function pointAlong(geom, fraction) {
  let total = 0;
  const seg = [];
  for (let i = 0; i < geom.length - 1; i++) {
    const d = haversine(geom[i], geom[i + 1]);
    seg.push(d);
    total += d;
  }
  let target = total * fraction;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, target / seg[i]) : 0;
      return [geom[i][0] + t * (geom[i + 1][0] - geom[i][0]), geom[i][1] + t * (geom[i + 1][1] - geom[i][1])];
    }
    target -= seg[i];
  }
  return geom[0];
}

async function renderChoices() {
  const seq = ++choicesSeq;
  const box = $('choices');
  const last = state.waypoints[state.waypoints.length - 1] || null;
  const key = state.peek || last;
  const meta = key && (graph.nodes.get(key) || state.wpMeta.get(key));
  const closedLoop = !state.peek && state.waypoints.length > 2 && state.waypoints[0] === last;
  const navigating = !state.peek && state.navigating; // onderweg is de ruimte voor de navigatie
  if (!meta || closedLoop || navigating) {
    focusLayer.clearLayers();
    box.hidden = true;
    sizeSheet();
    return;
  }
  await loadBounds(L.latLng(meta.lat, meta.lon).toBounds(6000), 0.02);
  if (seq !== choicesSeq) return;
  focusLayer.clearLayers();

  const peeking = !!state.peek && state.peek !== last;
  const na = state.route?.nodeAt;
  const prev = !state.peek && na && na.length >= 2 ? na[na.length - 2].key : null; // de weg waar je vandaan komt
  const neigh = graph.neighbours(key);
  box.hidden = false;
  $('choices-label').textContent = peeking ? `Knooppunt ${meta.ref}: je kunt naar` : `Vanaf ${meta.ref} naar`;
  $('btn-peek-add').hidden = !peeking;
  const chips = $('chips');
  chips.replaceChildren();
  if (!neigh.length) {
    chips.textContent = 'Geen verbindingen gevonden in de kaartdata.';
  }
  const accent = cssVar('--accent', '#1b5e20');
  if (peeking) L.circleMarker([meta.lat, meta.lon], { radius: 17, weight: 4, color: accent, fillOpacity: 0, interactive: false }).addTo(focusLayer);
  for (const { node, edgeKey, len } of neigh) {
    const back = !peeking && node.key === prev;
    const b = document.createElement('button');
    b.className = 'chip' + (back ? ' back' : '');
    const big = document.createElement('b');
    big.textContent = node.ref;
    const small = document.createElement('small');
    small.textContent = (back ? 'terug · ' : '') + formatDistance(len);
    b.append(big, small);
    b.onclick = () => (peeking ? setPeek(node.key) : addWaypoint(node.key));
    chips.append(b);

    const e = graph.edges.get(edgeKey);
    if (e) {
      L.polyline(e.geom, { color: accent, weight: 5, opacity: 0.9, dashArray: '1 9', lineCap: 'round', interactive: false }).addTo(focusLayer);
      L.tooltip({ permanent: true, direction: 'center', className: 'dist-tip', interactive: false })
        .setLatLng(pointAlong(e.geom, 0.5))
        .setContent(`${node.ref} · ${formatDistance(len)}`)
        .addTo(focusLayer);
    }
  }
  if (peeking && !map.getBounds().contains([meta.lat, meta.lon])) map.panTo([meta.lat, meta.lon]);
  sizeSheet();
}
$('btn-peek-add').onclick = () => {
  if (state.peek) addWaypoint(state.peek);
};

// ------------------------------------------------------------------ rondje maken
const loopDlg = $('loop-dialog');
let loopStart = null;
let loopKmTouched = false;
$('loop-km').addEventListener('input', () => (loopKmTouched = true));
$('loop-close').onclick = () => loopDlg.close();
loopDlg.addEventListener('close', () => loopSeq++);

async function pickLoopStart() {
  $('loop-go').disabled = true;
  $('loop-start').textContent = 'Start zoeken…';
  let pos = null;
  let why = '';
  const first0 = state.waypoints[0];
  const startNode = first0 && (graph.nodes.get(first0) || state.wpMeta.get(first0));
  if (startNode && (startNode.net ?? state.net) === state.net) {
    pos = [startNode.lat, startNode.lon];
    why = 'het knooppunt waar je begon';
  } else if (state.gps.on && state.gps.pos) {
    pos = state.gps.pos;
    why = 'het dichtst bij je positie';
  } else {
    const c = map.getCenter();
    pos = [c.lat, c.lng];
    why = 'het dichtst bij het kaartmidden';
  }
  await loadBounds(L.latLng(pos).toBounds(6000), 0.02);
  const [first] = graph.nearestNodes(pos, state.net, 1, 5000);
  if (!first) {
    loopStart = null;
    $('loop-start').textContent = 'Geen knooppunt in de buurt. Sluit dit venster en verschuif de kaart naar een gebied met knooppunten.';
    return;
  }
  loopStart = first.node.key;
  $('loop-start').textContent = `Start: knooppunt ${first.node.ref} (${why})`;
  $('loop-go').disabled = false;
}

$('btn-loop').onclick = () => {
  if (!state.index) return toast('Nog geen kaartdata.');
  if (!loopKmTouched) $('loop-km').value = state.net === 'w' ? 8 : 30;
  $('loop-status').textContent = '';
  $('loop-results').replaceChildren();
  loopDlg.showModal();
  pickLoopStart().then(() => {
    if (loopStart && loopDlg.open) findLoops(LOOP_LADDER[state.net] || LOOP_LADDER.w);
  });
};

// Voorstellen van kort naar lang; de gebruiker hoeft zelf geen afstand te kiezen.
const LOOP_LADDER = { w: [3, 5, 8, 12, 16], f: [6, 10, 15, 22, 30, 40, 50] };
let loopSeq = 0; // een nieuwe zoekactie of het sluiten van het venster breekt een lopende af

function renderLoops(loops) {
  const list = $('loop-results');
  list.replaceChildren();
  for (const l of loops) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const big = document.createElement('b');
    big.textContent = formatDistance(l.length);
    const info = document.createElement('span');
    const dubbel = l.overlap < 0.03 ? 'geen dubbel stuk' : `${Math.round(l.overlap * 100)}% dubbel gelopen`;
    info.textContent = `${l.nodes.length - 1} knooppunten · ${dubbel} · richting het ${loopDirection(l)}`;
    b.append(big, info);
    b.onclick = () => applyLoop(l);
    li.append(b);
    list.append(li);
  }
}

async function findLoops(kms) {
  if (!loopStart) return;
  const seq = ++loopSeq;
  const s = graph.nodes.get(loopStart);
  const status = $('loop-status');
  $('loop-results').replaceChildren();
  $('loop-go').disabled = true;
  const shown = [];
  for (let i = 0; i < kms.length; i++) {
    status.textContent = kms.length > 1 ? `Rondjes zoeken… ${i + 1} van ${kms.length}` : 'Rondjes zoeken…';
    await loadBounds(L.latLng(s.lat, s.lon).toBounds(kms[i] * 1000 * 0.9), 0.02);
    if (seq !== loopSeq) return;
    let loops = [];
    try {
      loops = await graph.planLoop(loopStart, kms[i] * 1000, { count: kms.length > 1 ? 1 : 3 });
    } catch (e) {
      console.warn(e);
    }
    if (seq !== loopSeq) return;
    for (const l of loops) {
      const dup = shown.some((p) => p.nodes.join() === l.nodes.join() || Math.abs(p.length - l.length) / l.length < 0.06);
      if (!dup) shown.push(l);
    }
    shown.sort((x, y) => x.length - y.length);
    renderLoops(shown);
  }
  $('loop-go').disabled = false;
  status.textContent = shown.length
    ? 'Kies een rondje (kort naar lang), of vul een eigen afstand in:'
    : 'Geen goed rondje gevonden. Probeer een andere afstand of een ander startpunt.';
}

$('loop-go').onclick = () => {
  const km = Math.max(1, Math.min(120, Number($('loop-km').value) || 8));
  $('loop-km').value = km;
  findLoops([km]);
};

const COMPASS = ['noorden', 'noordoosten', 'oosten', 'zuidoosten', 'zuiden', 'zuidwesten', 'westen', 'noordwesten'];
function loopDirection(loop) {
  const s = graph.nodes.get(loop.nodes[0]);
  let la = 0;
  let lo = 0;
  const pts = loop.nodes.map((k) => graph.nodes.get(k));
  for (const n of pts) {
    la += n.lat;
    lo += n.lon;
  }
  const dy = la / pts.length - s.lat;
  const dx = (lo / pts.length - s.lon) * Math.cos((s.lat * Math.PI) / 180);
  const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8];
}

function applyLoop(loop) {
  state.waypoints = [...loop.nodes];
  state.wpMeta.clear();
  for (const k of loop.nodes) {
    const n = graph.nodes.get(k);
    state.wpMeta.set(k, { lat: n.lat, lon: n.lon, ref: n.ref, net: n.net });
  }
  state.peek = null;
  loopDlg.close();
  recompute({ fit: true });
}

// ------------------------------------------------------------------ meldingen bij knooppunten
const SETTINGS_KEY = 'knooppunten.settings.v1';
const settings = { vibrate: true, beep: true, speak: false, near: 50, voiceURI: '' };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch { /* standaardwaarden */ }
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

const notifyDlg = $('notify-dialog');
function renderNotify() {
  for (const b of document.querySelectorAll('#notify-dialog .opt')) {
    const k = b.dataset.opt;
    const on = k === 'silent' ? !settings.beep && !settings.speak : !!settings[k];
    b.setAttribute('aria-pressed', String(on));
  }
  $('set-near').value = settings.near;
  $('near-out').textContent = `${settings.near} m`;
}
function renderVoices() {
  const sel = $('set-voice');
  const voices = dutchVoices();
  sel.replaceChildren();
  const auto = document.createElement('option');
  const best = bestVoice(voices);
  auto.value = '';
  auto.textContent = best ? `Automatisch (${best.name})` : 'Automatisch';
  sel.append(auto);
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name}${v.localService ? '' : ' · online'}`;
    sel.append(o);
  }
  sel.value = voices.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
  $('voice-hint').textContent = !('speechSynthesis' in window)
    ? 'Deze browser kan niet spreken.'
    : !voices.length
      ? 'Geen Nederlandse stem gevonden. Voeg er een toe in Android: Instellingen › Systeem › Talen › Tekst-naar-spraak.'
      : voices.every((v) => v.localService)
        ? 'Klinkt de stem robotachtig? Kies hier een andere, of installeer een betere in Android: Instellingen › Tekst-naar-spraak.'
        : '';
}
if ('speechSynthesis' in window) speechSynthesis.addEventListener?.('voiceschanged', renderVoices);
loadClips();

$('btn-bell').onclick = () => {
  renderNotify();
  renderVoices();
  notifyDlg.showModal();
};
$('notify-close').onclick = () => notifyDlg.close();
for (const b of document.querySelectorAll('#notify-dialog .opt')) {
  b.onclick = () => {
    const k = b.dataset.opt;
    if (k === 'silent') {
      settings.beep = false;
      settings.speak = false;
    } else {
      settings[k] = !settings[k];
      if (settings[k] && k !== 'vibrate') ensureAudio();
      if (settings[k] && k === 'vibrate') navigator.vibrate?.(150);
    }
    saveSettings();
    renderNotify();
  };
}
$('set-near').oninput = () => {
  settings.near = Number($('set-near').value);
  $('near-out').textContent = `${settings.near} m`;
  saveSettings();
};
$('set-voice').onchange = () => {
  settings.voiceURI = $('set-voice').value;
  saveSettings();
  say({ ref: '47', after: '12' }, settings.voiceURI);
};

let audioCtx;
function ensureAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
  } catch { /* geen geluid mogelijk */ }
}
function beep() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [[0, 880], [0.2, 1175]].forEach(([off, freq]) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t + off);
    g.gain.exponentialRampToValueAtTime(0.35, t + off + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.16);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + off);
    o.stop(t + off + 0.18);
  });
}
function notifyNode(info) {
  const { ref, after, isLast, start } = info;
  const text = start ? `Route gestart: ga naar knooppunt ${ref}` : isLast ? `Eindpunt: knooppunt ${ref}` : `Knooppunt ${ref}${after ? ` · daarna ${after}` : ''}`;
  const card = start
    ? { title: `Route gestart`, sub: `Ga naar knooppunt ${ref}` }
    : { title: isLast ? `Eindpunt ${ref} bereikt` : `Knooppunt ${ref}`, sub: !isLast && after ? `Daarna ${after}` : '' };
  if (!start && state.started) {
    const t = legDone(state.trip);
    const bits = [];
    if (t.legKmh != null) bits.push(`Ø ${fmtKmh(t.legKmh)} dit stuk`);
    if (t.totKmh != null) bits.push(`${fmtKmh(t.totKmh)} totaal`);
    if (isLast && t.totMoveS > 0) bits.push(`${fmtMoveTime(t.totMoveS)} onderweg`);
    else if (info.remaining != null) bits.push(`nog ${formatDistance(info.remaining)}`);
    card.stats = bits.join(' · ');
  } else if (info.stats) card.stats = info.stats;
  showCard(card);
  if (isNative && document.visibilityState !== 'visible') nativeNotify('Knooppunten', text); // app op de achtergrond of scherm uit
  if (settings.vibrate) navigator.vibrate?.(start ? [200] : [250, 120, 250]);
  if (settings.beep) beep();
  if (settings.speak) setTimeout(() => say(info, settings.voiceURI), settings.beep ? 500 : 0);
}
$('btn-test-notify').onclick = () => {
  ensureAudio();
  notifyNode({ ref: '47', after: '12', isLast: false, stats: 'Ø 14,2 km/u dit stuk · 13,8 km/u totaal · nog 5,3 km' });
};

function handleAnnouncements(p) {
  const g = state.gps;
  const nodeAt = state.route.nodeAt;
  // een knooppunt dat we net voorbij zijn en nog niet gemeld hebben (bij schaarse GPS-punten)
  if (g.lastNext != null && p.next && p.next.index > g.lastNext && !g.announced.has(g.lastNext) && nodeAt[g.lastNext]) {
    g.announced.add(g.lastNext);
    const n = nodeAt[g.lastNext];
    notifyNode({ ref: n.ref, after: nodeAt[g.lastNext + 1]?.ref ?? null, isLast: g.lastNext === nodeAt.length - 1, remaining: p.remaining });
  }
  // het volgende knooppunt komt dichtbij
  const near = Math.min(120, Math.max(settings.near, (g.acc || 0) * 0.5));
  if (p.next && p.next.dist < near && !g.announced.has(p.next.index)) {
    g.announced.add(p.next.index);
    notifyNode({ ref: p.next.ref, after: p.next.after, isLast: p.next.isLast, remaining: p.remaining });
  }
  g.lastNext = p.next ? p.next.index : nodeAt.length;
}

// ------------------------------------------------------------------ stappen, calorieën, water
const poiPrefs = loadPrefs();
let waterPoints = []; // [[lat, lon, naam?]]
const waterLayer = L.layerGroup().addTo(map);
const DROP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z"/></svg>';

async function loadWater() {
  try {
    const r = await fetch('data/water.json');
    if (!r.ok) return;
    const d = await r.json();
    if (Array.isArray(d.points)) waterPoints = d.points;
  } catch { /* geen watertappunten beschikbaar: de app werkt gewoon */ }
  drawWater();
  renderStats();
}

function drawWater() {
  waterLayer.clearLayers();
  if (!poiPrefs.water || !waterPoints.length || map.getZoom() < 13) return;
  const b = map.getBounds().pad(0.15);
  let n = 0;
  for (const p of waterPoints) {
    if (!b.contains([p[0], p[1]])) continue;
    if (++n > 400) break;
    const m = L.marker([p[0], p[1]], { icon: L.divIcon({ className: '', html: `<div class="water">${DROP}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }), keyboard: false, title: p[2] || 'Drinkwaterpunt' });
    m.bindTooltip(p[2] ? `Drinkwater: ${p[2]}` : 'Drinkwaterpunt', { direction: 'top', offset: [0, -10] });
    m.on('click', () => {
      const pos = state.gps.pos;
      showCard({ title: p[2] ? `Drinkwater: ${p[2]}` : 'Drinkwaterpunt', sub: pos ? `${formatDistance(haversine(pos, [p[0], p[1]]))} van je vandaan` : '' });
    });
    m.addTo(waterLayer);
  }
}
map.on('moveend', drawWater);

// ------------------------------------------------------------------ punten onderweg (toilet, opladen, picknick, eten)
const poiData = {}; // categorie -> [[lat, lon, naam?, extra?]]
const poiLoading = {};
const poiLayer = L.layerGroup().addTo(map);
const MAX_POI = 250;

async function ensurePoi(cat) {
  if (poiData[cat] || poiLoading[cat]) return;
  busy(true);
  poiLoading[cat] = fetchCat(cat).then((pts) => {
    poiData[cat] = pts;
    drawPoi();
    renderStats();
  }).finally(() => busy(false));
}

function drawPoi() {
  poiLayer.clearLayers();
  const b = map.getBounds().pad(0.15);
  const z = map.getZoom();
  for (const cat of CAT_KEYS) {
    if (!poiPrefs[cat] || !poiData[cat] || z < CATS[cat].minZoom) continue;
    let n = 0;
    for (const p of poiData[cat]) {
      if (!b.contains([p[0], p[1]])) continue;
      if (++n > MAX_POI) break;
      const d = poiDescribe(cat, p);
      const m = L.marker([p[0], p[1]], { icon: L.divIcon({ className: '', html: badgeHtml(cat), iconSize: [26, 26], iconAnchor: [13, 13] }), keyboard: false, title: d.title });
      m.on('click', () => {
        const pos = state.gps.pos;
        const dist = pos ? `${formatDistance(haversine(pos, [p[0], p[1]]))} van je vandaan` : '';
        showCard({ title: d.title, sub: d.info, stats: dist });
      });
      m.addTo(poiLayer);
    }
  }
}
map.on('moveend', drawPoi);

function buildPoiTray() {
  const tray = $('poitray');
  const items = [['water', 'Drinkwater', `<div class="poi" style="--pc:#1e88e5">${poiSvg('<path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z"/>')}</div>`]];
  for (const k of CAT_KEYS) items.push([k, CATS[k].label, badgeHtml(k)]);
  tray.innerHTML = items.map(([k, label, badge]) => `<button type="button" data-cat="${k}" aria-pressed="${!!poiPrefs[k]}">${badge}<span>${label}</span></button>`).join('');
  tray.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      const k = btn.dataset.cat;
      poiPrefs[k] = !poiPrefs[k];
      btn.setAttribute('aria-pressed', String(poiPrefs[k]));
      savePrefs(poiPrefs);
      if (poiPrefs[k] && k !== 'water') ensurePoi(k);
      drawWater();
      drawPoi();
      renderStats();
    };
  });
}
buildPoiTray();
for (const k of CAT_KEYS) if (poiPrefs[k]) ensurePoi(k);
$('btn-poi').onclick = () => {
  const open = $('poitray').hidden;
  $('poitray').hidden = !open;
  $('btn-poi').setAttribute('aria-pressed', String(open));
  $('btn-poi').setAttribute('aria-expanded', String(open));
};
map.on('click', () => {
  if (!$('poitray').hidden) $('btn-poi').onclick();
});

function routeStats() {
  const r = state.route;
  if (!r) return { steps: null, kcal: 0, water: 0, minutes: 0 };
  return {
    steps: stepsFor(r.length, state.net),
    kcal: kcalFor(r.length, state.net),
    water: waterAlong(r.coords, waterPoints, 150).length,
    poi: Object.fromEntries(CAT_KEYS.filter((k) => poiData[k]).map((k) => [k, waterAlong(r.coords, poiData[k], k === 'cafe' ? 120 : 100).length])),
    minutes: estimateMinutes(r.length, state.net),
  };
}

function renderStats() {
  const box = $('stats');
  if (!state.route) {
    box.hidden = true;
    return;
  }
  const st = routeStats();
  box.hidden = false;
  $('st-steps').hidden = st.steps == null;
  if (st.steps != null) $('st-steps').querySelector('b').textContent = `${formatSteps(st.steps)} stappen`;
  $('st-kcal').querySelector('b').textContent = `${st.kcal} kcal`;
  $('st-time').querySelector('b').textContent = formatDuration(st.minutes);
  $('st-water').hidden = !waterPoints.length;
  if (waterPoints.length) $('st-water').querySelector('b').textContent = st.water ? `${st.water} water` : 'geen water';
  $('st-poi').innerHTML = CAT_KEYS.filter((k) => poiPrefs[k] && st.poi && st.poi[k] > 0)
    .map((k) => `<span class="stat" style="--pc:${CATS[k].color}" title="${CATS[k].label} langs de route">${poiSvg(CATS[k].icon, 'poi-ic')}<b>${st.poi[k]}</b></span>`).join('');
  sizeSheet();
}

// ------------------------------------------------------------------ stappen en kopiëren
function currentRouteText() {
  const st = routeStats();
  return routeText(state.route, state.net, { url: mapsUrl(), steps: st.steps, kcal: st.kcal, water: st.water });
}
function mapsUrl() {
  return googleMapsUrl(state.route, state.net === 'w' ? 'walking' : 'bicycling').url;
}
const stepsDlg = $('steps-dialog');
const openSteps = () => {
  if (!state.route) return;
  const steps = routeSteps(state.route);
  const list = $('steps-list');
  list.replaceChildren();
  steps.forEach((st, i) => {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = `${i + 1}.`;
    const t = document.createElement('span');
    t.className = 't';
    const a = document.createElement('b');
    a.textContent = st.from;
    const c = document.createElement('b');
    c.textContent = st.to;
    t.append(a, ' → ', c);
    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = formatDistance(st.len);
    li.append(n, t, d);
    list.append(li);
  });
  renderStepsSub();
  stepsDlg.showModal();
};
function renderStepsSub() {
  const r = state.route;
  if (!r) return;
  const n = r.nodeAt.length - 1;
  const st = routeStats();
  $('steps-sub').textContent = [`${n} ${n === 1 ? 'stap' : 'stappen'}`, formatDistance(r.length), `ongeveer ${formatDuration(st.minutes)}`, st.steps != null ? `${formatSteps(st.steps)} stappen` : null, `${st.kcal} kcal`].filter(Boolean).join(' · ');
}
$('steps-close').onclick = () => stepsDlg.close();
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* val terug op de oude methode */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
$('steps-copy').onclick = async () => {
  if (!state.route) return;
  const ok = await copyText(currentRouteText());
  stepsDlg.close();
  toast(ok ? 'Gekopieerd. Plak het in WhatsApp of Messenger.' : 'Kopiëren lukt hier niet. Gebruik "Deel tekst".', 5000);
};
async function shareRouteText() {
  if (!state.route) return;
  const text = currentRouteText();
  shareDlg.close();
  stepsDlg.close();
  if (navigator.share) {
    try {
      await navigator.share({ title: routeTitle(state.route, state.net), text });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const ok = await copyText(text);
  stepsDlg.close();
  shareDlg.close();
  toast(ok ? 'Delen kan hier niet; de tekst is gekopieerd.' : 'Delen en kopiëren lukken hier niet.', 5000);
}
$('steps-share').onclick = shareRouteText;
$('share-text').onclick = shareRouteText;

// ------------------------------------------------------------------ routes opslaan
const saveDlg = $('save-dialog');
$('btn-save').onclick = () => {
  if (!state.route) return;
  $('save-name').value = defaultRouteName(state.route, state.net);
  saveDlg.showModal();
  $('save-name').select();
};
$('save-cancel').onclick = () => saveDlg.close();
async function doSave() {
  if (!state.route) return;
  const waypoints = state.waypoints.map((k) => ({ key: k, ...(graph.nodes.get(k) || state.wpMeta.get(k)) }));
  const r = makeSavedRoute({ name: $('save-name').value, net: state.net, waypoints, length: state.route.length, steps: state.route.nodeAt.length - 1 });
  const ok = writeRoutes(localStorage, [r, ...readRoutes(localStorage)]);
  saveDlg.close();
  toast(ok ? `Opgeslagen als "${r.name}"` : 'Opslaan mislukt: de browser staat opslag niet toe.', 5000);
  // plaats en provincie van het startpunt erbij zetten (op de achtergrond; lukt dit niet, dan blijft het leeg)
  const start = waypoints[0];
  if (ok && start) {
    const loc = await lookupPlace(start.lat, start.lon);
    if (loc) writeRoutes(localStorage, readRoutes(localStorage).map((x) => (x.id === r.id ? { ...x, ...loc } : x)));
  }
}
$('save-ok').onclick = doSave;
$('save-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doSave();
  }
});

const routesDlg = $('routes-dialog');
function renderRoutes() {
  const list = readRoutes(localStorage);
  const ul = $('routes-list');
  ul.replaceChildren();
  $('routes-empty').hidden = list.length > 0;
  for (const r of list) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'open';
    const name = document.createElement('b');
    name.textContent = r.name;
    const info = document.createElement('span');
    info.textContent = `${[r.place, r.province].filter(Boolean).join(' · ') || (r.net === 'f' ? 'Fietsen' : 'Wandelen')} · ${formatDistance(r.length)}`;
    open.append(name, info);
    open.onclick = () => openSavedRoute(r);
    const del = document.createElement('button');
    del.className = 'del';
    del.setAttribute('aria-label', `Verwijder ${r.name}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14"/><path d="M10 7V5h4v2"/><path d="M7 7l1 12h8l1-12"/></svg>';
    let armed = null;
    del.onclick = () => {
      if (!armed) {
        del.textContent = 'Zeker?';
        del.style.fontSize = '12px';
        del.style.fontWeight = '700';
        armed = setTimeout(() => {
          armed = null;
          renderRoutes();
        }, 3000);
        return;
      }
      clearTimeout(armed);
      writeRoutes(localStorage, readRoutes(localStorage).filter((x) => x.id !== r.id));
      renderRoutes();
    };
    if (cloud.state().available) {
      const pub = document.createElement('button');
      pub.className = 'del';
      pub.setAttribute('aria-label', `Deel ${r.name} openbaar`);
      pub.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.7 2.6 2.7 15.4 0 18"/><path d="M12 3c-2.7 2.6-2.7 15.4 0 18"/></svg>';
      pub.onclick = () => startPublish(r);
      li.append(netIcon(r.net), open, pub, del);
    } else li.append(netIcon(r.net), open, del);
    ul.append(li);
  }
}
$('btn-routes').onclick = () => {
  renderRoutes();
  routesDlg.showModal();
};
$('routes-close').onclick = () => routesDlg.close();

async function openSavedRoute(r) {
  routesDlg.close();
  if (state.started) stopRoute();
  if (state.net !== r.net) setNet(r.net);
  state.waypoints = r.waypoints.map((w) => w.key);
  state.wpMeta.clear();
  for (const w of r.waypoints) state.wpMeta.set(w.key, { lat: w.lat, lon: w.lon, ref: w.ref, net: r.net });
  state.peek = null;
  await recompute({ fit: true });
  if (!state.route) toast('Deze route kon niet worden berekend. Is de kaartdata van dit gebied aanwezig?', 6000);
}


// ------------------------------------------------------------------ account en openbare routes
const cloud = createCloud(null);
let cloudApi = cloud;
async function initCloud() {
  if (!configured()) return;
  try {
    const { createFirebaseAdapter } = await import('./firebase-adapter.js?v=25');
    const adapter = await createFirebaseAdapter(firebaseConfig);
    cloudApi = createCloud(adapter, { onChange: renderCloud });
    Object.assign(cloud, cloudApi);
    cloud.state = cloudApi.state;
    renderCloud();
  } catch (e) {
    console.warn('Accounts niet beschikbaar:', e);
  }
}
const cloudDlg = $('cloud-dialog');
const publicDlg = $('public-dialog');
const publishDlg = $('publish-dialog');
const cloudErr = (e) => toast(e && e.message ? e.message : 'Dat lukte niet. Probeer het later opnieuw.', 5000);
function renderCloud() {
  const st = cloud.state();
  $('cloud-off').hidden = st.available;
  $('cloud-out').hidden = !st.available || !!st.user;
  $('cloud-in').hidden = !st.available || !st.user;
  $('cloud-nav').hidden = !st.available || !st.user;
  if (st.user && document.activeElement !== $('cloud-name')) $('cloud-name').value = st.user.name || '';
  $('btn-account').classList.toggle('on', !!st.user);
}
$('btn-account').onclick = () => {
  renderCloud();
  cloudDlg.showModal();
};
$('cloud-close').onclick = () => cloudDlg.close();
$('cloud-guest').onclick = () => {
  cloudDlg.close();
  publicDlg.showModal();
  renderPublic('votes');
};
$('cloud-login').onclick = () => cloud.signIn().catch(cloudErr);
$('cloud-logout').onclick = () => cloud.signOut().then(() => toast('Uitgelogd')).catch(cloudErr);
$('cloud-save-name').onclick = () => cloud.setName($('cloud-name').value).then((n) => toast(`Naam opgeslagen: ${n}`)).catch(cloudErr);

const NET_ICONS = {
  w: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13.5" cy="4.5" r="1.9"/><path d="M12.5 8.5l-3 3.5 2.8 2.5-1.3 6M12.5 8.5l3 2.6 2.7.4M9.5 12l-2.3 3.2M12.3 14.5l3.4 2.3.8 4"/></svg>',
  f: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.8" cy="16.5" r="3.6"/><circle cx="18.2" cy="16.5" r="3.6"/><path d="M5.8 16.5l3.7-7.5h5.2l3.5 7.5M9.5 9l2.6 7.5M8.3 6.8h2.7M14.7 9l-1.2-2.4h2.4"/></svg>',
};
let publicMode = 'votes';
const pubFilter = { net: '', province: '', near: null };
for (const sel of [$('flt-province'), $('publish-province')]) for (const p of PROVINCES) sel.append(new Option(p, p));
async function renderPublic(mode = publicMode) {
  publicMode = mode;
  $('sort-votes').classList.toggle('on', mode === 'votes');
  $('sort-new').classList.toggle('on', mode === 'new');
  $('sort-votes').parentElement.hidden = mode === 'favs';
  $('public-filters').hidden = mode === 'favs';
  const ul = $('public-list');
  const empty = $('public-empty');
  ul.replaceChildren();
  empty.hidden = false;
  empty.textContent = 'Laden…';
  let items;
  try {
    items = mode === 'favs' ? await cloud.listFavs() : await cloud.list({ sort: mode, ...pubFilter });
  } catch (e) {
    empty.textContent = 'Laden mislukt. Ben je online?';
    return;
  }
  empty.hidden = items.length > 0;
  const filtered = mode !== 'favs' && (pubFilter.net || pubFilter.province || pubFilter.near);
  empty.textContent = mode === 'favs' ? 'Nog geen sterren. Geef een ster aan een openbare route.' : filtered ? 'Geen routes gevonden met deze filters. Routes zonder plaats tellen hierbij niet mee.' : 'Nog geen openbare routes. Deel de eerste via Mijn routes.';
  for (const r of items) ul.append(publicItem(r));
}
// filters
$('public-filters').querySelectorAll('[data-net]').forEach((b) => {
  const net = b.dataset.net;
  if (net) b.innerHTML = NET_ICONS[net];
  b.onclick = () => {
    pubFilter.net = net;
    $('public-filters').querySelectorAll('[data-net]').forEach((x) => x.classList.toggle('on', x === b));
    renderPublic();
  };
});
$('flt-province').onchange = () => {
  pubFilter.province = $('flt-province').value;
  renderPublic();
};
$('flt-near').onclick = () => {
  const btn = $('flt-near');
  if (pubFilter.near) {
    pubFilter.near = null;
    btn.setAttribute('aria-pressed', 'false');
    btn.classList.remove('on');
    return renderPublic();
  }
  if (!navigator.geolocation) return toast('Locatie is hier niet beschikbaar.', 4000);
  btn.textContent = 'Locatie zoeken…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      pubFilter.near = [pos.coords.latitude, pos.coords.longitude];
      btn.textContent = 'Dichtbij mij';
      btn.setAttribute('aria-pressed', 'true');
      btn.classList.add('on');
      renderPublic();
    },
    () => {
      btn.textContent = 'Dichtbij mij';
      toast('Je locatie is niet beschikbaar. Geef de app toestemming voor locatie.', 5000);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  );
};
function iconBtn(cls, label, svg, onclick) {
  const b = document.createElement('button');
  b.className = cls;
  b.setAttribute('aria-label', label);
  b.innerHTML = svg;
  b.onclick = onclick;
  return b;
}
const netIcon = (net) => {
  const sp = document.createElement('span');
  sp.className = `nt ${net === 'f' ? 'f' : 'w'}`;
  sp.title = net === 'f' ? 'Fietsroute' : 'Wandelroute';
  sp.setAttribute('role', 'img');
  sp.setAttribute('aria-label', sp.title);
  sp.innerHTML = NET_ICONS[net === 'f' ? 'f' : 'w'];
  return sp;
};
function publicItem(r) {
  const li = document.createElement('li');
  const open = document.createElement('button');
  open.className = 'open';
  const name = document.createElement('b');
  name.textContent = r.title;
  const info = document.createElement('span');
  info.textContent = `${formatDistance(r.length)} · door ${r.ownerName || 'onbekend'}`;
  open.append(name, info);
  const where = [r.place, r.province].filter(Boolean).join(' · ');
  if (where || r.distKm != null) {
    const w = document.createElement('span');
    w.className = 'where';
    w.textContent = [where, r.distKm != null ? `${formatKm(r.distKm)} van je af` : ''].filter(Boolean).join(' — ');
    open.append(w);
  }
  open.onclick = () => {
    publicDlg.close();
    cloudDlg.close();
    openSavedRoute(r);
  };
  const need = (fn) => async () => {
    if (!cloud.state().user) return toast('Log eerst in via je account.', 4000);
    try {
      await fn();
    } catch (e) {
      cloudErr(e);
    }
  };
  const star = iconBtn(`star${r.starred ? ' on' : ''}`, 'Ster', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8-4.3-4.1 5.9-.8z"/></svg>', need(async () => {
    r.starred = await cloud.toggleStar(r);
    star.classList.toggle('on', r.starred);
    if (publicMode === 'favs' && !r.starred) li.remove();
  }));
  const vote = document.createElement('button');
  vote.className = `vote${r.voted ? ' on' : ''}`;
  vote.setAttribute('aria-label', 'Upvote');
  const paint = () => (vote.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5l7 8h-4.5v6h-5v-6H5z"/></svg><span>${r.votes || 0}</span>`);
  paint();
  vote.onclick = need(async () => {
    const on = await cloud.toggleVote(r);
    r.voted = on;
    r.votes = Math.max(0, (r.votes || 0) + (on ? 1 : -1));
    vote.classList.toggle('on', on);
    paint();
  });
  li.append(netIcon(r.net), open, star, vote);
  const more = document.createElement('div');
  more.className = 'more';
  if (r.mine) {
    const del = document.createElement('button');
    del.textContent = 'Verwijderen';
    del.onclick = need(async () => {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = 'Zeker?';
        return setTimeout(() => ((del.dataset.armed = ''), (del.textContent = 'Verwijderen')), 3000);
      }
      await cloud.remove(r);
      li.remove();
      toast('Route verwijderd');
    });
    more.append(del);
  } else {
    const rep = document.createElement('button');
    rep.textContent = 'Melden';
    rep.onclick = need(async () => {
      await cloud.report(r);
      rep.textContent = 'Gemeld, bedankt';
      rep.disabled = true;
    });
    more.append(rep);
  }
  li.append(more);
  return li;
}
$('open-public').onclick = () => {
  cloudDlg.close();
  publicDlg.showModal();
  renderPublic('votes');
};
$('open-favs').onclick = () => {
  if (!cloud.state().user) return toast('Log eerst in om je sterren te zien.', 4000);
  cloudDlg.close();
  publicDlg.showModal();
  renderPublic('favs');
};
$('sort-votes').onclick = () => renderPublic('votes');
$('sort-new').onclick = () => renderPublic('new');
$('public-close').onclick = () => publicDlg.close();

let publishing = null;
function startPublish(saved) {
  const st = cloud.state();
  if (!st.user) return toast('Log eerst in via je account om te delen.', 4000);
  if (!st.user.name) return toast('Kies eerst een naam bij je account.', 4000);
  publishing = saved;
  $('publish-name').value = saved.name;
  $('publish-place').value = saved.place || '';
  $('publish-province').value = saved.province || '';
  $('publish-error').hidden = true;
  if (!saved.place && !saved.province && saved.waypoints[0]) {
    lookupPlace(saved.waypoints[0].lat, saved.waypoints[0].lon).then((loc) => {
      if (loc && publishing === saved && !$('publish-place').value && !$('publish-province').value) {
        $('publish-place').value = loc.place;
        $('publish-province').value = loc.province;
      }
    });
  }
  routesDlg.close();
  publishDlg.showModal();
}
$('publish-cancel').onclick = () => publishDlg.close();
$('publish-ok').onclick = async () => {
  const err = $('publish-error');
  const v = validateTitle($('publish-name').value);
  if (!v.ok) {
    err.textContent = v.error;
    err.hidden = false;
    return;
  }
  try {
    await cloud.publish(publishing, v.title, { place: $('publish-place').value, province: $('publish-province').value });
    publishDlg.close();
    toast(`"${v.title}" is gedeeld`, 5000);
  } catch (e) {
    err.textContent = e.message || 'Delen mislukte.';
    err.hidden = false;
  }
};
initCloud();

// ------------------------------------------------------------------ kaart draaien
map.on('rotate', () => {
  const b = map.getBearing ? map.getBearing() : 0;
  $('btn-compass').hidden = Math.abs(b) < 1;
  $('compass-svg').style.transform = `rotate(${-b}deg)`;
  redrawSoon(); // na het draaien komen er knooppunten in de hoeken in beeld
});
let redrawTimer;
function redrawSoon() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(redraw, 180);
}
map.on('resize', redrawSoon);
$('btn-compass').onclick = () => map.setBearing(0);

// ------------------------------------------------------------------ opslaan en herstellen
function persist() {
  try {
    localStorage.setItem('knooppunten.v1', JSON.stringify({ net: state.net, waypoints: state.waypoints.map((k) => ({ key: k, ...(graph.nodes.get(k) ? { lat: graph.nodes.get(k).lat, lon: graph.nodes.get(k).lon, ref: graph.nodes.get(k).ref } : state.wpMeta.get(k)) })), view: [map.getCenter().lat, map.getCenter().lng, map.getZoom()] }));
  } catch { /* opslag niet beschikbaar */ }
}
async function restore() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem('knooppunten.v1') || 'null');
  } catch { /* ignore */ }
  if (!saved) return;
  if (saved.view) map.setView([saved.view[0], saved.view[1]], saved.view[2]);
  if (saved.net === 'f') setNet('f');
  if (saved.waypoints?.length) {
    for (const w of saved.waypoints) state.wpMeta.set(w.key, { lat: w.lat, lon: w.lon, ref: w.ref });
    state.waypoints = saved.waypoints.map((w) => w.key);
    await recompute();
  }
}
map.on('click', () => {
  if (state.peek) setPeek(null);
});
map.on('moveend', () => {
  redraw();
  persist();
});

// ------------------------------------------------------------------ start
async function init() {
  sizeSheet();
  try {
    const r = await fetch('data/index.json');
    if (!r.ok) throw new Error(r.status);
    state.index = await r.json();
  } catch {
    $('data-info').textContent = 'Geen kaartdata gevonden. Draai eerst het databouw-script (zie README).';
    return;
  }
  const hadSaved = !!localStorage.getItem('knooppunten.v1');
  if (!hadSaved && state.index.bounds) {
    const [s, w, n, e] = state.index.bounds;
    map.fitBounds([[s, w], [n, e]], { maxZoom: 13 });
  }
  await restore();
  redraw();
  loadWater();
}
init();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker niet geregistreerd', e));
}
