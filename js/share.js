// Tekst van een route (voor kopiëren en delen) en opgeslagen routes. Zonder DOM, zodat het te testen is.
import { formatDistance } from './graph.js?v=26';

export function estimateMinutes(lengthM, net) {
  const kmh = net === 'f' ? 15 : 4.5;
  return Math.max(5, Math.round(((lengthM / 1000 / kmh) * 60) / 5) * 5);
}

export function formatDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} u ${m} min` : `${h} u`;
}

// [{ from, to, len, cum }]: een stap is het stuk tussen twee opeenvolgende knooppunten
export function routeSteps(route) {
  const na = route.nodeAt;
  const out = [];
  for (let i = 0; i < na.length - 1; i++) {
    out.push({ from: na[i].ref, to: na[i + 1].ref, len: na[i + 1].cum - na[i].cum, cum: na[i + 1].cum });
  }
  return out;
}

export function routeTitle(route, net) {
  return `${net === 'f' ? 'Fietsroute' : 'Wandelroute'} ${route.nodeAt.map((n) => n.ref).join(' → ')}`;
}

export function routeText(route, net, { url = '', steps: stepCount = null, kcal = null, water = null } = {}) {
  const steps = routeSteps(route);
  const extra = [];
  if (stepCount != null) extra.push(`${stepCount.toLocaleString('nl-NL')} stappen`);
  if (kcal != null) extra.push(`${kcal} kcal`);
  if (water) extra.push(`${water} ${water === 1 ? 'watertappunt' : 'watertappunten'} onderweg`);
  const lines = [routeTitle(route, net), `${formatDistance(route.length)}, ongeveer ${formatDuration(estimateMinutes(route.length, net))}`];
  if (extra.length) lines.push(extra.join(' · '));
  lines.push('');
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s.from} → ${s.to} (${formatDistance(s.len)})`));
  lines.push('', `Totaal: ${formatDistance(route.length)}`);
  if (url) lines.push('', `Route in Google Maps: ${url}`);
  return lines.join('\n');
}

// ---- opgeslagen routes (alleen de knooppunten; de route zelf wordt opnieuw berekend)
export const ROUTES_KEY = 'knooppunten.routes.v1';

export function readRoutes(storage) {
  try {
    const list = JSON.parse(storage.getItem(ROUTES_KEY) || '[]');
    return Array.isArray(list) ? list.filter((r) => r && Array.isArray(r.waypoints) && r.waypoints.length >= 2) : [];
  } catch {
    return [];
  }
}

export function writeRoutes(storage, list) {
  try {
    storage.setItem(ROUTES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function makeSavedRoute({ name, net, waypoints, length, steps, place = '', province = '' }, now = Date.now()) {
  return {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: String(name || '').trim() || 'Route',
    net,
    length,
    steps,
    place,
    province,
    savedAt: now,
    waypoints: waypoints.map((w) => ({ key: w.key, lat: w.lat, lon: w.lon, ref: w.ref })),
  };
}

export function defaultRouteName(route, net) {
  const refs = route.nodeAt.map((n) => n.ref);
  const short = refs.length > 6 ? `${refs.slice(0, 3).join('-')}…${refs.slice(-2).join('-')}` : refs.join('-');
  return `${net === 'f' ? 'Fietsen' : 'Wandelen'} ${short} · ${formatDistance(route.length)}`;
}
