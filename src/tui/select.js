// Temporary selector — the only interactive surface fahy owns.
//
// It is not a TUI application. Each interaction mounts ONE frame (a region of
// the terminal, see ./frame.js), every step of a selection is a *swap* of that
// frame's content rather than a new renderer, and the frame is erased the
// moment the interaction is over. The shell comes back exactly as it was: no
// alternate screen, no full-screen app, nothing left behind.
//
// Design rules:
//   - Render IN PLACE. A step change repaints the region the previous step
//     occupied, so Search -> Season -> Episode -> Source is one object the user
//     watches change, not four screens printed one after another.
//   - One mount at a time. A concurrent caller joins the live one instead of
//     stacking two renderers on the same terminal.
//   - Loading, errors and background provider output are *part of the frame*.
//     Nothing else may write to the terminal while it is up, which is what
//     keeps it from being corrupted.
//   - Esc = back (resolves null, never throws). Ctrl+C = cancel.
//   - Resize re-renders against the live column/row count; long lists window;
//     long titles clip. Height only changes when the content genuinely does.
import chalk from 'chalk';

import { Frame } from './frame.js';

export function short(s, n = 64) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t;
}

// Items may be:
//   { label, hint?, value }        — a selectable row
//   '-'                             — a non-selectable separator
export function normalizeItems(items) {
  return (items || []).map((it, i) =>
    it === '-' ? { separator: true, key: `sep-${i}` } : { ...it, key: it.key ?? `i${i}`, value: it.value ?? i }
  );
}

function nextIndex(list, from, dir) {
  let i = from;
  for (let n = 0; n < list.length; n++) {
    i = (i + dir + list.length) % list.length;
    if (!list[i].separator) return i;
  }
  return from;
}

function lastSelectable(list) {
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].separator) return i;
  return 0;
}

function firstSelectable(list) {
  for (let i = 0; i < list.length; i++) if (!list[i].separator) return i;
  return 0;
}

export const DEFAULT_FOOTER = '↑↓ move · enter select · esc back';

// True when we can (and should) show an interactive selector.
export function canSelect() {
  const input = host?.input || process.stdin;
  const out = host?.out || process.stdout;
  return !!input.isTTY && !!out.isTTY;
}

// ---- the live frame --------------------------------------------------------

let frame = null;
// The in-flight question, so a second concurrent caller joins the first
// instead of mounting a rival renderer on the same terminal.
let pending = null;

// The streams the shared frame is built on. Null means "the process's own
// terminal", which is the only thing production ever uses. It is settable so
// the entire selection chain can be driven against a terminal emulator in the
// test suite: the contract being verified is a property of the real code path,
// not of a stand-in written to resemble it.
let host = null;

export function setTerminalHost(next) {
  const prev = host;
  host = next || null;
  return prev;
}

export function frameLive() {
  return !!frame;
}

// The live frame itself, or null. The test suite compares what the terminal
// actually shows against the lines the frame believes it owns; that comparison
// is the contract, and it is only possible from inside.
export function liveFrame() {
  return frame;
}

// Fold a background line (a provider warning, a debug trace) into the live
// frame's message area instead of printing it over the frame. Replay order is
// preserved when the frame gives the terminal back.
export function pushLog(text, kind = 'dim') {
  frame?.log(text, kind);
}

// Give the terminal back. Safe to call when nothing is up.
//
// `keep` leaves the final frame in the scrollback (used for a notice, where the
// message is the point).
//
// Everything the frame swallowed while it was up — a provider warning, a debug
// trace, an accidental console.log from anywhere in the process — is printed
// underneath once the frame is gone. The frame is a temporary surface, and a
// line that was only ever visible inside it is a line the user never got to
// read. The frame shows one line of it at a time; the scrollback keeps all of
// it, in order, exactly once.
export function endFrame({ keep = false } = {}) {
  const f = frame;
  frame = null;
  if (pending) {
    const p = pending;
    pending = null;
    p.resolve(null);
  }
  // Read before stopping: stop() takes the screen down and drops its state.
  const captured = keep || !f ? [] : (f.state?.log || []).map((l) => l?.text).filter(Boolean);
  if (f) f.stop({ keep });
  if (captured.length) {
    for (const line of captured) {
      try {
        console.log(line);
      } catch {}
    }
  }
}

