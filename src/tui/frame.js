// The one thing in fahy that is allowed to touch the terminal while a
// selection is on screen.
//
// Everything interactive in the CLI (search results, season, episode, source,
// history, the now-playing bar, the loading spinner) is a *screen*: a pure
// function from state to a list of terminal lines. This module owns one region
// of the screen, paints those lines back over themselves, and gives the region
// back when the interaction is over. No other module writes to stdout/stderr
// while a frame is live — the guard installed on mount makes that a rule, not a
// convention.
//
// The contract, in order of importance:
//   1. One frame at a time. A second screen replaces the first *in place*; it
//      never stacks a second renderer on the same terminal.
//   2. A repaint rewrites the lines that changed and leaves the rest alone. A
//      cursor move or a spinner tick touches one line, not the whole frame.
//   3. Shrinking the frame clears the lines the old frame owned, so a shorter
//      list can never leave a tail of stale rows behind.
//   4. Nothing is painted until there is provably room for the frame. Writing
//      past the last row scrolls the screen, and a scrolled screen invalidates
//      every relative cursor move that follows — which is exactly how a
//      "persistent" selector degenerates into a pile of duplicated screens.
//   5. Unmounting restores the terminal: cursor shown, raw mode off, frame
//      erased (or deliberately kept), guards removed.
//
// Nothing here is a full-screen application: no alternate screen, no
// application mode, no scroll region, no dashboard. The frame is a rectangle of
// ordinary scrollback that happens to be repainted.
import chalk from 'chalk';

