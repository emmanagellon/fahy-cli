import { embedSource } from './base.js';
import { fetchText } from '../net.js';

// AniWave (FMHY-listed: aniwaves.ru + legacy mirror) — full ajax-chain
// resolution (no yt-dlp-proof search pages anymore):
//   filter page -> /watch/{slug} match -> ajax/episode/list/{id}
//   -> /watch/{id}/ep-{n} ids -> ajax/server/list -> ajax/sources
// yields per-server embed URLs. Dead video hosts (404/gone, they rot fast)
// are filtered by the prescreen downstream; every live server is offered.
// Sub by default, dub when opts.audio === 'dub' (server groups are labeled).
const MIRRORS = ['https://aniwaves.ru'];
// (aniwave.to was dropped: the domain is parked / for sale, not a mirror.)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const T = 12000;

const normTitle = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// '/watch/one-piece-81553' -> { slug: 'one-piece-81553', id: '81553', title: 'one piece' }
export function parseWatchSlug(href) {
  const slug = String(href || '').split(/[?#]/)[0].replace(/^\/*watch\//i, '').replace(/\/+$/, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/i.test(slug)) return null;
  return { slug, id: slug.split('-').pop(), title: normTitle(slug.replace(/-\d+$/, '').replace(/-/g, ' ')) };
}

export function parseFilterLinks(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/href="(\/watch\/[^"]+)"/gi)) {
    const p = parseWatchSlug(m[1]);
    if (!p || seen.has(p.slug)) continue;
    seen.add(p.slug);
    out.push(p);
  }
  return out;
}

export function chooseShow(links, query) {
  if (!links.length) return null;
  const q = normTitle(query);
  if (!q) return links[0];
  return (
    links.find((l) => l.title === q) ||
    links.find((l) => l.title.startsWith(`${q} `) || q.startsWith(`${l.title} `)) ||
    links.find((l) => l.title.includes(q) || q.includes(l.title)) ||
    links[0]
  );
}

// Episode list HTML -> [{ num, href, ids }] (ids = 'data-ids', e.g. '81553&eps=1').
export function parseEpisodeList(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = m[1] || '';
    const href = /(?:^|\s)href\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (!href || !/\/ep-\d+/i.test(href)) continue;
    const num = parseInt(/(?:^|\s)data-num\s*=\s*["'](\d+)["']/i.exec(attrs)?.[1] || '', 10);
    const ids = /(?:^|\s)data-ids\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.replace(/&amp;/g, '&');
    if (!Number.isInteger(num) || num <= 0 || !ids) continue;
    out.push({ num, href, ids });
  }
  return out.sort((a, b) => a.num - b.num);
}

// Server list HTML -> [{ type: 'sub'|'dub'|..., servers: [{ svId, linkId }] }].
export function parseServerGroups(html) {
  const groups = [];
  for (const sec of String(html || '').split('<div class="type"').slice(1)) {
    const type = /data-type="(\w+)"/i.exec(sec)?.[1]?.toLowerCase();
    if (!type) continue;
    const servers = [];
    for (const m of sec.matchAll(/data-sv-id="(\d+)"\s+data-link-id="([^"]+)"/gi)) {
      servers.push({ svId: m[1], linkId: m[2] });
    }
    if (servers.length) groups.push({ type, servers });
  }
  return groups;
}

function pickGroup(groups, audio) {
  if (!groups.length) return null;
  if (audio === 'dub') {
    return groups.find((g) => g.type === 'dub') || groups[0];
  }
  return groups.find((g) => g.type === 'sub') || groups.find((g) => g.type === 'ssub') || groups[0];
}

