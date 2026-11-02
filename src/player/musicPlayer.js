import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  demuxProbe,
} from '@discordjs/voice';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { normalize } from '../matcher/scorer.js';

export class MusicPlayer extends EventEmitter {
  constructor(textChannel) {
    super();
    this.textChannel = textChannel;
    this.player = createAudioPlayer();
    this.currentTrack = null;
    this.queue = [];
    this.history = []; // last 20 played tracks
    this.recentPlayedNormalized = new Map(); // normalized title -> timestamp
    this.activeYtdlpProcess = null;

    this.player.on(AudioPlayerStatus.Idle, () => {
      this._onTrackEnded();
    });

    this.player.on('error', (err) => {
      console.error('[Player] Audio player error:', err.message);
      this._onTrackEnded();
    });
  }

  isSongRecentlyPlayed(title, artist = '') {
    const full = normalize(`${artist} ${title}`);
    const justTitle = normalize(title);
    const now = Date.now();
    const cooldownMs = 2 * 60 * 1000; // 2 minutes

    for (const key of [full, justTitle]) {
      if (this.recentPlayedNormalized.has(key)) {
        if (now - this.recentPlayedNormalized.get(key) < cooldownMs) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Play or queue a song
   */
  async play(query, metadata = {}) {
    const trackItem = {
      query,
      title: metadata.title || query,
      artist: metadata.artist || '',
      triggeredByVoice: !!metadata.triggeredByVoice,
    };

    // If currently playing something
    if (this.currentTrack) {
      this.queue.push(trackItem);
      this._notify(`Додано в чергу: **${trackItem.title}**`);
      return;
    }

    await this._startStream(trackItem);
  }

  /**
   * Start yt-dlp process and stream Opus/WebM to AudioPlayer
   */
  async _startStream(trackItem) {
    this._killStreamProcess();

    const searchQuery = trackItem.query.startsWith('http')
      ? trackItem.query
      : `ytsearch1:${trackItem.artist} ${trackItem.title}`.trim();

    console.log(`[Player] Streaming with yt-dlp: "${searchQuery}"`);

    const args = [
      '--no-playlist',
      '--default-search', 'ytsearch1',
      '--extractor-args', 'youtube:player_client=visionos,default',
      '-f', 'bestaudio[acodec=opus]/bestaudio',
      '--print', 'before_dl:TITLE:%(title)s',
      '-o', '-',
      searchQuery,
    ];

    const ytdlp = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.activeYtdlpProcess = ytdlp;

    let realTitle = trackItem.title;

    ytdlp.stderr.on('data', (data) => {
      const text = data.toString();
      const match = text.match(/TITLE:(.+)/);
      if (match) {
        realTitle = match[1].trim();
        trackItem.title = realTitle;
      }
    });

    try {
      const { stream, type } = await demuxProbe(ytdlp.stdout);
      const resource = createAudioResource(stream, { inputType: type });

      this.currentTrack = trackItem;
      const norm = normalize(`${trackItem.artist} ${trackItem.title}`);
      this.recentPlayedNormalized.set(norm, Date.now());

      this.player.play(resource);

      const msg = trackItem.triggeredByVoice
        ? `🎤 Впізнано пісню: **${trackItem.artist ? `${trackItem.artist} – ` : ''}${trackItem.title}**`
        : `🎶 Грає: **${trackItem.title}**`;

      this._notify(msg);
      this.emit('playing', trackItem);
    } catch (err) {
      console.error('[Player] Failed to probe audio stream:', err.message);
      this._notify(`⚠️ Помилка запуску відтворення: ${err.message}`);
      this._onTrackEnded();
    }
  }

  _onTrackEnded() {
    if (this.currentTrack) {
      this.history.unshift(this.currentTrack);
      if (this.history.length > 20) this.history.pop();
      this.currentTrack = null;
    }

    if (this.queue.length > 0) {
      const nextTrack = this.queue.shift();
      this._startStream(nextTrack);
    }
  }

  skip() {
    if (!this.currentTrack) return false;
    this._notify('⏭️ Пропущено трек');
    this.player.stop();
    return true;
  }

  stop() {
    this.queue = [];
    this.currentTrack = null;
    this._killStreamProcess();
    this.player.stop();
    this._notify('⏹️ Відтворення зупинено');
    return true;
  }

  back() {
    if (this.history.length === 0) {
      this._notify('ℹ️ Немає попередніх треків у пам’яті');
      return false;
    }
    const previous = this.history.shift(); // take the last played track
    this.stop();
    this.play(previous.query, previous);
    return true;
  }

  _killStreamProcess() {
    if (this.activeYtdlpProcess) {
      try {
        this.activeYtdlpProcess.kill('SIGKILL');
      } catch {}
      this.activeYtdlpProcess = null;
    }
  }

  _notify(text) {
    if (this.textChannel && typeof this.textChannel.send === 'function') {
      this.textChannel.send(text).catch(console.error);
    }
  }
}
