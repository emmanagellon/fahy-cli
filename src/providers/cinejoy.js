// Cinejoy provider — TMDB-backed movie/TV streaming (pandaflix cinejoy parity).
// Chain: TMDB search -> multi-server race (Lisbon/Nebula/Solara) -> HLS streams.
// Cinejoy uses a sealed-request protocol; this implementation uses the direct
// API approach with server failover for resilience.
import { fetchText, fetchJsonVia } from '../net.js';
import { parseLadder } from '../hls.js';

const BASE = 'https://cinejoy.to';
const API = 'https://api.shegu.st';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 15000;
const VERIFIED_SERVERS = ['Lisbon', 'Nebula', 'Solara'];

async function cinejoyFetch(url, opts = {}) {
  return fetchText(url, {
    userAgent: UA,
    referer: BASE + '/',
    timeoutMs: TIMEOUT,
    signal: opts.signal,
    debug: opts.debug,
  });
}

// Fetch the server catalog
async function fetchCatalog(opts) {
  try {
    const body = await cinejoyFetch(`${API}/servers`, opts);
    const data = JSON.parse(body);
    const servers = (data?.servers || [])
      .filter((s) => s.status?.toLowerCase() === 'ok' && VERIFIED_SERVERS.includes(s.name))
      .map((s) => s.name);
    return servers.length ? servers : VERIFIED_SERVERS;
  } catch {
    return VERIFIED_SERVERS;
  }
}

// Try to resolve a stream from a specific server
async function tryServer(serverName, kind, params, opts) {
  const path = `/${serverName}/${kind}`;
  const payload = { path, payload: params };

  // Direct API call (simplified — full implementation uses WASM sealing)
  const url = `${API}/g`;
  const body = await fetchText(url, {
    method: 'POST',
    userAgent: UA,
    referer: BASE + '/',
    contentType: 'text/plain;charset=UTF-8',
    body: JSON.stringify(payload),
    timeoutMs: TIMEOUT,
    signal: opts.signal,
    debug: opts.debug,
  });

  const data = JSON.parse(body);
  if (data?.status < 200 || data?.status >= 300) return null;

  // Extract stream URL from response
  const streams = data?.stream || [];
  for (const s of streams) {
    if (s.playlist && s.playlist.startsWith('https://')) {
      return s.playlist;
    }
    if (s.type === 'file' && s.qualities) {
      const qualities = Object.entries(s.qualities)
        .sort((a, b) => (parseInt(b[0]) || 0) - (parseInt(a[0]) || 0));
      if (qualities.length && qualities[0][1].url) {
        return qualities[0][1].url;
      }
    }
  }
  return null;
}

// Validate that a URL is an HLS playlist
async function validateStream(url, opts) {
  try {
    const text = await cinejoyFetch(url, opts);
    return text.startsWith('#EXTM3U');
  } catch {
    return false;
  }
}

export const cinejoy = {
  id: 'cinejoy',
  name: 'Cinejoy',
  site: 'cinejoy.to (FMHY movies/TV)',
  sites: ['https://cinejoy.to', 'https://cinejoy.pk'],
  tokens: ['cinejoy'],
  direct: true,
  kinds: ['movie', 'tv'],

  // Cinejoy uses TMDB IDs — search is done via TMDB, not the provider itself.
  async search(query, opts = {}) {
    return [];
  },

  async resolve(media, opts = {}) {
    const tmdbId = media.tmdbId;
    if (!tmdbId) throw new Error('Cinejoy needs a TMDB ID');

    const kind = media.kind === 'tv' ? 'series' : 'movie';
    const audio = opts.audio === 'dub' ? 'dub' : 'sub';
    const params = { tmdb: tmdbId, audio };
    if (kind === 'series') {
      params.season = media.season || 1;
      params.episode = media.episode || 1;
    }
    if (media.title) params.title = media.title;
    if (media.year) params.year = media.year;

    // Fetch catalog and race servers
    const servers = await fetchCatalog(opts);
    if (!servers.length) throw new Error('Cinejoy no servers available');

    // Try servers in order (simplified race)
    let lastError = null;
    for (const server of servers) {
      try {
        const streamUrl = await tryServer(server, kind, params, opts);
        if (streamUrl && (await validateStream(streamUrl, opts))) {
          // Parse HLS ladder
          const streamHtml = await cinejoyFetch(streamUrl, opts);
          const variants = parseLadder(streamHtml, streamUrl);
          const headers = { Referer: BASE + '/', 'User-Agent': UA };

          const sources = (variants.length ? variants : [{ url: streamUrl, quality: 'auto', rank: 0 }]).map((v) => ({
            url: v.url,
            quality: `${v.quality} ${audio}`,
            type: 'hls',
            provider: 'cinejoy',
            direct: true,
            headers,
          }));

          return { embedUrl: `${BASE}/${kind}/${tmdbId}`, sources };
        }
      } catch (e) {
        lastError = e;
        if (opts.debug) console.error(`[cinejoy] ${server}: ${e.message}`);
      }
    }

    throw lastError || new Error('Cinejoy all servers failed');
  },
};
