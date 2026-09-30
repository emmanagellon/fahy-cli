// npm run smoke — function-by-function system audit (kunai check-suite parity).
// Section A runs offline (pure logic, fixtures). Section B hits live networks.
// Exit 1 on any failure; every check prints PASS/FAIL with its name.
import assert from 'node:assert';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let pass = 0;
let fail = 0;
const results = [];
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      results.push(`  ok   ${name}`);
    })
    .catch((e) => {
      fail += 1;
      // A one-line failure says what broke but not what the terminal looked
      // like, and most of the interesting assertions here carry a dump. Show
      // the whole message when asked.
      const lines = e.message.split('\n');
      results.push(`  FAIL ${name}: ${lines.slice(0, process.env.FAHY_FAILFULL ? 99 : 1).join('\n')}`);
    });
}
const live = !process.argv.includes('--offline');

// ---------- A. offline ----------
const { formatDuration, ytSearch } = await import('../src/metadata.js');
await ok('formatDuration 3:34', () => assert.equal(formatDuration(214), '3:34'));
await ok('formatDuration 1:01:01', () => assert.equal(formatDuration(3661), '1:01:01'));
await ok('formatDuration null', () => assert.equal(formatDuration(null), null));
await ok('formatDuration garbage', () => assert.equal(formatDuration('x'), null));

