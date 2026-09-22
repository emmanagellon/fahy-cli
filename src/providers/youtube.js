// YouTube provider — kunai youtube/ parity (lite, JS).
// Search: Invidious pool (registry + static fallback + 5min cooldown, like
// kunai's invidious-instance-pool) with yt-dlp `ytsearch` fallback.
// Playback: watch URL handed to mpv — yt-dlp's native YouTube extractor does
// the work, so NO pre-extraction here (source.direct stays falsy).
import { ytSearch } from '../metadata.js';

const REGISTRY = 'https://api.invidious.io/instances.json?sort_by=type,health,api';
const STATIC = [
  'https://invidious.nerdvpn.de',
  'https://inv.nadeko.net',
  'https://invidious.jing.li',
  'https://iv.melmac.space',
  'https://invidious.reallyaweso.me',
  'https://iv.duti.dev',
];
const COOLDOWN_MS = 5 * 60_000;
const cooldown = new Map(); // instance -> until
let cachedPool = null;
let cachedAt = 0;

const normUrl = (u) => {
  // kunai parity: tolerate schemeless registry entries by assuming https.
  const t = String(u || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
};

async function pool(debug) {
  const now = Date.now();
  for (const [k, v] of cooldown) if (v <= now) cooldown.delete(k);
  if (cachedPool && now - cachedAt < 15 * 60_000) {
    const live = cachedPool.filter((u) => (cooldown.get(u) || 0) <= now);
    if (live.length) return live;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(REGISTRY, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
      const j = await res.json();
      if (!Array.isArray(j)) throw new Error('registry bad shape');
      const urls = [...new Set(
        j
          .map((row) => {
            const host = Array.isArray(row) ? row[0] : row?.host || row?.url;
            const meta = Array.isArray(row) ? row[1] : row;
            return normUrl(meta?.uri?.trim() || host);
          })
          .filter((u) => /^https?:\/\//i.test(u) && !/\.(onion|i2p)$/i.test(u) && !/\.ygg$/i.test(u))
      )];
      if (urls.length) {
        cachedPool = urls;
        cachedAt = now;
        return urls.filter((u) => (cooldown.get(u) || 0) <= now);
      }
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    if (debug) console.error(`[youtube] registry: ${e.message}`);
  }
  if (cachedPool?.length) {
    const live = cachedPool.filter((u) => (cooldown.get(u) || 0) <= now);
    if (live.length) return live;
  }
  return STATIC.filter((u) => (cooldown.get(u) || 0) <= now).length
    ? STATIC.filter((u) => (cooldown.get(u) || 0) <= now)
    : STATIC;
}

async function invSearch(query, debug) {
  const params = new URLSearchParams({ q: query, type: 'video', sort_by: 'relevance' });
  const instances = await pool(debug);
  let lastErr;
  for (const inst of instances.slice(0, 4)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await fetch(`${inst}/api/v1/search?${params}`, {
          headers: { Accept: 'application/json', Connection: 'close' }, signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const items = await res.json();
        const videos = (Array.isArray(items) ? items : []).filter((v) => v?.type === 'video' && v?.videoId);
        if (videos.length) return videos;
        throw new Error('no videos');
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      lastErr = e;
      cooldown.set(inst, Date.now() + COOLDOWN_MS);
      if (debug) console.error(`[youtube] ${inst}: ${e.message}`);
    }
  }
  throw lastErr || new Error('No healthy Invidious instances');
}

export function toTrack(v) {
  // Video ids are 11 chars; channels (UC…, 24 chars) and playlists sometimes
  // leak through search results — drop anything that can't play as a video.
  if (!/^[A-Za-z0-9_-]{11}$/.test(v.videoId || '')) return null;
  return {
    kind: 'youtube',
    videoId: v.videoId,
    title: v.title,
    author: v.author,
    duration: v.lengthSeconds || null,
    views: v.viewCount ?? null,
    published: v.publishedText || null,
    live: !!v.liveNow,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
  };
}

export const youtube = {
  id: 'youtube',
  name: 'YouTube',
  site: 'youtube.com via Invidious (kunai-style) + yt-dlp fallback',
  sites: ['https://www.youtube.com'],
  tokens: ['youtube'],
  direct: false, // mpv's ytdl hook extracts — never pre-extract here
  kinds: ['youtube'],
  async search(query, opts = {}) {
    // Invidious first (fast, no yt-dlp spawn); yt-dlp ytsearch fallback.
    try {
      return (await invSearch(query, opts.debug)).slice(0, 10).map(toTrack).filter(Boolean);
    } catch (e) {
      if (opts.debug) console.error(`[youtube] invidious failed, ytsearch fallback: ${e.message}`);
      return ytSearch(query, 10, opts);
    }
  },
  async resolve(media, opts = {}) {
    void opts;
    const id = media.videoId || parseVideoId(media.url || '');
    if (!id) throw new Error('YouTube needs a video id or watch URL');
    const url = `https://www.youtube.com/watch?v=${id}`;
    return { embedUrl: url, sources: [{ url, quality: 'auto', type: 'youtube', provider: 'youtube', direct: false }] };
  },
};

export function parseVideoId(url) {
  // kunai parity (ids.ts): strict 11-char ids per URL form; channels,
  // playlists, and truncated ids never count as videos.
  const s = String(url || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return (
    /[?&]v=([A-Za-z0-9_-]{11})/.exec(s)?.[1] ||
    /youtu\.be\/([A-Za-z0-9_-]{11})/i.exec(s)?.[1] ||
    /youtube\.com\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/i.exec(s)?.[1] ||
    null
  );
}
