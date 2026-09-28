// PopcornMovies provider — FMHY top-rated streaming site.
import { createEmbedScraper } from './embed-scraper.js';

export const popcornmovies = createEmbedScraper({
  id: 'popcornmovies',
  name: 'PopcornMovies',
  site: 'popcornmovies.ac (FMHY movies/TV)',
  sites: ['https://popcornmovies.ac', 'https://bingebox.ac'],
  tokens: ['popcornmovies', 'bingebox'],
  searchUrl: 'https://popcornmovies.ac/search/{query}',
  linkPattern: /\/(movie|tv|show|watch)\//i,
  detailLinkPattern: /\/(embed|player|watch|stream)\//i,
});
