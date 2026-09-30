// Playback core: resolve -> vet -> play/download, with the provider cycle.
//
// The hang this module exists to prevent: a provider resolve is a chain of
// sequential HTTP fetches, so one slow or broken source used to leave the CLI
// sitting with no output and no way out. Every stage here is bounded, and a
// timeout is a first-class outcome that hands off to the next provider
// instead of ending the command.
//
// Outcomes are always exactly one of: succeed, fail, timeout, cancel, fallback.
import { existsSync } from 'node:fs';

import { forKind, getProvider, orderProviders } from './providers/registry.js';
import { ytMix, formatDuration } from './metadata.js';
import { classifyFailure } from './failure.js';
import { probeUrl, probePassesForPlayback } from './probe.js';
import { hasMpv, playUrl, playFile, prescreenEmbed, extractDirectUrl, killPlayerChildren, wasInterrupted, onInterrupt } from './player.js';
import { hasYtDlp, downloadSource, guessFile, defaultDownloadDir, defaultMusicDir, freeSpaceBytes } from './downloader.js';
import {
  addHistory, updateHistory, addDownload, setDownloadStatus,
  getHealth, recordHealth, healthBlocked, shouldAutoPin, saveRun,
} from './store.js';
import { saveConfig } from './config.js';
import { config, session, opts, setDefaultProvider, setAutoplay, persistModes } from './state.js';
import { tlog, startSpin, say } from './ui.js';
import { select, canSelect, endFrame } from './tui/select.js';
import { advanceEpisode } from './tui/flow.js';
import { nowPlaying } from './tui/nowplaying.js';
import { withDeadline, TimeoutError } from './lib/async.js';

// A provider resolve is allowed to be slow (page -> play page -> access API ->
// HLS validation, four round trips) but not unbounded. 45s covers a very slow
// connection and still guarantees the command moves on.
export const RESOLVE_TIMEOUT_MS = 45000;
// Source checking: probes run in parallel but a provider can hand back many
// sources, and the embed prescreen is a blocking spawn. Budget the whole step.
const VET_BUDGET_MS = 30000;
const PROBE_TIMEOUT_MS = 5000;
const PRESCREEN_TIMEOUT_MS = 12000;
const DIRECT_URL_TIMEOUT_MS = 20000;
// mpv that exits this fast after a seek either found nothing at that offset or
// landed past the end. Either way the honest response is to start over.
const RESUME_MIN_SESSION_MS = 5000;
// A source that got less than this far in never really started. Below ~5s of
// playback is startup, not a watch.
const STARTED_THRESHOLD_S = 5;
// Reaching this fraction of the runtime counts as finished. Matches the rule
// resume already uses to avoid seeking into the last few seconds.
const COMPLETED_RATIO = 0.9;

export function isInteractive() {
  return canSelect() && !opts.printUrl;
}

// Session queue (youtube/music results, radio mixes) — next/prev walk this.
let lastList = [];
export function getQueue() {
  return lastList;
}
export function setQueue(list) {
  lastList = (list || []).map((x) => ({ ...x }));
}

// ---- resolve --------------------------------------------------------------

export async function resolveMedia(provider, media, { audio = 'sub' } = {}) {
  let input;
  if (media.kind === 'anime') {
    input = { title: media.title, anilistId: media.anilistId, episode: media.episode, season: media.season, episodeId: media.episodeId || undefined };
  } else if (media.kind === 'movie' || media.kind === 'tv') {
    input = {
      ...media, kind: media.kind, tmdbId: media.tmdbId, title: media.title,
      year: media.year, season: media.season, episode: media.episode,
    };
  } else {
    input = { videoId: media.videoId, url: media.url, title: media.title };
  }
  return provider.resolve(input, { debug: session.debug, audio });
}

export function mediaTag(media) {
  if (media.kind === 'anime') return media.episode ? ` E${media.episode}` : '';
  if (media.kind === 'tv') return ` S${media.season || 1}E${media.episode || 1}`;
  if (media.kind === 'music' && media.duration) return ` (${formatDuration(media.duration)})`;
  return '';
}

export function friendlyFinishError(e, providerId) {
  const c = classifyFailure(e, providerId);
  return c.class === 'unknown' ? String(e.message || e) : c.summary;
}

// ---- source checking ------------------------------------------------------

// One verdict per source, always resolved — never a throw, never a hang.
async function checkSource(source, { signal }) {
  if (source.type === 'embed') {
    const v = await prescreenEmbed(source.url, { timeoutMs: PRESCREEN_TIMEOUT_MS, debug: session.debug });
    if (v === 'unplayable') return { status: 'unreachable', reason: 'yt-dlp cannot extract this page', definitive: true };
    return { status: v === 'playable' ? 'reachable' : 'timeout', reason: v, definitive: false };
  }
  return probeUrl(source.url, { headers: source.headers, timeoutMs: PROBE_TIMEOUT_MS, signal });
}

