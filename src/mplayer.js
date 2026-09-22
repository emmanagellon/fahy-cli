// Music daemon: one persistent mpv owned by the session, driven over IPC.
// Ported from ytmusic-player's player.ts (mpv --no-video --idle + JSON IPC
// over a Windows named pipe), adapted to our session model. This is what makes
// music visible: live position/duration/pause state for the TUI, instant
// next/prev via loadfile (no process respawn), and true end-of-track
// detection for autoplay — instead of blind spawns you can't tell are stuck.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { mpvPrivacyArgs } from './lib/privacy.js';

const REQ_TIMEOUT_MS = 5000;

export function ipcPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\fahy-mpv-${process.pid}`;
  return join(tmpdir(), `fahy-mpv-${process.pid}.sock`);
}

export class MusicPlayer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.socket = null;
    this.buf = '';
    this.reqId = 0;
    this.pending = new Map();
    this.state = { paused: false, timePos: 0, duration: 0, volume: 100 };
    this.path = ipcPath();
  }

  async start(extraArgs = []) {
    if (process.platform !== 'win32') {
      try {
        if (existsSync(this.path)) unlinkSync(this.path);
      } catch {}
    }
    this.proc = spawn('mpv', ['--no-video', '--no-terminal', `--input-ipc-server=${this.path}`, '--idle=yes', ...mpvPrivacyArgs(), ...extraArgs],
      { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    this.proc.on('error', () => {});
    await this.connect(15000);
    await this.observe();
  }

  connect(timeout = 15000) {
    const self = this;
    const deadline = Date.now() + timeout;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (self.proc?.exitCode !== undefined && self.proc?.exitCode !== null) {
          reject(new Error('mpv exited during startup.'));
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('mpv IPC did not become ready.'));
          return;
        }
        const socket = createConnection(self.path);
        socket.once('error', () => {
          socket.destroy();
          setTimeout(attempt, 80);
        });
        socket.once('connect', () => {
          socket.on('error', () => {});
          socket.on('close', () => {
            if (self.socket === socket) self.socket = null;
          });
          socket.on('data', (d) => self.onData(d.toString()));
          self.socket = socket;
          resolve();
        });
      };
      attempt();
    });
  }

  async observe() {
    await this.send('observe_property', 1, 'pause');
    await this.send('observe_property', 2, 'time-pos');
    await this.send('observe_property', 3, 'duration');
    await this.send('observe_property', 4, 'volume');
  }

  onData(data) {
    this.buf += data;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.request_id !== undefined) {
        const p = this.pending.get(msg.request_id);
        if (p) {
          clearTimeout(p.timeout);
          this.pending.delete(msg.request_id);
          if (msg.error && msg.error !== 'success') p.reject(new Error(`mpv: ${msg.error}`));
          else p.resolve(msg);
        }
      }
      if (msg.event === 'property-change') {
        const v = msg.data;
        if (v == null) continue;
        if (msg.name === 'pause') this.state.paused = !!v;
        else if (msg.name === 'time-pos') this.state.timePos = v;
        else if (msg.name === 'duration') this.state.duration = v;
        else if (msg.name === 'volume') this.state.volume = Math.round(v);
        this.emit('state');
      } else if (msg.event === 'end-file') {
        this.emit('end-file', msg.reason || 'unknown');
      } else if (msg.event === 'start-file') {
        this.emit('start-file');
      }
    }
  }

  send(...args) {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('mpv IPC unavailable.'));
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('mpv command timed out.'));
      }, REQ_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        socket.write(JSON.stringify({ command: args, request_id: id }) + '\n');
      } catch (e) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async load(url, { volume = null } = {}) {
    if (volume !== null && volume !== undefined) {
      try {
        await this.send('set_property', 'volume', Math.max(0, Math.min(100, Number(volume) || 0)));
      } catch {}
    }
    // A paused previous track must not freeze the next one at 0:00
    // (waitForStart keys on first progress).
    try {
      await this.send('set_property', 'pause', false);
    } catch {}
    await this.send('loadfile', url, 'replace');
  }

  // Resolves on first audible progress, rejects on early failure/timeout.
  // (start-file alone is NOT success — mpv emits it before failing too.)
  waitForStart(timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('track never started (network/extraction stall?)'));
      }, timeoutMs);
      const onState = () => {
        if (!started && (this.state.timePos || 0) > 0) {
          started = true;
          cleanup();
          resolve();
        }
      };
      const onEnd = (reason) => {
        // 'redirect' precedes a fresh start on the same load — not a failure.
        if (reason === 'redirect') return;
        if (!started) {
          cleanup();
          reject(new Error(`track failed before starting (mpv end-file: ${reason})`));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('state', onState);
        this.off('end-file', onEnd);
      };
      this.on('state', onState);
      this.on('end-file', onEnd);
    });
  }

  async togglePause() {
    await this.send('cycle', 'pause');
  }

  async pause() {
    await this.send('set_property', 'pause', true);
  }

  async seek(secs) {
    await this.send('seek', secs, 'relative');
  }

  async setVolume(v) {
    const level = Math.max(0, Math.min(100, Number(v) || 0));
    await this.send('set_property', 'volume', level);
    this.state.volume = level;
  }

  async quit() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(new Error('player quit'));
    }
    this.pending.clear();
    try {
      if (this.socket) this.socket.destroy();
    } catch {}
    this.socket = null;
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
    if (process.platform !== 'win32') {
      try {
        unlinkSync(this.path);
      } catch {}
    }
  }
}
