import { basename } from 'node:path';

// Shared filename helpers: one builder for downloads + library guesses.
// yt-dlp sanitization differs slightly, so guessFile() stays a guess —
// downloads record the real file when known.
function safeName(s) {
  const clean = String(s || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return clean || 'video';
}

export function buildBaseName({ title, season, episode, audio = false }) {
  const tag = !audio && season
    ? `S${season}E${episode}`
    : !audio && episode
      ? `E${episode}`
      : null;
  return [safeName(title), tag].filter(Boolean).join(' - ');
}

// Temp-file-safe name: basename + strict whitelist so provider-supplied
// names can never escape the tmp dir (path traversal).
export function safeFileName(name, fallback = 'file') {
  const base = basename(String(name || fallback));
  const clean = base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return clean || fallback;
}
