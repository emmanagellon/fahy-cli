// Persistent chat-style shell (opencode/kunai parity): ONE Ink root for the
// whole session — header, transcript log, status line, screen, footer. Nothing
// ever clears or remounts for loading: async work appends transcript lines or
// updates the single status line (spinner ticks in place). mpv borrows the
// terminal via suspend()/resume() with all state intact, so the identical
// screen returns. Screens: home, search, details, history, menu, error,
// nowplaying. Plain React.createElement only (Ink + whitespace = crash).
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { searchAnime, animeRelations, formatDuration } from '../metadata.js';
import { forKind, getProvider, providerTags } from '../providers/registry.js';
import { getHistory, historyToMedia, getHealth, healthBlocked, clearHistory } from '../store.js';

const e = React.createElement;
export const MODES = ['anime', 'youtube', 'music'];
const EP_LIST_CAP = 300;
const EP_PER_PAGE = 20;
const TRANSCRIPT_CAP = 120;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function modeLabel(m) {
  return m === 'anime' ? 'ANIME' : m === 'youtube' ? 'YOUTUBE' : 'MUSIC';
}

export function short(s, n = 72) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function friendly(err) {
  const m = String(err?.message || err);
  if (/fetch failed/i.test(m)) return 'Network request failed — site may block your region, or you are offline.';
  return m;
}

