// Routelogica voor de knooppunten-app. Geen DOM-afhankelijkheden, zodat het ook in Node getest kan worden.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const nodeKey = (net, id) => `${net}:${id}`;

// ------------------------------------------------------------------ binaire heap
class MinHeap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(item, pri) {
    const a = this.a;
    a.push([pri, item]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// ------------------------------------------------------------------ graaf
export class Graph {
  constructor() {
    this.nodes = new Map(); // key -> {key,id,net,ref,lat,lon}
    this.edges = new Map(); // key -> {key,id,net,a,b,len,geom}
    this.adj = new Map(); // nodeKey -> [{to, edgeKey, len}]
    this.loadedTiles = new Set();
  }

  /** Voeg een tegel toe (formaat zoals het databouw-script het schrijft). Dubbelen worden genegeerd. */
  addTile(tileKey, tile) {
    if (this.loadedTiles.has(tileKey)) return;
    this.loadedTiles.add(tileKey);
    for (const [id, net, ref, lat, lon] of tile.nodes) {
      const key = nodeKey(net, id);
      if (!this.nodes.has(key)) this.nodes.set(key, { key, id, net, ref, lat, lon });
    }
    for (const [id, net, a, b, len, geom] of tile.edges) {
      const key = `${net}:r${id}`;
      if (this.edges.has(key)) continue;
      const ka = nodeKey(net, a);
      const kb = nodeKey(net, b);
      this.edges.set(key, { key, id, net, a: ka, b: kb, len, geom });
      this._link(ka, kb, key, len);
      this._link(kb, ka, key, len);
    }
  }

  _link(from, to, edgeKey, len) {
    let list = this.adj.get(from);
    if (!list) this.adj.set(from, (list = []));
    // bij dubbele verbindingen tussen dezelfde twee knooppunten de kortste houden
    const existing = list.find((x) => x.to === to);
    if (existing) {
      if (len < existing.len) {
        existing.len = len;
        existing.edgeKey = edgeKey;
      }
      return;
    }
    list.push({ to, edgeKey, len });
  }

  /**
   * Kortste route tussen twee knooppunten; null als er geen verbinding is.
   * opts.used (Set met edge-sleutels) en opts.factor laten reeds gebruikte stukken duurder meetellen,
   * zodat een lusroute niet dezelfde weg terug neemt. opts.limit kapt het zoeken af (kosten in meters).
   * `length` is altijd de echte lengte van de gevonden route.
   */
  shortestPath(from, to, opts = {}) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    if (from === to) return { nodes: [from], edges: [], length: 0 };
    const { used = null, factor = 1, limit = Infinity } = opts;
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const heap = new MinHeap();
    heap.push(from, 0);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > (dist.get(u) ?? Infinity)) continue;
      if (u === to || d > limit) break;
      for (const { to: v, edgeKey, len } of this.adj.get(u) || []) {
        const nd = d + (used && used.has(edgeKey) ? len * factor : len);
        if (nd < (dist.get(v) ?? Infinity)) {
          dist.set(v, nd);
          prev.set(v, [u, edgeKey, len]);
          heap.push(v, nd);
        }
      }
    }
    if (!prev.has(to)) return null;
    const nodes = [to];
    const edges = [];
    let length = 0;
    for (let cur = to; cur !== from; ) {
      const [p, e, len] = prev.get(cur);
      nodes.push(p);
      edges.push(e);
      length += len;
      cur = p;
    }
    nodes.reverse();
    edges.reverse();
    return { nodes, edges, length };
  }

  /** Buurknooppunten van een knooppunt met de afstand over de verbinding, kortste eerst. */
  neighbours(key) {
    const out = [];
    for (const { to, edgeKey, len } of this.adj.get(key) || []) {
      const node = this.nodes.get(to);
      if (node) out.push({ node, edgeKey, len });
    }
    return out.sort((a, b) => a.len - b.len);
  }

  /**
   * Stelt lusroutes voor van ongeveer targetM meter vanaf startKey. Er worden cirkels in verschillende
   * richtingen en groottes over de kaart gelegd; drie punten op de cirkel (de start en twee ankers) worden aan
   * knooppunten gekoppeld en verbonden, waarbij al gebruikte stukken duurder zijn. Zo ontstaat een rondje
   * met zo min mogelijk dubbel gelopen weg. Geeft maximaal `count` voorstellen, beste eerst.
   */
  async planLoop(startKey, targetM, { count = 3, onProgress } = {}) {
    const start = this.nodes.get(startKey);
    if (!start) return [];
    const net = start.net;
    const rho = targetM / (2 * Math.PI * 1.35); // cirkelstraal; 1,35 = gemiddelde omweg over wegen
    const kLon = 111320 * Math.cos(rad(start.lat));
    const toLL = (dx, dy) => [start.lat + dy / 110540, start.lon + dx / kLon];
    const scales = [0.8, 1.0, 1.25];
    const angles = Array.from({ length: 12 }, (_, i) => i * 30);
    const found = new Map();
    let step = 0;
    const total = scales.length * angles.length;
    for (const sc of scales) {
      for (const ang of angles) {
        step++;
        if (step % 4 === 0) {
          onProgress?.(step / total);
          await new Promise((r) => setTimeout(r, 0)); // de interface even ruimte geven
        }
        const r = rho * sc;
        const th = rad(ang);
        const cx = r * Math.cos(th);
        const cy = r * Math.sin(th);
        const anchors = [];
        for (const a of [th + Math.PI + (2 * Math.PI) / 3, th + Math.PI - (2 * Math.PI) / 3]) {
          const near = this.nearestNodes(toLL(cx + r * Math.cos(a), cy + r * Math.sin(a)), net, 1, Math.max(700, r * 0.5))[0];
          if (near) anchors.push(near.node.key);
        }
        if (anchors.length < 2 || new Set([startKey, ...anchors]).size < 3) continue;
        const loop = this._loopThrough([startKey, ...anchors, startKey]);
        if (!loop) continue;
        const dev = Math.abs(loop.length - targetM) / targetM;
        const score = dev + 1.2 * loop.overlap;
        const sig = loop.nodes.join(',');
        if (!found.has(sig)) found.set(sig, { ...loop, deviation: dev, score });
      }
    }
    // compacte rondjes uit het netwerk zelf: eerlijke lengte, geen dubbel stuk, liefst een ronde vorm
    const near = this.findCycles(startKey, targetM * 1.25)
      .map((c) => ({ c, dev: Math.abs(c.length - targetM) / targetM }))
      .filter((x) => x.dev <= 0.25)
      .sort((a, b) => a.dev - b.dev)
      .slice(0, 400);
    const sp0 = [start.lat, start.lon];
    for (const { c, dev } of near) {
      let far = 0;
      for (const k of c.nodes) {
        const n = this.nodes.get(k);
        far = Math.max(far, haversine(sp0, [n.lat, n.lon]));
      }
      const thin = Math.max(0, far / c.length - 0.3); // een cirkel heeft ~0,32; een dunne lus tot 0,5
      const sig = c.nodes.join(',');
      if (!found.has(sig)) found.set(sig, { ...c, deviation: dev, score: dev + 0.9 * thin });
    }
    const sorted = [...found.values()].sort((a, b) => a.score - b.score);
    const picks = [];
    for (const c of sorted) {
      if (c.deviation > 0.4) continue;
      const set = new Set(c.edges);
      // geen bijna-dubbelen: minstens 40% andere verbindingen dan een eerder gekozen rondje
      const tooSimilar = picks.some((p) => {
        let same = 0;
        for (const e of set) if (p.edgeSet.has(e)) same++;
        return same / set.size > 0.6;
      });
      if (!tooSimilar) picks.push({ ...c, edgeSet: set });
      if (picks.length >= count) break;
    }
    return picks.map(({ edgeSet, edges, ...rest }) => rest);
  }

  /**
   * Zoekt alle enkelvoudige rondjes (geen knooppunt twee keer) vanaf startKey tot maxM meter, door het netwerk
   * stap voor stap af te lopen. Zo vind je ook de korte, compacte rondjes die een cirkel-methode mist.
   * Er is een rekenbudget (aantal stappen) zodat een groot netwerk de telefoon niet vastzet.
   */
  findCycles(startKey, maxM, { budget = 150000, maxFound = 4000 } = {}) {
    const start = this.nodes.get(startKey);
    if (!start) return [];
    const sp = [start.lat, start.lon];
    const straight = new Map();
    const toStart = (k) => {
      let d = straight.get(k);
      if (d === undefined) {
        const n = this.nodes.get(k);
        d = n ? haversine(sp, [n.lat, n.lon]) : Infinity;
        straight.set(k, d);
      }
      return d;
    };
    const out = [];
    const path = [startKey];
    const edges = [];
    const onPath = new Set([startKey]);
    let steps = 0;
    const walk = (cur, len) => {
      for (const { to, edgeKey, len: l } of this.adj.get(cur) || []) {
        if (steps++ > budget || out.length >= maxFound) return;
        const nl = len + l;
        if (to === startKey) {
          // een rondje heeft minstens 3 verschillende knooppunten; elke richting maar één keer meenemen
          if (path.length >= 3 && path[1] < cur) out.push({ nodes: [...path, startKey], edges: [...edges, edgeKey], length: nl, overlap: 0 });
          continue;
        }
        if (onPath.has(to) || !this.nodes.has(to)) continue;
        if (nl + toStart(to) > maxM) continue; // terug naar de start kan dan nooit meer binnen maxM
        path.push(to);
        edges.push(edgeKey);
        onPath.add(to);
        walk(to, nl);
        onPath.delete(to);
        edges.pop();
        path.pop();
      }
    };
    walk(startKey, 0);
    return out;
  }

  _loopThrough(seq) {
    const used = new Set();
    const nodes = [seq[0]];
    const edges = [];
    let length = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      const sp = this.shortestPath(seq[i], seq[i + 1], { used, factor: i === 0 ? 1 : 6 });
      if (!sp) return null;
      for (const e of sp.edges) used.add(e);
      edges.push(...sp.edges);
      nodes.push(...sp.nodes.slice(1));
      length += sp.length;
    }
    const count = new Map();
    for (const e of edges) count.set(e, (count.get(e) || 0) + 1);
    let doubled = 0;
    for (const e of edges) if (count.get(e) > 1) doubled += this.edges.get(e).len;
    // overlap = aandeel van de gelopen afstand dat over verbindingen gaat die meer dan eens gebruikt worden
    return { nodes, edges, length, overlap: length ? doubled / length : 0 };
  }

  /**
   * Route langs een reeks waypoints (knooppunt-sleutels). Geeft een route-object met de volledige
   * lijn, cumulatieve afstanden en de knooppunten onderweg, of {error} als een deel niet te verbinden is.
   */
  planRoute(waypoints) {
    if (waypoints.length < 2) return { error: 'Kies minstens twee knooppunten.' };
    const net = this.nodes.get(waypoints[0])?.net;
    const seq = [waypoints[0]];
    const legEdges = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = this.nodes.get(waypoints[i]);
      const b = this.nodes.get(waypoints[i + 1]);
      if (!a || !b) return { error: 'Onbekend knooppunt.' };
      if (a.net !== net || b.net !== net) return { error: 'Meng wandel- en fietsknooppunten niet in één route.' };
      const sp = this.shortestPath(a.key, b.key);
      if (!sp) return { error: `Geen verbinding gevonden tussen ${a.ref} en ${b.ref} in de geladen kaartdata.` };
      for (let k = 0; k < sp.edges.length; k++) {
        legEdges.push({ edgeKey: sp.edges[k], from: sp.nodes[k], to: sp.nodes[k + 1] });
        seq.push(sp.nodes[k + 1]);
      }
    }
    const coords = [];
    const cum = [];
    const nodeAt = [];
    let total = 0;
    const first = this.nodes.get(seq[0]);
    coords.push([first.lat, first.lon]);
    cum.push(0);
    nodeAt.push({ key: first.key, ref: first.ref, cum: 0, lat: first.lat, lon: first.lon });
    for (const leg of legEdges) {
      const e = this.edges.get(leg.edgeKey);
      const geom = e.a === leg.from ? e.geom : [...e.geom].reverse();
      for (let i = 1; i < geom.length; i++) {
        total += haversine(coords[coords.length - 1], geom[i]);
        coords.push(geom[i]);
        cum.push(total);
      }
      const n = this.nodes.get(leg.to);
      nodeAt.push({ key: n.key, ref: n.ref, cum: total, lat: n.lat, lon: n.lon });
    }
    return { net, waypoints: [...waypoints], coords, cum, nodeAt, length: total };
  }

  /** Dichtstbijzijnde knooppunten bij een positie (voor "knooppunt bij mij in de buurt"). */
  nearestNodes(pos, net, limit = 5, maxM = 5000) {
    const out = [];
    for (const n of this.nodes.values()) {
      if (net && n.net !== net) continue;
      if (Math.abs(n.lat - pos[0]) > 0.05) continue;
      const d = haversine(pos, [n.lat, n.lon]);
      if (d <= maxM) out.push({ node: n, dist: d });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, limit);
  }
}

