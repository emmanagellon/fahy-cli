// Terminal output — one place that decides what a line looks like, and one
// place that decides whether the terminal is free to take it.
//
// When a selector is on screen the frame owns the region it occupies, and
// anything printed would punch a permanent hole in it. So while a frame is
// live, log lines are folded INTO the frame (as its own status area) and result
// lines hand the terminal back first, then print underneath — which is also
// the behaviour you want: the selector disappears, the answer stays.
//
// Spinners are not a separate mechanism. A spinner is a one-line screen in the
// same region the results will occupy, so it animates in place and the results
// replace it in place. There is exactly one thing animating in fahy.
import chalk from 'chalk';

import { endFrame, frameLive, pushLog, showSpinner } from './tui/select.js';

// Start a one-line, in-place activity indicator. `stop()` retires it; if a
// selector has already taken the region over, the results simply stay.
export function startSpin(text) {
  return showSpinner(text);
}

const PAINT = {
  ok: (s) => chalk.green(s),
  warn: (s) => chalk.yellow(s),
  error: (s) => chalk.red(s),
  raw: (s) => s,
  dim: (s) => chalk.dim(s),
};

// A progress/notice line. With a frame up it is rendered by that frame; without
// one it is an ordinary line on stderr-free stdout, as it always was.
export function tlog(text, kind = 'dim') {
  if (frameLive()) {
    pushLog(text, kind);
    return;
  }
  console.log((PAINT[kind] || PAINT.dim)(text));
}

// A result the user asked for — always stdout, never dimmed, and never printed
// over a live selector. The frame is given back first so the line lands in the
// scrollback where it belongs.
export function say(text) {
  if (frameLive()) endFrame();
  console.log(text);
}

// A failure. Same handoff: the frame goes, then the message.
export function fail(text) {
  if (frameLive()) endFrame();
  console.error(chalk.red(text));
}

// Header for a block of command output. Kept to one line so a plain
// `fahy history` in a pipe reads as data, not as chrome.
export function heading(text) {
  if (frameLive()) endFrame();
  console.log(chalk.bold(text));
}

// The command is over, so the terminal goes back — once, at the boundary, for
// every command.
//
// say/fail/heading each hand the frame back before they print, and the playback
// session hands it back when it ends. That covers every path where something is
// still to be written. It missed the one that isn't: a selector the user backed
// out of with esc or ctrl+c, where the command simply returns and prints
// nothing. The frame stayed up holding stdin in raw mode, so the event loop
// never drained — the process hung on a live selector with a hidden cursor, and
// nothing was left to interrupt it.
//
// A frame is a temporary surface. Its lifetime is the command's, not the
// printing's, so it is released here rather than at each return that happened
// to remember.
export function releaseTerminal() {
  if (frameLive()) endFrame();
}