export function fmtClock(s) {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return '--:--';
  const t = Math.max(0, Math.floor(Number(s)));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const r = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function defaultProviderFor(config, kind) {
  return config.defaultProvider?.[kind] || (kind === 'anime' ? 'hianime' : kind === 'music' ? 'ytmusic' : 'youtube');
}

// ---- external store: survives suspend/resume because it lives outside React ----
function freshSearch(mode) {
  return {
    mode, query: '', results: [], loading: false, error: '',
    step: 'search', busyMsg: '', sel: null, chain: [], epList: [], epPage: 0, episode: '1',
  };
}

const S = {
  mounted: false,
  transcript: [], // {id, kind, text}
  status: null, // {text} | null
  frame: 0,
  route: 'home', // home|search|history|menu|error|nowplaying
  search: freshSearch('anime'),
  uiHi: 0, // shared highlight for list screens
  histHi: 0,
  menu: null, // {title, options}
  errorBox: null, // {message}
  nowPlaying: null, // {player, info, hooks, subs}
  help: false,
  nextId: 1,
};

let notify = null;
let waiter = null;
let searchTimer = null;
let searchToken = 0;
let spinnerTimer = null;

function update() {
  // Calls before mount-effects attach are intentionally dropped: startShell
  // always commits correct initial state, so there is nothing stale to fix.
  // (Tests must await a tick after render() before driving api calls.)
  if (notify) notify();
}

function answer(v) {
  const w = waiter;
  waiter = null;
  if (w) w(v);
}

function ensureSpinner() {
  if (S.status && S.mounted && !spinnerTimer) {
    spinnerTimer = setInterval(() => {
      S.frame += 1;
      update();
    }, 80);
  } else if ((!S.status || !S.mounted) && spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
}

// ---- logging / status (the loading story: lines append, one line spins) ----
export function shellLog(text, kind = 'dim') {
  S.transcript.push({ id: S.nextId++, kind, text: String(text) });
  if (S.transcript.length > TRANSCRIPT_CAP) S.transcript.splice(0, S.transcript.length - TRANSCRIPT_CAP);
  update();
}

export function shellStatus(text) {
  S.status = text == null ? null : { text: String(text) };
  ensureSpinner();
  update();
}

// ---- pure row builders (unit-tested) ----
export function homeItems(history, mode) {
  const items = [{ key: 'search', label: `Search ${modeLabel(mode).toLowerCase()}…`, value: 'search' }];
  if (history.length > 0) {
    const h = history[0];
    items.push({
      key: 'continue',
      label: `Continue  ${short(h.title, 44)}${h.kind === 'anime' && h.episode ? ` E${h.episode}` : ''}`,
      value: 'continue',
    });
  }
  items.push({ key: 'history', label: `History  ${history.length} entr${history.length === 1 ? 'y' : 'ies'}`, value: 'history' });
  items.push({ key: 'quit', label: 'Quit', value: 'quit' });
  return items;
}

export function historyRows(items, hi) {
  return items.map((item, i) => {
    const active = i === Math.min(Math.max(0, hi), items.length - 1);
    const tag = item.kind === 'anime' && item.episode ? ` E${item.episode}` : '';
    const prog = item.duration && item.watchedMs
      ? item.completed ? ' · done' : ` · ${Math.min(99, Math.round((item.watchedMs / 1000 / item.duration) * 100))}%`
      : item.completed ? ' · done' : '';
    return { key: `h-${i}`, active, label: short(`${item.title}${tag}${prog}`, 60) };
  });
}

export function resultRows(results, hi) {
  return results.slice(0, 10).map((r, i) => {
    const active = i === Math.min(hi, results.length - 1);
    const main = r.kind === 'anime'
      ? `${r.title} (${r.year || '?'})`
      : `${r.title}${r.duration ? ` (${formatDuration(r.duration)})` : ''}`;
    const hint = r.kind === 'anime' ? ` ${r.episodes || '?'} eps` : r.author ? ` ${r.author}` : '';
    return { key: `row-${i}`, active, label: short(main, 52), hint: short(hint, 26) };
  });
}

export function pageWindow(epList, epPage) {
  const total = Math.max(1, Math.ceil(epList.length / EP_PER_PAGE));
  const page = Math.min(epPage, total - 1);
  return { total, page, slice: epList.slice(page * EP_PER_PAGE, page * EP_PER_PAGE + EP_PER_PAGE) };
}

// ---- search engine (debounced, token-guarded; results land in store) ----
function runSearch() {
  const st = S.search;
  const q = st.query.trim();
  if (!q) {
    st.results = [];
    st.loading = false;
    st.error = '';
    update();
    return;
  }
  const id = ++searchToken;
  st.loading = true;
  update();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try {
      let r = [];
      if (st.mode === 'anime') {
        r = await searchAnime(q, 10);
      } else if (st.mode === 'youtube') {
        const { youtube } = await import('../providers/youtube.js');
        r = (await youtube.search(q, {})).map((x) => ({ ...x, kind: 'youtube' }));
      } else {
        const { ytmusic } = await import('../providers/ytmusic.js');
        r = await ytmusic.search(q, {});
      }
      if (id !== searchToken) return;
      st.results = r;
      st.hiReset = true;
      st.error = r.length ? '' : 'No results — try another spelling.';
    } catch (e2) {
      if (id !== searchToken) return;
      st.error = friendly(e2);
      st.results = [];
    } finally {
      if (id === searchToken) {
        st.loading = false;
        update();
      }
    }
  }, 350);
}

// ---- shared transitions ----
function cycleMode() {
  const next = MODES[(MODES.indexOf(S.search.mode) + 1) % MODES.length];
  S.search = { ...freshSearch(next), query: S.search.query };
  S.search.error = '';
  S.uiHi = 0;
  update();
  if (S.search.query.trim()) runSearch();
}

function gotoEpisodes(m) {
  const st = S.search;
  const eps = m.episodes || 0;
  if (eps > 1 && eps <= EP_LIST_CAP) {
    st.epList = Array.from({ length: eps }, (_, i) => ({ number: i + 1, name: null }));
    st.epPage = 0;
    st.hiReset = true;
    st.step = 'eplist';
  } else {
    st.step = 'episode';
  }
  S.uiHi = 0;
  update();
}