// ------------------------------------------------------------------ tegels
export function tileKeysForBounds(south, west, north, east, size = 0.5) {
  const keys = [];
  for (let la = Math.floor(south / size); la <= Math.floor(north / size); la++) {
    for (let lo = Math.floor(west / size); lo <= Math.floor(east / size); lo++) {
      keys.push(`${la}_${lo}`);
    }
  }
  return keys;
}

// ------------------------------------------------------------------ GPS-voortgang
function toXY(p, lat0) {
  const k = Math.cos(rad(lat0));
  return [rad(p[1]) * R * k, rad(p[0]) * R];
}

/**
 * Waar zit de gebruiker op de route? Geeft {off, along, next, remaining}:
 * off = afstand tot de route (m), along = afgelegde afstand langs de route (m),
 * next = {ref, dist} het eerstvolgende knooppunt, remaining = resterende routeafstand (m).
 * lastAlong helpt bij routes die over zichzelf terugkomen: segmenten ver achter de vorige
 * positie krijgen een strafpunt, zodat de positie niet naar het begin terugspringt.
 */
export function routeProgress(route, pos, lastAlong = 0) {
  const { coords, cum, nodeAt } = route;
  const lat0 = pos[0];
  const p = toXY(pos, lat0);
  let best = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = toXY(coords[i], lat0);
    const b = toXY(coords[i + 1], lat0);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    const along = cum[i] + t * (cum[i + 1] - cum[i]);
    const score = d + (along < lastAlong - 150 ? 60 : 0);
    if (!best || score < best.score) best = { score, off: d, along };
  }
  if (!best) return null;
  let next = null;
  for (let i = 0; i < nodeAt.length; i++) {
    const n = nodeAt[i];
    if (n.cum > best.along + 15) {
      next = { ref: n.ref, key: n.key, index: i, dist: n.cum - best.along, lat: n.lat, lon: n.lon, after: nodeAt[i + 1]?.ref ?? null, isLast: i === nodeAt.length - 1 };
      break;
    }
  }
  return { off: best.off, along: best.along, next, remaining: route.length - best.along, arrived: !next };
}

