#!/usr/bin/env node
// fahy-cli — anime + YouTube + music terminal player (kunai-inspired).
// Search -> pick -> play in mpv (audio-only for music) / download via yt-dlp.
// History + downloads + favorites persist in ~/.config/fahy-cli (JSON).
import { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { searchAnime, ytMix, formatDuration } from './metadata.js';
import { forKind, getProvider, providers, orderProviders, providerTags } from './providers/registry.js';

import { parseVideoId } from './providers/youtube.js';
import { hasMpv, playUrl, playFile, prescreenEmbed } from './player.js';
import { hasYtDlp, downloadSource, guessFile, defaultDownloadDir, defaultMusicDir, freeSpaceBytes } from './downloader.js';
import {
  getHistory, addHistory, clearHistory, removeHistory, updateHistory, getDownloads, addDownload,
  setDownloadStatus, getCompletedDownloads, getFavorites, toggleFavorite,
  getPlaylists, getPlaylist, playlistAdd, playlistClear, saveRun, historyToMedia,
  getHealth, recordHealth, healthBlocked, resetHealth, shouldAutoPin, scoreOf,
  getSourceSync, setSourceSync, getUpdateState, setUpdateState,
} from './store.js';
import { loadConfig, saveConfig, configPath } from './config.js';
import {
  startShell, stopShell, suspendShell, resumeShell, shellActive,
  shellLog, shellStatus, shellSearch, shellMenu, shellError, shellNowPlaying,
  setShellConfig,
} from './tui/shell.js';
import { runSearchTui } from './tui/search.js'; // flag-mode one-off screens (shell owns TUI mode)
import { classifyFailure } from './failure.js';
import { installedVersion, needsUpdate, latestVersion, upgrade } from './update.js';
import { probeUrl, probePassesForPlayback } from './probe.js';
import { MusicPlayer } from './mplayer.js';
import { fetchFmhyAnimeSites, diffFmhySources } from './sources.js';

const program = new Command();
program
  .name('fahy')
  .version(installedVersion())
  .description('Anime, YouTube and music terminal player (mpv-only)')
  .option('-S, --search <query>', 'search query')
  .option('-a, --anime', 'anime mode (AniList + anime providers)')
  .option('-y, --youtube', 'YouTube mode (video)')
  .option('-m, --music', 'music mode (YouTube audio-only)')
  .option('-t, --type <kind>', 'media type: anime|youtube|music', 'anime')
  .option('--url <url>', 'YouTube watch URL or video id (skips search)')
  .option('--episode <n>', 'episode number (anime)', '1')
  .option('--provider <id>', 'provider id')
  .option('--dub', 'prefer English dub audio for anime (default: sub)')
  .option('--mpv-clean', 'launch mpv with --no-config (rules out local mpv.conf conflicts)')
  .option('--mpv-log <file>', 'write mpv log to file (evidence for bug reports)')
  .option('--prune', 'drop download/library entries whose files no longer exist')
  .option('--no-fallback', 'strict mode: only the chosen provider, no auto-fallback')
  .option('--print-url', 'print resolved URL instead of playing')
  .option('--download', 'download via yt-dlp instead of playing')
  .option('--download-path <dir>', 'download directory for this run')
  .option('--downloads', 'list download queue')
  .option('--history', 'show watch history (tick entries to delete, in a terminal)')
  .option('--clear-history', 'clear watch history')
  .option('--continue', 'resume most recent history entry')
  .option('--radio', 'play a radio mix seeded from --url or the latest history entry')
  .option('--favorite', 'toggle favorite on the latest history entry')
  .option('--favorites', 'list favorites')
  .option('--playlist <name>', 'play a saved playlist')
  .option('--playlist-add <name>', 'add the latest history entry to a playlist')
  .option('--playlists', 'list saved playlists')
  .option('--playlist-clear <name>', 'delete a saved playlist')
  .option('--shuffle [mode]', 'shuffle on|off (bare flag toggles, session + saved)')
  .option('--repeat <mode>', 'repeat off|one|all (session + saved)')
  .option('--autoplay', 'auto-advance to next episode/track after clean playback')
  .option('--volume <v>', 'volume 0-100 or +N/-N (saved, passed to mpv)')
  .option('--now', 'show current track (latest history + modes)')
  .option('--offline', 'browse completed downloads (library) and play locally')
  .option('--library', 'alias for --offline')
  .option('--list-providers', 'list all provider adapters')
  .option('--set-default-provider <kind=id>', 'e.g. --set-default-provider anime=hianime', collect, [])
  .option('--set-priority <kind=id1,id2>', 'e.g. --set-priority anime=hianime,anikoto (fallback order)')
  .option('--provider-health', 'show per-provider health memory')
  .option('--reset-health [id]', 'forget health memory (one provider, or all)')
  .option('--upgrade [version]', 'upgrade fahy (latest, or pin: --upgrade 0.6.2)')
  .option('--auto-update [mode]', 'update policy: notice|install|off (default notice)')
  .option('--uninstall', 'remove the global fahy install (add --purge for config too)')
  .option('--purge', 'with --uninstall: also delete ~/.config/fahy-cli')
  .option('--check-sources', 'diff anime providers against live FMHY list + probe health')
  .option('--update-sources', 'check sources and auto-pin the fastest healthy anime provider')
  .option('--diagnostics', 'show the last run: providers tried, failures, trail')
  .option('--doctor', 'check mpv/yt-dlp/config health')
  .option('--setup', 'guided setup: health check (kunai-style)')
  .option('--debug', 'verbose resolve logging')
  .parse(process.argv);

function collect(v, acc) {
  acc.push(v);
  return acc;
}

// Piping to head/short-lived readers closes stdout early (EPIPE). Swallow it
// and let the loop drain: force-exiting here trips a libuv assertion on
// Windows (async.c) because handles are still mid-flight.
let brokenPipe = false;
process.stdout.on('error', (e) => {
  if (e?.code === 'EPIPE') {
    brokenPipe = true;
    process.exitCode = 0;
    return;
  }
  throw e;
});
process.stderr.on('error', () => {});

const opts = program.opts();
const config = loadConfig();
const debug = !!opts.debug;
const AUTO_UPDATE_MODES = ['notice', 'install', 'off'];
// kunai-style bare commands: `fahy upgrade`, `fahy uninstall [--purge]`.
// (program.args holds positionals commander didn't consume as options.)
{
  const bare = program.args.map(String);
  if (opts.upgrade === undefined && bare.includes('upgrade')) opts.upgrade = true;
  if (!opts.uninstall && bare.includes('uninstall')) opts.uninstall = true;
}
// Module scope on purpose: sessionLoop/postPlayMenu/finish all read this.
// (Declaring it inside main() crashed every TUI session with
// "useTuiShell is not defined" the moment a menu rendered.)
let useTuiShell = false;
// Session playback modes (ym parity): flags set them now and persist.
const session = {
  shuffle: !!config.shuffle,
  repeat: ['off', 'one', 'all'].includes(config.repeat) ? config.repeat : 'off',
  autoplay: !!opts.autoplay || !!config.autoplay,
};
function persistModes() {
  saveConfig({ ...config, shuffle: session.shuffle, repeat: session.repeat });
}
if (opts.shuffle !== undefined) {
  const v = typeof opts.shuffle === 'string' ? opts.shuffle.toLowerCase() : null;
  if (v !== null && v !== 'on' && v !== 'off') {
    console.error(chalk.red('shuffle takes on|off (or bare flag toggles).'));
    process.exit(1);
  }
  session.shuffle = v === null ? !session.shuffle : v === 'on';
  persistModes();
  console.log(`Shuffle ${session.shuffle ? chalk.green('on') : 'off'}.`);
}
if (opts.repeat) {
  const v = String(opts.repeat).toLowerCase();
  if (!['off', 'one', 'all'].includes(v)) {
    console.error(chalk.red('repeat takes off|one|all.'));
    process.exit(1);
  }
  session.repeat = v;
  persistModes();
  console.log(`Repeat ${v}.`);
}
if (opts.volume !== undefined) {
  const raw = String(opts.volume);
  const cur = Number(config.volume ?? 100) || 0;
  let next;
  if (/^[+-]\d+$/.test(raw)) next = cur + Number(raw);
  else if (/^\d+$/.test(raw)) next = Number(raw);
  else {
    console.error(chalk.red('volume takes 0-100 or +N/-N.'));
    process.exit(1);
  }
  next = Math.max(0, Math.min(100, next));
  saveConfig({ ...config, volume: next });
  config.volume = next;
  console.log(`Volume ${next}.`);
}
if (opts.autoUpdate !== undefined) {
  // `fahy --auto-update` shows the policy; `--auto-update <mode>` sets it.
  const cur = AUTO_UPDATE_MODES.includes(config.autoUpdate) ? config.autoUpdate : 'notice';
  const mode = typeof opts.autoUpdate === 'string' && opts.autoUpdate ? opts.autoUpdate.toLowerCase() : null;
  if (mode !== null && !AUTO_UPDATE_MODES.includes(mode)) {
    console.error(chalk.red('auto-update takes notice|install|off.'));
    process.exit(1);
  }
  if (mode !== null) {
    saveConfig({ ...config, autoUpdate: mode });
    config.autoUpdate = mode;
    console.log(`Auto-update: ${mode}.`);
  } else {
    const hints = { notice: ' — notify when a new version exists', install: ' — apply updates automatically', off: ' — never check automatically' };
    console.log(`Auto-update: ${cur}${hints[cur]}.`);
  }
}
// Bare mode flags behave like ym control commands: apply + exit, unless
// combined with something to play.
if (
  (opts.volume !== undefined || opts.shuffle !== undefined || opts.repeat || opts.autoUpdate !== undefined) &&
  !opts.search && !opts.url && !opts.continue && !opts.radio &&
  !opts.download && !opts.printUrl && !opts.playlist && !opts.offline && !opts.library
) {
  process.exit(0);
}
const kind = opts.anime ? 'anime' : opts.youtube ? 'youtube' : opts.music ? 'music' : opts.type || 'anime';
if (!['anime', 'youtube', 'music'].includes(kind)) {
  console.error(chalk.red(`Bad type: ${kind}. Use anime|youtube|music.`));
  process.exit(1);
}
const interactive = process.stdin.isTTY && !opts.printUrl;
let lastList = []; // session queue source for Next/radio (youtube/music results)

// Shell-aware feedback: inside the persistent shell, spinners become the
// status line and progress lines append to the transcript (the layout never
// moves). Everywhere else, ora/console as before.
function startSpin(text) {
  if (shellActive()) {
    shellStatus(text);
    return { stop: () => shellStatus(null), start() {} };
  }
  if (useTuiShell) return { stop() {}, start() {} };
  return ora(text).start();
}

function tlog(text, kind = 'dim') {
  if (shellActive()) shellLog(text, kind);
  else if (kind === 'warn') console.log(chalk.yellow(text));
  else if (kind === 'ok') console.log(chalk.green(text));
  else if (kind === 'error') console.log(chalk.red(text));
  else if (kind === 'raw') console.log(text);
  else console.log(chalk.dim(text));
}

// mpv owns the terminal while playing: suspend the shell first so Ink never
// fights it for stdin/stdout, then resume the identical screen after.
async function withShellSuspended(fn) {
  const active = shellActive();
  if (active) suspendShell();
  try {
    return await fn();
  } finally {
    if (active) resumeShell();
  }
}

if (opts.setDefaultProvider?.length) {
  const dp = { ...(config.defaultProvider || {}) };
  for (const kv of opts.setDefaultProvider) {
    const [k, v] = String(kv).split('=');
    if (!getProvider(v) || !['anime', 'youtube', 'music'].includes(k)) {
      console.error(chalk.red(`Bad value: ${kv}. Use kind=id, e.g. anime=hianime`));
      process.exit(1);
    }
    dp[k] = v;
  }
  saveConfig({ ...config, defaultProvider: dp });
  console.log(chalk.green(`Saved defaults to ${configPath()}`));
  process.exit(0);
}
if (opts.setPriority) {
  // Accept "anime=hianime,anikoto" (quote it in PowerShell — bare commas split
  // into separate args there) and tolerate the split form too.
  const raw = Array.isArray(opts.setPriority) ? opts.setPriority.join(' ') : String(opts.setPriority);
  const stray = (program.args || []).map(String).join(' ');
  const eq = raw.indexOf('=');
  const k = raw.slice(0, eq);
  const list = (raw.slice(eq + 1) + ' ' + stray).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!['anime', 'youtube', 'music'].includes(k) || !list.length || list.some((id) => !getProvider(id)?.kinds.includes(k))) {
    console.error(chalk.red(`Bad value: ${raw}. Use kind=id1,id2, e.g. "anime=hianime,anikoto"`));
    process.exit(1);
  }
  saveConfig({ ...config, providerPriority: { ...(config.providerPriority || {}), [k]: list } });
  console.log(chalk.green(`Saved priority for ${k}: ${list.join(' → ')}`));
  process.exit(0);
}
if (opts.providerHealth) {
  const h = getHealth();
  const ids = [...new Set([...providers.map((p) => p.id), ...Object.keys(h)])];
  if (!ids.length) console.log('No health data yet — play something first.');
  for (const id of ids) {
    const c = h[id];
    if (!c) {
      console.log(`${id.padEnd(14)} no data`);
      continue;
    }
    const blocked = healthBlocked(id) ? chalk.red(' SKIPPED (unhealthy)') : '';
    console.log(`${id.padEnd(14)} ok ${c.ok} · fail ${c.fail} · streak ${c.consecFail}${c.lastMs != null ? ` · ${c.lastMs}ms` : ''} · score ${scoreOf(c).rel.toFixed(2)}${blocked}`);
  }
  process.exit(0);
}
if (opts.resetHealth !== undefined) {
  const id = typeof opts.resetHealth === 'string' && opts.resetHealth ? opts.resetHealth : null;
  if (id && !getProvider(id)) {
    console.error(chalk.red(`Unknown provider: ${id}`));
    process.exit(1);
  }
  resetHealth(id);
  console.log(chalk.green(id ? `Forgot health for ${id} — it rejoins the cycle.` : 'Forgot all provider health.'));
  process.exit(0);
}
if (opts.listProviders) {
  const lane = (x) => (x.direct ? 'direct' : x.kinds[0] === 'youtube' || x.kinds[0] === 'music' ? 'ytdl' : 'embed');
  for (const x of providers) {
    console.log(`${x.id.padEnd(14)} ${lane(x).padEnd(7)} ${x.kinds.join(',').padEnd(14)} ${x.name} — ${x.site || ''}`);
  }
  console.log('\nMetadata only (search, no streams): AniList + yt-dlp + Invidious.');
  process.exit(0);
}
if (opts.doctor || opts.setup) {
  console.log(`mpv:      ${hasMpv() ? chalk.green('found') : chalk.red('missing — winget install --id mpv-player.mpv-CI.MSVC -e')}`);
  console.log(`yt-dlp:   ${hasYtDlp() ? chalk.green('found') : chalk.red('missing — required for YouTube/music/download — winget install --id yt-dlp.yt-dlp -e')}`);
  const { discoverCurl } = await import('./net.js');
  const curl = discoverCurl();
  console.log(`transport:${curl ? chalk.green(` ${curl.impersonates ? `curl-impersonate (${curl.profile})` : 'plain curl'}`) : chalk.yellow(' no curl found')}`);
  try {
    const { fetchText } = await import('./net.js');
    await fetchText('https://hianime.at/search?keyword=test', { userAgent: 'Mozilla/5.0', referer: 'https://hianime.at/', timeoutMs: 8000 });
    console.log(`hianime:  ${chalk.green('reachable (direct anime streams)')}`);
  } catch (e) {
    console.log(`hianime:  ${chalk.yellow(`blocked here (${e.message.slice(0, 80)}) — auto-fallback covers it`)}`);
  }
  console.log(`config:   ${configPath()}`);
  console.log(`downloads:${config.downloadPath || defaultDownloadDir()}`);
  console.log(`music:    ${defaultMusicDir()}`);
  console.log(`version:  ${installedVersion()}`);
  try {
    const latest = await latestVersion({ timeoutMs: 6000, debug });
    console.log(`latest:   ${latest}${needsUpdate(installedVersion(), latest) ? chalk.yellow(' — update available (fahy upgrade)') : chalk.green(' (current)')}`);
  } catch {
    console.log(`latest:   ${chalk.yellow('unreachable (offline? — fahy upgrade retries)')}`);
  }
  if (opts.setup && (!hasMpv() || !hasYtDlp())) {
    console.log(chalk.dim('\nInstall the missing tools above, then: fahy -S "<title>"'));
  } else if (opts.setup) {
    console.log(chalk.dim('\nReady. Try: fahy  (TUI)  or  fahy -m -S "<song>"'));
  }
  // No process.exit() here: force-exiting while the probe socket tears down
  // trips a Windows libuv assertion. Drain, then fall through (main is gated).
  process.exitCode = 0;
  await new Promise((r) => setTimeout(r, 2500));
  globalThis.__fahyDone = true;
}
if (opts.upgrade !== undefined) {
  // Channel-aware like kunai: a linked source checkout upgrades via git,
  // a registry install via npm. `upgrade()` shares the auto-update engine.
  const want = typeof opts.upgrade === 'string' && opts.upgrade ? opts.upgrade : 'latest';
  console.log(want === 'latest' ? 'Checking for updates…' : `Upgrading fahy-cli to ${want}…`);
  const res = upgrade({ wanted: want, debug, verbose: true });
  if (res.ok) {
    console.log(chalk.green(res.message));
    // A successful upgrade implies newest — reset the daily window so the
    // auto-check does not re-notify about the version we just installed.
    try {
      setUpdateState({ lastCheck: new Date().toISOString(), lastVersion: installedVersion() });
    } catch {}
    process.exit(0);
  }
  console.log(chalk.yellow(res.message));
  process.exit(1);
}
if (opts.uninstall) {
  console.log('Removing global fahy-cli…');
  const r = spawnSync('npm', ['uninstall', '-g', 'fahy-cli'], { stdio: 'inherit', shell: false });
  if (opts.purge) {
    // Purge the current dir plus the pre-rename legacy dir (rename orphan).
    for (const dir of [join(homedir(), '.config', 'fahy-cli'), join(homedir(), '.config', 'fmhy-cli')]) {
      try {
        rmSync(dir, { recursive: true, force: true });
        console.log(chalk.green(`Purged ${dir}`));
      } catch (e) {
        console.log(chalk.yellow(`Could not purge ${dir}: ${e.message}`));
      }
    }
  } else {
    console.log(chalk.dim(`Kept ${join(homedir(), '.config', 'fahy-cli')} (use --purge to delete it).`));
  }
  process.exit(r.status ?? 1);
}
if (opts.diagnostics) {
  const { getLastRun } = await import('./store.js');
  const run = getLastRun();
  if (!run?.events?.length) {
    console.log('No recorded runs yet — play something first.');
    process.exit(0);
  }
  console.log(chalk.dim(`Last run: ${run.title || ''} (${run.at})`));
  for (const e of run.events.slice(-30)) {
    const icon = e.ok === true ? chalk.green('✓') : e.ok === false ? chalk.red('✕') : chalk.dim('·');
    console.log(`  ${icon} ${e.provider || ''}${e.detail ? ` — ${e.detail}` : ''}`);
  }
  process.exit(0);
}
if (opts.prune) {
  const { pruneMissing } = await import('./store.js');
  const n = pruneMissing();
  console.log(n ? chalk.green(`Pruned ${n} stale entr${n === 1 ? 'y' : 'ies'}.`) : 'Nothing stale — library matches disk.');
  process.exit(0);
}
if (opts.checkSources || opts.updateSources) {
  const { fetchFmhyAnimeSites, matchCoverage, probeProviders, bestProvider } = await import('./sources.js');
  const spin = startSpin('Checking FMHY sources…');
  let fmhy;
  try {
    fmhy = await fetchFmhyAnimeSites({ debug });
  } catch (e) {
    spin.stop();
    throw new Error(`FMHY check failed: ${e.message}`);
  }
  spin.stop();
  // A manual check counts as a sync — resets the daily-watch timer.
  try {
    setSourceSync({ lastCheck: new Date().toISOString(), knownHosts: fmhy.map((s) => s.host) });
  } catch {}
  const anime = providers.filter((p) => p.kinds.includes('anime'));
  const coverage = matchCoverage(fmhy, anime);
  console.log(chalk.dim(`Probing ${anime.length} providers (this takes a few seconds)…`));
  const health = await probeProviders(anime);
  const byId = Object.fromEntries(health.map((h) => [h.id, h]));
  console.log(chalk.dim(`FMHY anime sites: ${fmhy.length}`));
  for (const c of coverage) {
    const h = byId[c.id];
    const dot = h?.status === 'reachable' ? chalk.green('●') : h?.status === 'timeout' ? chalk.yellow('●') : chalk.red('●');
    const ms = h?.ms != null ? ` ${h.ms}ms` : '';
    const note =
      c.status === 'drift' ? chalk.yellow(` — FMHY now lists: ${c.fmhy.map((f) => f.host).join(', ')}`)
      : c.status === 'missing' ? chalk.red(' — not on FMHY')
      : '';
    console.log(`  ${dot} ${c.name} (${h?.status || '?'}${ms})${note}`);
  }
  const covered = new Set(coverage.flatMap((c) => c.fmhy));
  const extra = fmhy.filter((f) => !covered.has(f));
  if (extra.length) {
    console.log(chalk.dim('\nOn FMHY but not covered (embed-only candidates):'));
    extra.slice(0, 15).forEach((f) => console.log(chalk.dim(`  - ${f.name} — ${f.url}`)));
    if (extra.length > 15) console.log(chalk.dim(`  …and ${extra.length - 15} more`));
  }
  if (opts.updateSources) {
    const best = bestProvider(health);
    if (!best) {
      console.log(chalk.yellow('\nNo healthy anime provider — default unchanged.'));
    } else if ((config.defaultProvider || {}).anime !== best.id) {
      saveConfig({ ...config, defaultProvider: { ...(config.defaultProvider || {}), anime: best.id } });
      console.log(chalk.green(`\nDefault anime provider → ${best.id} (${best.ms}ms).`));
    } else {
      console.log(chalk.dim(`\nDefault anime provider already ${best.id} (fastest).`));
    }
  }
  process.exit(0);
}
if (opts.downloads) {
  const q = getDownloads();
  if (!q.length) console.log('Download queue is empty.');
  for (const d of q) console.log(`[${d.status}] ${label(d)} — ${d.url}`);
  process.exit(0);
}
if (opts.history) {
  const h = getHistory();
  if (!h.length) console.log('No history yet.');
  else if (interactive) {
    // Interactive: tick entries to delete, or wipe everything.
    const list = h.slice(0, 20);
    const pick = await p.multiselect({
      message: 'History (space to tick, enter to delete ticked):',
      options: [
        ...list.map((e, i) => ({ value: e.url, label: `${i + 1}. ${label(e)}`, hint: e.at || '' })),
        { value: '__clear__', label: 'CLEAR ALL HISTORY' },
      ],
      required: false,
    });
    if (!p.isCancel(pick) && pick.length) {
      if (pick.includes('__clear__')) {
        clearHistory();
        console.log(chalk.green('History cleared.'));
      } else {
        const n = removeHistory(pick);
        console.log(chalk.green(`Deleted ${n} entr${n === 1 ? 'y' : 'ies'}.`));
      }
    }
  } else {
    h.slice(0, 20).forEach((e, i) => console.log(`${i + 1}. ${label(e)} (${e.at})`));
  }
  process.exit(0);
}
if (opts.clearHistory) {
  clearHistory();
  console.log('History cleared.');
  process.exit(0);
}
if (opts.favorite) {
  const h = getHistory();
  if (!h.length) {
    console.log('No history yet — play something first.');
    process.exit(0);
  }
  const on = toggleFavorite(h[0]);
  console.log(on ? chalk.green(`Favorited: ${h[0].title}`) : `Unfavorited: ${h[0].title}`);
  process.exit(0);
}
if (opts.favorites) {
  const f = getFavorites();
  if (!f.length) console.log('No favorites yet. Play something, then: fahy --favorite');
  f.forEach((e, i) => console.log(`${i + 1}. ${label(e)} — ${e.url}`));
  process.exit(0);
}
if (opts.playlists) {
  const all = getPlaylists();
  const names = Object.keys(all);
  if (!names.length) console.log('No playlists yet. Play something, then: fahy --playlist-add <name>');
  names.forEach((n) => console.log(`${n} (${all[n].length} tracks)`));
  process.exit(0);
}
if (opts.playlistAdd) {
  const h = getHistory();
  if (!h.length || !h[0].url) {
    console.log('Nothing to add — play something first.');
    process.exit(0);
  }
  const n = playlistAdd(opts.playlistAdd, h[0]);
  console.log(chalk.green(`Added to '${opts.playlistAdd}' (${n} tracks).`));
  process.exit(0);
}
if (opts.playlistClear) {
  console.log(playlistClear(opts.playlistClear) ? `Deleted playlist '${opts.playlistClear}'.` : `No playlist named '${opts.playlistClear}'.`);
  process.exit(0);
}
if (opts.now) {
  const h = getHistory();
  if (!h.length) console.log('Nothing played yet.');
  else console.log(`${label(h[0])}\nvolume ${config.volume ?? 100} · shuffle ${config.shuffle ? 'on' : 'off'} · repeat ${config.repeat || 'off'}`);
  process.exit(0);
}
if (opts.offline || opts.library) {
  await offlineLibrary();
  process.exit(0);
}