function startRelationsJob(m) {
  const st = S.search;
  st.step = 'busy';
  st.busyMsg = 'Loading…';
  update();
  (async () => {
    try {
      let rel = [];
      try {
        if (m.anilistId) rel = await animeRelations(m.anilistId);
      } catch {}
      const full = [m, ...rel.filter((r) => r.anilistId !== m.anilistId)];
      full.sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.anilistId - b.anilistId);
      if (st.step !== 'busy') return; // user navigated away mid-flight
      if (full.length > 1) {
        st.chain = full;
        st.step = 'aseason';
      } else {
        gotoEpisodes(m);
        return;
      }
    } catch {
      if (st.step === 'busy') st.step = 'search';
    }
    S.uiHi = 0;
    update();
  })();
}

function pickTitle(m) {
  const st = S.search;
  if (!m) return;
  if (m.kind === 'youtube' || m.kind === 'music') {
    const lanes = forKind(m.kind);
    answer({ media: { ...m, episode: 1 }, providerId: (lanes[0] || getProvider(m.kind === 'music' ? 'ytmusic' : 'youtube')).id });
    return;
  }
  st.sel = m;
  st.episode = '1';
  st.chain = [];
  st.epList = [];
  st.epPage = 0;
  st.hiReset = true;
  startRelationsJob(m);
}

function resumeEntry(entry) {
  const r = historyToMedia(entry);
  if (!r) {
    shellLog('That entry is from a retired lane.', 'warn');
    return;
  }
  const pid = getProvider(r.providerId) ? r.providerId : defaultProviderFor(shellConfig || {}, r.media.kind);
  if (!getProvider(pid)) {
    shellLog('No provider available for that entry.', 'warn');
    return;
  }
  answer({ media: r.media, providerId: pid });
}

function footerFor() {
  if (S.help) return '? / esc close help';
  switch (S.route) {
    case 'home':
      return 'tab switch · ←→↑↓ move · enter open · esc quit · s search · ? help';
    case 'history':
      return '←→↑↓ move · enter resume · esc back · s search';
    case 'menu':
      return '←→↑↓ move · enter select · esc back';
    case 'error':
      return 'any key to continue';
    case 'nowplaying':
      return 'space pause · ←/→ seek · n/p next/prev · +/- vol · m mute · q menu';
    default: {
      const st = S.search.step;
      if (st === 'search') return 'tab switch · ↑↓ navigate · enter select · esc back · ? help';
      if (st === 'busy') return 'working… · esc back';
      if (st === 'episode') return 'type number · enter select · esc back';
      return '←→↑↓ move · enter select · esc back · s search';
    }
  }
}

function helpBox() {
  return e(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    e(Text, { dimColor: true }, 'keys'),
    e(Text, { dimColor: true }, '  tab  switch anime / youtube / music'),
    e(Text, { dimColor: true }, '  ↑↓   move · enter select · esc back / quit'),
    e(Text, { dimColor: true }, '  ←→   back / select in lists (never while typing)'),
    e(Text, { dimColor: true }, '  s    new search from browse screens'),
    e(Text, { dimColor: true }, '  space pause · ←/→ seek (now playing)')
  );
}

function rows(items, hi) {
  return items.map((o, i) => e(
    Box,
    { key: o.key || String(i) },
    e(Text, { color: i === hi ? 'green' : undefined }, i === hi ? '❯ ' : '  '),
    e(Text, { dimColor: i !== hi }, o.label),
    o.hint ? e(Text, { dimColor: true }, ' ' + o.hint) : null
  ));
}

// Home/history/menu/error are single-screen lists driven by S.uiHi.
function listScreen(items, onPick) {
  return e(Box, { flexDirection: 'column' }, e(InnerList, { items, onPick }));
}

