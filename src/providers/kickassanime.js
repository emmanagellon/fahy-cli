// KickAssAnime provider — full episode resolution (kaa.lt internal API).
// Chain: show index (/api/anime?page=) -> show (/api/show/{slug}) ->
// episodes (/api/show/{slug}/episodes?lang=) -> episode
// (/api/show/{slug}/episode/ep-{num}-{slug}) -> server src (cat-player)
// whose Astro-isostar props embed the HLS manifest + subtitle tracks.
// The m3u8 CDN (hls.krussdomi.com) is Referer-locked to the player origin —
// mpv gets the header via direct HLS (same pattern as megaplay/hianime).
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fetchText, fetchJsonVia } from '../net.js';
import { parseLadder } from '../hls.js';
import { pickEnglish, downloadSub } from '../subs.js';
import { configDir } from '../lib/paths.js';

const BASE = 'https://kaa.lt';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = `${BASE}/`;
const INDEX_TTL_MS = 12 * 3600_000;
const INDEX_PAGE_CONCURRENCY = 8;

const normTitle = (v) =>
  String(v || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function indexFile() {
  const d = configDir();
  mkdirSync(d, { recursive: true });
  return join(d, 'kaa-index.json');
}

async function fetchApi(path, opts = {}) {
  return fetchJsonVia(`${BASE}/api${path}`, {
    headers: {},
    userAgent: UA,
    referer: REFERER,
    timeoutMs: opts.timeoutMs || 15000,
    signal: opts.signal,
    debug: opts.debug,
  });
}

async function fetchIndex(opts = {}) {
  const f = indexFile();
  let stale = null;
  try {
    if (existsSync(f)) {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      if (data && Array.isArray(data.shows)) stale = data;
    }
  } catch {}
  if (stale && Date.now() - (Date.parse(stale.at) || 0) < INDEX_TTL_MS) return stale;
  // Rebuild: page 1 carries maxPage, then fetch the rest concurrently.
  const first = await fetchApi('/anime?page=1', opts);
  const maxPage = Math.max(1, Number(first.maxPage) || 1);
  const pages = [first];
  const pool = async (jobs, limit) => {
    const results = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        try {
          results[i] = await jobs[i]();
        } catch (e) {
          if (opts.debug) console.error(`[kickassanime] index page ${i + 2}: ${e.message}`);
        }
      }
    });
    await Promise.all(workers);
    return results;
  };
  const rest = await pool(
    Array.from({ length: maxPage - 1 }, (_, i) => () => fetchApi(`/anime?page=${i + 2}`, opts)),
    INDEX_PAGE_CONCURRENCY
  );
  const seen = new Map();
  for (const p of [first, ...rest]) {
    for (const s of p?.result || []) {
      if (s && s.slug && /^[a-z0-9-]+$/.test(s.slug)) seen.set(s.slug, s);
    }
  }
  const shows = [...seen.values()];
  if (shows.length) {
    try {
      writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), shows }, null, 2));
    } catch (e) {
      if (opts.debug) console.error(`[kickassanime] index save: ${e.message}`);
    }
  }
  if (shows.length) return { at: new Date().toISOString(), shows };
  if (stale) return stale;
  throw new Error(`KickAssAnime index is empty (got ${maxPage} page(s))`);
}

