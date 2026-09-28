// 7Movies provider — FMHY top-rated streaming site.
import { createEmbedScraper } from './embed-scraper.js';

export const sevenmovies = createEmbedScraper({
  id: '7movies',
  name: '7Movies',
  site: '7movies.ac (FMHY movies/TV)',
  sites: ['https://7movies.ac'],
  tokens: ['7movies'],
  searchUrl: 'https://7movies.ac/search/{query}',
  linkPattern: /\/(movie|tv|show|watch)\//i,
  detailLinkPattern: /\/(embed|player|watch|stream)\//i,
});
