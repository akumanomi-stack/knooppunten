// Plaats en provincie bij een route: opzoeken via PDOK (gratis, geen sleutel) en filteren op afstand/provincie.
export const PROVINCES = ['Drenthe', 'Flevoland', 'Friesland', 'Gelderland', 'Groningen', 'Limburg', 'Noord-Brabant', 'Noord-Holland', 'Overijssel', 'Utrecht', 'Zeeland', 'Zuid-Holland'];

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');

export function normProvince(name) {
  const n = fold(name);
  if (!n) return '';
  if (n === 'fryslan') return 'Friesland';
  return PROVINCES.find((p) => fold(p) === n) || '';
}

export function distanceKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function formatKm(km) {
  return km < 10 ? `${km.toFixed(1).replace('.', ',')} km` : `${Math.round(km)} km`;
}

export const PDOK_REVERSE = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse';

// Geeft { place, province } of null als het opzoeken niet lukt (offline, geblokkeerd, buiten Nederland).
export async function lookupPlace(lat, lon, { fetchFn = (...a) => fetch(...a), timeoutMs = 3000 } = {}) {
  try {
    const url = `${PDOK_REVERSE}?lat=${(+lat).toFixed(5)}&lon=${(+lon).toFixed(5)}&type=woonplaats&fl=woonplaatsnaam,gemeentenaam,provincienaam&rows=1`;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetchFn(url, ctl ? { signal: ctl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    const doc = (await res.json())?.response?.docs?.[0];
    if (!doc) return null;
    const place = String(doc.woonplaatsnaam || doc.gemeentenaam || '').trim().slice(0, 40);
    const province = normProvince(doc.provincienaam);
    return place || province ? { place, province } : null;
  } catch {
    return null;
  }
}

// Filteren van de openbare lijst. near = [lat, lon] sorteert op afstand tot het startpunt.
export function filterRoutes(items, { net = '', province = '', near = null } = {}) {
  let out = items.filter((r) => (!net || r.net === net) && (!province || r.province === province));
  if (near) {
    out = out
      .filter((r) => Number.isFinite(r.startLat) && Number.isFinite(r.startLon))
      .map((r) => ({ ...r, distKm: distanceKm(near, [r.startLat, r.startLon]) }))
      .sort((a, b) => a.distKm - b.distKm);
  }
  return out;
}
