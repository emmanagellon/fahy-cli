import { createClanAdapter } from './clan.js';

// Anikoto (FMHY-listed: anikototv.to) — same ajax dialect as aniwaves.ru
// (filter -> episode list -> server list -> sources), shared engine.
// Show ids ride on the poster's data-tip (slugs end in a hash, not a number).
export const anikoto = createClanAdapter({
  id: 'anikoto',
  name: 'Anikoto',
  site: 'anikototv.to (FMHY anime)',
  sites: ['https://anikototv.to'],
  tokens: ['anikoto'],
  mirrors: ['https://anikototv.to'],
  label: 'Anikoto',
  dialect: 'server',
});
