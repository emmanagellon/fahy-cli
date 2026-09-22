import { embedSource, fetchJson } from './base.js';
import { fetchText } from '../net.js';

// Shared engine for the AniWave-clone family (anikototv.to, animesuge.cz —
// same filter/playback flow, verified per site):
//   filter page -> /watch/ match -> ajax/episode/list/{id} -> episode ids
//   -> ajax/server/list -> ajax/server?get=<token>
// yields per-server embed URLs. Show ids come from the poster's data-tip
// (slugs end in a hash, not a number). Dead video hosts (404/gone, they rot
// fast) are filtered by the prescreen downstream; every live server is
// offered. Sub by default, dub when asked.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const T = 12000;

const normTitle = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// '/watch/one-piece-81553' -> { slug, id: '81553', ... } (numeric-tail shape).
export function parseWatchSlug(href) {
  const slug = String(href || '').split(/[?#]/)[0].replace(/^\/*watch\//i, '').replace(/\/+$/, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/i.test(slug)) return null;
  return { slug, id: slug.split('-').pop(), title: normTitle(slug.replace(/-\d+$/, '').replace(/-/g, ' ')) };
}

export function parseFilterLinks(html) {
  const text = String(html || '');
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(/href="((?:https?:\/\/[^/]+)?\/(?:watch|anime)\/[^"]+)"/gi)) {
    const path = m[1].replace(/^https?:\/\/[^/]+/i, '');
    const tail = parseWatchSlug(path);
    let id = tail?.id || null;
    let slug = tail?.slug || path.replace(/^\/*(watch|anime)\//i, '').replace(/\/+$/, '');
    if (!id) {
      // Anikoto/Anisuge shape: the numeric id rides on the poster's
      // data-tip attribute just before the link.
      const back = text.slice(Math.max(0, m.index - 900), m.index);
      const tips = [...back.matchAll(/data-tip="(\d+)"/gi)].map((t) => t[1]);
      id = tips.length ? tips[tips.length - 1] : null;
    }
    if (!id || !slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, id, path, title: normTitle(slug.replace(/-\d+$/, '').replace(/-/g, ' ')) });
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

// Episode list HTML -> [{ num, href, ids }].
// The clone-family dialect: href="#"/"#0" where the episode number rides on
// data-num (anikoto) or data-slug (anisuge), ids on data-ids alone.
export function parseEpisodeList(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = m[1] || '';
    const href = /(?:^|\s)href\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    const num = parseInt(
      /(?:^|\s)data-num\s*=\s*["'](\d+)["']/i.exec(attrs)?.[1] ||
      /(?:^|\s)data-slug\s*=\s*["'](\d+)["']/i.exec(attrs)?.[1] || '', 10);
    const ids = /(?:^|\s)data-ids\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.replace(/&amp;/g, '&');
    if (!Number.isInteger(num) || num <= 0 || !ids) continue;
    if (!/\/ep-\d+/i.test(href) && !/^#?$/i.test(href)) continue;
    out.push({ num, href: /^#?$/i.test(href) ? null : href, ids });
  }
  return out.sort((a, b) => a.num - b.num);
}

// Server list HTML -> [{ type: 'sub'|'dub'|..., servers: [{ svId, linkId }] }].
// Attribute-driven, tolerant of the family's markup drift: groups are any
// element with data-type; servers are data-sv-id + data-link-id (svId may be
// numeric on some mirrors, hexadecimal on animesuge).
export function parseServerGroups(html) {
  const text = String(html || '');
  const groups = [];
  for (const g of text.matchAll(/data-type\s*=\s*["'](\w+)["']/gi)) {
    groups.push({ type: g[1].toLowerCase(), at: g.index, servers: [] });
  }
  for (const m of text.matchAll(/data-sv-id\s*=\s*["']([^"']+)["']\s+data-link-id\s*=\s*["']([^"']+)["']/gi)) {
    const owner = [...groups].filter((g) => g.at < m.index).sort((a, b) => b.at - a.at)[0];
    if (owner) owner.servers.push({ svId: m[1], linkId: m[2] });
  }
  return groups.filter((g) => g.servers.length).map(({ type, servers }) => ({ type, servers }));
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
      headers: { 'User-Agent': UA, Referer: referer, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Connection: 'close' },
      body: new URLSearchParams(form).toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function absUrl(mirror, href) {
  try {
    return new URL(href, mirror).toString();
  } catch {
    return href;
  }
}

// megaplay.buzz embeds (the anikoto/anisuge video hosts) are JS-wall players:
// the page itself is unplayable by yt-dlp. Their stream API
// (stream/getSources?id=<realid>) exposes the CDN path via subtitle tracks, and
// the HLS master lives one level up as master.m3u8. The CDN is Referer-locked
// (no header -> 403), so the converted source carries headers and is marked
// direct so mpv opens the m3u8 natively with --http-header-fields (yt-dlp
// can't attach our headers). Non-megaplay embeds return null untouched.
async function megaplayToHls(embedUrl, { userAgent = UA, referer, timeoutMs = T } = {}) {
  const m = /\/stream\/s-\d+\/([^/]+)\/(?:sub|dub)\/?/i.exec(embedUrl);
  if (!m || !/^https:\/\//i.test(embedUrl)) return null;
  const origin = new URL(embedUrl).origin;
  const json = await fetchJson(`${origin}/stream/getSources?id=${encodeURIComponent(m[1])}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json, */*', 'X-Requested-With': 'XMLHttpRequest', Referer: referer || embedUrl },
    timeoutMs,
  });
  const tracks = Array.isArray(json?.tracks) ? json.tracks : [];
  const direct = Array.isArray(json?.sources) ? json.sources : [];
  const sub = (tracks.find((t) => /\.(vtt|srt)(?:\?|$)/i.test(t.file)) || tracks[0])?.file;
  let m3u8 = null;
  if (sub) {
    m3u8 = /\/subtitles\/[^/]+(?:\?|$)/i.test(sub)
      ? sub.replace(/\/subtitles\/[^/]+(?:\?.*)?$/i, '') + '/master.m3u8'
      : new URL('../master.m3u8', sub).href;
  }
  if (!m3u8) m3u8 = direct.find((sc) => /\.m3u8/i.test(sc.file))?.file || null;
  if (!m3u8) return null;
  return { url: m3u8, headers: { Referer: `${origin}/` }, subFile: sub || null };
}