// Daily FMHY watcher: once per 24h (interactive runs only — pipes stay pure
// and fast), diff our anime lane against the live FMHY list. New sites are
// SURFACED, never silently added (they need real adapters); drift/missing
// notes explain why a provider vanished. A manual --check-sources counts as
// a sync (it records state too). Failures are silent — tomorrow retries.
const FMHY_SYNC_MS = 24 * 3600 * 1000;
async function maybeDailyFmhySync({ background = false } = {}) {
  if (!process.stdin.isTTY || opts.printUrl) return;
  let state = {};
  try {
    state = getSourceSync();
  } catch {
    return;
  }
  if (state.lastCheck && Date.now() - Date.parse(state.lastCheck) < FMHY_SYNC_MS) return;
  const run = (async () => {
    const fmhy = await fetchFmhyAnimeSites({ timeoutMs: 12000, debug });
    const animeProviders = providers.filter((p) => p.kinds.includes('anime'));
    const { drifted, fresh } = diffFmhySources(fmhy, animeProviders);
    const known = new Set(state.knownHosts || []);
    const newlySeen = fresh.filter((s) => !known.has(s.host));
    setSourceSync({ lastCheck: new Date().toISOString(), knownHosts: fmhy.map((s) => s.host) });
    if (newlySeen.length) {
      const names = newlySeen.slice(0, 5).map((s) => s.name).join(', ');
      tlog(`New on FMHY (not supported yet): ${names}${newlySeen.length > 5 ? ` +${newlySeen.length - 5} more` : ''}`, 'warn');
    }
    for (const d of drifted.filter((x) => x.status === 'drift')) {
      tlog(`FMHY drift: ${d.name} now lists ${d.fmhy.map((f) => f.host).join(', ')}`, 'warn');
    }
    for (const d of drifted.filter((x) => x.status === 'missing')) {
      tlog(`FMHY watch: ${d.name} no longer listed — fallback covers it`, 'warn');
    }
  })();
  if (background) {
    run.catch(() => {});
  } else {
    try {
      await run;
    } catch (e) {
      if (debug) console.error(`[fahy-sync] ${e.message}`);
    }
  }
}

