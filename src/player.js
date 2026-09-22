import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mpvPrivacyArgs, proxyUrl, ytDlpPrivacyArgs } from './lib/privacy.js';

// Every spawned mpv is tracked so a CLI exit (Quit, Ctrl+C, fatal error)
// never orphans an audible player — music especially keeps playing with no
// window to stop it. Spawns unregister on close/error.
const liveMpv = new Set();
function trackChild(child) {
  liveMpv.add(child);
  child.once('close', () => liveMpv.delete(child));
  child.once('error', () => liveMpv.delete(child));
  return child;
}
export function killPlayerChildren() {
  for (const c of liveMpv) {
    try {
      c.kill();
    } catch {}
  }
  liveMpv.clear();
}
process.on('exit', () => killPlayerChildren());

export function hasMpv() {
  try {
    const r = spawnSync('mpv', ['--version'], { stdio: 'ignore', shell: false });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function playUrl(url, { headers = null, subFile = null, skip = null, direct = false, audioOnly = false, androidClient = false, volume = null, clean = false, logFile = null, debug = false } = {}) {
  const args = ['--really-quiet']; // mpv's status chatter (AO/VO/ffmpeg tls lines) stays off; failures still surface via exit code + our messages
  // ytmusic-player parity: tracking-free mpv (no disk cache/cookies/history).
  // mpv's own ytdl hook inherits the same yt-dlp privacy flags, merged with
  // the Android extractor fallback for kids/restricted videos.
  const ytdlOpts = ['ignore-config=', 'no-cache-dir=', 'no-cookies=', 'no-cookies-from-browser='];
  if (androidClient) ytdlOpts.unshift('extractor-args=youtube:player_client=android');
  const proxy = proxyUrl();
  if (proxy) ytdlOpts.push(`proxy=${proxy}`);
  // Kids/restricted YouTube videos 403 the default web client but play via the
  // Android client (verified same video/same network: 403 -> 200).
  args.push(`--ytdl-raw-options=${ytdlOpts.join(',')}`);
  if (proxy && /^https?:\/\//i.test(proxy)) args.push(`--http-proxy=${proxy}`);
  args.push('--cache-on-disk=no', '--resume-playback=no', '--cookies=no');
  if (direct) args.push('--no-ytdl'); // direct HLS/DASH/mp4: skip yt-dlp (it lacks our cookies/headers and 403s)
  if (audioOnly) args.push('--no-video'); // music mode (ytmusic-player parity)
  if (volume !== null && volume !== undefined) args.push(`--volume=${Math.max(0, Math.min(100, Number(volume) || 0))}`);
  const hdrs = Array.isArray(headers) ? headers : headers ? [headers] : [];
  for (const h of hdrs) {
    if (typeof h === 'string') args.push(`--http-header-fields=${h}`);
    else if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) {
      // Custom User-Agent via --http-header-fields 403s some CDNs (a custom UA
      // string on an HLS master hard-fails mpv with exit 2). ffmpeg's own UA
      // suffices for playback; keep the rest verbatim.
      if (/^user-agent$/i.test(k)) continue;
      args.push(`--http-header-fields=${k}: ${v}`);
    }
  }
  if (subFile) args.push(`--sub-file=${subFile}`);
  const skipFile = skip ? skipScript(skip) : null;
  if (skipFile) args.push(`--script=${skipFile}`);
  if (clean) args.push('--no-config'); // kunai --mpv-clean: rule out local mpv.conf conflicts
  if (logFile) args.push(`--log-file=${logFile}`); // kunai --mpv-log-file: evidence for bug reports
  args.push(url);
  if (debug) console.error(`[player] mpv ${args.join(' ')}`);
  return spawnMpv(args);
}

function spawnMpv(args) {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = trackChild(spawn('mpv', args, { stdio: 'inherit', shell: false }));
    } catch {
      resolve({ code: -1, ms: 0 });
      return;
    }
    child.on('error', () => resolve({ code: -1, ms: Date.now() - started }));
    child.on('close', (code) => resolve({ code, ms: Date.now() - started }));
  });
}

