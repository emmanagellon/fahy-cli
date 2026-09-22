// HiAnime provider — full episode resolution (kunai hianime/ parity, JS port).
// Chain: search -> episode catalog -> servers (ZokoAnime) -> embed decode
// (window.__P = base64(JSON XOR "otaku-embed-v1")) -> HLS quality ladder.
// Yields DIRECT HLS streams + soft subs + intro/outro skip times: mpv plays
// these with no yt-dlp involved. Only the ZokoAnime server is understood
// (HD-1/Vidstream answer 410 upstream); a missing sub/dub fails closed.
import { fetchText, fetchJsonVia } from '../net.js';
import { parseLadder } from '../hls.js';
import { pickEnglish, downloadSub } from '../subs.js';

const BASE = 'https://hianime.at';
// FMHY lists hianime.ad; .at is kept primary (verified reachable) with .ad
// as automatic fallback — HiAnime domains rotate frequently.
const MIRRORS = ['https://hianime.at', 'https://hianime.ad'];
const REFERER_FOR = (base) => (base.endsWith('/') ? base : `${base}/`);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SUPPORTED_SERVER = 'ZokoAnime';
const XOR_KEY = 'otaku-embed-v1';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function attr(tag, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m?.[1]?.trim() || undefined;
}

function hasClass(attrs, token) {
  return (attr(attrs, 'class') || '').split(/\s+/).some((c) => c.toLowerCase() === token);
}

function lastSegment(href) {
  const segs = (href.split(/[?#]/)[0] || '').split('/').filter(Boolean);
  return segs[segs.length - 1] || '';
}

const looksShowId = (v) => /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/i.test((v || '').trim());
const numericId = (slug) => {
  const m = /-(\d+)$/.exec((slug || '').trim());
  const n = m?.[1] ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};
const normTitle = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function parseSearch(html) {
  const main = html.split('id="main-sidebar"')[0] || html;
  const out = [];
  const seen = new Set();
  for (const block of main.split('<div class="film-detail">').slice(1)) {
    const aTag = /<h3 class="film-name">\s*(<a\b[^>]*>)/i.exec(block)?.[1];
    if (!aTag) continue;
    const href = attr(aTag, 'href');
    const title = decodeEntities(attr(aTag, 'title'));
    if (!href || !title) continue;
    const id = lastSegment(decodeEntities(href));
    if (!looksShowId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title });
  }
  return out;
}

export function chooseMatch(query, results) {
  const fallback = results[0] || null;
  const q = normTitle(query);
  if (!results.length || !q) return fallback;
  return (
    results.find((r) => normTitle(r.title) === q) ||
    results.find((r) => {
      const t = normTitle(r.title);
      return t.startsWith(q + ' ') || q.startsWith(t + ' ') || t.includes(q) || q.includes(t);
    }) ||
    fallback
  );
}

export function parseEpisodes(html, slug) {
  const out = [];
  let pos = 0;
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (!/\bep-item\b/.test(attrs)) continue;
    const epId = attr(attrs, 'data-id');
    if (!epId || !/^[0-9]+$/.test(epId)) continue;
    const href = attr(attrs, 'href');
    if (href && slug) {
      const hs = lastSegment(href.split('?ep=')[0] || '');
      if (hs && hs !== slug) continue;
    }
    pos += 1;
    const raw = attr(attrs, 'data-number');
    const n = raw !== undefined ? parseInt(raw, 10) : NaN;
    const number = Number.isInteger(n) && n > 0 ? n : pos;
    const jn = /data-jname\s*=\s*["']([^"']*)["']/i.exec(m[2] || '')?.[1];
    const title = jn?.trim() ? decodeEntities(jn) : undefined;
    out.push({ episodeId: epId, number, ...(title ? { title } : {}) });
  }
  return out;
}

export function parseServers(html) {
  const out = [];
  const re = /<div\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (!hasClass(attrs, 'server-item')) continue;
    const mode = (attr(attrs, 'data-type') || '').toLowerCase();
    if (mode !== 'sub' && mode !== 'dub') continue;
    const name = attr(attrs, 'data-server-name');
    const hash = attr(attrs, 'data-hash');
    if (!name || !hash) continue;
    let embedUrl = null;
    try {
      const dec = Buffer.from(hash, 'base64').toString('utf8').trim();
      if (/^https?:\/\//i.test(dec)) embedUrl = dec;
    } catch {}
    if (!embedUrl) continue;
    out.push({ audioMode: mode, serverName: name, embedUrl });
  }
  return out;
}

export function decodeEmbed(html) {
  const blob = /window\.__P="([^"]*)"/.exec(html)?.[1];
  if (!blob) {
    const e = new Error('embed payload missing (site changed?)');
    e.code = 'embed-blob-missing';
    throw e;
  }
  let enc;
  try {
    enc = Buffer.from(blob, 'base64');
  } catch {
    const e = new Error('embed payload not base64');
    e.code = 'embed-base64-invalid';
    throw e;
  }
  const key = Buffer.from(XOR_KEY, 'utf8');
  const out = Buffer.alloc(enc.length);
  for (let i = 0; i < enc.length; i++) out[i] = enc[i] ^ key[i % key.length];
  let doc;
  try {
    doc = JSON.parse(out.toString('utf8'));
  } catch {
    const e = new Error('embed payload not JSON (key rotated?)');
    e.code = 'embed-json-invalid';
    throw e;
  }
  if (!doc || typeof doc !== 'object' || !/^https?:\/\//i.test(doc.src || '')) {
    const e = new Error('embed payload has no stream URL');
    e.code = 'embed-shape-invalid';
    throw e;
  }
  const subs = Array.isArray(doc.subtitles) ? doc.subtitles.filter((s) => s && /^https?:\/\//i.test(s.src)) : [];
  const seg = (v) => (v && typeof v.start === 'number' && typeof v.end === 'number' && v.end > v.start && v.start >= 0 ? { start: v.start, end: v.end } : undefined);
  return {
    src: doc.src.trim(),
    subtitles: subs.map((s) => ({ lang: s.lang, label: s.label, default: s.default === true, src: s.src.trim() })),
    intro: seg(doc.skip?.intro),
    outro: seg(doc.skip?.outro),
    downloadUrl: typeof doc.download_url === 'string' && doc.download_url.trim() ? doc.download_url.trim() : undefined,
  };
}

