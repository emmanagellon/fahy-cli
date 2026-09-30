// Admin / utility commands: everything that is not "play something".
//
// These stay plain CLI. No prompts, no frames, no alternate screen — each one
// prints and exits, so they compose in a shell, in a script, and in CI.
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { providers, getProvider, forKind } from '../providers/registry.js';
import { hasMpv } from '../player.js';
import { hasYtDlp, defaultDownloadDir, defaultMusicDir } from '../downloader.js';
import { configPath, saveConfig } from '../config.js';
import {
  getDownloads, getCompletedDownloads, getFavorites, toggleFavorite, getPlaylists,
  playlistAdd, playlistClear, getHealth, resetHealth, scoreOf, healthBlocked,
  getHistory, getLastRun, getSourceSync, setSourceSync, getUpdateState, setUpdateState,
  pruneMissing,
} from '../store.js';
import { config, session, opts, applyVolumeArg, persistModes, setDefaultProvider, setAutoplay, AUTO_UPDATE_MODES } from '../state.js';
import { say, tlog, fail, startSpin } from '../ui.js';
import { canSelect, select } from '../tui/select.js';
import { playLocalFile } from '../playback.js';
import { installedVersion, needsUpdate, latestVersion, upgrade } from '../update.js';
import { listHistory, historyLine, historyLabel, historyHint } from '../history.js';
import { runPlaylist, runPlay, runRadio } from './play.js';
import { withDeadline } from '../lib/async.js';

const LANE = (x) => (x.direct ? 'direct' : ['youtube', 'music'].includes(x.kinds[0]) ? 'ytdl' : 'embed');

// ---- health / setup / diagnostics ----------------------------------------

export function runVersion() {
  say(installedVersion());
}

// mpv, yt-dlp, transport, config, and whether the primary site answers.
async function probeEnvironment({ debug }) {
  const lines = [];
  lines.push(`mpv:       ${hasMpv() ? chalk.green('found') : chalk.red('missing — winget install --id mpv-player.mpv-CI.MSVC -e')}`);
  lines.push(`yt-dlp:    ${hasYtDlp() ? chalk.green('found') : chalk.red('missing — needed for YouTube/music/download — winget install --id yt-dlp.yt-dlp -e')}`);
  const { discoverCurl, fetchText } = await import('../net.js');
  const curl = discoverCurl();
  lines.push(`transport: ${curl ? chalk.green(curl.impersonates ? `curl-impersonate (${curl.profile})` : 'plain curl') : chalk.yellow('no curl found')}`);
  try {
    await withDeadline(
      () => fetchText('https://hianime.at/search?keyword=test', { userAgent: 'Mozilla/5.0', referer: 'https://hianime.at/', timeoutMs: 8000 }),
      10000,
      'hianime check'
    );
    lines.push(`hianime:   ${chalk.green('reachable (direct anime streams)')}`);
  } catch (e) {
    lines.push(`hianime:   ${chalk.yellow(`blocked here (${String(e.message).slice(0, 80)}) — auto-fallback covers it`)}`);
  }
  lines.push(`config:    ${configPath()}`);
  lines.push(`downloads: ${config.downloadPath || defaultDownloadDir()}`);
  lines.push(`music:     ${defaultMusicDir()}`);
  lines.push(`version:   ${installedVersion()}`);
  try {
    const latest = await withDeadline(() => latestVersion({ timeoutMs: 6000, debug }), 8000, 'version check');
    lines.push(`latest:    ${latest}${needsUpdate(installedVersion(), latest) ? chalk.yellow(' — update available (fahy upgrade)') : chalk.green(' (current)')}`);
  } catch {
    lines.push(`latest:    ${chalk.yellow('unreachable (offline? — fahy upgrade retries)')}`);
  }
  return lines;
}

export async function runDoctor({ debug = false } = {}) {
  for (const line of await probeEnvironment({ debug })) say(line);
  return { ok: true };
}

