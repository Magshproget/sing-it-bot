import fs from 'node:fs';
import readline from 'node:readline';
import { getDatabase, insertSong } from '../src/db/sqlite.js';

/**
 * Script to import lyrics into SQLite FTS5 database.
 * Supports:
 * 1. JSON file containing array of { artist, title, album, lyrics }
 * 2. JSONL file (one JSON object per line)
 */
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log('Usage: node scripts/import-lyrics.js <path-to-lyrics.json-or-jsonl>');
    process.exit(1);
  }

  const db = getDatabase();
  console.log(`[Import] Importing from ${filePath}...`);

  const insert = db.transaction((songs) => {
    for (const s of songs) {
      if (s.lyrics && s.track_name && s.artist_name) {
        insertSong({
          artist: s.artist_name,
          title: s.track_name,
          album: s.album_name || '',
          lyrics: s.lyrics,
          source: 'import',
        });
      }
    }
  });

  if (filePath.endsWith('.json')) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = Array.isArray(data) ? data : [data];
    insert(list);
    console.log(`[Import] Inserted ${list.length} songs.`);
  } else {
    // Stream line by line for large files
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let batch = [];
    let total = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        batch.push(item);
        if (batch.length >= 1000) {
          insert(batch);
          total += batch.length;
          console.log(`[Import] Processed ${total} songs...`);
          batch = [];
        }
      } catch {}
    }

    if (batch.length > 0) {
      insert(batch);
      total += batch.length;
    }
    console.log(`[Import] Finished! Total inserted: ${total} songs.`);
  }
}

main().catch(console.error);