// Generic keyboard list. CONTRACT: onPick always receives the ROW index into
// `items` (never item.value) — every call site must resolve items[idx] itself.
// This is what bit us before: two screens assumed value/id and broke.
// `nav` enables ←/→ on pure-list screens (→ picks, ← goes back via the root
// dispatcher). Screens with a focused TextInput or the now-playing seeker
// leave nav off so arrows keep their text/seek meaning.
function InnerList({ items, onPick, nav }) {
  const pickHi = () => Math.min(Math.max(0, S.uiHi), items.length - 1);
  useInput((input, key) => {
    if (!items.length) return;
    if (key.upArrow) {
      S.uiHi = (Math.max(0, S.uiHi) - 1 + items.length) % items.length;
      update();
    } else if (key.downArrow) {
      S.uiHi = (Math.max(0, S.uiHi) + 1) % items.length;
      update();
    } else if (key.return || (nav && key.rightArrow)) {
      onPick(pickHi());
    }
  });
  return e(Box, { flexDirection: 'column' }, ...rows(items, S.uiHi));
}

function renderScreen() {
  if (S.route === 'home') return renderHome();
  if (S.route === 'history') return renderHistory();
  if (S.route === 'menu') return renderMenu();
  if (S.route === 'error') return renderError();
  if (S.route === 'nowplaying') return renderNowPlaying();
  return renderSearch();
}

function renderHome() {
  const history = getHistory().filter((x) => ['anime', 'youtube', 'music'].includes(x.kind)).slice(0, 15);
  const items = homeItems(history, S.search.mode);
  return e(Box, { flexDirection: 'column' }, e(InnerList, {
    items,
    nav: true,
    onPick: (idx) => {
      const item = items[idx];
      if (!item) return;
      if (item.value === 'search') {
        S.route = 'search';
        S.uiHi = 0;
        update();
      } else if (item.value === 'continue' && history[0]) {
        resumeEntry(history[0]);
      } else if (item.value === 'history') {
        S.histHi = 0;
        S.route = 'history';
        update();
      } else if (item.value === 'quit') {
        answer(null);
      }
    },
  }));
}

export function historyItems(history, hi) {
  return [...historyRows(history, hi), { key: 'clear-all', label: 'CLEAR ALL HISTORY' }];
}

function renderHistory() {
  const history = getHistory().filter((x) => ['anime', 'youtube', 'music'].includes(x.kind)).slice(0, 15);
  if (!history.length) return e(Text, { dimColor: true }, 'Nothing watched yet — pick Search.');
  const items = historyItems(history, S.histHi);
  return e(Box, { flexDirection: 'column' }, e(InnerList, {
    items,
    nav: true,
    onHi: undefined,
    onPick: (idx) => {
      if (idx >= history.length) {
        clearHistory();
        S.histHi = 0;
        shellLog('History cleared.', 'ok');
        update();
        return;
      }
      const entry = history[idx];
      if (entry) resumeEntry(entry);
    },
  }));
}

function renderMenu() {
  const m = S.menu;
  if (!m) return null;
  return e(
    Box,
    { flexDirection: 'column' },
    m.title ? e(Text, { dimColor: true }, short(m.title, 60)) : null,
    e(InnerList, {
      items: m.options.map((o, i) => ({ key: String(i), label: o.label, value: o.value })),
      nav: true,
      onPick: (idx) => answer(m.options[idx]?.value ?? null),
    })
  );
}

function renderError() {
  // No in-screen hint here — the frame footer already says it (doubling the
  // line is what produced the stacked "any key to continue" look).
  return e(
    Box,
    { flexDirection: 'column' },
    e(Text, { color: 'red' }, '✕ ' + short(S.errorBox?.message || 'Something failed.', 200))
  );
}