// Daily update watcher: once per 24h on interactive runs, ask the npm
// registry if a newer version exists. 'notice' (default) prints one line
// pointing at `fahy upgrade`; 'install' applies it in place, quietly, so npm
// never paints over the running shell; 'off' disables checks. Failures are
// silent — tomorrow retries. A manual --upgrade resets the window.
const UPDATE_CHECK_MS = 24 * 3600 * 1000;
async function maybeCheckForUpdates({ config: cfg, background = false } = {}) {
  if (!process.stdin.isTTY || opts.printUrl) return;
  const mode = AUTO_UPDATE_MODES.includes(cfg?.autoUpdate) ? cfg.autoUpdate : 'notice';
  if (mode === 'off') return;
  let state = {};
  try {
    state = getUpdateState();
  } catch {
    return;
  }
  if (state.lastCheck && Date.now() - Date.parse(state.lastCheck) < UPDATE_CHECK_MS) return;
  const run = (async () => {
    const current = installedVersion();
    let latest;
    try {
      latest = await latestVersion({ timeoutMs: 8000, debug });
    } catch {
      setUpdateState({ lastCheck: new Date().toISOString(), lastVersion: state.lastVersion });
      return;
    }
    setUpdateState({ lastCheck: new Date().toISOString(), lastVersion: latest });
    if (!needsUpdate(current, latest)) return;
    if (mode === 'install') {
      tlog(`Updating fahy ${current} → ${latest}…`, 'dim');
      const res = upgrade({ wanted: latest, debug });
      tlog(res.ok ? `Updated to ${latest}. Restart fahy to use it.` : `Update failed: ${res.message}`, res.ok ? 'ok' : 'warn');
      return;
    }
    tlog(`Update available: fahy v${current} → v${latest} — run \`fahy upgrade\` to apply.`, 'warn');
  })();
  if (background) {
    run.catch(() => {});
  } else {
    try {
      await run;
    } catch (e) {
      if (debug) console.error(`[fahy-update] ${e.message}`);
    }
  }
}