export async function runSetup({ debug = false } = {}) {
  const lines = await probeEnvironment({ debug });
  for (const line of lines) say(line);
  const missing = [];
  if (!hasMpv()) missing.push('mpv');
  if (!hasYtDlp()) missing.push('yt-dlp');
  if (missing.length) {
    say('');
    say(chalk.dim(`Install the missing ${missing.join(' and ')}, then run: fahy anime "Frieren"`));
  } else {
    say('');
    say(chalk.dim('Ready. Try: fahy anime "Frieren"  ·  fahy tv "Daybreak"  ·  fahy music "lofi"'));
  }
  return { ok: missing.length === 0, missing };
}

export function runDiagnostics() {
  const run = getLastRun();
  if (!run?.events?.length) {
    say('No recorded runs yet — play something first.');
    return;
  }
  say(chalk.dim(`Last run: ${run.title || ''} (${run.at})`));
  for (const e of run.events.slice(-30)) {
    const icon = e.ok === true ? chalk.green('✓') : e.ok === false ? chalk.red('✕') : chalk.dim('·');
    say(`  ${icon} ${e.provider || ''}${e.detail ? ` — ${e.detail}` : ''}`);
  }
}

export function runProviders({ setDefault = null, priority = null } = {}) {
  if (setDefault) {
    const eq = String(setDefault).indexOf('=');
    const kind = String(setDefault).slice(0, eq);
    const id = String(setDefault).slice(eq + 1);
    if (!forKind(kind).some((p) => p.id === id)) {
      throw new Error(`Bad value: ${setDefault}. Use kind=id, e.g. anime=hianime`);
    }
    setDefaultProvider(kind, id);
    say(chalk.green(`Default ${kind} provider → ${id} (saved to ${configPath()})`));
    return;
  }
  if (priority) {
    const eq = String(priority).indexOf('=');
    const kind = String(priority).slice(0, eq);
    const list = String(priority).slice(eq + 1).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.some((id) => !getProvider(id)?.kinds.includes(kind))) {
      throw new Error(`Bad value: ${priority}. Use kind=id1,id2, e.g. "anime=hianime,anikoto"`);
    }
    const next = { ...(config.providerPriority || {}), [kind]: list };
    saveConfig({ ...config, providerPriority: next });
    config.providerPriority = next;
    say(chalk.green(`Fallback order for ${kind}: ${list.join(' → ')}`));
    return;
  }
  for (const x of providers) {
    const def = (config.defaultProvider || {})[x.kinds[0]] === x.id ? chalk.green(' (default)') : '';
    say(`${x.id.padEnd(14)} ${LANE(x).padEnd(7)} ${x.kinds.join(',').padEnd(14)} ${x.name}${def} — ${x.site || ''}`);
  }
  say('');
  say(chalk.dim('Metadata only (search, no streams): AniList + TMDB + yt-dlp.'));
  say(chalk.dim('Set a default:  fahy providers --default anime=hianime'));
  say(chalk.dim('Set a priority: fahy providers --priority "anime=hianime,anikoto"'));
}

export function runHealth({ reset = null } = {}) {
  if (reset !== null) {
    const id = reset || null;
    if (id && !getProvider(id)) throw new Error(`Unknown provider: ${id}`);
    resetHealth(id);
    say(chalk.green(id ? `Forgot health for ${id} — it rejoins the cycle.` : 'Forgot all provider health.'));
    return;
  }
  const h = getHealth();
  const ids = [...new Set([...providers.map((p) => p.id), ...Object.keys(h)])];
  if (!ids.length) {
    say('No health data yet — play something first.');
    return;
  }
  for (const id of ids) {
    const c = h[id];
    if (!c) {
      say(`${id.padEnd(14)} no data`);
      continue;
    }
    const blocked = healthBlocked(id) ? chalk.red(' SKIPPED (unhealthy)') : '';
    say(`${id.padEnd(14)} ok ${c.ok} · fail ${c.fail} · streak ${c.consecFail}${c.lastMs != null ? ` · ${c.lastMs}ms` : ''} · score ${scoreOf(c).rel.toFixed(2)}${blocked}`);
  }
  say('');
  say(chalk.dim('Forget one provider (or all): fahy health --reset [id]'));
}

// ---- source drift ---------------------------------------------------------