async function resolveOnMirror(mirror, cfg, { title, epNum, audio }) {
  const { label, providerId } = cfg;
  const ref = (p) => `${mirror}${p.startsWith('/') ? p : `/${p}`}`;
  // 1. Filter -> best show match.
  const filter = await fetchText(`${mirror}/filter?keyword=${encodeURIComponent(title)}`, {
    userAgent: UA, referer: `${mirror}/`, timeoutMs: T,
  });
  const show = chooseShow(parseFilterLinks(filter), title);
  if (!show) throw new Error(`${label} lists no match for "${title}"`);
  const showRef = absUrl(mirror, show.path || `/watch/${show.slug}`);
  // 2. Episode list -> ids for the wanted episode.
  const epJson = await postForm(`${mirror}/ajax/episode/list/${show.id}`, { style: 'list' }, showRef);
  if (!epJson || epJson.status !== 200 || typeof epJson.result !== 'string') {
    throw new Error(`${label} episode list parse failed`);
  }
  const eps = parseEpisodeList(epJson.result);
  if (!eps.length) throw new Error(`${label} lists no episodes for "${title}"`);
  const ep = eps.find((e) => e.num === epNum) || eps[0];
  // 3. Servers -> per-server sources (every live server offered; dead video
  // hosts fail the prescreen downstream instead of killing the lane).
  // NOTE: ids/linkId are concatenated RAW (like the site's own JS does):
  // ids is '81553&eps=1' — encoding the & breaks the server's parsing.
  const svText = await fetchText(
    `${mirror}/ajax/server/list?servers=${ep.ids}`,
    { headers: { 'X-Requested-With': 'XMLHttpRequest' }, userAgent: UA, referer: showRef, timeoutMs: T }
  );
  const svJson = JSON.parse(svText);
  if (!svJson || svJson.status !== 200 || typeof svJson.result !== 'string') {
    throw new Error(`${label} server list parse failed`);
  }
  const group = pickGroup(parseServerGroups(svJson.result), audio);
  if (!group) throw new Error(`${label} has no ${audio} servers for "${title}" E${ep.num}`);
  let sources = [];
  const resolved = await Promise.all(
    group.servers.slice(0, 4).map(async (s) => {
      try {
        // The clone family hands the server token straight to /ajax/server?get=
        // and gets { status, result: { url, skip_data } } back. Weapons in
        // parallel — serial probing made multi-server mirrors take seconds.
        const srcText = await fetchText(
          `${mirror}/ajax/server?get=${s.linkId}`,
          { headers: { 'X-Requested-With': 'XMLHttpRequest' }, userAgent: UA, referer: showRef, timeoutMs: T }
        );
        const srcJson = JSON.parse(srcText);
        const url = srcJson?.result?.url;
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
        const seg = (v) => (Array.isArray(v) && v[1] > v[0] && v[0] >= 0 ? { start: v[0], end: v[1] } : undefined);
        const skip = srcJson.result.skip_data
          ? { intro: seg(srcJson.result.skip_data.intro), outro: seg(srcJson.result.skip_data.outro) }
          : null;
        const clean = skip && (skip.intro || skip.outro) ? { skip } : {};
        const base = { ...embedSource(url, providerId), quality: `auto ${audio} (sv${s.svId})`, ...clean };
        const hls = await megaplayToHls(url, { referer: showRef }).catch(() => null);
        if (hls) {
          // JS-wall megaplay embed -> direct Referer-locked HLS.
          return { ...base, url: hls.url, type: 'hls', direct: true, headers: hls.headers, subFile: hls.subFile };
        }
        // Kept as an embed for the prescreen if megaplay conversion fails.
        return base;
      } catch {
        // One dead server must not kill the lane — the next may be alive.
        return null;
      }
    })
  );
  sources = resolved.filter(Boolean);
  if (!sources.length) throw new Error(`${label} servers all failed for "${title}" E${ep.num}`);
  // Several servers on the same video host share one master (megaplay HLS):
  // collapse identical URLs so the picker isn't full of clones.
  const seen = new Set();
  sources = sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  // The '#' dialect has no per-episode href — rebuild it from the show path.
  const watchRef = ep.href || `${(show.path || `/watch/${show.slug}`).replace(/\/ep-\d+$/i, '')}/ep-${ep.num}`;
  return { embedUrl: absUrl(mirror, watchRef), sources };
}

export function createClanAdapter({ id, name, site, sites, tokens, mirrors, label }) {
  return {
    id,
    name,
    site,
    sites: [...sites],
    tokens,
    direct: false,
    kinds: ['anime'],
    async resolve(media, opts = {}) {
      const title = String(media?.title || '').trim();
      if (!title) throw new Error(`${label} needs a title to search.`);
      const epNum = Number(media?.episode?.number ?? media?.episode) || 1;
      const audio = opts.audio === 'dub' ? 'dub' : 'sub';
      let firstErr = null;
      for (const mirror of mirrors) {
        try {
          return await resolveOnMirror(mirror, { label, providerId: id }, { title, epNum, audio });
        } catch (e) {
          // First error wins: a later mirror's misleading error must not
          // mask the real failure.
          if (!firstErr) firstErr = e;
        }
      }
      throw firstErr || new Error(`${label} could not resolve "${title}"`);
    },
  };
}