const { parseVideoId, toTrack } = await import('../src/providers/youtube.js');
await ok('parseVideoId watch', () => assert.equal(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ'));
await ok('parseVideoId short', () => assert.equal(parseVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ'));
await ok('parseVideoId bare id', () => assert.equal(parseVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ'));
await ok('parseVideoId garbage', () => assert.equal(parseVideoId('hello world'), null));
await ok('toTrack drops channel id', () => assert.equal(toTrack({ videoId: 'UCSJ4gkVC6NrvII8umztf0Ow', title: 'x' }), null));
await ok('toTrack keeps video', () => assert.equal(toTrack({ videoId: 'dQw4w9WgXcQ', title: 'x' }).url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'));

const { classifyFailure } = await import('../src/failure.js');
const classes = {
  'fetch failed': 'network', 'Connect Timeout Error': 'timeout', 'HTTP 429': 'rate-limited',
  'HTTP 403 blocked': 'blocked', 'HTTP 401': 'auth', 'no playable stream': 'provider-empty',
  'HiAnime has no episode 2 for X (1 listed)': 'provider-empty',
  'unexpected token': 'provider-parse', cancelled: 'user-cancelled', 'getaddrinfo ENOTFOUND x': 'offline',
};
for (const [msg, cls] of Object.entries(classes)) {
  await ok(`classify ${cls}`, () => assert.equal(classifyFailure(new Error(msg)).class, cls));
}
await ok('auto-fallback policy', () => assert.equal(classifyFailure(new Error('fetch failed')).policy, 'auto-fallback'));
await ok('episode-missing falls back, not fatal', () => {
  assert.equal(classifyFailure(new Error('HiAnime has no episode 2 for X (1 listed)')).policy, 'auto-fallback');
});

const { probePassesForPlayback } = await import('../src/probe.js');
await ok('probe pass reachable', () => assert.equal(probePassesForPlayback({ status: 'reachable' }), true));
await ok('probe pass timeout', () => assert.equal(probePassesForPlayback({ status: 'timeout' }), true));
await ok('probe block definitive', () => assert.equal(probePassesForPlayback({ status: 'unreachable', definitive: true }), false));

const { parseLadder, rankQuality } = await import('../src/hls.js');
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\n720/index.m3u8\n';
await ok('parseLadder 2 rungs', () => {
  const v = parseLadder(MASTER, 'https://x.test/master.m3u8');
  assert.equal(v.length, 2);
  assert.equal(v[0].url, 'https://x.test/360/index.m3u8');
  assert.equal(v[1].quality, '720p');
});
await ok('rankQuality', () => assert.equal(rankQuality('1080p'), 1080));

const { pickEnglish } = await import('../src/subs.js');
await ok('pickEnglish prefers en', () =>
  assert.equal(pickEnglish([{ url: 'http://a/jp.vtt', lang: 'ja' }, { url: 'http://a/en.vtt', lang: 'en' }]).url, 'http://a/en.vtt'));
await ok('pickEnglish empty', () => assert.equal(pickEnglish([]), null));

const hi = await import('../src/providers/hianime.js');
const SEARCH_FIX = '<div class="film-detail"><h3 class="film-name"><a href="/watch/reborn-3138" title="REBORN!">x</a></h3></div><div id="main-sidebar">junk';
await ok('parseSearch slug', () => {
  const r = hi.parseSearch(SEARCH_FIX);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'reborn-3138');
});
await ok('chooseMatch exact', () => {
  const m = hi.chooseMatch('reborn', [{ id: 'reborn-3138', title: 'REBORN!' }, { id: 'x-1', title: 'Other' }]);
  assert.equal(m.id, 'reborn-3138');
});
const EP_FIX = '<a class="ss-list ep-item" data-number="1" data-id="42393" href="/watch/reborn-3138?ep=42393"><span class="ep-name" data-jname="Ep 1"></span></a>';
await ok('parseEpisodes entry', () => {
  const r = hi.parseEpisodes(EP_FIX, 'reborn-3138');
  assert.equal(r.length, 1);
  assert.equal(r[0].episodeId, '42393');
  assert.equal(r[0].number, 1);
});
const SRV_FIX = `<div class="server-item" data-type="sub" data-server-name="ZokoAnime" data-hash="${Buffer.from('https://zokoanime.video/e/1').toString('base64')}"></div>`;
await ok('parseServers zoko', () => {
  const r = hi.parseServers(SRV_FIX);
  assert.equal(r.length, 1);
  assert.equal(r[0].embedUrl, 'https://zokoanime.video/e/1');
});
await ok('decodeEmbed round-trip', () => {
  const doc = JSON.stringify({ src: 'https://x.test/m.m3u8', subtitles: [], skip: { intro: { start: 1, end: 2 } } });
  const key = Buffer.from('otaku-embed-v1', 'utf8');
  const plain = Buffer.from(doc, 'utf8');
  const out = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) out[i] = plain[i] ^ key[i % key.length];
  const html = `window.__P="${out.toString('base64')}"`;
  const p = hi.decodeEmbed(html);
  assert.equal(p.src, 'https://x.test/m.m3u8');
  assert.deepEqual(p.intro, { start: 1, end: 2 });
});
await ok('decodeEmbed missing blob', () => {
  try {
    hi.decodeEmbed('<html></html>');
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.code, 'embed-blob-missing');
  }
});

const { embedSource } = await import('../src/providers/base.js');
await ok('embedSource shape', () => {
  const s = embedSource('https://x.test', 'p');
  assert.equal(s.type, 'embed');
  assert.equal(s.provider, 'p');
});

const aw = await import('../src/providers/clan.js');
await ok('parseWatchSlug', () => {
  const p = aw.parseWatchSlug('/watch/one-piece-81553');
  assert.equal(p.id, '81553');
  assert.equal(p.title, 'one piece');
  assert.equal(aw.parseWatchSlug('/genre/action'), null);
});
const AW_FILTER_FIX = '<a href="/watch/one-piece-81553">s</a><a href="/watch/one-piece-film-strong-world-76079">m</a><a href="/genre/action">g</a>';
await ok('parseFilterLinks + chooseShow exact', () => {
  const l = aw.parseFilterLinks(AW_FILTER_FIX);
  assert.equal(l.length, 2);
  assert.equal(aw.chooseShow(l, 'ONE PIECE').slug, 'one-piece-81553');
});
await ok('parseFilterLinks data-tip id (anikoto shape)', () => {
  const html = '<div class="ani poster tip" data-tip="769"><a href="https://anikototv.to/watch/one-piece-special-abc12/ep-1">';
  const l = aw.parseFilterLinks(html);
  assert.equal(l.length, 1);
  assert.equal(l[0].id, '769');
  assert.ok(l[0].title.includes('one piece'));
});
await ok('clan adapters registered', async () => {
  const reg = await import('../src/providers/registry.js');
  for (const id of ['anikoto', 'anisuge']) {
    const p = reg.getProvider(id);
    assert.ok(p && p.kinds.includes('anime'), id);
    assert.ok((p.sites || []).length > 0, `${id} sites`);
  }
  assert.ok(reg.forKind('anime').length >= 3);
});
const AW_EPS_FIX = '<a href="/watch/81553/ep-2" data-ids="81553&amp;eps=2" data-num="2">2</a><a href="/watch/81553/ep-1" data-ids="81553&amp;eps=1" data-num="1">1</a>';
await ok('parseEpisodeList sorted + ids decoded', () => {
  const e = aw.parseEpisodeList(AW_EPS_FIX);
  assert.equal(e.length, 2);
  assert.equal(e[0].num, 1);
  assert.equal(e[0].ids, '81553&eps=1');
});
const AW_SRV_FIX = '<div class="type" data-type="sub"><li data-ep-id="1" data-sv-id="14" data-link-id="AAA"></li></div><div class="type" data-type="dub"><li data-ep-id="1" data-sv-id="4" data-link-id="BBB"></li></div>';
await ok('parseServerGroups sub/dub', () => {
  const g = aw.parseServerGroups(AW_SRV_FIX);
  assert.equal(g.length, 2);
  assert.equal(g[0].servers[0].linkId, 'AAA');
  assert.equal(g[1].type, 'dub');
});

const store = await import('../src/store.js');
await ok('store history array', () => assert.ok(Array.isArray(store.getHistory())));
await ok('store downloads array', () => assert.ok(Array.isArray(store.getDownloads())));
await ok('favorites toggle twice clean', () => {
  const probe = { title: '__smoke__', url: 'https://example.com/__smoke__' };
  assert.equal(store.toggleFavorite(probe), true);
  assert.equal(store.toggleFavorite(probe), false);
  assert.ok(!store.getFavorites().some((x) => x.url === probe.url));
});
await ok('playlists add/list/clear clean', () => {
  const probe = { title: '__smoke__', url: 'https://example.com/__smoke__', kind: 'music' };
  assert.equal(store.playlistAdd('__smoke__', probe), 1);
  assert.equal(store.playlistAdd('__smoke__', probe), 1); // no dupes
  assert.equal(store.getPlaylist('__smoke__').length, 1);
  assert.equal(store.playlistClear('__smoke__'), true);
  assert.equal(store.getPlaylist('__smoke__').length, 0);
});
await ok('history remove round-trip', () => {
  store.addHistory({ title: '__smoke__', url: 'https://example.com/__smoke__', kind: 'music' });
  assert.ok(store.getHistory().some((e) => e.url === 'https://example.com/__smoke__'));
  assert.equal(store.removeHistory(['https://example.com/__smoke__']), 1);
  assert.ok(!store.getHistory().some((e) => e.url === 'https://example.com/__smoke__'));
});

const { loadConfig, configPath } = await import('../src/config.js');await ok('config loads object', () => {
  const c = loadConfig();
  assert.ok(c && typeof c === 'object' && c.defaultProvider?.anime);
  assert.ok(typeof configPath() === 'string');
});
await ok('config modes sane', () => {
  const c = loadConfig();
  assert.ok(typeof c.volume === 'number' || c.volume === undefined);
  assert.ok(['off', 'one', 'all'].includes(c.repeat || 'off'));
});
await ok('historyToMedia anime', () => {
  const r = store.historyToMedia({ title: 'X', kind: 'anime', anilistId: 1, episode: 5, providerId: 'hianime' });
  assert.ok(r && r.media.episode === 5 && r.providerId === 'hianime');
});
await ok('historyToMedia retired lane', () => {
  // Movie/TV are now supported lanes — only truly retired kinds return null
  assert.equal(store.historyToMedia({ title: 'X', kind: 'retired_kind' }), null);
  // Movie entries with tmdbId are now valid
  const r = store.historyToMedia({ title: 'X', kind: 'movie', tmdbId: 123, providerId: 'vixsrc' });
  assert.ok(r && r.media.tmdbId === 123 && r.providerId === 'vixsrc');
});
await ok('historyToMedia garbage', () => {
  assert.equal(store.historyToMedia(null), null);
  assert.equal(store.historyToMedia({ title: 'X', kind: 'music' }), null);
});
await ok('health record + block + reset', () => {
  store.resetHealth('__smoke__');
  store.recordHealth('__smoke__', { ok: false });
  store.recordHealth('__smoke__', { ok: false });
  assert.equal(store.healthBlocked('__smoke__'), false); // only 2
  store.recordHealth('__smoke__', { ok: false });
  assert.equal(store.healthBlocked('__smoke__'), true); // 3-streak
  store.recordHealth('__smoke__', { ok: true, ms: 100 });
  assert.equal(store.healthBlocked('__smoke__'), false); // success clears
  assert.deepEqual(store.resetHealth('__smoke__'), ['__smoke__']);
  assert.equal(store.healthBlocked('__smoke__'), false);
});
await ok('orderProviders chosen+priority+health', async () => {
  const { orderProviders } = await import('../src/providers/registry.js');
  const mk = (id, direct) => ({ id, direct, kinds: ['anime'] });
  const avail = [mk('a', false), mk('b', true), mk('c', false)];
  const o = orderProviders(mk('a', false), avail, {
    priority: ['c'], healthBlocked: (id) => id === 'b', strict: false,
  });
  assert.deepEqual(o.map((x) => x.id), ['a', 'c', 'b']); // chosen, priority, unhealthy last
  const s = orderProviders(mk('a', false), avail, { strict: true });
  assert.deepEqual(s.map((x) => x.id), ['a']);
});
await ok('scoreOf neutral/ranked/streak-penalized', () => {
  assert.equal(store.scoreOf(undefined).rel, 0.5); // untried: neutral, still tried
  const good = store.scoreOf({ ok: 5, fail: 0, consecFail: 0, lastMs: 200 });
  const flaky = store.scoreOf({ ok: 1, fail: 3, consecFail: 0, lastMs: 9000 });
  const streaky = store.scoreOf({ ok: 5, fail: 0, consecFail: 2, lastMs: 200 });
  assert.ok(good.rel > flaky.rel, 'reliable beats flaky');
  assert.ok(good.rel > streaky.rel, 'clean streak beats recent failures');
  assert.equal(store.scoreOf({ ok: 5, fail: 0, consecFail: 0, lastMs: null }).ms, null);
});
await ok('shouldAutoPin only on unhealthy default', () => {
  assert.equal(store.shouldAutoPin('anikoto', 'hianime', true), true);
  assert.equal(store.shouldAutoPin('hianime', 'hianime', true), false); // same: no churn
  assert.equal(store.shouldAutoPin('anikoto', 'hianime', false), false); // default works: no churn
  assert.equal(store.shouldAutoPin('anikoto', undefined, true), false);
});
await ok('orderProviders auto-ranks by score', async () => {
  const { orderProviders } = await import('../src/providers/registry.js');
  const mk = (id, direct) => ({ id, direct, kinds: ['anime'] });
  const avail = [mk('slow', true), mk('fast', false), mk('new', false)];
  const health = {
    slow: { ok: 1, fail: 3, consecFail: 0, lastMs: 9000 },
    fast: { ok: 4, fail: 0, consecFail: 0, lastMs: 300 },
  };
  const o = orderProviders(mk('z', true), avail, { healthBlocked: () => false, health });
  assert.deepEqual(o.map((x) => x.id), ['z', 'fast', 'new', 'slow']);
  const b = orderProviders(mk('z', true), avail, { healthBlocked: (id) => id === 'fast', health });
  assert.deepEqual(b.map((x) => x.id), ['z', 'new', 'slow', 'fast']); // blocked last despite best score
});
await ok('bestScoredId picks/skips/empty', () => {
  const h = {
    a: { ok: 5, fail: 0, consecFail: 0, lastMs: 100 },
    b: { ok: 0, fail: 0, consecFail: 0, lastMs: null },
  };
  assert.equal(store.bestScoredId(['a', 'b'], h, () => false), 'a');
  assert.equal(store.bestScoredId(['a', 'b'], h, (id) => id === 'a'), 'b'); // blocked skipped
  assert.equal(store.bestScoredId(['a'], h, () => true), null);
  assert.equal(store.bestScoredId([], h, () => false), null);
});
await ok('providerTags best/unhealthy/neutral', async () => {
  const { providerTags } = await import('../src/providers/registry.js');
  const tags = providerTags([{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
    health: {
      a: { ok: 5, fail: 0, consecFail: 0, lastMs: 100 },
      b: { ok: 0, fail: 0, consecFail: 0, lastMs: null },
      c: { ok: 0, fail: 3, consecFail: 3, lastMs: null },
    },
    isBlocked: (id) => id === 'c',
  });
  assert.deepEqual(tags, { a: 'best', b: null, c: 'unhealthy' });
});
await ok('diffFmhySources fresh + drift', async () => {
  const { diffFmhySources } = await import('../src/sources.js');
  const sites = [
    { name: 'HiAnime', url: 'https://hianime.at/', host: 'hianime.at' },
    { name: 'NewSite', url: 'https://newsite.example/', host: 'newsite.example' },
  ];
  const lane = [{ id: 'hianime', name: 'HiAnime', sites: ['https://hianime.at'], tokens: ['hianime'] }];
  const d = diffFmhySources(sites, lane);
  assert.deepEqual(d.drifted, []);
  assert.deepEqual(d.fresh.map((s) => s.host), ['newsite.example']);
  const moved = [{ id: 'hianime', name: 'HiAnime', sites: ['https://hianime.old'], tokens: ['hianime'] }];
  const d2 = diffFmhySources(sites, moved);
  assert.equal(d2.drifted.length, 1);
  assert.equal(d2.drifted[0].status, 'drift');
  assert.deepEqual(d2.fresh.map((s) => s.host), ['newsite.example']);
});
await ok('sourceSync round-trip (restored)', async () => {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const fs = await import('node:fs');
  const f = join(homedir(), '.config', 'fahy-cli', 'sources.json');
  const had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  try {
    store.setSourceSync({ lastCheck: '2026-01-01T00:00:00.000Z', knownHosts: ['__smoke__'] });
    assert.deepEqual(store.getSourceSync().knownHosts, ['__smoke__']);
  } finally {
    if (had === null) fs.rmSync(f, { force: true });
    else fs.writeFileSync(f, had);
  }
});
await ok('updateState round-trip (restored)', async () => {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const fs = await import('node:fs');
  const f = join(homedir(), '.config', 'fahy-cli', 'update.json');
  const had = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  try {
    store.setUpdateState({ lastCheck: '2026-01-01T00:00:00.000Z', lastVersion: '__smoke__' });
    assert.equal(store.getUpdateState().lastVersion, '__smoke__');
  } finally {
    if (had === null) fs.rmSync(f, { force: true });
    else fs.writeFileSync(f, had);
  }
});
await ok('config autoUpdate sanitized', async () => {
  const { loadConfig } = await import('../src/config.js');
  const c = loadConfig();
  assert.ok(['notice', 'install', 'off'].includes(c.autoUpdate));
});
const upd = await import('../src/update.js');
await ok('compareVersions numeric', () => {
  assert.equal(upd.compareVersions('0.6.2', '0.6.2'), 0);
  assert.equal(upd.compareVersions('0.6.2', '0.6.3'), -1);
  assert.equal(upd.compareVersions('0.6.3', '0.6.2'), 1);
  assert.equal(upd.compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(upd.compareVersions('1.0.0', '0.99.9'), 1);
  assert.equal(upd.compareVersions('v0.6.2', '0.6.2'), 0);
});
await ok('needsUpdate', () => {
  assert.equal(upd.needsUpdate('0.6.2', '0.6.2'), false);
  assert.equal(upd.needsUpdate('0.6.2', '0.7.0'), true);
  assert.equal(upd.needsUpdate('0.7.0', '0.6.2'), false);
});
await ok('installedVersion matches package.json', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(upd.installedVersion(), pkg.version);
});
await ok('sourceCheckout null or path', () => {
  const t = upd.sourceCheckout();
  assert.ok(t === null || typeof t === 'string');
});
// ---- modes / legacy argv --------------------------------------------------
const { kindFor, isKind, KINDS } = await import('../src/modes.js');
await ok('kindFor aliases', () => {
  assert.equal(kindFor('anime'), 'anime');
  assert.equal(kindFor('A'), 'anime');
  assert.equal(kindFor('tv'), 'tv');
  assert.equal(kindFor('show'), 'tv');
  assert.equal(kindFor('yt'), 'youtube');
  assert.equal(kindFor('music'), 'music');
  assert.equal(kindFor('bogus'), null);
  assert.equal(kindFor(null), null);
});
await ok('modes KINDS match provider lanes', async () => {
  const { forKind } = await import('../src/providers/registry.js');
  assert.deepEqual(KINDS.slice().sort(), ['anime', 'movie', 'music', 'tv', 'youtube']);
  for (const k of KINDS) {
    assert.ok(isKind(k));
    assert.ok(forKind(k).length > 0, `no provider for ${k}`);
  }
});
const { normalizeArgv } = await import('../src/legacy-args.js');
await ok('legacy -S -a becomes anime <query>', () => {
  const r = normalizeArgv(['node', 'fahy', '-S', 'Frieren', '-a']);
  assert.deepEqual(r.argv.slice(2), ['anime', 'Frieren']);
  assert.match(r.note, /fahy anime "Frieren"/);
});
await ok('legacy unquoted query runs to next flag', () => {
  const r = normalizeArgv(['node', 'fahy', '-S', 'Frieren', 'Beyond', '--dub']);
  assert.deepEqual(r.argv.slice(2), ['anime', 'Frieren Beyond', '--dub']);
});
await ok('legacy --search=Frieren inline', () => {
  const r = normalizeArgv(['node', 'fahy', '--search=Frieren', '--anime']);
  assert.deepEqual(r.argv.slice(2), ['anime', 'Frieren']);
});
await ok('legacy -m maps to music', () => {
  assert.deepEqual(normalizeArgv(['node', 'fahy', '-S', 'x', '-m']).argv.slice(2), ['music', 'x']);
  assert.deepEqual(normalizeArgv(['node', 'fahy', '-t', 'tv', '-S', 'x']).argv.slice(2), ['tv', 'x']);
});
await ok('legacy --history becomes history', () => {
  const r = normalizeArgv(['node', 'fahy', '--history']);
  assert.deepEqual(r.argv.slice(2), ['history']);
  assert.ok(r.note);
});
await ok('legacy --volume 50 becomes volume 50', () => {
  const r = normalizeArgv(['node', 'fahy', '--volume', '50']);
  assert.deepEqual(r.argv.slice(2), ['volume', '50']);
});
await ok('legacy --reset-health hianime becomes health --reset hianime', () => {
  const r = normalizeArgv(['node', 'fahy', '--reset-health', 'hianime']);
  assert.deepEqual(r.argv.slice(2), ['health', '--reset', 'hianime']);
});
await ok('legacy --set-default-provider anime=x becomes providers --default anime=x', () => {
  const r = normalizeArgv(['node', 'fahy', '--set-default-provider', 'anime=hianime']);
  assert.deepEqual(r.argv.slice(2), ['providers', '--default', 'anime=hianime']);
});
await ok('legacy query with no mode defaults to anime', () => {
  const r = normalizeArgv(['node', 'fahy', '-S', 'Frieren']);
  assert.deepEqual(r.argv.slice(2), ['anime', 'Frieren']);
});
await ok('legacy play flags survive the rewrite', () => {
  const r = normalizeArgv(['node', 'fahy', '-S', 'Daybreak', '--tv', '--season', '1', '--episode', '2', '--provider', 'lookmovie']);
  assert.deepEqual(r.argv.slice(2), ['tv', 'Daybreak', '--season', '1', '--episode', '2', '--provider', 'lookmovie']);
});
await ok('legacy already-new argv is untouched', () => {
  const argv = ['node', 'fahy', 'anime', 'Frieren', '--dub'];
  const r = normalizeArgv(argv);
  assert.deepEqual(r.argv, argv);
  assert.equal(r.note, null);
});
await ok('legacy unknown flags pass through for commander to report', () => {
  const argv = ['node', 'fahy', '--nope', 'x'];
  const r = normalizeArgv(argv);
  assert.deepEqual(r.argv, argv);
  assert.equal(r.note, null);
  const bad = ['node', 'fahy', '-S', 'x', '-t', 'bogus'];
  assert.deepEqual(normalizeArgv(bad).argv, bad);
});
await ok('legacy bare invocation untouched', () => {
  const argv = ['node', 'fahy'];
  assert.deepEqual(normalizeArgv(argv).argv, argv);
});

// ---- history.js -----------------------------------------------------------
const historyFile = join(homedir(), '.config', 'fahy-cli', 'history.json');
// Snapshot/restore the history file around a mutation test, so the suite never
// leaves a real watch history behind.
async function withStore(fn) {
  const had = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8') : null;
  try {
    await fn();
  } finally {
    if (had === null) fs.rmSync(historyFile, { force: true });
    else fs.writeFileSync(historyFile, had);
  }
}
// Start each history test from a known-empty file (not "whatever was there").
const emptyHistory = () => fs.writeFileSync(historyFile, '[]');
const { historyProgress, historyTag, historyLabel, historyHint, historyWhen, historyItems, historyLine, resumeTarget, CLEAR_ALL } = await import('../src/history.js');
await ok('historyProgress minutes, done, partial', () => {
  assert.equal(historyProgress({ duration: 1440, positionMs: 1080_000 }), '18m / 24m');
  assert.equal(historyProgress({ duration: 200, positionMs: 200_000, completed: true }), 'done');
  assert.equal(historyProgress({ positionMs: 95_000 }), '1:35 in');
  assert.equal(historyProgress({}), '');
  assert.equal(historyProgress({ duration: 100, positionMs: 200_000 }), '1m / 1m', 'clamped to runtime');
  assert.equal(historyProgress({ duration: 30, positionMs: 20_000 }), '0:20 in', 'sub-minute runtime falls back');
});
await ok('historyTag only for episodic lanes', () => {
  assert.equal(historyTag({ kind: 'anime', episode: 5 }), 'E5');
  assert.equal(historyTag({ kind: 'tv', season: 1, episode: 12 }), 'S1E12');
  assert.equal(historyTag({ kind: 'tv', episode: 3 }), 'S1E3');
  assert.equal(historyTag({ kind: 'movie' }), '');
  assert.equal(historyTag({ kind: 'music' }), '');
});
await ok('historyLabel/hint compose the row', () => {
  const e = { kind: 'anime', title: 'Frieren', episode: 12, positionMs: 1080_000, duration: 1440, provider: 'hianime' };
  assert.equal(historyLabel(e), 'Frieren · E12');
  assert.equal(historyLabel({ kind: 'movie' }), '(untitled)');
  assert.equal(historyHint(e), '18m / 24m · hianime');
  assert.equal(historyHint({ kind: 'movie', title: 'X' }), '');
});
await ok('historyWhen relative buckets', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  assert.equal(historyWhen(ago(5_000)), 'just now');
  assert.equal(historyWhen(ago(9 * 60_000)), '9m ago');
  assert.equal(historyWhen(ago(3 * 3600_000)), '3h ago');
  assert.equal(historyWhen(ago(2 * 86400_000)), '2d ago');
  assert.match(historyWhen(ago(30 * 86400_000)), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(historyWhen(null), '');
  assert.equal(historyWhen('garbage'), '');
});
await ok('historyItems ends with separator + clear-all', () => {
  const items = historyItems([{ title: 'A', kind: 'anime', episode: 1 }, { title: 'B', kind: 'movie' }]);
  assert.equal(items.length, 4);
  assert.equal(items[0].value, 0);
  assert.equal(items[1].value, 1);
  assert.equal(items[2], '-');
  assert.equal(items[3].value, CLEAR_ALL);
});
await ok('historyLine numbered row', () => {
  const line = historyLine({ kind: 'anime', title: 'A', episode: 1, at: new Date().toISOString() }, 0);
  assert.match(line, /^ 1\. A · E1/);
  assert.ok(line.includes('just now'));
});
// ---- history identity -----------------------------------------------------
// One episode is one row. Without this a run that falls back through three
// sources leaves three rows for the same episode and `fahy history` fills up
// with duplicates.
await ok('historyKey identifies the item, not the source', () => {
  const a = { kind: 'anime', anilistId: 21, title: 'Frieren', season: 1, episode: 3 };
  const b = { kind: 'anime', anilistId: 21, title: 'Frieren', season: 1, episode: 3, url: 'https://a.test/1.m3u8' };
  assert.equal(store.historyKey(a), store.historyKey(b), 'a different source URL is the same episode');
  assert.notEqual(store.historyKey(a), store.historyKey({ ...a, episode: 4 }), 'a different episode is not');
  assert.notEqual(store.historyKey(a), store.historyKey({ ...a, season: 2 }), 'a different season is not');
  assert.equal(store.historyKey({ kind: 'movie', tmdbId: 5 }), store.historyKey({ kind: 'movie', tmdbId: 5, url: 'x' }));
  assert.equal(store.historyKey({ kind: 'youtube', videoId: 'abc' }), store.historyKey({ kind: 'youtube', videoId: 'abc' }));
  assert.equal(store.historyKey({ kind: 'youtube', url: 'u' }), 'youtube:u', 'falls back to the url with no id');
  assert.equal(store.historyKey(null), null);
  assert.equal(store.historyKey({ kind: 'nonsense' }), null);
});
await ok('addHistory collapses a re-watch onto one row', () => withStore(async () => {
  emptyHistory();
  const ep = { kind: 'anime', anilistId: 21, title: 'Frieren', season: 1, episode: 3, url: 'u1', provider: 'hianime' };
  store.addHistory(ep);
  store.addHistory({ ...ep, url: 'u2', provider: 'anikoto' });
  store.addHistory({ ...ep, url: 'u3', provider: 'clan' });
  const h = store.getHistory();
  assert.equal(h.length, 1, 'three attempts are one episode');
  assert.equal(h[0].url, 'u3', 'the newest attempt is what is stored');
  assert.equal(h[0].provider, 'clan');
}));
await ok('a failed attempt never erases a good resume offset', () => withStore(async () => {
  emptyHistory();
  const ep = { kind: 'anime', anilistId: 21, title: 'Frieren', season: 1, episode: 3, duration: 1440, url: 'u1' };
  store.addHistory({ ...ep, positionMs: 600_000 });
  // A later attempt that never reported a position (source died on start).
  store.addHistory({ ...ep, url: 'u2' });
  let [row] = store.getHistory();
  assert.equal(row.url, 'u2', 'the newest attempt leads');
  assert.equal(row.positionMs, 600_000, 'the old offset survives');
  assert.equal(row.completed, false);
  // A real re-watch from 0 IS a real position, and it overwrites.
  store.addHistory({ ...ep, url: 'u3', positionMs: 0 });
  [row] = store.getHistory();
  assert.equal(row.positionMs, 0, 'a genuine restart resets the offset');
}));
await ok('a re-watch carries completed forward only while it stays true', () => withStore(async () => {
  emptyHistory();
  const ep = { kind: 'anime', anilistId: 21, title: 'F', season: 1, episode: 1, duration: 1440, url: 'u1' };
  store.addHistory({ ...ep, positionMs: 1400_000, completed: true });
  // Quitting a re-watch early: the latest attempt is the truth.
  store.addHistory({ ...ep, url: 'u2', positionMs: 60_000 });
  const [row] = store.getHistory();
  assert.equal(row.completed, false, 'an unfinished re-watch is not completed');
  // And that is what resume keys off: a row marked unfinished resumes into it.
  const t = resumeTarget(row);
  assert.equal(t.positionMs, 60_000, 'resume uses the latest attempt, not the old one');
}));
await ok('different episodes stay separate rows', () => withStore(async () => {
  emptyHistory();
  const base = { kind: 'anime', anilistId: 21, title: 'F', season: 1, url: 'u' };
  store.addHistory({ ...base, episode: 1 });
  store.addHistory({ ...base, episode: 2 });
  store.addHistory({ ...base, season: 2, episode: 1 });
  assert.equal(store.getHistory().length, 3);
}));

await ok('resumeTarget nulls the offset for finished items', async () => {
  const half = resumeTarget({ kind: 'anime', title: 'A', episode: 1, positionMs: 600_000, providerId: 'hianime' });
  assert.equal(half.positionMs, 600_000);
  assert.equal(half.providerId, 'hianime');
  assert.equal(half.media.episode, 1);
  const done = resumeTarget({ kind: 'anime', title: 'A', episode: 1, positionMs: 1_380_000, completed: true });
  assert.equal(done.positionMs, null);
  assert.equal(resumeTarget({ kind: 'retired' }), null);
  assert.equal(resumeTarget(null), null);
  assert.equal(resumeTarget({ kind: 'anime' }), null, 'no identity -> not resumable');
});
await ok('history survives a store round-trip with resume fields', async () => {
  await withStore(async () => {
    store.clearHistory();
    store.addHistory({ kind: 'anime', title: 'Frieren', url: 'https://x.test/1.m3u8', providerId: 'hianime', season: 1, episode: 12, episodeId: 'ep-12' });
    store.updateHistory('https://x.test/1.m3u8', { positionMs: 600_000, duration: 1440, audio: 'dub' });
    assert.equal(store.updateHistory('https://x.test/nope', { positionMs: 1 }), false, 'unknown url reports no-op');
    const [entry] = store.getHistory();
    assert.equal(entry.positionMs, 600_000);
    assert.equal(entry.audio, 'dub');
    assert.equal(entry.episodeId, 'ep-12');
    assert.equal(entry.completed, false);
    // undefined never clobbers a stored value
    store.updateHistory('https://x.test/1.m3u8', { positionMs: undefined, audio: 'sub' });
    assert.equal(store.getHistory()[0].positionMs, 600_000);
    assert.equal(store.getHistory()[0].audio, 'sub');
    assert.equal(resumeTarget(store.getHistory()[0]).positionMs, 600_000);
  });
});
await ok('historyToMedia carries identity and resume', () => {
  const r = store.historyToMedia({
    kind: 'tv', title: 'Daybreak', tmdbId: 1234, season: 2, episode: 5, url: 'https://x.test/e5',
    providerId: 'lookmovie', positionMs: 300_000, duration: 2700, completed: false,
  });
  assert.equal(r.media.tmdbId, 1234);
  assert.equal(r.media.season, 2);
  assert.equal(r.media.episode, 5);
  assert.equal(r.providerId, 'lookmovie');
  assert.equal(r.positionMs, 300_000);
  assert.equal(r.completed, false);
  assert.equal(store.historyToMedia({ kind: 'nope' }), null);
  assert.equal(store.historyToMedia({ kind: 'music' }), null);
  assert.equal(store.historyToMedia({ kind: 'music', videoId: 'abc' }).media.videoId, 'abc');
});
await ok('history is capped and normalized on read', async () => {
  await withStore(async () => {
    store.clearHistory();
    for (let i = 0; i < store.HISTORY_CAP + 25; i++) {
      store.addHistory({ kind: 'movie', title: `M${i}`, url: `https://x.test/${i}` });
    }
    const h = store.getHistory();
    assert.equal(h.length, store.HISTORY_CAP);
    assert.equal(h[0].title, `M${store.HISTORY_CAP + 24}`, 'newest first');
    assert.equal(h[0].completed, false, 'missing fields normalize');
    assert.equal(h[0].positionMs, null);
    assert.equal(store.clearHistory(), store.HISTORY_CAP);
    assert.deepEqual(store.getHistory(), []);
  });
});

// ---- player: resume seek + position reporting ---------------------------
// startArgFor turns a stored offset into an mpv seek; the progress script is
// how the offset gets stored in the first place.
const player = await import('../src/player.js');
const { startArgFor, progressScript, readProgress, clearProgress } = player;
await ok('startArgFor floor, ceiling, happy path', () => {
  assert.equal(startArgFor(0, 1440), null);
  assert.equal(startArgFor(-5, 1440), null);
  assert.equal(startArgFor(null, 1440), null);
  assert.equal(startArgFor('x', 1440), null);
  assert.equal(startArgFor(4999, 1440), null, 'below the 5s floor: no seek');
  assert.equal(startArgFor(5000, 1440), '--start=5');
  assert.equal(startArgFor(600_000, 1440), '--start=600');
  assert.equal(startArgFor(1_400_000, 1440), null, 'past 95% of runtime: start over');
  assert.equal(startArgFor(1_000_000, null), '--start=1000', 'unknown duration: seek');
  assert.equal(startArgFor(1_000_000, 0), '--start=1000');
});

const scratch = join(homedir(), 'AppData', 'Local', 'Temp', 'opencode', `fahy-prog-${process.pid}`);
fs.mkdirSync(scratch, { recursive: true });
await ok('progressScript writes a lua script separate from its data file', () => {
  const script = join(scratch, 'p.lua');
  const data = join(scratch, 'p.txt');
  progressScript(script, data);
  const lua = fs.readFileSync(script, 'utf8');
  assert.match(lua, /mp\.get_property_number\("time-pos"/);
  assert.match(lua, /mp\.register_event\("shutdown"/);
  assert.ok(lua.includes('p.txt'), 'the script writes to the data file');
  assert.ok(!lua.includes('p.lua'), 'and never to itself');
  assert.equal(fs.existsSync(data), false, 'no data file until mpv runs');
  // A windows path must not leak backslashes into the lua string.
  assert.ok(!/local out, tmp = "[^"]*\\/.test(lua), 'paths are lua-escaped');
});
await ok('readProgress parses both record shapes and rejects junk', () => {
  const data = join(scratch, 'r.txt');
  // A periodic checkpoint: no reason yet.
  fs.writeFileSync(data, '612.500 1440.000');
  assert.deepEqual(readProgress(data), { positionSec: 612.5, durationSec: 1440, reason: null });
  // The end-file record: reason first. "eof" is how completion is decided, so
  // it has to survive the round trip.
  fs.writeFileSync(data, 'eof 612.500 1440.000');
  assert.deepEqual(readProgress(data), { positionSec: 612.5, durationSec: 1440, reason: 'eof' });
  fs.writeFileSync(data, 'quit 100.000 1440.000');
  assert.equal(readProgress(data).reason, 'quit', 'a user quit is not a finished file');
  fs.writeFileSync(data, '0 0');
  assert.deepEqual(readProgress(data), { positionSec: 0, durationSec: null, reason: null }, 'a zero duration is unknown, not zero');
  fs.writeFileSync(data, '  10.0   20.0  ');
  assert.equal(readProgress(data).positionSec, 10, 'tolerates surrounding whitespace');
  fs.writeFileSync(data, '612.5');              // torn write: only half the pair
  assert.equal(readProgress(data), null);
  fs.writeFileSync(data, 'mp.get_property_num'); // the script itself
  assert.equal(readProgress(data), null);
  assert.equal(readProgress(join(scratch, 'missing.txt')), null);
  assert.equal(readProgress(null), null);
});
await ok('the checkpoint is monotonic and reason-bearing', () => {
  const script = join(scratch, 'shape.lua');
  progressScript(script, join(scratch, 'shape.txt'));
  const lua = fs.readFileSync(script, 'utf8');
  // A timer that fires once and stops freezes the position near the start.
  assert.ok(!lua.includes('mp.add_timeout'), 'driven by an observed property, not a timer');
  assert.match(lua, /mp\.observe_property\("time-pos"/);
  // end-file/shutdown read time-pos back as 0; without the guard that zeroes
  // the real position.
  assert.match(lua, /if pos <= best then return end/, 'never writes a position backwards');
  assert.match(lua, /mp\.register_event\("end-file", function\(ev\)/);
  assert.match(lua, /ev\.reason/, 'the end reason is recorded');
  assert.match(lua, /os\.remove\(out\)/, 'windows rename cannot replace an existing file');
});
await ok('stale checkpoints from a killed run are swept, live ones are not', () => {
  // A hard kill leaves pos-<pid>-* behind and no handler can clean up. The
  // filename carries the owning pid, so leftovers from a dead process are
  // removable and one from a live process must be left alone.
  const dir = join(scratch, 'prune');
  fs.mkdirSync(dir, { recursive: true });
  // This process is definitely alive, so its own id must be respected.
  fs.writeFileSync(join(dir, `pos-${process.pid}-1-1.lua`), 'x');
  // A pid that is certainly not running.
  const deadPid = 999_999;
  fs.writeFileSync(join(dir, `pos-${deadPid}-2-1.lua`), 'x');
  fs.writeFileSync(join(dir, `pos-${deadPid}-2-1.txt`), 'x');
  // An unrelated file in the same directory is none of our business.
  fs.writeFileSync(join(dir, 'other.txt'), 'x');

  player.pruneProgressFiles(dir);

  assert.equal(fs.existsSync(join(dir, `pos-${process.pid}-1-1.lua`)), true, 'a live pid is left alone');
  assert.equal(fs.existsSync(join(dir, `pos-${deadPid}-2-1.lua`)), false, 'a dead pid is swept');
  assert.equal(fs.existsSync(join(dir, `pos-${deadPid}-2-1.txt`)), false);
  assert.equal(fs.existsSync(join(dir, 'other.txt')), true, 'unrelated files are untouched');
  // A missing directory is a no-op, never a throw.
  player.pruneProgressFiles(join(scratch, 'does-not-exist'));
  fs.rmSync(dir, { recursive: true, force: true });
});
await ok('clearProgress removes the script and every data artefact', () => {
  const script = join(scratch, 'c.lua');
  const data = join(scratch, 'c.txt');
  progressScript(script, data);
  fs.writeFileSync(data, '5 10');
  fs.writeFileSync(`${data}.tmp`, '5 10');
  clearProgress({ script, data });
  assert.equal(fs.existsSync(script), false);
  assert.equal(fs.existsSync(data), false);
  assert.equal(fs.existsSync(`${data}.tmp`), false, 'the temp half is cleaned too');
  clearProgress(null); // must not throw
});
await ok('wasInterrupted is a plain flag until a signal lands', () => {
  assert.equal(typeof player.wasInterrupted(), 'boolean');
});
await ok('onInterrupt registers and unregisters a saver', async () => {
  let ran = 0;
  const off = player.onInterrupt(() => { ran += 1; });
  assert.equal(typeof off, 'function', 'returns an unsubscribe');
  assert.equal(player.interruptSaverCount(), 1);
  off();
  assert.equal(player.interruptSaverCount(), 0, 'unsubscribing actually removes it');
  // A saver that throws must not take the process down with it.
  const off2 = player.onInterrupt(() => { throw new Error('boom'); });
  assert.equal(player.interruptSaverCount(), 1);
  off2();
  assert.equal(ran, 0);
});
await ok('player installs an exit hook and no hard exit on signals', () => {
  const body = fs.readFileSync(new URL('../src/player.js', import.meta.url), 'utf8');
  assert.match(body, /process\.on\('exit', killPlayerChildrenNow\)/);
  // The signal path must not exit outright while a player is live: that would
  // throw away the very position it just wrote.
  assert.match(body, /const hadPlayer = liveMpv\.size > 0;/);
  // And the savers are bounded, so an interrupt can never hang the terminal.
  assert.match(body, /setTimeout\(r, 1500\)/);
});
await ok('the music daemon saves its position on interrupt', () => {
  const body = fs.readFileSync(new URL('../src/playback.js', import.meta.url), 'utf8');
  // The daemon is supervised rather than awaited, so nothing else would ever
  // write its position out.
  assert.match(body, /onInterrupt\(async \(\) => \{/);
  assert.match(body, /updateHistory\(url, \{/);
  assert.match(body, /musicHistoryUrl = source\.url;/);
});

// ---- bounded async --------------------------------------------------------
const { withDeadline, withTimeout, withBudget, deadline, TimeoutError, CancelledError } = await import('../src/lib/async.js');
// Deadline timers are unref'd on purpose (a fired timeout must not be the only
// thing holding the process open), so a test that waits on one has to keep the
// loop alive itself.
const hold = (ms) => new Promise((r) => setTimeout(r, ms));
await ok('withDeadline resolves on time', async () => {
  assert.equal(await withDeadline(async () => 'ok', 2000), 'ok');
  assert.equal(await withDeadline(Promise.resolve(7), 2000), 7);
});
await ok('withDeadline times out instead of hanging', async () => {
  const never = new Promise(() => {});
  const keepAlive = hold(1500);
  const t0 = Date.now();
  await assert.rejects(() => withDeadline(() => never, 60, 'source check'), (e) => {
    assert.equal(e.name, 'TimeoutError');
    assert.equal(e.code, 'fahy-timeout');
    assert.equal(e.timeoutMs, 60);
    assert.match(e.message, /source check timed out/);
    return true;
  });
  const took = Date.now() - t0;
  await keepAlive;
  assert.ok(took < 1000, `must give up fast, took ${took}ms`);
});
await ok('withDeadline aborts the signal it hands out', async () => {
  let seen = null;
  const keepAlive = hold(1500);
  await assert.rejects(() => withDeadline(async (signal) => {
    seen = signal;
    return new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
  }, 60, 'resolve'), (e) => e.name === 'TimeoutError');
  await keepAlive;
  assert.ok(seen && seen.aborted, 'provider must see the abort');
});
await ok('losing promise rejection never goes unhandled', async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(() => withDeadline(() => new Promise((_, rej) => setTimeout(() => rej(new Error('late boom')), 120)), 40, 'resolve'));
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen, [], 'detached loser must be caught');
});
await ok('withDeadline passes through provider errors', async () => {
  await assert.rejects(() => withDeadline(async () => { throw new Error('provider exploded'); }, 2000), /provider exploded/);
  await assert.rejects(() => withDeadline(async () => { throw new Error('sync throw'); }, 2000), /sync throw/);
});
await ok('withTimeout/deadline abort by hand', async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 2000), 1);
  const d = deadline(60_000, 'x');
  const err = new CancelledError('x');
  d.abort(err);
  assert.equal(d.signal.aborted, true);
  assert.equal(d.signal.reason, err);
  d.stop();
});
await ok('withBudget stops at the wall clock', async () => {
  assert.deepEqual(await withBudget([() => Promise.resolve(1), () => Promise.resolve(2)], 2000), [1, 2]);
  await assert.rejects(() => withBudget([() => new Promise((r) => setTimeout(() => r(1), 80)), () => new Promise((r) => setTimeout(() => r(2), 500))], 150, 'fan-out'), (e) => e.name === 'TimeoutError');
});

const { hasMpv } = await import('../src/player.js');
await ok('hasMpv boolean', () => assert.equal(typeof hasMpv(), 'boolean'));
if (hasMpv()) {
  const { playUrl } = await import('../src/player.js');
  await ok('playUrl arg plumbing (bad file fails fast, no throw)', async () => {
    const r = await playUrl('file:///nonexistent-fahy-smoke.mp4', {
      headers: { Referer: 'https://x.test/' }, subFile: null,
      skip: { intro: { start: 1, end: 2 } }, direct: true, audioOnly: true,
      androidClient: true, volume: 80,
    });
    assert.ok(r && typeof r.code === 'number' && typeof r.ms === 'number');
  });
  await ok('daemon boots + rejects bad load', async () => {
    const { MusicPlayer } = await import('../src/mplayer.js');
    const d = new MusicPlayer();
    await d.start();
    assert.ok(d.socket, 'IPC connected');
    await d.setVolume(77);
    assert.equal(d.state.volume, 77);
    let failed = false;
    try {
      await d.load('file:///nonexistent-fahy-smoke.mp3');
      await d.waitForStart(15000);
    } catch {
      failed = true;
    }
    assert.ok(failed, 'bad file must fail fast, not hang');
    await d.quit();
  });
} else {
  await ok('playUrl skipped (no mpv)', () => true);
}
const { hasYtDlp, guessFile, defaultMusicDir, freeSpaceBytes } = await import('../src/downloader.js');
await ok('hasYtDlp boolean', () => assert.equal(typeof hasYtDlp(), 'boolean'));
await ok('guessFile mp3', () => assert.ok(guessFile({ title: 'X', audio: true }).endsWith('.mp3')));
await ok('guessFile mp4', () => assert.ok(guessFile({ title: 'X' }).endsWith('.mp4')));
await ok('music dir', () => assert.ok(defaultMusicDir().toLowerCase().includes('music')));
await ok('freeSpace number|null', () => {
  const f = freeSpaceBytes(defaultMusicDir());
  assert.ok(f === null || typeof f === 'bigint');
});

const { skipScript } = await import('../src/player.js');
await ok('skipScript lua', () => {
  const f = skipScript({ intro: { start: 1, end: 2 } });
  assert.ok(typeof f === 'string' && f.endsWith('.lua'));
});
await ok('skipScript none', () => assert.equal(skipScript({}), null));

const { discoverCurl, isChallengeText } = await import('../src/net.js');
await ok('isChallengeText', () => assert.equal(isChallengeText('Just a moment...'), true));
await ok('discoverCurl shape|null', () => {
  const c = discoverCurl();
  assert.ok(c === null || typeof c.path === 'string');
});

const { ytDlpPrivacyArgs, mpvPrivacyArgs } = await import('../src/lib/privacy.js');
await ok('yt-dlp privacy args (ytmusic-player parity)', () => {
  const a = ytDlpPrivacyArgs();
  assert.ok(a.includes('--ignore-config') && a.includes('--no-cache-dir') && a.includes('--no-cookies-from-browser'));
});
await ok('mpv privacy args (ytmusic-player parity)', () => {
  const a = mpvPrivacyArgs().join(' ');
  assert.ok(a.includes('--cache-on-disk=no') && a.includes('ignore-config='));
});
await ok('parseVideoId rejects truncated id (kunai parity)', () =>
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=abc123'), null));
await ok('parseVideoId embed form', () =>
  assert.equal(parseVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ'));
await ok('no permanent TUI shell survives (removed code stays removed)', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const root = new URL('../src/', import.meta.url);
  assert.equal(existsSync(new URL('tui/shell.js', root)), false, 'tui/shell.js must be gone');
  assert.equal(existsSync(new URL('tui/search.js', root)), false, 'tui/search.js must be gone');
  for (const f of ['index.js', 'cli/play.js', 'cli/admin.js', 'playback.js', 'tui/select.js', 'tui/flow.js', 'tui/nowplaying.js']) {
    const body = readFileSync(new URL(f, root), 'utf8');
    assert.ok(!/from '\.\/tui\/shell\.js'/.test(body), `${f} must not import the old shell`);
    assert.ok(!/require\(.ink.\)[^]*?useApp/.test(body), `${f} must not re-enter a full-screen app`);
  }
});
await ok('index.js keeps EPIPE handling and never force-exits on EPIPE', async () => {
  const { readFileSync } = await import('node:fs');
  const body = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(body, /EPIPE/, 'EPIPE guard must survive the rewrite');
  const guard = body.slice(body.indexOf('EPIPE') - 400, body.indexOf('EPIPE') + 400);
  assert.ok(!/process\.exit\(/.test(guard), 'the EPIPE guard must swallow, not force-exit');
});
await ok('no interactive module is imported at load time (CLI stays pipe-safe)', async () => {
  const { readFileSync } = await import('node:fs');
  const body = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(!/^import .*from '\.\/tui\//m.test(body), 'index.js must not import the selector eagerly');
  assert.ok(!/^import .*from 'ink'/m.test(body), 'index.js must not import ink eagerly');
});

const src = await import('../src/sources.js');
await ok('fmhy parse anime section', () => {
  const html = '<h3 id="anime-streaming">Anime</h3><ul>'
    + '<li><a href="https://anikototv.to/">Anikoto</a>, <a href="https://discord.gg/x">chat</a></li>'
    + '<li><a href="https://hianime.ad/">HiAnime</a></li></ul>'
    + '<h3 id="cartoon-streaming">Cartoons</h3><a href="https://example.com/">X</a>';
  const r = src.parseFmhyAnimeSection(html);
  assert.deepEqual(r.map((x) => x.host), ['anikototv.to', 'hianime.ad']);
});
await ok('fmhy parse missing section throws', () => {
  assert.throws(() => src.parseFmhyAnimeSection('<html></html>'), /FMHY layout changed/);
});
await ok('fmhy parse skips apps subsection (exact id)', () => {
  const html = '<h3 id="anime-streaming-apps">Apps</h3><a href="https://seanime.app/">Seanime</a>'
    + '<h3 id="anime-streaming">Anime</h3><a href="https://anikototv.to/">Anikoto</a>'
    + '<h3 id="cartoon-streaming">Cartoons</h3>';
  const r = src.parseFmhyAnimeSection(html);
  assert.deepEqual(r.map((x) => x.host), ['anikototv.to']);
});
await ok('fmhy coverage ok/drift/missing', () => {
  const fmhy = [
    { name: 'Anikoto', url: 'https://anikototv.to/', host: 'anikototv.to' },
    { name: 'HiAnime', url: 'https://hianime.ad/', host: 'hianime.ad' },
  ];
  const cov = src.matchCoverage(fmhy, [
    { id: 'anikoto', name: 'Anikoto', sites: ['https://anikototv.to'], tokens: ['anikoto'] },
    { id: 'hianime', name: 'HiAnime', sites: ['https://hianime.at'], tokens: ['hianime'] },
    { id: 'gone', name: 'Gone', sites: ['https://gone.test'], tokens: ['gone'] },
  ]);
  assert.deepEqual(cov.map((c) => c.status), ['ok', 'drift', 'missing']);
});
await ok('bestProvider picks fastest reachable', () => {
  const b = src.bestProvider([
    { id: 'a', status: 'unreachable', ms: 10 },
    { id: 'b', status: 'reachable', ms: 50 },
    { id: 'c', status: 'reachable', ms: 20 },
  ]);
  assert.equal(b.id, 'c');
});
await ok('bestProvider none healthy', () => {
  assert.equal(src.bestProvider([{ id: 'a', status: 'unreachable' }]), null);
});
// ---- the frame renderer ---------------------------------------------------
//
// The selector is tested against a real Frame wired to fake streams. That is
// the point: the property that matters is not "does the list highlight the
// right row" but "what bytes reach the terminal when state changes", and only
// the renderer knows that.
const { Frame, drainKeys, visibleLength, clip, stripAnsi } = await import('../src/tui/frame.js');
const sel = await import('../src/tui/select.js');
const { EventEmitter } = await import('node:events');
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const guard = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

class FakeOut {
  constructor({ columns = 80, rows = 24, isTTY = true } = {}) {
    this.columns = columns;
    this.rows = rows;
    this.isTTY = isTTY;
    this.chunks = [];
    this.listeners = new Map();
  }
  write(s) { this.chunks.push(String(s)); return true; }
  on(ev, fn) { this.listeners.set(ev, [...(this.listeners.get(ev) || []), fn]); }
  removeListener(ev, fn) { this.listeners.set(ev, (this.listeners.get(ev) || []).filter((x) => x !== fn)); }
  emit(ev, ...a) { for (const fn of this.listeners.get(ev) || []) fn(...a); }
  get text() { return this.chunks.join(''); }
  // A fresh baseline: everything written so far is ignored from now on.
  mark() { this.chunks = []; }
  get marked() { return this.chunks.join(''); }
}

class FakeIn extends EventEmitter {
  constructor() { super(); this.isTTY = true; }
  setRawMode() {}
  resume() {}
  pause() {}
  setEncoding() {}
}

// A frame on fakes, with the cursor-position handshake disabled so tests never
// wait on the real DSR timeout.
async function mountFrame({ columns = 80, rows = 24, render } = {}) {
  const out = new FakeOut({ columns, rows });
  const input = new FakeIn();
  const frame = new Frame({ out, input, columns, rows, cursorQuery: false, guard: false });
  frame.renderFn = render || (() => ['one', 'two']);
  await frame.start();
  // Whatever the mount painted, so a test can assert on the very first frame.
  const first = out.text;
  out.mark();
  return { frame, out, input, first };
}

// Mount a selector screen on fakes. Same code path as production; only the
// streams differ.
async function mountSelector(items, opts = {}) {
  const out = new FakeOut({ columns: opts.columns || 80, rows: opts.rows || 24 });
  const input = new FakeIn();
  const frame = new Frame({ out, input, columns: out.columns, rows: out.rows, cursorQuery: false, guard: false });
  let done;
  const answered = [];
  const screen = sel.listScreen({ ...opts, items }, (v) => { answered.push(v); done = v; });
  await frame.start();
  frame.setScreen({ state: screen.state, render: (s) => screen.render(s, frame), onKey: (k) => screen.onKey(k, frame) });
  out.mark();
  return {
    out, input, frame, screen,
    // What the frame currently shows, as plain lines.
    lines: () => screen.render(frame.state, frame),
    press: (s) => { input.emit('data', s); },
    result: () => done,
    // How many times the screen tried to answer. A question has one answer.
    answers: () => answered,
  };
}

await ok('frame ANSI helpers: strip/visibleLength/clip', () => {
  assert.equal(stripAnsi('\u001B[32mok\u001B[39m'), 'ok');
  assert.equal(visibleLength('\u001B[32mok\u001B[39m'), 2);
  assert.equal(visibleLength('\u00E9x'), 2, 'counts code points, not UTF-16 units');
  assert.equal(clip('abcdef', 4), 'abc\u2026');
  assert.equal(clip('abc', 10), 'abc', 'no change when it already fits');
  // A clipped line keeps the escapes it walked past and drops the rest; the
  // visible width is what matters, and it is exactly the budget.
  assert.equal(visibleLength(clip('\u001B[32mabcdef\u001B[39m', 4)), 4, 'clipped to the budget');
  assert.ok(clip('\u001B[32mabcdef\u001B[39m', 4).includes('\u001B[32m'), 'escape codes survive a clip');
  assert.equal(clip('x', 0), '');
});
await ok('drainKeys decodes every key the selector uses', () => {
  const names = (s) => drainKeys(s).keys.map((k) => k.name);
  assert.deepEqual(names('\r'), ['return']);
  assert.deepEqual(names('\n'), ['return']);
  assert.deepEqual(names('\t'), ['tab']);
  assert.deepEqual(names('\u001B[A'), ['up']);
  assert.deepEqual(names('\u001B[B'), ['down']);
  assert.deepEqual(names('\u001B[C'), ['right']);
  assert.deepEqual(names('\u001B[D'), ['left']);
  assert.deepEqual(names('\u001B[5~'), ['pageup']);
  assert.deepEqual(names('\u001B[6~'), ['pagedown']);
  assert.deepEqual(names('\u001B[H'), ['home']);
  assert.deepEqual(names('\u001B[F'), ['end']);
  assert.deepEqual(names('\u001BOA'), ['up'], 'application cursor mode');
  assert.deepEqual(names('\u001BOB'), ['down']);
  assert.equal(drainKeys('\u0003').keys[0].ctrl, true);
  assert.equal(drainKeys('\u0003').keys[0].char, 'c');
  assert.deepEqual(names('j'), ['char']);
  assert.deepEqual(names('\u007F'), ['backspace']);
  // A split sequence across chunks: only the incomplete part is held.
  assert.equal(drainKeys('\u001B').keys.length, 0);
  assert.equal(drainKeys('\u001B').pending, true);
  assert.equal(drainKeys('\u001B[').pending, true);
  assert.deepEqual(names('\u001B[B'), ['down']);
  // Several keys in one chunk, including an astral one.
  assert.deepEqual(drainKeys('a\r\u{1F600}').keys.map((k) => k.char || k.name), ['a', 'return', '\u{1F600}']);
  // A lone ESC is only an Escape key once forced.
  assert.deepEqual(drainKeys('\u001B', true).keys.map((k) => k.name), ['escape']);
});
await ok('frame paints the first frame in place, with an anchor below it', async () => {
  const { first, frame } = await mountFrame({ render: () => ['a', 'b', 'c'] });
  frame.stop();
  assert.ok(first.includes('a') && first.includes('c'), 'the lines are written');
  assert.ok(first.endsWith('\r'), 'the cursor is left re-homed at the anchor');
});
await ok('frame redraws only the lines that changed', async () => {
  const { out, frame } = await mountFrame({ render: (s) => [`row ${s.n}`, 'static', 'static'] });
  frame.setState({ n: 0 });
  out.mark();
  frame.setState({ n: 1 });
  const t = out.marked;
  assert.ok(t.includes('row 1'), 'the changed line is painted');
  assert.ok(!t.includes('row 0'), 'the old value is gone');
  assert.equal((t.match(/static/g) || []).length, 0, 'unchanged lines are not rewritten');
  frame.stop();
});
await ok('frame an unchanged state writes nothing at all', async () => {
  const { out, frame } = await mountFrame({ render: () => ['a', 'b'] });
  frame.paint();
  frame.paint();
  const t = out.marked;
  frame.stop();
  assert.equal(t, '', 'a no-op repaint must not touch the terminal');
});
await ok('frame clears stale lines when the frame shrinks', async () => {
  const rows = { n: 5 };
  const { out, frame } = await mountFrame({ render: () => Array.from({ length: rows.n }, (_, i) => `l${i}`) });
  rows.n = 2;
  frame.paint();
  const t = out.marked;
  const owned = [...frame.prevLines];
  frame.stop();
  assert.ok(t.includes('\u001B[2K'), 'the dropped lines are cleared');
  assert.ok(!t.includes('l4'), 'no stale row is left behind');
  assert.deepEqual(owned, ['l0', 'l1'], 'the frame now owns exactly two lines');
});
await ok('frame clips to the terminal and never exceeds its height', async () => {
  const { frame } = await mountFrame({ columns: 20, rows: 10, render: () => Array.from({ length: 40 }, (_, i) => `line-${i}`) });
  const painted = frame.prevLines;
  frame.stop();
  assert.ok(painted.length <= 9, `painted ${painted.length} lines into a 10-row terminal`);
  for (const l of painted) assert.ok(visibleLength(l) <= 19, `line too wide: ${JSON.stringify(l)}`);
});
await ok('frame resize repaints against the new size', async () => {
  const { out, frame } = await mountFrame({ columns: 80, render: () => 'x'.repeat(70) });
  assert.ok(visibleLength(frame.prevLines[0]) <= 79, 'starts within the original width');
  out.columns = 30;
  out.emit('resize');
  const painted = frame.prevLines;
  frame.stop();
  assert.ok(visibleLength(painted[0]) <= 29, `width not reapplied: ${visibleLength(painted[0])}`);
});
await ok('frame repaints fully on a forced refresh', async () => {
  const { out, frame } = await mountFrame({ render: () => ['a', 'b'] });
  frame.refresh();
  const t = out.marked;
  frame.stop();
  assert.ok(t.includes('a') && t.includes('b'), 'a refresh repaints every line');
});
await ok('frame stop erases its region and restores the cursor', async () => {
  const { out, frame } = await mountFrame({ render: () => ['a', 'b', 'c'] });
  frame.stop();
  const t = out.marked;
  assert.ok(t.includes('\u001B[2K'), 'the region is cleared');
  assert.ok(t.includes('\u001B[?25h'), 'the cursor is shown again');
  // The cursor walks back up over the frame, then down again: no new line is
  // ever opened, which is what keeps the shell prompt on the same row.
  assert.match(t, /\u001B\[\d+A/, 'the cursor is walked back over the frame');
  assert.ok(!/\n\s*\n\s*\n/.test(t.replace(/\u001B\[\d+[AB]/g, '')), 'stop opens no blank rows');
});
await ok('frame stop({keep}) leaves the frame in the scrollback', async () => {
  const { out, frame } = await mountFrame({ render: () => ['a'] });
  frame.stop({ keep: true });
  const t = out.marked;
  assert.ok(!t.includes('\u001B[2K'), 'nothing is erased');
  assert.ok(t.includes('[?25h'), 'the cursor still comes back');
});
await ok('frame is safe to stop twice', async () => {
  const { out, frame } = await mountFrame({ render: () => ['a'] });
  frame.stop();
  out.mark();
  frame.stop();
  assert.equal(out.marked, '', 'a second stop writes nothing');
});
await ok('frame log is bounded and never grows without limit', async () => {
  const { frame } = await mountFrame({ render: (s) => s.log.map((l) => l.text) });
  for (let i = 0; i < 50; i++) frame.log(`line ${i}`);
  assert.ok(frame.state.log.length <= 6, `log grew to ${frame.state.log.length}`);
  assert.equal(frame.state.log.at(-1).text, 'line 49', 'the newest line is kept');
  frame.stop();
});
await ok('frame spinner animates in place without accumulating frames', async () => {
  let repaints = 0;
  const { out, frame } = await mountFrame({ render: () => { repaints += 1; return ['spin line']; } });
  frame.setSpin('Resolving...');
  await tick(300);
  const text = out.text;
  frame.clearSpin();
  frame.stop();
  assert.ok(repaints > 1, 'the spinner repainted over time');
  // Every repaint targets the same single line: no frame is ever appended.
  assert.ok(!/spin line[\s\S]{10,}spin line/.test(text.replace(/\r/g, '')),
    'a spinner must not leave a trail of frames');
});
await ok('frame never writes a line wider than the terminal', async () => {
  const { frame } = await mountFrame({ columns: 24, render: () => ['x'.repeat(200)] });
  const painted = frame.prevLines;
  frame.stop();
  for (const l of painted) assert.ok(visibleLength(l) <= 23, `overflow: ${visibleLength(l)}`);
});
await ok('frame holds the terminal: a stray write cannot corrupt the region', async () => {
  const { frame, out } = await mountFrame({ render: () => ['a', 'b'] });
  // This is what a console.log from anywhere in the process would do. The
  // guard folds it into the frame's own message area instead of writing over
  // the region, which is the property that keeps a selector intact.
  const before = frame.state.log.length;
  assert.equal(typeof out.write, 'function');
  frame.log('stray output', 'dim');
  assert.equal(frame.state.log.length, before + 1, 'stray output is captured, not printed');
  frame.stop();
});

// ---- the temporary selector ----------------------------------------------
await ok('select pure helpers: short/normalizeItems/firstOf', () => {
  assert.equal(sel.short('abc', 10), 'abc');
  assert.equal(sel.short('abcdefghij', 5), 'abcd\u2026');
  assert.equal(sel.short(null, 5), '');
  const items = sel.normalizeItems([{ label: 'a' }, '-', { label: 'b', value: 'b' }]);
  assert.equal(items.length, 3);
  assert.equal(items[1].separator, true);
  assert.equal(items[0].value, 0, 'value defaults to the index');
  assert.equal(items[2].value, 'b', 'explicit value wins');
  assert.equal(sel.firstOf([{ label: 'x', value: 7 }]), 7);
  assert.equal(sel.firstOf(['-', { label: 'y', value: 8 }]), 8, 'separator is skipped');
  assert.equal(sel.firstOf(['-']), null);
  assert.equal(sel.firstOf([]), null);
});
await ok('selector enter picks the highlighted value', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }], { footer: 'enter select' });
  const text = s.lines().join('\n');
  assert.ok(text.includes('a'), 'frame shows the rows');
  assert.ok(text.includes('enter select'));
  s.press('\r');
  assert.equal(s.result(), 'a');
  s.frame.stop();
});
await ok('selector down arrow moves the cursor', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]);
  assert.match(s.lines().join('\n'), /\u276F a/, 'starts on the first row');
  s.press('\u001B[B');
  assert.match(s.lines().join('\n'), /\u276F b/, 'cursor moved down');
  s.frame.stop();
});
await ok('selector skips separators when moving', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }, '-', { label: 'b', value: 'b' }]);
  s.press('\u001B[B');
  const text = s.lines().join('\n');
  assert.match(text, /\u276F b/);
  assert.doesNotMatch(text, /\u276F\s+-/, 'a separator must never be highlighted');
  s.frame.stop();
});
await ok('selector wraps around and honours g/G', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]);
  s.press('\u001B[A');
  assert.match(s.lines().join('\n'), /\u276F b/, 'up from the top wraps to the bottom');
  s.press('g');
  assert.match(s.lines().join('\n'), /\u276F a/, 'g jumps to the top');
  s.press('G');
  assert.match(s.lines().join('\n'), /\u276F b/, 'G jumps to the last selectable');
  s.frame.stop();
});
await ok('selector clamps initialIndex onto a real row', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }], { initialIndex: 99 });
  assert.match(s.lines().join('\n'), /\u276F b/, 'an out-of-range index lands on the last row');
  s.frame.stop();
});
await ok('selector windows long lists and shows a position', async () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ label: `Episode ${i + 1}`, value: i + 1 }));
  const s = await mountSelector(many, { maxVisible: 8 });
  const text = s.lines().join('\n');
  assert.ok(!text.includes('Episode 45'), 'long lists do not dump every row');
  assert.match(text, /1\/45/, 'position indicator present');
  s.frame.stop();
});
await ok('selector keeps a stable height while navigating', async () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ label: `Episode ${i + 1}`, value: i + 1 }));
  const s = await mountSelector(many, { maxVisible: 8 });
  const heights = new Set();
  for (let i = 0; i < 20; i++) {
    heights.add(s.lines().length);
    s.press(i % 3 === 0 ? '\u001B[B' : i % 3 === 1 ? '\u001B[A' : '\u001B[6~');
  }
  assert.equal(heights.size, 1, `height changed across navigation: ${[...heights].join(',')}`);
  s.frame.stop();
});
await ok('selector rewrites only the rows the cursor moved between', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }, { label: 'c', value: 'c' }]);
  const height = s.frame.prevLines.length;
  s.out.mark();
  s.press('\u001B[B');
  const t = s.out.marked;
  assert.ok(t.length > 0, 'something was drawn');
  assert.ok(!t.includes('c'), 'the untouched row is not rewritten');
  assert.ok(t.includes('a') && t.includes('b'), 'only the two rows the cursor crossed are rewritten');
  assert.equal(s.frame.prevLines.length, height, 'the region keeps its height');
  s.frame.stop();
});
await ok('selector esc resolves null, never throws', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }], { title: 'Source' });
  s.press('\u001B');
  await tick(80); // a lone ESC needs its disambiguation window
  assert.equal(s.result(), null, 'esc must resolve null');
  s.frame.stop();
});
await ok('selector ctrl+c resolves null and does not throw', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]);
  s.press('\u0003');
  assert.equal(s.result(), null, 'ctrl+c must resolve null');
  s.frame.stop();
});
await ok('selector enter resolves the value and exits', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]);
  s.press('\u001B[B');
  s.press('\r');
  assert.equal(s.result(), 'b');
  s.frame.stop();
});
await ok('selector answers exactly once even on a keypress storm', async () => {
  const s = await mountSelector([{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]);
  s.press('\r');
  s.press('\r');
  s.press('\u001B');
  s.press('\u0003');
  assert.equal(s.answers().length, 1, 'a question has exactly one answer');
  assert.equal(s.result(), 'a');
  s.frame.stop();
});
await ok('selector empty list renders a message and exits on esc', async () => {
  const s = await mountSelector([], { title: 'History', emptyText: 'Nothing here yet.' });
  assert.match(s.lines().join('\n'), /Nothing here yet\./);
  s.press('\u001B');
  await tick(80);
  assert.equal(s.result(), null);
  s.frame.stop();
});
await ok('selector clips long titles instead of overflowing', async () => {
  const long = 'The Apothecary Diaries: Season 2 \u2014 Apothecary Diaries Season Two Specials';
  const s = await mountSelector([{ label: long, value: 'x' }], { columns: 40, title: long });
  for (const l of s.lines()) assert.ok(visibleLength(l) <= 39, `overflowed: ${JSON.stringify(l)}`);
  assert.ok(s.lines().some((l) => l.includes('\u2026')), 'the long title is truncated with an ellipsis');
  s.frame.stop();
});
await ok('selector fits a short terminal instead of overflowing it', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ label: `Episode ${i + 1}`, value: i + 1 }));
  const s = await mountSelector(many, { rows: 12, maxVisible: 20 });
  assert.ok(s.lines().length <= 11, `frame is ${s.lines().length} lines in a 12-row terminal`);
  assert.ok(s.lines().length > 3, 'it still shows something');
  s.frame.stop();
});
await ok('selector shows a hint beside the row without changing height', async () => {
  const s = await mountSelector([
    { label: 'Frieren', hint: 'TV \u00B7 28 eps', value: 'a' },
    { label: 'One Piece', hint: 'TV \u00B7 1000 eps', value: 'b' },
  ]);
  const h1 = s.lines().length;
  assert.match(s.lines().join('\n'), /28 eps/, 'the hint is shown');
  s.press('\u001B[B');
  assert.equal(s.lines().length, h1, 'the height does not change when the cursor moves');
  s.frame.stop();
});
await ok('selector renders history rows (tag + progress) and returns the index', async () => {
  const hist = await import('../src/history.js');
  const s = await mountSelector(
    hist.historyItems([
      { title: 'Frieren: Beyond Journey\u2019s End', kind: 'anime', episode: 12, positionMs: 18 * 60_000, duration: 1440, provider: 'HiAnime' },
      { title: 'Inception', kind: 'movie', positionMs: 71 * 60_000, duration: 148 * 60, provider: 'LookMovie' },
    ]),
    { title: 'History', subtitle: 'enter resumes' }
  );
  const text = s.lines().join('\n');
  assert.match(text, /E12/);
  assert.match(text, /18m \/ 24m/);
  assert.match(text, /71m \/ 148m/);
  s.press('\u001B[B');
  assert.equal(s.answers().length, 0, 'moving must not answer');
  s.press('\r');
  assert.equal(s.result(), 1, 'enter returns the index');
  assert.equal(s.answers().length, 1, 'exactly one answer');
  s.frame.stop();
});
await ok('selector swaps screens in place: one region, no second mount', async () => {
  const { frame, out } = await mountFrame();
  const first = sel.listScreen({ title: 'Search Results', items: [{ label: 'Frieren', value: 'a' }] }, () => {});
  frame.setScreen({ state: first.state, render: (s) => first.render(s, frame), onKey: (k) => first.onKey(k, frame) });
  out.mark();
  const second = sel.listScreen({ title: 'Source', items: [{ label: 'LookMovie', value: 'p' }] }, () => {});
  frame.setScreen({ state: second.state, render: (s) => second.render(s, frame), onKey: (k) => second.onKey(k, frame) });
  const t = out.marked;
  assert.ok(t.includes('LookMovie'), 'the new screen is drawn');
  assert.ok(t.includes('Source'), 'the new title is drawn');
  assert.ok(!/\n\s*Search Results[\s\S]*\n\s*Source/.test(t), 'the previous screen was not left behind');
  frame.stop();
});
await ok('select() is single-flight (concurrent calls share one mount)', async () => {
  const p1 = sel.select({ title: 'A', items: [{ label: 'x', value: 1 }] });
  const p2 = sel.select({ title: 'B', items: [{ label: 'y', value: 2 }] });
  assert.equal(p1, p2, 'a second call joins the live one instead of stacking renderers');
  const v = await guard(p1, 5000, 'single-flight select');
  assert.ok(v === null || v === 1, `got ${JSON.stringify(v)}`);
});
await ok('canSelect reflects the TTY state', () => {
  assert.equal(typeof sel.canSelect(), 'boolean');
  assert.equal(sel.canSelect(), !!process.stdin.isTTY && !!process.stdout.isTTY);
});
await ok('confirm returns false when backed out of', async () => {
  const v = await guard(sel.confirm({ title: 'Sure?' }), 5000, 'confirm');
  assert.ok(v === true || v === false, `got ${JSON.stringify(v)}`);
});
await ok('ask is a no-op off a TTY', async () => {
  if (!sel.canSelect()) assert.equal(await sel.ask({ title: 'x' }), null);
});