function renderNowPlaying() {
  const np = S.nowPlaying;
  if (!np) return null;
  const { timePos, duration, paused } = np.player.state;
  const frac = duration > 0 && timePos >= 0 ? Math.max(0, Math.min(1, timePos / duration)) : 0;
  const W = 40;
  const fill = Math.round(frac * W);
  return e(
    Box,
    { flexDirection: 'column' },
    e(Text, null, short(String(np.info.title || 'music'), 64)),
    np.info.subtitle ? e(Text, { dimColor: true }, short(String(np.info.subtitle), 64)) : null,
    e(Box, { marginTop: 1 }, e(Text, { color: 'green' }, '━'.repeat(fill) + '─'.repeat(W - fill))),
    e(Text, { dimColor: true }, `${fmtClock(timePos)} / ${fmtClock(duration)}${paused ? ' · paused' : ''}`)
  );
}

function renderSearch() {
  const st = S.search;
  if (st.step === 'search') {
    return e(
      Box,
      { flexDirection: 'column' },
      e(
        Box,
        null,
        e(Text, { dimColor: true }, '› '),
        e(TextInput, {
          value: st.query,
          onChange: (v) => {
            st.query = v;
            st.error = '';
            update();
            runSearch();
          },
          placeholder: 'Search ' + modeLabel(st.mode).toLowerCase() + '...',
        })
      ),
      st.loading ? e(Text, { dimColor: true }, ' …') : null,
      st.error ? e(Text, { color: 'yellow' }, short(st.error, 100)) : null,
      st.results.length > 0
        ? e(Box, { marginTop: 1, flexDirection: 'column' }, e(SearchResults, null))
        : null,
      !st.query && st.results.length === 0
        ? e(Text, { dimColor: true }, 'tab switch · esc back · ? help')
        : null
    );
  }
  if (st.step === 'busy') return e(Text, { dimColor: true }, st.busyMsg || 'Loading…');
  if (st.step === 'aseason') {
    return e(
      Box,
      { flexDirection: 'column' },
      e(Text, { dimColor: true }, 'Season:'),
      e(InnerList, {
        items: st.chain.map((c, i) => ({
          key: String(c.anilistId),
          label: short(c.title + ' (' + (c.year || '?') + ')' + (c.episodes ? ' - ' + c.episodes + ' eps' : '')),
          value: i,
        })),
        nav: true,
        onPick: (idx) => {
          const m = st.chain[idx];
          if (!m) return;
          st.sel = m;
          st.episode = '1';
          gotoEpisodes(m);
        },
      })
    );
  }
  if (st.step === 'eplist') {
    const { total, page, slice } = pageWindow(st.epList, st.epPage);
    const items = slice.map((x, i) => ({ key: String(x.number), label: `Episode ${x.number}`, value: page * EP_PER_PAGE + i }));
    if (page > 0) items.unshift({ key: '__prev', label: '← Prev', value: '__prev' });
    if (page < total - 1) items.push({ key: '__next', label: 'Next →', value: '__next' });
    return e(
      Box,
      { flexDirection: 'column' },
      e(Text, { dimColor: true }, `${short(st.sel?.title || '', 60)}${total > 1 ? `   ${page + 1}/${total}` : ''}`),
      e(InnerList, {
        items,
        nav: true,
        // InnerList reports the ROW index — resolve it to the item first.
        onPick: (rowIdx) => {
          const v = items[rowIdx]?.value;
          if (v === '__prev') {
            st.epPage = page - 1;
            S.uiHi = 0;
            update();
          } else if (v === '__next') {
            st.epPage = page + 1;
            S.uiHi = 0;
            update();
          } else if (typeof v === 'number' && st.epList[v]) {
            st.episode = String(st.epList[v].number);
            st.step = 'provider';
            S.uiHi = 0;
            update();
          }
        },
      })
    );
  }
  if (st.step === 'episode') {
    return e(
      Box,
      { flexDirection: 'column' },
      e(Text, { dimColor: true }, short(st.sel?.title || '', 60)),
      e(
        Box,
        null,
        e(Text, { dimColor: true }, 'episode › '),
        e(TextInput, {
          value: st.episode,
          onChange: (v) => {
            st.episode = v;
            update();
          },
          onSubmit: () => {
            st.step = 'provider';
            S.uiHi = 0;
            update();
          },
        })
      )
    );
  }
  if (st.step === 'provider') {
    const providers = forKind(st.sel?.kind || st.mode);
    const def = shellConfig?.defaultProvider?.[st.sel?.kind || st.mode];
    const ordered = [...providers].sort((a, b) => (a.id === def ? -1 : b.id === def ? 1 : 0));
    // Best-for-you marker comes from observed playback health, refreshed by
    // the daily FMHY watcher + every run — no probes, no waiting.
    const tags = providerTags(ordered, { health: getHealth(), isBlocked: (id) => healthBlocked(id) });
    const tagSuffix = (id) => (tags[id] ? ` · ${tags[id]}` : '');
    return e(
      Box,
      { flexDirection: 'column' },
      e(Text, { dimColor: true }, short(st.sel?.title || '', 60)),
      e(InnerList, {
        items: ordered.map((x) => ({ key: x.id, label: x.name + (x.id === def ? ' (default)' : '') + tagSuffix(x.id), value: x.id })),
        nav: true,
        // InnerList reports the ROW index — map back to the provider id.
        onPick: (rowIdx) => {
          const chosen = ordered[rowIdx];
          if (!chosen) return;
          const sel = st.sel;
          answer({ media: { ...sel, episode: Math.max(1, Number(st.episode) || 1) }, providerId: chosen.id });
        },
      })
    );
  }
  return null;
}