function label(e) {
  const tag = e.kind === 'anime' && e.episode ? ` E${e.episode}` : '';
  const dur = e.duration ? ` (${formatDuration(e.duration)})` : '';
  let prog = '';
  if (e.duration && e.watchedMs) {
    const pct = Math.min(99, Math.round((e.watchedMs / 1000 / e.duration) * 100));
    prog = e.completed ? ' · done' : pct > 3 ? ` · ${pct}%` : '';
  } else if (e.completed) {
    prog = ' · done';
  }
  return `${e.title}${tag}${dur}${prog} [${e.provider}]`;
}

async function offlineLibrary() {
  const done = getCompletedDownloads();
  if (!done.length) {
    console.log('Library is empty. Queue one with: fahy -S "<title>" --download');
    return;
  }
  if (!interactive) {
    done.forEach((d, i) => console.log(`${i + 1}. ${label(d)} -> ${d.file}`));
    return;
  }
  p.intro('Offline library');
  const pick = await p.select({ message: 'Play a download:', options: done.map((d, i) => ({ value: i, label: label(d), hint: d.file })) });
  if (p.isCancel(pick)) return;
  const d = done[Number(pick)];
  if (!existsSync(d.file)) return p.cancel(`File missing: ${d.file}`);
  if (!hasMpv()) return p.cancel('mpv not found.');
  await playFile(d.file, { volume: config.volume ?? 100, clean: opts.mpvClean, logFile: opts.mpvLog, debug });
  p.outro('Done.');
}

function trackLabel(t) {
  const dur = t.duration ? ` (${formatDuration(t.duration)})` : '';
  return `${t.title}${dur}`;
}
function trackHint(t) {
  const bits = [t.author, t.views ? `${Number(t.views).toLocaleString()} views` : null].filter(Boolean);
  return bits.join(' · ');
}

