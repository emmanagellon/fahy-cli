// npm run smoke — function-by-function system audit (kunai check-suite parity).
// Section A runs offline (pure logic, fixtures). Section B hits live networks.
// Exit 1 on any failure; every check prints PASS/FAIL with its name.
import assert from 'node:assert';

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
      results.push(`  FAIL ${name}: ${e.message.split('\n')[0]}`);
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

const aw = await import('../src/providers/aniwave.js');
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
  assert.ok(reg.forKind('anime').length >= 7);
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
  assert.equal(store.historyToMedia({ title: 'X', kind: 'movie' }), null);
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
  assert.equal(store.shouldAutoPin('aniwave', 'hianime', true), true);
  assert.equal(store.shouldAutoPin('hianime', 'hianime', true), false); // same: no churn
  assert.equal(store.shouldAutoPin('aniwave', 'hianime', false), false); // default works: no churn
  assert.equal(store.shouldAutoPin('aniwave', undefined, true), false);
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
await ok('shell homeItems', async () => {
  const { homeItems } = await import('../src/tui/shell.js');
  const items = homeItems([{ title: 'X', kind: 'anime', episode: 3 }], 'anime');
  assert.deepEqual(items.map((x) => x.value), ['search', 'continue', 'history', 'quit']);
  assert.deepEqual(homeItems([], 'music').map((x) => x.value), ['search', 'history', 'quit']);
});
await ok('shell historyRows progress', async () => {
  const { historyRows } = await import('../src/tui/shell.js');
  const rows = historyRows([
    { title: 'A', kind: 'music', duration: 200, watchedMs: 200000, completed: true },
    { title: 'B', kind: 'music', duration: 200, watchedMs: 100000 },
    { title: 'C', kind: 'anime', episode: 5 },
  ], 0);
  assert.ok(rows[0].label.includes('done') && rows[1].label.includes('50%') && rows[2].label.includes('E5'));
  assert.equal(rows[0].active, true);
});
await ok('shell historyItems ends with clear-all', async () => {
  const { historyItems } = await import('../src/tui/shell.js');
  const items = historyItems([{ title: 'A', kind: 'anime', episode: 1 }], 0);
  assert.equal(items.length, 2);
  assert.equal(items[1].label, 'CLEAR ALL HISTORY');
});
await ok('shell pageWindow', async () => {
  const { pageWindow } = await import('../src/tui/shell.js');
  const eps = Array.from({ length: 45 }, (_, i) => ({ number: i + 1 }));
  const p = pageWindow(eps, 5);
  assert.equal(p.total, 3);
  assert.equal(p.page, 2);
  assert.equal(p.slice[0].number, 41);
});
await ok('shell fmtClock', async () => {
  const { fmtClock } = await import('../src/tui/shell.js');
  assert.equal(fmtClock(65), '1:05');
  assert.equal(fmtClock(3661), '1:01:01');
  assert.equal(fmtClock(null), '--:--');
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
  await ok('no function-locals leak (useTuiShell is module scope)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.ok(/^let useTuiShell/m.test(src), 'useTuiShell must be module-scoped');
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
await ok('shell screen codes (single-page TUI)', async () => {
  const tui = await import('../src/tui/search.js');
  assert.equal(tui.ALT_ENTER, '\x1b[?1049h\x1b[H');
  assert.equal(tui.ALT_LEAVE, '\x1b[?1049l');
  assert.equal(tui.PAGE_CLEAR, '\x1b[2J\x1b[H');
  assert.equal(typeof tui.shellEnter, 'function');
  assert.equal(typeof tui.shellLeave, 'function');
  assert.equal(typeof tui.shellClear, 'function');
});

const src = await import('../src/sources.js');
await ok('fmhy parse anime section', () => {
  const html = '<h3 id="anime-streaming">Anime</h3><ul>'
    + '<li><a href="https://www.miruro.com/">Miruro</a>, <a href="https://discord.gg/x">chat</a></li>'
    + '<li><a href="https://hianime.ad/">HiAnime</a></li></ul>'
    + '<h3 id="cartoon-streaming">Cartoons</h3><a href="https://example.com/">X</a>';
  const r = src.parseFmhyAnimeSection(html);
  assert.deepEqual(r.map((x) => x.host), ['miruro.com', 'hianime.ad']);
});
await ok('fmhy parse missing section throws', () => {
  assert.throws(() => src.parseFmhyAnimeSection('<html></html>'), /FMHY layout changed/);
});
await ok('fmhy parse skips apps subsection (exact id)', () => {
  const html = '<h3 id="anime-streaming-apps">Apps</h3><a href="https://seanime.app/">Seanime</a>'
    + '<h3 id="anime-streaming">Anime</h3><a href="https://www.miruro.com/">Miruro</a>'
    + '<h3 id="cartoon-streaming">Cartoons</h3>';
  const r = src.parseFmhyAnimeSection(html);
  assert.deepEqual(r.map((x) => x.host), ['miruro.com']);
});
await ok('fmhy coverage ok/drift/missing', () => {
  const fmhy = [
    { name: 'Miruro', url: 'https://www.miruro.com/', host: 'miruro.com' },
    { name: 'HiAnime', url: 'https://hianime.ad/', host: 'hianime.ad' },
  ];
  const cov = src.matchCoverage(fmhy, [
    { id: 'miruro', name: 'Miruro', sites: ['https://www.miruro.com'], tokens: ['miruro'] },
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
await ok('TUI provider pick resolves id (not index)', async () => {
  const shell = await import('../src/tui/shell.js');
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  shell.setShellConfig({ defaultProvider: { anime: 'hianime' } });
  const app = render(React.createElement(shell.__ShellFrame));
  await new Promise((r) => setTimeout(r, 300)); // let mount effects attach first:
  // updates before that land on identical initial state, but a changed screen
  // would paint stale with no re-render scheduled (same rule as production).
  const p = shell.__testProviderPick({ title: 'X', kind: 'anime' });
  await new Promise((r) => setTimeout(r, 400));
  app.stdin.write('\r');
  const res = await Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('UI pick timed out')), 10000)),
  ]);
  app.unmount();
  assert.ok(res && res.providerId === 'hianime', `got ${JSON.stringify(res)}`);
  assert.equal(res.media.episode, 1);
});
await ok('TUI episode pager navigates + picks absolute', async () => {
  const shell = await import('../src/tui/shell.js');
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  shell.setShellConfig({ defaultProvider: { anime: 'hianime' } });
  const app = render(React.createElement(shell.__ShellFrame));
  const eps = Array.from({ length: 45 }, (_, i) => ({ number: i + 1 }));
  await new Promise((r) => setTimeout(r, 300)); // mount effects first (see above)
  const p = shell.__testEpisodePick(eps);
  await new Promise((r) => setTimeout(r, 400));
  app.stdin.write('\x1B[B'); // down -> Episode 2
  await new Promise((r) => setTimeout(r, 400));
  app.stdin.write('\r'); // select episode -> provider step
  await new Promise((r) => setTimeout(r, 400));
  app.stdin.write('\r'); // select provider (hianime default)
  const res = await Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('UI pick timed out')), 10000)),
  ]);
  app.unmount();
  assert.ok(res && res.providerId === 'hianime', `got ${JSON.stringify(res)}`);
  assert.equal(res.media.episode, 2);
});
await ok('TUI right-arrow selects like enter', async () => {
  const shell = await import('../src/tui/shell.js');
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  shell.setShellConfig({ defaultProvider: { anime: 'hianime' } });
  const app = render(React.createElement(shell.__ShellFrame));
  await new Promise((r) => setTimeout(r, 300));
  const p = shell.__testProviderPick({ title: 'X', kind: 'anime' });
  await new Promise((r) => setTimeout(r, 400));
  app.stdin.write('\x1B[C'); // → selects highlighted provider
  const res = await Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('UI pick timed out')), 10000)),
  ]);
  app.unmount();
  assert.ok(res && res.providerId === 'hianime', `got ${JSON.stringify(res)}`);
});
await ok('TUI left-arrow backs out of provider step', async () => {
  const shell = await import('../src/tui/shell.js');
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  shell.setShellConfig({ defaultProvider: { anime: 'hianime' } });
  const app = render(React.createElement(shell.__ShellFrame));
  await new Promise((r) => setTimeout(r, 300));
  shell.__testProviderPick({ title: 'X', kind: 'anime' });
  await new Promise((r) => setTimeout(r, 400));
  app.stdin.write('\x1B[D'); // ← back to search input (waiter stays pending)
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(shell.__S.search.step, 'search');
  app.unmount();
});
await ok('TUI s restarts search from menu', async () => {
  const shell = await import('../src/tui/shell.js');
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  const app = render(React.createElement(shell.__ShellFrame));
  await new Promise((r) => setTimeout(r, 300));
  shell.shellMenu('T', [{ label: 'A', value: 'a' }]);
  await new Promise((r) => setTimeout(r, 400));
  app.stdin.write('s');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(shell.__S.route, 'search');
  assert.equal(shell.__S.search.step, 'search');
  app.unmount();
});

// ---------- B. live ----------
if (live) {  const meta = await import('../src/metadata.js');
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
