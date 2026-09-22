import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, statfsSync } from 'node:fs';
import { spawnSettled } from './lib/spawn.js';
import { buildBaseName } from './lib/filenames.js';
import { ytDlpPrivacyArgs } from './lib/privacy.js';
import { videosDir, musicDir } from './lib/paths.js';

export function defaultDownloadDir() {
  return videosDir();
}

export function defaultMusicDir() {
  return musicDir();
}

export function hasYtDlp() {
  try {
    const r = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore', shell: false });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Headers may arrive as a string ("K: V"), an array of strings/objects
// (player.js shape), or a plain object. Normalize to [key, value] pairs
// so Referer-locked CDNs don't 403 on download while playback works.
function normalizeHeaders(headers) {
  if (!headers) return [];
  const list = Array.isArray(headers) ? headers : [headers];
  const out = [];
  for (const h of list) {
    if (typeof h === 'string') {
      const i = h.indexOf(':');
      if (i > 0) out.push([h.slice(0, i).trim(), h.slice(i + 1).trim()]);
    } else if (h && typeof h === 'object' && !Array.isArray(h)) {
      for (const [k, v] of Object.entries(h)) out.push([k, v]);
    }
  }
  return out;
}

export function downloadSource({ url, title, season, episode, outDir, audio = false, headers, debug }) {
  const dir = outDir || (audio ? defaultMusicDir() : defaultDownloadDir());
  mkdirSync(dir, { recursive: true });
  const name = buildBaseName({ title, season, episode, audio });
  const out = join(dir, `${name}.%(ext)s`);
  // Music (ytmusic-player parity): extract mp3 audio only.
  // Tracking-free yt-dlp (no config/cache/cookies), same as search/mix.
  const args = [...ytDlpPrivacyArgs()];
  const dlArgs = audio
    ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', out, '--no-playlist']
    : ['-o', out, '--no-playlist', '--merge-output-format', 'mp4'];
  args.push(...dlArgs);
  for (const [k, v] of normalizeHeaders(headers)) args.push('--add-header', `${k}:${v}`);
  args.push(url);
  if (debug) console.error(`[dl] yt-dlp ${args.join(' ')}`);
  return spawnSettled('yt-dlp', args, { stdio: 'inherit' }).then(({ code }) => ({
    code,
    dir,
    pattern: `${name}.${audio ? 'mp3' : 'mp4'}`,
  }));
}

export function freeSpaceBytes(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const st = statfsSync(dir);
    return BigInt(st.bavail) * BigInt(st.bsize);
  } catch {
    return null; // unknown: don't block, just skip the warning
  }
}

export function guessFile({ title, season, episode, outDir, audio = false }) {
  const dir = outDir || (audio ? defaultMusicDir() : defaultDownloadDir());
  const name = buildBaseName({ title, season, episode, audio });
  return join(dir, `${name}.${audio ? 'mp3' : 'mp4'}`);
}