async function ensureFrame() {
  // A frame that has stopped is not a frame. It can stop without going through
  // endFrame — a signal, an exit, a start() that threw — and handing a dead
  // frame to the next question means the selector is invisible and never
  // answers. Checked, not assumed.
  if (frame && !frame.alive) frame = null;
  if (frame) return frame;
  if (!canSelect()) return null;
  const f = new Frame(host || {});
  frame = f;
  try {
    await f.start();
  } catch {
    if (frame === f) frame = null;
    return null;
  }
  return frame;
}

// Mount a custom screen on the shared frame. Used by the now-playing bar so it
// reuses this region instead of bringing a second renderer with it.
export async function mountScreen({ state, render, onKey } = {}) {
  const f = await ensureFrame();
  if (!f) return null;
  f.setScreen({ state, render: (s) => render(s, f), onKey });
  return f;
}

// ---- shared layout ---------------------------------------------------------
//
// One builder for every screen, so the frame's chrome, its height accounting
// and its width clamping are decided in exactly one place. The selector, the
// spinner, the notice and the now-playing bar are all the same shape: a head,
// a body, a tail.

export function clipText(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t;
}

// A log line keeps the colour of the thing that produced it: a provider failure
// must not read like routine progress once it is folded into the frame.
function paintLog(line) {
  const s = clipText(line.text, 200);
  if (line.kind === 'error') return chalk.red(s);
  if (line.kind === 'warn') return chalk.yellow(s);
  if (line.kind === 'ok') return chalk.green(s);
  return chalk.dim(s);
}

function lastLogLine(log) {
  return log?.length ? paintLog(log[log.length - 1]) : '';
}

function build(state, dims) {
  const rows = dims?.rows || 24;
  const cols = dims?.columns || 80;
  const w = Math.max(16, cols - 2);
  // A short terminal drops the niceties before it drops the options.
  const compact = rows < 14;
  const body = state.body || [];
  const head = [];
  const tail = [];

  if (state.title) head.push(chalk.bold(clipText(state.title, w)));
  if (state.subtitle && !compact) head.push(chalk.dim(`  ${clipText(state.subtitle, w - 2)}`));
  const status = state.status || lastLogLine(state.log);
  if (status) head.push(`  ${status}`);
  // With no list on screen the whole (bounded) log shows, so provider failures
  // during a resolve are visible instead of swallowed.
  if (!body.length && state.log?.length) {
    for (const l of state.log) head.push(`  ${paintLog({ ...l, text: clipText(l.text, w - 2) })}`);
  }
  if (!body.length && state.empty) head.push(`  ${chalk.yellow(clipText(state.empty, w - 2))}`);
  if (body.length) {
    head.push('');
    if (state.counter) tail.push(chalk.dim(`  ${clipText(state.counter, w)}`));
    tail.push('');
  }
  if (state.footer && rows > 10) tail.push(chalk.dim(clipText(state.footer, w)));
  return { head, body, tail };
}

export function renderScreen(state, dims) {
  const { head, body, tail } = build(state, dims);
  return [...head, ...body, ...tail];
}

// Everything that is not a row. `maxVisible` is clamped against it so the frame
// always fits the terminal — a selector that overflows is a selector that
// scrolls, and a scrolled selector cannot redraw itself in place.
function chromeHeight(state, dims) {
  const { head, tail } = build(state, dims);
  return head.length + tail.length;
}

// ---- the list screen -------------------------------------------------------

