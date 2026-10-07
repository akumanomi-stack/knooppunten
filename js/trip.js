// Snelheid onderweg: gemiddelde per deelstuk (tussen twee knooppunten) en over de hele route.
// Alleen beweegtijd telt mee: stilstaan (bankje, verkeerslicht) drukt het gemiddelde niet omlaag.

const MIN_MOVE = 0.4; // m/s: langzamer dan dit geldt als stilstaan
const MAX_MOVE = 15; // m/s (54 km/u): sneller is een GPS-sprong
const MAX_GAP = 30; // s: een langere pauze tussen twee punten (GPS weg) telt niet mee

export function createTrip() {
  return { lastT: null, lastAlong: null, moveS: 0, distM: 0, legMoveS: 0, legDistM: 0, recent: [] };
}

/** Nieuw GPS-punt: tMs = tijdstip (ms), along = meters langs de route. */
export function tripUpdate(tr, tMs, along) {
  if (tr.lastT != null) {
    const dt = (tMs - tr.lastT) / 1000;
    const dd = along - tr.lastAlong;
    // een stuk tussen twee punten telt alleen mee als het geen GPS-sprong of lange pauze is
    if (dt > 0 && dt <= MAX_GAP && dd >= 0 && dd / dt <= MAX_MOVE) {
      const moving = dd / dt >= MIN_MOVE;
      if (moving) {
        tr.moveS += dt;
        tr.distM += dd;
        tr.legMoveS += dt;
        tr.legDistM += dd;
      }
      tr.recent.push([tMs, moving ? dd : 0, dt]);
    }
  }
  tr.lastT = tMs;
  tr.lastAlong = along;
  while (tr.recent.length && tMs - tr.recent[0][0] > 15000) tr.recent.shift();
}

const kmh = (m, s) => (s > 0 ? (m / s) * 3.6 : null);

/** Snelheid van de afgelopen ~15 s in km/u, of null bij stilstand of te weinig punten. */
export function liveKmh(tr) {
  let dd = 0;
  let dt = 0;
  for (const [, d, t] of tr.recent) {
    dd += d;
    dt += t;
  }
  if (dt < 3) return null;
  const v = dd / dt;
  return v < MIN_MOVE ? null : v * 3.6;
}

export function avgKmh(tr) {
  return kmh(tr.distM, tr.moveS);
}

/** Sluit het deelstuk af: geeft gemiddelden en begint een nieuw deelstuk. */
export function legDone(tr) {
  const out = { legKmh: kmh(tr.legDistM, tr.legMoveS), totKmh: kmh(tr.distM, tr.moveS), totMoveS: tr.moveS };
  tr.legMoveS = 0;
  tr.legDistM = 0;
  return out;
}

export function fmtKmh(v) {
  return v == null ? '–' : `${v.toFixed(1).replace('.', ',')} km/u`;
}

export function fmtMoveTime(s) {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} u ${String(m % 60).padStart(2, '0')} min`;
}
