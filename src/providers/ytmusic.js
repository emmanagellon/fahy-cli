// YouTube Music provider — ytmusic-player parity (lite, JS).
// This yt-dlp build has NO ytmsearch prefix, so music search rides the same
// `ytsearch` engine (music videos live on YouTube anyway). Radio mixes use
// ytmusic-player's RD-playlist trick: watch?v={id}&list=RD{id}, flattened.
// Playback is audio-only mpv (--no-video); the ytdl hook extracts.
import { ytSearch, ytMix } from '../metadata.js';
import { parseVideoId } from './youtube.js';

export const ytmusic = {
  id: 'ytmusic',
  name: 'Music',
  site: 'music.youtube.com via yt-dlp (ytmusic-player-style)',
  sites: ['https://music.youtube.com'],
  tokens: ['ytmusic', 'music'],
  direct: false, // mpv's ytdl hook extracts audio — never pre-extract here
  kinds: ['music'],
  async search(query, opts = {}) {
    return ytSearch(query, 10, opts).map((t) => ({ ...t, kind: 'music' }));
  },
  async radio(videoId, limit = 25, opts = {}) {
    return ytMix(videoId, limit, opts).map((t) => ({ ...t, kind: 'music' }));
  },
  async resolve(media, opts = {}) {
    void opts;
    const id = media.videoId || parseVideoId(media.url || '');
    if (!id) throw new Error('Music needs a video id or watch URL');
    const url = `https://music.youtube.com/watch?v=${id}`;
    return {
      embedUrl: url,
      sources: [{ url, quality: 'audio', type: 'music', provider: 'ytmusic', direct: false, audioOnly: true }],
    };
  },
};
