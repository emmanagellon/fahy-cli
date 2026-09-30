// Search + media selection for every lane, with the selectors that actually
// matter and nothing else.
//
// The rule from the redesign: a screen exists only when the choice is real.
//   movie  -> title -> (provider)                      no season/episode/audio
//   tv     -> title -> season? -> episode -> (audio) -> (provider)
//   anime  -> title -> season? -> episode -> (audio) -> (provider)
//   youtube-> title -> (provider, single lane)
//   music  -> title -> (provider, single lane)
//
// Every network call is bounded (lib/async.js), so a dead provider can never
// leave a spinner on screen forever.
import { searchAnime, animeRelations, searchMovies, ytSearch, formatDuration } from '../metadata.js';
import { getSeasons, getEpisodes } from '../tmdb.js';
import { forKind, getProvider, providerTags } from '../providers/registry.js';
import { getHealth, healthBlocked } from '../store.js';
import { withDeadline } from '../lib/async.js';
import { select, canSelect, firstOf, short } from './select.js';
import { KINDS, isKind } from '../modes.js';

export { KINDS, isKind };

export const EP_LIST_CAP = 300;

const SEARCH_TIMEOUT_MS = 20000;
const METADATA_TIMEOUT_MS = 15000;
const MIN_EPISODE_PICK = 2; // 1 episode needs no screen

// ---- raw search (bounded) -------------------------------------------------

async function searchAnimeLane(query) {
  return withDeadline(() => searchAnime(query, 12), SEARCH_TIMEOUT_MS, 'AniList search');
}

async function searchTmdbLane(query, kind) {
  const all = await withDeadline(() => searchMovies(query, { timeoutMs: METADATA_TIMEOUT_MS }), SEARCH_TIMEOUT_MS, 'TMDB search');
  // TMDB multi returns both; the lane the user asked for is the only one shown.
  return all.filter((r) => r.kind === kind);
}

async function searchYoutubeLane(query) {
  return withDeadline(() => ytSearch(query, 12, {}), SEARCH_TIMEOUT_MS, 'YouTube search');
}

async function searchMusicLane(query) {
  const { ytmusic } = await import('../providers/ytmusic.js');
  return withDeadline(() => ytmusic.search(query, {}), SEARCH_TIMEOUT_MS, 'music search');
}

export async function searchLane(kind, query) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (kind === 'anime') return searchAnimeLane(q);
  if (kind === 'movie' || kind === 'tv') return searchTmdbLane(q, kind);
  if (kind === 'youtube') return searchYoutubeLane(q);
  return searchMusicLane(q);
}

// ---- row formatting -------------------------------------------------------

export function titleLabel(m) {
  if (m.kind === 'anime') return `${m.title} (${m.year || '?'})`;
  if (m.kind === 'movie' || m.kind === 'tv') return `${m.title} (${m.year || '?'})`;
  const d = m.duration ? ` (${formatDuration(m.duration)})` : '';
  return `${m.title}${d}`;
}

export function titleHint(m) {
  if (m.kind === 'anime') {
    const bits = [m.format || null, m.episodes ? `${m.episodes} eps` : null];
    return bits.filter(Boolean).join(' · ');
  }
  if (m.kind === 'movie' || m.kind === 'tv') return m.rating ? `★ ${m.rating.toFixed(1)}` : '';
  return short(m.author || '', 30);
}

// ---- pick a title ---------------------------------------------------------

export async function pickTitle(kind, query, { interactive = canSelect() } = {}) {
  const results = await searchLane(kind, query);
  if (!results.length) {
    throw new Error(`No ${kind === 'youtube' ? 'videos' : kind === 'music' ? 'tracks' : kind === 'movie' ? 'movies' : kind === 'tv' ? 'TV shows' : 'anime'} found for "${query}".`);
  }
  // A single unambiguous hit needs no screen.
  if (!interactive || results.length === 1) return { ...results[0] };
  const picked = await select({
    title: 'Search Results',
    subtitle: query,
    items: results.map((r, i) => ({ label: titleLabel(r), hint: titleHint(r), value: i })),
  });
  if (picked === null) return null;
  return { ...results[picked] };
}

// ---- anime: season + episode --------------------------------------------

