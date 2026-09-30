#!/usr/bin/env node
// fahy-cli — anime, TV, movies, YouTube and music in mpv.
//
//   fahy anime "Frieren"      search, pick, play
//   fahy tv "Daybreak"        season → episode → source → play
//   fahy music "lofi beats"   audio-only
//   fahy history              pick something you watched and resume it
//
// There is no TUI shell. A run is a command: it prints, it asks at most the
// questions that matter, and it exits. The only interactive surface is a
// short-lived in-place list, mounted for one question and unmounted the
// moment the answer arrives.
import { Command } from 'commander';
import chalk from 'chalk';

import { normalizeArgv } from './legacy-args.js';
import { installedVersion } from './update.js';
import { config, session, opts } from './state.js';
import { fail, releaseTerminal, say } from './ui.js';
import { classifyFailure } from './failure.js';
import {
  runPlay, runHistory, runContinue, clearHistoryCommand, runDeleteHistory, runRadio, runPlaylist,
} from './cli/play.js';
import {
  runVersion, runDoctor, runSetup, runDiagnostics, runProviders, runHealth, runSources,
  runDownloads, runPrune, runLibrary, runFavorites, runFavorite, runPlaylists, runPlaylistAdd,
  runPlaylistClear, runNow, runVolume, runShuffle, runRepeat, runAutoplay, runAutoUpdate,
  runUpgrade, runUninstall, maybeDailyFmhySync, maybeCheckForUpdates,
} from './cli/admin.js';

// Piping to head/short-lived readers closes stdout early (EPIPE). Swallow it
// and let the loop drain: force-exiting here trips a libuv assertion on
// Windows (async.c) because handles are still mid-flight.
process.stdout.on('error', (e) => {
  if (e?.code === 'EPIPE') {
    process.exitCode = 0;
    return;
  }
  throw e;
});
process.stderr.on('error', () => {});

const { argv, note } = normalizeArgv(process.argv);
// One line of migration guidance for a legacy invocation, on stderr so it can
// never contaminate piped output.
if (note && process.stderr.isTTY) process.stderr.write(`${chalk.dim(note)}\n`);

const program = new Command();
program
  .name('fahy')
  .description('Anime, TV, movies, YouTube and music in mpv.\n\nStart with:  fahy anime "Frieren"   ·   fahy history')
  .version(installedVersion(), '-V, --version', 'print the installed version')
  .helpOption('-h, --help', 'show help for a command')
  .showHelpAfterError('(run `fahy help <command>`)')
  .allowExcessArguments(true)
  .allowUnknownOption(false);

// ---- shared option groups -------------------------------------------------

// The advanced flags. They are available on every play command but are not
// part of the common path: `fahy anime "Frieren"` needs none of them.
function withPlayOptions(cmd) {
  return cmd
    .option('-p, --provider <id>', 'use this source instead of asking (see: fahy providers)')
    .option('-s, --season <n>', 'season number (anime/tv)')
    .option('-e, --episode <n>', 'episode number (anime/tv)')
    .option('--dub', 'prefer the English dub')
    .option('--sub-dub <mode>', 'audio mode: sub or dub')
    .option('--url <url>', 'play a YouTube URL or id directly (yt/music)')
    .option('--print-url', 'print the resolved URL and exit (no player)')
    .option('-d, --download', 'download via yt-dlp instead of playing')
    .option('--download-path <dir>', 'download directory for this run')
    .option('--best', 'take the first verified source, do not ask')
    .option('--no-fallback', 'only try the chosen source, never auto-fallback')
    .option('--autoplay', 'advance to the next episode/track automatically')
    .option('--radio', 'start a radio mix from this result (yt/music)')
    .option('--mpv-clean', 'launch mpv with --no-config')
    .option('--mpv-log <file>', 'write an mpv log to this file (evidence for bug reports)');
}

function withGlobalOptions(cmd) {
  return cmd.option('--debug', 'verbose resolve logging and stack traces');
}

// Resume takes the play flags that change *how* an item is played, not the ones
// that pick it: season/episode/url already come from the stored entry.
function withResumeOptions(cmd) {
  return withGlobalOptions(
    cmd
      .option('-p, --provider <id>', 'use this source instead of the remembered one')
      .option('--dub', 'prefer the English dub')
      .option('--sub-dub <mode>', 'audio mode: sub or dub')
      .option('--print-url', 'print the resolved URL and exit (no player)')
      .option('-d, --download', 'download via yt-dlp instead of playing')
      .option('--download-path <dir>', 'download directory for this run')
      .option('--best', 'take the first verified source, do not ask')
      .option('--no-fallback', 'only try the chosen source, never auto-fallback')
      .option('--autoplay', 'advance to the next episode/track automatically')
      .option('--radio', 'start a radio mix from this entry (yt/music)')
      .option('--mpv-clean', 'launch mpv with --no-config')
      .option('--mpv-log <file>', 'write an mpv log to this file (evidence for bug reports)')
  );
}

// ---- play commands --------------------------------------------------------

