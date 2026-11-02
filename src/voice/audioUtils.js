/**
 * Downsample 48kHz 16-bit stereo PCM to 16kHz 16-bit mono PCM.
 * Input buffer: 48kHz 2 channels 16-bit LE (4 bytes per sample frame).
 * Downsampling factor: 3 (48000 / 16000 = 3).
 * Stereo -> Mono: average of Left and Right channels.
 */
export function downsample48kStereoTo16kMono(buffer) {
  const bytesPerFrame48k = 4; // 2 bytes L + 2 bytes R
  const totalFrames48k = Math.floor(buffer.length / bytesPerFrame48k);
  const totalFrames16k = Math.floor(totalFrames48k / 3);

  const outBuffer = Buffer.alloc(totalFrames16k * 2); // 2 bytes per 16-bit mono sample

  for (let i = 0; i < totalFrames16k; i++) {
    const srcFrameIdx = i * 3;
    const offset = srcFrameIdx * bytesPerFrame48k;

    // Average left and right channel for this frame
    const left = buffer.readInt16LE(offset);
    const right = buffer.readInt16LE(offset + 2);
    const mono = Math.round((left + right) / 2);

    outBuffer.writeInt16LE(mono, i * 2);
  }

  return outBuffer;
}

/**
 * Calculates audio RMS (in dBFS) for 16-bit mono PCM.
 * Full scale is 32768.
 */
export function calculateRmsDbfs(pcm16MonoBuffer) {
  const numSamples = Math.floor(pcm16MonoBuffer.length / 2);
  if (numSamples === 0) return -100;

  let sumSquares = 0;
  for (let i = 0; i < numSamples; i++) {
    const sample = pcm16MonoBuffer.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / numSamples);
  if (rms <= 0) return -100;

  // dBFS calculation
  return 20 * Math.log10(rms / 32768);
}

/**
 * Wraps raw 16kHz 16-bit mono PCM in a standard 44-byte WAV header.
 */
export function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0); // ChunkID
  header.writeUInt32LE(36 + dataSize, 4); // ChunkSize
  header.write('WAVE', 8); // Format
  header.write('fmt ', 12); // Subchunk1ID
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  header.writeUInt16LE(numChannels, 22); // NumChannels
  header.writeUInt32LE(sampleRate, 24); // SampleRate
  header.writeUInt32LE(byteRate, 28); // ByteRate
  header.writeUInt16LE(blockAlign, 32); // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34); // BitsPerSample
  header.write('data', 36); // Subchunk2ID
  header.writeUInt32LE(dataSize, 40); // Subchunk2Size

  return Buffer.concat([header, pcmBuffer]);
}
