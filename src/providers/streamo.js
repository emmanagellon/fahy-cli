// Streamo provider — FMHY top-rated streaming site.
import { createEmbedScraper } from './embed-scraper.js';

export const streamo = createEmbedScraper({
  id: 'streamo',
  name: 'Streamo',
  site: 'streamo.pro (FMHY movies/TV)',
  sites: ['https://streamo.pro'],
  tokens: ['streamo'],
  searchUrl: 'https://streamo.pro/search/{query}',
  linkPattern: /\/(movie|tv|show|watch)\//i,
  detailLinkPattern: /\/(embed|player|watch|stream)\//i,
});
