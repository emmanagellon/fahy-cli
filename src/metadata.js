// Metadata: where titles come from.
// Anime: AniList GraphQL (no key). YouTube/Music: yt-dlp search + Invidious
// pool (kunai-style). No keys needed for anything anymore.
import { spawnSync } from 'node:child_process';
import { ytDlpPrivacyArgs } from './lib/privacy.js';

export async function searchAnime(query, limit = 10) {
  const gql = {
    query: `query ($q: String, $n: Int) { Page(perPage: $n) { media(search: $q, type: ANIME, sort: POPULARITY_DESC) {
      id title { romaji english } format episodes startDate { year } coverImage { large } } } }`,
    variables: { q: query, n: limit },
  };
  const res = await fetchWithTimeout('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Connection: 'close' },
    body: JSON.stringify(gql),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(`AniList: ${json.errors[0]?.message || 'query failed'}`);
  return (json?.data?.Page?.media || []).map((m) => ({
    kind: 'anime',
    anilistId: m.id,
    title: m.title?.english || m.title?.romaji || 'Unknown',
    format: m.format,
    episodes: m.episodes,
    year: m.startDate?.year,
    image: m.coverImage?.large,
  }));
}

// Anime "seasons" are separate AniList entries linked by PREQUEL/SEQUEL
// relations (e.g. Frieren vs Frieren Season 2). One request, no recursion.
export async function animeRelations(anilistId) {
  const gql = {
    query: `query ($id: Int) { Media(id: $id) { relations { edges {
      relationType(version: 2) node { id title { romaji english } format episodes startDate { year } } } } } }`,
    variables: { id: anilistId },
  };
  const res = await fetchWithTimeout('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Connection: 'close' },
    body: JSON.stringify(gql),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(`AniList: ${json.errors[0]?.message || 'query failed'}`);
  const edges = json?.data?.Media?.relations?.edges || [];
  return edges
    .filter((x) => x.relationType === 'PREQUEL' || x.relationType === 'SEQUEL')
    .map((x) => ({
      kind: 'anime',
      anilistId: x.node.id,
      title: x.node.title?.english || x.node.title?.romaji || 'Unknown',
      format: x.node.format,
      episodes: x.node.episodes,
      year: x.node.startDate?.year,
      relation: x.relationType,
    }));
}

async function fetchWithTimeout(url, init, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('AniList timeout')), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// YouTube search via yt-dlp (ytmusic-player's search.ts parity): no API key,
// no instance roulette. One JSON object per line (flat playlist).
export function ytSearch(query, limit = 10, opts = {}) {
  return parseYtDlpLines(runYtDlp([`ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist', '--quiet'], opts), 'youtube');
}

// Radio mix (ytmusic-player parity): watch + RD playlist id, flattened.
export function ytMix(videoId, limit = 25, opts = {}) {
  return parseYtDlpLines(
    runYtDlp(
      [`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`, '--dump-json', '--flat-playlist', '--quiet', '--playlist-end', String(limit)],
      opts
    ),
    'youtube'
  );
}

function parseYtDlpLines(out, kind) {
  return String(out || '')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const d = JSON.parse(line);
        // 11-char video ids only — channels/playlists can't play as videos.
        if (!d?.id || !/^[A-Za-z0-9_-]{11}$/.test(d.id)) return [];
        return [{
          kind,
          videoId: d.id,
          title: d.title || d.id,
          author: d.uploader || d.channel || null,
          duration: typeof d.duration === 'number' ? d.duration : null,
          views: d.view_count ?? null,
          url: `https://www.youtube.com/watch?v=${d.id}`,
        }];
      } catch {
        return [];
      }
    });
}

function runYtDlp(args, opts = {}) {
  if (opts.debug) console.error(`[meta] yt-dlp ${args.join(' ')}`);
  // ytmusic-player parity: tracking-free yt-dlp (no config/cache/cookies).
  const r = spawnSync('yt-dlp', [...ytDlpPrivacyArgs(), ...args], { encoding: 'utf8', shell: false, timeout: opts.timeoutMs || 60000 });
  if (r.error) throw new Error(`yt-dlp failed to start: ${r.error.message}`);
  if (r.status !== 0) {
    const detail = String(r.stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 200);
    throw new Error(detail || `yt-dlp exited with code ${r.status}`);
  }
  return String(r.stdout || '');
}

export function formatDuration(secs) {
  if (secs === null || secs === undefined || !Number.isFinite(Number(secs))) return null;
  const s = Math.max(0, Math.floor(Number(secs)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