// parseLadder lives in ../hls.js (shared) — do not duplicate it here.

const catalogCache = new Map(); // session-only: never stale across runs, avoids re-fetch windows
async function episodeCatalog(base, slug, opts = {}) {
  const key = `${base}::${slug}`;
  if (catalogCache.has(key)) return catalogCache.get(key);
  const n = numericId(slug);
  if (n === null) throw new Error(`bad HiAnime show id: ${slug}`);
  const raw = await fetchJsonVia(`${base}/api/theme/episode/list/${n}`, {
    headers: {}, userAgent: UA, referer: REFERER_FOR(base), timeoutMs: 15000, signal: opts.signal, debug: opts.debug,
  });
  if (!raw || typeof raw.html !== 'string') throw new Error('HiAnime episode catalog parse failed');
  const entries = parseEpisodes(raw.html, slug);
  if (!entries.length) throw new Error(`HiAnime has no episodes listed for ${slug}`);
  catalogCache.set(key, entries);
  return entries;
}

async function episodeServers(base, episodeId, opts = {}) {
  const raw = await fetchJsonVia(`${base}/api/theme/episode/servers?episodeId=${encodeURIComponent(episodeId)}`, {
    headers: {}, userAgent: UA, referer: REFERER_FOR(base), timeoutMs: 15000, signal: opts.signal, debug: opts.debug,
  });
  if (!raw || typeof raw.html !== 'string') throw new Error('HiAnime servers response parse failed');
  return parseServers(raw.html);
}

// HiAnime mirrors rotate: probe all in parallel, keep the one that answers.
// Search results are also cached per session (the same keyword resolves
// again during play), so typing a query then playing an episode is 2 fetches,
// not 4.
const searchCache = new Map(); // keyword -> { page, base }
async function searchMirrors(keyword, opts = {}) {
  const key = String(keyword || '').trim();
  const hit = searchCache.get(key);
  if (hit) return hit;
  let lastErr = null;
  const attempts = MIRRORS.map(async (base) => {
    try {
      const page = await fetchText(`${base}/search?keyword=${encodeURIComponent(key).replace(/%20/g, '+')}`, {
        userAgent: UA, referer: REFERER_FOR(base), timeoutMs: 10000, signal: opts.signal, debug: opts.debug,
      });
      return { page, base };
    } catch (e) {
      lastErr = e;
      if (opts.debug) console.error(`[hianime] ${base}: ${e.message}`);
      throw e;
    }
  });
  let result;
  try {
    result = await Promise.any(attempts);
  } catch {
    throw lastErr || new Error('HiAnime mirrors unreachable — try --provider anikoto or anisuge.');
  }
  if (searchCache.size >= 64) searchCache.clear();
  searchCache.set(key, result);
  return result;
}

