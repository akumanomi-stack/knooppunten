// Eenvoudig woordfilter voor titels en namen. Bewust klein en aanpasbaar: voeg woorden toe aan BLOCKED.
// Het filter vangt de grofste gevallen af; de Melden-knop en jouw controle in de Firebase-console doen de rest.
const BLOCKED = [
  'kut', 'kanker', 'tering', 'tyfus', 'klote', 'hoer', 'slet', 'lul', 'pik', 'eikel', 'kloot', 'mongool', 'debiel', 'idioot',
  'neger', 'nigger', 'nazi', 'hitler', 'fuck', 'shit', 'bitch', 'cunt', 'dick', 'asshole', 'whore', 'slut', 'fag', 'retard',
];

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[@4]/g, 'a')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

export function isClean(text) {
  const n = normalize(text);
  if (!n) return true;
  // losse letters ("k u t", "k.u.t") aan elkaar plakken
  const words = n.split(' ').reduce((acc, w) => {
    if (w.length === 1 && acc.length && acc[acc.length - 1].single) acc[acc.length - 1].w += w;
    else acc.push({ w, single: w.length === 1 });
    return acc;
  }, []).map((x) => x.w);
  const joined = words.join('');
  return !BLOCKED.some((b) => words.includes(b) || (b.length >= 5 && joined.includes(b)));
}

// Titel opschonen: spaties, lengte, geen links.
export function cleanTitle(text, max = 60) {
  return String(text || '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
