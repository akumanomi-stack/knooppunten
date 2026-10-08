// Inloggen, openbare routes, sterren en upvotes. De logica staat los van Firebase (adapter), zodat ze te testen is.
import { isClean, cleanTitle } from './filter.js?v=26';
import { PROVINCES, filterRoutes } from './place.js?v=26';

export const MAX_PUBLIC_ROUTES_PER_USER = 50;

// Vingerafdruk van een route: zelfde type en zelfde knooppunten in dezelfde volgorde (of precies omgekeerd) = dezelfde route.
function hash53(str) {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
export function routeSignature(waypoints, net) {
  const keys = waypoints.map((w) => String(w.key));
  const fwd = keys.join('>');
  const rev = [...keys].reverse().join('>');
  return `${net === 'f' ? 'f' : 'w'}-${hash53(fwd < rev ? fwd : rev)}`;
}

export function validateTitle(title) {
  const t = cleanTitle(title);
  if (t.length < 3) return { ok: false, error: 'Geef de route een titel van minstens 3 tekens.' };
  if (!isClean(t)) return { ok: false, error: 'Deze titel is niet toegestaan. Kies een andere.' };
  return { ok: true, title: t };
}

export function validateName(name) {
  const t = cleanTitle(name, 30);
  if (t.length < 2) return { ok: false, error: 'Kies een naam van minstens 2 tekens.' };
  if (!isClean(t)) return { ok: false, error: 'Deze naam is niet toegestaan. Kies een andere.' };
  return { ok: true, name: t };
}

// Wat er openbaar komt: alleen knooppunten en samenvatting. Geen GPS-sporen, geen e-mailadres.
export function cleanPlace(place, province) {
  const pl = cleanTitle(place, 40);
  if (pl && !isClean(pl)) return { ok: false, error: 'Deze plaatsnaam is niet toegestaan.' };
  return { ok: true, place: pl, province: PROVINCES.includes(province) ? province : '' };
}

export function makePublicRoute(saved, user, title, loc = {}) {
  const start = saved.waypoints[0];
  return {
    title,
    net: saved.net === 'f' ? 'f' : 'w',
    length: Math.round(saved.length),
    steps: saved.steps | 0,
    waypoints: saved.waypoints.map((w) => ({ key: String(w.key), lat: +(+w.lat).toFixed(5), lon: +(+w.lon).toFixed(5), ref: String(w.ref) })),
    sig: routeSignature(saved.waypoints, saved.net),
    place: loc.place || '',
    province: loc.province || '',
    startLat: +(+start.lat).toFixed(3),
    startLon: +(+start.lon).toFixed(3),
    ownerUid: user.uid,
    ownerName: user.name,
    votes: 0,
    createdAt: Date.now(),
  };
}

export function createCloud(adapter, { onChange = () => {} } = {}) {
  const s = { ready: false, user: null, favs: new Set(), voted: new Set(), available: !!adapter };

  const emit = () => onChange({ ...s });
  const need = () => {
    if (!s.user) throw new Error('Log eerst in.');
  };

  async function loadUserData() {
    const [favs, voted] = await Promise.all([adapter.listFavs(s.user.uid), adapter.listVoted(s.user.uid)]);
    s.favs = new Set(favs.map((f) => f.id));
    s.voted = new Set(voted);
  }

  if (adapter) {
    adapter.onAuth(async (u) => {
      s.ready = true;
      if (u) {
        const profile = await adapter.getProfile(u.uid).catch(() => null);
        s.user = { uid: u.uid, name: profile?.name || '', photo: u.photo || '' };
        await loadUserData().catch(() => {});
      } else {
        s.user = null;
        s.favs = new Set();
        s.voted = new Set();
      }
      emit();
    });
  }

  return {
    state: () => s,
    signIn: () => adapter.signIn(),
    signOut: () => adapter.signOut(),

    async setName(name) {
      need();
      const v = validateName(name);
      if (!v.ok) throw new Error(v.error);
      await adapter.setProfile(s.user.uid, { name: v.name });
      s.user.name = v.name;
      emit();
      return v.name;
    },

    async publish(saved, title, loc = {}) {
      need();
      if (!s.user.name) throw new Error('Kies eerst een naam bij je account.');
      const v = validateTitle(title);
      if (!v.ok) throw new Error(v.error);
      if (!saved?.waypoints || saved.waypoints.length < 2) throw new Error('Deze route heeft te weinig knooppunten.');
      const mine = await adapter.listMine(s.user.uid);
      if (mine.length >= MAX_PUBLIC_ROUTES_PER_USER) throw new Error(`Je kunt maximaal ${MAX_PUBLIC_ROUTES_PER_USER} routes openbaar hebben.`);
      const lc = cleanPlace(loc.place, loc.province);
      if (!lc.ok) throw new Error(lc.error);
      const route = makePublicRoute(saved, s.user, v.title, lc);
      if (await adapter.exists(route.sig)) throw new Error('Deze route staat al in de openbare lijst.');
      return adapter.publish(route);
    },

    async list(opts = 'votes') {
      const o = typeof opts === 'string' ? { sort: opts } : opts;
      const items = await adapter.listPublic(o.sort === 'new' ? 'new' : 'votes');
      const all = items.map((r) => ({ ...r, starred: s.favs.has(r.id), voted: s.voted.has(r.id), mine: !!s.user && r.ownerUid === s.user.uid }));
      return filterRoutes(all, o);
    },

    async listFavs() {
      need();
      return (await adapter.listFavs(s.user.uid)).map((r) => ({ ...r, starred: true, voted: s.voted.has(r.id), mine: r.ownerUid === s.user.uid }));
    },

    async toggleStar(route) {
      need();
      const on = !s.favs.has(route.id);
      await adapter.setFav(s.user.uid, route, on);
      on ? s.favs.add(route.id) : s.favs.delete(route.id);
      emit();
      return on;
    },

    async toggleVote(route) {
      need();
      const on = !s.voted.has(route.id);
      await adapter.setVote(s.user.uid, route.id, on);
      on ? s.voted.add(route.id) : s.voted.delete(route.id);
      emit();
      return on;
    },

    async report(route) {
      need();
      await adapter.report(s.user.uid, route.id);
    },

    async remove(route) {
      need();
      await adapter.deleteRoute(route.id);
    },
  };
}
