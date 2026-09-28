// VixSrc provider — TMDB-backed movie/TV streaming (pandaflix vixsrc parity).
// Chain: TMDB search -> API (/api/movie/:id or /api/tv/:id/:s/:e) -> embed page
// -> parse playlist URL + token + expires -> master playlist (h=1) -> HLS.
// English subtitles extracted from master playlist EXT-X-MEDIA entries.
import { fetchText, fetchJsonVia } from '../net.js';
import { parseLadder } from '../hls.js';

const BASE = 'https://vixsrc.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

async function vixsrcFetch(url, opts = {}) {
  return fetchText(url, {
    userAgent: UA,
    referer: BASE + '/',
    timeoutMs: TIMEOUT,
    signal: opts.signal,
    debug: opts.debug,
  });
}

// Parse the API response to get the embed URL path
function parseApiSrc(body) {
  try {
    const data = JSON.parse(body);
    if (data?.src && data.src.startsWith('/embed/')) return data.src;
  } catch {}
  return null;
}

// Parse embed page HTML for playlist URL, token, and expires
function parseEmbedPage(html) {
  const playlistMatch = /url:\s*'(https:\/\/vixsrc\.to\/playlist\/[0-9]+(?:\?[^']*)?)'/.exec(html);
  const tokenMatch = /'token':\s*'([^']+)'/.exec(html);
  const expiresMatch = /'expires':\s*'([^']+)'/.exec(html);
  if (!playlistMatch || !tokenMatch || !expiresMatch) return null;
  return {
    playlistUrl: playlistMatch[1],
    token: tokenMatch[1],
    expires: expiresMatch[1],
  };
}

// Build the master playlist URL with required h=1 flag
function buildMasterUrl(playlistUrl, token, expires) {
  const u = new URL(playlistUrl);
  u.searchParams.set('token', token);
  u.searchParams.set('expires', expires);
  u.searchParams.set('asn', '');
  u.searchParams.set('h', '1');
  return u.toString();
}

// Extract English subtitle URL from master playlist
function extractSubtitleUrl(masterText) {
  const lines = masterText.split('\n');
  let fallback = null;
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    if (!/TYPE=SUBTITLES/i.test(line)) continue;
    const uriMatch = /URI="([^"]+)"/.exec(line);
    if (!uriMatch) continue;
    const lang = (/LANGUAGE="([^"]+)"/i.exec(line)?.[1] || '').toLowerCase();
    const name = (/NAME="([^"]+)"/i.exec(line)?.[1] || '').toLowerCase();
    if (lang === 'eng' || lang === 'en' || name.includes('english')) {
      return uriMatch[1];
    }
    if (!fallback) fallback = uriMatch[1];
  }
  return fallback;
}

export const vixsrc = {
  id: 'vixsrc',
  name: 'VixSrc',
  site: 'vixsrc.to (FMHY movies/TV)',
  sites: ['https://vixsrc.to'],
  tokens: ['vixsrc'],
  direct: true,
  kinds: ['movie', 'tv'],

  // VixSrc uses TMDB IDs — search is done via TMDB, not the provider itself.
  // The provider's search is a passthrough; the caller uses tmdb.searchTmdb.
  async search(query, opts = {}) {
    // Return empty — TMDB search handles movie/TV queries.
    // The caller merges TMDB results with provider capability.
    return [];
  },

  async resolve(media, opts = {}) {
    const tmdbId = media.tmdbId;
    if (!tmdbId) throw new Error('VixSrc needs a TMDB ID');

    const kind = media.kind === 'tv' ? 'tv' : 'movie';
    const audio = opts.audio === 'dub' ? 'dub' : 'sub';
    let apiUrl;
    if (kind === 'tv') {
      const season = media.season || 1;
      const episode = media.episode || 1;
      apiUrl = `${BASE}/api/tv/${tmdbId}/${season}/${episode}`;
    } else {
      apiUrl = `${BASE}/api/movie/${tmdbId}`;
    }

    // 1. API call to get embed URL
    const apiBody = await vixsrcFetch(apiUrl, opts);
    const embedPath = parseApiSrc(apiBody);
    if (!embedPath) throw new Error('VixSrc API returned no embed URL');

    // 2. Fetch embed page
    const embedHtml = await vixsrcFetch(BASE + embedPath, opts);
    const embedData = parseEmbedPage(embedHtml);
    if (!embedData) throw new Error('VixSrc embed page parse failed');

    // 3. Build and fetch master playlist
    const masterUrl = buildMasterUrl(embedData.playlistUrl, embedData.token, embedData.expires);
    const masterText = await vixsrcFetch(masterUrl, opts);
    if (!masterText.startsWith('#EXTM3U')) throw new Error('VixSrc master playlist invalid');

    // 4. Parse HLS ladder
    const variants = parseLadder(masterText, masterUrl);
    if (!variants.length) throw new Error('VixSrc no stream variants found');

    // 5. Extract English subtitle (only for sub mode — dub uses the audio track)
    const subUrl = audio === 'sub' ? extractSubtitleUrl(masterText) : null;
    let subFile = null;
    if (subUrl) {
      try {
        const { downloadSub } = await import('../subs.js');
        subFile = await downloadSub(subUrl, `vixsrc-${tmdbId}.vtt`, { 'User-Agent': UA, Referer: BASE + '/' });
      } catch {}
    }

    const headers = { Referer: BASE + '/', 'User-Agent': UA };
    const sources = variants.map((v) => ({
      url: v.url,
      quality: `${v.quality} ${audio}`,
      type: 'hls',
      provider: 'vixsrc',
      direct: true,
      headers,
      ...(subFile ? { subFile } : {}),
    }));

    return { embedUrl: BASE + embedPath, sources };
  },
};