// AniList models "season 2" as a separate entry joined by PREQUEL/SEQUEL.
// Offering them as a Season screen is the difference between picking the right
// show and silently landing in the wrong one.
async function animeSeasons(media) {
  let rel = [];
  if (media.anilistId) {
    rel = await withDeadline(() => animeRelations(media.anilistId).catch(() => []), METADATA_TIMEOUT_MS, 'AniList relations');
  }
  const all = [media, ...rel.filter((r) => r.anilistId !== media.anilistId)];
  all.sort((a, b) => (a.year || 9999) - (b.year || 9999) || (a.anilistId || 0) - (b.anilistId || 0));
  return all;
}

export async function pickAnimeSeason(media, { interactive = canSelect() } = {}) {
  if (!interactive) return { ...media, season: media.season ?? 1 };
  const seasons = await animeSeasons(media);
  if (seasons.length <= 1) return { ...seasons[0] || media, season: media.season ?? 1 };
  const picked = await select({
    title: 'Season',
    subtitle: media.title,
    items: seasons.map((s, i) => ({
      label: `${s.title} (${s.year || '?'})`,
      hint: s.episodes ? `${s.episodes} eps` : '',
      value: i,
    })),
  });
  if (picked === null) return null;
  return { ...seasons[picked], season: media.season ?? 1 };
}

function episodeItems(count) {
  return Array.from({ length: count }, (_, i) => ({ label: `Episode ${i + 1}`, value: i + 1 }));
}

export async function pickAnimeEpisode(media, { interactive = canSelect(), forced = null } = {}) {
  if (forced != null) return Math.max(1, Number(forced) || 1);
  const total = Number(media.episodes) || 0;
  if (!interactive || total < MIN_EPISODE_PICK || total > EP_LIST_CAP) return 1;
  const picked = await select({
    title: 'Episode',
    subtitle: media.title,
    items: episodeItems(total),
    maxVisible: 15,
  });
  if (picked === null) return null;
  return Math.max(1, Number(picked) || 1);
}

// ---- tv: season + episode (TMDB gives real names) ------------------------

export async function pickTvSeason(media, { interactive = canSelect(), forced = null } = {}) {
  if (forced != null) return Number(forced) || 1;
  if (!interactive) return Number(media.season) || 1;
  const seasons = await withDeadline(
    () => getSeasons(media.tmdbId, { timeoutMs: METADATA_TIMEOUT_MS }),
    METADATA_TIMEOUT_MS + 3000,
    'season list'
  ).catch(() => []);
  // One season is not a decision — skip straight to episodes.
  if (seasons.length <= 1) return seasons[0]?.seasonNumber || Number(media.season) || 1;
  const picked = await select({
    title: 'Season',
    subtitle: media.title,
    items: seasons.map((s) => ({
      label: s.name,
      hint: s.episodeCount ? `${s.episodeCount} eps` : '',
      value: s.seasonNumber,
    })),
  });
  if (picked === null) return null;
  return Number(picked) || 1;
}

export async function pickTvEpisode(media, season, { interactive = canSelect(), forced = null } = {}) {
  if (forced != null) return Math.max(1, Number(forced) || 1);
  if (!interactive) return 1;
  const episodes = await withDeadline(
    () => getEpisodes(media.tmdbId, season, { timeoutMs: METADATA_TIMEOUT_MS }),
    METADATA_TIMEOUT_MS + 3000,
    'episode list'
  ).catch(() => []);
  if (episodes.length < MIN_EPISODE_PICK || episodes.length > EP_LIST_CAP) return 1;
  const picked = await select({
    title: 'Episode',
    subtitle: `${media.title} · Season ${season}`,
    items: episodes.map((ep) => ({
      label: `Episode ${ep.episodeNumber}${ep.name && ep.name !== `Episode ${ep.episodeNumber}` ? ` — ${ep.name}` : ''}`,
      value: ep.episodeNumber,
    })),
    maxVisible: 15,
  });
  if (picked === null) return null;
  // Remember how long this season runs so "next episode" knows where the end
  // is without another lookup. TMDB search results do not carry it.
  media.seasonEpisodes = episodes.length;
  return Math.max(1, Number(picked) || 1);
}

// ---- provider / source ---------------------------------------------------

