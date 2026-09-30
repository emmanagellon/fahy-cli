import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { mpvPrivacyArgs, proxyUrl, ytDlpPrivacyArgs } from './lib/privacy.js';

// Every spawned mpv is tracked so a CLI exit never orphans a player.
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
      c.kill('SIGTERM');
      // Force kill after 2s if still alive
      setTimeout(() => {
        try { c.kill('SIGKILL'); } catch {}
      }, 2000).unref();
    } catch {}
  }
  liveMpv.clear();
}

// On the `exit` event there is no event loop left, so the 2s SIGKILL
// escalation above can never run. Anything still alive gets SIGKILL outright —
// a half-dead orphan is worse than a hard one.
function killPlayerChildrenNow() {
  for (const c of liveMpv) {
    try { c.kill('SIGKILL'); } catch {}
  }
  liveMpv.clear();
}

// Set when a signal tore down a running player. The session ends on it: a
// user who hit Ctrl+C does not want to be shown a "what next?" menu.
let interrupted = false;
export function wasInterrupted() {
  return interrupted;
}

// Last-chance savers, run once on a signal when there is no tracked player to
// let finish on its own (the music daemon is supervised, not awaited). Each is
// given a short, bounded window: an interrupt must still feel instant, and a
// saver that hangs must not hold the terminal.
const interruptSavers = new Set();
export function onInterrupt(fn) {
  interruptSavers.add(fn);
  return () => interruptSavers.delete(fn);
}
export function interruptSaverCount() {
  return interruptSavers.size;
}
async function runInterruptSavers() {
  const jobs = [...interruptSavers].map((fn) => {
    try {
      return Promise.resolve(fn()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  });
  if (!jobs.length) return;
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 1500).unref?.())]);
}

// A player that is running means there is real work in flight: its promise
// still has to resolve so the watch position reaches history. Exiting here
// would throw that away, so we only kill and let the normal path finish.
function onSignal() {
  const hadPlayer = liveMpv.size > 0;
  killPlayerChildren();
  if (hadPlayer) {
    interrupted = true;
    return;
  }
  void runInterruptSavers().finally(() => process.exit(0));
}
// Kill mpv on any exit path: normal exit, SIGINT (Ctrl+C), SIGTERM, etc.
process.on('exit', killPlayerChildrenNow);
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
process.on('SIGHUP', onSignal);