async function pickTitle(query, kind) {
  if (opts.url) {
    const id = parseVideoId(opts.url);
    if (!id) throw new Error('Could not parse a YouTube video id from --url.');
    if (kind !== 'youtube' && kind !== 'music') throw new Error('--url only works with youtube/music modes.');
    return { kind, videoId: id, title: opts.url, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (kind === 'anime') {
    const spin = startSpin('Searching AniList…');
    let results;
    try {
      results = await searchAnime(query);
    } catch (e) {
      spin.stop();
      throw e;
    }
    spin.stop();
    if (!results.length) throw new Error('No anime found.');
    if (!interactive) return { ...results[0], episode: Number(opts.episode) || 1 };
    const pick = await p.select({
      message: 'Pick a title:',
      options: results.map((r, i) => ({
        value: i,
        label: `${r.title} (${r.year || '?'})`,
        hint: `${r.format || ''} · ${r.episodes || '?'} eps`,
      })),
    });
    if (p.isCancel(pick)) throw new Error('cancelled');
    const sel = results[pick];
    const media = { ...sel, episode: Number(opts.episode) || 1 };
    if ((sel.episodes || 0) > 1 && opts.episode === '1' && !opts.download && interactive) {
      const ep = await p.text({ message: `Episode (1-${sel.episodes}):`, initialValue: '1' });
      if (!p.isCancel(ep)) media.episode = Math.max(1, Number(ep) || 1);
    }
    return media;
  }
  // youtube / music
  const provider = getProvider(kind === 'music' ? 'ytmusic' : 'youtube');
  const spin = startSpin(kind === 'music' ? 'Searching music…' : 'Searching YouTube…');
  let results;
  try {
    results = await provider.search(query, { debug });
    spin.stop();
  } catch (e) {
    spin.stop();
    throw e;
  }
  if (!results.length) throw new Error('No results.');
  lastList = results.map((r) => ({ ...r, kind }));
  if (!interactive) return { ...lastList[0] };
  const pick = await p.select({
    message: 'Pick:',
    options: lastList.map((r, i) => ({ value: i, label: trackLabel(r), hint: trackHint(r) })),
  });
  if (p.isCancel(pick)) throw new Error('cancelled');
  return { ...lastList[Number(pick)] };
}

// Provider option labels with best/unhealthy markers from observed health
// (same tags as the shell picker — one shared helper, no drift).
function providerTagsFor(list) {
  return providerTags(list, { health: getHealth(), isBlocked: (id) => healthBlocked(id) });
}
function providerLabel(x, defId, tags) {
  const bits = [];
  if (x.id === defId) bits.push('default');
  if (tags[x.id]) bits.push(tags[x.id]);
  return bits.length ? `${x.name} (${bits.join(', ')})` : x.name;
}

async function pickProvider(media) {
  const avail = forKind(media.kind);
  let provider = opts.provider ? getProvider(opts.provider) : null;
  if (provider && provider.kinds.includes(media.kind)) return provider;
  if (opts.provider) throw new Error(`Unknown/incompatible provider: ${opts.provider} (see --list-providers)`);
  if (avail.length === 1) return avail[0]; // youtube/music have one lane each
  if (!interactive) return getProvider(config.defaultProvider?.[media.kind]) || avail[0];
  const defId = config.defaultProvider?.[media.kind];
  const tags = providerTagsFor(avail);
  if (shellActive()) {
    const v = await shellMenu(`Provider for "${media.title}"`, avail.map((x) => ({ label: providerLabel(x, defId, tags), value: x.id })));
    if (v == null) throw new Error('cancelled');
    return getProvider(String(v));
  }
  const pick = await p.select({
    message: `Provider for "${media.title}":`,
    options: avail.map((x) => ({ value: x.id, label: x.name, hint: [x.id === defId ? 'default' : '', tags[x.id] || ''].filter(Boolean).join(' · ') })),
  });
  if (p.isCancel(pick)) throw new Error('cancelled');
  return getProvider(String(pick));
}

async function resolveMedia(provider, media) {
  const spin = startSpin(`Resolving ${provider.name}…`);
  try {
    if (media.kind === 'anime' && !media.anime) media.anime = { ...media };
    // NOTE: no trailing ...media spread — it used to overwrite episode {number}
    // with the plain episode number and produced `undefined` URLs.
    const input =
      media.kind === 'anime'
        ? { title: media.title, anilistId: media.anilistId, anime: media.anime || media, episode: media.episodeRef || { number: media.episode } }
        : { videoId: media.videoId, url: media.url, title: media.title };
    const out = await provider.resolve(input, { debug, audio: opts.dub ? 'dub' : 'sub' });
    spin.stop();
    return out;
  } catch (e) {
    spin.stop();
    throw e;
  }
}

async function main() {
  // Bare `fahy` in a real terminal -> fullscreen search TUI (kunai-style).
  // TAB cycles anime/youtube/music, no -S needed. Flags bypass the TUI.
  const wantsTui =
    !opts.search && !opts.url && !opts.continue && !opts.radio &&
    !opts.playlist && !opts.offline && !opts.library && !opts.downloads && !opts.history &&
    !opts.clearHistory && !opts.favorite && !opts.favorites &&
    !opts.listProviders && !opts.download && !opts.diagnostics && !opts.checkSources && !opts.updateSources &&
    process.stdin.isTTY && process.stdout.isTTY;
  // Persistent shell mode: one root for the session — home, pickers, menus,
  // errors, now-playing. mpv borrows the terminal; the identical screen returns.
  if (wantsTui) {
    useTuiShell = true;
    setShellConfig(config);
    startShell(kind);
    void maybeDailyFmhySync({ background: true }); // notices land in the transcript when done
    void maybeCheckForUpdates({ config, background: true });
    const bye = (code) => {
      stopShell();
      process.exit(code);
    };
    try {
      for (;;) {
        const res = await shellSearch({ home: true });
        if (!res) bye(0);
        const provider = getProvider(res.providerId);
        if (!provider) throw new Error(`Unknown provider: ${res.providerId}`);
        await sessionLoop(res.media, provider);
        // Post-play Quit/ESC returns here — back to the homepage shell,
        // never a frozen frame or a dead process. Home Quit exits.
      }
    } catch (e) {
      stopShell(); // fatal errors print on the real screen, not the alt one
      throw e;
    }
  }

  if (interactive) p.intro(chalk.bold('fahy — anime · youtube · music in mpv'));

  let media;
  let provider;
  if (opts.continue) {
    // Skip retired movie/tv entries — resume the newest playable entry.
    const h = getHistory().find((e) => ['anime', 'youtube', 'music'].includes(e.kind));
    if (!h) throw new Error('No resumable history — play some anime, YouTube or music first.');
    const resumed = historyToMedia(h);
    if (!resumed) throw new Error('Latest history entry is from a retired lane.');
    tlog(`Resuming: ${label(h)}`);
    media = { ...resumed.media };
    if (!opts.provider && resumed.providerId) opts.provider = resumed.providerId;
    provider = await pickProvider(media);
  } else if (opts.radio) {
    ({ media, provider } = await seedRadio());
  } else if (opts.playlist) {
    const list = getPlaylist(opts.playlist);
    if (!list.length) throw new Error(`Playlist '${opts.playlist}' is empty or missing. Add tracks: fahy --playlist-add ${opts.playlist}`);
    lastList = list.map((t) => ({ ...t }));
    media = { ...lastList[0] };
    provider = getProvider(media.kind === 'music' ? 'ytmusic' : media.kind === 'youtube' ? 'youtube' : 'hianime') || (await pickProvider(media));
  } else {
      const query = opts.search;
      if (!query && !opts.url) {
        if (!interactive) throw new Error('Need -S <query>, --url, or --radio.');
        const q = await p.text({ message: `Search ${kind}:`, placeholder: kind === 'anime' ? 'Frieren' : kind === 'music' ? 'song or artist' : 'video' });
        if (!q || typeof q !== 'string') throw new Error('cancelled');
        media = await pickTitle(q, kind);
      } else {
        media = await pickTitle(query, kind);
      }
      provider = await pickProvider(media);
    }
  await maybeDailyFmhySync(); // stale-day check before playback (fast when fresh)
  await maybeCheckForUpdates({ config });
  await sessionLoop(media, provider);
}

async function seedRadio() {
  let seedId = opts.url ? parseVideoId(opts.url) : null;
  let seedKind = kind === 'anime' ? 'youtube' : kind;
  if (!seedId) {
    const h = getHistory().find((e) => e.kind === 'youtube' || e.kind === 'music');
    if (!h?.videoId) throw new Error('Radio needs a YouTube seed: --radio --url <url>, or play something first.');
    seedId = h.videoId;
    seedKind = h.kind;
  }
  if (seedKind === 'anime') seedKind = 'youtube';
  const spin = startSpin('Loading radio mix…');
  let mix;
  try {
    mix = await ytMix(seedId, 25, { debug });
  } catch (e) {
    spin.stop();
    throw e;
  }
  spin.stop();
  if (!mix.length) throw new Error('Radio mix came back empty.');
  lastList = mix.map((t) => ({ ...t, kind: seedKind }));
  const provider = getProvider(seedKind === 'music' ? 'ytmusic' : 'youtube');
  return { media: { ...lastList[0] }, provider };
}

// Music daemon lifecycle: one mpv for the whole music session. Killed on
// session end and (best-effort) on process exit so it never orphans.
let musicDaemon = null;
let musicAndroid = false;
async function ensureMusicDaemon() {
  // Fail fast with a useful message instead of a 15s IPC timeout + orphan.
  if (!hasMpv()) throw new Error('mpv not found on PATH and this tool is mpv-only (no browser fallback). Install: winget install --id mpv-player.mpv-CI.MSVC -e');
  // A crashed mpv leaves a dead object behind — detect via exitCode and
  // respawn instead of handing callers a corpse that fails every load.
  if (musicDaemon) {
    const code = musicDaemon.proc?.exitCode;
    if (code === null || code === undefined) return musicDaemon;
    await killMusicDaemon();
  }
  const d = new MusicPlayer();
  try {
    await d.start(musicAndroid ? ['--ytdl-raw-options=extractor-args=youtube:player_client=android'] : []);
  } catch (e) {
    // start() can fail AFTER spawning (IPC never ready) — kill the orphan.
    try {
      d.proc?.kill();
    } catch {}
    throw e;
  }
  musicDaemon = d;
  return d;
}
async function killMusicDaemon() {
  const d = musicDaemon;
  musicDaemon = null;
  if (d) {
    try {
      await d.quit();
    } catch {}
  }
}
process.on('exit', () => {
  try {
    musicDaemon?.proc?.kill();
  } catch {}
});

// One supervised music track: resolve -> load -> live screen -> action.
// Never silent: load failures reject (caller shows them), natural end maps
// to queue semantics, keys map straight through.
async function playMusicTrack(media, provider) {
  const resolved = await resolveMedia(provider, media);
  const source = resolved.sources[0];
  if (!source?.url) throw new Error(`Provider ${provider.name} returned no playable URL.`);
  const daemon = await ensureMusicDaemon();
  addHistory({
    title: media.title, kind: media.kind, videoId: media.videoId || null,
    duration: media.duration || null, provider: provider.name, providerId: provider.id, url: source.url,
  });
  const vol = config.volume ?? 100;
  const loadOnce = () => daemon.load(source.url, { volume: vol }).then(() => daemon.waitForStart(45000));
  try {
    await loadOnce();
    recordHealth(provider.id, { ok: true });
  } catch (e) {
    // Same Android-client fallback as one-shot playback, via daemon respawn.
    if (!musicAndroid) {
      musicAndroid = true;
      tlog('  Retrying with Android client…');
      await killMusicDaemon();
      const d2 = await ensureMusicDaemon();
      try {
        await d2.load(source.url, { volume: vol });
        await d2.waitForStart(45000);
        recordHealth(provider.id, { ok: true });
      } catch (e2) {
        recordHealth(provider.id, { ok: false });
        throw e2;
      }
    } else {
      recordHealth(provider.id, { ok: false });
      throw e;
    }
  }
  const live = musicDaemon;
  const r = await shellNowPlaying(live, {
    title: media.title,
    subtitle: media.author ? `${media.author}${media.duration ? ` · ${formatDuration(media.duration)}` : ''}` : null,
  }, {
    volume: (v) => {
      saveConfig({ ...config, volume: v });
      config.volume = v;
    },
  });
  // Persist where the track was left (keys and natural end alike).
  try {
    const pos = live.state.timePos || 0;
    const dur = live.state.duration || 0;
    updateHistory(source.url, {
      watchedMs: Math.round(pos * 1000),
      ...(dur > 0 && pos >= dur * 0.9 ? { completed: true } : {}),
    });
  } catch {}
  if (r.action === 'ended') return 'next';
  if (r.action === 'failed') throw new Error(`track failed (${r.reason || 'mpv gave up'}) — try radio or another search`);
  return r.action; // next | prev | menu
}

// kunai's return-to-shell, ytmusic-player's queue semantics: after mpv exits,
// offer next/prev/shuffle/repeat-aware navigation, radio, replay, search.
function shuffledOrder(n, exclude = -1) {
  const idx = [];
  for (let i = 0; i < n; i++) if (i !== exclude) idx.push(i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

async function sessionLoop(media, provider) {
  const startIdx = lastList.findIndex((x) => x.videoId && media.videoId && x.videoId === media.videoId);
  let qi = startIdx >= 0 ? startIdx : 0;
  let order = session.shuffle ? shuffledOrder(lastList.length, qi) : null;
  const back = []; // prev stack of queue indices / episode markers
  const isQueue = () => media.kind === 'youtube' || media.kind === 'music';
  for (;;) {
    if (media.kind !== 'music') await killMusicDaemon();
    const musicLive = media.kind === 'music' && process.stdin.isTTY && !opts.download && !opts.printUrl;
    let action;
    if (musicLive) {
      // Supervised daemon + live screen (ym parity) instead of one-shot mpv.
      try {
        action = await playMusicTrack(media, provider);
      } catch (e) {
        if (e.message === 'cancelled') {
          await killMusicDaemon();
          break;
        }
        if (useTuiShell && process.stdin.isTTY) {
          await shellError(friendlyFinishError(e));
          action = await postPlayMenu(media, qi, back);
        } else {
          await killMusicDaemon();
          throw e;
        }
      }
      if (action === 'menu') action = await postPlayMenu(media, qi, back);
    } else {
      // In the persistent shell, finish() failures render inline and the
      // session continues at the menu below. Flag-mode keeps fatal behavior.
      let failed = false;
      try {
        await finish(media, provider);
      } catch (e) {
        if (e.message === 'cancelled') break;
        if (useTuiShell && process.stdin.isTTY) {
          await shellError(friendlyFinishError(e, provider?.id));
          failed = true;
        } else {
          throw e;
        }
      }
      if (!failed && (opts.download || opts.printUrl || !process.stdin.isTTY)) break;
      // Autoplay (kunai parity): clean playback advances without asking.
      if (!failed && session.autoplay && (media.kind === 'anime' || isQueue())) {
        if (media.kind === 'anime') {
          media = { ...media, episode: (Number(media.episode) || 1) + 1, episodeRef: undefined };
        } else if (lastList.length > 1) {
          qi = (qi + 1) % lastList.length;
          media = { ...lastList[qi] };
          provider = getProvider(media.kind === 'music' ? 'ytmusic' : 'youtube') || provider;
        } else {
          break;
        }
        continue;
      }
      action = await postPlayMenu(media, qi, back);
    }
    if (action === 'quit' || !action || p.isCancel(action)) {
      await killMusicDaemon();
      break;
    }
    if (action === 'next') {
      if (media.kind === 'anime') {
        back.push({ media, qi });
        media = { ...media, episode: (Number(media.episode) || 1) + 1, episodeRef: undefined };
      } else if (session.repeat === 'one') {
        continue; // replay same track below (no advance)
      } else if (session.shuffle) {
        if (!order || !order.length) {
          if (session.repeat === 'all' && lastList.length > 1) {
            order = shuffledOrder(lastList.length, qi);
          } else {
            tlog('End of shuffled queue — try radio or a new search.', 'warn');
            continue;
          }
        }
        back.push({ media, qi });
        qi = order.shift();
        media = { ...lastList[qi] };
        provider = getProvider(media.kind === 'music' ? 'ytmusic' : 'youtube') || provider;
      } else {
        back.push({ media, qi });
        qi += 1;
        if (qi >= lastList.length) {
          if (session.repeat === 'all' && lastList.length > 0) {
            qi = 0;
          } else {
            tlog('End of queue — try radio or a new search.', 'warn');
            qi = Math.max(0, lastList.length - 1);
            back.pop();
            continue;
          }
        }
        if (!lastList[qi]) {
          tlog('End of queue — try radio or a new search.', 'warn');
          back.pop();
          continue;
        }
        media = { ...lastList[qi] };
        provider = getProvider(media.kind === 'music' ? 'ytmusic' : 'youtube') || provider;
      }
    } else if (action === 'prev') {
      const prev = back.pop();
      if (!prev) {
        tlog('Nothing before this.', 'warn');
        continue;
      }
      media = prev.media;
      qi = prev.qi;
      provider = await pickProvider(media);
    } else if (action === 'shuffle') {
      session.shuffle = !session.shuffle;
      order = session.shuffle ? shuffledOrder(lastList.length, qi) : null;
      persistModes();
      tlog(`Shuffle ${session.shuffle ? 'on' : 'off'}.`);
      continue;
    } else if (action === 'repeat') {
      session.repeat = session.repeat === 'off' ? 'all' : session.repeat === 'all' ? 'one' : 'off';
      persistModes();
      tlog(`Repeat ${session.repeat}.`);
      continue;
    } else if (action === 'queue') {
      const upcoming = session.shuffle && order?.length
        ? order.slice(0, 10).map((i) => lastList[i])
        : lastList.slice(qi + 1, qi + 11);
      if (!upcoming.length) tlog('Queue is empty after this.');
      upcoming.forEach((t, i) => tlog(`  ${i + 1}. ${t.title}`));
      continue;
    } else if (action === 'radio') {
      if (!media.videoId) {
        tlog('Radio needs a YouTube track — not available here.', 'warn');
        continue;
      }
      const spin = startSpin('Loading radio mix…');
      try {
        const mix = await ytMix(media.videoId, 25, { debug });
        spin.stop();
        if (!mix.length) {
          tlog('Radio mix came back empty.', 'warn');
          continue;
        }
        lastList = mix.map((t) => ({ ...t, kind: media.kind }));
        qi = 0;
        order = session.shuffle ? shuffledOrder(lastList.length, 0) : null;
        back.length = 0;
        media = { ...lastList[0] };
        provider = getProvider(media.kind === 'music' ? 'ytmusic' : 'youtube') || provider;
      } catch (e) {
        spin.stop();
        tlog(`Radio failed: ${e.message}`, 'warn');
      }
    } else if (action === 'provider') {
      provider = await pickProvider(media);
    } else if (action === 'search') {
      const res = useTuiShell
        ? await shellSearch({ home: false })
        : await runSearchTui({ config, initialMode: media.kind });
      if (!res) break;
      const np = getProvider(res.providerId);
      if (!np) throw new Error(`Unknown provider: ${res.providerId}`);
      media = res.media;
      provider = np;
      const found = lastList.findIndex((x) => x.videoId && media.videoId && x.videoId === media.videoId);
      qi = found >= 0 ? found : 0;
      order = session.shuffle ? shuffledOrder(lastList.length, qi) : null;
      back.length = 0;
    }
    // 'replay' loops with the same media/provider.
  }
  await killMusicDaemon();
}

async function postPlayMenu(media, qi, back) {
  let options = [];
  if (media.kind === 'anime') {
    options.push({ value: 'next', label: `Next episode (E${(Number(media.episode) || 1) + 1})` });
  } else if (media.kind === 'music') {
    // Music lane: full DJ menu (ytmusic-player parity).
    if (lastList.length > 1) options.push({ value: 'next', label: `Next in queue${session.repeat === 'one' ? ' (repeat one: replays)' : ''}` });
    if (back.length) options.push({ value: 'prev', label: 'Previous' });
    options.push({ value: 'shuffle', label: `Shuffle: ${session.shuffle ? 'on' : 'off'}` });
    options.push({ value: 'repeat', label: `Repeat: ${session.repeat}` });
    options.push({ value: 'queue', label: 'Show upcoming queue' });
    options.push({ value: 'radio', label: 'Radio mix (from this track)' });
  } else {
    // YouTube lane: video-only menu — no DJ controls (shuffle/repeat/
    // queue/radio live in the music lane). Radio stays available via --radio.
    if (lastList.length > 1) options.push({ value: 'next', label: 'Next in queue' });
    if (back.length) options.push({ value: 'prev', label: 'Previous' });
  }
  options.push({ value: 'autoplay', label: `Autoplay: ${session.autoplay ? 'on' : 'off'}` });
  options.push({ value: 'replay', label: media.kind === 'music' ? 'Replay track' : 'Replay' });
  options.push({ value: 'provider', label: 'Try another provider' });
  options.push({ value: 'search', label: 'New search' });
  // In the persistent shell, Quit goes back to the homepage (home Quit exits).
  options.push({ value: 'quit', label: useTuiShell ? 'Back to home' : 'Quit' });
  if (useTuiShell && process.stdin.isTTY) {
    for (;;) {
      const v = await shellMenu(media.title, options);
      if (v === 'autoplay') {
        session.autoplay = !session.autoplay;
        saveConfig({ ...config, autoplay: session.autoplay });
        options = options.map((o) => (o.value === 'autoplay' ? { ...o, label: `Autoplay: ${session.autoplay ? 'on' : 'off'}` } : o));
        continue;
      }
      return v;
    }
  }
  for (;;) {
    const v = await p.select({ message: 'What next?', options });
    if (v === 'autoplay') {
      session.autoplay = !session.autoplay;
      saveConfig({ ...config, autoplay: session.autoplay });
      options = options.map((o) => (o.value === 'autoplay' ? { ...o, label: `Autoplay: ${session.autoplay ? 'on' : 'off'}` } : o));
      continue;
    }
    return v;
  }
}

function friendlyFinishError(e, providerId) {
  const c = classifyFailure(e, providerId);
  return c.class === 'unknown' ? String(e.message || e) : c.summary;
}

async function finish(media, provider) {
  // --print-url: fast path, first source, no probing (unchanged).
  if (opts.printUrl) {
    const resolved = await resolveMedia(provider, media);
    const source = resolved.sources[0];
    if (!source?.url) throw new Error(`Provider ${provider.name} returned no playable URL.`);
    tlog(`\n${media.title} — ${provider.name} → ${source.type}`);
    tlog(source.url, 'raw');
    return;
  }

  // Resolve cycle: chosen provider first, then your priority list, then the
  // rest auto-ranked by observed health (reliability, then speed) — the
  // cycle finds the best stable source by itself. Health-skipped adapters
  // print why (reset to retry). mpv-only: no browser fallback anywhere.
  const avail = forKind(media.kind);
  // NOTE: commander maps `--no-fallback` to opts.fallback === false (there is
  // no opts.noFallback). Get this wrong and strict mode silently never engages.
  const strict = opts.fallback === false;
  const priority = (config.providerPriority || {})[media.kind] || [];
  const health = getHealth();
  const ordered = orderProviders(provider, avail, {
    priority, strict, healthBlocked: (id) => id !== provider.id && healthBlocked(id), health,
  });
  // A win on a non-default provider while the default is unhealthy migrates
  // the default (logged, no churn while the default works).
  const maybeAutoPin = (cand) => {
    const defId = (config.defaultProvider || {})[media.kind];
    if (shouldAutoPin(cand.id, defId, healthBlocked(defId))) {
      const names = { ...(config.defaultProvider || {}), [media.kind]: cand.id };
      saveConfig({ ...config, defaultProvider: names });
      config.defaultProvider = names;
      tlog(`Default ${media.kind} provider → ${cand.name} (previous default unhealthy).`);
    }
  };
  const unhealthyIds = new Set(
    (!strict ? avail.filter((x) => x.id !== provider.id && healthBlocked(x.id)) : []).map((x) => x.id)
  );
  const failures = [];
  const deadThisSession = new Set(); // don't re-probe/retry a URL that already died
  const androidTried = new Set(); // android-client retries already spent per URL
  const trail = []; // diagnostics evidence for --diagnostics
  const mark = (provider, ok, detail) => trail.push({ provider, ok, detail });
  const persistTrail = () => saveRun({ title: `${media.title}${mediaTag(media)}`, kind: media.kind, events: trail.slice(-50) });
  // YouTube/music go through yt-dlp natively — vetting would only add latency
  // and false verdicts, so those lanes skip probe/prescreen entirely.
  const vet = media.kind !== 'youtube' && media.kind !== 'music';
  for (const cand of ordered) {
    const t0 = Date.now();
    // Unhealthy notice lands here (at try time), not upfront — one line per
    // provider actually attempted, never a stale repeated preamble.
    if (unhealthyIds.has(cand.id)) tlog(`  ${cand.name}: unhealthy streak — trying last (--reset-health to forgive)`);
    let resolved;
    try {
      resolved = await resolveMedia(cand, media);
    } catch (e) {
      const c = classifyFailure(e, cand.id);
      // Summary plus the underlying reason — a bare "unexpected issue"
      // hides whether it's a wrong title, a dead CDN, or a site change.
      const reason = c.detail && c.detail !== c.summary ? ` (${c.detail.slice(0, 140)})` : '';
      tlog(`  ${cand.name}: ${c.summary}${reason}`, 'warn');
      failures.push(`${cand.id} (${c.class})`);
      mark(cand.name, false, `${c.summary}${reason}`);
      // Availability gaps (the title/episode simply isn't here), a user
      // cancel, or being offline are not provider outages — they stay in
      // the trail but must not degrade provider health or trigger a pin.
      if (!['provider-empty', 'user-cancelled', 'offline'].includes(c.class)) {
        recordHealth(cand.id, { ok: false });
      }
      if (c.policy === 'auto-fallback' && !strict) continue;
      persistTrail();
      throw e;
    }
    if (!resolved.sources?.length) {
      tlog(`  ${cand.name}: no sources returned.`, 'warn');
      failures.push(`${cand.id} (empty)`);
      mark(cand.name, false, 'no sources returned');
      recordHealth(cand.id, { ok: false });
      if (!strict) continue;
      persistTrail();
      throw new Error(`${cand.name} returned no sources.`);
    }
    let alive = resolved.sources;
    if (vet) {
      // Shell-only progress: probes/prescreens run several seconds per source
      // with the previous screen still showing — without this the session looks
      // frozen on the picker. Flag mode keeps the tlog lines below.
      const vetActive = useTuiShell && shellActive();
      if (vetActive) shellStatus(`Checking ${resolved.sources.length} source(s) from ${cand.name}…`);
      const checks = await Promise.all(
        resolved.sources.map(async (s) => {
          if (deadThisSession.has(s.url)) {
            return { status: 'unreachable', reason: 'died earlier this session', definitive: true };
          }
          if (s.type === 'embed') {
            const v = prescreenEmbed(s.url, { debug });
            if (v === 'unplayable') return { status: 'unreachable', reason: 'yt-dlp cannot extract this page', definitive: true };
            return { status: v === 'playable' ? 'reachable' : 'timeout', reason: v, definitive: false };
          }
          return probeUrl(s.url, { headers: s.headers, timeoutMs: 8000 });
        })
      );
      if (vetActive) shellStatus(null);
      alive = resolved.sources.filter((_, i) => probePassesForPlayback(checks[i]));
      checks.forEach((pr, i) => {
        if (!probePassesForPlayback(pr)) tlog(`  ✕ ${resolved.sources[i].url} (${pr.reason})`);
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

    let source = alive[0];
    if (alive.length > 1 && interactive && !opts.download) {
      const opts2 = alive.map((s, i) => ({ value: i, label: `#${i + 1} ${s.provider} · ${s.quality} · ${s.type} — ${s.url.slice(0, 48)}` }));
      if (shellActive()) {
        const v = await shellMenu(`Source (${alive.length} verified)`, opts2);
        if (v != null) source = alive[Number(v)];
      } else {
        const pick = await p.select({
          message: `Source (${alive.length} verified):`,
          options: alive.map((s, i) => ({ value: i, label: `#${i + 1} ${s.provider} · ${s.quality} · ${s.type}`, hint: s.url.slice(0, 48) })),
        });
        if (!p.isCancel(pick)) source = alive[Number(pick)];
      }
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
      let outcome = await playOrDownload(media, cand, attempt);
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
        const outcome2 = await playOrDownload(media, cand, attempt, { android: true });
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
  // mpv-only: exhaustion is fatal with the full failure trail. Nothing here
  // ever opens a browser — copy the URL with --print-url if you need it.
  persistTrail();
  throw new Error(`All providers exhausted (${failures.join(', ') || 'no attempts'}).`);
}

function mediaTag(media) {
  return media.kind === 'anime' ? ` E${media.episode}` : media.kind === 'music' && media.duration ? ` (${formatDuration(media.duration)})` : '';
}

function formatBytes(b) {
  const n = Number(b);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)}MB`;
  return `${(n / 1024).toFixed(0)}KB`;
}

async function playOrDownload(media, provider, source, extra = {}) {
  if (!source?.url) throw new Error(`Provider ${provider.name} returned no playable URL.`);
  // Audio-only is MUSIC-ONLY by contract: anime + youtube always play video.
  // (music kind, or a source explicitly flagged audioOnly like ytmusic.)
  const audioOnly = media.kind === 'music' || source.audioOnly === true;
  if (useTuiShell) {
    // Transcript lines, not console: the shell owns the screen.
    tlog(`fahy  ${media.title}${mediaTag(media)} — ${provider.name}`, 'raw');
    tlog(`  ▶ Playing in mpv — q to stop${media.kind === 'music' ? ', audio only' : ''}`);
  } else {
    console.log(chalk.dim(`\n${media.title}${mediaTag(media)} — ${provider.name} → ${source.type}`));
    console.log(chalk.cyan(source.url));
    if (source.type === 'embed' || media.kind === 'youtube' || media.kind === 'music') {
      console.log(chalk.dim('  Resolving the stream can take up to ~30s on slow networks. Hang tight.'));
    }
  }

  const record = {
    title: media.title, kind: media.kind, videoId: media.videoId || null, anilistId: media.anilistId || null,
    duration: media.duration || null, episode: media.episode,
    provider: provider.name, providerId: provider.id, url: source.url,
  };

  if (opts.download) {
    if (!hasYtDlp()) throw new Error('yt-dlp not found: winget install --id yt-dlp.yt-dlp -e');
    const outDir = opts.downloadPath || (media.kind === 'music' ? defaultMusicDir() : config.downloadPath || defaultDownloadDir());
    const free = freeSpaceBytes(outDir);
    if (free !== null && free < 500n * 1024n * 1024n) {
      throw new Error(`Only ${formatBytes(free)} free in ${outDir} — need ~500MB. Free space or pick another path.`);
    }
    addDownload({ ...record, outDir });
    const { code } = await downloadSource({ url: source.url, title: media.title, outDir, audio: audioOnly, headers: source.headers, debug });
    if (code === 0) {
      setDownloadStatus(source.url, 'done', { file: guessFile({ title: media.title, outDir, audio: audioOnly }) });
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
  addHistory(record);
  if (source.subMissing && interactive) {
    tlog('No soft subtitles available for this source — video may be subbed, dubbed, or raw.', 'warn');
  }
  if (!hasMpv()) {
    throw new Error('mpv not found on PATH and this tool is mpv-only (no browser fallback). Install: winget install --id mpv-player.mpv-CI.MSVC -e');
  }
  // State line: with mpv silenced, music especially looks frozen between
  // "resolving" and sound. This marks the handoff unambiguously.
  // (TUI shell already printed its two-line status above.)
  if (!useTuiShell) console.log(chalk.dim(`  ▶ Playing — q to stop${media.kind === 'music' ? ', audio only' : ''}`));
  const { code, ms } = await withShellSuspended(() => playUrl(source.url, { headers: source.headers, subFile: source.subFile, skip: source.skip, direct: source.direct === true, audioOnly, volume: config.volume ?? 100, androidClient: extra.android === true, clean: opts.mpvClean, logFile: opts.mpvLog, debug }));
  // mpv exit codes: 0 = played/quit normally. Non-zero within ~2 min means the
  // file never played (bad URL, extractor failed) — keep falling back.
  // (code null = killed externally; long sessions that later error count as played.)
  if (code !== 0 && code !== null && ms < 120000) {
    tlog(`  mpv could not play this source (exit ${code}) — trying next…`, 'warn');
    return 'retry';
  }
  // Watch progress (kunai parity): session length + completion heuristic.
  // No IPC position tracking, so completion = 90% of known duration.
  try {
    const patch = { watchedMs: ms };
    if (media.duration && ms >= Number(media.duration) * 1000 * 0.9) patch.completed = true;
    updateHistory(source.url, patch);
  } catch {}
  if (interactive && !useTuiShell) p.outro(chalk.green('Done.'));
  return 'ok';
}

if (!globalThis.__fahyDone) main().then(() => {
  // Safety: a returned TUI shell must never sit on a frozen frame —
  // homepage Quit/ESC already exit explicitly; this covers the rest.
  if (useTuiShell) process.exit(0);
}).catch((e) => {
  // TUI shell lives on the alt screen: stop it (unmount + leave) before printing.
  if (useTuiShell) {
    try { stopShell(); } catch {}
  }
  if (e.message === 'cancelled') process.exit(0);
  const c = classifyFailure(e);
  const msg = c.class === 'unknown' ? String(e.message || e) : `${c.summary} ${c.detail !== c.summary ? `(${c.detail})` : ''}`.trim();
  console.error(chalk.red(`Fatal: ${msg}`));
  if (debug) console.error(e);
  process.exit(1);
});