async function postForm(url, form, referer, timeoutMs = T) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, Referer: referer, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
      body: new URLSearchParams(form).toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function resolveOnMirror(mirror, { title, epNum, audio }) {
  const ref = (p) => `${mirror}${p}`;
  // 1. Filter -> best /watch/ match.
  const filter = await fetchText(`${mirror}/filter?keyword=${encodeURIComponent(title)}`, {
    userAgent: UA, referer: `${mirror}/`, timeoutMs: T,
  });
  const show = chooseShow(parseFilterLinks(filter), title);
  if (!show) throw new Error(`AniWave lists no match for "${title}"`);
  // 2. Episode list -> ids for the wanted episode.
  const epJson = await postForm(`${mirror}/ajax/episode/list/${show.id}`, { style: 'list' }, ref(`/watch/${show.slug}`));
  if (!epJson || epJson.status !== 200 || typeof epJson.result !== 'string') {
    throw new Error('AniWave episode list parse failed');
  }
  const eps = parseEpisodeList(epJson.result);
  if (!eps.length) throw new Error(`AniWave lists no episodes for "${title}"`);
  const ep = eps.find((e) => e.num === epNum) || eps[0];
  // 3. Servers -> per-server sources (every live server offered; dead video
  // hosts fail the prescreen downstream instead of killing the lane).
  // NOTE: ids/linkId are concatenated RAW (like the site's own JS does):
  // ids is '81553&eps=1' — encoding the & breaks the server's parsing.
  const svText = await fetchText(
    `${mirror}/ajax/server/list?servers=${ep.ids}`,
    { headers: { 'X-Requested-With': 'XMLHttpRequest' }, userAgent: UA, referer: ref(`/watch/${show.slug}`), timeoutMs: T }
  );
  const svJson = JSON.parse(svText);
  if (!svJson || svJson.status !== 200 || typeof svJson.result !== 'string') {
    throw new Error('AniWave server list parse failed');
  }
  const group = pickGroup(parseServerGroups(svJson.result), audio);
  if (!group) throw new Error(`AniWave has no ${audio} servers for "${title}" E${ep.num}`);
  const sources = [];
  for (const s of group.servers.slice(0, 4)) {
    try {
      const srcText = await fetchText(
        `${mirror}/ajax/sources?id=${s.linkId}&asi=0&autoPlay=0`,
        { headers: { 'X-Requested-With': 'XMLHttpRequest' }, userAgent: UA, referer: ref(`/watch/${show.slug}`), timeoutMs: T }
      );
      const srcJson = JSON.parse(srcText);
      const url = srcJson?.result?.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
      const seg = (v) => (Array.isArray(v) && v[1] > v[0] && v[0] >= 0 ? { start: v[0], end: v[1] } : undefined);
      const skip = srcJson.result.skip_data
        ? { intro: seg(srcJson.result.skip_data.intro), outro: seg(srcJson.result.skip_data.outro) }
        : null;
      const clean = skip && (skip.intro || skip.outro) ? { skip } : {};
      sources.push({ ...embedSource(url, 'aniwave'), quality: `auto ${audio} (sv${s.svId})`, ...clean });
    } catch {
      // One dead server must not kill the lane — the next may be alive.
    }
  }
  if (!sources.length) throw new Error(`AniWave servers all failed for "${title}" E${ep.num}`);
  return { embedUrl: ref(`/watch/${show.id}/ep-${ep.num}`), sources };
}

export const aniwave = {
  id: 'aniwave',
  name: 'AniWave-style',
  site: 'aniwaves.ru (FMHY anime)',
  sites: [...MIRRORS],
  tokens: ['aniwave'],
  direct: false,
  kinds: ['anime'],
  async resolve(media, opts = {}) {
    const title = String(media?.title || '').trim();
    if (!title) throw new Error('AniWave needs a title to search.');
    const epNum = Number(media?.episode?.number ?? media?.episode) || 1;
    const audio = opts.audio === 'dub' ? 'dub' : 'sub';
    let firstErr = null;
    for (const mirror of MIRRORS) {
      try {
        return await resolveOnMirror(mirror, { title, epNum, audio });
      } catch (e) {
        // First error wins: a later mirror's misleading error (e.g. a parked
        // domain's empty page) must not mask the real failure.
        if (!firstErr) firstErr = e;
      }
    }
    throw firstErr || new Error(`AniWave could not resolve "${title}"`);
  },
};