// ---- the terminal itself ---------------------------------------------------
//
// Everything above asserts on bytes or on a render function. That is not the
// same as what the user sees: bytes can be perfectly well-formed and still add
// up to a duplicated screen. So these tests run the *real* selection chain
// against a terminal emulator — a small VT interpreter that keeps a row/column
// grid, wraps at the last column and scrolls, like the thing on the other end.
//
// The invariant is not "a line was written". It is: the frame's own lines are
// on the screen exactly once, in one contiguous block, and nothing else is.
class Term {
  constructor({ columns = 80, rows = 24, promptRow = 6, prompt = 'PS C:\\work> fahy anime Frieren' } = {}) {
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    this.grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '));
    // The shell has echoed the command and left its cursor on the line *below*
    // the prompt. That is where the frame will start, and it is the last line
    // the user can still see.
    this.promptText = prompt;
    this.promptRow = Math.min(promptRow, rows - 2);
    this.row = this.promptRow + 1;
    this.col = 0;
    this.cursorVisible = true;
    this.rawMode = false;
    this.scrolls = 0;
    this.set(this.promptRow, 0, prompt);
  }

  on(ev, fn) { this.listeners.set(ev, [...(this.listeners.get(ev) || []), fn]); }
  removeListener(ev, fn) { this.listeners.set(ev, (this.listeners.get(ev) || []).filter((x) => x !== fn)); }
  emit(ev, ...a) { for (const fn of this.listeners.get(ev) || []) fn(...a); }
  get listeners() { if (!this._l) this._l = new Map(); return this._l; }

