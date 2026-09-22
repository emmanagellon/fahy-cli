// Shared subtitle fetch: pick English, download to temp for mpv --sub-file.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { safeFileName } from './lib/filenames.js';

const MAX_SUB_BYTES = 2 * 1024 * 1024;

export function pickEnglish(captions) {
  const list = (captions || []).filter((c) => c && /^https?:\/\//i.test(c.url || c.src || ''));
  if (!list.length) return null;
  const en = list.find((c) => /en\b/i.test(c.lang || c.language || '') || /english/i.test(c.label || ''));
  if (en) return en;
  // No English track: signal a guess instead of silently returning non-English.
  return { ...list[0], guessed: true };
}

export async function downloadSub(url, name, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { ...headers, Connection: 'close' }, signal: ctrl.signal });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_SUB_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_SUB_BYTES) return null;
    const dir = join(tmpdir(), 'fahy-cli');
    mkdirSync(dir, { recursive: true });
    const ext = /\.vtt$/i.test(name) ? '.vtt' : /\.srt$/i.test(name) ? '.srt' : '.vtt';
    const f = join(dir, `${safeFileName(name).replace(/\.[a-z0-9]+$/i, '')}-${process.pid}-${Date.now()}${ext}`);
    writeFileSync(f, buf);
    return f;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
