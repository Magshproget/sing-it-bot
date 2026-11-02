import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normalize, levenshtein, partialScore, parseVoiceCommand } from '../src/matcher/scorer.js';
import { getDatabase, insertSong, searchLyricsLocal } from '../src/db/sqlite.js';
import { downsample48kStereoTo16kMono, calculateRmsDbfs, pcmToWav } from '../src/voice/audioUtils.js';
import { startWhisperServer, stopWhisperServer, transcribeWav } from '../src/stt/whisper.js';
import { findSongByLyrics } from '../src/matcher/search.js';

async function runTests() {
  console.log('--- [1/6] Testing Text Normalizer & Scorer ---');
  assert.strictEqual(normalize('Щедрик, щедрик, щедрівочка!'), 'щедрик щедрик щедрівочка');
  assert.strictEqual(normalize('Ёжик в тумане?'), 'ежик в тумане');
  assert.strictEqual(normalize("Don't stop believin'"), 'dont stop believin');

  const lyrics = 'Щедрик щедрик щедрівочка прилетіла ластівочка стала собі щебетати господаря викликати';
  const sung = 'щедрик щедрівочка прилетіла ластівочка';
  const score = partialScore(sung, lyrics);
  console.log(`Fuzzy match score: ${score.toFixed(3)}`);
  assert(score >= 0.85, `Expected score >= 0.85, got ${score}`);

  console.log('--- [2/6] Testing Voice Command Parsing ---');
  assert.deepStrictEqual(parseVoiceCommand('стоп'), { type: 'stop' });
  assert.deepStrictEqual(parseVoiceCommand('вимкни музику'), { type: 'stop' });
  assert.deepStrictEqual(parseVoiceCommand('next'), { type: 'skip' });
  assert.deepStrictEqual(parseVoiceCommand('дали'), { type: 'skip' });
  assert.deepStrictEqual(parseVoiceCommand('назад'), { type: 'back' });
  assert.deepStrictEqual(parseVoiceCommand('увімкни Океан Ельзи Без бою'), {
    type: 'play',
    query: 'океан ельзи без бою',
  });
  assert.strictEqual(parseVoiceCommand('якась випадкова фраза без команд'), null);

  console.log('--- [3/6] Testing Local SQLite FTS5 Database ---');
  const testDbPath = 'temp/test_lyrics.db';
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  process.env.SQLITE_DB_PATH = testDbPath;

  const db = getDatabase(testDbPath);
  insertSong({
    artist: 'Українська народна',
    title: 'Щедрик',
    album: 'Колядки',
    lyrics: 'Щедрик щедрик щедрівочка прилетіла ластівочка стала собі щебетати господаря викликати',
    source: 'test',
  });
  insertSong({
    artist: 'Traditional',
    title: 'Amazing Grace',
    album: 'Hymns',
    lyrics: 'Amazing grace how sweet the sound that saved a wretch like me I once was lost but now am found',
    source: 'test',
  });

  const searchResultsUk = searchLyricsLocal('прилетіла ластівочка стала собі щебетати');
  assert(searchResultsUk.length > 0, 'SQLite FTS search failed for Ukrainian lyrics');
  assert.strictEqual(searchResultsUk[0].title, 'Щедрик');

  const searchResultsEn = searchLyricsLocal('sweet the sound that saved a wretch');
  assert(searchResultsEn.length > 0, 'SQLite FTS search failed for English lyrics');
  assert.strictEqual(searchResultsEn[0].title, 'Amazing Grace');
  console.log('Local SQLite FTS5 search works perfectly!');

  console.log('--- [4/6] Testing Audio Utils & Downsampling ---');
  // 48kHz stereo 1 sec = 48000 frames * 4 bytes = 192000 bytes
  const mock48k = Buffer.alloc(192000);
  for (let i = 0; i < mock48k.length; i += 4) {
    mock48k.writeInt16LE(1000, i); // Left
    mock48k.writeInt16LE(1000, i + 2); // Right
  }
  const pcm16Mono = downsample48kStereoTo16kMono(mock48k);
  // 16kHz mono 1 sec = 16000 samples * 2 bytes = 32000 bytes
  assert.strictEqual(pcm16Mono.length, 32000);
  const rms = calculateRmsDbfs(pcm16Mono);
  console.log(`Calculated RMS dBFS: ${rms.toFixed(2)} dBFS`);
  assert(rms > -35 && rms < -25);

  const wav = pcmToWav(pcm16Mono, 16000, 1, 16);
  assert.strictEqual(wav.length, 32000 + 44);
  assert.strictEqual(wav.subarray(0, 4).toString(), 'RIFF');
  assert.strictEqual(wav.subarray(8, 12).toString(), 'WAVE');

  console.log('--- [5/6] Testing Whisper STT & Search Integration ---');
  const tempWav = path.resolve('temp/sample_speech.wav');
  if (!fs.existsSync('temp')) fs.mkdirSync('temp', { recursive: true });

  execSync('say "amazing grace how sweet the sound that saved a wretch like me" -o temp/sample.aiff');
  execSync(`ffmpeg -y -i temp/sample.aiff -ar 16000 -ac 1 ${tempWav} 2>/dev/null`);

  await startWhisperServer();
  const sampleWavBuffer = fs.readFileSync(tempWav);
  const transcription = await transcribeWav(sampleWavBuffer);
  console.log(`Whisper transcription: "${transcription}"`);
  assert(transcription.length > 0, 'Whisper transcription should not be empty');

  // Test full pipeline with SQLite provider
  process.env.LYRIC_SEARCH_PROVIDER = 'sqlite';
  const found = await findSongByLyrics(transcription);
  console.log('Song recognition result:', found);
  assert(found !== null, 'Song should be recognised from transcription');
  assert.strictEqual(found.title, 'Amazing Grace');

  console.log('--- [6/6] Testing False Positive Resistance ---');
  const shortTalk = 'hello there how are';
  const shortResult = await findSongByLyrics(shortTalk);
  assert.strictEqual(shortResult, null, 'Phrases under 5 words must be ignored');

  stopWhisperServer();
  console.log('\n✅ All offline tests passed successfully!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  stopWhisperServer();
  process.exit(1);
});
