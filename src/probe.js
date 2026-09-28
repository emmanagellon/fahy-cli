// Preflight reachability probe — ported from kunai's stream-reachability.ts.
// Asks "will mpv actually play this?" BEFORE handing off, so dead mirrors get
// skipped instead of dumping mpv's usage text on screen.
//
// Verdicts mirror kunai's leniency rules:
//   reachable            -> play it
//   timeout (inconclusive) -> play it (slow CDNs pass as unverified)
//   unreachable+definitive -> skip it (DNS death, 4xx refusal, HTML where media belongs)
import { spawn } from 'node:child_process';
import { discoverCurl } from './net.js';

const DEFAULT_TIMEOUT_MS = 5000;

export async function probeUrl(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  // Hard timeout: the entire probe (including all sequential HLS fetches)
  // must complete within timeoutMs + a small grace period.
  const hardTimeoutMs = timeoutMs + 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('probe hard timeout')), hardTimeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw signal.reason || new Error('aborted');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    if (/\.m3u8([?#]|$)/i.test(url)) return await probeHls(url, headers, timeoutMs, ctrl.signal);
    return await probeHttp(url, headers, timeoutMs, ctrl.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function probePassesForPlayback(probe) {
  if (!probe) return false;
  if (probe.status === 'reachable' || probe.status === 'timeout') return true;
  // kunai leniency: an inconclusive (non-definitive) unreachable verdict
  // must never veto a stream mpv might still play.
  return probe.status === 'unreachable' && probe.definitive === false;
}

async function fetchTimeout(url, init, ms, parentSignal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('probe timeout')), ms);
  const onAbort = () => ctrl.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    const fetchPromise = fetch(url, { ...init, signal: ctrl.signal });
    // Prevent unhandled rejection if fetch settles after hard timeout
    fetchPromise.catch(() => {});
    // Hard timeout: reject even if fetch doesn't respond to abort (tarpit server)
    let hardT;
    const timeoutPromise = new Promise((_, reject) => {
      hardT = setTimeout(() => reject(new Error('probe hard timeout')), ms + 2000);
    });
    let res;
    try {
      res = await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      clearTimeout(hardT);
    }
    // Read the body INSIDE the timeout window — a server that trickles data
    // or hangs mid-body would otherwise hang res.text() forever.
    const text = await res.text();
    clearTimeout(t);
    parentSignal?.removeEventListener('abort', onAbort);
    // Return a plain object with the fields callers use.
    return {
      status: res.status,
      headers: res.headers,
      ok: res.ok,
      text: () => Promise.resolve(text),
    };
  } catch (e) {
    clearTimeout(t);
    parentSignal?.removeEventListener('abort', onAbort);
    throw e;
  }
}

// Curl fallback: when native fetch hangs (tarpit, TLS fingerprint block), curl
// often succeeds. Returns a verdict or null if curl also failed.
async function probeWithCurl(url, headers, timeoutMs, signal) {
  const curl = discoverCurl();
  if (!curl) return null;
  return new Promise((resolve) => {
    const args = [curl.path, '-sL', '--max-time', String(Math.max(1, Math.round(timeoutMs / 1000))), '-o', '/dev/null', '-w', '%{http_code}', url];
    if (headers['User-Agent']) args.splice(1, 0, '-A', headers['User-Agent']);
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'user-agent') continue;
      args.splice(1, 0, '-H', `${k}: ${v}`);
    }
    const child = spawn(args[0], args.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill(); } catch {}
        resolve({ status: 'timeout', reason: 'curl timeout', definitive: false });
      }
    }, timeoutMs + 2000);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve(null);
        return;
      }
      const onAbort = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          try { child.kill(); } catch {}
          resolve(null);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    child.on('error', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
    child.on('close', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ status: 'reachable', reason: 'curl OK', definitive: true });
        } else if (code === 28) {
          resolve({ status: 'timeout', reason: 'curl timeout', definitive: false });
        } else {
          resolve({ status: 'unreachable', reason: `curl exit ${code}`, definitive: true });
        }
      }
    });
  });
}

