// LookMovie provider — IMDb-keyed movie/TV streaming (pandaflix lookmovie parity).
// Chain: own JSON API search -> view page -> play page (hash/expires) -> access API
// -> HLS stream + English subtitles. Uses IMDb-prefixed slugs for matching.
import { fetchText, fetchJsonVia } from '../net.js';
import { parseLadder } from '../hls.js';

const BASE = 'https://www.lookmovie2.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 20000;

async function lookmovieFetch(url, opts = {}) {
  return fetchText(url, {
    userAgent: UA,
    referer: BASE + '/',
    timeoutMs: TIMEOUT,
    signal: opts.signal,
    debug: opts.debug,
  });
}

// Search LookMovie's own API (movies + shows)
async function searchApi(kind, query, opts) {
  const apiPath = kind === 'tv' ? 'shows' : 'movies';
  const url = `${BASE}/api/v1/${apiPath}/do-search/?q=${encodeURIComponent(query)}`;
  const body = await lookmovieFetch(url, opts);
  try {
    const data = JSON.parse(body);
    return data?.result || [];
  } catch {
    return [];
  }
}

// Parse search results
function parseSearchResults(results, kind) {
  return results
    .filter((r) => r.slug && r.title)
    .map((r) => ({
      id: kind === 'tv' ? `lookmovie|series|${r.slug}` : `lookmovie|movie|${r.slug}`,
      title: r.title,
      year: r.year ? String(r.year).slice(0, 4) : null,
      slug: r.slug,
      kind,
    }));
}

// Parse play page path from view page HTML
function parsePlayLink(html, kind) {
  const regex = kind === 'tv'
    ? /href="(\/shows\/play\/[^"]+)"/
    : /href="(\/movies\/play\/[^"]+)"/;
  return regex.exec(html)?.[1] || null;
}

// Parse hash and expires from play page
function parseStorage(html) {
  const hashMatch = /hash:\s*["']([^"']+)["']/.exec(html);
  const expiresMatch = /expires:\s*(\d+)/.exec(html);
  if (!hashMatch || !expiresMatch) return null;
  return { hash: hashMatch[1], expires: expiresMatch[1] };
}

// Parse id_movie from movie play page
function parseMovieId(html) {
  return /id_movie:\s*(\d+)/.exec(html)?.[1] || null;
}

// Parse seasons from show play page
function parseSeasons(html) {
  const match = /window\.seasons='(.*?)';/.exec(html);
  if (!match) return null;
  // Unescape JS string
  const raw = match[1]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/');
  try {
    const data = JSON.parse(raw);
    const seasons = {};
    for (const [num, season] of Object.entries(data)) {
      seasons[num] = Object.values(season.episodes || {});
    }
    return seasons;
  } catch {
    return null;
  }
}

// Parse access API response for stream + subtitles
function parseAccess(body) {
  try {
    const data = JSON.parse(body);
    if (!data?.success) return null;
    // Quality keys: "1080p", "1080", "720p", "720", etc.
    const stream = data.streams?.['1080p'] || data.streams?.['1080'] ||
      data.streams?.['720p'] || data.streams?.['720'] ||
      data.streams?.['480p'] || data.streams?.['480'] || null;
    const subtitles = (data.subtitles || [])
      .filter((s) => s.language?.toLowerCase() === 'english')
      .flatMap((s) => {
        if (typeof s.file === 'string') return [s.file];
        if (Array.isArray(s.file)) return s.file.filter((f) => typeof f === 'string');
        return [];
      });
    return { stream, subtitles };
  } catch {
    return null;
  }
}

// Map a TMDB result to a LookMovie slug by searching LookMovie's API
async function slugFromTmdb(media, opts) {
  const query = media.title || '';
  if (!query) return null;
  const results = await searchApi(media.kind, query, opts);
  // Prefer exact title match, then year match
  const normalized = query.toLowerCase().trim();
  const exact = results.find((r) => r.title?.toLowerCase().trim() === normalized);
  if (exact) return exact.slug;
  if (media.year) {
    const yearMatch = results.find((r) => String(r.year).startsWith(String(media.year)));
    if (yearMatch) return yearMatch.slug;
  }
  return results[0]?.slug || null;
}