// The selector's state, renderer and key handler are built as one unit: every
// keypress and every repaint read the same object, so what is on screen and
// what enter returns can never disagree.
export function listScreen(opts, done) {
  const items = normalizeItems(opts.items);
  const footer = opts.footer || DEFAULT_FOOTER;
  const emptyText = opts.emptyText || 'Nothing to choose here.';
  const want = Number(opts.maxVisible) > 0 ? Number(opts.maxVisible) : 12;

  const state = {
    title: opts.title || '',
    subtitle: opts.subtitle || '',
    status: '',
    items,
    index: items.length ? Math.min(Math.max(0, Number(opts.initialIndex) || 0), lastSelectable(items)) : 0,
    maxVisible: want,
    footer,
    emptyText,
  };
  // Clamp an out-of-range initial index onto a real row, never a separator.
  if (items.length && items[state.index]?.separator) state.index = firstSelectable(items);

  const selectable = () => items.map((x, i) => (x.separator ? -1 : i)).filter((i) => i >= 0);

  function dims(f) {
    return { rows: f?.rows || 24, columns: f?.columns || 80 };
  }

  function visibleCount(f) {
    const d = dims(f);
    // Probe with a placeholder row and counter so the budget covers the frame
    // exactly as it will be painted.
    const chrome = chromeHeight(
      { ...state, status: state.status || 'x', counter: 'x', body: [''] },
      d
    );
    return Math.max(1, Math.min(want, (d.rows - 1) - chrome));
  }

  // Pure windowing: the same index always lands on the same slice, and moving
  // the cursor can never make the frame grow or shrink.
  function windowFor(index, visible) {
    let start = index;
    const min = Math.max(0, items.length - visible);
    if (index - Math.floor(visible / 2) < 0) start = 0;
    else if (index - Math.floor(visible / 2) > min) start = min;
    else start = index - Math.floor(visible / 2);
    return Math.max(0, Math.min(start, min));
  }

  function render(s, f) {
    const d = dims(f);
    if (!s.items.length) {
      return renderScreen({ ...s, body: [], status: '', counter: '', empty: s.emptyText }, d);
    }
    const visible = visibleCount(f);
    const start = windowFor(s.index, visible);
    const width = Math.max(20, d.columns - 6);
    const rows = s.items.slice(start, start + visible).map((it, i) => {
      const active = start + i === s.index;
      if (it.separator) return chalk.dim(`  ${clipText(it.label ?? '', width)}`);
      const room = active && it.hint ? Math.max(12, width - String(it.hint).length - 2) : width;
      const label = clipText(it.label, room);
      const painted = active ? chalk.green(`❯ ${chalk.bold(label)}`) : `  ${label}`;
      return it.hint ? `${painted}${chalk.dim(`  ${clipText(it.hint, 28)}`)}` : painted;
    });
    const all = selectable();
    const pos = Math.max(0, all.indexOf(s.index));
    return renderScreen({ ...s, body: rows, counter: all.length > visible ? `${pos + 1}/${all.length}` : '' }, d);
  }

  function move(f, to) {
    state.index = Math.max(0, Math.min(to, items.length - 1));
    if (items[state.index]?.separator) state.index = nextIndex(items, state.index, to > items[state.index] ? 1 : -1);
    // One repaint, one state change. The frame rewrites only the two rows that
    // actually differ and leaves the rest of the region untouched.
    f?.paint();
  }

  function onKey(key, f, answer) {
    if (key.ctrl && key.char === 'c') return answer(null);
    if (key.name === 'escape') return answer(null);
    if (!items.length) {
      if (key.name === 'return') answer(null);
      return undefined;
    }
    if (key.name === 'return') {
      const picked = items[state.index];
      if (picked && !picked.separator) answer(picked.value);
      return undefined;
    }
    const visible = visibleCount(f);
    if (key.name === 'up') move(f, nextIndex(items, state.index, -1));
    else if (key.name === 'down') move(f, nextIndex(items, state.index, 1));
    else if (key.name === 'pageup') move(f, nextIndex(items, state.index, -visible));
    else if (key.name === 'pagedown') move(f, nextIndex(items, state.index, visible));
    else if (key.name === 'home') move(f, firstSelectable(items));
    else if (key.name === 'end') move(f, lastSelectable(items));
    else if (!key.ctrl && key.char === 'k') move(f, nextIndex(items, state.index, -1));
    else if (!key.ctrl && key.char === 'j') move(f, nextIndex(items, state.index, 1));
    else if (!key.ctrl && key.char === 'g') move(f, firstSelectable(items));
    else if (!key.ctrl && key.char === 'G') move(f, lastSelectable(items));
    return undefined;
  }

  // One question gets one answer. A keypress storm (a held arrow key, a
  // double Enter, a key arriving after the screen was already replaced) must
  // not resolve the same selection twice — the second answer would be applied
  // to a command that has already moved on.
  let settled = false;
  const answer = (value) => {
    if (settled) return;
    settled = true;
    done(value);
  };

  return { state, render, onKey: (k, f) => onKey(k, f, answer), items };
}

// ---- public screens --------------------------------------------------------

