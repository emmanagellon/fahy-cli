// Now Playing — the one screen that lives longer than a single question.
//
// It is still temporary: it takes over the selector's region when a track
// starts and hands it back when the track ends or the user leaves. It is a
// screen on the shared frame, not a second renderer — which is why the
// transition from a spinner to the transport bar, and from the bar to the
// "what next?" list, is an in-place repaint instead of a new screen.
//
// Purpose: with mpv silenced there is no on-screen feedback during music
// playback, so a live position/volume line is the only sign the thing is
// alive. Nothing here writes to the terminal outside the frame.
import chalk from 'chalk';

import { canSelect, short, mountScreen, endFrame, clipText, renderScreen } from './select.js';

export function fmtClock(s) {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return '--:--';
  const t = Math.max(0, Math.floor(Number(s)));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const r = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

const FOOTER = 'space pause · ←/→ seek · n/p next/prev · +/- vol · m mute · q back';

// Resolves { action: 'menu'|'next'|'prev'|'ended'|'failed', reason? }.
// Resolves (never throws) even if the daemon dies mid-frame, so playback can
// never wedge the CLI on a dead mpv.
export function nowPlaying(player, info = {}, hooks = {}) {
  if (!canSelect()) return Promise.resolve({ action: 'menu' });
  return (async () => {
    let finish = (v) => v;
    const frame = await mountScreen({
      state: {
        title: clipText(info.title || 'music', 60),
        subtitle: info.subtitle ? clipText(String(info.subtitle), 70) : '',
        body: [],
        counter: '',
        log: [],
      },
      render: (s, f) => {
        const { timePos, duration, paused } = player.state;
        const frac = duration > 0 && timePos >= 0 ? Math.max(0, Math.min(1, timePos / duration)) : 0;
        // Width follows the terminal, so a narrow window shortens the bar
        // instead of wrapping it onto a second line.
        const w = Math.max(10, Math.min(48, (f.columns || 80) - 8));
        const filled = Math.round(frac * w);
        const bar = '━'.repeat(filled) + '─'.repeat(w - filled);
        const body = [
          chalk.green(bar),
          chalk.dim(`${fmtClock(timePos)} / ${fmtClock(duration)}${paused ? ' · paused' : ''}`),
        ];
        return renderScreen({ ...s, body, footer: FOOTER }, f);
      },
      onKey: (k) => {
        // Fire and forget: a dead IPC socket must not throw inside the handler
        // and take the frame down with it.
        const send = (fn) => Promise.resolve().then(fn).catch(() => {});
        if (k.name === 'char' && !k.ctrl && k.char === ' ') send(() => player.togglePause());
        else if (k.name === 'char' && !k.ctrl && k.char === 'k') send(() => player.togglePause());
        else if (k.name === 'left') send(() => player.seek(-10));
        else if (k.name === 'right') send(() => player.seek(10));
        else if (k.name === 'char' && !k.ctrl && k.char === 'n') finish({ action: 'next' });
        else if (k.name === 'char' && !k.ctrl && k.char === 'p') finish({ action: 'prev' });
        else if (k.name === 'char' && !k.ctrl && (k.char === '+' || k.char === '=')) {
          const v = Math.min(100, (player.state.volume || 100) + 5);
          send(() => player.setVolume(v)).then(() => hooks.volume?.(v));
        } else if (k.name === 'char' && !k.ctrl && (k.char === '-' || k.char === '_')) {
          const v = Math.max(0, (player.state.volume || 100) - 5);
          send(() => player.setVolume(v)).then(() => hooks.volume?.(v));
        } else if (k.name === 'char' && !k.ctrl && k.char === 'm') send(() => player.send('cycle', 'mute'));
        else if (k.name === 'char' && !k.ctrl && k.char === 'q') finish({ action: 'menu' });
        else if (k.name === 'escape') finish({ action: 'menu' });
        else if (k.ctrl && k.char === 'c') finish({ action: 'menu' });
      },
    });
    if (!frame) return { action: 'menu' };
    return new Promise((resolve) => {
      let settled = false;
      finish = (v) => {
        if (settled) return;
        settled = true;
        cleanup();
        // The bar is transient: leaving it must not leave a stale transport
        // sitting above the shell prompt.
        endFrame();
        resolve(v);
      };
      const onEnd = (reason) => finish(reason === 'eof' ? { action: 'ended' } : { action: 'failed', reason });
      const onDead = () => finish({ action: 'failed', reason: 'player exited' });
      // Redraw on every daemon state tick. A dead player stops ticking, which
      // is exactly the signal the user needs to see, so no artificial timer.
      const bump = () => frame.paint();
      const cleanup = () => {
        player.off?.('state', bump);
        player.off?.('end-file', onEnd);
        player.proc?.off?.('exit', onDead);
      };
      player.on?.('state', bump);
      player.on?.('end-file', onEnd);
      player.proc?.once?.('exit', onDead);
      frame.paint();
    });
  })();
}

export { short };