function SearchResults() {
  const st = S.search;
  return e(InnerList, {
    items: st.results.slice(0, 10).map((r, i) => {
      if (r.kind === 'anime') {
        return { key: `a${r.anilistId}-${i}`, label: short(`${r.title} (${r.year || '?'})`), hint: `${r.episodes || '?'} eps`, value: i };
      }
      const dur = r.duration ? ` (${formatDuration(r.duration)})` : '';
      return { key: `y${r.videoId}-${i}`, label: short(`${r.title}${dur}`), hint: short(r.author || '', 30), value: i };
    }),
    onPick: (idx) => pickTitle(st.results[idx]),
  });
}

function nowPlayingKeys(input, key) {
  const np = S.nowPlaying;
  if (!np) return;
  const { player, hooks } = np;
  (async () => {
    try {
      if (input === ' ') await player.togglePause();
      else if (key.leftArrow) await player.seek(-10);
      else if (key.rightArrow) await player.seek(10);
      else if (input === 'n') return answer({ action: 'next' });
      else if (input === 'p') return answer({ action: 'prev' });
      else if (input === '+' || input === '=') {
        const v = Math.min(100, (player.state.volume || 100) + 5);
        await player.setVolume(v);
        if (hooks?.volume) hooks.volume(v);
      } else if (input === '-' || input === '_') {
        const v = Math.max(0, (player.state.volume || 100) - 5);
        await player.setVolume(v);
        if (hooks?.volume) hooks.volume(v);
      } else if (input === 'm') await player.send('cycle', 'mute');
      else if (input === 'q' || key.escape) return answer({ action: 'menu' });
    } catch {}
    update();
  })();
}

// A TextInput owns the arrows on these steps — the lists never see them.
function textEntryActive() {
  return S.route === 'search' && (S.search.step === 'search' || S.search.step === 'episode');
}

// One back-behavior for ESC and ← (nowplaying excluded: arrows seek there).
function goBack() {
  if (S.route === 'home') return answer(null);
  if (S.route === 'history') {
    S.route = 'home';
    S.uiHi = 0;
    update();
    return;
  }
  if (S.route === 'menu') return answer(null);
  if (S.route === 'search') {
    if (S.search.step !== 'search') {
      S.search.step = 'search';
      S.uiHi = 0;
      update();
    } else {
      S.route = 'home';
      S.uiHi = 0;
      update();
    }
    return;
  }
  if (S.route === 'error') return answer(null);
}

