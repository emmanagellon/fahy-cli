import { createClanAdapter } from './clan.js';

// Anisuge (FMHY-listed: animesuge.cz) — same ajax dialect as aniwaves.ru
// (filter -> episode list -> server list -> sources), shared engine.
export const anisuge = createClanAdapter({
  id: 'anisuge',
  name: 'Anisuge',
  site: 'animesuge.cz (FMHY anime)',
  sites: ['https://animesuge.cz'],
  tokens: ['anisuge'],
  mirrors: ['https://animesuge.cz'],
  label: 'Anisuge',
});