const ESC = '\u001B';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
// Carriage return first: vertical cursor movement preserves the column, so
// every line write has to re-home before it can clear or draw.
const ERASE_LINE = `\r${ESC}[2K`;
// Device Status Report: "where is the cursor". The reply comes back on stdin as
// ESC [ row ; col R and is the only way to know the frame will fit.
//
// Deliberately unanchored. A terminal does not hand the reply over on its own:
// it arrives coalesced with whatever else stdin produced in the same read — the
// newline the shell echoed when the command was launched, a key the user pressed
// while the frame was asking. An anchored pattern only matches a chunk that is
// nothing but the reply, so every one of those coalesced reads missed, and the
// reply was pushed into the key buffer instead, where "ESC [ 3 ; 1 R" decodes as
// the Escape key. The frame therefore cancelled its own selector the moment it
// asked the terminal a question, which is why a selector could mount and vanish
// in the same breath.
const ASK_CURSOR = `${ESC}[6n`;
const DSR_REPLY = /\u001B\[(\d+);(\d+)R/;

const DSR_TIMEOUT_MS = 120;
// How long a lone ESC waits before it is decided to be the Escape key rather
// than the start of an arrow-key sequence.
const ESC_TIMEOUT_MS = 35;
const SPINNER_MS = 80;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FALLBACK = ['-', '\\', '|', '/'];
// How many background lines the frame keeps visible. Bounded so a chatty
// debug run cannot grow the frame without limit.
const LOG_LINES = 6;
// How many times a re-place may re-read the screen before it settles. Each pass
// costs a cursor round trip, so this is a safety net for a screen that changes
// on every pass, not a knob.
const RELAYOUT_PASSES = 6;

// ---- ANSI-aware string helpers --------------------------------------------

const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`);
const CSI_G = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

export function stripAnsi(s) {
  return String(s ?? '').replace(CSI_G, '');
}

// Width in terminal cells. Code points, not UTF-16 units, so an emoji or an
// astral title character counts once — the same count the terminal uses.
export function visibleLength(s) {
  return [...stripAnsi(s)].length;
}

// Hard width clamp that keeps escape sequences intact. A line that exactly
// fills the last column makes the terminal wrap, and a wrap moves the cursor
// down a line the frame does not know about. Every painted line goes through
// here, so the frame can never be the thing that scrolls the screen.
export function clip(s, n) {
  const str = String(s ?? '');
  if (n <= 0) return '';
  if (visibleLength(str) <= n) return str;
  const limit = Math.max(1, n - 1);
  let out = '';
  let vis = 0;
  let i = 0;
  while (i < str.length && vis < limit) {
    if (str[i] === ESC) {
      const m = CSI.exec(str.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = String.fromCodePoint(str.codePointAt(i));
    out += cp;
    vis += 1;
    i += cp.length;
  }
  return `${out}…`;
}

const up = (n) => (n > 0 ? `${ESC}[${n}A` : '');
const down = (n) => (n > 0 ? `${ESC}[${n}B` : '');

function sameLines(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- key decoding ----------------------------------------------------------

// Terminals send escape sequences, not key events. This turns a byte stream
// into named keys, buffering across chunk boundaries and holding a lone ESC
// briefly so `esc` is distinguishable from the start of an arrow key.
// CSI (ESC [ …) and SS3 (ESC O …) forms, plus the bare control characters.
// Written as concatenations of ESC + a plain suffix so a mistyped escape cannot
// silently produce a key that never matches: every sequence is built from the
// same two-part shape and the table below is the single source of truth.
const csi = (suffix) => `${ESC}[${suffix}`;
const ss3 = (suffix) => `${ESC}O${suffix}`;

const SEQUENCES = new Map([
  ['\r', { name: 'return' }],
  ['\n', { name: 'return' }],
  ['\t', { name: 'tab' }],
  [csi('3~'), { name: 'delete' }],
  [csi('5~'), { name: 'pageup' }],
  [csi('6~'), { name: 'pagedown' }],
  [csi('1~'), { name: 'home' }],
  [csi('4~'), { name: 'end' }],
  [csi('7~'), { name: 'home' }],
  [csi('8~'), { name: 'end' }],
  [csi('H'), { name: 'home' }],
  [csi('F'), { name: 'end' }],
  [csi('A'), { name: 'up' }],
  [csi('B'), { name: 'down' }],
  [csi('C'), { name: 'right' }],
  [csi('D'), { name: 'left' }],
  [csi('Z'), { name: 'tab', shift: true }],
  // Application cursor mode: same keys, different introducer.
  [ss3('A'), { name: 'up' }],
  [ss3('B'), { name: 'down' }],
  [ss3('C'), { name: 'right' }],
  [ss3('D'), { name: 'left' }],
  [ss3('H'), { name: 'home' }],
  [ss3('F'), { name: 'end' }],
]);
const MAX_SEQUENCE = Math.max(...[...SEQUENCES.keys()].map((k) => k.length));

function literalKey(s) {
  if (s === '\u007F' || s === '\b') return { name: 'backspace' };
  const code = s.codePointAt(0);
  if (code < 0x20) return { name: 'char', char: String.fromCodePoint(code + 0x60), ctrl: true };
  return { name: 'char', char: String.fromCodePoint(code) };
}

// Pull as many keys as the buffer currently holds. `pending` is set when the
// buffer is an incomplete sequence that more bytes could still complete;
// `force` decides the leftover as best it can instead of waiting.
export function drainKeys(buf, force = false) {
  const keys = [];
  let i = 0;
  let pending = false;
  while (i < buf.length) {
    const rest = buf.slice(i);
    // Longest known sequence that prefixes what we have. This covers the
    // single-character entries too (`\r`, `\n`, `\t`), so a plain Return is
    // decoded as Return rather than as a control character named 'r'.
    let matched = null;
    for (let len = Math.min(MAX_SEQUENCE, rest.length); len >= 1; len--) {
      const seq = rest.slice(0, len);
      if (SEQUENCES.has(seq)) {
        matched = { seq, key: SEQUENCES.get(seq) };
        break;
      }
    }
    if (matched) {
      keys.push({ ...matched.key, sequence: matched.seq });
      i += matched.seq.length;
      continue;
    }
    if (rest[0] === ESC) {
      if (force) {
        // A lone ESC with nothing usable after it is the Escape key.
        keys.push({ name: 'escape', sequence: rest });
        i = buf.length;
        break;
      }
      // An unterminated escape sequence: more bytes could still complete it.
      pending = true;
      break;
    }
    // One code point at a time so an astral character is never split.
    const ch = String.fromCodePoint(rest.codePointAt(0));
    keys.push({ ...literalKey(ch), sequence: ch });
    i += ch.length;
  }
  return { keys, rest: buf.slice(i), pending };
}

// ---- the frame -------------------------------------------------------------

// Streams and geometry are injected so the whole rendering contract can be
// tested without a terminal.
export class Frame {
  constructor({ out, input, columns, rows, cursorQuery = true, guard = null } = {}) {
    this.out = out || process.stdout;
    this.input = input || process.stdin;
    this._columns = columns || null;
    this._rows = rows || null;
    this._cursorQuery = cursorQuery;
    // Only the process's own streams get the write guard; a test double must
    // not have the real stdout re-routed underneath it.
    this._useGuard = guard === null ? this.out === process.stdout : guard;

    this.renderFn = () => [];
    this.state = { log: [] };
    this.prevLines = null;
    this.alive = false;
    this.anchored = false;

    // The rows this frame owns, and where the terminal's cursor is in them.
    // Both are tracked rather than assumed, because every relative cursor move
    // this frame emits is measured against them.
    this.region = null;
    this.cy = 0;
    this._laying = false;
    this._want = 0;

    this._keyHandler = null;
    this._buf = '';
    this._escTimer = null;
    this._querying = false;
    this._spinTimer = null;
    this._spinIndex = 0;
    this.spin = null;

    this._onData = (chunk) => this._feed(chunk);
    this._onResize = () => this.refresh();
    this._onExit = () => this._hardExit();
    this._onSignal = () => this._onSignalQuit();
    this._rawDepth = 0;
  }

  // Geometry always comes from the live stream. The constructor values are only
  // a fallback for a stream that reports no size (a pipe, a test double that
  // does not model one) — caching the real value here would be a bug, because
  // a terminal resize has to reach the very next repaint.
  get columns() {
    return this.out.columns || this._columns || 80;
  }

  get rows() {
    return this.out.rows || this._rows || 24;
  }

  get spinnerFrames() {
    const term = this.out.isTTY ? process.env.TERM : null;
    return term && term !== 'dumb' ? SPINNER_FRAMES : SPINNER_FALLBACK;
  }

  // ---- lifecycle ----

  // Resolve once the frame is anchored and safe to paint. Painting before this
  // point is a no-op; state changes still land, they just are not drawn yet.
  start() {
    if (this._starting) return this._starting;
    this.alive = true;
    this._starting = (async () => {
      this._attachInput();
      this._attachResize();
      this._attachGuards();
      process.once('exit', this._onExit);
      // In raw mode Ctrl+C arrives as a byte and never raises a signal. If raw
      // mode could not be entered, the signal is the only way out — and the
      // cursor has to come back on that path too, or the shell is left sitting
      // in the middle of a half-drawn frame.
      process.on('SIGINT', this._onSignal);
      process.on('SIGTERM', this._onSignal);
      this._writeRaw(HIDE_CURSOR);
      // The frame is mounted before its screen is known, so this first pass
      // reserves almost nothing. The real screen arrives a tick later, asks for
      // more room, and _relayout moves the region before anything is painted
      // into it.
      await this._relayout(this._compose().length);
    })();
    return this._starting;
  }

  stop({ keep = false } = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.anchored = false;
    this._stopSpinner();
    if (this._escTimer) clearTimeout(this._escTimer);
    this._escTimer = null;
    this._detachGuards();
    this._detachInput();
    this._detachResize();
    process.removeListener('exit', this._onExit);
    process.removeListener('SIGINT', this._onSignal);
    process.removeListener('SIGTERM', this._onSignal);
    if (keep) {
      this._writeRaw(`${SHOW_CURSOR}\r\n`);
    } else {
      this.erase();
      this._writeRaw(SHOW_CURSOR);
    }
    this.prevLines = null;
  }

  // Take the region back out of the scrollback, leaving the cursor where the
  // frame started so the shell prompt lands on the line the command began on.
  erase() {
    this._clearRegion();
  }

  // ---- screens ----

  // A screen is a render function plus a key handler. Replacing one with the
  // next is a single in-place repaint, which is how Search -> Season ->
  // Episode -> Source stays one object on screen instead of four.
  setScreen({ render, onKey, state } = {}) {
    if (typeof render === 'function') this.renderFn = render;
    this._keyHandler = typeof onKey === 'function' ? onKey : null;
    if (state) {
      // Adopt the screen's own object, not a copy of it. The screen keeps a
      // reference to its state and mutates it directly (that is what a plain
      // `state.index = n` in a key handler should do), so copying here would
      // silently split the screen's state from the one being rendered — the
      // cursor would move in the handler and never on screen.
      this.state = state;
      if (!Array.isArray(this.state.log)) this.state.log = [];
    }
    this.paint(true);
    return this;
  }

  // Patch state in place. Replacing the object would detach it from any screen
  // that captured a reference to it, which is exactly the split described in
  // setScreen.
  setState(patch) {
    Object.assign(this.state, patch || {});
    this.paint();
    return this;
  }

  onKey(fn) {
    this._keyHandler = typeof fn === 'function' ? fn : null;
  }

  // ---- in-frame status ----

  // A one-line, animated, in-place status. It lives in the same region as
  // everything else, so a spinner can never leave a trail of frames behind.
  setSpin(text) {
    this.spin = text ? { text, index: 0 } : null;
    if (this.spin) {
      if (!this._spinTimer) {
        this._spinTimer = setInterval(() => {
          if (!this.spin || !this.alive) return;
          this.spin.index = (this.spin.index + 1) % this.spinnerFrames.length;
          this.paint();
        }, SPINNER_MS);
        // Never the reason the process stays alive.
        this._spinTimer.unref?.();
      }
    } else {
      this._stopSpinner();
    }
    this.paint();
    return this;
  }

  clearSpin() {
    return this.setSpin(null);
  }

  // A line produced by something that is not the frame (a provider log, a
  // debug trace, a stray console.log). It is folded into the frame's own
  // message area instead of being printed over the top of it — that is the
  // whole reason a frame can be trusted to stay intact.
  log(text, kind = 'dim') {
    const line = String(text ?? '').trim();
    if (!line) return this;
    const log = [...(this.state.log || []), { text: line, kind }].slice(-LOG_LINES);
    this.state.log = log;
    this.paint();
    return this;
  }

  clearLog() {
    if (!(this.state.log || []).length) return this;
    this.state.log = [];
    this.paint();
    return this;
  }

  _stopSpinner() {
    if (this._spinTimer) clearInterval(this._spinTimer);
    this._spinTimer = null;
  }

// ---- geometry rework -------------------------------------------------------
//
// Replaces `_anchor` / `erase` / `paint` / `refresh` / `_frameHeight` in the
// Frame class, and adds the region bookkeeping they need.

  // ---- where the frame lives ----
  //
  // A frame owns a rectangle of rows: `top` is the first of them, `room` is how
  // many it was given, and `anchorBelow` says whether the cursor was parked on
  // a line *under* the frame. Everything the frame draws is expressed relative
  // to `top`, and the frame keeps its own cursor row so those relative moves
  // stay correct. That bookkeeping is the whole reason a repaint cannot land on
  // the wrong line: a move is only ever emitted when it is known to be inside
  // the region.
  //
  // `this.cy` is the frame's model of the terminal's cursor row. It is
  // conservative: a cursor-down that would walk off the bottom is clamped, and
  // the only way the frame ever scrolls the screen is by asking for it in
  // _reserve, before it has painted anything.

  _compose() {
    let lines;
    try {
      lines = this.renderFn(this.state) || [];
    } catch (e) {
      lines = [chalk.red(`frame failed: ${e?.message || e}`)];
    }
    // A screen that returns a bare string is a one-line screen, not a crash.
    if (!Array.isArray(lines)) lines = [lines];
    const width = Math.max(8, this.columns - 1);
    // Never taller than the screen: a frame that overflows is a frame that
    // scrolls, and a scrolled frame cannot keep its own coordinates.
    const budget = Math.max(1, this.rows - 1);
    return lines.slice(0, budget).map((l) => clip(String(l ?? ''), width));
  }

  // Relative cursor moves, with the model kept in step. Every `up`/`down` the
  // frame emits goes through here, so `cy` can never drift from what the
  // terminal actually did.
  _up(s, from, n) {
    const k = Math.max(0, Math.min(from, n));
    return k > 0 ? { s: s + up(k), cy: Math.max(0, from - k) } : { s, cy: from };
  }

  _down(s, from, n) {
    const k = Math.max(0, n);
    if (k <= 0) return { s, cy: from };
    // Cursor-down stops at the last row. It never scrolls — which is precisely
    // why the frame buys its room up front instead of discovering the problem
    // halfway through a repaint.
    return { s: s + down(k), cy: Math.min(this.rows - 1, from + k) };
  }

  // Put the region somewhere it can be painted safely, and remember exactly
  // where that is. Returns the new region. This is the only place the frame is
  // allowed to scroll the terminal, and it does so before painting anything.
  _reserve(height, row1) {
    const rows = this.rows;
    const room = Math.max(1, Math.min(height, rows));
    // `row1` is the cursor's 1-based line, or 0 when the terminal would not
    // say. With no answer, assume the worst: the cursor is on the last line.
    const r = row1 > 0 ? row1 : rows;
    if (r + room <= rows) {
      // It fits under the cursor, with a line to spare for the anchor the
      // shell prompt will eventually take back.
      this.cy = r - 1;
      return { top: r - 1, room, rows, anchorBelow: true };
    }
    if (r + room === rows + 1) {
      // It fits exactly — the last line lands on the last row. No scrolling and
      // no anchor line below it, so the cursor rests on the frame's own last
      // line. Off by one here and every fit to the bottom of the window turns
      // into an unnecessary scroll that throws the command line off the top.
      this.cy = r - 1;
      return { top: r - 1, room, rows, anchorBelow: false };
    }
    // It does not fit, and a cursor can never be moved up: the only way to get
    // space is to push the screen up and take the bottom `room` rows. Scroll
    // exactly that much, then stand on the first of them. The frame ends flush
    // with the bottom, so there is no anchor line below it and the last line is
    // where the cursor rests.
    this._writeRaw('\n'.repeat(room));
    this.cy = rows - 1;
    const top = rows - room;
    const back = this._up('', this.cy, this.cy - top);
    this._writeRaw(back.s);
    this.cy = back.cy;
    return { top, room, rows, anchorBelow: false };
  }

  // Take the region back out of the screen, leaving the cursor where the shell
  // prompt belongs. Safe to call when nothing is placed.
  //
  // `park` is 'anchor' (the default) to leave the cursor where the prompt
  // belongs once the frame is finished with, or 'top' to stand on the region's
  // first line so the region can be re-placed without drifting. Re-placing from
  // wherever the cursor happened to be left is how a region creeps one line
  // down the screen on every step, until it starts scrolling and shoving the
  // user's command line off the top.
  _clearRegion({ park = 'anchor' } = {}) {
    const region = this.region;
    const n = this.prevLines ? this.prevLines.length : 0;
    if (!region || !n) {
      this.prevLines = null;
      return;
    }
    let s = '';
    let cy = this.cy;
    ({ s, cy } = this._up(s, cy, cy - region.top));
    for (let i = 0; i < n; i++) {
      if (i > 0) ({ s, cy } = this._down(s, cy, 1));
      s += ERASE_LINE;
    }
    const to = park === 'top' ? region.top : region.anchorBelow ? region.top + n : region.top + n - 1;
    if (cy < to) ({ s, cy } = this._down(s, cy, to - cy));
    else ({ s, cy } = this._up(s, cy, cy - to));
    s += '\r';
    this._writeRaw(s);
    this.cy = cy;
    this.prevLines = null;
  }

  // Paint `next` into the region. Only the lines that changed are rewritten;
  // the cursor is walked to the frame's first row first, so this works from any
  // position the frame may have been left in.
  _draw(next, force = false) {
    const region = this.region;
    if (!region) return;
    const prev = this.prevLines;
    if (!force && sameLines(prev, next)) return;
    const top = region.top;
    let s = '';
    let cy = this.cy;
    ({ s, cy } = this._up(s, cy, cy - top));
    // Walk the whole owned height, including rows this frame no longer has, so
    // a shorter screen cannot leave a tail of stale rows behind.
    const total = Math.max(next.length, prev ? prev.length : 0);
    for (let i = 0; i < total; i++) {
      if (i > 0) ({ s, cy } = this._down(s, cy, 1));
      if (i >= next.length) {
        s += ERASE_LINE;
        continue;
      }
      if (force || !prev || i >= prev.length || prev[i] !== next[i]) s += ERASE_LINE + next[i];
    }
    // Rest the cursor where the next repaint and the eventual shell prompt both
    // expect to find the anchor.
    const want = region.anchorBelow ? top + next.length : top + next.length - 1;
    if (cy < want) ({ s, cy } = this._down(s, cy, want - cy));
    else ({ s, cy } = this._up(s, cy, cy - want));
    s += '\r';
    this._writeRaw(s);
    this.cy = cy;
    this.prevLines = next;
  }

  // Re-place the region and repaint. Runs for three reasons: the first paint,
  // a screen that needs more room than was reserved (the common case — a frame
  // is mounted before its screen is known), and a resize.
  async _relayout(height) {
    if (!this.alive) return;
    if (this._laying) {
      // One re-place at a time. Take the biggest room anyone has asked for; the
      // pass in flight re-reads the screen when it comes back.
      this._want = Math.max(this._want || 0, height);
      return;
    }
    this._laying = true;
    try {
      let want = height;
      // Bounded, because the loop's exit condition depends on things that can
      // change under us. Every pass has to make progress or this never returns.
      for (let pass = 0; pass < RELAYOUT_PASSES; pass++) {
        this._want = 0;
        this._clearRegion({ park: 'top' });
        this.region = null;
        let next = this._compose();
        want = Math.max(want, next.length, this._want);
        const row1 = this._cursorQuery ? await this._askCursorRow() : 0;
        // Asking the terminal where the cursor is costs a round trip. Anything
        // that changed while we waited belongs in this pass, not the next one —
        // composing before the wait is how a second and third log line get
        // dropped on the floor and the screen keeps showing the first.
        next = this._compose();
        want = Math.max(want, next.length, this._want);
        this.region = this._reserve(want, row1);
        this.anchored = true;
        this._draw(next, true);
        // Does the screen still fit what was reserved? Asking the terminal
        // where the cursor is is the expensive part of a re-place and it only
        // has to happen when the answer can differ — when the screen has grown
        // since the room was bought. A change that still fits is painted into
        // the region already owned, which costs nothing and cannot move it.
        const shown = this._compose();
        if (shown.length <= this.region.room) break;
        want = shown.length;
      }
    } catch {
      // A terminal that will not answer or will not write leaves the frame
      // inert rather than half-drawn.
      this.region = null;
      this.prevLines = null;
    } finally {
      this._laying = false;
    }
  }

  // ---- painting ----

  paint(force = false) {
    if (!this.alive) return;
    if (this._laying) {
      // A re-place is in flight and owns the region. This paint is not dropped,
      // it is handed over: the pass re-reads the screen after it comes back and
      // buys more room if what it finds no longer fits. Starting a second
      // re-place here instead would ask the terminal where the cursor is once
      // per mutation, and a terminal that answers only sometimes would move the
      // region on a guess.
      return;
    }
    const next = this._compose();
    if (!this.region || this.region.rows !== this.rows || next.length > this.region.room) {
      // Not enough room for what is being asked for. Re-place instead of
      // painting into a region that cannot hold it — painting anyway is what
      // scrolls the screen mid-frame and desynchronises every later move.
      this._relayout(next.length);
      return;
    }
    this._draw(next, force);
  }

  // A resize can reflow every line below the cursor and can shrink the screen
  // below the frame's own height, which leaves the region stale: "walk up N
  // lines" no longer lands on the frame's first row. So a resize re-places.
  refresh() {
    if (!this.alive) return;
    this._relayout(this._compose().length);
  }

  // ---- internals ----

  _askCursorRow() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (row) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.input?.removeListener?.('data', onReply);
        this._querying = false;
        // Keystrokes typed during the handshake were buffered, not eaten.
        if (this._buf) {
          const held = this._buf;
          this._buf = '';
          this._feed(held);
        }
        resolve(row);
      };
      const onReply = (chunk) => {
        const s = String(chunk);
        const m = DSR_REPLY.exec(s);
        if (!m) {
          // Not the answer. Keep it — a key pressed during the handshake is not
          // lost, it is waiting.
          this._buf += s;
          return;
        }
        // The answer, plus whatever shared the read with it. Only the answer is
        // consumed; the rest is real input and is fed as keys.
        const rest = s.slice(0, m.index) + s.slice(m.index + m[0].length);
        if (rest) this._buf += rest;
        finish(Number(m[1]));
      };
      const timer = setTimeout(() => finish(0), DSR_TIMEOUT_MS);
      timer.unref?.();
      this._querying = true;
      this.input?.on?.('data', onReply);
      this._writeRaw(ASK_CURSOR);
    });
  }

  _attachInput() {
    const input = this.input;
    if (!input) return;
    try {
      if (this._rawDepth === 0 && input.isTTY) input.setRawMode(true);
      this._rawDepth += 1;
    } catch {}
    try {
      input.resume?.();
      input.setEncoding?.('utf8');
    } catch {}
    input.on?.('data', this._onData);
  }

  _detachInput() {
    const input = this.input;
    if (!input) return;
    input.removeListener?.('data', this._onData);
    this._rawDepth = Math.max(0, this._rawDepth - 1);
    if (this._rawDepth === 0) {
      try {
        if (input.isTTY) input.setRawMode(false);
      } catch {}
    }
    try {
      input.pause?.();
    } catch {}
  }

  _attachResize() {
    this.out.on?.('resize', this._onResize);
  }

  _detachResize() {
    this.out.removeListener?.('resize', this._onResize);
  }

  // Ctrl+C in raw mode arrives as a byte, not a signal, so the key handler
  // normally deals with it. A real SIGINT (some terminals, or a `kill`) still
  // has to put the terminal back before anyone else can act on it.
  _onSignalQuit() {
    this.stop();
  }

  _attachGuards() {
    if (!this._useGuard) return;
    const g = installGuards(this);
    // The frame's own drawing path, captured from the stream it actually draws
    // to. When that stream is the process's stdout the guard has just patched
    // it, so the pristine method is used; when it is anything else, the guard
    // never touched it and its own method is the real thing. Either way the
    // frame draws to the stream it was given, and its own output is never
    // mistaken for background noise.
    this._rawOut = this.out === g.out ? g.outWrite.bind(g.out) : this.out.write.bind(this.out);
    this._rawErr = this.out === g.err ? g.errWrite.bind(g.err) : null;
  }

  _detachGuards() {
    if (!this._useGuard) return;
    removeGuards(this);
  }

  _feed(chunk) {
    if (this._querying) return; // the cursor-position handshake owns stdin
    this._buf += String(chunk);
    const { keys, rest, pending } = drainKeys(this._buf);
    this._buf = rest;
    if (this._escTimer) {
      clearTimeout(this._escTimer);
      this._escTimer = null;
    }
    if (pending) {
      // An unterminated sequence: give it one short window to complete, then
      // decide on what is actually here.
      this._escTimer = setTimeout(() => this._flushPartial(), ESC_TIMEOUT_MS);
      this._escTimer.unref?.();
    }
    for (const key of keys) this._dispatch(key);
  }

  _flushPartial() {
    if (this._escTimer) {
      clearTimeout(this._escTimer);
      this._escTimer = null;
    }
    if (!this._buf) return;
    const { keys, rest } = drainKeys(this._buf, true);
    this._buf = rest;
    for (const key of keys) this._dispatch(key);
  }

  _dispatch(key) {
    try {
      this._keyHandler?.(key);
    } catch {}
  }

  _writeRaw(s) {
    if (!s) return;
    try {
      // The guard patches out.write, so the frame must go through the
      // original it captured on mount — otherwise its own output is captured
      // as background noise and it can never draw.
      const write = this._rawOut || this.out.write;
      write.call(this.out, s);
    } catch {}
  }

  // The process is exiting: the cursor has to come back no matter what. Same
  // teardown as stop(), best effort, because there is no second chance here.
  _hardExit() {
    this._stopSpinner();
    try {
      this._clearRegion();
    } catch {}
    try {
      this._writeRaw(SHOW_CURSOR);
    } catch {}
  }
}

// ---- the write guard -------------------------------------------------------
//
// The rule that keeps a frame intact: while a frame is live, nothing writes to
// stdout or stderr except the frame. Debug logs, provider chatter, an
// accidental console.log from anywhere in the process are captured and folded
// into the frame's own message area instead of punching a permanent hole in
// it. This is what makes "one persistent region" a property of the program
// rather than a habit.

let guard = null;

const route = (original) => (chunk, encoding, cb) => {
  const done = typeof encoding === 'function' ? encoding : cb;
  const live = guard && guard.frame && guard.frame.alive;
  if (live) {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    // Whole lines only: a partial line or a stray carriage return must not be
    // able to move the frame's cursor.
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) guard.frame.log(line, 'dim');
    }
    done?.();
    return true;
  }
  return original(chunk, encoding, cb);
};

// Patch the process's own streams so nothing can punch a hole in a live frame,
// and keep the pristine methods so the patch can be lifted again.
//
// Note what is deliberately absent: any opinion about where the frame draws. A
// frame may be rendering to a stream that is not the process's stdout at all —
// a test double, an embedded surface — and the frame's own drawing path is
// captured by Frame from its own stream (see _attachGuards). Reaching for
// process.stdout here instead is how a frame ends up painting to the real
// terminal while its caller believes it is painting somewhere else.
function installGuards(frame) {
  if (!guard) {
    const out = process.stdout;
    const err = process.stderr;
    const outWrite = out.write;
    const errWrite = err.write;
    out.write = route(outWrite.bind(out));
    err.write = route(errWrite.bind(err));
    guard = { out, err, outWrite, errWrite };
  }
  guard.frame = frame;
  return guard;
}

function removeGuards(frame) {
  if (!guard) return;
  if (frame && guard.frame !== frame) return;
  const { out, err, outWrite, errWrite } = guard;
  try { out.write = outWrite; } catch {}
  try { err.write = errWrite; } catch {}
  guard = null;
}

// True when something is holding the terminal. Callers use this to decide
// whether their output can go straight through, or has to be deferred.
export function terminalOwned() {
  return !!guard;
}

export { HIDE_CURSOR, SHOW_CURSOR, ERASE_LINE };
