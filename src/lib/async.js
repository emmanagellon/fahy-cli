// Bounded async — every operation in fahy must terminate.
//
// Rule from the redesign: no code path may wait forever. Anything that talks to
// the network, spawns a child process, or waits on a user goes through here so
// it always ends as exactly one of: success, failure, timeout, cancel.
//
// Two layers, because they solve different problems:
//   1. withDeadline() hands providers an AbortSignal, so in-flight sockets are
//      torn down instead of left dangling in the background.
//   2. The returned promise ALSO races a timer, so a provider that ignores the
//      signal (a parsing loop, a spawnSync, a third-party helper) still cannot
//      wedge the CLI. The loser is detached with a no-op catch so its late
//      rejection never surfaces as an unhandled rejection.

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
    this.code = 'fahy-timeout';
    this.timeoutMs = ms;
  }
}

export class CancelledError extends Error {
  constructor(label = 'operation') {
    super(`${label} cancelled`);
    this.name = 'CancelledError';
    this.code = 'fahy-cancelled';
  }
}

// A signal that fires after `ms`, plus a `stop()` to release the timer early
// (call it in a finally — an un-stopped timer keeps the event loop alive).
export function deadline(ms, label = 'operation') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new TimeoutError(label, ms)), ms);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: ctrl.signal,
    stop: () => clearTimeout(timer),
    abort: (reason) => ctrl.abort(reason || new CancelledError(label)),
  };
}

// Run `fn(signal)` under a hard deadline.
//
// `fn` may be a promise or a function; the signal is handed to providers that
// accept one, and the outer race guarantees a verdict either way.
export async function withDeadline(fn, ms, label = 'operation') {
  const d = deadline(ms, label);
  const settled = new Promise((_, reject) => {
    d.signal.addEventListener('abort', () => reject(d.signal.reason || new TimeoutError(label, ms)), { once: true });
  });
  let work;
  try {
    work = Promise.resolve(typeof fn === 'function' ? fn(d.signal) : fn);
  } catch (e) {
    d.stop();
    throw e;
  }
  // If the timer wins, the provider's own promise may still reject later.
  work.catch(() => {});
  try {
    return await Promise.race([work, settled]);
  } catch (e) {
    // A timeout/abort must be identifiable downstream so the failure classifier
    // treats it as "try the next provider" instead of a hard stop.
    if (e?.name === 'TimeoutError' || e?.code === 'fahy-timeout') {
      throw new TimeoutError(label, ms);
    }
    throw e;
  } finally {
    d.stop();
  }
}

// Bound an existing promise (no signal to hand out).
export async function withTimeout(promise, ms, label = 'operation') {
  return withDeadline(() => promise, ms, label);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Sequential-with-budget: run `tasks` in order, but stop the moment the total
// wall clock passes `ms`. Used for provider fan-out where each step is already
// individually bounded but their sum is not.
export async function withBudget(tasks, ms, label = 'operation') {
  const started = Date.now();
  const out = [];
  for (const t of tasks) {
    const left = ms - (Date.now() - started);
    if (left <= 0) throw new TimeoutError(label, ms);
    out.push(await withDeadline(t, left, label));
  }
  return out;
}
