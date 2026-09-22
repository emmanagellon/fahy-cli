import { createClanAdapter } from './clan.js';

// AniWave (FMHY-listed: aniwaves.ru) — full ajax-chain resolution via the
// shared clan engine (aniwave.to was dropped: parked / for sale).
export const aniwave = createClanAdapter({
  id: 'aniwave',
  name: 'AniWave-style',
  site: 'aniwaves.ru (FMHY anime)',
  sites: ['https://aniwaves.ru'],
  tokens: ['aniwave'],
  mirrors: ['https://aniwaves.ru'],
  label: 'AniWave',
});

// Re-exported so existing parser tests keep importing from here.
export {
  parseWatchSlug,
  parseFilterLinks,
  chooseShow,
  parseEpisodeList,
  parseServerGroups,
} from './clan.js';