export async function runSources({ update = false, debug = false } = {}) {
  const { fetchFmhyAnimeSites, matchCoverage, probeProviders, bestProvider } = await import('../sources.js');
  const spin = startSpin('Checking FMHY sources…');
  let fmhy;
  try {
    fmhy = await withDeadline(() => fetchFmhyAnimeSites({ debug }), 20000, 'FMHY check');
  } catch (e) {
    spin.stop();
    throw new Error(`FMHY check failed: ${e.message}`);
  }
  spin.stop();
  // A manual check counts as a sync — it resets the daily-watch timer.
  try {
    setSourceSync({ lastCheck: new Date().toISOString(), knownHosts: fmhy.map((s) => s.host) });
  } catch {}
  const anime = providers.filter((p) => p.kinds.includes('anime'));
  const coverage = matchCoverage(fmhy, anime);
  say(chalk.dim(`Probing ${anime.length} anime providers (a few seconds)…`));
  const health = await probeProviders(anime);
  const byId = Object.fromEntries(health.map((h) => [h.id, h]));
  say(chalk.dim(`FMHY anime sites: ${fmhy.length}`));
  for (const c of coverage) {
    const h = byId[c.id];
    const dot = h?.status === 'reachable' ? chalk.green('●') : h?.status === 'timeout' ? chalk.yellow('●') : chalk.red('●');
    const ms = h?.ms != null ? ` ${h.ms}ms` : '';
    const note = c.status === 'drift' ? chalk.yellow(` — FMHY now lists: ${c.fmhy.map((f) => f.host).join(', ')}`)
      : c.status === 'missing' ? chalk.red(' — not on FMHY')
      : '';
    say(`  ${dot} ${c.name} (${h?.status || '?'}${ms})${note}`);
  }
  const covered = new Set(coverage.flatMap((c) => c.fmhy));
  const extra = fmhy.filter((f) => !covered.has(f));
  if (extra.length) {
    say('');
    say(chalk.dim('On FMHY but not covered (would need a real adapter):'));
    extra.slice(0, 15).forEach((f) => say(chalk.dim(`  - ${f.name} — ${f.url}`)));
    if (extra.length > 15) say(chalk.dim(`  …and ${extra.length - 15} more`));
  }
  if (update) {
    const best = bestProvider(health);
    if (!best) say(chalk.yellow('\nNo healthy anime provider — default unchanged.'));
    else if ((config.defaultProvider || {}).anime !== best.id) {
      setDefaultProvider('anime', best.id);
      say(chalk.green(`\nDefault anime provider → ${best.id} (${best.ms}ms).`));
    } else say(chalk.dim(`\nDefault anime provider already ${best.id} (fastest).`));
  }
}

// ---- downloads / library --------------------------------------------------

export function runDownloads() {
  const q = getDownloads();
  if (!q.length) say('Download queue is empty.');
  for (const d of q) {
    const title = d.title || d.url;
    const tag = d.kind === 'tv' ? ` S${d.season || 1}E${d.episode}` : d.episode ? ` E${d.episode}` : '';
    say(`[${d.status}] ${title}${tag} — ${d.file || d.url}`);
  }
}

export function runPrune() {
  const n = pruneMissing();
  say(n ? `Pruned ${n} stale ${n === 1 ? 'entry' : 'entries'}.` : 'Nothing stale — library matches disk.');
}

export async function runLibrary(commandOpts = {}) {
  if (commandOpts.mpvClean) opts.mpvClean = true;
  if (commandOpts.mpvLog) opts.mpvLog = commandOpts.mpvLog;
  const done = getCompletedDownloads();
  if (!done.length) {
    say('Library is empty. Queue one with: fahy anime "Frieren" --download');
    return;
  }
  if (!canSelect()) {
    done.forEach((d, i) => say(`${i + 1}. ${historyLabel(d)}${d.file ? `  ${d.file}` : ''}`));
    return;
  }
  const picked = await select({
    title: 'Library',
    subtitle: `${done.length} download${done.length === 1 ? '' : 's'}`,
    items: done.map((d, i) => ({ label: historyLabel(d), hint: d.file || '', value: i })),
  });
  if (picked === null) return;
  const d = done[picked];
  if (!existsSync(d.file)) throw new Error(`File missing: ${d.file} (fahy prune)`);
  await playLocalFile(d.file);
}

