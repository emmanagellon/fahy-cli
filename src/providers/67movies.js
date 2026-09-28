// 67Movies provider — FMHY top-rated streaming site (4K).
import { createEmbedScraper } from './embed-scraper.js';

export const sixsevenmovies = createEmbedScraper({
  id: '67movies',
  name: '67Movies',
  site: '67movies.st (FMHY movies/TV)',
  sites: ['https://67movies.st', 'https://phantomflix.net'],
  tokens: ['67movies', 'phantomflix'],
  searchUrl: 'https://67movies.st/search/{query}',
  linkPattern: /\/(movie|tv|show|watch)\//i,
  detailLinkPattern: /\/(embed|player|watch|stream)\//i,
});
