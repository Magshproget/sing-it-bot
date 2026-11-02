import { EventEmitter } from 'node:events';
import { calculateRmsDbfs, pcmToWav } from './audioUtils.js';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // 16-bit
const FRAME_DURATION_MS = 20;
const FRAME_SIZE_BYTES = (SAMPLE_RATE * (FRAME_DURATION_MS / 1000)) * BYTES_PER_SAMPLE; // 640 bytes

const RMS_VOICED_THRESHOLD_DBFS = -36;
const MIN_VOICED_MS = 400; // minimum voiced duration to consider speech
const MAX_CHUNK_DURATION_MS = 4500; // cut chunk at 4.5s
const SILENCE_SPLIT_MS = 1000; // split on 1s pause
const MIN_CHUNK_DURATION_MS = 700; // drop chunks shorter than 0.7s

/**
 * AudioChunker collects 16kHz mono PCM frames from one speaker,
 * runs VAD and emits 'chunk' events containing ready WAV buffers.
 */
export class AudioChunker extends EventEmitter {
  constructor(userId) {
    super();
    this.userId = userId;
    this.audioBuffer = []; // array of frame Buffers
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.totalChunkMs = 0;
    this.lastChunkPcm = null;
    this.lastChunkTime = 0;
    this.residualBuffer = Buffer.alloc(0);
  }

  /**
   * Push newly downsampled 16kHz mono PCM bytes
   */
  push(pcmBytes) {
    let combined = Buffer.concat([this.residualBuffer, pcmBytes]);

    while (combined.length >= FRAME_SIZE_BYTES) {
      const frame = combined.subarray(0, FRAME_SIZE_BYTES);
      combined = combined.subarray(FRAME_SIZE_BYTES);
      this._processFrame(frame);
    }

    this.residualBuffer = combined;
  }

  _processFrame(frame) {
    const rmsDbfs = calculateRmsDbfs(frame);
    const isVoiced = rmsDbfs > RMS_VOICED_THRESHOLD_DBFS;

    if (isVoiced) {
      this.voicedMs += FRAME_DURATION_MS;
      this.silenceMs = 0;
    } else {
      this.silenceMs += FRAME_DURATION_MS;
    }

    this.audioBuffer.push(frame);
    this.totalChunkMs += FRAME_DURATION_MS;

    // Conditions to emit a chunk:
    // 1. Max chunk duration reached
    // 2. We had speech (>= MIN_VOICED_MS) and now have a silence pause (>= SILENCE_SPLIT_MS)
    const reachedMax = this.totalChunkMs >= MAX_CHUNK_DURATION_MS;
    const reachedPause = this.voicedMs >= MIN_VOICED_MS && this.silenceMs >= SILENCE_SPLIT_MS;

    if (reachedMax || reachedPause) {
      this._flush();
    }
  }

  _flush() {
    if (this.audioBuffer.length === 0) return;

    const currentPcm = Buffer.concat(this.audioBuffer);
    const durationMs = this.totalChunkMs;
    const voicedMs = this.voicedMs;

    this.audioBuffer = [];
    this.totalChunkMs = 0;
    this.voicedMs = 0;
    this.silenceMs = 0;

    // Drop if total duration too short or not enough voiced energy
    if (durationMs < MIN_CHUNK_DURATION_MS || voicedMs < MIN_VOICED_MS) {
      return;
    }

    const wavBuffer = pcmToWav(currentPcm, SAMPLE_RATE, 1, 16);

    // Also prepare a joined retry buffer if previous chunk was <= 10s ago
    let joinedWav = null;
    const now = Date.now();
    if (this.lastChunkPcm && (now - this.lastChunkTime) <= 10000) {
      const joinedPcm = Buffer.concat([this.lastChunkPcm, currentPcm]);
      joinedWav = pcmToWav(joinedPcm, SAMPLE_RATE, 1, 16);
    }

    this.lastChunkPcm = currentPcm;
    this.lastChunkTime = now;

    this.emit('chunk', {
      userId: this.userId,
      wavBuffer,
      joinedWav,
      durationMs,
    });
  }

  /**
   * Final flush when user stops speaking or stream ends
   */
  finish() {
    this._flush();
  }
}