// ---- favorites / playlists -----------------------------------------------

export function runFavorites() {
  const f = getFavorites();
  if (!f.length) say('No favorites yet. Play something, then: fahy favorite');
  f.forEach((e, i) => say(`${i + 1}. ${historyLabel(e)} — ${e.url}`));
}

// Toggle favorite on a history entry — the newest one by default, or the
// Nth when the user says so.
export async function runFavorite({ index = null, url = null } = {}) {
  const h = getHistory();
  if (!h.length) throw new Error('No history yet — play something first.');
  let entry = h[0];
  if (url) entry = h.find((e) => e.url === url) || entry;
  if (index !== null) {
    const i = Number(index) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= h.length) throw new Error(`No history entry ${index} (have ${h.length}).`);
    entry = h[i];
  }
  const on = toggleFavorite(entry);
  say(on ? `Favorited: ${historyLabel(entry)}` : `Unfavorited: ${historyLabel(entry)}`);
}

export function runPlaylists() {
  const all = getPlaylists();
  const names = Object.keys(all);
  if (!names.length) say('No playlists yet. Play something, then: fahy playlist-add <name>');
  names.forEach((n) => say(`${n} (${all[n].length} ${all[n].length === 1 ? 'track' : 'tracks'})`));
}

export function runPlaylistAdd(name) {
  const h = getHistory();
  if (!h.length || !h[0].url) throw new Error('Nothing to add — play something first.');
  const n = playlistAdd(name, h[0]);
  say(chalk.green(`Added to '${name}' (${n} ${n === 1 ? 'track' : 'tracks'}).`));
}

export function runPlaylistClear(name) {
  say(playlistClear(name) ? `Deleted playlist '${name}'.` : `No playlist named '${name}'.`);
}

// ---- now / session settings ----------------------------------------------

export function runNow() {
  const h = getHistory();
  if (!h.length) {
    say('Nothing played yet.');
    return;
  }
  const e = h[0];
  say(`${historyLabel(e)}${historyHint(e) ? `  (${historyHint(e)})` : ''}`);
  say(chalk.dim(`volume ${config.volume ?? 100} · shuffle ${session.shuffle ? 'on' : 'off'} · repeat ${session.repeat}`));
}

export function runVolume(arg) {
  const next = applyVolumeArg(arg);
  if (next === null) throw new Error('volume takes 0-100, or +N/-N to adjust.');
  say(`Volume ${next}.`);
}

export function runShuffle(arg) {
  const v = arg === undefined || arg === '' ? null : String(arg).toLowerCase();
  if (v !== null && v !== 'on' && v !== 'off') throw new Error('shuffle takes on|off (or bare to toggle).');
  session.shuffle = v === null ? !session.shuffle : v === 'on';
  persistModes();
  say(`Shuffle ${session.shuffle ? 'on' : 'off'}.`);
}

export function runRepeat(arg) {
  const v = String(arg || '').toLowerCase();
  if (!['off', 'one', 'all'].includes(v)) throw new Error('repeat takes off|one|all.');
  session.repeat = v;
  persistModes();
  say(`Repeat ${v}.`);
}

export function runAutoplay(arg) {
  const v = arg === undefined || arg === '' ? (session.autoplay ? 'off' : 'on') : String(arg).toLowerCase();
  if (!['on', 'off'].includes(v)) throw new Error('autoplay takes on|off (or bare to toggle).');
  setAutoplay(v === 'on');
  say(`Autoplay ${session.autoplay ? 'on' : 'off'}.`);
}

export function runAutoUpdate(arg) {
  const cur = AUTO_UPDATE_MODES.includes(config.autoUpdate) ? config.autoUpdate : 'notice';
  if (arg === undefined || arg === '') {
    const hints = { notice: ' — notify when a new version exists', install: ' — apply updates automatically', off: ' — never check automatically' };
    say(`Auto-update: ${cur}${hints[cur]}.`);
    return;
  }
  const v = String(arg).toLowerCase();
  if (!AUTO_UPDATE_MODES.includes(v)) throw new Error('auto-update takes notice|install|off.');
  saveConfig({ ...config, autoUpdate: v });
  config.autoUpdate = v;
  say(`Auto-update: ${v}.`);
}