function chooseShow(title, index, year) {
  const q = normTitle(title);
  if (!q) return null;
  const y = Number(year);
  const rows = (index.shows || []).filter((s) => {
    const ts = [normTitle(s.title), normTitle(s.title_en)].filter(Boolean);
    return ts.some(
      (t) => t === q || t.startsWith(q + ' ') || q.startsWith(t + ' ') || t.includes(q) || q.includes(t)
    );
  });
  if (y) {
    const byYear = rows.filter((s) => String(s.year) === String(y));
    if (byYear.length) return byYear[0];
  }
  return rows[0] || null;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Astro/isostar props: [0, scalar] and [1, array] wrappers around data.
function unwrapIsostar(v) {
  if (Array.isArray(v)) {
    if (v.length === 2 && (v[0] === 0 || v[0] === 1)) return unwrapIsostar(v[1]);
    return v.map(unwrapIsostar);
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = unwrapIsostar(x);
    return o;
  }
  return v;
}

// cat-player SSR: <astro-island props="..."> with manifest + subtitles.
export function parsePlayer(html) {
  const m = /<astro-island[^>]*props="([^"]*)"/.exec(html || '');
  if (!m) {
    const e = new Error('KickAssAnime player payload missing');
    e.code = 'kaa-player-missing';
    throw e;
  }
  const raw = decodeEntities(m[1]);
  const i0 = raw.indexOf('{');
  const i1 = raw.lastIndexOf('}');
  if (i0 < 0 || i1 <= i0) {
    const e = new Error('KickAssAnime player payload not JSON');
    e.code = 'kaa-player-json-invalid';
    throw e;
  }
  let props;
  try {
    props = unwrapIsostar(JSON.parse(raw.slice(i0, i1 + 1)));
  } catch {
    // Fallback: regex the manifest out of the raw HTML.
    const m3u8 = /https:\/\/hls\.krussdomi\.com\/manifest\/[0-9a-f]+\/master\.m3u8/.exec(html || '')?.[0];
    if (m3u8) return { manifest: m3u8, subtitles: [] };
    const e = new Error('KickAssAnime player payload unparseable');
    e.code = 'kaa-player-json-invalid';
    throw e;
  }
  if (!props || typeof props.manifest !== 'string' || !/^https:\/\/hls\.krussdomi\.com\/manifest\//.test(props.manifest)) {
    const e = new Error('KickAssAnime player has no HLS manifest');
    e.code = 'kaa-player-no-manifest';
    throw e;
  }
  const subtitles = Array.isArray(props.subtitles)
    ? props.subtitles
        .filter((s) => s && /^https:\/\/subst\.krussdomi\.com\//.test(s.src || ''))
        .map((s) => ({ lang: s.language, label: s.name, url: s.src }))
    : [];
  return { manifest: props.manifest, subtitles };
}