export function hasMpv() {
  try {
    const r = spawnSync('mpv', ['--version'], { stdio: 'ignore', shell: false });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Resume offset handling is shared by online playback and the offline library:
// a stored position in ms, a floor (never seek into the first few seconds —
// mpv's start is not frame-exact and a 0s jump can land on a black frame),
// and a ceiling below the end (resuming into the final seconds "finishes"
// the item instantly and looks like a no-op).
const RESUME_FLOOR_S = 5;
const RESUME_TAIL_RATIO = 0.95;

export function startArgFor(positionMs, durationSec) {
  const ms = Number(positionMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const secs = Math.floor(ms / 1000);
  // Too early to be worth a seek — mpv's own start is not frame-exact, and
  // jumping a couple of seconds in can land on a black frame.
  if (secs < RESUME_FLOOR_S) return null;
  if (Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 && secs >= Number(durationSec) * RESUME_TAIL_RATIO) {
    return null; // already at/past the end — start over instead of finishing
  }
  return `--start=${secs}`;
}

export function playUrl(url, { headers = null, subFile = null, skip = null, direct = false, audioOnly = false, androidClient = false, volume = null, clean = false, logFile = null, positionMs = null, duration = null, debug = false } = {}) {
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
  const start = startArgFor(positionMs, duration);
  if (start) args.push(start);
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

// Spawn mpv and wait for it. There is deliberately NO timeout: a 24-minute
// episode taking 24 minutes is the whole point, and the only honest evidence
// that a player is broken is that mpv itself reports one — its exit code, or
// the position it stops making progress at. Anything time-based here would
// kill legitimate playback.
//
// The promise settles on the first of error/close, and those listeners are
// removed when it does, so a finished player leaves nothing attached.
function spawnMpv(args) {
  const started = Date.now();
  return new Promise((resolve) => {
    let child = null;
    let report = null;
    const handlers = {};

    const settle = (result) => {
      for (const [ev, fn] of Object.entries(handlers)) child?.off(ev, fn);
      const reported = readProgress(report?.data);
      clearProgress(report);
      resolve({
        ms: Date.now() - started,
        signal: null,
        interrupted: wasInterrupted(),
        positionSec: reported?.positionSec ?? null,
        durationSec: reported?.durationSec ?? null,
        // Did mpv itself say the file played to the end?
        playedToEnd: reported?.reason === 'eof',
        ...result,
      });
    };

    try {
      report = newProgressReport();
      if (report) args = [...args, `--script=${report.script}`];
      child = trackChild(spawn('mpv', args, { stdio: 'inherit', shell: false }));
    } catch {
      clearProgress(report);
      resolve({ code: -1, ms: 0, signal: null, interrupted: wasInterrupted(), positionSec: null, durationSec: null, playedToEnd: false });
      return;
    }

    handlers.error = () => settle({ code: -1 });
    handlers.close = (code, signal) => settle({ code, signal: signal || null });
    child.on('error', handlers.error);
    child.on('close', handlers.close);
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

// ---- position reporting ---------------------------------------------------
//
// Why this exists: "how far in did the user actually get" cannot be measured
// from the wall clock. Pausing for ten minutes inflates it (and used to mark a
// half-watched episode `completed`, which then made resume restart from zero),
// while watching at 2x deflates it. mpv knows the real number, so we ask it.
//
// A tiny lua script checkpoints `time-pos` to a data file every few seconds
// and once more on end-file/shutdown. Periodic checkpoints matter: they are
// what survives a hard kill (Ctrl+C, a crash, a killed terminal), so an
// interrupted watch still has a usable resume point.
//
// The data file is written via a temp name + rename, so a read can never catch
// a half-written line.

// Short enough that a kill during the opening seconds still leaves a position
// worth resuming from, long enough that the write is invisible.
const PROGRESS_INTERVAL_S = 2;

function luaString(p) {
  return String(p).replace(/\\/g, '/').replace(/"/g, '\\"');
}

export function progressScript(scriptFile, dataFile, { intervalS = PROGRESS_INTERVAL_S } = {}) {
  const out = luaString(dataFile);
  const tmp = luaString(`${dataFile}.tmp`);
  const lua =
    `local out, tmp = "${out}", "${tmp}"\n` +
    `local every = ${Number(intervalS) || PROGRESS_INTERVAL_S}\n` +
    `local best, bestdur, last = -1, 0, 0\n` +
    `local function snap()\n` +
    `  local pos = mp.get_property_number("time-pos", 0) or 0\n` +
    `  local dur = mp.get_property_number("duration", 0) or 0\n` +
    // Monotonic on purpose. By the time end-file/shutdown fire, mpv has
    // already torn the file down and time-pos reads back as 0 — writing that
    // would erase the real position the ticks just recorded. So the furthest
    // point reached wins, and a forward seek counts as progress.
    `  if pos <= best then return end\n` +
    `  best = pos\n` +
    `  if dur > 0 then bestdur = dur end\n` +
    `  local f = io.open(tmp, "w")\n` +
    `  if not f then return end\n` +
    `  f:write(string.format("%.3f %.3f", best, bestdur))\n` +
    `  f:close()\n` +
    // os.rename cannot replace an existing file on windows, so without this
    // remove the FIRST checkpoint is the only one that ever lands and the
    // reported position stays frozen near the start of the video.
    `  os.remove(out)\n` +
    `  os.rename(tmp, out)\n` +
    `end\n` +
    // Driven by an observed property rather than a timer. time-pos changes on
    // every tick of playback, so the position is always current, and the
    // throttle keeps that from turning into a write per frame. A timer that
    // fired once and stopped would freeze the position near the start, which
    // is the failure this replaces.
    `mp.observe_property("time-pos", "number", function(_, pos)\n` +
    `  if not pos then return end\n` +
    `  local now = mp.get_time()\n` +
    `  if now - last < every and best >= 0 then return end\n` +
    `  last = now\n` +
    `  snap()\n` +
    `end)\n` +
    // end-file carries the reason the file stopped. "eof" means mpv played it
    // to the end — that is definitive proof of completion, and far more
    // reliable than comparing a position against a duration (a file watched to
    // the end reports only 0.89-0.98 of its own runtime, because the last
    // checkpoint lands just before the final frames). "quit" is the user
    // pressing q: a real watch at a position, but not a finished one.
    `mp.register_event("end-file", function(ev)\n` +
    `  snap()\n` +
    `  local r = ev and ev.reason or ""\n` +
    `  local f = io.open(tmp, "w")\n` +
    `  if not f then return end\n` +
    `  f:write(string.format("%s %.3f %.3f", r, best, bestdur))\n` +
    `  f:close()\n` +
    `  os.remove(out)\n` +
    `  os.rename(tmp, out)\n` +
    `end)\n` +
    `mp.register_event("shutdown", snap)\n`;
  writeFileSync(scriptFile, lua);
  return scriptFile;
}

// What mpv reported: how far in, how long, and why it stopped.
// `eof` is mpv's own statement that the file played through — proof of
// completion, independent of any position/duration arithmetic.
// null when mpv never ran the script (no script, too old, killed before the
// first tick).
export function readProgress(dataFile) {
  if (!dataFile) return null;
  try {
    const raw = readFileSync(dataFile, 'utf8').trim();
    // Periodic checkpoints write "pos dur"; the end-file record prefixes the
    // reason. Both are accepted.
    const m = /^(eof|quit|error|unknown-file|redirect)?\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(raw);
    if (!m) return null;
    const positionSec = Number(m[2]);
    const durationSec = Number(m[3]);
    if (!Number.isFinite(positionSec) || positionSec < 0) return null;
    return {
      positionSec,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      reason: m[1] || null,
    };
  } catch {
    return null;
  }
}

export function clearProgress(report) {
  if (!report) return;
  for (const f of [report.script, report.data, `${report.data}.tmp`]) {
    try { rmSync(f, { force: true }); } catch {}
  }
}

function newProgressReport() {
  const dir = join(tmpdir(), 'fahy-cli');
  const id = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const script = join(dir, `pos-${id}.lua`);
  const data = join(dir, `pos-${id}.txt`);
  try {
    mkdirSync(dir, { recursive: true });
    pruneProgressFiles(dir);
    progressScript(script, data);
    return { script, data };
  } catch {
    return null; // a missing progress report must never block playback
  }
}

// A hard kill (a killed terminal, a power cut) leaves the script and its data
// behind — no handler runs, so nothing can clean up. Every file is named
// pos-<pid>-..., and a pid that is not running cannot be writing one, so its
// leftovers are safe to drop immediately. A file whose name has no usable pid is
// kept until it is old, in case it belongs to something we do not recognise.
export function pruneProgressFiles(dir, { maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('pos-')) continue;
    const file = join(dir, name);
    try {
      const pid = Number(name.split('-')[1]);
      if (Number.isInteger(pid) && pid > 0) {
        if (isAlive(pid)) continue; // its owner is still running
        rmSync(file, { force: true });
        continue;
      }
      if (Date.now() - statSync(file).mtimeMs > maxAgeMs) rmSync(file, { force: true });
    } catch {}
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to someone else.
    return e.code === 'EPERM';
  }
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
export function playFile(file, { volume = null, clean = false, logFile = null, positionMs = null, duration = null, debug = false } = {}) {
  const args = ['--really-quiet', ...mpvPrivacyArgs()];
  if (volume !== null && volume !== undefined) args.push(`--volume=${Math.max(0, Math.min(100, Number(volume) || 0))}`);
  const start = startArgFor(positionMs, duration);
  if (start) args.push(start);
  if (clean) args.push('--no-config');
  if (logFile) args.push(`--log-file=${logFile}`);
  args.push(file);
  if (debug) console.error(`[player] mpv ${args.join(' ')}`);
  return spawnMpv(args);
}
