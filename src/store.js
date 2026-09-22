import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { configDir } from './lib/paths.js';

// kunai lesson: local state must never vanish silently. All writes are atomic
// (tmp + rename) so a crash mid-write can't corrupt the file, and a corrupt
// file is backed up to .bak instead of being discarded.
function dataDir() {
  const d = configDir();
  mkdirSync(d, { recursive: true });
  return d;
}

function load(name, fallback) {
  const f = join(dataDir(), name);
  try {
    if (!existsSync(f)) return fallback;
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    try {
      renameSync(f, `${f}.corrupt-${Date.now()}.bak`);
      console.error(`[store] ${name} was corrupt — backed up, starting fresh.`);
    } catch {}
    return fallback;
  }
}

function save(name, data) {
  const f = join(dataDir(), name);
  try {
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, f);
  } catch (e) {
    console.error(`[store] could not save ${name}: ${e.message}`);
  }
  return f;
}

// --- Watch history ---
export function getHistory() {
  const h = load('history.json', []);
  return Array.isArray(h) ? h : [];
}

export function addHistory(entry) {
  const h = getHistory();
  h.unshift({ ...entry, at: new Date().toISOString() });
  save('history.json', h.slice(0, 200));
}

export function clearHistory() {
  save('history.json', []);
}

// Remove entries by URL (selective delete keeps the rest).
export function removeHistory(urls) {
  const set = new Set(urls);
  const h = getHistory();
  const kept = h.filter((e) => !set.has(e.url));
  save('history.json', kept);
  return h.length - kept.length;
}

// --- Downloads queue ---
export function getDownloads() {
  const q = load('downloads.json', []);
  return Array.isArray(q) ? q : [];
}

export function addDownload(entry) {
  const q = getDownloads();
  q.unshift({ ...entry, status: 'queued', at: new Date().toISOString() });
  save('downloads.json', q.slice(0, 200));
}

export function setDownloadStatus(url, status, extra = {}) {
  const q = getDownloads().map((d) => (d.url === url ? { ...d, status, ...extra } : d));
  save('downloads.json', q);
}

// Patch the most recent history entry for a URL (watch progress, kunai parity).
export function updateHistory(url, patch) {
  const h = getHistory();
  const i = h.findIndex((e) => e.url === url);
  if (i < 0) return;
  h[i] = { ...h[i], ...patch };
  save('history.json', h);
}

export function getCompletedDownloads() {
  return getDownloads().filter((d) => d.status === 'done' && d.file);
}

// Last-run diagnostics trail (kunai /diagnostics parity, lite): what was
// tried, what failed, in order. Shown by --diagnostics.
export function saveRun(entry) {
  save('last-run.json', { ...entry, at: new Date().toISOString() });
}

export function getLastRun() {
  const r = load('last-run.json', null);
  return r && typeof r === 'object' ? r : null;
}

// Rebuild playable media from a history entry (continue/resume flows).
// Returns null for retired lanes or entries without an identity.
export function historyToMedia(e) {
  if (!e || !['anime', 'youtube', 'music'].includes(e.kind)) return null;
  if (e.kind === 'anime' && !e.anilistId && !e.title) return null;
  if ((e.kind === 'youtube' || e.kind === 'music') && !e.videoId && !e.url) return null;
  return {
    media: {
      title: e.title, kind: e.kind, videoId: e.videoId || null, anilistId: e.anilistId || null,
      season: e.season, episode: e.episode, url: e.url, duration: e.duration || null,
    },
    providerId: e.providerId || null,
  };
}

// Provider health memory (kunai parity): outcomes persist across runs so the
// cycle learns. consecFail >= 3 with a recent failure = skipped until reset
// or 24h decay. Never blocks an explicitly chosen provider.
const HEALTH_FAIL_THRESHOLD = 3;
const HEALTH_DECAY_MS = 24 * 3600_000;

export function getHealth() {
  const h = load('health.json', {});
  return h && typeof h === 'object' ? h : {};
}

export function recordHealth(id, { ok, ms = null }) {
  const h = getHealth();
  const cur = h[id] || { ok: 0, fail: 0, consecFail: 0, lastMs: null, lastOk: null, lastFail: null };
  const now = new Date().toISOString();
  if (ok) {
    cur.ok += 1;
    cur.consecFail = 0;
    cur.lastOk = now;
    if (ms !== null) cur.lastMs = ms;
  } else {
    cur.fail += 1;
    cur.consecFail += 1;
    cur.lastFail = now;
  }
  h[id] = cur;
  save('health.json', h);
}

