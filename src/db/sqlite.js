import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let dbInstance = null;

export function getDatabase(dbPath = process.env.SQLITE_DB_PATH || 'data/lyrics.db') {
  if (dbInstance) return dbInstance;

  const resolvedPath = path.resolve(process.cwd(), dbPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Initialize schema if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_name TEXT NOT NULL,
      track_name TEXT NOT NULL,
      album_name TEXT,
      lyrics TEXT NOT NULL,
      source TEXT DEFAULT 'manual'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
      artist_name,
      track_name,
      lyrics,
      content='songs',
      content_rowid='id'
    );

    -- Triggers to keep FTS index synced
    CREATE TRIGGER IF NOT EXISTS songs_ai AFTER INSERT ON songs BEGIN
      INSERT INTO songs_fts(rowid, artist_name, track_name, lyrics)
      VALUES (new.id, new.artist_name, new.track_name, new.lyrics);
    END;

    CREATE TRIGGER IF NOT EXISTS songs_ad AFTER DELETE ON songs BEGIN
      INSERT INTO songs_fts(songs_fts, rowid, artist_name, track_name, lyrics)
      VALUES('delete', old.id, old.artist_name, old.track_name, old.lyrics);
    END;

    CREATE TRIGGER IF NOT EXISTS songs_au AFTER UPDATE ON songs BEGIN
      INSERT INTO songs_fts(songs_fts, rowid, artist_name, track_name, lyrics)
      VALUES('delete', old.id, old.artist_name, old.track_name, old.lyrics);
      INSERT INTO songs_fts(rowid, artist_name, track_name, lyrics)
      VALUES (new.id, new.artist_name, new.track_name, new.lyrics);
    END;
  `);

  dbInstance = db;
  return dbInstance;
}

/**
 * Insert or replace song into local DB
 */
export function insertSong({ artist, title, album = '', lyrics, source = 'manual' }) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO songs (artist_name, track_name, album_name, lyrics, source)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(artist, title, album, lyrics, source);
}

/**
 * Search songs by lyric snippet using FTS5 match query
 */
export function searchLyricsLocal(query, limit = 5) {
  const db = getDatabase();
  // Clean query for FTS5 (keep only unicode letters, digits and whitespace)
  const terms = query
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 1);

  if (terms.length === 0) return [];

  // FTS5 phrase or near match
  const ftsQuery = `"${terms.join(' ')}"`;

  try {
    const stmt = db.prepare(`
      SELECT s.id, s.artist_name AS artist, s.track_name AS title, s.lyrics
      FROM songs_fts f
      JOIN songs s ON f.rowid = s.id
      WHERE songs_fts MATCH ?
      LIMIT ?
    `);
    const results = stmt.all(ftsQuery, limit);
    if (results.length > 0) return results;

    // Fallback: search with NEAR or individual terms
    const orQuery = terms.join(' OR ');
    const fallbackStmt = db.prepare(`
      SELECT s.id, s.artist_name AS artist, s.track_name AS title, s.lyrics, bm25(songs_fts) AS rank
      FROM songs_fts f
      JOIN songs s ON f.rowid = s.id
      WHERE songs_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return fallbackStmt.all(orQuery, limit);
  } catch (err) {
    console.error('[DB] FTS search error:', err.message);
    return [];
  }
}
