// Rive provider — FMHY top-rated streaming site (4K).
import { createEmbedScraper } from './embed-scraper.js';

export const rive = createEmbedScraper({
  id: 'rive',
  name: 'Rive',
  site: 'rivestream.app (FMHY movies/TV)',
  sites: ['https://www.rivestream.app', 'https://rivestream.ru', 'https://rivestream.pw'],
  tokens: ['rive', 'rivestream'],
  searchUrl: 'https://www.rivestream.app/search/{query}',
  linkPattern: /\/(movie|tv|show|watch)\//i,
  detailLinkPattern: /\/(embed|player|watch|stream)\//i,
});