export function healthBlocked(id, nowMs = Date.now()) {
  const cur = getHealth()[id];
  if (!cur || cur.consecFail < HEALTH_FAIL_THRESHOLD) return false;
  const last = cur.lastFail ? Date.parse(cur.lastFail) : 0;
  return nowMs - last < HEALTH_DECAY_MS;
}

// Scored ranking for automatic best-source selection (no probes needed —
// this is observed playback truth). Laplace-smoothed reliability so an
// untried provider (0.5) still gets tried, a recent-failure streak drags
// the score down (stability matters), and known latency breaks ties.
// Stale failures are never forgiven here — trust must be re-earned
// through new successes (the 24h decay only lifts the hard block above).
export function scoreOf(rec) {
  const ok = rec?.ok || 0;
  const fail = rec?.fail || 0;
  const rel = (ok + 1) / (ok + fail + 2);
  const streak = Math.min(rec?.consecFail || 0, 5);
  const ms = rec?.lastMs;
  return { rel: Math.max(0, rel - streak * 0.05), ms: Number.isFinite(ms) ? ms : null };
}

// Auto-pin decision: migrate the default only when the winner differs AND
// the current default is unhealthy. Never churns while the default works.
export function shouldAutoPin(winnerId, defaultId, defaultBlocked) {
  return !!winnerId && !!defaultId && winnerId !== defaultId && defaultBlocked === true;
}

// Best observed provider for a lane (what the picker marks "best").
// Skips blocked providers; null when everything is blocked or empty.
export function bestScoredId(ids, health = {}, isBlocked = () => false) {
  let best = null;
  let bestRel = -Infinity;
  let bestMs = Infinity;
  for (const id of ids || []) {
    if (isBlocked(id)) continue;
    const s = scoreOf(health[id]);
    const ms = s.ms ?? Infinity;
    if (s.rel > bestRel || (s.rel === bestRel && ms < bestMs)) {
      best = id;
      bestRel = s.rel;
      bestMs = ms;
    }
  }
  return best;
}

// Daily FMHY watcher state: last successful check + the host list seen
// then. A new host on FMHY = a source we don't cover yet (surfaced, never
// silently added — new sites need real adapters).
export function getSourceSync() {
  const s = load('sources.json', {});
  return s && typeof s === 'object' ? s : {};
}

export function setSourceSync(patch) {
  save('sources.json', { ...getSourceSync(), ...(patch || {}) });
}

export function resetHealth(id) {
  if (id) {
    const h = getHealth();
    delete h[id];
    save('health.json', h);
    return [id];
  }
  save('health.json', {});
  return [];
}

// Playlists (ytmusic-player parity): named persistent queues.
export function getPlaylists() {
  const p = load('playlists.json', {});
  return p && typeof p === 'object' ? p : {};
}

export function getPlaylist(name) {
  const list = getPlaylists()[name];
  return Array.isArray(list) ? list : [];
}

export function playlistAdd(name, entry) {
  const all = getPlaylists();
  const list = Array.isArray(all[name]) ? all[name] : [];
  if (!list.some((x) => x.url === entry.url)) list.push({ ...entry, at: new Date().toISOString() });
  all[name] = list.slice(0, 500);
  save('playlists.json', all);
  return list.length;
}

export function playlistClear(name) {
  const all = getPlaylists();
  const had = Array.isArray(all[name]) && all[name].length > 0;
  delete all[name];
  save('playlists.json', all);
  return had;
}

// Favorites (ytmusic-player parity): toggle by URL, newest first.
export function getFavorites() {
  const f = load('favorites.json', []);
  return Array.isArray(f) ? f : [];
}

export function toggleFavorite(entry) {
  const f = getFavorites();
  const i = f.findIndex((x) => x.url === entry.url);
  if (i >= 0) {
    f.splice(i, 1);
    save('favorites.json', f);
    return false;
  }
  f.unshift({ ...entry, at: new Date().toISOString() });
  save('favorites.json', f.slice(0, 500));
  return true;
}

// Drop queue/library entries whose files no longer exist on disk.
export function pruneMissing() {
  const q = getDownloads();
  const kept = q.filter((d) => d.status !== 'done' || !d.file || existsSync(d.file));
  const dropped = q.length - kept.length;
  if (dropped) save('downloads.json', kept);
  return dropped;
}