// YouTube/music go through yt-dlp natively — vetting would only add latency
// and false verdicts, so those lanes skip probe/prescreen entirely.
function shouldVet(media) {
  return media.kind !== 'youtube' && media.kind !== 'music';
}

// ---- the provider cycle ---------------------------------------------------

export async function finish(media, provider, { resumeMs = null, audio = null } = {}) {
  // --print-url: fast path, first source, no probing. Machine-readable stdout.
  if (opts.printUrl) {
    const resolved = await withDeadline(
      (signal) => resolveMedia(provider, media, { audio, signal }),
      RESOLVE_TIMEOUT_MS,
      `${provider.name} resolve`
    );
    const source = resolved.sources?.[0];
    if (!source?.url) throw new Error(`Provider ${provider.name} returned no playable URL.`);
    say(source.url);
    return;
  }

  // Resolve cycle: chosen provider first, then your priority list, then the
  // rest auto-ranked by observed health (reliability, then speed) — the cycle
  // finds the best stable source by itself. Health-skipped adapters print why.
  const avail = forKind(media.kind);
  // NOTE: commander maps `--no-fallback` to opts.fallback === false.
  const strict = opts.fallback === false;
  const priority = (config.providerPriority || {})[media.kind] || [];
  const health = getHealth();
  const ordered = orderProviders(provider, avail, {
    priority, strict, healthBlocked: (id) => id !== provider.id && healthBlocked(id), health,
  });
  const maybeAutoPin = (cand) => {
    const defId = (config.defaultProvider || {})[media.kind];
    if (shouldAutoPin(cand.id, defId, healthBlocked(defId))) {
      setDefaultProvider(media.kind, cand.id);
      tlog(`Default ${media.kind} provider → ${cand.name} (previous default unhealthy).`);
    }
  };
  const unhealthyIds = new Set(
    (!strict ? avail.filter((x) => x.id !== provider.id && healthBlocked(x.id)) : []).map((x) => x.id)
  );
  const failures = [];
  const deadThisSession = new Set(); // don't re-probe/retry a URL that already died
  const androidTried = new Set(); // android-client retries already spent per URL
  const trail = []; // diagnostics evidence for `fahy diagnostics`
  const mark = (name, ok, detail) => trail.push({ provider: name, ok, detail });
  const persistTrail = () => saveRun({ title: `${media.title}${mediaTag(media)}`, kind: media.kind, events: trail.slice(-50) });
  const vet = shouldVet(media);

  for (const cand of ordered) {
    const t0 = Date.now();
    // Unhealthy notice lands here, at try time — one line per provider
    // actually attempted, never a stale repeated preamble.
    if (unhealthyIds.has(cand.id)) tlog(`  ${cand.name}: unhealthy streak — trying last (fahy health --reset to forgive)`);

    // --- 1. resolve (bounded) ---
    let resolved;
    const spin = startSpin(`Resolving ${cand.name}…`);
    try {
      resolved = await withDeadline(
        (signal) => resolveMedia(cand, media, { audio, signal }),
        RESOLVE_TIMEOUT_MS,
        `${cand.name} resolve`
      );
    } catch (e) {
      spin.stop();
      const c = classifyFailure(e, cand.id);
      // Summary plus the underlying reason — a bare "unexpected issue" hides
      // whether it is a wrong title, a dead CDN, or a site change.
      const reason = c.detail && c.detail !== c.summary ? ` (${c.detail.slice(0, 140)})` : '';
      const timedOut = e instanceof TimeoutError || e?.name === 'TimeoutError';
      const line = timedOut ? `${cand.name} timed out (${Math.round(RESOLVE_TIMEOUT_MS / 1000)}s).` : `${cand.name}: ${c.summary}${reason}`;
      tlog(`  ${line}`, 'warn');
      failures.push(`${cand.id} (${c.class})`);
      mark(cand.name, false, line);
      // Availability gaps (the title/episode simply is not here), a user
      // cancel, or being offline are not provider outages — they stay in the
      // trail but must not degrade health or trigger a pin.
      if (!['provider-empty', 'user-cancelled', 'offline'].includes(c.class)) {
        recordHealth(cand.id, { ok: false });
      }
      if (c.policy === 'auto-fallback' && !strict) continue;
      persistTrail();
      throw e;
    }
    spin.stop();

    if (!resolved.sources?.length) {
      tlog(`  ${cand.name}: no sources returned.`, 'warn');
      failures.push(`${cand.id} (empty)`);
      mark(cand.name, false, 'no sources returned');
      recordHealth(cand.id, { ok: false });
      if (!strict) continue;
      persistTrail();
      throw new Error(`${cand.name} returned no sources.`);
    }
    // The provider may know the episode id it resolved; keep it for history.
    const episodeId = media.episodeId || resolved.episodeId || null;

    // --- 2. check the sources (bounded) ---
    let alive = resolved.sources;
    if (vet) {
      const spin2 = startSpin(`Checking ${resolved.sources.length} source${resolved.sources.length === 1 ? '' : 's'} from ${cand.name}…`);
      const checks = await withDeadline(async (signal) => {
        const settled = await Promise.allSettled(
          resolved.sources.map((s) =>
            deadThisSession.has(s.url)
              ? Promise.resolve({ status: 'unreachable', reason: 'died earlier this session', definitive: true })
              : checkSource(s, { signal })
          )
        );
        return settled.map((r) =>
          r.status === 'fulfilled' ? r.value : { status: 'timeout', reason: r.reason?.message || 'check failed', definitive: false }
        );
      }, VET_BUDGET_MS, `${cand.name} source check`).catch((err) => {
        if (err instanceof TimeoutError) tlog(`  ${cand.name}: source checking timed out — trying the first source anyway.`, 'warn');
        return null;
      });
      spin2.stop();
      // A check that could not finish is inconclusive, not dead: fall through
      // with the unvetted sources rather than declaring a provider bad.
      if (checks) {
        alive = resolved.sources.filter((_, i) => probePassesForPlayback(checks[i]));
        checks.forEach((pr, i) => {
          if (!probePassesForPlayback(pr)) tlog(`  ✕ ${shortUrl(resolved.sources[i].url)} (${pr.reason})`);
        });
        if (!alive.length) {
          tlog(`  ${cand.name}: all ${resolved.sources.length} source(s) unreachable.`, 'warn');
          failures.push(`${cand.id} (sources dead)`);
          mark(cand.name, false, 'all sources unreachable');
          recordHealth(cand.id, { ok: false });
          if (!strict) continue;
          persistTrail();
          throw new Error(`${cand.name}: all sources unreachable.`);
        }
      }
    }

    // --- 3. pick a source ---
    let source = alive[0];
    if (alive.length > 1 && isInteractive() && !opts.download && !opts.best) {
      const picked = await select({
        title: 'Source',
        subtitle: `${cand.name} · ${alive.length} verified`,
        items: alive.map((s, i) => ({
          label: `#${i + 1} ${s.provider} · ${s.quality} · ${s.type}`,
          hint: shortUrl(s.url),
          value: i,
        })),
      });
      if (picked !== null) source = alive[picked];
    }

    // One dead rendition must not sink a provider with several verified ones
    // (dead tiers, anikoto servers): play failure hands off to the next source
    // of the SAME provider, then falls through to the next provider.
    const deduped = [...new Map(alive.map((s) => [s.url, s])).values()];
    const queue = [source, ...deduped.filter((s) => s !== source)];
    let lastOutcome = 'retry';
    let played = false;
    for (const attempt of queue) {
      if (deadThisSession.has(attempt.url)) continue;
      const outcome = await playOrDownload(media, cand, attempt, { resumeMs, audio, episodeId });
      if (outcome === 'ok') {
        mark(cand.name, true, attempt.quality);
        recordHealth(cand.id, { ok: true, ms: Date.now() - t0 });
        maybeAutoPin(cand);
        persistTrail();
        played = true;
        break;
      }
      lastOutcome = outcome;
      // YouTube/music are single-lane: before giving up, retry the same source
      // through the Android client (kids/restricted videos 403 otherwise).
      // Same provider, same source — allowed even in strict mode.
      if ((media.kind === 'youtube' || media.kind === 'music') && !androidTried.has(attempt.url)) {
        androidTried.add(attempt.url);
        tlog('  Retrying with Android client…');
        const outcome2 = await playOrDownload(media, cand, attempt, { resumeMs, audio, episodeId, android: true });
        if (outcome2 === 'ok') {
          mark(cand.name, true, `${attempt.quality} (android client)`);
          recordHealth(cand.id, { ok: true, ms: Date.now() - t0 });
          maybeAutoPin(cand);
          persistTrail();
          played = true;
          break;
        }
        lastOutcome = outcome2;
      }
      deadThisSession.add(attempt.url);
    }
    if (played) return;
    failures.push(`${cand.id} (${lastOutcome})`);
    mark(cand.name, false, `mpv/yt-dlp ${lastOutcome}`);
    recordHealth(cand.id, { ok: false });
    // outcome 'retry' (mpv/yt-dlp failed fast): fall through to next provider.
  }
  persistTrail();
  throw new Error(`All providers exhausted (${failures.join(', ') || 'no attempts'}).`);
}