export const lookmovie = {
  id: 'lookmovie',
  name: 'LookMovie',
  site: 'lookmovie2.to (FMHY movies/TV)',
  sites: ['https://www.lookmovie2.to', 'https://lookmovie2.la'],
  tokens: ['lookmovie'],
  direct: true,
  kinds: ['movie', 'tv'],

  async search(query, opts = {}) {
    const [movies, shows] = await Promise.all([
      searchApi('movie', query, opts).catch(() => []),
      searchApi('tv', query, opts).catch(() => []),
    ]);
    return [
      ...parseSearchResults(movies, 'movie'),
      ...parseSearchResults(shows, 'tv'),
    ];
  },

  async resolve(media, opts = {}) {
    const kind = media.kind === 'tv' ? 'series' : 'movie';
    const audio = opts.audio === 'dub' ? 'dub' : 'sub';
    let slug = media.slug;
    // If no slug but we have a tmdbId, look up the slug via LookMovie's API
    if (!slug && media.tmdbId) {
      slug = await slugFromTmdb(media, opts);
    }
    if (!slug) throw new Error('LookMovie needs a slug (no tmdbId or title to look up)');

    // 1. View page -> play link
    const viewPath = kind === 'series' ? `shows/view/${slug}` : `movies/view/${slug}`;
    const viewHtml = await lookmovieFetch(`${BASE}/${viewPath}`, opts);
    const playPath = parsePlayLink(viewHtml, media.kind);
    if (!playPath) throw new Error('LookMovie play link not found');

    // 2. Play page -> hash/expires + episode data
    const playHtml = await lookmovieFetch(BASE + playPath, opts);
    const storage = parseStorage(playHtml);
    if (!storage) throw new Error('LookMovie storage credentials not found');

    let accessUrl;
    if (kind === 'series') {
      const seasons = parseSeasons(playHtml);
      if (!seasons) throw new Error('LookMovie seasons parse failed');
      const season = seasons[String(media.season || 1)];
      if (!season) throw new Error(`LookMovie season ${media.season} not found`);
      const episode = season.find((e) => String(e.episode_number) === String(media.episode || 1));
      if (!episode) throw new Error(`LookMovie episode ${media.episode} not found`);
      accessUrl = `${BASE}/api/v1/security/episode-access?id_episode=${encodeURIComponent(episode.id_episode)}&hash=${encodeURIComponent(storage.hash)}&expires=${encodeURIComponent(storage.expires)}`;
    } else {
      const idMovie = parseMovieId(playHtml);
      if (!idMovie) throw new Error('LookMovie movie ID not found');
      accessUrl = `${BASE}/api/v1/security/movie-access?id_movie=${encodeURIComponent(idMovie)}&hash=${encodeURIComponent(storage.hash)}&expires=${encodeURIComponent(storage.expires)}`;
    }

    // 3. Access API -> stream + subtitles
    const accessBody = await lookmovieFetch(accessUrl, opts);
    const access = parseAccess(accessBody);
    if (!access?.stream) throw new Error('LookMovie access denied or no stream');

    // 4. Validate HLS
    const streamHtml = await lookmovieFetch(access.stream, opts);
    if (!streamHtml.startsWith('#EXTM3U')) throw new Error('LookMovie stream is not HLS');

    // 5. Parse ladder + download subs (only for sub mode)
    const variants = parseLadder(streamHtml, access.stream);
    const headers = { Referer: BASE + '/', 'User-Agent': UA };

    let subFile = null;
    if (audio === 'sub' && access.subtitles.length > 0) {
      try {
        const { downloadSub } = await import('../subs.js');
        const subUrl = access.subtitles[0].startsWith('http')
          ? access.subtitles[0]
          : BASE + access.subtitles[0];
        subFile = await downloadSub(subUrl, `lookmovie-${slug}.vtt`, { 'User-Agent': UA, Referer: BASE + '/' });
      } catch {}
    }

    const sources = (variants.length ? variants : [{ url: access.stream, quality: 'auto', rank: 0 }]).map((v) => ({
      url: v.url,
      quality: `${v.quality} ${audio}`,
      type: 'hls',
      provider: 'lookmovie',
      direct: true,
      headers,
      ...(subFile ? { subFile } : {}),
    }));

    return { embedUrl: BASE + playPath, sources };
  },
};