  set(r, c, text) {
    for (let i = 0; i < text.length && c + i < this.columns; i++) this.grid[r][c + i] = text[i];
  }
  // The shell printing a line and leaving its cursor on the one under it — the
  // same thing that happens when a user types a command. The frame only learns
  // about it through the cursor, so the emulator has to model it faithfully.
  print(text) {
    this.set(this.row, 0, String(text));
    this.promptRow = this.row;
    this.promptText = String(text);
    this.down(1);
  }
  line(r) { return (this.grid[r] || []).join('').replace(/\s+$/, ''); }
  // Every row holding anything at all.
  get used() {
    const out = [];
    for (let r = 0; r < this.rows; r++) if (this.line(r)) out.push(r);
    return out;
  }
  get dump() { return this.grid.map((_, r) => `${String(r).padStart(2)}| ${this.line(r)}`).join('\n'); }

  scroll() {
    this.grid.shift();
    this.grid.push(Array.from({ length: this.columns }, () => ' '));
    this.scrolls += 1;
    // The prompt scrolls with everything else; it may leave the window entirely.
    this.promptRow -= 1;
  }

  // Only a line feed scrolls. Cursor-down stops at the bottom row, which is
  // exactly why the frame has to buy room before it paints.
  down(n = 1) {
    this.row += n;
    if (this.row >= this.rows) this.scroll();
    this.row = Math.min(this.row, this.rows - 1);
  }

