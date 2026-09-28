import { createClanAdapter } from './clan.js';

// Anisuge (FMHY-listed: animesuge.cz) — shared clan engine
// (filter -> episode list -> server list -> sources, with megaplay HLS.
export const anisuge = createClanAdapter({
  id: 'anisuge',
  name: 'Anisuge',
  site: 'animesuge.cz (FMHY anime)',
  sites: ['https://animesuge.cz'],
  tokens: ['anisuge'],
  mirrors: ['https://animesuge.cz'],
  label: 'Anisuge',
});
