/**
 * String normalization:
 * - lowercase
 * - replace 'ё' with 'е'
 * - strip apostrophes
 * - remove punctuation and brackets, keep all unicode letters and numbers
 * - collapse multiple spaces
 */
export function normalize(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/['’`ʼ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Standard Levenshtein distance
 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let v0 = new Array(b.length + 1);
  let v1 = new Array(b.length + 1);

  for (let i = 0; i <= b.length; i++) v0[i] = i;

  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}

/**
 * Word-window similarity score:
 * Compares transcript to any word window of lyrics of size (transcript_words ± 1).
 * Score = 1 - (Levenshtein / max(len(a), len(b)))
 */
export function partialScore(line, lyrics) {
  let a = normalize(line);
  let b = normalize(lyrics);
  if (!a || !b) return 0;

  const aWords = a.split(' ').filter(Boolean);
  const words = b.split(' ').filter(Boolean);
  if (aWords.length === 0 || words.length === 0) return 0;

  const n = aWords.length;
  let best = 0;

  for (let i = 0; i < words.length; i++) {
    for (const w of [n - 1, n, n + 1]) {
      if (w < 1 || i + w > words.length) continue;
      const win = words.slice(i, i + w).join(' ');
      const dist = levenshtein(a, win);
      const score = 1 - dist / Math.max(a.length, win.length);
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * Voice commands detection before lyric search
 */
export function parseVoiceCommand(transcript) {
  const norm = normalize(transcript);
  if (!norm) return null;

  // Stop commands
  if (['стоп', 'stop', 'вимкни музику', 'вимкни', 'пауза'].includes(norm)) {
    return { type: 'stop' };
  }

  // Next / Skip commands
  if (['дали', 'next', 'скип', 'наступна', 'пропусти'].includes(norm)) {
    return { type: 'skip' };
  }

  // Back / Previous commands
  if (['назад', 'минула', 'попередня', 'back', 'prev'].includes(norm)) {
    return { type: 'back' };
  }

  // Play direct command: "увімкни <artist title>" / "play <artist title>"
  const playMatchUk = norm.match(/^(?:увімкни|включи|заграй|грай)\s+(.+)$/);
  if (playMatchUk && playMatchUk[1].trim().length > 2) {
    return { type: 'play', query: playMatchUk[1].trim() };
  }
  const playMatchEn = norm.match(/^(?:play)\s+(.+)$/);
  if (playMatchEn && playMatchEn[1].trim().length > 2) {
    return { type: 'play', query: playMatchEn[1].trim() };
  }

  return null;
}
