import { spawn } from 'node:child_process';

// Shared child-process settle helper: spawn + resolve { code, ms }.
// Eliminates the duplicated spawn/error/close boilerplate.
export function spawnSettled(cmd, args, { stdio = 'inherit' } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (!settled) {
        settled = true;
        resolve({ code, ms: Date.now() - started });
      }
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio, shell: false });
    } catch {
      done(-1);
      return;
    }
    child.on('error', () => done(-1));
    child.on('close', (code) => done(code));
  });
}