export function providerRows(media, { health = getHealth(), isBlocked = (id) => healthBlocked(id) } = {}) {
  const avail = forKind(media.kind);
  const defId = media.defaultProviderId;
  const tags = providerTags(avail, { health, isBlocked });
  const ordered = [...avail].sort((a, b) => {
    if (a.id === defId) return -1;
    if (b.id === defId) return 1;
    if (tags[a.id] === 'best') return -1;
    if (tags[b.id] === 'best') return 1;
    return 0;
  });
  return ordered.map((x) => ({
    id: x.id,
    label: x.name,
    hint: [x.id === defId ? 'default' : '', tags[x.id] === 'best' ? 'best' : tags[x.id] === 'unhealthy' ? 'unhealthy' : '']
      .filter(Boolean)
      .join(' · '),
  }));
}

// One lane (youtube/music) needs no screen. Multiple candidates do.
export async function pickProvider(media, { interactive = canSelect(), forced = null } = {}) {
  if (forced) {
    const p = getProvider(forced);
    if (!p) throw new Error(`Unknown provider: ${forced} (see: fahy providers)`);
    if (!p.kinds.includes(media.kind)) {
      throw new Error(`${p.name} does not handle ${media.kind}.`);
    }
    return p;
  }
  const rows = providerRows(media);
  if (!rows.length) throw new Error(`No provider available for ${media.kind}.`);
  // A single provider is not a choice — take it.
  if (!interactive || rows.length === 1) return getProvider(rows[0].id);
  const picked = await select({
    title: 'Source',
    subtitle: media.title,
    items: rows.map((r) => ({ label: r.label, hint: r.hint, value: r.id })),
  });
  if (picked === null) return null;
  return getProvider(picked);
}

// Sub/dub only exists where the media can actually be dubbed. A provider that
// hands back a single rendition (most embed scrapers) must not be asked.
export function supportsAudioChoice(provider, media) {
  if (!provider || !['anime', 'movie', 'tv'].includes(media.kind)) return false;
  if (provider.audioModes === false) return false;
  // Known single-rendition lanes: the embed scraper family never varies audio.
  if (provider.id && ['flixer', 'rive', 'movy', '7movies', '67movies'].includes(provider.id)) return false;
  return true;
}

export async function pickAudioMode(provider, media, { interactive = canSelect(), forced = null } = {}) {
  if (forced) return forced === 'dub' ? 'dub' : 'sub';
  if (!interactive || !supportsAudioChoice(provider, media)) return 'sub';
  const picked = await select({
    title: 'Language',
    subtitle: media.title,
    items: [
      { label: 'Sub', hint: 'original audio + English subs', value: 'sub' },
      { label: 'Dub', hint: 'English audio', value: 'dub' },
    ],
  });
  if (picked === null) return null;
  return picked === 'dub' ? 'dub' : 'sub';
}

// ---- continuing an episodic session ---------------------------------------
//
// After an episode ends the session has to know whether there IS a next one.
// ani-cli gets this for free because it holds the show's episode list in
// memory; we re-derive it, but only at the boundary — one bounded call when
// the current episode was the last one, and never during ordinary playback.

// Episode count for the season being watched. Returns null when unknown
// (metadata did not say, or the lookup failed) — callers must treat null as
// "assume there may be more" rather than "this was the last one".
export function seasonEpisodeCount(media) {
  if (media.kind === 'anime') {
    const n = Number(media.episodes) || 0;
    return n > 0 ? n : null;
  }
  if (media.kind === 'tv') {
    const n = Number(media.seasonEpisodes) || Number(media.totalEpisodes) || 0;
    return n > 0 ? n : null;
  }
  return null;
}

// The next thing to watch in this session, or 'end' when the show is done.
// Used by both the autoplay path and the "what next?" menu so the two can
// never disagree about where an episode goes — or what to call it.
//
// Returns { media, label } or 'end'.
export async function advanceEpisode(media) {
  if (media.kind !== 'anime' && media.kind !== 'tv') return 'end';
  const ep = Number(media.episode) || 1;
  const total = seasonEpisodeCount(media);
  // Anime reads "E4" (the show has no numbered seasons to disambiguate);
  // TV needs the season, or S1E4 and S2E4 look identical in a list.
  const epLabel = (n) => (media.kind === 'tv' ? `S${media.season || 1}E${n}` : `E${n}`);

  // Inside the season (or when the season length is unknown, in which case we
  // let the resolve fail honestly rather than guessing the show is over).
  if (!total || ep < total) {
    const next = { ...media, episode: ep + 1, episodeId: undefined };
    return { media: next, label: `Next episode (${epLabel(ep + 1)})` };
  }
  // Last episode of the season: carry on into the next one if there is one.
  const later = await nextSeasonMedia(media);
  if (!later) return 'end';
  const season = Number(later.season) || (Number(media.season) || 1) + 1;
  return { media: rollOverSeason(media, later, season), label: `Next season (S${season}E1)` };
}