// ------------------------------------------------------------------ GPX
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function routeToGPX(route, name = 'Knooppuntroute') {
  const label = route.nodeAt.map((n) => n.ref).join(' - ');
  const wpts = route.nodeAt
    .map((n) => `  <wpt lat="${n.lat}" lon="${n.lon}"><name>${esc(n.ref)}</name><sym>Flag, Blue</sym></wpt>`)
    .join('\n');
  const trkpts = route.coords.map((c) => `      <trkpt lat="${c[0]}" lon="${c[1]}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="knooppunten-app" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><desc>${esc(label)} (c) OpenStreetMap contributors</desc></metadata>
${wpts}
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

/**
 * Link die Google Maps opent met de knooppunten als tussenstops. Google rekent de weg tussen de punten zelf uit,
 * dus de route kan afwijken van de knooppuntenroute. Google staat maximaal 9 tussenstops toe; bij meer worden
 * er gelijkmatig verspreid 8 gekozen. Geeft {url, used, total} (used/total = tussenstops).
 */
export function googleMapsUrl(route, mode = 'bicycling', maxStops = 8) {
  const pts = route.nodeAt;
  const fmt = (n) => `${n.lat.toFixed(5)},${n.lon.toFixed(5)}`;
  const inner = pts.slice(1, -1);
  let pick = inner;
  if (inner.length > maxStops) {
    pick = [];
    for (let i = 0; i < maxStops; i++) pick.push(inner[Math.round((i * (inner.length - 1)) / (maxStops - 1))]);
  }
  const params = [
    'api=1',
    `origin=${fmt(pts[0])}`,
    `destination=${fmt(pts[pts.length - 1])}`,
  ];
  if (pick.length) params.push(`waypoints=${pick.map(fmt).join('%7C')}`);
  params.push(`travelmode=${mode}`);
  return { url: `https://www.google.com/maps/dir/?${params.join('&')}`, used: pick.length, total: inner.length };
}

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`;
}