for (const [name, kind, blurb, alias] of [
  ['anime', 'anime', 'search AniList, pick a title/season/episode, play it'],
  ['tv', 'tv', 'search TMDB, pick a show/season/episode, play it'],
  ['movie', 'movie', 'search TMDB, pick a film, play it'],
  ['yt', 'youtube', 'search YouTube and play (audio + video)', 'youtube'],
  ['music', 'music', 'search YouTube Music and play audio only'],
]) {
  const cmd = program
    .command(name)
    .argument('[query...]', 'what to search for')
    .description(blurb);
  if (alias) cmd.alias(alias);
  withGlobalOptions(withPlayOptions(cmd));
  cmd.action(async (queryParts, commandOpts) => {
    // `--debug` is declared per-command but behaves globally.
    session.debug = !!commandOpts.debug;
    await preflight();
    await runPlay(kind, queryParts, commandOpts);
  });
}

// ---- history --------------------------------------------------------------

// Resume accepts the same play flags as a play command: the point of resuming
// is to get the item back, not to be stuck with the settings of last time.
withResumeOptions(
  program
    .command('history')
    .description('watch history — pick an entry to resume it where you stopped')
)
  .action(async (commandOpts) => {
    session.debug = !!commandOpts.debug;
    await preflight();
    await runHistory(commandOpts);
  });

withResumeOptions(
  program
    .command('continue')
    .description('resume the most recent resumable history entry')
)
  .action(async (commandOpts) => {
    session.debug = !!commandOpts.debug;
    await preflight();
    await runContinue(commandOpts);
  });

withGlobalOptions(
  program
    .command('clear-history')
    .description('delete every history entry')
    .option('-y, --yes', 'do not ask for confirmation')
)
  .action(async (commandOpts) => {
    await clearHistoryCommand({ force: !!commandOpts.yes });
  });

program
  .command('delete-history <url...>')
  .description('delete specific history entries by URL')
  .action(async (urls) => {
    await runDeleteHistory(urls);
  });

// ---- session settings -----------------------------------------------------

withGlobalOptions(
  program
    .command('volume [level]')
    .description('set volume: 0-100, or +N/-N to adjust')
)
  .action(async (level) => {
    if (level === undefined) {
      say(`Volume ${config.volume ?? 100}.`);
      return;
    }
    runVolume(level);
  });

withGlobalOptions(
  program
    .command('shuffle [mode]')
    .description('shuffle on|off (bare toggles)')
)
  .action(async (mode) => {
    runShuffle(mode);
  });

withGlobalOptions(
  program
    .command('repeat <mode>')
    .description('repeat off|one|all')
)
  .action(async (mode) => {
    runRepeat(mode);
  });

withGlobalOptions(
  program
    .command('autoplay [mode]')
    .description('autoplay on|off (bare toggles)')
)
  .action(async (mode) => {
    runAutoplay(mode);
  });

withGlobalOptions(
  program
    .command('auto-update [mode]')
    .description('update policy: notice|install|off (bare shows the current policy)')
)
  .action(async (mode) => {
    runAutoUpdate(mode);
  });

program.command('now').description('show the last thing played and the current session modes').action(async () => {
  runNow();
});

// ---- libraries ------------------------------------------------------------

withGlobalOptions(program.command('downloads').description('list the download queue')).action(async () => {
  runDownloads();
});

withGlobalOptions(program.command('prune').description('drop download entries whose files are gone')).action(async () => {
  runPrune();
});

withGlobalOptions(program.command('library').description('play something you already downloaded').option('--mpv-clean', 'launch mpv with --no-config').option('--mpv-log <file>', 'write an mpv log to this file')).action(async () => {
  await runLibrary();
});

withGlobalOptions(program.command('favorites').description('list favorites')).action(async () => {
  runFavorites();
});

withGlobalOptions(
  program
    .command('favorite')
    .description('toggle favorite on a history entry (newest by default)')
    .option('-n, --index <n>', 'history entry number, newest is 1')
)
  .action(async (commandOpts) => {
    await runFavorite({ index: commandOpts.index });
  });

withGlobalOptions(program.command('playlists').description('list saved playlists')).action(async () => {
  runPlaylists();
});

withGlobalOptions(
  program
    .command('playlist <name>')
    .description('play a saved playlist')
    .option('-p, --provider <id>', 'use this source instead of asking')
)
  .action(async (name, commandOpts) => {
    await runPlaylist(name, commandOpts);
  });

withGlobalOptions(
  program
    .command('playlist-add <name>')
    .description('add the newest history entry to a playlist')
)
  .action(async (name) => {
    runPlaylistAdd(name);
  });

withGlobalOptions(
  program
    .command('playlist-clear <name>')
    .description('delete a saved playlist')
)
  .action(async (name) => {
    runPlaylistClear(name);
  });

// ---- radio ----------------------------------------------------------------

withGlobalOptions(
  withPlayOptions(program.command('radio [url]').description('play a radio mix seeded from a URL or recent history'))
)
  .action(async (url, commandOpts) => {
    session.debug = !!commandOpts.debug;
    await preflight();
    await runRadio(url);
  });