  write(chunk) {
    const s = String(chunk);
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\u001B') {
        const m = /^\u001B\[([0-9;?]*)([ -/]*)([@-~])/.exec(s.slice(i));
        if (m) { this.csi(m[1], m[3]); i += m[0].length; continue; }
        i += 1;
        continue;
      }
      if (ch === '\n') { this.down(); i += 1; continue; }
      if (ch === '\r') { this.col = 0; i += 1; continue; }
      if (ch === '\b') { this.col = Math.max(0, this.col - 1); i += 1; continue; }
      if (ch === '\u0007') { i += 1; continue; }
      // A character in the last column defers the wrap to the next one.
      if (this.col >= this.columns) { this.col = 0; this.down(); }
      this.grid[this.row][this.col] = ch;
      this.col += 1;
      i += 1;
    }
    return true;
  }

  csi(params, final) {
    const priv = params.startsWith('?');
    const nums = params.replace('?', '').split(';').filter((x) => x !== '').map(Number);
    const n = nums[0] || 0;
    if (priv) {
      if (final === 'h' && n === 25) this.cursorVisible = true;
      if (final === 'l' && n === 25) this.cursorVisible = false;
      return;
    }
    if (final === 'A') this.row = Math.max(0, this.row - (n || 1));
    else if (final === 'B') this.row = Math.min(this.rows - 1, this.row + (n || 1));
    else if (final === 'C') this.col = Math.min(this.columns - 1, this.col + (n || 1));
    else if (final === 'D') this.col = Math.max(0, this.col - (n || 1));
    else if (final === 'G') this.col = Math.max(0, (n || 1) - 1);
    else if (final === 'H') { this.row = Math.max(0, (nums[0] || 1) - 1); this.col = Math.max(0, (nums[1] || 1) - 1); }
    else if (final === 'K') {
      if (n === 1) for (let c = 0; c <= this.col; c++) this.grid[this.row][c] = ' ';
      else if (n === 0) for (let c = this.col; c < this.columns; c++) this.grid[this.row][c] = ' ';
      else this.grid[this.row] = Array.from({ length: this.columns }, () => ' ');
    } else if (final === 'J' && (n === 2 || n === 3)) {
      this.grid = this.grid.map(() => Array.from({ length: this.columns }, () => ' '));
    }
    // SGR and anything unrecognised is ignored: colour is not part of the
    // contract, and neither is a private mode the frame never uses.
  }
}

