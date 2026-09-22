// Miruro — FMHY-listed open-source frontend. Every mirror is Cloudflare-gated:
// the SPA pages, its base64url+gzip "pipe" API (www.miruro.com/api/secure/pipe),
// and every community Miruro-API deployment currently up are challenged or
// offline (502/404/403). yt-dlp cannot pass those challenges, so resolve()
// fails fast with an honest message instead of burning prescreen time on
// search URLs that can never stream.
export const miruro = {
  id: 'miruro',
  name: 'Miruro',
  site: 'miruro.com (FMHY anime)',
  sites: [
    'https://www.miruro.com',
    'https://miruro.tv',
    'https://miruro.bz',
    'https://miruro.ru',
    'https://miruro.to',
  ],
  tokens: ['miruro'],
  direct: false,
  kinds: ['anime'],
  async resolve(_media, _opts = {}) {
    throw new Error(
      'Miruro is behind a Cloudflare JS challenge on every mirror and its pipe API is challenged too, so a headless player cannot stream from it. Try --provider hianime, anikoto, anisuge, or kickassanime.'
    );
  },
};
