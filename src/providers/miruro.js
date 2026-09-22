import { embedSource } from './base.js';

// Miruro — FMHY-listed open-source frontend (all 5 FMHY mirrors).
// No frozen public API; MVP resolves to Miruro search URLs for yt-dlp
// prescreen + mpv fallback.
const MIRRORS = [
  'https://www.miruro.com',
  'https://miruro.tv',
  'https://miruro.bz',
  'https://miruro.ru',
  'https://miruro.to',
];

export const miruro = {
  id: 'miruro',
  name: 'Miruro',
  site: 'miruro.com (FMHY anime)',
  sites: [...MIRRORS],
  tokens: ['miruro'],
  direct: false,
  kinds: ['anime'],
  async resolve(media, opts = {}) {
    void opts;
    const title = String(media?.title || '').trim();
    if (!title) throw new Error('Miruro needs a title to search.');
    const q = encodeURIComponent(title);
    const sources = MIRRORS.map((m) => embedSource(`${m}/search?q=${q}`, 'miruro'));
    return { embedUrl: sources[0]?.url, sources };
  },
};