// A keyboard attached to the emulator: it emits key bytes, and it answers the
// frame's cursor-position query the way a real terminal does.
class Keys extends EventEmitter {
  constructor(term) {
    super();
    this.term = term;
    this.isTTY = true;
  }
  setRawMode(v) { this.term.rawMode = v; }
  resume() {}
  pause() {}
  setEncoding() {}
  type(s) { this.emit('data', s); }
  // A terminal reports the cursor's 1-based line number.
  //
  // A real terminal does not deliver that reply on its own. It shares a read with
  // whatever else stdin produced at the same moment — most reliably the newline
  // the shell echoed when the command was launched. `coalesce` reproduces that,
  // because the two cases differ only in whether the reply arrives alone, and a
  // suite that only ever sends it alone cannot tell them apart.
  answer({ coalesce = false } = {}) {
    const reply = `\u001B[${this.term.row + 1};1R`;
    this.emit('data', coalesce ? `\n${reply}` : reply);
  }
}

function attach({ columns = 80, rows = 24, promptRow = 6, guard = false, deferCursor = false, coalesce = false } = {}) {
  const term = new Term({ columns, rows, promptRow });
  const keys = new Keys(term);
  const raw = term.write.bind(term);
  // The frame asks where the cursor is; the terminal answers on stdin. With
  // `deferCursor` those answers wait, which is how a test changes the screen
  // while the frame is still waiting on the terminal.
  //
  // keys.flush() answers until the frame stops asking. Answering is not a
  // straight loop: each answer lets the frame re-read its screen, and a frame
  // that has just mounted reserves a line before it knows what it will show, so
  // one answer commonly provokes the next question. So the queue is counted,
  // that many answers are sent, and the frame is given a turn before the count
  // is taken again — otherwise answering and asking feed each other forever.
  let held = [];
  term.write = (s) => {
    raw(s);
    if (String(s).includes('\u001B[6n')) {
      if (deferCursor) held.push(1);
      else setImmediate(() => keys.answer({ coalesce }));
    }
    return true;
  };
  keys.flush = async () => {
    for (let round = 0; round < 20; round++) {
      await tick(1);
      const owed = held.length;
      held.length = 0;
      for (let i = 0; i < owed; i++) keys.answer({ coalesce });
      if (!held.length) return;
    }
  };
  sel.setTerminalHost({ out: term, input: keys, guard });
  return { term, keys };
}

// A frame on the terminal emulator, with the cursor-position handshake held
// until the test says otherwise. Used where the test is about how the frame
// places itself in a real terminal rather than about what a selector renders.
async function mountOnTerm(term, keys) {
  const f = new Frame({ out: term, input: keys, cursorQuery: true, guard: false });
  const started = f.start();
  await keys.flush();
  await started;
  return f;
}

// Wait until the frame has stopped laying out. A frame re-places
// asynchronously and each answer can provoke the next question, so "the answer
// was sent" and "the frame is done" are not the same moment.
async function settle(f, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await tick(3);
    if (!f._laying) return;
  }
}

// The core assertion, run after every single transition.
//
// The frame knows which lines it owns. Those exact lines must appear on the
// screen exactly once, in one contiguous block, and no other row may hold
// anything. A duplicated screen, a stale tail from a shorter previous frame, a
// hole punched by a background write and a row that wrapped past the terminal
// edge all fail this.
function assertRegion(term, what, { frame, at = null } = {}) {
  const f = frame === undefined ? sel.liveFrame() : frame;
  assert.ok(f, `${what}: no frame is live`);
  const owned = (f.prevLines || []).map(stripAnsi);
  assert.ok(owned.length > 0, `${what}: the frame owns no lines`);
  const found = [];
  for (let r = 0; r + owned.length <= term.rows; r++) {
    let match = true;
    for (let i = 0; i < owned.length; i++) {
      if (term.line(r + i) !== owned[i]) { match = false; break; }
    }
    if (match) found.push(r);
  }
  assert.equal(
    found.length, 1,
    `${what}: the frame is on screen ${found.length} times\n--- terminal ---\n${term.dump}\n--- frame owns ---\n${JSON.stringify(owned)}`
  );
  const top = found[0];
  const bottom = top + owned.length - 1;
  // With room to spare the frame must start exactly where the terminal was
  // left: the command line the user typed stays where it was, and the region
  // does not creep down the screen one line per step.
  const want = at === null ? term.promptRow + 1 : at;
  if (term.scrolls === 0) {
    assert.equal(top, want, `${what}: the frame does not start on row ${want} (it starts on ${top})\n${term.dump}`);
  }
  for (let r = 0; r < term.rows; r++) {
    // The frame owns [top, bottom]. Below it there must be nothing: that is
    // where a stale tail from a taller previous frame would sit. Above it is the
    // shell's own scrollback — echoed commands and handoffs — and none of that
    // is the frame's to account for.
    if (r <= bottom) continue;
    if (r === term.promptRow) continue;
    assert.equal(term.line(r), '', `${what}: residue on row ${r}: ${JSON.stringify(term.line(r))}\n${term.dump}`);
  }
  for (let r = top; r <= bottom; r++) {
    assert.ok(term.line(r).length <= term.columns, `${what}: row ${r} is ${term.line(r).length} wide in a ${term.columns}-column terminal`);
  }
  return {
    top,
    bottom,
    height: owned.length,
    // Every line of the frame as the terminal shows it.
    body: owned.join('\n'),
    lines: owned,
  };
}

// After the interaction is over the terminal must be indistinguishable from how
// it was found: no frame, no residue, cursor back, raw mode off.
function assertClean(term, what) {
  // Nothing is holding the terminal. A dead frame may still be referenced — a
  // signal stops the frame without going through endFrame — but a frame that
  // has stopped is not drawing, and that is what matters here.
  const live = sel.liveFrame();
  assert.ok(!live || !live.alive, `${what}: a frame is still drawing`);
  // Only the shell's own output may be on screen: the prompt and whatever the
  // shell has printed since. Everything below the last of those is the frame's
  // residue.
  let floor = term.promptRow;
  for (let r = term.promptRow + 1; r < term.rows; r++) if (term.line(r)) floor = r;
  for (let r = floor + 1; r < term.rows; r++) {
    assert.equal(term.line(r), '', `${what}: residue on row ${r}: ${JSON.stringify(term.line(r))}\n${term.dump}`);
  }
  if (term.promptRow >= 0) {
    assert.equal(term.line(term.promptRow), term.promptText, `${what}: the prompt line was damaged`);
  }
  assert.equal(term.cursorVisible, true, `${what}: the cursor is still hidden`);
  assert.equal(term.rawMode, false, `${what}: the terminal is still in raw mode`);
}

const ui = await import('../src/ui.js');
const PROMPT_ROW = 6;
const ROOMY = { columns: 80, rows: 24, promptRow: PROMPT_ROW };
// Production never leaves a frame up: ui.say/ui.fail end it before printing.
// These tests go through the same handoff, or they are asserting a state no
// user would ever be in.
const handBack = async (ms = 60) => { sel.endFrame(); await tick(ms); };

