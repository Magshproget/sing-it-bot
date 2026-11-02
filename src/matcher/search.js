import { normalize, partialScore } from './scorer.js';
import { searchLyricsLocal } from '../db/sqlite.js';

// In-memory cache: query -> { results, timestamp }
const queryCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Rate-limiting / Backoff state
let lastGeniusRequestTime = 0;
let geniusBackoffUntil = 0;
const MIN_GENIUS_INTERVAL_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clean up Genius title & artist formatting quirks
 */
function cleanGeniusMetadata(artist, title) {
  let cleanArtist = artist.trim();
  let cleanTitle = title.trim();

  // Strip trailing ASCII transliteration in brackets if rest is Cyrillic/non-Latin
  // e.g. "Щедрик (Shchedryk)" -> "Щедрик"
  const bracketMatch = cleanTitle.match(/^([^\x00-\x7F]+)\s*\([A-Za-z0-9\s.,'ʼ-]+\)$/);
  if (bracketMatch) {
    cleanTitle = bracketMatch[1].trim();
  }

  // Translation page quirk: artist "Genius English Translations", title "Artist - Song (English Translation)"
  if (cleanArtist.toLowerCase().includes('translations')) {
    const splitMatch = cleanTitle.match(/^(.+?)\s*[-–]\s*(.+?)(?:\s*\([^)]*translation[^)]*\))?$/i);
    if (splitMatch) {
      cleanArtist = splitMatch[1].trim();
      cleanTitle = splitMatch[2].trim();
    }
  }

  // Remove trailing "(English Translation)" etc.
  cleanTitle = cleanTitle.replace(/\s*\([^)]*translation[^)]*\)/gi, '').trim();

  return { artist: cleanArtist, title: cleanTitle };
}

/**
 * Search lyrics via Genius API / web endpoint with rate limiting & backoff
 */
async function searchGenius(query) {
  const now = Date.now();
  if (now < geniusBackoffUntil) {
    console.warn(`[Genius] In 429 backoff until ${new Date(geniusBackoffUntil).toLocaleTimeString()}`);
    return [];
  }

  // Enforce spacing between requests
  const timeSinceLast = now - lastGeniusRequestTime;
  if (timeSinceLast < MIN_GENIUS_INTERVAL_MS) {
    await sleep(MIN_GENIUS_INTERVAL_MS - timeSinceLast);
  }
  lastGeniusRequestTime = Date.now();

  const token = process.env.GENIUS_ACCESS_TOKEN;
  let url;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  if (token) {
    // Official API
    url = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    // Public web lyric search
    url = `https://genius.com/api/search/lyric?q=${encodeURIComponent(query)}`;
  }

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });

    if (res.status === 429) {
      geniusBackoffUntil = Date.now() + 30000; // 30s backoff
      console.warn('[Genius] HTTP 429 Rate limited! Backing off for 30s');
      return [];
    }

    if (!res.ok) {
      console.warn(`[Genius] HTTP ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    const hits = data?.response?.sections?.[0]?.hits || data?.response?.hits || [];

    const candidates = [];
    for (const hit of hits) {
      const result = hit.result;
      if (!result) continue;

      const rawArtist = result.primary_artist?.name || '';
      const rawTitle = result.title || '';
      const { artist, title } = cleanGeniusMetadata(rawArtist, rawTitle);

      // In public lyric search, hit.highlights contains matching snippet
      let snippet = '';
      if (hit.highlights && Array.isArray(hit.highlights)) {
        snippet = hit.highlights.map(h => h.value).join(' ');
      }

      candidates.push({
        artist,
        title,
        snippet,
        source: 'genius',
      });
    }

    return candidates;
  } catch (err) {
    console.error('[Genius] Search error:', err.message);
    return [];
  }
}

/**
 * Fetch full lyrics from lrclib to verify a match
 */
export async function fetchLyricsLrclib(artist, title) {
  try {
    const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SingItBot/1.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.plainLyrics || data?.syncedLyrics || null;
  } catch {
    return null;
  }
}

/**
 * Main lyric search & scoring coordinator:
 * 1. Check local cache
 * 2. Search Local SQLite FTS5 (if enabled or available)
 * 3. Search Genius API (with throttle/backoff)
 * 4. Score snippets & verify candidates against threshold
 */
export async function findSongByLyrics(transcript) {
  const normLine = normalize(transcript);
  const words = normLine.split(' ').filter(Boolean);

  // Requirement: at least 5 words to prevent false positives
  if (words.length < 5) {
    return null;
  }

  // Check cache
  if (queryCache.has(normLine)) {
    const cached = queryCache.get(normLine);
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const provider = process.env.LYRIC_SEARCH_PROVIDER || 'genius';
  let candidates = [];

  // 1. Try local SQLite
  if (provider === 'sqlite' || provider === 'both') {
    const localResults = searchLyricsLocal(transcript, 5);
    for (const item of localResults) {
      const score = partialScore(normLine, item.lyrics);
      candidates.push({
        artist: item.artist,
        title: item.title,
        lyrics: item.lyrics,
        score,
        source: 'sqlite',
      });
    }
  }

  // 2. Try Genius if needed
  if ((provider === 'genius' || provider === 'both') && candidates.every(c => c.score < 0.72)) {
    const geniusCandidates = await searchGenius(transcript);
    for (const gc of geniusCandidates) {
      let score = 0;
      if (gc.snippet) {
        score = partialScore(normLine, gc.snippet);
      }
      candidates.push({
        ...gc,
        score,
      });
    }
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    queryCache.set(normLine, { result: null, timestamp: Date.now() });
    return null;
  }

  let top = candidates[0];

  // If score is borderline (0.50 .. 0.72) and we only had a short snippet, fetch full lyrics from lrclib to rescore
  if (top.score >= 0.50 && top.score < 0.72) {
    const fullLyrics = await fetchLyricsLrclib(top.artist, top.title);
    if (fullLyrics) {
      const rescore = partialScore(normLine, fullLyrics);
      top.score = Math.max(top.score, rescore);
      top.lyrics = fullLyrics;
    }
  }

  // Check threshold:
  // Immediate trigger if score >= 0.85
  // Candidate match if score >= 0.72
  let result = null;
  if (top.score >= 0.72) {
    result = {
      artist: top.artist,
      title: top.title,
      score: top.score,
      immediate: top.score >= 0.85,
    };
  }

  queryCache.set(normLine, { result, timestamp: Date.now() });
  return result;
}
