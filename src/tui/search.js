// Persistent fullscreen shell (kunai/ym-style): one minimalist layout for the
// whole session — HOME landing page, SEARCH, DETAILS, HISTORY. It unmounts
// while mpv owns the terminal, then remounts with state intact, so the screen
// never "moves". Errors render inline; quit only via ESC / Quit.
// Plain React.createElement only — Ink crashes on whitespace text nodes.
import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import { searchAnime, animeRelations, formatDuration } from '../metadata.js';
import { forKind, getProvider } from '../providers/registry.js';
import { getHistory, historyToMedia, removeHistory, clearHistory } from '../store.js';

const e = React.createElement;
const MODES = ['anime', 'youtube', 'music'];
const EP_LIST_CAP = 300;
const EP_PER_PAGE = 20;

// Session-persistent search state: remounts after mpv restore the same screen.
const persist = {
  mode: null,
  byMode: { anime: { query: '', results: [] }, youtube: { query: '', results: [] }, music: { query: '', results: [] } },
};

function modeLabel(m) {
  return m === 'anime' ? 'ANIME' : m === 'youtube' ? 'YOUTUBE' : 'MUSIC';
}

function short(s, n = 72) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function friendly(err) {
  const m = String(err?.message || err);
  if (/fetch failed/i.test(m)) return 'Network request failed — site may block your region, or you are offline.';
  return m;
}

function defaultProviderFor(config, kind) {
  return config.defaultProvider?.[kind] || (kind === 'anime' ? 'hianime' : kind === 'music' ? 'ytmusic' : 'youtube');
}