// ---- single root dispatcher (replaces per-component useInput) ----
function ShellKeys() {
  const { exit } = useApp();
  void exit;
  useInput((input, key) => {
    if (input === '?' && (S.route === 'home' || S.route === 'search' || S.route === 'history')) {
      S.help = !S.help;
      update();
      return;
    }
    if (S.help && (key.escape || input === '?')) {
      S.help = false;
      update();
      return;
    }
    if (S.help) return;
    if (key.tab && (S.route === 'home' || S.route === 'search')) {
      cycleMode();
      return;
    }
    if (key.escape) {
      goBack();
      return;
    }
    // ← mirrors ESC everywhere except text inputs and now-playing.
    if (key.leftArrow && !textEntryActive() && S.route !== 'nowplaying') {
      goBack();
      return;
    }
    // `s` restarts search from browse screens (never while typing).
    if (input === 's' && !textEntryActive()) {
      const st = S.search.step;
      if (
        S.route === 'home' || S.route === 'history' || S.route === 'menu' ||
        (S.route === 'search' && (st === 'aseason' || st === 'eplist' || st === 'provider'))
      ) {
        S.route = 'search';
        Object.assign(S.search, { step: 'search', query: '', results: [], loading: false, error: '' });
        S.uiHi = 0;
        update();
        return;
      }
    }
    if (S.route === 'home' || S.route === 'history' || S.route === 'menu') {
      // InnerList handles arrows/enter; ESC/← handled above.
      return;
    }
    if (S.route === 'search') {
      // Search-step keys live in the components (TextInput + InnerList).
      return;
    }
    if (S.route === 'error') return answer(null); // any key continues
    if (S.route === 'nowplaying') nowPlayingKeys(input, key);
  });
  return null;
}

function ShellFrame({ config }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    notify = () => setTick((t) => t + 1);
    ensureSpinner();
    return () => {
      notify = null;
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
    };
  }, []);
  const tabs = MODES.map((m) =>
    m === S.search.mode ? `[${modeLabel(m).toLowerCase()}]` : ` ${modeLabel(m).toLowerCase()} `
  ).join('·');
  const crumb = S.route === 'home' ? 'home' : S.route === 'history' ? 'history'
    : S.route === 'menu' ? 'menu' : S.route === 'error' ? 'error'
    : S.route === 'nowplaying' ? 'now playing'
    : S.search.step === 'search' ? 'search' : 'details';
  return e(
    Box,
    { flexDirection: 'column' },
    e(
      Box,
      { marginBottom: 1 },
      e(Text, { bold: true }, 'fahy'),
      e(Text, { dimColor: true }, '  ' + tabs + `   ${crumb}`)
    ),
    e(
      Box,
      { flexDirection: 'column' },
      ...S.transcript.map((l) => e(Text, { key: l.id, dimColor: l.kind !== 'error' && l.kind !== 'warn', color: l.kind === 'error' ? 'red' : l.kind === 'warn' ? 'yellow' : undefined }, short(l.text, 110)))
    ),
    S.status
      ? e(Box, null, e(Text, { color: 'green' }, SPINNER[S.frame % SPINNER.length] + ' '), e(Text, { dimColor: true }, short(S.status.text, 100)))
      : null,
    e(ShellKeys, null),
    renderScreen(),
    S.help ? helpBox() : null,
    e(Box, { marginTop: 1 }, e(Text, { dimColor: true }, footerFor()))
  );
}

// ---- test seams (kunai __testing parity): drive screens headless ----
export const __S = S;
// ---- test seams (kunai __testing parity): drive screens headless ----
export { ShellFrame as __ShellFrame };