// kunai-style autoskip: tiny generated lua that jumps over intro/outro segments.
export function skipScript(skip) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const segs = [skip?.intro, skip?.outro]
    .map((s) => (s ? { start: num(s.start), end: num(s.end) } : null))
    .filter((s) => s && s.start !== null && s.end !== null && s.end > s.start && s.start >= 0);
  if (!segs.length) return null;
  const lua = `local skips = { ${segs.map((s) => `{${s.start}, ${s.end}}`).join(', ')} }\n` +
    `mp.observe_property("time-pos", "number", function(_, pos)\n` +
    `  if not pos then return end\n` +
    `  for _, s in ipairs(skips) do\n` +
    `    if pos >= s[1] and pos < s[2] then mp.set_property("time-pos", s[2] + 0.1); break end\n` +
    `  end\n` +
    `end)\n`;
  const dir = join(tmpdir(), 'fahy-cli');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `skip-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.lua`);
  writeFileSync(f, lua);
  return f;
}

// mpv-only tool: openBrowser() was removed — nothing opens a browser anymore.

// Embed prescreen: ask yt-dlp (no download) whether an embed page is even
// extractable BEFORE mpv launches. mpv on a dead embed hangs silently for
// 30-60s; this turns that into a fast verdict + visible message.
// Returns 'playable' | 'unplayable' | 'unknown' (timeout = try mpv anyway).
// Timeout is deliberately short: working embeds answer yt-dlp in seconds,
// and each second here blocks the UI thread (spawnSync) with the previous
// screen still showing — long tarpits read as a frozen app.
export function prescreenEmbed(url, { timeoutMs = 12000, debug = false } = {}) {
  let p;
  try {
    p = spawnSync(
      'yt-dlp',
      [...ytDlpPrivacyArgs(), '--simulate', '--skip-download', '--no-warnings', '--socket-timeout', '10', '--print', '%(title)s', url],
      { encoding: 'utf8', timeout: timeoutMs, shell: false }
    );
  } catch (e) {
    if (debug) console.error(`[prescreen] spawn failed: ${e.message}`);
    return 'unknown';
  }
  if (p.status === 0) return 'playable';
  if (p.status === null) {
    if (debug) console.error('[prescreen] timed out (inconclusive)');
    return 'unknown'; // killed by timeout: tarpit, not proof of death
  }
  const err = `${p.stdout || ''}\n${p.stderr || ''}`;
  if (/unsupported url|no video formats/i.test(err)) return 'unplayable';
  if (/timed out|timeout/i.test(err)) return 'unknown';
  if (/429|too many requests|rate/i.test(err)) return 'unknown'; // transient — let mpv try
  if (/403|private|unavailable/i.test(err)) return 'unknown'; // mpv + android-client retry may still play
  // Any other yt-dlp failure (404/5xx page): treat as unplayable, but the
  // message below carries the reason so the user sees why.
  return 'unplayable';
}

// YouTube/music fast-start: pull ONE direct stream URL up front so mpv opens
// an actual file (--no-ytdl) instead of running its own yt-dlp hook silently
// for seconds with no picture on screen. null = fall back to the hook — a
// failed extraction must never block playback.
export function extractDirectUrl(url, { audioOnly = false, timeoutMs = 20000, debug = false } = {}) {
  const fmt = audioOnly ? 'bestaudio/best' : 'b[height<=1080]/b';
  try {
    const r = spawnSync(
      'yt-dlp',
      [...ytDlpPrivacyArgs(), '--no-warnings', '--socket-timeout', '10', '-f', fmt, '--print', '%(url)s', url],
      { encoding: 'utf8', timeout: timeoutMs, shell: false }
    );
    if (r.status !== 0) {
      if (debug) console.error(`[extract] yt-dlp ${r.status}: ${String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0]}`);
      return null;
    }
    const direct = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s));
    return direct || null;
  } catch (e) {
    if (debug) console.error(`[extract] ${e.message}`);
    return null;
  }
}

// Offline library playback. Same { code, ms } shape as playUrl, honoring
// volume / clean / log flags like online playback.
export function playFile(file, { volume = null, clean = false, logFile = null, debug = false } = {}) {
  const args = ['--really-quiet', ...mpvPrivacyArgs()];
  if (volume !== null && volume !== undefined) args.push(`--volume=${Math.max(0, Math.min(100, Number(volume) || 0))}`);
  if (clean) args.push('--no-config');
  if (logFile) args.push(`--log-file=${logFile}`);
  args.push(file);
  if (debug) console.error(`[player] mpv ${args.join(' ')}`);
  return spawnMpv(args);
}