function SearchApp({ config, initialMode, onDone }) {
  const { exit } = useApp();
  const [mode, setMode] = useState(MODES.includes(initialMode) ? initialMode : persist.mode && MODES.includes(persist.mode) ? persist.mode : 'anime');
  const [route, setRoute] = useState('home'); // home|search|history + detail steps below
  const [showHelp, setShowHelp] = useState(false);
  const [histHi, setHistHi] = useState(0);
  const [histVer, setHistVer] = useState(0); // bump to re-read history.json after delete
  const [histMsg, setHistMsg] = useState('');
  const [homeMsg, setHomeMsg] = useState('');
  const [query, setQuery] = useState(() => {
    const m = MODES.includes(initialMode) ? initialMode : MODES.includes(persist.mode) ? persist.mode : 'anime';
    return (persist.byMode[m] || {}).query || '';
  });
  const [results, setResults] = useState(() => {
    const m = MODES.includes(initialMode) ? initialMode : MODES.includes(persist.mode) ? persist.mode : 'anime';
    return (persist.byMode[m] || {}).results || [];
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState('search'); // search|busy|aseason|episode|eplist|provider
  const [busyMsg, setBusyMsg] = useState('');
  const [sel, setSel] = useState(null);
  const [chain, setChain] = useState([]);
  const [epList, setEpList] = useState([]);
  const [epPage, setEpPage] = useState(0);
  const [episode, setEpisode] = useState('1');
  const seq = useRef(0);
  const pending = useRef(null);

  const quit = () => {
    exit();
    onDone(null);
  };

  const submitPlay = (media, providerId) => {
    exit();
    onDone({ media, providerId });
  };

  const resumeEntry = (entry) => {
    const r = historyToMedia(entry);
    if (!r) {
      setHomeMsg('That entry is from a retired lane.');
      return;
    }
    const pid = getProvider(r.providerId) ? r.providerId : defaultProviderFor(config, r.media.kind);
    if (!getProvider(pid)) {
      setHomeMsg('No provider available for that entry.');
      return;
    }
    submitPlay(r.media, pid);
  };

  // Global keys: TAB cycles mode, ? help, ESC back/quit.
  useInput((input, key) => {
    if (input === '?' && (route === 'home' || route === 'search' || route === 'history')) {
      setShowHelp((v) => !v);
      return;
    }
    if (showHelp && (key.escape || input === '?')) {
      setShowHelp(false);
      return;
    }
    if (showHelp) return;
    if (key.tab && (route === 'home' || route === 'search')) {
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      persist.mode = next;
      persist.byMode[mode] = { query, results };
      setMode(next);
      setQuery((persist.byMode[next] || {}).query || '');
      setResults((persist.byMode[next] || {}).results || []);
      setError('');
      return;
    }
    if (key.escape) {
      if (route === 'history') setRoute('home');
      else if (route === 'search' && step !== 'search' && step !== 'busy') setStep('search');
      else if (route === 'search' || route === 'home') quit();
    }
  });

  // Debounced live search.
  useEffect(() => {
    if (route !== 'search' || step !== 'search') return;
    const q = query.trim();
    persist.mode = mode;
    persist.byMode[mode] = { query, results };
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        let r = [];
        if (mode === 'anime') {
          r = await searchAnime(q, 10);
        } else if (mode === 'youtube') {
          const { youtube } = await import('../providers/youtube.js');
          r = (await youtube.search(q, {})).map((x) => ({ ...x, kind: 'youtube' }));
        } else {
          const { ytmusic } = await import('../providers/ytmusic.js');
          r = await ytmusic.search(q, {});
        }
        if (id === seq.current) {
          setResults(r);
          persist.byMode[mode] = { query: q, results: r };
          setError(r.length ? '' : 'No results — try another spelling.');
        }
      } catch (e2) {
        if (id === seq.current) {
          setError(friendly(e2));
          setResults([]);
        }
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, mode, step, route]); // eslint-disable-line react-hooks/exhaustive-deps

  // Runs one async transition (busy screen) then moves to the next step.
  useEffect(() => {
    if (step !== 'busy' || !pending.current) return;
    const job = pending.current;
    pending.current = null;
    job().catch((e2) => {
      setError(friendly(e2));
      setStep('search');
    });
  }, [step]);

  const runBusy = (msg, job) => {
    setBusyMsg(msg);
    pending.current = job;
    setStep('busy');
  };

  const gotoEpisodes = (m) => {
    const eps = m.episodes || 0;
    if (eps > 1 && eps <= EP_LIST_CAP) {
      setEpList(Array.from({ length: eps }, (_, i) => ({ number: i + 1, name: null })));
      setEpPage(0);
      setStep('eplist');
    } else {
      setStep('episode');
    }
  };

  const chooseTitle = (item) => {
    const m = results[item.value];
    if (!m) return;
    if (m.kind === 'youtube' || m.kind === 'music') {
      const lanes = forKind(m.kind);
      const lane = lanes[0] || getProvider(m.kind === 'music' ? 'ytmusic' : 'youtube');
      if (!lane) {
        setError('No provider available for this kind.');
        return;
      }
      submitPlay({ ...m, episode: 1 }, lane.id);
      return;
    }
    setSel(m);
    setEpisode('1');
    setChain([]);
    setEpList([]);
    setEpPage(0);
    // Season picker via prequel/sequel relations (best-effort, skipped on failure).
    runBusy('Loading…', async () => {
      let rel = [];
      try {
        if (m.anilistId) rel = await animeRelations(m.anilistId);
      } catch {}
      const full = [m, ...rel.filter((r) => r.anilistId !== m.anilistId)];
      full.sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.anilistId - b.anilistId);
      if (full.length > 1) {
        setChain(full);
        setStep('aseason');
      } else {
        gotoEpisodes(m);
      }
    });
  };

  const chooseAnimeSeason = (item) => {
    const m = chain[item.value];
    if (!m) return;
    setSel(m);
    setEpisode('1');
    gotoEpisodes(m);
  };

  const chooseEpisode = (item) => {
    const ep = epList[item.value];
    if (!ep || typeof item.value !== 'number') return;
    setEpisode(String(ep.number));
    setStep('provider');
  };

  const providers = forKind(sel?.kind || mode);
  const def = config.defaultProvider?.[sel?.kind || mode];
  const ordered = [...providers].sort((a, b) => (a.id === def ? -1 : b.id === def ? 1 : 0));

  const submitProvider = (item) => {
    submitPlay(
      { ...sel, episode: Math.max(1, Number(episode) || 1) },
      item.value
    );
  };

  // ---- home + history data (read fresh each render; plain JSON reads) ----
  void histVer;
  const allHistory = getHistory();
  const history = allHistory.filter((x) => ['anime', 'youtube', 'music'].includes(x.kind)).slice(0, 15);
  const homeItems = [
    { key: 'search', label: `Search ${modeLabel(mode).toLowerCase()}…`, value: 'search' },
    ...(history.length > 0
      ? [{ key: 'continue', label: `Continue  ${short(history[0].title, 44)}${history[0].kind === 'anime' && history[0].episode ? ` E${history[0].episode}` : ''}`, value: 'continue' }]
      : []),
    { key: 'history', label: `History  ${allHistory.length} entries`, value: 'history' },
    { key: 'quit', label: 'Quit', value: 'quit' },
  ];

  const tabs = MODES.map((m) =>
    m === mode ? `[${modeLabel(m).toLowerCase()}]` : ` ${modeLabel(m).toLowerCase()} `
  ).join('·');

  const header = (crumb) => e(
    Box,
    { marginBottom: 1 },
    e(Text, { bold: true }, 'fahy'),
    e(Text, { dimColor: true }, '  ' + tabs + (crumb ? `   ${crumb}` : ''))
  );

  const helpBox = showHelp
    ? e(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        e(Text, { dimColor: true }, 'keys'),
        e(Text, { dimColor: true }, '  tab  switch anime / youtube / music'),
        e(Text, { dimColor: true }, '  ↑↓   move · enter select · esc back / quit'),
        e(Text, { dimColor: true }, '  x    delete history entry · X clear all (history screen)'),
        e(Text, { dimColor: true }, '  ?    close this help')
      )
    : null;

  let body = null;
  let footer = null;
  if (route === 'home') {
    body = e(
      Box,
      { flexDirection: 'column' },
      e(SelectInput, {
        items: homeItems.map((o, i) => ({ key: o.key, label: o.label, value: o.value })),
        onSelect: (item) => {
          if (item.value === 'search') {
            setRoute('search');
          } else if (item.value === 'continue' && history[0]) {
            resumeEntry(history[0]);
          } else if (item.value === 'history') {
            setHistHi(0);
            setHistMsg('');
            setRoute('history');
          } else if (item.value === 'quit') {
            quit();
          }
        },
      }),
      homeMsg ? e(Box, { marginTop: 1 }, e(Text, { color: 'yellow' }, short(homeMsg, 80))) : null,
      helpBox
    );
    footer = e(Text, { dimColor: true }, 'tab switch · ↑↓ navigate · enter open · esc quit · ? help');
  } else if (route === 'history') {
    const deleteEntry = (entry) => {
      if (!entry?.url) return;
      removeHistory([entry.url]);
      setHistMsg(`Deleted: ${short(entry.title, 50)}`);
      setHistHi((hi) => Math.max(0, Math.min(hi, history.length - 2)));
      setHistVer((v) => v + 1);
    };
    const clearAllHistory = () => {
      clearHistory();
      setHistMsg('History cleared.');
      setHistHi(0);
      setHistVer((v) => v + 1);
    };
    body = e(
      Box,
      { flexDirection: 'column' },
      history.length
        ? e(HistoryList, {
            items: history,
            hi: histHi,
            onHi: setHistHi,
            onPick: (entry) => resumeEntry(entry),
            onDelete: deleteEntry,
            onClear: clearAllHistory,
          })
        : e(Text, { dimColor: true }, 'Nothing watched yet — pick Search.'),
      histMsg ? e(Box, { marginTop: 1 }, e(Text, { color: 'green' }, short(histMsg, 80))) : null,
      helpBox
    );
    footer = e(Text, { dimColor: true }, '↑↓ navigate · enter resume · x delete · X clear all · esc back · ? help');
  } else if (step === 'search') {
    body = e(
      Box,
      { flexDirection: 'column' },
      e(
        Box,
        null,
        e(Text, { dimColor: true }, '› '),
        e(TextInput, {
          value: query,
          onChange: setQuery,
          placeholder: 'Search ' + modeLabel(mode).toLowerCase() + '...',
        })
      ),
      loading ? e(Text, { dimColor: true }, ' …') : null,
      error ? e(Text, { color: 'yellow' }, short(error, 100)) : null,
      results.length > 0
        ? e(
            Box,
            { marginTop: 1, flexDirection: 'column' },
            e(SelectInput, {
              items: results.slice(0, 10).map((r, i) => {
                if (r.kind === 'anime') {
                  return { key: `a${r.anilistId}-${i}`, label: short(`${r.title} (${r.year || '?'})`), hint: `${r.episodes || '?'} eps`, value: i };
                }
                const dur = r.duration ? ` (${formatDuration(r.duration)})` : '';
                return { key: `y${r.videoId}-${i}`, label: short(`${r.title}${dur}`), hint: short(r.author || '', 30), value: i };
              }),
              onSelect: chooseTitle,
            })
          )
        : null,
      !query && results.length === 0
        ? e(Text, { dimColor: true }, 'tab switch · esc back · ? help')
        : null,
      helpBox
    );
    footer = e(Text, { dimColor: true }, 'tab switch · ↑↓ navigate · enter select · esc back · ? help');
  } else if (step === 'busy') {
    body = e(Text, { dimColor: true }, busyMsg);
    footer = e(Text, { dimColor: true }, 'esc quit');
  } else if (step === 'aseason') {
    body = e(
      Box,
      { flexDirection: 'column' },
      e(Text, { dimColor: true }, 'Season:'),
      e(SelectInput, {
        items: chain.map((c, i) => ({
          key: String(c.anilistId),
          label: short(c.title + ' (' + (c.year || '?') + ')' + (c.episodes ? ' - ' + c.episodes + ' eps' : '')),
          value: i,
        })),
        onSelect: chooseAnimeSeason,
      })
    );
    footer = e(Text, { dimColor: true }, '↑↓ navigate · enter select · esc back');
  } else if (step === 'eplist') {
    const total = Math.max(1, Math.ceil(epList.length / EP_PER_PAGE));
    const page = Math.min(epPage, total - 1);
    const slice = epList.slice(page * EP_PER_PAGE, page * EP_PER_PAGE + EP_PER_PAGE);
    const items = slice.map((x, i) => ({
      key: String(x.number),
      label: `Episode ${x.number}`,
      value: page * EP_PER_PAGE + i,
    }));
    if (page > 0) items.unshift({ key: '__prev', label: '← Prev', value: '__prev' });
    if (page < total - 1) items.push({ key: '__next', label: 'Next →', value: '__next' });
    const onPick = (item) => {
      if (item.value === '__prev') {
        setEpPage(page - 1);
        return;
      }
      if (item.value === '__next') {
        setEpPage(page + 1);
        return;
      }
      chooseEpisode(item);
    };
    body = e(
      Box,
      { flexDirection: 'column' },
      e(Text, { dimColor: true }, `${short(sel.title, 60)}${total > 1 ? `   ${page + 1}/${total}` : ''}`),
      e(SelectInput, { items, onSelect: onPick })
    );
    footer = e(Text, { dimColor: true }, '↑↓ navigate · enter select · esc back');
  } else if (step === 'episode') {
    body = e(
      Box,
      { flexDirection: 'column' },
      e(Text, { dimColor: true }, short(sel.title, 60)),
      e(
        Box,
        null,
        e(Text, { dimColor: true }, 'episode › '),
        e(TextInput, { value: episode, onChange: setEpisode, onSubmit: () => setStep('provider') })
      )
    );
    footer = e(Text, { dimColor: true }, 'type number · enter select · esc back');
  } else if (step === 'provider') {
    body = ordered.length
      ? e(
        Box,
        { flexDirection: 'column' },
        e(Text, { dimColor: true }, short(sel.title, 60)),
        e(SelectInput, {
          items: ordered.map((x) => ({
            key: x.id,
            label: x.name + (x.id === def ? ' (default)' : ''),
            value: x.id,
          })),
          onSelect: submitProvider,
        })
      )
      : e(Text, { color: 'yellow' }, 'No providers for this kind (esc to go back).');
    footer = e(Text, { dimColor: true }, '↑↓ navigate · enter play · esc back');
  }

  const crumb = route === 'home' ? 'home' : route === 'history' ? 'history' : step === 'search' ? 'search' : 'details';
  return e(
    Box,
    { flexDirection: 'column' },
    header(crumb),
    body,
    footer ? e(Box, { marginTop: 1 }, footer) : null
  );
}

// History browser: pick an entry to resume, x deletes one, X clears all.
function HistoryList({ items, hi, onHi, onPick, onDelete, onClear }) {
  useInput((input, key) => {
    if (!items.length) return;
    if (key.upArrow) onHi((Math.max(0, hi) - 1 + items.length) % items.length);
    else if (key.downArrow) onHi((Math.max(0, hi) + 1) % items.length);
    else if (key.return) {
      const entry = items[Math.min(Math.max(0, hi), items.length - 1)];
      if (entry) onPick(entry);
    } else if (input === 'X' && onClear) {
      onClear();
    } else if ((input === 'x' || input === 'd' || key.backspace || key.delete) && onDelete) {
      const entry = items[Math.min(Math.max(0, hi), items.length - 1)];
      if (entry) onDelete(entry);
    } else if (key.escape) {
      // handled globally (back to home)
    }
  });
  const rows = items.map((item, i) => {
    const active = i === Math.min(Math.max(0, hi), items.length - 1);
    const tag = item.kind === 'anime' && item.episode ? ` E${item.episode}` : '';
    const prog = item.duration && item.watchedMs
      ? item.completed ? ' · done' : ` · ${Math.min(99, Math.round((item.watchedMs / 1000 / item.duration) * 100))}%`
      : item.completed ? ' · done' : '';
    return e(
      Box,
      { key: `h-${i}` },
      e(Text, { color: active ? 'green' : undefined }, active ? '❯ ' : '  '),
      e(Text, { dimColor: !active }, short(`${item.title}${tag}${prog}`, 60))
    );
  });
  return e(Box, { flexDirection: 'column' }, ...rows);
}

// Minimalist menu screen: same shell chrome, options list, ESC quits.
// Single-page shell: the whole session lives on the terminal's alternate
// screen buffer, and every screen starts from a cleared page — frames and
// logs never accumulate in the user's scrollback. shellLeave() restores the
// user's terminal exactly as it was (only the `fahy` command line remains).
export const ALT_ENTER = '\x1b[?1049h\x1b[H';
export const ALT_LEAVE = '\x1b[?1049l';
export const PAGE_CLEAR = '\x1b[2J\x1b[H';
let shellHooks = false;
export function shellEnter() {
  if (!process.stdout.isTTY) return;
  process.stdout.write(ALT_ENTER);
  // Backstop: if the process dies on the alt screen through a path that
  // skips shellLeave(), still hand the terminal back on the way out.
  if (!shellHooks) {
    shellHooks = true;
    process.on('exit', () => {
      try { process.stdout.write(ALT_LEAVE); } catch {}
    });
  }
}
export function shellLeave() {
  if (process.stdout.isTTY) process.stdout.write(ALT_LEAVE);
}
export function shellClear() {
  if (process.stdout.isTTY) process.stdout.write(PAGE_CLEAR);
}

export function tuiMenu(title, options) {
  shellClear();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        instance.unmount();
      } catch {}
      resolve(v);
    };
    const Menu = () => {
      const { exit } = useApp();
      useInput((input, key) => {
        if (key.escape) {
          exit();
          finish(null);
        }
      });
      return e(
        Box,
        { flexDirection: 'column' },
        e(Box, { marginBottom: 1 }, e(Text, { bold: true }, 'fahy'), title ? e(Text, { dimColor: true }, '  ' + String(title).slice(0, 60)) : null),
        e(SelectInput, {
          items: options.map((o, i) => ({ key: String(i), label: o.label, value: o.value })),
          onSelect: (item) => {
            exit();
            finish(item.value);
          },
        }),
        e(Box, { marginTop: 1 }, e(Text, { dimColor: true }, '↑↓ navigate · enter select · esc quit'))
      );
    };
    const instance = render(e(Menu));
    instance.waitUntilExit().then(() => finish(null)).catch(() => finish(null));
  });
}

