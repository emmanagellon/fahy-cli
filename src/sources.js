// FMHY source checker — diffs our anime providers against the live
// https://fmhy.net/video Anime Streaming list, probes provider health,
// and picks the fastest healthy default. FMHY domains rotate constantly,
// so this is how domain drift gets caught without reading the wiki by hand.
import { fetchText } from './net.js';
import { probeUrl } from './probe.js';

export const FMHY_VIDEO_URL = 'https://fmhy.net/video';

const LINK_RE = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
// Social/invite/status links are noise, not watch sources.
const NOISE = ['discord', 'github', 'telegram', 't.me', 'reddit', 'rentry', 'greasyfork', 'twitter', 'x.com', 'status.'];
// Mirror labels ("2", "3") and nav links ("Wiki", "Backups") are not sources.
const NAME_NOISE = new Set(['wiki', 'backups', 'mirrors', 'status', 'index', 'guide', 'enhancements', 'downloader']);

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

// Extract { name, url, host } entries from FMHY's Anime Streaming section.
// Throws (instead of returning garbage) when the FMHY layout changes.
export function parseFmhyAnimeSection(html) {
  const text = String(html || '');
  // Exact id match: a plain substring search hits 'anime-streaming-apps'
  // (which appears earlier in the page) before the real section.
  const anchor = text.search(/id="anime-streaming"/);
  if (anchor < 0) throw new Error('FMHY layout changed (anime section not found).');
  const bodyStart = text.indexOf('>', anchor) + 1;
  let end = text.indexOf('<h2', bodyStart);
  const h3 = text.indexOf('<h3', bodyStart);
  if (h3 > 0 && (end < 0 || h3 < end)) end = h3;
  const section = end < 0 ? text.slice(bodyStart) : text.slice(bodyStart, end);
  const seen = new Map();
  for (const m of section.matchAll(LINK_RE)) {
    const url = m[1];
    const host = hostOf(url);
    if (!host || NOISE.some((n) => host.includes(n))) continue;
    // Mirror labels ("2", "5") and nav links ("Wiki") are not real names —
    // keep the host, fall back to it for display.
    let name = stripTags(m[2]) || host;
    if (/^\d+$/.test(name) || NAME_NOISE.has(name.toLowerCase())) name = host;
    if (!seen.has(host)) seen.set(host, { name, url, host });
  }
  return [...seen.values()];
}

// Match providers against FMHY entries by host overlap, falling back to
// name tokens (catches domain drift: same site, new TLD).
// Status: 'ok' (host matches) | 'drift' (name matches, hosts differ) | 'missing'.
export function matchCoverage(fmhySites, animeProviders) {
  return animeProviders.map((p) => {
    const ours = (p.sites || []).map(hostOf).filter(Boolean);
    const byHost = fmhySites.filter((s) => ours.includes(s.host));
    const toks = (p.tokens || [p.id]).map((t) => String(t).toLowerCase());
    const byName = fmhySites.filter(
      (s) =>
        !byHost.includes(s) &&
        toks.some((t) => (s.name || '').toLowerCase().includes(t) || s.host.includes(t))
    );
    const fmhy = [...byHost, ...byName];
    return {
      id: p.id,
      name: p.name,
      sites: p.sites || [],
      fmhy,
      status: fmhy.length ? (byHost.length ? 'ok' : 'drift') : 'missing',
    };
  });
}

export async function fetchFmhyAnimeSites(opts = {}) {
  const html = await fetchText(FMHY_VIDEO_URL, {
    timeoutMs: opts.timeoutMs || 15000,
    userAgent: 'Mozilla/5.0',
    debug: opts.debug,
  });
  return parseFmhyAnimeSection(html);
}

// Probe each provider's primary site. Returns [{ id, url, status, ms }].
export async function probeProviders(list, { timeoutMs = 8000 } = {}) {
  const out = [];
  for (const p of list) {
    const url = (p.sites || [])[0];
    if (!url) {
      out.push({ id: p.id, url: null, status: 'unknown', ms: null });
      continue;
    }
    const t = Date.now();
    try {
      const r = await probeUrl(url, { timeoutMs });
      out.push({ id: p.id, url, status: r.status, ms: Date.now() - t, reason: r.reason });
    } catch (e) {
      out.push({ id: p.id, url, status: 'error', ms: Date.now() - t, reason: e.message });
    }
  }
  return out;
}

// Daily-watcher diff: which FMHY entries match no provider (fresh —
// candidates for future adapters, never auto-added) and which providers
// drifted off their FMHY hosts. Pure; the caller fetches + persists.
export function diffFmhySources(fmhySites, laneProviders) {
  const coverage = matchCoverage(fmhySites, laneProviders);
  const covered = new Set(coverage.flatMap((c) => c.fmhy));
  return {
    coverage,
    drifted: coverage.filter((c) => c.status !== 'ok'),
    fresh: (fmhySites || []).filter((s) => !covered.has(s)),
  };
}
// Fastest reachable provider — the "best source" pick for --update-sources.
export function bestProvider(health) {
  const ok = (health || []).filter((h) => h.status === 'reachable').sort((a, b) => a.ms - b.ms);
  return ok[0] || null;
}