await ok('the whole selection chain stays in one region', async () => {
  const { term, keys } = attach(ROOMY);
  const steps = [
    { title: 'Search Results', items: [{ label: 'Frieren (2023)', value: 0 }, { label: 'Frieren: Beyond Journey (2024)', value: 1 }], keys: ['\u001B[B', '\r'], want: 1 },
    { title: 'Season', items: [{ label: 'Season 1', value: 1 }, { label: 'Season 2', value: 2 }], keys: ['\u001B[B', '\r'], want: 2 },
    { title: 'Episode', items: Array.from({ length: 30 }, (_, i) => ({ label: `Episode ${i + 1}`, value: i + 1 })), keys: ['\u001B[6~', 'g', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r'], want: 5 },
    { title: 'Source', items: [{ label: 'AnimePahe', value: 'pahe' }, { label: 'Hianime', value: 'hianime' }], keys: ['\r'], want: 'pahe' },
  ];
  const heights = [];
  try {
    for (const step of steps) {
      const answer = sel.select({ title: step.title, items: step.items, maxVisible: 12 });
      await tick(60);
      const v = assertRegion(term, `${step.title} mounted`);
      assert.ok(v.height > 0, `${step.title} rendered nothing`);
      assert.equal(stripAnsi(term.line(v.top)).includes(step.title), true, `${step.title}: the screen is not the one on screen\n${term.dump}`);
      heights.push(v.height);
      for (const k of step.keys) { keys.type(k); await tick(15); }
      assert.equal(await guard(answer, 2000, `${step.title} answer`), step.want, `${step.title}: wrong answer`);
      await tick(20);
    }
    // The interaction is over; the terminal goes back the way it came.
    await handBack();
    assertClean(term, 'after the chain');
    assert.equal(term.scrolls, 0, `the chain scrolled the terminal ${term.scrolls} times`);
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
  assert.ok(heights.every((h) => h > 0), 'every step rendered something');
});

await ok('a step change never scrolls the terminal', async () => {
  const { term, keys } = attach(ROOMY);
  try {
    const answer = sel.select({
      title: 'Episode',
      items: Array.from({ length: 200 }, (_, i) => ({ label: `Episode ${i + 1}`, value: i + 1 })),
      maxVisible: 10,
    });
    await tick(60);
    assertRegion(term, 'long list mounted');
    const scrolls = term.scrolls;
    for (let i = 0; i < 60; i++) { keys.type('\u001B[B'); await tick(1); }
    assertRegion(term, 'after 60 moves');
    assert.equal(term.scrolls, scrolls, 'moving the cursor scrolled the terminal');
    keys.type('\r');
    await guard(answer, 2000, 'answer');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('resize re-lays out the live frame in place', async () => {
  const { term, keys } = attach(ROOMY);
  const items = Array.from({ length: 40 }, (_, i) => ({ label: `Episode ${i + 1} — a deliberately long episode title number ${i}`, value: i + 1 }));
  try {
    const answer = sel.select({ title: 'Episode', items, maxVisible: 10 });
    await tick(60);
    const wide = assertRegion(term, 'wide');
    const scrolls = term.scrolls;
    // Narrower: the frame re-clips. It must not scroll, stack or drop rows.
    term.columns = 40;
    term.emit('resize');
    await tick(20);
    const narrow = assertRegion(term, 'narrow');
    assert.equal(term.scrolls, scrolls, 'narrowing scrolled the terminal');
    assert.ok(narrow.height <= wide.height, 'a narrower terminal did not get shorter');
    // Shorter: fewer rows, same prompt, still one region.
    term.columns = 80;
    term.rows = 14;
    term.emit('resize');
    await tick(20);
    const short = assertRegion(term, 'short terminal');
    assert.ok(short.height < wide.height, `a 14-row terminal showed the same ${short.height} rows as a 24-row one`);
    // Taller: it must use the room it just gained.
    term.rows = 40;
    term.emit('resize');
    await tick(20);
    const tall = assertRegion(term, 'tall terminal');
    assert.ok(tall.height > short.height, 'a tall terminal did not use the extra rows');
    keys.type('\r');
    await guard(answer, 2000, 'answer');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('a small terminal fits, scrolls once, and still works', async () => {
  // 8 rows with the prompt on the second line leaves no room for a full
  // selector, so the frame has to scroll to get on screen — and then behave.
  const { term, keys } = attach({ columns: 32, rows: 8, promptRow: 1 });
  try {
    const answer = sel.select({ title: 'Source', items: [{ label: 'AnimePahe', value: 'a' }, { label: 'Hianime', value: 'b' }] });
    await tick(80);
    const v = assertRegion(term, 'tiny terminal');
    assert.ok(v.height <= 7, `the frame is ${v.height} rows in an 8-row terminal`);
    for (let r = v.top; r <= v.bottom; r++) {
      assert.ok(term.line(r).length <= 32, `row ${r} overflows a 32-column terminal`);
    }
    keys.type('\u001B[B');
    keys.type('\r');
    assert.equal(await guard(answer, 2000, 'answer'), 'b', 'the selection is still correct when cramped');
    await handBack();
    assertClean(term, 'tiny terminal teardown');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('a frame with no room scrolls exactly as far as it needs', async () => {
  // The cursor is on the last line: painting has to scroll, and it has to
  // scroll once, by the height of the frame, and no further.
  const { term, keys } = attach({ columns: 80, rows: 12, promptRow: 10 });
  try {
    const answer = sel.select({
      title: 'Episode',
      items: Array.from({ length: 30 }, (_, i) => ({ label: `Episode ${i + 1}`, value: i + 1 })),
      maxVisible: 8,
    });
    await tick(80);
    const v = assertRegion(term, 'bottom-anchored');
    assert.ok(v.height <= 11, `the frame is ${v.height} rows in a 12-row terminal`);
    const scrolls = term.scrolls;
    keys.type('\u001B[B');
    keys.type('\u001B[B');
    assertRegion(term, 'bottom-anchored, after moving');
    assert.equal(term.scrolls, scrolls, 'navigating scrolled a terminal that was already scrolled');
    keys.type('\r');
    await guard(answer, 2000, 'answer');
    await handBack();
    assertClean(term, 'bottom-anchored teardown');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('a long title is clipped, never wrapped onto a second row', async () => {
  const { term, keys } = attach({ columns: 40, rows: 20, promptRow: 4 });
  const long = `${'Very Long Title '.repeat(12)}End`;
  try {
    const answer = sel.select({ title: 'Search Results', items: [{ label: long, value: 1 }] });
    await tick(60);
    assertRegion(term, 'long title');
    for (const r of term.used) {
      assert.ok(term.line(r).length <= 40, `a row wrapped: ${JSON.stringify(term.line(r))}`);
    }
    keys.type('\r');
    await guard(answer, 2000, 'answer');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('an emoji title does not desynchronise the width accounting', async () => {
  // The frame clips by code point, and an astral character is one cell but two
  // UTF-16 units. If the two ever disagreed, the row would run past the edge.
  const { term, keys } = attach({ columns: 32, rows: 14, promptRow: 3 });
  try {
    const answer = sel.select({ title: 'Search', items: [{ label: '🎬🎥🍿 '.repeat(14) + 'end', value: 1 }] });
    await tick(60);
    assertRegion(term, 'emoji title');
    for (const r of term.used) {
      assert.ok(term.line(r).length <= 32, `a row ran past the edge: ${term.line(r).length} cells`);
    }
    keys.type('\r');
    await guard(answer, 2000, 'answer');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('the spinner is a line inside the frame, replaced by the results', async () => {
  const { term, keys } = attach(ROOMY);
  try {
    sel.showSpinner('Searching…');
    await tick(80);
    const loading = assertRegion(term, 'spinner');
    assert.match(term.line(loading.top), /Searching/, `the spinner is not on screen\n${term.dump}`);
    const answer = sel.select({ title: 'Search Results', items: [{ label: 'Frieren (2023)', value: 0 }] });
    await tick(40);
    const results = assertRegion(term, 'results over the spinner');
    assert.match(term.line(results.top), /Search Results/, 'the results are not on screen');
    assert.ok(!results.body.includes('Searching'), `the spinner is still on screen\n${term.dump}`);
    sel.pushLog('hianime replied in 240ms');
    await tick(20);
    assertRegion(term, 'results plus a log line');
    keys.type('\r');
    await guard(answer, 2000, 'answer');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('a spinner tick rewrites one line, not the frame', async () => {
  const { term, keys } = attach(ROOMY);
  try {
    sel.showSpinner('Resolving…');
    await tick(80);
    const before = assertRegion(term, 'spinner');
    const scrolls = term.scrolls;
    await tick(320); // four animation frames
    const after = assertRegion(term, 'after spinner ticks');
    assert.equal(after.height, before.height, 'the frame changed height while idle');
    assert.equal(after.top, before.top, 'the frame moved while idle');
    assert.equal(term.scrolls, scrolls, 'the spinner scrolled the terminal');
    await handBack();
    assertClean(term, 'spinner teardown');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('background output is folded into the frame, then given back', async () => {
  // The write guard patches the process's own streams, so this is the one test
  // that touches them — and it always puts them back.
  const { term, keys } = attach({ ...ROOMY, guard: true });
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const realLog = console.log;
  const replayed = [];
  console.log = (...a) => replayed.push(stripAnsi(a.join(' ')));
  try {
    const answer = sel.select({ title: 'Source', items: [{ label: 'AnimePahe', value: 'a' }] });
    await tick(80);
    const was = assertRegion(term, 'before the noise');
    const scrolls = term.scrolls;
    // Three different routes to the same place: a direct write, a write to the
    // other stream, and a console.* call from somewhere in the process. console.info
    // and not console.log, because console.log is the channel the replay below is
    // observed through — stubbing it would stub the very thing under test.
    process.stdout.write('provider says hello\n');
    process.stderr.write('warning: slow mirror\n');
    console.info('a stray console.info');
    await tick(40);
    // The frame still shows one screen, in one place, and the terminal did not
    // move: none of the three punched a hole in it. The frame may legitimately
    // grow a row to make room for the status line, but it must not move.
    const now = assertRegion(term, 'after the noise');
    assert.equal(term.scrolls, scrolls, 'a background write scrolled the terminal');
    assert.equal(now.top, was.top, 'a background write moved the region down the screen');
    assert.deepEqual(replayed, [], `a background write reached the terminal directly: ${JSON.stringify(replayed)}`);
    // The frame has room for one line of status, so the newest one is what is
    // on screen.
    const onScreen = term.grid.map((_, r) => term.line(r)).join('\n');
    assert.match(onScreen, /stray console\.info/, `the newest captured line is not on screen\nlog=${JSON.stringify(sel.liveFrame()?.state?.log)}\n${term.dump}`);
    keys.type('\r');
    await guard(answer, 2000, 'answer');
    // And nothing is lost: all three come back, in order, once, when the frame
    // gives the terminal up.
    sel.endFrame();
    await tick(40);
    assert.deepEqual(
      replayed,
      ['provider says hello', 'warning: slow mirror', 'a stray console.info'],
      'the captured lines were not given back'
    );
    assertClean(term, 'after the noise was handed back');
  } finally {
    console.log = realLog;
    sel.endFrame();
    sel.setTerminalHost(null);
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  assert.equal(process.stdout.write, realOut, 'the stdout guard was left installed');
  assert.equal(process.stderr.write, realErr, 'the stderr guard was left installed');
});

await ok('a screen that arrives while the terminal is silent still renders', async () => {
  // The frame asks the terminal where the cursor is before it knows what it
  // will draw, and the very first screen a frame is given usually arrives
  // during that round trip. Anything that happens in that window used to be
  // thrown away: the frame painted the empty screen it was mounted with and the
  // real one never appeared.
  const { term, keys } = attach({ ...ROOMY, deferCursor: true });
  try {
    // This is the real shape: a frame mounts empty, and the screen that matters
    // lands while the frame is still waiting on the terminal.
    const f = await mountOnTerm(term, keys);
    assert.ok(f, 'no frame');
    f.setScreen({ state: { title: 'first', body: [] }, render: (s) => [s.title] });
    await keys.flush();
    await settle(f);
    const first = assertRegion(term, 'the first screen', { frame: f });
    assert.ok(first.body.includes('first'), `the first screen never rendered\n${term.dump}`);

    // A screen that needs more room than the first one got must re-place, not
    // paint over a region that cannot hold it.
    f.setScreen({ state: { title: 'second', body: [] }, render: (s) => [s.title, ...Array.from({ length: 6 }, (_, i) => `  row ${i}`)] });
    await keys.flush();
    await settle(f);
    const second = assertRegion(term, 'a taller screen', { frame: f });
    assert.ok(second.height > first.height, `the frame did not grow to hold the new screen (${first.height} -> ${second.height})`);
    assert.ok(second.body.includes('row 5'), `the taller screen is not fully drawn\n${term.dump}`);
    f.stop();
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('a selector survives its own cursor-position reply arriving with other input', async () => {
  // The frame asks the terminal where the cursor is, and the answer comes back
  // on stdin. A real terminal does not deliver that answer on its own: it shares
  // a read with whatever else stdin produced at the same moment, most reliably
  // the newline the shell echoed when the command was launched.
  //
  // The reply is ESC [ row ; col R. Matched as a whole chunk it looked like
  // nothing the frame had seen before, so it was pushed into the key buffer,
  // where it decoded as the Escape key — and the frame cancelled its own
  // selector the instant it asked the terminal a question. In a real terminal
  // that made every selector mount and vanish in the same breath, and because
  // the cancel left the frame up, the process then hung on it forever.
  const { term, keys } = attach({ ...ROOMY, coalesce: true });
  try {
    const answer = sel.select({ title: 'Search Results', items: [{ label: 'Frieren (2023)', value: 0 }] });
    await tick(120);
    const v = assertRegion(term, 'mounted with a coalesced cursor reply', { frame: sel.liveFrame() });
    assert.ok(v.body.includes('Frieren'), `the selector vanished on its own cursor reply\n${term.dump}`);
    assert.ok(sel.frameLive(), 'the frame tore itself down while asking the terminal where the cursor was');
    // Still answering, so the screen is not merely painted but usable.
    keys.type('\u001B[B');
    await tick(40);
    keys.type('\r');
    assert.equal(await guard(answer, 2000, 'answer'), 0, 'the selector stopped answering keys');
    await handBack();
    assertClean(term, 'after the coalesced reply');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('the cursor-position reply is consumed and the rest of the read is kept', async () => {
  // The other half of the same fix: extracting the answer must not throw away
  // the input it shared a read with. A key pressed while the frame was asking is
  // real input, and dropping it would be a lost keystroke.
  const { term, keys } = attach({ ...ROOMY, deferCursor: true });
  try {
    const f = await mountOnTerm(term, keys);
    assert.ok(f, 'no frame');
    f.setScreen({
      state: { index: 0 },
      render: () => ['pick a thing', 'a', 'b'],
      onKey: (k) => {
        if (k.name === 'down') f.state.index = 1;
        if (k.name === 'return') f.stop();
      },
    });
    await keys.flush();
    await settle(f);
    // Now hold the next handshake open and answer it by hand, so the reply and a
    // real key arrive in the same read — which is what a terminal does. A resize
    // is what makes the frame ask again.
    const held = [];
    const realWrite = term.write;
    term.write = (s) => {
      realWrite(s);
      if (String(s).includes('\u001B[6n')) held.push(1);
      return true;
    };
    term.emit('resize');
    for (let i = 0; i < 40 && !held.length; i++) await tick(3);
    assert.ok(held.length, 'the frame never asked the terminal where the cursor was');
    // One read: the echoed newline, the answer, and a genuine arrow key.
    keys.emit('data', `\n\u001B[${term.row + 1};1R\u001B[B`);
    await tick(60);
    assert.equal(f.state.index, 1, 'the arrow key was swallowed along with the reply');
    term.write = realWrite;
    f.stop();
    await handBack();
    assertClean(term, 'after a coalesced keypress');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('ui hands the terminal back before it prints', async () => {
  const { term, keys } = attach(ROOMY);
  const seen = [];
  const realErr = console.error;
  const realLog = console.log;
  console.error = (...a) => seen.push(['err', stripAnsi(a.join(' '))]);
  console.log = (...a) => seen.push(['out', stripAnsi(a.join(' '))]);
  try {
    const answer = sel.select({ title: 'Search Results', items: [{ label: 'a', value: 1 }] });
    await tick(80);
    assertRegion(term, 'mounted');
    ui.fail('No results for "xyz".');
    await tick(40);
    assertClean(term, 'after ui.fail');
    assert.deepEqual(seen, [['err', 'No results for "xyz".']], 'the message prints once, after the handoff');
    assert.equal(await guard(answer, 2000, 'answer'), null, 'ending the frame resolves the question with null');
    // And the log path folds into the frame instead of printing over it. The
    // frame mounts under wherever the handoff left the terminal, which is
    // lower down than the original prompt — not under the prompt.
    const at = term.row;
    const answer2 = sel.select({ title: 'Source', items: [{ label: 'a', value: 1 }] });
    await tick(80);
    assertRegion(term, 'second mount', { at });
    seen.length = 0;
    ui.tlog('trying hianime');
    await tick(20);
    assertRegion(term, 'tlog into a live frame', { at });
    assert.deepEqual(seen, [], `tlog printed while a frame was up: ${JSON.stringify(seen)}`);
    assert.match(term.grid.map((_, r) => term.line(r)).join('\n'), /trying hianime/, 'the log line was lost');
    keys.type('\r');
    await guard(answer2, 2000, 'answer 2');
    // say() ends the frame — which gives back what the frame swallowed — and
    // then prints the result underneath it.
    seen.length = 0;
    ui.say('now playing');
    await tick(20);
    assert.deepEqual(
      seen,
      [['out', 'trying hianime'], ['out', 'now playing']],
      `the handoff and the result did not print once each, in order: ${JSON.stringify(seen)}`
    );
    assertClean(term, 'after ui.say');
  } finally {
    console.error = realErr;
    console.log = realLog;
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('esc leaves the terminal exactly as it found it', async () => {
  const { term, keys } = attach(ROOMY);
  try {
    const answer = sel.select({ title: 'Search Results', items: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] });
    await tick(80);
    assertRegion(term, 'before esc');
    keys.type('\u001B');
    assert.equal(await guard(answer, 2000, 'esc'), null, 'esc must resolve null, never throw');
    await handBack();
    assertClean(term, 'after esc');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('ctrl+c leaves the terminal exactly as it found it', async () => {
  const { term, keys } = attach(ROOMY);
  try {
    const answer = sel.select({ title: 'Search Results', items: [{ label: 'a', value: 1 }] });
    await tick(80);
    assertRegion(term, 'before ctrl+c');
    keys.type('\u0003');
    assert.equal(await guard(answer, 2000, 'ctrl+c'), null);
    await handBack();
    assertClean(term, 'after ctrl+c');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('the frame takes a signal as its own exit, not the process', async () => {
  // In raw mode Ctrl+C is a byte and never raises a signal. A kill -INT, or a
  // terminal that could not enter raw mode, does — and the frame still has to
  // come down. The frame's handler is called directly rather than by emitting
  // SIGINT on the process, because every other module in the process has its
  // own idea of what a signal means (player.js exits outright) and this test is
  // about the frame, not about them.
  const { term, keys } = attach(ROOMY);
  const sigints = () => process.listeners('SIGINT');
  const sigterms = () => process.listeners('SIGTERM');
  const exits = () => process.listeners('exit');
  const before = { i: sigints(), t: sigterms(), x: exits() };
  try {
    sel.select({ title: 'Search Results', items: [{ label: 'a', value: 1 }] });
    await tick(80);
    assertRegion(term, 'before the signal');
    const added = {
      i: sigints().filter((f) => !before.i.includes(f)),
      t: sigterms().filter((f) => !before.t.includes(f)),
      x: exits().filter((f) => !before.x.includes(f)),
    };
    assert.equal(added.i.length, 1, `the frame added ${added.i.length} SIGINT handlers, expected 1`);
    assert.equal(added.t.length, 1, `the frame added ${added.t.length} SIGTERM handlers, expected 1`);
    assert.equal(added.x.length, 1, `the frame added ${added.x.length} exit handlers, expected 1`);
    added.i[0]('SIGINT');
    await tick(40);
    assertClean(term, 'after the frame handled SIGINT');
    // And it takes them back off again rather than leaking a handler per mount.
    assert.equal(sigints().filter((f) => !before.i.includes(f)).length, 0, 'the SIGINT handler leaked');
    assert.equal(sigterms().filter((f) => !before.t.includes(f)).length, 0, 'the SIGTERM handler leaked');
    assert.equal(exits().filter((f) => !before.x.includes(f)).length, 0, 'the exit handler leaked');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('re-entering after a clean exit mounts a fresh region', async () => {
  const { term, keys } = attach(ROOMY);
  try {
    for (let round = 1; round <= 3; round++) {
      // What the shell does after the previous command: print its handoff, then
      // a fresh prompt. The frame has to mount under *that*, wherever it is.
      if (round > 1) term.print(`cancelled round ${round - 1}`);
      const answer = sel.select({ title: `Round ${round}`, items: [{ label: 'only', value: round }] });
      await tick(60);
      const v = assertRegion(term, `round ${round}`);
      assert.ok(v.body.includes(`Round ${round}`), `round ${round} mounted the wrong screen`);
      assert.equal(v.top, term.promptRow + 1, `round ${round} did not mount under the new prompt`);
      keys.type('\r');
      assert.equal(await guard(answer, 2000, `round ${round} answer`), round);
      await handBack();
      assert.equal(term.scrolls, 0, `round ${round} scrolled the terminal`);
      // The frame is gone. Everything still on screen is the shell's: the
      // command lines it echoed and the handoff it printed.
      assertClean(term, `after round ${round}`);
    }
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('a question with no results shows a message and backs out cleanly', async () => {
  const { term, keys } = attach(ROOMY);
  try {
    const answer = sel.select({ title: 'Search Results', items: [], emptyText: 'No anime found for "xyz".' });
    await tick(60);
    const v = assertRegion(term, 'empty');
    assert.match(v.body, /No anime found/, 'the empty message is not on screen');
    keys.type('\u001B');
    assert.equal(await guard(answer, 2000, 'empty answer'), null);
    await handBack();
    assertClean(term, 'empty teardown');
  } finally {
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('a list that shrinks repaints in place instead of leaving a tail', async () => {
  // The failure this guards against: ten rows on screen, then two. The two
  // must replace the ten, not sit underneath them.
  const { term, keys } = attach(ROOMY);
  const f = new Frame({ out: term, input: keys, cursorQuery: true, guard: false });
  const state = { n: 12 };
  const body = Array.from({ length: 12 }, (_, i) => `  Episode ${i + 1}`);
  f.setScreen({ state, render: (s) => ['Pick an episode', ...body.slice(0, s.n), ''] });
  try {
    await f.start();
    f.paint(true);
    await tick(60);
    const tall = assertRegion(term, 'long list', { frame: f });
    assert.ok(tall.height > 6, `the long list only rendered ${tall.height} rows`);
    const top = tall.top;
    const scrolls = term.scrolls;
    // Nine of the twelve go away, one at a time.
    for (let n = 11; n >= 2; n--) {
      state.n = n;
      f.paint();
      await tick(5);
      const v = assertRegion(term, `short list, ${n} rows`, { frame: f });
      assert.equal(v.top, top, `the region moved while shrinking to ${n}`);
      assert.equal(term.scrolls, scrolls, `shrinking to ${n} scrolled the terminal`);
    }
    f.stop();
    await tick(20);
    for (let r = 0; r < term.rows; r++) {
      if (r === term.promptRow) continue;
      assert.equal(term.line(r), '', `the shrunken frame left residue on row ${r}`);
    }
  } finally {
    f.stop();
    sel.endFrame();
    sel.setTerminalHost(null);
  }
});

await ok('the terminal host seam is inert when unused', () => {
  assert.equal(sel.setTerminalHost(null), null, 'clearing the host returns null');
  assert.equal(sel.canSelect(), !!process.stdin.isTTY && !!process.stdout.isTTY, 'the default host is the process');
});

// ---- selection flow (no network) ----------------------------------------
const registry = await import('../src/providers/registry.js');
const flow = await import('../src/tui/flow.js');
await ok('titleLabel/titleHint per lane', () => {
  assert.equal(flow.titleLabel({ kind: 'anime', title: 'Frieren', year: 2023 }), 'Frieren (2023)');
  assert.equal(flow.titleLabel({ kind: 'movie', title: 'Dune' }), 'Dune (?)');
  assert.equal(flow.titleLabel({ kind: 'youtube', title: 'X', duration: 214 }), 'X (3:34)');
  assert.equal(flow.titleLabel({ kind: 'music', title: 'Y' }), 'Y');
  assert.equal(flow.titleHint({ kind: 'anime', format: 'TV', episodes: 28 }), 'TV · 28 eps');
  assert.equal(flow.titleHint({ kind: 'anime' }), '');
  assert.equal(flow.titleHint({ kind: 'movie', rating: 8.13 }), '★ 8.1');
  assert.equal(flow.titleHint({ kind: 'music', author: 'A' }), 'A');
});
await ok('supportsAudioChoice only where dubbing exists', () => {
  const { getProvider } = registry;
  assert.equal(flow.supportsAudioChoice(getProvider('hianime'), { kind: 'anime' }), true);
  assert.equal(flow.supportsAudioChoice(getProvider('flixer'), { kind: 'anime' }), false, 'single-rendition lane');
  assert.equal(flow.supportsAudioChoice(getProvider('hianime'), { kind: 'music' }), false, 'music is not dubbed');
  assert.equal(flow.supportsAudioChoice(getProvider('hianime'), { kind: 'youtube' }), false);
  assert.equal(flow.supportsAudioChoice(null, { kind: 'anime' }), false);
  assert.equal(flow.supportsAudioChoice({ id: 'x', audioModes: false }, { kind: 'movie' }), false);
});
await ok('providerRows puts the default first and tags health', () => {
  const { forKind } = registry;
  const anime = forKind('anime');
  const rows = flow.providerRows(
    { kind: 'anime', defaultProviderId: anime[anime.length - 1].id },
    { health: { [anime[0].id]: { ok: 5, fail: 0, consecFail: 0, lastMs: 100 } }, isBlocked: () => false },
  );
  assert.equal(rows.length, anime.length);
  assert.equal(rows[0].id, anime[anime.length - 1].id, 'the configured default leads');
  assert.match(rows[0].hint, /default/);
  assert.ok(rows.some((r) => r.hint.includes('best')), 'health is surfaced');
  assert.ok(rows.every((r) => typeof r.label === 'string' && r.label.length > 0));
});
await ok('pickAudioMode defaults to sub when not interactive', async () => {
  const { getProvider } = registry;
  assert.equal(await flow.pickAudioMode(getProvider('hianime'), { kind: 'anime' }, { interactive: false }), 'sub');
  assert.equal(await flow.pickAudioMode(getProvider('flixer'), { kind: 'anime' }, { interactive: false }), 'sub');
  assert.equal(await flow.pickAudioMode(getProvider('hianime'), { kind: 'anime' }, { interactive: false, forced: 'dub' }), 'dub');
});
await ok('pickProvider forced rejects a wrong lane', async () => {
  await assert.rejects(() => flow.pickProvider({ kind: 'anime' }, { forced: 'definitely-not-a-provider' }), /Unknown provider/);
  await assert.rejects(() => flow.pickProvider({ kind: 'anime' }, { forced: 'youtube' }), /does not handle anime/);
});
await ok('single-candidate lanes resolve without a screen', async () => {
  const p = await flow.pickProvider({ kind: 'youtube' }, { interactive: false });
  assert.equal(p.id, 'youtube');
  assert.equal(await flow.pickAnimeEpisode({ kind: 'anime', episodes: 2 }, { interactive: false }), 1, 'few episodes need no prompt');
  assert.equal(await flow.pickAnimeEpisode({ kind: 'anime', episodes: 40 }, { interactive: false, forced: 7 }), 7);
  assert.equal(await flow.pickTvSeason({ tmdbId: 1 }, { interactive: false, forced: 3 }), 3);
});

// ---- the "what next?" screen ---------------------------------------------
// The menu and the action that follows it must not each resolve the next
// episode independently: two lookups can disagree, and then the row says one
// thing and playback does another.
await ok('the menu hands its resolved step to the action', () => {
  const body = fs.readFileSync(new URL('../src/playback.js', import.meta.url), 'utf8');
  // postPlayMenu returns the step alongside the answer...
  assert.match(body, /return \{ action, next \};/);
  // ...the loop carries it through untouched...
  assert.match(body, /\(\{ action, next \} = await postPlayMenu\(/);
  assert.match(body, /applyAction\(\{ action, next, media/);
  // ...and the action uses that object instead of looking it up again.
  assert.match(body, /async function applyAction\(\{ action, next,/);
  const applyBody = body.slice(body.indexOf('async function applyAction'));
  assert.ok(!/advanceEpisode\(/.test(applyBody.slice(0, applyBody.indexOf("action === 'prev'"))),
    'no second advanceEpisode lookup before the next row is built');
  // Autoplay goes through the same helper, so the two paths cannot drift.
  assert.match(body, /async function advanceOne\(media, qi\)/);
  const advanceBody = body.slice(body.indexOf('async function advanceOne'));
  assert.match(advanceBody.slice(0, 400), /await advanceEpisode\(media\)/);
  // And an interrupt ends the session rather than asking what is next.
  assert.match(body, /if \(wasInterrupted\(\)\) break;/);
});

// ---- episodic session advance -------------------------------------------
// ani-cli's useful idea is that the session knows where the episode list ends,
// so "next" never walks into an episode that is not there. These pin the
// equivalent: inside a season it is an increment, at a boundary it is a
// bounded lookup, and at the end it says so instead of guessing.
await ok('seasonEpisodeCount knows only what it was told', () => {
  assert.equal(flow.seasonEpisodeCount({ kind: 'anime', episodes: 28 }), 28);
  assert.equal(flow.seasonEpisodeCount({ kind: 'anime', episodes: 0 }), null, 'unknown is null, not 0');
  assert.equal(flow.seasonEpisodeCount({ kind: 'anime' }), null);
  assert.equal(flow.seasonEpisodeCount({ kind: 'tv', seasonEpisodes: 12 }), 12);
  assert.equal(flow.seasonEpisodeCount({ kind: 'tv', totalEpisodes: 8 }), 8);
  assert.equal(flow.seasonEpisodeCount({ kind: 'tv' }), null, 'search results do not carry it');
  assert.equal(flow.seasonEpisodeCount({ kind: 'movie' }), null);
});
await ok('advanceEpisode steps inside a season', async () => {
  const m = { kind: 'anime', anilistId: 21, title: 'F', season: 1, episode: 3, episodes: 28, episodeId: 'x' };
  const next = await flow.advanceEpisode(m);
  assert.equal(next.media.episode, 4);
  assert.equal(next.media.episodeId, undefined, 'the old episode id must not leak into the next one');
  assert.equal(next.media.anilistId, 21, 'the show identity is carried');
  assert.match(next.label, /E4/);
  // TV labels carry the season, so S1E4 does not read as a bare E4.
  const t = await flow.advanceEpisode({ kind: 'tv', tmdbId: 5, season: 1, episode: 3, seasonEpisodes: 12 });
  assert.equal(t.media.episode, 4);
  assert.match(t.label, /S1E4/);
});
await ok('an unknown season length is assumed to have more', async () => {
  // Nothing is known about the length, so the session must not declare the
  // show finished: an honest resolve failure beats a wrong "end of series".
  const next = await flow.advanceEpisode({ kind: 'tv', tmdbId: 5, season: 1, episode: 2 });
  assert.notEqual(next, 'end');
  assert.equal(next.media.episode, 3);
});
await ok('non-episodic lanes have no next episode', async () => {
  assert.equal(await flow.advanceEpisode({ kind: 'movie', tmdbId: 1 }), 'end');
  assert.equal(await flow.advanceEpisode({ kind: 'youtube', videoId: 'x' }), 'end');
  assert.equal(await flow.advanceEpisode({ kind: 'music', videoId: 'x' }), 'end');
});
await ok('advanceEpisode clears the finished season count when it rolls over', async () => {
  // Simulate a later season existing by checking the reset happens on the
  // object we control. A TV lookup that fails must not be mistaken for one.
  const m = { kind: 'anime', anilistId: 21, title: 'F', season: 1, episode: 28, episodes: 28 };
  const next = await flow.advanceEpisode(m);
  // No relations cached and no network here: an unreachable lookup is not
  // proof the show ended, so this must not claim a later season either.
  assert.ok(next === 'end' || next.media.season === 2);
  if (next !== 'end') {
    assert.equal(next.media.episode, 1, 'a new season starts at episode 1');
    assert.match(next.label, /S2E1/);
  }
});
await ok('a season rollover takes the new season\'s own record', () => {
  // A split cour is its own entry with its own length. Inheriting the finished
  // season's 28 into a 10-episode cour would walk the session 18 episodes past
  // the end.
  const finished = { kind: 'anime', anilistId: 21, title: 'Frieren', season: 1, episode: 28, episodes: 28, episodeId: 'ep-28' };
  const cour2 = { anilistId: 22, title: 'Frieren: Beyond Journey\'s End Season 2', season: 2, episodes: 10, year: 2024, format: 'TV' };
  const next = flow.rollOverSeason(finished, cour2, 2);
  assert.equal(next.episode, 1, 'the new season starts at episode 1');
  assert.equal(next.season, 2);
  assert.equal(next.kind, 'anime', 'the lane is preserved');
  assert.equal(next.episodes, 10, "the new season's own count wins");
  assert.notEqual(next.episodes, finished.episodes, 'and it is not the old one');
  assert.equal(flow.seasonEpisodeCount(next), 10, 'the new season knows where ITS end is');
  assert.equal(next.anilistId, 22, 'the new record is the identity, not a copy of the old');
  assert.equal(next.episodeId, undefined, 'the previous episode id is not reused');
  // A TV rollover comes from the season list, which has a count of its own.
  const tv = flow.rollOverSeason({ kind: 'tv', tmdbId: 5, title: 'Daybreak', season: 2, episode: 10, seasonEpisodes: 10 },
    { tmdbId: 5, title: 'Daybreak', season: 3, seasonEpisodes: 8 }, 3);
  assert.equal(tv.kind, 'tv');
  assert.equal(tv.season, 3);
  assert.equal(tv.seasonEpisodes, 8, 'the new season brings its own count');
  assert.notEqual(tv.seasonEpisodes, 10, 'and it is not the finished season\'s');
  assert.equal(flow.seasonEpisodeCount(tv), 8);
  // A season whose length is unknown must read as "there may be more", never
  // as "the show ended".
  const unknown = flow.rollOverSeason({ kind: 'tv', tmdbId: 5, title: 'X', season: 1, episode: 4, seasonEpisodes: 4 },
    { tmdbId: 5, title: 'X', season: 2, seasonEpisodes: null }, 2);
  assert.equal(flow.seasonEpisodeCount(unknown), null, 'an unknown length is not an end');
});

// ---- CLI surface (subprocess) -------------------------------------------
// Guards the argv hand-off end to end: a rewrite that leaves the node
// executable in the arg list must fail here, not on a user's machine.
const CLI = new URL('../src/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// A throwaway HOME so nothing here can read or write real user state.
const CLI_HOME = join(homedir(), 'AppData', 'Local', 'Temp', 'opencode', `fahy-cli-smoke-${process.pid}`);
function runCli(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, USERPROFILE: CLI_HOME, HOME: CLI_HOME },
    });
    assert.equal(expectFail, false, `expected \`fahy ${args.join(' ')}\` to fail`);
    return stdout;
  } catch (e) {
    if (expectFail) return `${e.stdout || ''}${e.stderr || ''}`;
    throw new Error(`${e.stdout || ''}${e.stderr || ''}`.trim() || String(e.message));
  }
}
try {
  await ok('fahy --help lists the five modes and history', () => {
    const out = runCli(['--help']);
    for (const c of ['anime', 'tv', 'movie', 'yt', 'music', 'history', 'clear-history', 'doctor', 'providers', 'version']) {
      assert.ok(new RegExp(`^\\s+${c}\\b`, 'm').test(out), `help is missing \`${c}\``);
    }
    assert.ok(!/interactive shell/i.test(out), 'the removed TUI shell must not be advertised');
  });
  await ok('fahy with no arguments prints examples', () => {
    const out = runCli([]);
    assert.match(out, /Examples:/);
    assert.match(out, /fahy anime "Frieren"/);
  });
  await ok('fahy version prints the package version', () => {
    const out = runCli(['version']).trim();
    assert.match(out, /^\d+\.\d+\.\d+$/);
  });
  await ok('fahy -V matches fahy version', () => {
    assert.equal(runCli(['-V']).trim(), runCli(['version']).trim());
  });
  await ok('every advertised command resolves to a real subcommand', () => {
    const out = runCli(['--help']);
    const names = [...out.matchAll(/^ {2}([a-z][a-z-]*(?:\|[a-z]+)*)\s/gm)].map((m) => m[1].split('|')[0]);
    assert.ok(names.length > 20, `only found ${names.length} commands`);
    for (const n of names) {
      // `help <cmd>` is the cheap way to prove commander knows the name.
      const h = runCli(['help', n]);
      assert.match(h, /Usage: fahy /, `fahy help ${n} did not resolve`);
    }
  });
  await ok('unknown command fails with an actionable line', () => {
    const out = runCli(['definitely-not-a-command'], { expectFail: true });
    assert.match(out, /unknown command/i);
  });
  await ok('unknown option fails instead of being ignored', () => {
    const out = runCli(['anime', 'X', '--nope'], { expectFail: true });
    assert.match(out, /unknown option/i);
  });
  await ok('a bare fahy history on a fresh install is a clean empty state', () => {
    assert.match(runCli(['history']), /No history yet/);
  });
  await ok('legacy --history reaches the history command', () => {
    // The rewrite must not leave the node path where the subcommand goes.
    const out = runCli(['--history']);
    assert.match(out, /No history yet/);
    assert.doesNotMatch(out, /unknown command/i);
  });
  await ok('legacy --list-providers reaches the providers command', () => {
    // Offline-safe end of the legacy path: the rewrite must not leave the node
    // path where the subcommand goes.
    const out = runCli(['--list-providers']);
    assert.match(out, /^hianime\s/m);
    assert.doesNotMatch(out, /unknown command/i);
  });
  await ok('legacy --volume 50 reaches the volume command', () => {
    const out = runCli(['--volume', '55']);
    assert.match(out, /Volume 55/);
    assert.doesNotMatch(out, /unknown command|unknown option/i);
  });
  await ok('legacy --doctor reaches the doctor command', () => {
    const out = runCli(['--doctor']);
    assert.match(out, /mpv:/);
    assert.doesNotMatch(out, /unknown command/i);
  });
  await ok('fahy doctor exits 0 and names the external tools', () => {
    const out = runCli(['doctor']);
    assert.match(out, /mpv:/);
    assert.match(out, /yt-dlp:/);
  });
  await ok('fahy providers lists every source with a lane', () => {
    const out = runCli(['providers']);
    for (const id of ['hianime', 'anikoto', 'anisuge', 'youtube', 'ytmusic', 'lookmovie']) {
      assert.ok(new RegExp(`^${id}\\s`, 'm').test(out), `providers is missing ${id}`);
    }
  });
} finally {
  fs.rmSync(CLI_HOME, { recursive: true, force: true });
}

// ---------- B. live ----------
if (live) {  const meta = await import('../src/metadata.js');
  await ok('LIVE latestVersion semver', async () => {
    const v = await upd.latestVersion({ timeoutMs: 10000 });
    assert.match(v, /^\d+\.\d+\.\d+$/);
  });
  await ok('LIVE searchAnime', async () => {
    const r = await meta.searchAnime('Frieren', 3);
    assert.ok(r.length > 0 && r[0].anilistId);
  });
  await ok('LIVE animeRelations', async () => {
    const r = await meta.animeRelations(154587);
    assert.ok(Array.isArray(r));
  });
  await ok('LIVE ytSearch', async () => {
    const r = await meta.ytSearch('lofi beats', 3);
    assert.ok(r.length > 0 && /^[A-Za-z0-9_-]{11}$/.test(r[0].videoId));
  });
  await ok('LIVE ytMix', async () => {
    const r = await meta.ytMix('dQw4w9WgXcQ', 3);
    assert.ok(r.length > 0);
  });
  const { youtube } = await import('../src/providers/youtube.js');
  await ok('LIVE youtube.search', async () => {
    const r = await youtube.search('lofi beats', {});
    assert.ok(r.length > 0 && r[0].url.startsWith('https://www.youtube.com/watch?v='));
  });
  await ok('LIVE youtube.resolve', async () => {
    const r = await youtube.resolve({ videoId: 'dQw4w9WgXcQ' });
    assert.equal(r.sources[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.ok(!r.sources[0].audioOnly, 'youtube must play WITH video');
  });
  const { ytmusic } = await import('../src/providers/ytmusic.js');
  await ok('LIVE ytmusic.search', async () => {
    const r = await ytmusic.search('bohemian rhapsody', {});
    assert.ok(r.length > 0 && r[0].kind === 'music');
  });
  await ok('LIVE ytmusic.resolve audio-only', async () => {
    const r = await ytmusic.resolve({ videoId: 'fJ9rUzIMcZQ' });
    assert.equal(r.sources[0].audioOnly, true);
    assert.ok(r.sources[0].url.includes('music.youtube.com'));
  });
  await ok('LIVE hianime full chain', async () => {
    const r = await hi.hianime.resolve({ title: 'REBORN!', episode: 1 }, {});
    assert.ok(r.sources.length > 0 && r.sources[0].url.includes('.m3u8'));
    assert.ok(!!r.sources[0].headers?.Referer);
    assert.ok(!r.sources[0].audioOnly, 'anime must play WITH video');
  });
  const { probeUrl } = await import('../src/probe.js');
  await ok('LIVE probe google', async () => {
    const pr = await probeUrl('https://www.google.com', { timeoutMs: 10000 });
    assert.equal(pr.status, 'reachable');
  });
}

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
