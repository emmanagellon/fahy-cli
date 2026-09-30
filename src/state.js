// Process-wide state shared by the command modules.
//
// Deliberately a module singleton rather than a passed context: config is read
// and written from the playback cycle, the admin commands and the music
// daemon, and threading it through all of them added noise without adding
// safety. Everything here is explicit and typed by its own module.
import { loadConfig, saveConfig } from './config.js';

export const config = loadConfig();

// Playback modes: flags set them, they persist for the session and the config.
export const session = {
  shuffle: !!config.shuffle,
  repeat: ['off', 'one', 'all'].includes(config.repeat) ? config.repeat : 'off',
  autoplay: !!config.autoplay,
  debug: false,
};

// The merged option bag for the command currently running. Commands that need
// a flag set it here; the playback core reads it. Keeping one bag means the
// core never has to care which subcommand invoked it.
export const opts = {
  // Advanced playback flags. All default to "not chosen" so a plain
  // `fahy anime "Frieren"` never stops to ask a question the user could not
  // have answered.
  provider: null,
  season: null,
  episode: null,
  audio: null, // 'sub' | 'dub' | null
  download: false,
  downloadPath: null,
  printUrl: false,
  fallback: true, // --no-fallback sets this false
  best: false,
  autoplay: false,
  mpvClean: false,
  mpvLog: null,
  url: null,
};

export function persistModes() {
  saveConfig({ ...config, shuffle: session.shuffle, repeat: session.repeat });
}

export function setVolume(v) {
  const next = Math.max(0, Math.min(100, Number(v) || 0));
  saveConfig({ ...config, volume: next });
  config.volume = next;
  return next;
}

// --volume takes 0-100, or +/-N to move relative to the current level.
export function applyVolumeArg(raw) {
  const text = String(raw);
  const cur = Number(config.volume ?? 100) || 0;
  let next;
  if (/^[+-]\d+$/.test(text)) next = cur + Number(text);
  else if (/^\d+$/.test(text)) next = Number(text);
  else return null;
  return setVolume(Math.max(0, Math.min(100, next)));
}

export function setDefaultProvider(kind, id) {
  const names = { ...(config.defaultProvider || {}), [kind]: id };
  saveConfig({ ...config, defaultProvider: names });
  config.defaultProvider = names;
}

export function setAutoplay(on) {
  session.autoplay = !!on;
  saveConfig({ ...config, autoplay: session.autoplay });
}

export const AUTO_UPDATE_MODES = ['notice', 'install', 'off'];