function shortUrl(u, n = 48) {
  const s = String(u || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---- play or download -----------------------------------------------------

function formatBytes(b) {
  const n = Number(b);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)}MB`;
  return `${(n / 1024).toFixed(0)}KB`;
}

export async function playOrDownload(media, provider, source, { resumeMs = null, audio = 'sub', episodeId = null, android = false } = {}) {
  if (!source?.url) throw new Error(`Provider ${provider.name} returned no playable URL.`);
  // mpv owns the terminal from here. A child process drawing into a region the
  // frame still believes it owns is the one way a selector's frame cannot
  // survive, so the frame is retired before any player or downloader starts.
  // A `▶ Playing` line after this point is ordinary scrollback again.
  endFrame();
  // Audio-only is MUSIC-ONLY by contract: anime + youtube always play video.
  const audioOnly = media.kind === 'music' || source.audioOnly === true;
  const duration = media.duration || null;

  const record = {
    title: media.title, kind: media.kind, videoId: media.videoId || null, anilistId: media.anilistId || null,
    tmdbId: media.tmdbId || null, season: media.season || null, episode: media.episode || null,
    episodeId: episodeId || media.episodeId || null, duration, audio: audio || null,
    provider: provider.name, providerId: provider.id, url: source.url,
  };

  if (opts.download) {
    if (!hasYtDlp()) throw new Error('yt-dlp not found: winget install --id yt-dlp.yt-dlp -e');
    const outDir = opts.downloadPath || (media.kind === 'music' ? defaultMusicDir() : config.downloadPath || defaultDownloadDir());
    const free = freeSpaceBytes(outDir);
    if (free !== null && free < 500n * 1024n * 1024n) {
      throw new Error(`Only ${formatBytes(free)} free in ${outDir} — need ~500MB. Free space or pick another path.`);
    }
    addDownload({ ...record, outDir });    const { code } = await downloadSource({
      url: source.url, title: media.title, season: media.season, episode: media.episode, outDir, audio: audioOnly, headers: source.headers, debug: session.debug,
    });
    if (code === 0) {
      setDownloadStatus(source.url, 'done', { file: guessFile({ title: media.title, season: media.season, episode: media.episode, outDir, audio: audioOnly }) });
      tlog(`Downloaded to ${outDir}`, 'ok');
      return 'ok';
    }
    setDownloadStatus(source.url, 'failed');
    tlog(`  yt-dlp could not download this source (exit ${code}) — trying next…`, 'warn');
    return 'retry';
  }

  if ((media.kind === 'youtube' || media.kind === 'music') && !hasYtDlp()) {
    throw new Error('YouTube playback needs yt-dlp (mpv extracts through it): winget install --id yt-dlp.yt-dlp -e');
  }
  if (!hasMpv()) {
    throw new Error('mpv not found on PATH and this tool is mpv-only. Install: winget install --id mpv-player.mpv-CI.MSVC -e');
  }
  if (source.subMissing && isInteractive()) {
    tlog('No soft subtitles available for this source — video may be subbed, dubbed, or raw.', 'warn');
  }

  // YouTube/music fast-start: resolve ONE direct stream up front so mpv opens
  // a real file (--no-ytdl) instead of running its own yt-dlp hook silently for
  // seconds with no picture on screen. null -> mpv's own hook, as before.
  let playSource = source;
  if ((media.kind === 'youtube' || media.kind === 'music') && !android) {
    const spin = startSpin('Fetching stream…');
    const direct = extractDirectUrl(source.url, { audioOnly, timeoutMs: DIRECT_URL_TIMEOUT_MS, debug: session.debug });
    spin.stop();
    if (direct) playSource = { ...source, url: direct, direct: true };
  }

  const startMs = Number(resumeMs) || 0;
  if (startMs > 0) tlog(`  Resuming at ${formatDuration(startMs / 1000)}`);
  tlog(`  ▶ Playing in mpv — q to stop${media.kind === 'music' ? ' (audio only)' : ''}`);

  const playOpts = (source, extra = {}) => ({
    headers: source.headers, subFile: source.subFile, skip: source.skip,
    direct: source.direct === true, audioOnly, volume: config.volume ?? 100,
    clean: opts.mpvClean, logFile: opts.mpvLog, debug: session.debug, ...extra,
  });

  let res = await playUrl(playSource.url, playOpts(playSource, { positionMs: startMs, duration, androidClient: android === true }));

  // A seek past the end (or a resume offset this file does not have) makes
  // mpv exit almost immediately. Start over rather than reporting a failure
  // for a file the user can plainly play.
  if (startMs > 0 && res.code === 0 && res.ms < RESUME_MIN_SESSION_MS) {
    tlog('  Nothing left at that offset — starting from the beginning.', 'warn');
    res = await playUrl(playSource.url, playOpts(playSource));
    startMs = 0;
  }

  // Did this source actually play? Only a non-zero exit is in question, and
  // mpv's own report is the evidence: if it failed, `positionSec` never got
  // past the opening seconds. This replaces an "exited non-zero within two
  // minutes" guess, which misread a long session that failed at the end and a
  // short one that was simply watched briefly. A zero exit is the user quitting
  // or the file ending — that is a watch, however brief.
  // The wall-clock rule stays only as the fallback for a player that never
  // reported a position at all (spawn failure, no script, hard kill).
  const failedExit = res.code !== 0 && res.code !== null;
  const neverStarted = failedExit && (res.positionSec !== null
    ? res.positionSec < STARTED_THRESHOLD_S
    : res.ms < 120000);
  if (neverStarted) {
    tlog(`  mpv could not play this source (exit ${res.code}) — trying next…`, 'warn');
    return 'retry';
  }

  // Where the watch actually got to. mpv's number is authoritative; the wall
  // clock only stands in when mpv could not tell us (start offset plus elapsed
  // session time).
  const positionSec = res.positionSec !== null ? res.positionSec : (startMs + res.ms) / 1000;
  const totalSec = duration || res.durationSec || null;
  // Completion is mpv's own statement that it reached the end, not our
  // arithmetic. A file watched through reports only 0.89-0.98 of its runtime as
  // the final position (the last checkpoint lands just before the closing
  // frames), so any position-vs-duration threshold has to guess — and guessing
  // wrong here is what makes a finished episode resume from the middle.
  // The ratio stays only for a player that never reported a reason.
  const completed = res.playedToEnd === true
    || (res.playedToEnd == null && totalSec && positionSec >= Number(totalSec) * COMPLETED_RATIO);
  // History is written HERE, not before the spawn: an attempt that never played
  // leaves no row, so a dead source cannot dress itself up as something
  // watched. One call carries the position, so there is no window in which a
  // row exists with a stale or missing offset.
  try {
    const entry = { ...record, positionMs: Math.round(positionSec * 1000) };
    if (completed) entry.completed = true;
    addHistory(entry);
  } catch {}
  return 'ok';
}

// ---- offline library playback --------------------------------------------

export async function playLocalFile(file, { positionMs = null, duration = null } = {}) {
  if (!existsSync(file)) throw new Error(`File missing: ${file}`);
  if (!hasMpv()) throw new Error('mpv not found on PATH. Install: winget install --id mpv-player.mpv-CI.MSVC -e');
  const { code, ms } = await playFile(file, {
    volume: config.volume ?? 100, clean: opts.mpvClean, logFile: opts.mpvLog,
    positionMs, duration, debug: session.debug,
  });
  if (code !== 0 && code !== null) tlog(`mpv exited ${code}.`, 'warn');
  return { code, ms };
}

// ---- music daemon ---------------------------------------------------------

let musicDaemon = null;
let musicAndroid = false;
// The url the current music row is filed under, so an interrupt can find the
// history row to update.
let musicHistoryUrl = null;

async function ensureMusicDaemon() {
  // Fail fast with a useful message instead of a 15s IPC timeout + orphan.
  if (!hasMpv()) throw new Error('mpv not found on PATH and this tool is mpv-only. Install: winget install --id mpv-player.mpv-CI.MSVC -e');
  // A crashed mpv leaves a dead object behind — detect via exitCode and respawn
  // instead of handing callers a corpse that fails every load.
  if (musicDaemon) {
    const code = musicDaemon.proc?.exitCode;
    if (code === null || code === undefined) return musicDaemon;
    await killMusicDaemon();
  }
  const { MusicPlayer } = await import('./mplayer.js');
  const d = new MusicPlayer();
  try {
    await d.start(musicAndroid ? ['--ytdl-raw-options=extractor-args=youtube:player_client=android'] : []);
  } catch (e) {
    try {
      d.proc?.kill();
    } catch {}
    throw e;
  }
  musicDaemon = d;
  return d;
}

export async function killMusicDaemon() {
  const d = musicDaemon;
  musicDaemon = null;
  musicHistoryUrl = null;
  if (d) {
    try {
      await d.quit();
    } catch {}
  }
}

process.on('exit', () => {
  try {
    musicDaemon?.proc?.kill();
    killPlayerChildren();
  } catch {}
});

// Ctrl+C while the music daemon is up: nothing is awaiting that process, so
// the daemon's position would never reach history. Save it on the way out.
onInterrupt(async () => {
  const d = musicDaemon;
  if (!d) return;
  try {
    const pos = Number(d.state?.timePos) || 0;
    const dur = Number(d.state?.duration) || 0;
    const url = musicHistoryUrl;
    if (url && pos > 0) {
      updateHistory(url, {
        positionMs: Math.round(pos * 1000),
        ...(dur > 0 && pos >= dur * 0.9 ? { completed: true } : {}),
      });
    }
  } catch {}
  await killMusicDaemon();
});

// One supervised music track: resolve -> load -> live screen -> action.
async function playMusicTrack(media, provider, { resumeMs = null }) {
  const spin = startSpin(`Resolving ${provider.name}…`);
  let resolved;
  try {
    resolved = await withDeadline(
      (signal) => resolveMedia(provider, media, { signal }),
      RESOLVE_TIMEOUT_MS,
      `${provider.name} resolve`
    );
  } finally {
    spin.stop();
  }
  const source = resolved.sources[0];
  if (!source?.url) throw new Error(`Provider ${provider.name} returned no playable URL.`);
  const daemon = await ensureMusicDaemon();
  musicHistoryUrl = source.url;
  addHistory({
    title: media.title, kind: media.kind, videoId: media.videoId || null,
    duration: media.duration || null, provider: provider.name, providerId: provider.id, url: source.url,
  });
  const vol = config.volume ?? 100;
  const load = async (d) => {
    if (resumeMs > 0) {
      try {
        await d.send('seek', resumeMs / 1000, 'absolute');
      } catch {}
    }
    await d.load(source.url, { volume: vol });
    return d.waitForStart(45000);
  };
  try {
    await load(daemon);
    recordHealth(provider.id, { ok: true });
  } catch (e) {
    // Same Android-client fallback as one-shot playback, via daemon respawn.
    if (!musicAndroid) {
      musicAndroid = true;
      tlog('  Retrying with Android client…');
      await killMusicDaemon();
      await load(await ensureMusicDaemon()).catch((e2) => {
        recordHealth(provider.id, { ok: false });
        throw e2;
      });
      recordHealth(provider.id, { ok: true });
    } else {
      recordHealth(provider.id, { ok: false });
      throw e;
    }
  }
  const live = musicDaemon;
  const r = await nowPlaying(live, {
    title: media.title,
    subtitle: media.author ? `${media.author}${media.duration ? ` · ${formatDuration(media.duration)}` : ''}` : null,
  }, {
    volume: (v) => {
      saveConfig({ ...config, volume: v });
      config.volume = v;
    },
  });
  // Leaving now-playing must pause the track — "exit" is a stop, not a
  // background continuous-play. Playback resumes on the next load().
  if (r.action === 'menu') {
    try {
      await live.pause();
    } catch {}
  }
  // Persist where the track was left (keys and natural end alike).
  try {
    const pos = live.state.timePos || 0;
    const dur = live.state.duration || 0;
    updateHistory(source.url, {
      positionMs: Math.round(pos * 1000),
      ...(dur > 0 && pos >= dur * 0.9 ? { completed: true } : {}),
    });
  } catch {}
  if (r.action === 'ended') return 'next';
  if (r.action === 'failed') throw new Error(`track failed (${r.reason || 'mpv gave up'}) — try radio or another search`);
  return r.action; // next | prev | menu
}

// ---- session loop ---------------------------------------------------------

function shuffledOrder(n, exclude = -1) {
  const idx = [];
  for (let i = 0; i < n; i++) if (i !== exclude) idx.push(i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

export async function sessionLoop(media, provider, { resumeMs = null, pickProvider: pickProviderFn = null } = {}) {
  const startIdx = lastList.findIndex((x) => x.videoId && media.videoId && x.videoId === media.videoId);
  let qi = startIdx >= 0 ? startIdx : 0;
  let order = session.shuffle ? shuffledOrder(lastList.length, qi) : null;
  const back = [];
  let pendingResume = resumeMs;
  for (;;) {
    if (media.kind !== 'music') await killMusicDaemon();
    // Music gets the supervised daemon (live controls + accurate resume);
    // everything else is a one-shot mpv.
    const musicLive = media.kind === 'music' && canSelect() && !opts.download && !opts.printUrl;
    let action;
    // The next episodic step, resolved once by the menu, so the row it showed
    // and the episode it plays cannot end up two different answers.
    let next = null;
    if (musicLive) {
      try {
        action = await playMusicTrack(media, provider, { resumeMs: pendingResume });
      } catch (e) {
        await killMusicDaemon();
        if (e.message === 'cancelled') return;
        throw e;
      }
      pendingResume = 0;
      if (action === 'menu') ({ action, next } = await postPlayMenu(media, qi, back));
      else next = null;
    } else {
      try {
        await finish(media, provider, { resumeMs: pendingResume, audio: media.audio });
      } catch (e) {
        if (e.message === 'cancelled') return;
        throw e;
      }
      // Ctrl+C during playback: the position is saved, the session is over.
      // Asking "what next?" to someone who just asked to stop is noise.
      if (wasInterrupted()) break;
      pendingResume = 0;
      // A one-shot run ends here unless a human is there to ask what is next.
      if (opts.download || opts.printUrl || !canSelect()) break;
      if (session.autoplay) {
        const advanced = await advanceOne(media, qi);
        if (advanced === 'end') {
          tlog(endOfQueueMessage(media), 'ok');
          break;
        }
        if (advanced) {
          media = advanced.media;
          provider = advanced.provider || provider;
          qi = advanced.qi ?? qi;
          order = session.shuffle ? shuffledOrder(lastList.length, qi) : null;
          continue;
        }
      }
      ({ action, next } = await postPlayMenu(media, qi, back));
    }
    if (action === 'quit' || !action) break;
    if (action === 'provider') {
      const next = pickProviderFn ? await pickProviderFn(media) : null;
      if (!next) break;
      provider = next;
      continue;
    }
    if (action === 'radio') {
      const moved = await startRadio(media, provider);
      if (!moved) break;
      ({ media, provider, qi, order } = moved);
      back.length = 0;
      continue;
    }
    const moved = await applyAction({ action, next, media, provider, qi, back, order });
    if (!moved) break;
    ({ media, provider, qi, order } = moved);
  }
  // The session is over: give the terminal back so the shell prompt starts on a
  // clean line rather than under a retired frame.
  endFrame();
  await killMusicDaemon();
}

// Radio from whatever YouTube track is playing. Returns null when the mix
// could not be built, so the caller keeps the current track instead of
// silently ending the session.
async function startRadio(media, provider) {
  if (!media.videoId) {
    tlog('Radio needs a YouTube track — not available here.', 'warn');
    return null;
  }
  const spin = startSpin('Loading radio mix…');
  try {
    const mix = await withDeadline(() => ytMix(media.videoId, 25, { debug: session.debug }), 25000, 'radio mix');
    if (!mix.length) {
      tlog('Radio mix came back empty.', 'warn');
      return null;
    }
    setQueue(mix.map((t) => ({ ...t, kind: media.kind })));
    return { media: { ...lastList[0] }, provider: providerFor(lastList[0], provider), qi: 0, order: session.shuffle ? shuffledOrder(lastList.length, 0) : null };
  } catch (e) {
    tlog(`Radio failed: ${e.message}`, 'warn');
    return null;
  } finally {
    spin.stop();
  }
}

// Apply a post-play action. Returns the new position in the session, or null
// when the session should end. Every branch returns a full replacement so no
// state is left half-updated.
async function applyAction({ action, next, media, provider, qi, back, order }) {
  const same = { media, provider, qi, order };
  if (action === 'replay') return same;

  if (action === 'next') {
    if (media.kind === 'anime' || media.kind === 'tv') {
      // `next` is the step the menu already resolved and labelled. Acting on
      // that same object is what keeps the row and the episode in agreement —
      // a second lookup could answer differently and play something the menu
      // never offered.
      if (!next) {
        tlog(endOfQueueMessage(media), 'warn');
        return same;
      }
      back.push({ media, qi });
      return { ...same, media: next.media };
    }
    if (session.repeat === 'one') return same;
    if (session.shuffle) {
      let cursor = order;
      if (!cursor || !cursor.length) {
        if (session.repeat === 'all' && lastList.length > 1) cursor = shuffledOrder(lastList.length, qi);
        else {
          tlog('End of shuffled queue — try radio or a new search.', 'warn');
          return same;
        }
      }
      back.push({ media, qi });
      const i = cursor.shift();
      return { media: { ...lastList[i] }, provider: providerFor(lastList[i], provider), qi: i, order: cursor };
    }
    back.push({ media, qi });
    let i = qi + 1;
    if (i >= lastList.length) {
      if (session.repeat === 'all' && lastList.length > 0) i = 0;
      else {
        tlog('End of queue — try radio or a new search.', 'warn');
        back.pop();
        return same;
      }
    }
    if (!lastList[i]) {
      tlog('End of queue — try radio or a new search.', 'warn');
      back.pop();
      return same;
    }
    return { media: { ...lastList[i] }, provider: providerFor(lastList[i], provider), qi: i, order };
  }

  if (action === 'prev') {
    const prev = back.pop();
    if (!prev) {
      tlog('Nothing before this.', 'warn');
      return same;
    }
    return { media: prev.media, provider: providerFor(prev.media, provider), qi: prev.qi, order };
  }
  if (action === 'shuffle') {
    session.shuffle = !session.shuffle;
    persistModes();
    tlog(`Shuffle ${session.shuffle ? 'on' : 'off'}.`);
    return { ...same, order: session.shuffle ? shuffledOrder(lastList.length, qi) : null };
  }
  if (action === 'repeat') {
    session.repeat = session.repeat === 'off' ? 'all' : session.repeat === 'all' ? 'one' : 'off';
    persistModes();
    tlog(`Repeat ${session.repeat}.`);
    return same;
  }
  if (action === 'queue') {
    const upcoming = session.shuffle && order?.length
      ? order.slice(0, 10).map((i) => lastList[i])
      : lastList.slice(qi + 1, qi + 11);
    if (!upcoming.length) tlog('Queue is empty after this.');
    upcoming.forEach((t, i) => tlog(`  ${i + 1}. ${t.title}`));
    return same;
  }
  if (action === 'autoplay') {
    setAutoplay(!session.autoplay);
    tlog(`Autoplay ${session.autoplay ? 'on' : 'off'}.`);
    return same;
  }
  return same;
}

function providerFor(media, fallback) {
  if (!media) return fallback;
  const wanted = media.kind === 'music' ? 'ytmusic' : media.kind === 'youtube' ? 'youtube' : null;
  return (wanted ? getProvider(wanted) : null) || fallback;
}

// Advance for autoplay. Returns { media, provider?, qi? } or 'end' (queue or
// series finished) or null (nothing to advance into).
//
// For anime/TV this asks flow.advanceEpisode, which knows where the season
// ends and can carry into the next one — the same answer the "what next?" menu
// would give, so autoplay can never walk into an episode that does not exist.
async function advanceOne(media, qi) {
  if (media.kind === 'anime' || media.kind === 'tv') {
    const next = await advanceEpisode(media);
    return next === 'end' ? 'end' : { media: next.media };
  }
  if (lastList.length > 1) {
    const i = (qi + 1) % lastList.length;
    return { media: { ...lastList[i] }, provider: providerFor(lastList[i], null), qi: i };
  }
  return null;
}

// What to say when there is provably nothing left to play.
function endOfQueueMessage(media) {
  if (media.kind === 'anime' || media.kind === 'tv') return 'End of the series.';
  return 'End of queue.';
}

// The "what next?" screen. Same temporary-selector contract as every other
// interactive surface: mount, answer, unmount.
//
// It never offers an episode that does not exist. Resolving the next step is
// cheap inside a season (an increment) and costs one bounded lookup at a
// season boundary, which is the only moment it is worth paying for — so it is
// paid once, and the resolved step rides out with the answer rather than being
// looked up a second time to act on it.
export async function postPlayMenu(media, qi, back) {
  const items = [];
  let next = null;
  if (media.kind === 'anime' || media.kind === 'tv') {
    next = await advanceEpisode(media);
    if (next === 'end') {
      tlog(endOfQueueMessage(media), 'ok');
    } else {
      items.push({ value: 'next', label: next.label });
    }
  } else {
    if (lastList.length > 1) items.push({ value: 'next', label: 'Next in queue', hint: session.repeat === 'one' ? 'repeat one: replays instead' : '' });
  }
  if (back.length) items.push({ value: 'prev', label: 'Previous' });
  if (media.kind === 'music') {
    items.push({ value: 'shuffle', label: `Shuffle: ${session.shuffle ? 'on' : 'off'}` });
    items.push({ value: 'repeat', label: `Repeat: ${session.repeat}` });
    items.push({ value: 'queue', label: 'Show upcoming queue' });
    if (media.videoId) items.push({ value: 'radio', label: 'Radio mix (from this track)' });
  }
  items.push({ value: 'autoplay', label: `Autoplay: ${session.autoplay ? 'on' : 'off'}` });
  items.push({ value: 'replay', label: media.kind === 'music' ? 'Replay track' : 'Replay' });
  items.push({ value: 'provider', label: 'Try another source' });
  items.push({ value: 'quit', label: 'Done' });

  const action = await select({ title: media.title, subtitle: 'What next?', items });
  return { action, next };
}