// Merge the season being finished with the season about to start. Pure, so the
// merge rules can be pinned without a network.
//
// `later` is the NEXT season's own record, not a blank slate. That matters: a
// split anime cour is a separate entry with its own episode count, and carrying
// the finished season's count forward would walk the session past the real last
// episode of the new one.
export function rollOverSeason(media, later, season) {
  // `later` is spread FIRST so the finished season's counts cannot survive —
  // only what the incoming season actually says is kept. A count it does not
  // have stays absent, which seasonEpisodeCount reads as "there may be more",
  // the safe direction to be wrong in.
  return {
    ...later,
    kind: media.kind,
    season,
    episode: 1,
    episodeId: undefined,
  };
}

// Bounded, non-interactive: the show's next season, or null when there is none
// or the lookup could not say. A failed lookup is never read as "the show
// ended" — that would cut a session short on a network blip.
async function nextSeasonMedia(media) {
  try {
    if (media.kind === 'tv') {
      const seasons = await withDeadline(
        () => getSeasons(media.tmdbId, { timeoutMs: METADATA_TIMEOUT_MS }),
        METADATA_TIMEOUT_MS + 3000, 'season list'
      ).catch(() => []);
      const current = Number(media.season) || 1;
      const next = seasons
        .filter((s) => Number(s.seasonNumber) > current && Number(s.seasonNumber) > 0)
        .sort((a, b) => a.seasonNumber - b.seasonNumber)[0];
      // Season 0 is specials; never a continuation of the main run.
      if (!next) return null;
      return {
        tmdbId: media.tmdbId,
        title: media.title,
        season: next.seasonNumber,
        seasonEpisodes: Number(next.episodeCount) || null,
      };
    }
    if (media.kind === 'anime') {
      // A split cour is its own AniList record, so the next one is already a
      // complete media row with its own episode count.
      const all = await animeSeasons(media);
      const i = all.findIndex((s) => s.anilistId === media.anilistId);
      if (i < 0 || i >= all.length - 1) return null;
      return { ...all[i + 1], season: (Number(media.season) || 0) + 1 };
    }
  } catch {}
  return null;
}

// ---- one call that runs the whole selection chain ------------------------

// Returns { media, provider, audio } or null when the user backed out.
// `overrides` carries explicit flags (--season/--episode/--provider/--dub) so a
// scripted run never stops to ask.
export async function selectMedia({ kind, query, config, overrides = {}, interactive = canSelect() }) {
  const title = await pickTitle(kind, query, { interactive });
  if (!title) return null;

  const media = { ...title, kind, defaultProviderId: config?.defaultProvider?.[kind] || null };
  const provider = await pickProvider(media, { interactive, forced: overrides.provider });
  if (!provider) return null;

  let season = media.season ?? null;
  let episode = 1;

  if (kind === 'anime') {
    const withSeason = await pickAnimeSeason(media, { interactive });
    if (!withSeason) return null;
    Object.assign(media, withSeason);
    const ep = await pickAnimeEpisode(media, { interactive, forced: overrides.episode });
    if (ep === null) return null;
    episode = ep;
  } else if (kind === 'tv') {
    const s = await pickTvSeason(media, { interactive, forced: overrides.season });
    if (s === null) return null;
    season = s;
    media.season = s;
    const ep = await pickTvEpisode(media, s, { interactive, forced: overrides.episode });
    if (ep === null) return null;
    episode = ep;
  }

  const audio = await pickAudioMode(provider, media, { interactive, forced: overrides.audio });
  if (audio === null) return null;

  media.season = season;
  media.episode = episode;
  return { media, provider, audio };
}

// Scriptable single-shot: no prompts, first result wins.
export function quickSelectMedia({ kind, query, config, overrides = {} }) {
  return selectMedia({ kind, query, config, overrides, interactive: false });
}

export { firstOf };