export function __testProviderPick(sel) {
  S.route = 'search';
  Object.assign(S.search, { mode: 'anime', step: 'provider', sel, episode: '1' });
  S.uiHi = 0;
  update();
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

export function __testEpisodePick(epList) {
  S.route = 'search';
  Object.assign(S.search, {
    mode: 'anime', step: 'eplist', sel: { title: 'X', kind: 'anime' },
    epList, epPage: 0, episode: '1',
  });
  S.uiHi = 0;
  update();
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

// ---- public api (promise per interaction; mount-wide state persists) ----
let instance = null;
let shellCfg = null;

export function shellActive() {
  return !!instance;
}

export function startShell(initialMode) {
  S.transcript = [];
  S.status = null;
  S.frame = 0;
  S.route = 'home';
  S.search = freshSearch(MODES.includes(initialMode) ? initialMode : 'anime');
  S.uiHi = 0;
  S.histHi = 0;
  S.menu = null;
  S.errorBox = null;
  S.nowPlaying = null;
  S.help = false;
  S.nextId = 1;
  S.mounted = true;
  shellEnter();
  pageClear();
  instance = render(e(ShellFrame, null));
  ensureSpinner();
}

export function stopShell() {
  const inst = instance;
  instance = null;
  S.mounted = false;
  waiter = null;
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  clearTimeout(searchTimer);
  try {
    inst?.unmount();
  } catch {}
  shellLeave();
}

export function suspendShell() {
  const inst = instance;
  instance = null;
  S.mounted = false;
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  try {
    inst?.unmount();
  } catch {}
}

export function resumeShell() {
  if (instance) return;
  S.mounted = true;
  pageClear(); // wipe the pre-mpv frame so only the fresh screen shows
  instance = render(e(ShellFrame, null));
  ensureSpinner();
}

let shellConfig = null;
export function setShellConfig(c) {
  shellConfig = c;
}

export function shellSearch(opts = {}) {
  S.route = opts.home === false ? 'search' : 'home';
  S.uiHi = 0;
  S.histHi = 0;
  update();
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

export function shellMenu(title, options) {
  S.route = 'menu';
  S.menu = { title, options, hi: 0 };
  S.uiHi = 0;
  update();
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

export function shellError(message) {
  S.route = 'error';
  S.errorBox = { message: String(message || 'Something failed.').slice(0, 300) };
  update();
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

export function shellNowPlaying(player, info = {}, hooks = {}) {
  S.route = 'nowplaying';
  const bump = () => update();
  const onEnd = (reason) => finishNowPlaying(reason === 'eof' ? { action: 'ended' } : { action: 'failed', reason });
  player.on('state', bump);
  player.on('end-file', onEnd);
  S.nowPlaying = { player, info, hooks, subs: { bump, onEnd } };
  update();
  return new Promise((resolve) => {
    waiter = (v) => {
      const np = S.nowPlaying;
      if (np) {
        try {
          np.player.off('state', np.subs.bump);
          np.player.off('end-file', np.subs.onEnd);
        } catch {}
      }
      S.nowPlaying = null;
      resolve(v);
    };
  });
}

function finishNowPlaying(v) {
  const w = waiter;
  waiter = null;
  const np = S.nowPlaying;
  S.nowPlaying = null;
  if (np) {
    try {
      np.player.off('state', np.subs.bump);
      np.player.off('end-file', np.subs.onEnd);
    } catch {}
  }
  if (w) w(v);
}

// alt-screen: the session never touches user scrollback.
export function shellEnter() {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\x1b[?1049h\x1b[H');
  if (!shellEnter.hooked) {
    shellEnter.hooked = true;
    process.on('exit', () => {
      try {
        process.stdout.write('\x1b[?1049l');
      } catch {}
    });
  }
}

// A remount paints BELOW whatever pixels the unmount left behind (unmount
// stops rendering but erases nothing), so every (re)mount starts from a
// cleared page — otherwise the pre-mpv screen and the new screen stack up
// visibly, which is exactly the doubled-screen bug.
export function pageClear() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
}

export function shellLeave() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?1049l');
}
