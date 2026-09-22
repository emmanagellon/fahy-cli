import { embedSource } from './base.js';
import { fetchJsonVia } from '../net.js';

// AnimePahe — FMHY-listed (animepahe.pw), stable public search/release API.
// search:  GET {API}?m=search&q={query}
// release: GET {API}?m=release&id={anime_id}&sort=episode_asc&page={n}
// API sits behind Cloudflare, so JSON goes through fetchJsonVia
// (curl-impersonate fallback) instead of plain fetch.
// Full episode download URLs need kwik unpacking (JS eval, fragile) —
// resolves to the AnimePahe play page + lists episodes; playback goes through
// mpv/yt-dlp, failing forward to the next adapter when unplayable.
const SITE = 'https://animepahe.pw';
const API = `${SITE}/api`;

export const animepahe = {
  id: 'animepahe',
  name: 'AnimePahe',
  site: 'animepahe.pw (FMHY anime)',
  sites: ['https://animepahe.pw'],
  tokens: ['animepahe'],
  direct: false, // play pages via yt-dlp/kwik; direct when extractable
  kinds: ['anime'],
  async search(query, opts = {}) {
    const data = await fetchJsonVia(`${API}?m=search&q=${encodeURIComponent(query)}`, opts);
    return (data?.data || []).map((a) => ({
      providerId: String(a.id),
      title: a.title,
      type: a.type,
      episodes: a.episodes,
      year: a.year,
      image: a.poster,
      url: `${SITE}/anime/${a.session}`,
      session: a.session,
    }));
  },
  async episodes(anime, opts = {}) {
    const out = [];
    let page = 1;
    let lastPage = 1;
    do {
      const data = await fetchJsonVia(
        `${API}?m=release&id=${anime.providerId}&sort=episode_asc&page=${page}`,
        opts
      );
      lastPage = data?.last_page || 1;
      for (const e of data?.data || []) out.push({ number: e.episode, id: e.id, session: e.session, title: e.title });
      page++;
    } while (page <= lastPage && out.length < 500);
    return out;
  },
  async resolve(media, opts = {}) {
    void opts;
    // media: { anime: {session, url}, episode: {number, session?} }
    // Throws instead of returning an undefined URL (mpv would just dump usage).
    if (media.episode?.session && media.anime?.session) {
      const embedUrl = `${SITE}/play/${media.anime.session}/${media.episode.session}`;
      return { embedUrl, sources: [embedSource(embedUrl, 'animepahe')] };
    }
    if (media.anime?.url) {
      return { embedUrl: media.anime.url, sources: [embedSource(media.anime.url, 'animepahe')] };
    }
    throw new Error(`AnimePahe has no page for "${media.title || 'this title'}" — try --provider hianime or miruro.`);
  },
};