export const hianime = {
  id: 'hianime',
  name: 'HiAnime',
  site: 'hianime.at / hianime.ad (FMHY anime)',
  sites: ['https://hianime.at', 'https://hianime.ad'],
  tokens: ['hianime', 'aniwatch'],
  direct: true, // direct HLS ladder + subs + skip times
  kinds: ['anime'],
  async search(query, opts = {}) {
    const { page } = await searchMirrors(query.trim(), opts);
    return parseSearch(page).map((r) => ({ providerId: r.id, title: r.title, showId: r.id }));
  },
  async resolve(media, opts = {}) {
    const mode = opts.audio === 'dub' ? 'dub' : 'sub';
    const epNum = Number(media.episode?.number ?? media.episode) || 1;
    if (!String(media?.title || '').trim()) throw new Error('HiAnime needs a title to search.');
    // 1. Show match (exact -> prefix -> first, like kunai).
    const { page, base } = await searchMirrors(media.title.trim(), opts);
    const referer = REFERER_FOR(base);
    const match = chooseMatch(media.title, parseSearch(page));
    if (!match) throw new Error(`HiAnime has no entry for "${media.title}"`);
    // 2. Episode catalog -> entry by number.
    const catalog = await episodeCatalog(base, match.id, opts);
    const entry = catalog.find((x) => x.number === epNum);
    if (!entry) throw new Error(`HiAnime has no episode ${epNum} for ${match.title} (${catalog.length} listed)`);
    // 3. Servers -> ZokoAnime in the requested mode (fail closed, no fallback).
    const servers = await episodeServers(base, entry.episodeId, opts);
    const observed = [...new Set(servers.map((s) => s.serverName))];
    const embedUrl = servers.find((s) => s.audioMode === mode && s.serverName.localeCompare(SUPPORTED_SERVER, undefined, { sensitivity: 'accent' }) === 0)?.embedUrl;
    if (!embedUrl) {
      throw new Error(
        `HiAnime has no ${mode} stream for ${match.title} E${epNum}` +
        (observed.length ? ` (servers seen: ${observed.join(', ')})` : ' (no servers listed)')
      );
    }
    // 4. Embed decode -> master HLS + subs + skip times.
    const origin = new URL(embedUrl).origin + '/';
    const embedHtml = await fetchText(embedUrl, { userAgent: UA, referer, timeoutMs: 15000, debug: opts.debug });
    const payload = decodeEmbed(embedHtml);
    // 5. Quality ladder + English sub — fetched IN PARALLEL (both derive from
    // the embed payload, and the sub used to block play-start on a serial tail).
    const headers = { Referer: origin, 'User-Agent': UA };
    const [variants, subFile] = await Promise.all([
      (async () => {
        const ladderHeaders = { ...headers, Origin: origin.replace(/\/$/, ''), Connection: 'close' };
        let variants = [];
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 12000);
          try {
            const res = await fetch(payload.src, { headers: ladderHeaders, signal: ctrl.signal });
            if (res.ok) {
              const text = await res.text();
              if (/#EXT-X-STREAM-INF/i.test(text)) variants = parseLadder(text, payload.src);
            }
          } finally {
            clearTimeout(t);
          }
        } catch (e) {
          if (opts.debug) console.error(`[hianime] ladder: ${e.message}`);
        }
        if (!variants.length) variants = [{ url: payload.src, quality: 'auto', rank: 0 }];
        return variants.sort((a, b) => b.rank - a.rank);
      })(),
      (async () => {
        // A failed/missing sub is LOUD (silent no-subs playback confuses
        // everyone) — subMissing surfaces as a printed warning.
        const sub = pickEnglish(payload.subtitles.map((s) => ({ url: s.src, lang: s.lang, label: s.label })));
        if (!sub) return null;
        return downloadSub(sub.url, `hi-${entry.episodeId}-${mode}.vtt`, { 'User-Agent': UA, Referer: origin });
      })(),
    ]);
    const subMissing = !subFile;
    const skip = payload.intro || payload.outro ? { intro: payload.intro, outro: payload.outro } : null;
    const watchUrl = `${base}/watch/${match.id}?ep=${entry.episodeId}`;
    const sources = variants.map((v) => ({
      url: v.url, quality: `${v.quality} ${mode}`, type: 'hls', provider: 'hianime', direct: true,
      headers, ...(subFile ? { subFile } : {}), ...(skip ? { skip } : {}), ...(subMissing ? { subMissing: true } : {}),
    }));
    // NOTE: payload.downloadUrl (/download/...) is intentionally NOT offered:
    // it needs embed-session state — mpv/yt-dlp both reject it. HLS variants
    // cover watching, and yt-dlp downloads .m3u8 natively for --download.
    return { embedUrl: watchUrl, sources };
  },
};
// Legacy: title-only resolve used to return a search page. Kept working via
// full chain above; watchUrl is the real episode page.
