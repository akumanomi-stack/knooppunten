// Stappen, calorieën en watertappunten langs een route. Schattingen, zonder DOM.
import { haversine } from './graph.js?v=22';

export const STEPS_PER_KM = 1333;
export const DEFAULT_WEIGHT = 75; // vast gemiddelde: de app vraagt niet naar je gewicht

// Alleen bij wandelen: bij fietsen zijn stappen niet zinvol.
export function stepsFor(lengthM, net) {
  return net === 'f' ? null : Math.round((lengthM / 1000) * STEPS_PER_KM);
}

// kcal = MET x gewicht x uren; wandelen 3,5 MET bij 4,5 km/u, fietsen 6 MET bij 15 km/u
export function kcalFor(lengthM, net, weightKg = DEFAULT_WEIGHT) {
  const kg = Number.isFinite(weightKg) && weightKg >= 30 && weightKg <= 250 ? weightKg : DEFAULT_WEIGHT;
  const perKm = net === 'f' ? (6 * kg) / 15 : (3.5 * kg) / 4.5;
  return Math.round(((lengthM / 1000) * perKm) / 5) * 5;
}

export function formatSteps(n) {
  return n.toLocaleString('nl-NL');
}

// Aantal watertappunten binnen maxM van de route. points: [[lat, lon, naam?], ...]
export function waterAlong(coords, points, maxM = 150) {
  if (!coords?.length || !points?.length) return [];
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [la, lo] of coords) {
    if (la < s) s = la;
    if (la > n) n = la;
    if (lo < w) w = lo;
    if (lo > e) e = lo;
  }
  const padLat = (maxM / 111000) * 1.5;
  const padLon = padLat / Math.cos((((s + n) / 2) * Math.PI) / 180);
  const near = [];
  for (const p of points) {
    if (p[0] < s - padLat || p[0] > n + padLat || p[1] < w - padLon || p[1] > e + padLon) continue;
    for (let i = 0; i < coords.length; i++) {
      // ook tussen twee punten: bij lange rechte stukken is het dichtstbijzijnde punt niet altijd een hoekpunt
      if (nearSegment(p, coords[i], coords[i + 1] || coords[i], maxM)) {
        near.push(p);
        break;
      }
    }
  }
  return near;
}

function nearSegment(p, a, b, maxM) {
  if (haversine(p, a) <= maxM) return true;
  const dx = b[1] - a[1];
  const dy = b[0] - a[0];
  const len2 = dx * dx + dy * dy;
  if (!len2) return false;
  const k = Math.cos((a[0] * Math.PI) / 180);
  const t = Math.max(0, Math.min(1, ((p[1] - a[1]) * k * dx * k + (p[0] - a[0]) * dy) / (dx * dx * k * k + dy * dy)));
  return haversine(p, [a[0] + t * dy, a[1] + t * dx]) <= maxM;
}