// Ask one question. Resolves the picked value, or null when the user backs out
// (esc / ctrl+c) or the list is empty.
export function select({ title, subtitle, items, initialIndex, footer, emptyText, maxVisible } = {}) {
  if (pending) return pending.promise;
  let resolve = () => {};
  const promise = new Promise((res) => {
    resolve = res;
  });
  const entry = { promise, resolve };
  pending = entry;
  promise.then(() => {
    if (pending === entry) pending = null;
  });
  (async () => {
    const f = await ensureFrame();
    if (!f) {
      resolve(null);
      return;
    }
    const screen = listScreen({ title, subtitle, items, initialIndex, footer, emptyText, maxVisible }, resolve);
    f.setScreen({ state: screen.state, render: (s) => screen.render(s, f), onKey: (k) => screen.onKey(k, f) });
  })();
  return promise;
}

// Yes/no in the same compact frame. Resolves boolean (false when backed out).
export function confirm({ title, message, yes = 'Yes', no = 'No' } = {}) {
  return select({
    title,
    subtitle: message,
    items: [
      { label: yes, value: true },
      { label: no, value: false },
    ],
    footer: 'enter confirm · esc cancel',
  }).then((v) => v === true);
}

// The loading state: one line, animated in place, in the same region the
// results will occupy. `stop()` retires it; if a list has already taken the
// region over, that is a no-op and the results stay exactly where they are.
export function showSpinner(text) {
  const handle = {
    text: '',
    start: () => handle,
    update: (t) => {
      handle.text = t;
      frame?.setSpin(t);
      return handle;
    },
    stop: () => {
      if (!frame) return handle;
      if (frame.spin) {
        frame.clearSpin();
        // Retire the region rather than leaving a blank rectangle behind. The
        // next step paints straight back into the same lines.
        frame.setScreen({ render: () => [], onKey: null });
      }
      return handle;
    },
  };
  if (!canSelect()) return handle;
  ensureFrame().then((f) => {
    if (!f || frame !== f) return;
    handle.text = text;
    f.setScreen({
      render: (s) => {
        const head = [];
        if (f.spin) head.push(`  ${chalk.dim(`${f.spinnerFrames[f.spin.index]} ${f.spin.text}`)}`);
        return [...head, ...renderScreen({ ...s, body: [], counter: '', footer: '' }, f)];
      },
      onKey: null,
    });
    f.setSpin(text);
  });
  return handle;
}

// One-shot informational frame: shows text, any key dismisses, and the frame is
// KEPT on screen — a failure should not scroll past as a bare line.
export function notice({ title, message, kind = 'error' } = {}) {
  if (!canSelect()) return Promise.resolve();
  return (async () => {
    const f = await ensureFrame();
    if (!f) return;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        endFrame({ keep: true });
        resolve();
      };
      f.setScreen({
        render: (s) => renderScreen({ ...s, body: [], counter: '', status: '', empty: '' }, f),
        onKey: (k) => {
          if (k.ctrl && k.char === 'c') {
            endFrame();
            process.exit(0);
          }
          done();
        },
        state: {
          title: title || 'fahy',
          subtitle: '',
          body: [],
          counter: '',
          status: chalk[kind === 'error' ? 'red' : kind === 'warn' ? 'yellow' : 'green'](short(message || '', 76)),
          log: [],
        },
      });
    });
  })();
}

// Free-text prompt, same in-place contract. Resolves the string, or null when
// the user backs out. Only reachable when canSelect() is true.
export function ask({ title, placeholder = '', initial = '' } = {}) {
  if (!canSelect()) return Promise.resolve(null);
  return (async () => {
    const f = await ensureFrame();
    if (!f) return null;
    return new Promise((resolve) => {
      const state = { title: title || '', subtitle: '', body: [], counter: '', value: String(initial ?? '') };
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        endFrame();
        resolve(value);
      };
      f.setScreen({
        render: (s) => {
          const width = Math.max(16, (f.columns || 80) - 6);
          const body = [`  ${chalk.green('❯')} ${clipText(s.value || placeholder, width)}`];
          return renderScreen({ ...s, body, footer: 'enter confirm · esc cancel' }, f);
        },
        onKey: (k) => {
          if ((k.ctrl && k.char === 'c') || k.name === 'escape') return finish(null);
          if (k.name === 'return') return finish(state.value.trim() || null);
          if (k.name === 'backspace') state.value = state.value.slice(0, -1);
          else if (k.name === 'char' && !k.ctrl) state.value += k.char;
          else return undefined;
          f.paint();
          return undefined;
        },
        state,
      });
    });
  })();
}

// Used by non-interactive paths (pipes, CI, scripts) to stay scriptable.
export function firstOf(items) {
  const list = normalizeItems(items);
  const row = list.find((x) => !x.separator);
  return row ? row.value : null;
}
