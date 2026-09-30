// The play commands: `fahy anime "Frieren"`, `fahy tv "Daybreak"`, plus the
// resume / radio / playlist entry points.
//
// Every one of them has the same shape: resolve the query to a title, walk the
// selection chain, then hand off to the playback core. The chain only asks a
// question when the answer is not already determined.
import { parseVideoId } from '../providers/youtube.js';
import { getProvider } from '../providers/registry.js';
import { ytMix } from '../metadata.js';
import { selectMedia, pickProvider, titleLabel, titleHint, isKind } from '../tui/flow.js';
import {
  getHistory, getPlaylist, clearHistory, removeHistory,
} from '../store.js';
import { config, opts, session, setAutoplay } from '../state.js';
import { tlog, startSpin, say } from '../ui.js';
import { canSelect, select, ask } from '../tui/select.js';
import { withDeadline } from '../lib/async.js';
import { listHistory, historyItems, historyLine, resumeTarget, CLEAR_ALL } from '../history.js';
import { sessionLoop, setQueue, finish, isInteractive } from '../playback.js';

const MODE_LABEL = {
  anime: 'Anime', movie: 'Movie', tv: 'TV show', youtube: 'YouTube', music: 'Music',
};

// Copy the command's flags into the shared option bag the playback core reads.
function applyPlayOpts(o = {}) {
  if (o.provider !== undefined) opts.provider = o.provider;
  if (o.season !== undefined) opts.season = o.season;
  if (o.episode !== undefined) opts.episode = o.episode;
  if (o.dub) opts.audio = 'dub';
  else if (o.subDub) opts.audio = o.subDub;
  if (o.download) opts.download = true;
  if (o.downloadPath) opts.downloadPath = o.downloadPath;
  if (o.printUrl) opts.printUrl = true;
  if (o.best) opts.best = true;
  if (o.mpvClean) opts.mpvClean = true;
  if (o.mpvLog) opts.mpvLog = o.mpvLog;
  if (o.url) opts.url = o.url;
  // commander exposes `--no-fallback` as fallback === false.
  if (o.fallback === false) opts.fallback = false;
  if (o.autoplay !== undefined) setAutoplay(!!o.autoplay);
}

function playOverrides() {
  return {
    provider: opts.provider,
    season: opts.season,
    episode: opts.episode,
    audio: opts.audio,
  };
}

// ---- `fahy <mode> <query...>` --------------------------------------------

export async function runPlay(kind, queryParts, commandOpts = {}) {
  if (!isKind(kind)) throw new Error(`Unknown mode: ${kind}`);
  applyPlayOpts(commandOpts);
  const query = (queryParts || []).join(' ').trim();

  if (opts.url && (kind === 'youtube' || kind === 'music')) return playByUrl(kind, opts.url);

  let q = query;
  if (!q) {
    // No query: ask for one rather than guessing. Piped, there is nobody to
    // ask, so say what the command should have been.
    if (!canSelect()) throw new Error(`Nothing to search for. Try: fahy ${kind} "<title>"`);
    q = await ask({ title: `${MODE_LABEL[kind]} to search for`, placeholder: 'title, artist, channel…' });
    if (!q) return;
  }
  return playQuery(kind, q);
}

async function playQuery(kind, query) {
  const spin = startSpin('Searching…');
  let picked;
  try {
    picked = await selectMedia({ kind, query, config, overrides: playOverrides(), interactive: isInteractive() });
  } finally {
    spin.stop();
  }
  if (!picked) return; // user backed out
  return start({ ...picked.media, audio: picked.audio }, picked.provider);
}

async function playByUrl(kind, url) {
  const id = parseVideoId(url);
  if (!id) throw new Error(`Could not read a video id from: ${url}`);
  const media = { kind, videoId: id, title: url, url: `https://www.youtube.com/watch?v=${id}` };
  const provider = await pickProvider(media, { interactive: false, forced: opts.provider });
  if (!provider) return;
  return start(media, provider);
}

// One entry point for "we have media + provider, now play it".
async function start(media, provider, { resumeMs = null } = {}) {
  // --print-url and --download are one-shot commands: no session loop, no
  // "what next?" menu, nothing waiting on a keypress.
  if (opts.printUrl || opts.download) {
    return finish(media, provider, { resumeMs, audio: media.audio || 'sub' });
  }
  return sessionLoop(media, provider, {
    resumeMs,
    pickProvider: (m) => pickProvider(m, { interactive: true }),
  });
}

// ---- history --------------------------------------------------------------

