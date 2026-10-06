// Uitspreken van knooppunten: eigen opnames (audio/nl/*.mp3) als die er zijn, anders de spraak van de telefoon.

const num = (ref) => {
  const n = Number(ref);
  return Number.isFinite(n) ? String(n) : String(ref);
};

export function sentence({ ref, after, isLast, start }) {
  if (start) return `Route gestart. Ga naar knooppunt ${num(ref)}`;
  if (isLast) return `Je bent bij het eindpunt, knooppunt ${num(ref)}`;
  return `Knooppunt ${num(ref)}${after ? `, daarna ${num(after)}` : ''}`;
}

// ---- stemmen van het apparaat
export function dutchVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter((v) => /^nl([-_]|$)/i.test(v.lang));
}

// Netwerk-/neurale stemmen klinken veel natuurlijker dan de ingebouwde robotstem.
export function voiceScore(v) {
  let s = 0;
  if (/natural|neural|online|premium|enhanced|wavenet/i.test(v.name)) s += 4;
  if (!v.localService) s += 3;
  if (/google/i.test(v.name)) s += 1;
  if (/nl[-_]NL/i.test(v.lang)) s += 1;
  return s;
}

export function bestVoice(voices) {
  return [...voices].sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
}

export function pickVoice(uri) {
  const voices = dutchVoices();
  return voices.find((v) => v.voiceURI === uri) || bestVoice(voices);
}

export function speakText(text, voiceURI = '') {
  if (!('speechSynthesis' in window)) return false;
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(voiceURI);
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  } else {
    u.lang = 'nl-NL';
  }
  u.rate = 0.95;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  return true;
}

// ---- eigen opnames: audio/nl/manifest.json = { "files": ["knooppunt","daarna","eindpunt","start","1","2",...] }
let clips = null;
export async function loadClips(base = 'audio/nl/') {
  try {
    const r = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const m = await r.json();
    clips = { base, files: new Set(m.files || []) };
  } catch {
    clips = { base, files: new Set() };
  }
  return clips.files.size > 0;
}

export function clipSequence(info) {
  const seq = info.start ? ['start', num(info.ref)] : info.isLast ? ['eindpunt', num(info.ref)] : ['knooppunt', num(info.ref), ...(info.after ? ['daarna', num(info.after)] : [])];
  return seq;
}

function playSequence(names) {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= names.length) return resolve(true);
      const a = new Audio(`${clips.base}${names[i++]}.mp3`);
      a.onended = next;
      a.onerror = () => resolve(false);
      a.play().catch(() => resolve(false));
    };
    next();
  });
}

export async function say(info, voiceURI = '') {
  if (clips && clips.files.size) {
    const seq = clipSequence(info);
    if (seq.every((n) => clips.files.has(n))) {
      if (await playSequence(seq)) return true;
    }
  }
  return speakText(sentence(info), voiceURI);
}