export const kickassanime = {
  id: 'kickassanime',
  name: 'KickAssAnime',
  site: 'kaa.lt (FMHY anime)',
  sites: [BASE],
  tokens: ['kickass', 'kaa'],
  direct: true, // direct Referer-locked HLS + soft subs
  kinds: ['anime'],
  async search(query, opts = {}) {
    const index = await fetchIndex(opts);
    const q = normTitle(query);
    if (!q) return [];
    return index.shows
      .filter((s) => {
        const ts = [normTitle(s.title), normTitle(s.title_en)].filter(Boolean);
        return ts.some((t) => t && t.includes(q));
      })
      .slice(0, 10)
      .map((s) => ({ providerId: s.slug, title: s.title_en || s.title, showId: s.slug }));
  },
  async resolve(media, opts = {}) {
    const mode = opts.audio === 'dub' ? 'dub' : 'sub';
    const epNum = Number(media.episode?.number ?? media.episode) || 1;
    const title = String(media?.title || '').trim();
    if (!title) throw new Error('KickAssAnime needs a title to search.');

    const index = await fetchIndex(opts);
    const show = chooseShow(title, index, media?.year);
    if (!show) throw new Error(`KickAssAnime has no entry for "${title}"`);

    const meta = await fetchApi(`/show/${show.slug}`, opts);
    const locales = Array.isArray(meta?.locales) ? meta.locales : [];
    let locale = locales[0];
    if (mode === 'dub') {
      locale = locales.find((l) => /^en\b/i.test(l) || /^en-/.test(l)) || locale;
      if (!locale?.toLowerCase().startsWith('en')) {
        throw new Error(
          `KickAssAnime has no ${mode} for ${show.title_en || show.title}` +
          (locales.length ? ` (audios: ${locales.join(', ')})` : '')
        );
      }
    }
    if (!locale) throw new Error(`KickAssAnime show ${show.slug} lists no audio locales`);

    const eps = await fetchApi(`/show/${show.slug}/episodes?lang=${encodeURIComponent(locale)}`, opts);
    const entries = Array.isArray(eps?.result) ? eps.result : [];
    const entry = entries.find((x) => Number(x?.episode_number) === epNum);
    if (!entry) {
      throw new Error(
        `KickAssAnime has no episode ${epNum} for ${show.title_en || show.title}` +
        (entries.length ? ` (${entries.length} listed)` : '')
      );
    }

    const epSlug = String(entry.slug || '');
    const epPage = await fetchApi(`/show/${show.slug}/episode/ep-${entry.episode_string}-${epSlug}`, opts);
    const server = (Array.isArray(epPage?.servers) ? epPage.servers : []).find((s) => s && /^https?:\/\//.test(s.src));
    if (!server) throw new Error(`KickAssAnime has no stream servers for ${show.title_en || show.title} E${epNum}`);

    const playerHtml = await fetchText(server.src, {
      userAgent: UA,
      referer: REFERER,
      timeoutMs: opts.timeoutMs || 15000,
      signal: opts.signal,
      debug: opts.debug,
    });
    const parsed = parsePlayer(playerHtml);

    // Segments resolve to st1.* CDN hosts — they 403 without the player's
    // Origin (Referer alone is not enough).
    const origin = `${new URL(server.src).origin}/`;
    const headers = { Referer: origin, Origin: origin.replace(/\/$/, ''), 'User-Agent': UA };

    // Master + ladder. Every variant URLs a single rendition so mpv never
    // auto-selects a broken one: KAA's CDN intermittently 404s segment files
    // of a rendition (its 720p tier was fully reaping 404s). Verify seg 0 of
    // each variant with a 1-byte range grab; drop hard 404s, keep the rest.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    let masterText = null;
    try {
      const res = await fetch(parsed.manifest, { headers, signal: ctrl.signal });
      if (res.ok) masterText = await res.text();
    } catch (e) {
      if (opts.debug) console.error(`[kickassanime] master: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
    let variants = masterText ? parseLadder(masterText, parsed.manifest) : [];
    if (variants.length > 1) {
      const headersFor = (url) => ({ ...headers, 'Range': 'bytes=0-0' });
      const probe = async (variant) => {
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 6000);
          try {
            const pl = await fetch(variant.url, { headers: headersFor(variant.url), signal: ac.signal });
            if (!pl.ok) return { variant, ok: false };
            let seg = null;
            try {
              const body = await pl.text();
              seg = body.split('\n').find((l) => l && !l.startsWith('#'));
            } catch {}
            if (!seg) return { variant, ok: null };
            const segUrl = seg.startsWith('//') ? `https:${seg}` : new URL(seg, variant.url).href;
            const s = await fetch(segUrl, { headers: headersFor(segUrl), signal: ac.signal });
            await s.body?.cancel?.().catch(() => {});
            return { variant, ok: s.status !== 404 };
          } finally {
            clearTimeout(timer);
          }
        } catch (e) {
          return { variant, ok: null }; // network blip: keep it, don't punish
        }
      };
      const results = await Promise.all(variants.map(probe));
      const dropped = results.filter((r) => r.ok === false).map((r) => r.variant.quality);
      if (dropped.length && opts.debug) console.error(`[kickassanime] skipping dead renderings: ${dropped.join(', ')}`);
      variants = results.filter((r) => r.ok !== false).map((r) => r.variant);
    }
    if (!variants.length) variants = [{ url: parsed.manifest, quality: 'auto', rank: 0 }];
    variants.sort((a, b) => b.rank - a.rank);
    // Cap at 1080p: default source pick would otherwise make mpv open 4K.
    const capped = variants.filter((v) => v.rank <= 1080);
    if (capped.length) variants = capped;

    let subFile = null;
    let subMissing = false;
    const sub = pickEnglish(parsed.subtitles);
    if (sub) {
      subFile = await downloadSub(sub.url, `kaa-${show.slug}-${entry.episode_string}.vtt`, { 'User-Agent': UA, Referer: origin });
      if (!subFile) subMissing = true;
    } else {
      subMissing = true;
    }

    const watchUrl = `${BASE}/${show.slug}/ep-${entry.episode_string}-${epSlug}`;
    const sources = variants.map((v) => ({
      url: v.url,
      quality: `${mode} ${v.quality || 'auto'}`,
      type: 'hls',
      provider: 'kickassanime',
      direct: true,
      headers,
      ...(subFile ? { subFile } : {}),
      ...(subMissing ? { subMissing: true } : {}),
    }));
    return { embedUrl: watchUrl, sources };
  },
};