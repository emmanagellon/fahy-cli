import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './lib/paths.js';

const dir = configDir();
const file = join(dir, 'config.json');

const defaults = {
  defaultProvider: { anime: 'hianime', youtube: 'youtube', music: 'ytmusic' },
  volume: 100,
  shuffle: false,
  repeat: 'off', // off | one | all
};

const REPEATS = new Set(['off', 'one', 'all']);

function sanitize(raw) {
  const cfg = { ...defaults, ...(raw || {}) };
  cfg.defaultProvider = { ...defaults.defaultProvider, ...((raw || {}).defaultProvider || {}) };
  const vol = Number(cfg.volume);
  cfg.volume = Number.isFinite(vol) ? Math.max(0, Math.min(100, vol)) : defaults.volume;
  cfg.shuffle = cfg.shuffle === true;
  if (!REPEATS.has(cfg.repeat)) cfg.repeat = defaults.repeat;
  return cfg;
}

export function loadConfig() {
  try {
    if (!existsSync(file)) return sanitize(null);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    // Drop retired keys (movies era) so old configs stay clean.
    delete raw.tmdbApiKey;
    return sanitize(raw);
  } catch {
    try {
      if (existsSync(file)) renameSync(file, `${file}.corrupt-${Date.now()}.bak`);
    } catch {}
    return sanitize(null);
  }
}

// Atomic write (tmp + rename), matching store.js — a crash mid-write
// must never leave a half-written config.json.
export function saveConfig(cfg) {
  mkdirSync(dir, { recursive: true });
  const safe = sanitize(cfg);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(safe, null, 2));
  renameSync(tmp, file);
  return file;
}

export function configPath() {
  return file;
}