// `fahy history` — a list you can act on, not a log you scroll past.
export async function runHistory(commandOpts = {}) {
  applyPlayOpts(commandOpts);
  const history = listHistory();
  if (!history.length) {
    say('No history yet — play something first.');
    return;
  }
  // Non-interactive: plain rows, one per line, no chrome. This is what a
  // script or a `| head` gets.
  if (!canSelect()) {
    history.forEach((e, i) => say(historyLine(e, i)));
    return;
  }
  const picked = await select({
    title: 'History',
    subtitle: `${history.length} ${history.length === 1 ? 'item' : 'items'} · enter resumes`,
    items: historyItems(history),
    maxVisible: 15,
  });
  if (picked === null) return;
  if (picked === CLEAR_ALL) return clearHistoryCommand();

  const entry = history[picked];
  const target = resumeTarget(entry);
  if (!target) {
    tlog('That entry cannot be resumed (no media id or provider).', 'warn');
    return;
  }
  const resumed = await resumeEntry(entry, target);
  if (!resumed) return;
  return start(resumed.media, resumed.provider, { resumeMs: target.positionMs });
}

async function resumeEntry(entry, target) {
  const ep = entry.episode ? (entry.kind === 'tv' ? `S${entry.season || 1}E${entry.episode}` : `E${entry.episode}`) : '';
  say(`Resuming ${entry.title}${ep ? ` ${ep}` : ''}${target.positionMs ? ` at ${Math.floor(target.positionMs / 60000)}m` : ''}…`);
  const provider = await pickProvider(target.media, { forced: opts.provider || target.providerId });
  if (!provider) return null;
  return { media: target.media, provider };
}

// `fahy continue` — the newest resumable entry, no prompt. This is the
// shorthand people actually type.
export async function runContinue(commandOpts = {}) {
  applyPlayOpts(commandOpts);
  const entry = getHistory().find((e) => resumeTarget(e));
  if (!entry) throw new Error('Nothing to resume yet — play something first.');
  const target = resumeTarget(entry);
  const resumed = await resumeEntry(entry, target);
  if (!resumed) return;
  return start(resumed.media, resumed.provider, { resumeMs: target.positionMs });
}

// Destructive, so it asks — but only when someone is there to answer.
export async function clearHistoryCommand({ force = false } = {}) {
  if (!force && canSelect()) {
    const ok = await select({
      title: 'Clear history',
      subtitle: 'This deletes every entry and cannot be undone.',
      items: [
        { label: 'Cancel', value: false },
        { label: 'Delete everything', value: true },
      ],
      footer: 'enter confirm · esc cancel',
    });
    if (ok !== true) {
      say('History kept.');
      return;
    }
  }
  const n = clearHistory();
  say(n ? `Cleared ${n} history ${n === 1 ? 'entry' : 'entries'}.` : 'History was already empty.');
}

export async function runDeleteHistory(urls) {
  if (!urls?.length) throw new Error('Nothing to delete.');
  const n = removeHistory(urls);
  say(n ? `Deleted ${n} ${n === 1 ? 'entry' : 'entries'}.` : 'Nothing matched.');
}

// ---- radio ----------------------------------------------------------------

// A radio mix seeded from a URL or the newest YouTube/music history entry.
export async function runRadio(url = null) {
  let seedId = url ? parseVideoId(url) : null;
  let seedKind = 'youtube';
  if (!seedId) {
    const h = getHistory().find((e) => (e.kind === 'youtube' || e.kind === 'music') && e.videoId);
    if (!h) throw new Error('Radio needs a YouTube seed. Try: fahy radio <url>, or play something first.');
    seedId = h.videoId;
    seedKind = h.kind;
  }
  const spin = startSpin('Loading radio mix…');
  let mix;
  try {
    mix = await withDeadline(() => ytMix(seedId, 25, { debug: session.debug }), 25000, 'radio mix');
  } finally {
    spin.stop();
  }
  if (!mix.length) throw new Error('Radio mix came back empty.');
  setQueue(mix.map((t) => ({ ...t, kind: seedKind })));
  const provider = getProvider(seedKind === 'music' ? 'ytmusic' : 'youtube');
  return start({ ...getQueue()[0] }, provider);
}

// ---- playlists ------------------------------------------------------------

export async function runPlaylist(name, commandOpts = {}) {
  if (commandOpts.provider) opts.provider = commandOpts.provider;
  const list = getPlaylist(name);
  if (!list.length) {
    throw new Error(`Playlist '${name}' is empty or missing. Add one with: fahy playlist-add ${name}`);
  }
  setQueue(list.map((t) => ({ ...t })));
  // More than one track is a real choice; one track is not.
  let chosen = list[0];
  if (canSelect() && list.length > 1) {
    const picked = await select({
      title: `Playlist: ${name}`,
      items: list.map((t, i) => ({ label: titleLabel(t), hint: titleHint(t), value: i })),
    });
    if (picked === null) return;
    chosen = list[picked];
  }
  const provider = await pickProvider(chosen, { forced: opts.provider, interactive: false });
  if (!provider) return;
  return start({ ...chosen }, provider);
}
