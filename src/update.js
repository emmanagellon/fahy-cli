// Automatic update system — once a day on interactive runs we ask the npm
// registry whether a newer version exists and surface a one-line notice
// (or, with autoUpdate 'install', apply it in place). Failures are silent:
// offline or flaky registries never block playback and just retry tomorrow.
// Source checkouts (npm link) upgrade via git; registry installs via npm.
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fetchJsonVia } from './net.js';

const REGISTRY_LATEST = 'https://registry.npmjs.org/fahy-cli/latest';
const PKG_NAME = 'fahy-cli';

export function installedVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Numeric dot-segment compare (missing tails count as 0): 0.10.0 > 0.9.9.
export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').trim().split('.').map((x) => parseInt(x, 10));
  const pb = String(b || '').replace(/^v/i, '').trim().split('.').map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function needsUpdate(current, latest) {
  return compareVersions(current, latest) < 0;
}

// Latest published version from npm. Throws on any registry failure.
export async function latestVersion({ timeoutMs = 8000, debug } = {}) {
  const pkg = await fetchJsonVia(`${REGISTRY_LATEST}`, { timeoutMs, userAgent: PKG_NAME, debug });
  const v = pkg?.version;
  if (typeof v !== 'string' || !v) throw new Error('registry replied without a version');
  return v;
}

// npm marks symlinked (npm link) installs as `-> target`. Returns the real
// checkout path, or null for a plain registry install.
export function sourceCheckout() {
  let listed = '';
  try {
    listed = execSync('npm ls -g fahy-cli', { encoding: 'utf8', shell: false });
  } catch {
    return null;
  }
  const link = /fahy-cli@[^\s]*\s+->\s+(\S+)/.exec(listed)?.[1];
  if (!link) return null;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', shell: false }).trim();
    return readlinkSync(join(root, 'fahy-cli'));
  } catch {
    return null;
  }
}

// Apply an update. Manual `fahy upgrade` keeps progress visible (verbose:
// child stdio inherited); the automatic path stays quiet so npm never paints
// over the running shell. Returns { ok, method, message }.
export function upgrade({ wanted = 'latest', debug, verbose = false } = {}) {
  const spec = wanted === 'latest' ? PKG_NAME : `${PKG_NAME}@${wanted}`;
  const stdio = verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'];
  const detail = (r) =>
    verbose ? '' : ` (${Buffer.from(r.stderr || []).toString().trim().split('\n')[0] || `exit ${r.status}`})`;
  const target = sourceCheckout();
  if (target) {
    if (debug) console.error(`[update] source checkout: ${target}`);
    const r = spawnSync('git', ['pull', '--ff-only'], { cwd: target, shell: false, stdio });
    if (r.status === 0) {
      return { ok: true, method: 'git', message: 'Updated. Restart fahy to use it (npm link needs no reinstall).' };
    }
    return { ok: false, method: 'git', message: `Could not git pull in ${target}${detail(r)} — update it manually.` };
  }
  const r = spawnSync('npm', ['install', '-g', spec], { shell: false, stdio });
  if (r.status === 0) {
    return { ok: true, method: 'npm', message: `Updated to ${wanted}. Restart fahy to use it.` };
  }
  return { ok: false, method: 'npm', message: `npm install -g ${spec} failed${detail(r)} — retry with fahy upgrade.` };
}