// ---- update / uninstall ---------------------------------------------------

export function runUpgrade(version, { debug = false } = {}) {
  const want = version && String(version) !== '' ? String(version) : 'latest';
  say(want === 'latest' ? 'Checking for updates…' : `Upgrading fahy-cli to ${want}…`);
  const res = upgrade({ wanted: want, debug, verbose: true });
  if (res.ok) {
    say(chalk.green(res.message));
    // A successful upgrade implies newest — reset the daily window so the
    // auto-check does not re-notify about the version we just installed.
    try {
      setUpdateState({ lastCheck: new Date().toISOString(), lastVersion: installedVersion() });
    } catch {}
    return 0;
  }
  say(chalk.yellow(res.message));
  return 1;
}

export function runUninstall({ purge = false } = {}) {
  say('Removing global fahy-cli…');
  const r = spawnSync('npm', ['uninstall', '-g', 'fahy-cli'], { stdio: 'inherit', shell: false });
  if (purge) {
    for (const dir of [join(homedir(), '.config', 'fahy-cli'), join(homedir(), '.config', 'fmhy-cli')]) {
      try {
        rmSync(dir, { recursive: true, force: true });
        say(chalk.green(`Purged ${dir}`));
      } catch (e) {
        say(chalk.yellow(`Could not purge ${dir}: ${e.message}`));
      }
    }
  } else {
    say(chalk.dim(`Kept ${join(homedir(), '.config', 'fahy-cli')} (use --purge to delete it).`));
  }
  return r.status ?? 1;
}

// ---- daily background watchers -------------------------------------------

// One FMHY diff per run-day. Silent by default: the only output is a warning
// when the source list actually moved.
export async function maybeDailyFmhySync({ debug = false } = {}) {
  if (!process.stdin.isTTY || opts.printUrl) return;
  let state = {};
  try {
    state = getSourceSync();
  } catch {
    return;
  }
  if (state.lastCheck && Date.now() - Date.parse(state.lastCheck) < 24 * 3600 * 1000) return;
  try {
    const { fetchFmhyAnimeSites, diffFmhySources } = await import('../sources.js');
    const fmhy = await withDeadline(() => fetchFmhyAnimeSites({ timeoutMs: 12000, debug }), 16000, 'FMHY check');
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
  } catch (e) {
    if (debug) console.error(`[fahy-sync] ${e.message}`);
  }
}

// One version check per run-day.
export async function maybeCheckForUpdates({ debug = false } = {}) {
  if (!process.stdin.isTTY || opts.printUrl) return;
  const mode = AUTO_UPDATE_MODES.includes(config.autoUpdate) ? config.autoUpdate : 'notice';
  if (mode === 'off') return;
  let state = {};
  try {
    state = getUpdateState();
  } catch {
    return;
  }
  if (state.lastCheck && Date.now() - Date.parse(state.lastCheck) < 24 * 3600 * 1000) return;
  const current = installedVersion();
  let latest;
  try {
    latest = await withDeadline(() => latestVersion({ timeoutMs: 8000, debug }), 10000, 'version check');
  } catch {
    setUpdateState({ lastCheck: new Date().toISOString(), lastVersion: state.lastVersion });
    return;
  }
  setUpdateState({ lastCheck: new Date().toISOString(), lastVersion: latest });
  if (!needsUpdate(current, latest)) return;
  if (mode === 'install') {
    tlog(`Updating fahy ${current} → ${latest}…`);
    const res = upgrade({ wanted: latest, debug });
    tlog(res.ok ? `Updated to ${latest}. Restart fahy to use it.` : `Update failed: ${res.message}`, res.ok ? 'ok' : 'warn');
    return;
  }
  tlog(`Update available: fahy v${current} → v${latest} — run \`fahy upgrade\` to apply.`, 'warn');
}
