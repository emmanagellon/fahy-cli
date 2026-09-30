// Legacy flag compatibility.
//
// The CLI used to be one flat option set (`fahy -S "Frieren" -a`, `fahy
// --history`). The surface is now subcommands (`fahy anime Frieren`,
// `fahy history`). Old invocations still work: this module rewrites argv into
// the new form before commander sees it, so nothing downstream has to know
// both dialects exist.
//
// Pure. Returns { argv, note } where note is a single line of migration
// guidance — never an error, never a deprecation wall. If nothing recognisable
// is found, argv comes back untouched so commander can report the real
// problem (an unknown flag, a typo) instead of this module guessing.
import { kindFor } from './modes.js';

const MODE_FLAGS = {
  '-a': 'anime', '--anime': 'anime',
  '--movie': 'movie',
  '--tv': 'tv',
  '-y': 'youtube', '--youtube': 'youtube',
  '-m': 'music', '--music': 'music',
};

// Bare flag -> the subcommand it means.
const FLAG_COMMANDS = {
  '--history': ['history'],
  '--clear-history': ['clear-history'],
  '--list-providers': ['providers'],
  '--provider-health': ['health'],
  '--doctor': ['doctor'],
  '--setup': ['setup'],
  '--diagnostics': ['diagnostics'],
  '--favorites': ['favorites'],
  '--favorite': ['favorite'],
  '--playlists': ['playlists'],
  '--offline': ['library'],
  '--library': ['library'],
  '--now': ['now'],
  '--downloads': ['downloads'],
  '--prune': ['prune'],
  '--check-sources': ['sources'],
  '--update-sources': ['sources', '--update'],
  '--continue': ['continue'],
  '--uninstall': ['uninstall'],
};

// Flag whose value becomes an argument on a different subcommand.
const VALUE_COMMANDS = {
  '--playlist': ['playlist'],
  '--playlist-add': ['playlist-add'],
  '--playlist-clear': ['playlist-clear'],
  '--volume': ['volume'],
  '--repeat': ['repeat'],
  '--auto-update': ['auto-update'],
  '--reset-health': ['health', '--reset'],
  '--upgrade': ['upgrade'],
  '--set-default-provider': ['providers', '--default'],
  '--set-priority': ['providers', '--priority'],
};

// Flags that mean "toggle this setting" when they carry no value.
const TOGGLE_COMMANDS = { '--shuffle': 'shuffle', '--autoplay': 'autoplay' };

const KNOWN_COMMANDS = new Set([
  'anime', 'tv', 'movie', 'yt', 'youtube', 'music',
  'history', 'continue', 'clear-history', 'now', 'providers', 'health', 'doctor',
  'setup', 'diagnostics', 'sources', 'downloads', 'library', 'prune',
  'favorites', 'favorite', 'playlists', 'playlist', 'playlist-add', 'playlist-clear',
  'radio', 'volume', 'shuffle', 'repeat', 'autoplay', 'auto-update',
  'upgrade', 'uninstall', 'version', 'help',
]);

const NODE = 'node';
const FAHY = 'fahy';

function splitInline(token) {
  const eq = token.indexOf('=');
  if (eq < 1) return [token, null];
  return [token.slice(0, eq), token.slice(eq + 1)];
}

export function normalizeArgv(argv) {
  const tokens = argv.slice(2);
  if (!tokens.length) return { argv: argv.slice(0, 2), note: null };

  // Already new-style: a leading subcommand. Nothing to do.
  if (typeof tokens[0] === 'string' && KNOWN_COMMANDS.has(tokens[0])) {
    return { argv, note: null };
  }

  let mode = null;
  let query = null;
  let command = null;
  const rest = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (typeof token !== 'string') {
      rest.push(token);
      continue;
    }
    const [flag, inline] = splitInline(token);

    if (MODE_FLAGS[flag]) {
      mode = MODE_FLAGS[flag];
      continue;
    }
    if (flag === '-t' || flag === '--type') {
      const v = inline ?? tokens[++i];
      if (v) mode = String(v);
      continue;
    }
    // The query runs from -S to the next flag, so `fahy -S Frieren Beyond`
    // works without quoting.
    if (flag === '-S' || flag === '--search') {
      if (inline !== null) {
        query = inline;
        continue;
      }
      const words = [];
      while (i + 1 < tokens.length && !(typeof tokens[i + 1] === 'string' && tokens[i + 1].startsWith('-'))) {
        words.push(tokens[++i]);
      }
      if (words.length) query = words.join(' ');
      continue;
    }
    // Consumed outright: these are subcommands now, and forwarding the old
    // flag would hand commander an option it no longer defines.
    if (FLAG_COMMANDS[flag]) {
      if (!command) command = FLAG_COMMANDS[flag];
      continue;
    }
    if (VALUE_COMMANDS[flag]) {
      const v = inline ?? tokens[++i];
      if (!command && v !== undefined && v !== null && String(v) !== '') {
        command = [...VALUE_COMMANDS[flag], String(v)];
      }
      continue;
    }
    if (TOGGLE_COMMANDS[flag]) {
      const name = TOGGLE_COMMANDS[flag];
      if (!command) command = inline ? [name, inline] : [name];
      else rest.push(token);
      continue;
    }
    rest.push(token);
  }

  // Nothing recognisable: let commander report the actual problem.
  if (!command && !mode && query === null) return { argv, note: null };

  const kind = mode ? kindFor(mode) : null;
  // An unknown --type value must reach commander so it can say so.
  if (mode && !kind) return { argv, note: null };

  if (command) {
    const lead = kind && query ? [kind, query, ...command] : command;
    const note = kind && query ? `note: use \`fahy ${kind} "${query}"\`` : 'note: `fahy --flag` is now `fahy <command>`';
    return { argv: [NODE, FAHY, ...lead, ...rest], note };
  }
  if (kind) return { argv: [NODE, FAHY, kind, ...(query ? [query] : []), ...rest], note: query ? `note: use \`fahy ${kind} "${query}"\`` : null };
  // A query with no mode: `-S "x"` on its own keeps the old default lane.
  if (query) return { argv: [NODE, FAHY, 'anime', query, ...rest], note: `note: use \`fahy anime "${query}"\`` };
  return { argv, note: null };
}
