import { spawn } from 'node:child_process';
import path from 'node:path';

let serverProcess = null;
let serverPort = parseInt(process.env.WHISPER_PORT || '8080', 10);
let serverUrl = `http://127.0.0.1:${serverPort}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks if whisper-server is healthy
 */
async function checkHealth() {
  try {
    const res = await fetch(`${serverUrl}/`, { signal: AbortSignal.timeout(1000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Starts whisper-server as a background process and waits for ready status
 */
export async function startWhisperServer() {
  if (serverProcess) {
    if (await checkHealth()) return true;
  }

  const modelPath = path.resolve(
    process.cwd(),
    process.env.WHISPER_MODEL_PATH || 'models/ggml-large-v3-turbo-q5_0.bin'
  );

  console.log(`[Whisper] Starting server on port ${serverPort} with model ${modelPath}...`);

  const args = [
    '-m', modelPath,
    '--port', String(serverPort),
    '--host', '127.0.0.1',
    '-l', 'auto',
    '-t', '4',
    '-bs', '5',
    '-nt',
  ];

  serverProcess = spawn('whisper-server', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.on('error', (err) => {
    console.error('[Whisper] Server process error:', err.message);
  });

  serverProcess.on('exit', (code, signal) => {
    console.log(`[Whisper] Server stopped (code: ${code}, signal: ${signal})`);
    serverProcess = null;
  });

  // Wait for server readiness by polling GET /
  const start = Date.now();
  const timeoutMs = 15000;

  while (Date.now() - start < timeoutMs) {
    await sleep(250);
    if (await checkHealth()) {
      console.log(`[Whisper] Server ready in ${((Date.now() - start) / 1000).toFixed(2)}s`);
      return true;
    }
  }

  throw new Error(`[Whisper] Server did not become ready within ${timeoutMs / 1000}s`);
}

/**
 * Stops whisper-server process
 */
export function stopWhisperServer() {
  if (!serverProcess) return;
  console.log('[Whisper] Stopping server...');
  try {
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
      if (serverProcess) serverProcess.kill('SIGKILL');
    }, 2000);
  } catch (err) {
    console.error('[Whisper] Stop error:', err.message);
  }
  serverProcess = null;
}

/**
 * Transcribe WAV audio buffer via whisper-server /inference endpoint
 * @param {Buffer} wavBuffer 16kHz mono WAV audio
 * @returns {Promise<string>}
 */
export async function transcribeWav(wavBuffer) {
  const formData = new FormData();
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  formData.append('file', blob, 'audio.wav');
  formData.append('response_format', 'json');
  formData.append('temperature', '0.0');

  const res = await fetch(`${serverUrl}/inference`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Whisper inference failed with HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = (data?.text || '').trim();
  return text;
}
