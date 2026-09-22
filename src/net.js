// Transport layer — kunai-style: plain fetch first, local curl on failure.
// hianime.at answers plain fetch from most networks, but the lane sits behind
// Cloudflare, so every provider fetch goes through fetchText(): native fetch,
// then curl (curl-impersonate wrapper if one is on PATH, else plain curl).
import { spawnSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { delimiter as PATH_DELIMITER } from 'node:path';

const FAMILY_RANK = ['chrome', 'firefox', 'ff', 'safari', 'edge'];
const WRAPPER_PATTERN = /^curl_([a-z]+?)(\d+)([a-z]*)(?:_(android|ios))?(?:\.(?:exe|bat|cmd))?$/i;

function parseWrapper(entry) {
  const m = WRAPPER_PATTERN.exec(entry);
  if (!m) return null;
  const [, fam = '', ver = '', rev = '', mobile] = m;
  if (mobile) return null;
  const family = fam.toLowerCase();
  if (!FAMILY_RANK.includes(family)) return null;
  const version = parseInt(ver, 10);
  if (!Number.isFinite(version)) return null;
  return { name: entry, family, version, rev: rev.toLowerCase() };
}

function which(cmd) {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(probe, [cmd], { encoding: 'utf8', shell: false });
    if (r.status !== 0) return null;
    return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

let cachedScan = undefined; // undefined = not scanned yet (null = scanned, none found)
export function discoverCurl() {
  if (cachedScan !== undefined) return cachedScan;
  let best = null;
  try {
    const raw = process.env.PATH || process.env.Path || '';
    for (const dir of raw.split(PATH_DELIMITER)) {
      if (!dir) continue;
      let entries = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith('curl_')) continue;
        const p = parseWrapper(entry);
        if (!p) continue;
        const better =
          !best ||
          FAMILY_RANK.indexOf(p.family) < FAMILY_RANK.indexOf(best.family) ||
          (p.family === best.family && (p.version > best.version || (p.version === best.version && p.rev > best.rev)));
        if (better) best = p;
      }
    }
  } catch {}
  let out = null;
  if (best) {
    const p = which(best.name);
    if (p) out = { path: p, impersonates: true, profile: `${best.family}${best.version}${best.rev}` };
  }
  if (!out) {
    const plain = which('curl');
    if (plain) out = { path: plain, impersonates: false, profile: null };
  }
  cachedScan = out;
  return out;
}

export function isChallengeText(text) {
  return /just a moment/i.test(text || '');
}

function runCurl(args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill();
        } catch {}
        const e = new Error('curl timeout');
        e.code = 'curl-timeout';
        reject(e);
      }
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason || new Error('aborted'));
        return;
      }
      const onAbort = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          try {
            child.kill();
          } catch {}
          reject(signal.reason || new Error('aborted'));
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      child.on('error', cleanup);
      child.on('close', cleanup);
    }
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      }
    });
  });
}

const CODE_MARKER = '\n__FAHY_HTTP_CODE__:';
function splitTrailer(stdout) {
  // Unique marker so bodies ending in newline+3 digits (e.g. JSON "...\n200")
  // are never mistaken for the curl -w trailer.
  const i = String(stdout || '').lastIndexOf(CODE_MARKER);
  if (i < 0) return { body: stdout, httpCode: null };
  const code = Number(String(stdout).slice(i + CODE_MARKER.length).trim());
  if (!Number.isInteger(code)) return { body: stdout, httpCode: null };
  return { body: String(stdout).slice(0, i), httpCode: code === 0 ? null : code };
}

// The one fetch every provider should use for Cloudflare-fronted hosts.
export async function fetchText(url, { headers = {}, timeoutMs = 15000, referer, userAgent, signal, debug } = {}) {
  const h = { ...headers };
  if (userAgent) h['User-Agent'] = userAgent;
  if (referer) h['Referer'] = referer;
  // No keep-alive: pooled sockets racing process exit trip a libuv assertion
  // on Windows (async.c). Our chains are a few sequential requests; the extra
  // handshakes are negligible and exits stay clean.
  if (!Object.keys(h).some((k) => k.toLowerCase() === 'connection')) h['Connection'] = 'close';

  // 1. Native fetch.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { headers: h, signal: ctrl.signal });
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > 8 * 1024 * 1024) throw new Error(`response too large (${len} bytes): ${url}`);
      const text = await res.text();
      if (text.length > 8 * 1024 * 1024) throw new Error(`response too large (${text.length} chars): ${url}`);
      if (res.ok && !isChallengeText(text)) return text;
      if (debug) console.error(`[net] fetch ${res.status} for ${url} — trying curl`);
    } finally {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    if (debug) console.error(`[net] fetch failed for ${url} (${e.message}) — trying curl`);
  }

  // 2. Local curl / curl-impersonate.
  const curl = discoverCurl();
  if (!curl) throw new Error(`blocked by Cloudflare and no curl on PATH (${url})`);
  const args = [curl.path, '-sL', '--max-time', String(Math.max(1, Math.round(timeoutMs / 1000))), '-w', `${CODE_MARKER}%{http_code}`, url];
  if (h['User-Agent']) args.splice(1, 0, '-A', h['User-Agent']);
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'user-agent') continue;
    args.splice(1, 0, '-H', `${k}: ${v}`);
  }
  let r = await runCurl(args, timeoutMs + 2000, signal);
  if (r.exitCode === 28) r = await runCurl(args, timeoutMs + 2000, signal); // retry once on timeout
  if (r.exitCode !== 0) {
    const { httpCode } = splitTrailer(r.stdout);
    throw new Error(`curl ${httpCode ? `HTTP ${httpCode}` : 'no HTTP response'} for ${url} (exit ${r.exitCode})`);
  }
  const { body, httpCode } = splitTrailer(r.stdout);
  if (httpCode !== null && (httpCode < 200 || httpCode > 299)) {
    if (isChallengeText(body)) throw new Error(`blocked by Cloudflare${curl.impersonates ? '' : ' (try curl-impersonate)'}: ${url}`);
    throw new Error(`HTTP ${httpCode} for ${url}`);
  }
  if (isChallengeText(body)) throw new Error(`blocked by Cloudflare${curl.impersonates ? '' : ' (try curl-impersonate)'}: ${url}`);
  return body;
}

export async function fetchJsonVia(url, opts = {}) {
  try {
    return JSON.parse(await fetchText(url, opts));
  } catch (e) {
    throw new Error(`invalid JSON from ${url}: ${e.message}`);
  }
}
