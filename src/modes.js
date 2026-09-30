// The five things fahy can play, and the names people type for them.
//
// A single place so the CLI surface, the search lanes and the provider
// registry all agree on what "movie" means.
export const KINDS = ['anime', 'movie', 'tv', 'youtube', 'music'];

// Every spelling that has ever meant each kind. `yt` and `y` are the short
// forms people actually type; the rest are legacy flag forms.
export const KIND_ALIASES = {
  anime: 'anime',
  a: 'anime',
  movie: 'movie',
  films: 'movie',
  tv: 'tv',
  show: 'tv',
  series: 'tv',
  youtube: 'youtube',
  yt: 'youtube',
  y: 'youtube',
  video: 'youtube',
  music: 'music',
  song: 'music',
  m: 'music',
};

export const MODE_LABEL = {
  anime: 'Anime',
  movie: 'Movie',
  tv: 'TV show',
  youtube: 'YouTube',
  music: 'Music',
};

export function isKind(k) {
  return KINDS.includes(k);
}

export function kindFor(name) {
  return KIND_ALIASES[String(name || '').toLowerCase()] || null;
}
