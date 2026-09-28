// Flixer provider — FMHY top-rated streaming site.
import { createEmbedScraper } from './embed-scraper.js';

export const flixer = createEmbedScraper({
  id: 'flixer',
  name: 'Flixer',
  site: 'flixer.gd (FMHY movies/TV)',
  sites: ['https://flixer.gd', 'https://flixer.su', 'https://flixer.cx'],
  tokens: ['flixer'],
  searchUrl: 'https://flixer.gd/search/{query}',
  linkPattern: /\/(movie|tv|show|watch)\//i,
  detailLinkPattern: /\/(embed|player|watch|stream)\//i,
});
