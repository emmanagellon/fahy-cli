// Movy provider — FMHY top-rated streaming site.
import { createEmbedScraper } from './embed-scraper.js';

export const movy = createEmbedScraper({
  id: 'movy',
  name: 'Movy',
  site: 'movy.sx (FMHY movies/TV)',
  sites: ['https://www.movy.sx'],
  tokens: ['movy'],
  searchUrl: 'https://www.movy.sx/search/{query}',
  linkPattern: /\/(movie|tv|show|watch)\//i,
  detailLinkPattern: /\/(embed|player|watch|stream)\//i,
});
