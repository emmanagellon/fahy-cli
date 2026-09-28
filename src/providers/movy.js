// Movy provider — TMDB-backed movie/TV streaming (FMHY top-rated).
// Chain: TMDB search -> API -> embed page -> HLS stream.
import { fetchText, fetchJsonVia } from '../net.js';
import { parseLadder } from '../hls.js';

const BASE = 'https://www.movy.sx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

async function movyFetch(url, opts = {}) {
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
  // Look for m3u8 URLs in the page
  const m3u8Match = /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/.exec(html);
  if (m3u8Match) return m3u8Match[0];
  // Look for playlist URL
  const playlistMatch = /playlist[^"'\s]*\.m3u8[^"'\s]*/.exec(html);
  if (playlistMatch) return playlistMatch[0];
  return null;
}

export const movy = {
  id: 'movy',
  name: 'Movy',
  site: 'movy.sx (FMHY movies/TV)',
  sites: ['https://www.movy.sx'],
  tokens: ['movy'],
  direct: true,
  kinds: ['movie', 'tv'],

  async search(query, opts = {}) {
    return [];
  },

  async resolve(media, opts = {}) {
    const tmdbId = media.tmdbId;
    if (!tmdbId) throw new Error('Movy needs a TMDB ID');

    const kind = media.kind === 'tv' ? 'tv' : 'movie';
    const audio = opts.audio === 'dub' ? 'dub' : 'sub';

    // 1. Get embed URL from API
    const apiUrl = kind === 'tv'
      ? `${BASE}/api/tv/${tmdbId}/${media.season || 1}/${media.episode || 1}`
      : `${BASE}/api/movie/${tmdbId}`;

    const apiBody = await movyFetch(apiUrl, opts);
    const embedPath = parseApiSrc(apiBody);
    if (!embedPath) throw new Error('Movy API returned no embed URL');

    // 2. Fetch embed page
    const embedHtml = await movyFetch(BASE + embedPath, opts);
    const streamUrl = parseEmbedPage(embedHtml);
    if (!streamUrl) throw new Error('Movy embed page parse failed');

    // 3. Validate HLS
    const streamHtml = await movyFetch(streamUrl, opts);
    if (!streamHtml.startsWith('#EXTM3U')) throw new Error('Movy stream is not HLS');

    // 4. Parse ladder
    const variants = parseLadder(streamHtml, streamUrl);
    const headers = { Referer: BASE + '/', 'User-Agent': UA };

    const sources = (variants.length ? variants : [{ url: streamUrl, quality: 'auto', rank: 0 }]).map((v) => ({
      url: v.url,
      quality: `${v.quality} ${audio}`,
      type: 'hls',
      provider: 'movy',
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
