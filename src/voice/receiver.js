import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { downsample48kStereoTo16kMono } from './audioUtils.js';
import { AudioChunker } from './chunker.js';
import { transcribeWav } from '../stt/whisper.js';
import { parseVoiceCommand, normalize } from '../matcher/scorer.js';
import { findSongByLyrics } from '../matcher/search.js';

export function setupVoiceReceiver(connection, player, botUserId) {
  const speakerChunkers = new Map(); // userId -> AudioChunker
  const candidateHistory = new Map(); // userId -> { title, artist, timestamp }

  connection.receiver.speaking.on('start', (userId) => {
    // Ignore the bot's own voice
    if (userId === botUserId) return;

    if (!speakerChunkers.has(userId)) {
      const chunker = new AudioChunker(userId);
      speakerChunkers.set(userId, chunker);

      chunker.on('chunk', async ({ wavBuffer, joinedWav, durationMs }) => {
        try {
          const t0 = Date.now();
          let transcript = await transcribeWav(wavBuffer);

          // If empty and joined buffer exists, try once with joined
          if (!transcript && joinedWav) {
            transcript = await transcribeWav(joinedWav);
          }

          if (!transcript) return;

          const words = transcript.trim().split(/\s+/);
          const elapsedMs = Date.now() - t0;
          console.log(`[STT] User ${userId} (${durationMs}ms audio -> ${elapsedMs}ms): heard ${words.length} words`);

          // 1. Voice command check (handled before lyric search)
          const command = parseVoiceCommand(transcript);
          if (command) {
            console.log(`[VoiceCommand] Detected command: ${command.type}`);
            if (command.type === 'stop') player.stop();
            else if (command.type === 'skip') player.skip();
            else if (command.type === 'back') player.back();
            else if (command.type === 'play') player.play(command.query);
            return;
          }

          // 2. Sung line search (requires >= 5 words)
          if (words.length < 5) return;

          const match = await findSongByLyrics(transcript);
          if (!match) return;

          console.log(`[Match] Candidate: "${match.artist} - ${match.title}" (score: ${match.score.toFixed(2)})`);

          if (player.isSongRecentlyPlayed(match.title, match.artist)) {
            console.log('[Match] Song recently played or playing, ignoring.');
            return;
          }

          // Immediate trigger if score >= 0.85
          if (match.immediate) {
            console.log(`[Trigger] High confidence match (${match.score.toFixed(2)}): playing!`);
            candidateHistory.delete(userId);
            await player.play(`${match.artist} ${match.title}`.trim(), {
              artist: match.artist,
              title: match.title,
              triggeredByVoice: true,
            });
            return;
          }

          // Otherwise (0.72 <= score < 0.85), require two consecutive chunks within 30s
          const now = Date.now();
          const prev = candidateHistory.get(userId);
          const currentNormTitle = normalize(match.title);

          if (prev && (now - prev.timestamp <= 30000) && normalize(prev.title) === currentNormTitle) {
            console.log(`[Trigger] Two consecutive matches for "${match.title}": playing!`);
            candidateHistory.delete(userId);
            await player.play(`${match.artist} ${match.title}`.trim(), {
              artist: match.artist,
              title: match.title,
              triggeredByVoice: true,
            });
          } else {
            candidateHistory.set(userId, {
              title: match.title,
              artist: match.artist,
              timestamp: now,
            });
          }
        } catch (err) {
          console.error('[VoiceReceiver] Error processing chunk:', err.message);
        }
      });
    }

    const chunker = speakerChunkers.get(userId);

    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 800,
      },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    opusStream
      .pipe(decoder)
      .on('data', (pcm48) => {
        const pcm16Mono = downsample48kStereoTo16kMono(pcm48);
        chunker.push(pcm16Mono);
      })
      .on('error', (err) => {
        console.error(`[OpusDecoder] Error for user ${userId}:`, err.message);
      });

    opusStream.on('end', () => {
      chunker.finish();
    });
  });

  return {
    cleanup: () => {
      speakerChunkers.clear();
      candidateHistory.clear();
    },
  };
}
