import { embedSource } from './base.js';

// KickAssAnime — FMHY-starred (kaa.lt), sub/dub, no-ads-claimed.
// Embed-only MVP like miruro: title search pages; per-episode extraction
// is site-specific and rots fast. Search URL shape confirmed from KAA's own
// site schema (SearchAction urlTemplate .../search?q={search_query}).
export const kickassanime = {
  id: 'kickassanime',
  name: 'KickAssAnime',
  site: 'kaa.lt (FMHY anime)',
  sites: ['https://kaa.lt'],
  tokens: ['kickass', 'kaa'],
  direct: false,
  kinds: ['anime'],
  async resolve(media, opts = {}) {
    void opts;
    const title = String(media?.title || '').trim();
    if (!title) throw new Error('KickAssAnime needs a title to search.');
    const q = encodeURIComponent(title);
    const embedUrl = `https://kaa.lt/search?q=${q}`;
    return { embedUrl, sources: [embedSource(embedUrl, 'kickassanime')] };
  },
};
