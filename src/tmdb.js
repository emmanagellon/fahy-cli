// TMDB API integration for movie/TV search and metadata.
// No user-facing keys needed — uses a shared public API key (configurable).
// Search returns movies + TV shows; seasons/episodes for TV via TMDB API.
import { fetchJsonVia } from './net.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w500';
// Shared public key (configurable via config.tmdbApiKey). TMDB keys are free
// at https://www.themoviedb.org/settings/api — replace if rate-limited.
const DEFAULT_API_KEY = '1f54bd990f1cdfb230adb312546d765d';

function apiKey(opts = {}) {
  return opts.apiKey || process.env.TMDB_API_KEY || DEFAULT_API_KEY;
}

// Search TMDB multi (movies + TV shows). Returns normalized results with
// kind: 'movie' | 'tv', tmdbId, title, year, poster.
export async function searchTmdb(query, opts = {}) {
  const params = new URLSearchParams({
    query,
    include_adult: 'false',
    language: 'en-US',
    page: '1',
    api_key: apiKey(opts),
  });
  const url = `${TMDB_BASE}/search/multi?${params}`;
  const data = await fetchJsonVia(url, {
    timeoutMs: opts.timeoutMs || 15000,
    signal: opts.signal,
    debug: opts.debug,
  });
  const results = (data?.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map((r) => {
      const kind = r.media_type === 'tv' ? 'tv' : 'movie';
      const title = r.title || r.name || 'Unknown';
      const date = r.release_date || r.first_air_date || '';
      const year = date ? date.slice(0, 4) : null;
      const poster = r.poster_path ? `${TMDB_IMAGE}${r.poster_path}` : null;
      return {
        kind,
        tmdbId: r.id,
        title,
        year,
        poster,
        overview: r.overview || null,
        rating: r.vote_average ?? null,
      };
    });
  return results;
}

// Get seasons for a TV show. Returns [{ seasonNumber, name, episodeCount }].
export async function getSeasons(tmdbId, opts = {}) {
  const url = `${TMDB_BASE}/tv/${tmdbId}?api_key=${apiKey(opts)}`;
  const data = await fetchJsonVia(url, {
    timeoutMs: opts.timeoutMs || 15000,
    signal: opts.signal,
    debug: opts.debug,
  });
  return (data?.seasons || [])
    .filter((s) => s.season_number > 0)
    .map((s) => ({
      seasonNumber: s.season_number,
      name: s.name || `Season ${s.season_number}`,
      episodeCount: s.episode_count || null,
    }));
}

// Get episodes for a season. Returns [{ episodeNumber, name, overview }].
export async function getEpisodes(tmdbId, seasonNumber, opts = {}) {
  const url = `${TMDB_BASE}/tv/${tmdbId}/season/${seasonNumber}?api_key=${apiKey(opts)}`;
  const data = await fetchJsonVia(url, {
    timeoutMs: opts.timeoutMs || 15000,
    signal: opts.signal,
    debug: opts.debug,
  });
  return (data?.episodes || []).map((e) => ({
    episodeNumber: e.episode_number,
    name: e.name || `Episode ${e.episode_number}`,
    overview: e.overview || null,
  }));
}

// Get movie details (for recommendations, etc.)
export async function getMovieDetails(tmdbId, opts = {}) {
  const url = `${TMDB_BASE}/movie/${tmdbId}?api_key=${apiKey(opts)}`;
  const data = await fetchJsonVia(url, {
    timeoutMs: opts.timeoutMs || 15000,
    signal: opts.signal,
    debug: opts.debug,
  });
  return {
    tmdbId: data.id,
    title: data.title || 'Unknown',
    year: data.release_date ? data.release_date.slice(0, 4) : null,
    poster: data.poster_path ? `${TMDB_IMAGE}${data.poster_path}` : null,
    overview: data.overview || null,
    rating: data.vote_average ?? null,
    runtime: data.runtime || null,
    genres: (data.genres || []).map((g) => g.name),
  };
}

// Get TV show details
export async function getTvDetails(tmdbId, opts = {}) {
  const url = `${TMDB_BASE}/tv/${tmdbId}?api_key=${apiKey(opts)}`;
  const data = await fetchJsonVia(url, {
    timeoutMs: opts.timeoutMs || 15000,
    signal: opts.signal,
    debug: opts.debug,
  });
  return {
    tmdbId: data.id,
    title: data.name || 'Unknown',
    year: data.first_air_date ? data.first_air_date.slice(0, 4) : null,
    poster: data.poster_path ? `${TMDB_IMAGE}${data.poster_path}` : null,
    overview: data.overview || null,
    rating: data.vote_average ?? null,
    seasons: data.number_of_seasons || null,
    episodes: data.number_of_episodes || null,
    genres: (data.genres || []).map((g) => g.name),
  };
}
