import { embedSource } from './base.js';

// Miruro — FMHY-listed open-source frontend (miruro.com + mirrors).
// No frozen public API; MVP resolves to Miruro search URLs (primary +
// FMHY-listed backup mirror) for yt-dlp prescreen + mpv fallback.
const PRIMARY = 'https://www.miruro.com';
const BACKUP = 'https://miruro.tv'; // FMHY-listed mirror

export const miruro = {
  id: 'miruro',
  name: 'Miruro',
  site: 'miruro.com (FMHY anime)',
  sites: ['https://www.miruro.com', 'https://miruro.tv'],
  tokens: ['miruro'],
  direct: false,
  kinds: ['anime'],
  async resolve(media, opts = {}) {
    void opts;
    const title = String(media?.title || '').trim();
    if (!title) throw new Error('Miruro needs a title to search.');
    const q = encodeURIComponent(title);
    const embedUrl = `${PRIMARY}/search?q=${q}`;
    return {
      embedUrl,
      sources: [
        embedSource(embedUrl, 'miruro'),
        embedSource(`${BACKUP}/search?q=${q}`, 'miruro'),
      ],
    };
  },
};
