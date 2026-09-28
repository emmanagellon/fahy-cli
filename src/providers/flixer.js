// Flixer provider — TMDB-backed movie/TV streaming (FMHY top-rated).
// Chain: TMDB search -> API -> embed page -> HLS stream.
import { fetchText, fetchJsonVia } from '../net.js';
import { parseLadder } from '../hls.js';

const BASE = 'https://flixer.gd';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

async function flixerFetch(url, opts = {}) {
  return fetchText(url, {
    userAgent: UA,
    referer: BASE + '/',
    timeoutMs: TIMEOUT,
    signal: opts.signal,
    debug: opts.debug,
  });
}

// Parse embed page for stream URL
function parseEmbedPage(html) {
  const m3u8Match = /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/.exec(html);
  if (m3u8Match) return m3u8Match[0];
  const playlistMatch = /playlist[^"'\s]*\.m3u8[^"'\s]*/.exec(html);
  if (playlistMatch) return playlistMatch[0];
  return null;
}

export const flixer = {
  id: 'flixer',
  name: 'Flixer',
  site: 'flixer.gd (FMHY movies/TV)',
  sites: ['https://flixer.gd', 'https://flixer.su', 'https://flixer.cx'],
  tokens: ['flixer'],
  direct: true,
  kinds: ['movie', 'tv'],

  async search(query, opts = {}) {
    return [];
  },

  async resolve(media, opts = {}) {
    const tmdbId = media.tmdbId;
    if (!tmdbId) throw new Error('Flixer needs a TMDB ID');

    const kind = media.kind === 'tv' ? 'tv' : 'movie';
    const audio = opts.audio === 'dub' ? 'dub' : 'sub';

    // 1. Get embed URL from API
    const apiUrl = kind === 'tv'
      ? `${BASE}/api/tv/${tmdbId}/${media.season || 1}/${media.episode || 1}`
      : `${BASE}/api/movie/${tmdbId}`;

    const apiBody = await flixerFetch(apiUrl, opts);
    const embedPath = parseApiSrc(apiBody);
    if (!embedPath) throw new Error('Flixer API returned no embed URL');

    // 2. Fetch embed page
    const embedHtml = await flixerFetch(BASE + embedPath, opts);
    const streamUrl = parseEmbedPage(embedHtml);
    if (!streamUrl) throw new Error('Flixer embed page parse failed');

    // 3. Validate HLS
    const streamHtml = await flixerFetch(streamUrl, opts);
    if (!streamHtml.startsWith('#EXTM3U')) throw new Error('Flixer stream is not HLS');

    // 4. Parse ladder
    const variants = parseLadder(streamHtml, streamUrl);
    const headers = { Referer: BASE + '/', 'User-Agent': UA };

    const sources = (variants.length ? variants : [{ url: streamUrl, quality: 'auto', rank: 0 }]).map((v) => ({
      url: v.url,
      quality: `${v.quality} ${audio}`,
      type: 'hls',
      provider: 'flixer',
      direct: true,
      headers,
    }));

    return { embedUrl: BASE + embedPath, sources };
  },
};

function parseApiSrc(body) {
  try {
    const data = JSON.parse(body);
    if (data?.src && data.src.startsWith('/embed/')) return data.src;
    if (data?.url && data.url.startsWith('/embed/')) return data.url;
  } catch {}
  return null;
}
