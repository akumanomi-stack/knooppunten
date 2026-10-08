// Punten onderweg: toiletten, oplaadpunten voor e-bikes, picknickplekken en cafés/restaurants.
// Alle iconen zijn SVG (scherp op elk scherm), lijnstijl, zelfde raster van 24x24.

export const CATS = {
  toilet: {
    label: 'Toilet', color: '#00897b', file: 'data/poi_toilet.json', minZoom: 14,
    icon: '<circle cx="12" cy="5.2" r="1.9"/><path d="M8.5 21v-6.2H7l1.6-5.1a2 2 0 0 1 1.9-1.4h3a2 2 0 0 1 1.9 1.4l1.6 5.1h-1.5V21"/><path d="M12 12v9"/>',
  },
  ebike: {
    label: 'Opladen', color: '#f9a825', file: 'data/poi_ebike.json', minZoom: 14,
    icon: '<path d="M13 2.8 6.5 13H12l-1 8.2L17.5 11H12z"/>',
  },
  picnic: {
    label: 'Picknick', color: '#8d6e63', file: 'data/poi_picnic.json', minZoom: 15,
    icon: '<path d="M5 10h14"/><path d="M7 10 5 20M17 10l2 10"/><path d="M3.5 14.5h17"/><path d="M8 6.5h8"/>',
  },
  cafe: {
    label: 'Eten & drinken', color: '#e64a19', file: 'data/poi_cafe.json', minZoom: 14,
    icon: '<path d="M5 8h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 9.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8.5 3.5v2M12 3.5v2"/>',
  },
};
export const CAT_KEYS = Object.keys(CATS);
const DEFAULT_ON = { water: true, toilet: true, ebike: false, picnic: false, cafe: false };

export const svg = (inner, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
export const badgeHtml = (cat) => `<div class="poi" style="--pc:${CATS[cat].color}">${svg(CATS[cat].icon)}</div>`;

/** Welke categorieën staan aan? (bewaard in localStorage, werkt ook zonder) */
export function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem('kn-poi') || 'null');
    if (raw && typeof raw === 'object') return { ...DEFAULT_ON, ...Object.fromEntries(['water', ...CAT_KEYS].map((k) => [k, !!raw[k]])) };
  } catch { /* geen opslag beschikbaar */ }
  return { ...DEFAULT_ON };
}
export function savePrefs(p) {
  try { localStorage.setItem('kn-poi', JSON.stringify(p)); } catch { /* geen opslag beschikbaar */ }
}

export async function fetchCat(cat) {
  try {
    const r = await fetch(CATS[cat].file);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.points) ? d.points : [];
  } catch {
    return [];
  }
}

const KIND = { cafe: 'Café', restaurant: 'Restaurant', pub: 'Kroeg', biergarten: 'Biergarten' };

/** Titel en regel voor het info-kaartje van een punt. */
export function describe(cat, p) {
  const name = p[2] || '';
  const x = p[3] || {};
  if (cat === 'toilet') {
    const bits = [x.f === 1 ? 'Betaald' : x.f === 0 ? 'Gratis' : '', x.w ? 'Rolstoeltoegankelijk' : ''].filter(Boolean);
    return { title: name ? `Toilet: ${name}` : 'Toilet', info: bits.join(' · ') };
  }
  if (cat === 'ebike') return { title: 'Oplaadpunt e-bike', info: [name, x.op].filter(Boolean).join(' · ') };
  if (cat === 'picnic') return { title: name ? `Picknickplek: ${name}` : 'Picknickplek', info: '' };
  const kind = KIND[x.k] || 'Eten & drinken';
  return { title: name ? `${kind}: ${name}` : kind, info: x.oh ? `Open: ${x.oh}` : 'Openingstijden onbekend' };
}

/** Samenvatting voor de routekenmerken, bijvoorbeeld "2 toiletten". */
export function countLabel(cat, n) {
  const one = { toilet: 'toilet', ebike: 'oplaadpunt', picnic: 'picknickplek', cafe: 'café/restaurant' };
  const many = { toilet: 'toiletten', ebike: 'oplaadpunten', picnic: 'picknickplekken', cafe: 'cafés/restaurants' };
  return `${n} ${n === 1 ? one[cat] : many[cat]}`;
}