async function probeHttp(url, headers, timeoutMs, signal) {
  // HEAD first (cheap); many embeds reject HEAD, so fall back to ranged GET.
  try {
    const head = await fetchTimeout(url, { method: 'HEAD', headers }, timeoutMs, signal);
    if (head.status >= 200 && head.status < 300) return { status: 'reachable', reason: `HTTP ${head.status}`, definitive: true };
    if (head.status === 429) return { status: 'timeout', reason: 'HTTP 429 rate-limited (inconclusive)', definitive: false };
    if (head.status === 403 || head.status === 405) throw new Error(`HEAD ${head.status}`);
    if (head.status >= 400 && head.status < 500) {
      return { status: 'unreachable', reason: `HTTP ${head.status}`, definitive: true };
    }
  } catch (e) {
    const v = classifyNetError(e);
    if (v) return v;
    // else: fall through to ranged GET
  }
  try {
    const res = await fetchTimeout(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' } }, timeoutMs, signal);
    if ((res.status >= 200 && res.status < 300) || res.status === 206) {
      return { status: 'reachable', reason: `HTTP ${res.status}`, definitive: true };
    }
    return { status: 'unreachable', reason: `HTTP ${res.status}`, definitive: res.status >= 400 && res.status < 500 };
  } catch (e) {
    const v = classifyNetError(e);
    if (v) return v;
    // Curl fallback: native fetch hung or was blocked — try curl
    const curlResult = await probeWithCurl(url, headers, timeoutMs, signal);
    if (curlResult) return curlResult;
    return { status: 'timeout', reason: 'probe timed out', definitive: false };
  }
}

const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

async function readCappedText(res, cap = MAX_PLAYLIST_BYTES) {
  // Malicious oversized playlists must not OOM the process.
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > cap) throw new Error(`playlist too large (${len} bytes)`);
  const text = await res.text();
  if (text.length > cap) throw new Error(`playlist too large (${text.length} chars)`);
  return text;
}
async function probeHls(url, headers, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(500, deadline - Date.now());
  try {
    const res = await fetchTimeout(url, { method: 'GET', headers }, left(), signal);
    if (res.status < 200 || res.status >= 300) {
      return { status: 'unreachable', reason: `playlist HTTP ${res.status}`, definitive: res.status >= 400 && res.status < 500 };
    }
    let text = await readCappedText(res);
    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const variant = firstUriLine(text, url);
      if (!variant) return { status: 'unreachable', reason: 'master playlist has no variant', definitive: true };
      const vres = await fetchTimeout(variant, { method: 'GET', headers }, left(), signal);
      if (vres.status < 200 || vres.status >= 300) {
        return { status: 'unreachable', reason: `variant HTTP ${vres.status}`, definitive: vres.status >= 400 && vres.status < 500 };
      }
      text = await readCappedText(vres);
      url = variant;
    }
    const seg = firstUriLine(text, url);
    if (!seg) return { status: 'unreachable', reason: 'media playlist has no segments', definitive: true };
    const sres = await fetchTimeout(seg, { method: 'GET', headers: { ...headers, Range: 'bytes=0-16383' } }, left(), signal);
    if (!((sres.status >= 200 && sres.status < 300) || sres.status === 206)) {
      return { status: 'unreachable', reason: `segment HTTP ${sres.status}`, definitive: sres.status >= 400 && sres.status < 500 };
    }
    const ct = (sres.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) return { status: 'unreachable', reason: 'segment is an HTML page', definitive: true };
    return { status: 'reachable', reason: 'segment OK', definitive: true };
  } catch (e) {
    return classifyNetError(e) || { status: 'timeout', reason: 'probe timed out', definitive: false };
  }
}

function firstUriLine(text, base) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    try {
      return new URL(t, base).toString();
    } catch {
      continue; // skip one malformed URI, don't abort the whole playlist
    }
  }
  return null;
}

// Definitive network deaths (kunai's rule): DNS/refused/certs. Everything else
// is inconclusive — a failing probe must never veto a stream that might play.
function classifyNetError(e) {
  const msg = e?.message ? String(e.message) : String(e);
  if (/probe timeout|aborted|abortion|timeout|timed out/i.test(msg) && !/connect/i.test(msg)) {
    return null; // caller maps to timeout
  }
  const lower = msg.toLowerCase();
  const definitive =
    lower.includes('econnrefused') || lower.includes('connection refused') ||
    lower.includes('enotfound') || lower.includes('getaddrinfo') ||
    lower.includes('failed to resolve') || lower.includes('name or service not known') ||
    lower.includes('certificate') || lower.includes('unsupported protocol') ||
    lower.includes('bad/illegal format') || lower.includes('unknown scheme');
  if (definitive) return { status: 'unreachable', reason: msg.slice(0, 120), definitive: true };
  return null;
}