// Minimalist error screen: message stays IN the shell, ENTER continues.
export function tuiError(message) {
  shellClear();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        instance.unmount();
      } catch {}
      resolve();
    };
    const Err = () => {
      const { exit } = useApp();
      useInput(() => {
        exit();
        finish();
      });
      return e(
        Box,
        { flexDirection: 'column' },
        e(Box, { marginBottom: 1 }, e(Text, { bold: true }, 'fahy')),
        e(Text, { color: 'red' }, '✕ ' + String(message || 'Something failed.').slice(0, 200)),
        e(Box, { marginTop: 1 }, e(Text, { dimColor: true }, 'any key to continue'))
      );
    };
    const instance = render(e(Err));
    instance.waitUntilExit().then(() => finish()).catch(() => finish());
  });
}

export function runSearchTui({ config, initialMode }) {
  shellClear();
  return new Promise((resolve) => {
    let done = false;
    const instance = render(e(SearchApp, { config, initialMode, onDone: finish }));
    function finish(res) {
      if (done) return;
      done = true;
      try {
        instance.unmount();
      } catch {}
      resolve(res);
    }
    instance.waitUntilExit().then(() => finish(null)).catch(() => finish(null));
  });
}

// Now Playing screen (ym-style): live progress from the music daemon.
// Resolves menu|next|prev on keys, ended on natural finish, failed on error.
export function tuiNowPlaying(player, info = {}, hooks = {}) {
  shellClear();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        instance.unmount();
      } catch {}
      resolve(v);
    };
    const fmt = (s) => {
      if (s === null || s === undefined || !Number.isFinite(Number(s))) return '--:--';
      const t = Math.max(0, Math.floor(Number(s)));
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const r = t % 60;
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
    };
    const NowPlaying = () => {
      const { exit } = useApp();
      const [, setTick] = useState(0);
      useEffect(() => {
        const bump = () => setTick((t) => t + 1);
        const onEnd = (reason) => {
          exit();
          finish(reason === 'eof' ? { action: 'ended' } : { action: 'failed', reason });
        };
        player.on('state', bump);
        player.on('end-file', onEnd);
        return () => {
          player.off('state', bump);
          player.off('end-file', onEnd);
        };
      }, []);
      useInput((input, key) => {
        (async () => {
          try {
            if (input === ' ') await player.togglePause();
            else if (key.leftArrow) await player.seek(-10);
            else if (key.rightArrow) await player.seek(10);
            else if (input === 'n') {
              exit();
              finish({ action: 'next' });
            } else if (input === 'p') {
              exit();
              finish({ action: 'prev' });
            } else if (input === '+' || input === '=') {
              const v = Math.min(100, (player.state.volume || 100) + 5);
              await player.setVolume(v);
              if (hooks.volume) hooks.volume(v);
            } else if (input === '-' || input === '_') {
              const v = Math.max(0, (player.state.volume || 100) - 5);
              await player.setVolume(v);
              if (hooks.volume) hooks.volume(v);
            } else if (input === 'm') {
              await player.send('cycle', 'mute');
            } else if (input === 'q' || key.escape) {
              exit();
              finish({ action: 'menu' });
            }
          } catch {}
        })();
      });
      const { timePos, duration, paused } = player.state;
      const frac = duration > 0 && timePos >= 0 ? Math.max(0, Math.min(1, timePos / duration)) : 0;
      const W = 40;
      const fill = Math.round(frac * W);
      const bar = '━'.repeat(fill) + '─'.repeat(W - fill);
      return e(
        Box,
        { flexDirection: 'column' },
        e(Box, { marginBottom: 1 }, e(Text, { bold: true }, 'fahy'), e(Text, { dimColor: true }, '   now playing')),
        e(Text, null, short(String(info.title || 'music'), 64)),
        info.subtitle ? e(Text, { dimColor: true }, short(String(info.subtitle), 64)) : null,
        e(Box, { marginTop: 1 }, e(Text, { color: 'green' }, bar)),
        e(Text, { dimColor: true }, `${fmt(timePos)} / ${fmt(duration)}${paused ? ' · paused' : ''}`),
        e(Box, { marginTop: 1 }, e(Text, { dimColor: true }, 'space pause · ←/→ seek · n/p next/prev · +/- vol · m mute · q menu'))
      );
    };
    const instance = render(e(NowPlaying));
    instance.waitUntilExit().then(() => finish({ action: 'menu' })).catch(() => finish({ action: 'menu' }));
  });
}