// ---- admin ----------------------------------------------------------------

withGlobalOptions(program.command('doctor').description('check mpv, yt-dlp, transport and config health')).action(async (commandOpts) => {
  await runDoctor({ debug: commandOpts.debug });
});

withGlobalOptions(program.command('setup').description('guided setup: health check plus what to install')).action(async (commandOpts) => {
  await runSetup({ debug: commandOpts.debug });
});

withGlobalOptions(program.command('diagnostics').description('the last run: which sources were tried and what failed')).action(async () => {
  runDiagnostics();
});

withGlobalOptions(
  program
    .command('providers')
    .description('list source adapters')
    .option('--default <kind=id>', 'set the default source for a lane, e.g. anime=hianime')
    .option('--priority <kind=id1,id2>', 'set the fallback order, e.g. "anime=hianime,anikoto"')
)
  .action(async (commandOpts) => {
    runProviders({ setDefault: commandOpts.default, priority: commandOpts.priority });
  });

withGlobalOptions(
  program
    .command('health')
    .description('per-provider health memory')
    .option('--reset [id]', 'forget one provider, or all of them')
)
  .action(async (commandOpts) => {
    runHealth({ reset: commandOpts.reset });
  });

withGlobalOptions(
  program
    .command('sources')
    .description('diff the anime adapters against the live FMHY list and probe them')
    .option('--update', 'also pin the fastest healthy anime provider as the default')
)
  .action(async (commandOpts) => {
    await runSources({ update: !!commandOpts.update, debug: commandOpts.debug });
  });

withGlobalOptions(
  program
    .command('upgrade [version]')
    .description('upgrade fahy (latest, or pin a version)')
)
  .action(async (version, commandOpts) => {
    const code = runUpgrade(version, { debug: commandOpts.debug });
    if (code) process.exitCode = code;
  });

withGlobalOptions(
  program
    .command('uninstall')
    .description('remove the global fahy install')
    .option('--purge', 'also delete ~/.config/fahy-cli')
)
  .action(async (commandOpts) => {
    process.exitCode = runUninstall({ purge: !!commandOpts.purge });
  });

program.command('version').description('print the installed version').action(async () => {
  runVersion();
});

program.command('help [command]').description('show help, or help for one command').action(async (name) => {
  if (name) {
    const target = program.commands.find((c) => c.name() === name || c.aliases().includes(name));
    if (!target) {
      fail(`Unknown command: ${name}. Run \`fahy help\` for the list.`);
      process.exitCode = 1;
      return;
    }
    target.outputHelp();
    return;
  }
  program.outputHelp();
});

// ---- dispatch -------------------------------------------------------------

// One per run-day: a source diff and a version check, both silent unless
// something actually changed. Skipped entirely when not interactive or when
// the output is being piped somewhere.
async function preflight() {
  if (!process.stdin.isTTY || opts.printUrl) return;
  await maybeDailyFmhySync({ debug: session.debug });
  await maybeCheckForUpdates({ debug: session.debug });
}

function topLevelHelp() {
  program.outputHelp();
  say('');
  say(chalk.dim('Examples:'));
  say(chalk.dim('  fahy anime "Frieren"                      pick a title, season, episode, source'));
  say(chalk.dim('  fahy tv "Daybreak" -s 1 -e 1              skip the season/episode prompts'));
  say(chalk.dim('  fahy music "lofi beats"                   audio only'));
  say(chalk.dim('  fahy history                             resume something you watched'));
  say(chalk.dim('  fahy anime "Frieren" -e 5 --print-url    just the stream URL'));
  say(chalk.dim('  fahy doctor                              check mpv / yt-dlp / config'));
}

// Every failure becomes one actionable line. The stack trace is opt-in.
function reportError(e) {
  if (e?.message === 'cancelled' || e?.name === 'CancelledError') {
    process.exitCode = 0;
    return;
  }
  const c = classifyFailure(e);
  const msg = c.class === 'unknown'
    ? String(e?.message || e)
    : `${c.summary} ${c.detail !== c.summary ? `(${c.detail})` : ''}`.trim();
  fail(`fahy: ${msg}`);
  if (session.debug) console.error(e);
  process.exitCode = 1;
}

process.on('uncaughtException', reportError);
process.on('unhandledRejection', reportError);

if (!argv.slice(2).length) {
  topLevelHelp();
} else {
  try {
    // `argv` is node-style ([node, script, ...args]) — normalizeArgv keeps that
    // shape, so commander gets the default 'node' parsing.
    await program.parseAsync(argv);
  } catch (e) {
    // commander has already printed usage/help for its own errors; anything
    // else came from a command action and is ours to explain.
    if (typeof e?.code === 'string' && e.code.startsWith('commander.')) {
      process.exitCode = e.exitCode === 0 ? 0 : 1;
    } else {
      reportError(e);
    }
  } finally {
    // Every command ends here, including the ones that end in a cancel and
    // print nothing. A frame left up holds the terminal — stdin in raw mode,
    // cursor hidden — and would keep the process alive on a selector the user
    // already walked away from.
    releaseTerminal();
  }
}
