// Automatic update system — once a day on interactive runs we ask GitHub
// (the distribution channel today; npm post-publication) whether a newer
// version exists and surface a one-line notice (or, with autoUpdate
// 'install', apply it in place). Failures are silent: offline or flaky
// networks never block playback and just retry tomorrow. The version of
// `main`'s package.json is the source of truth, so bump version on each
// release push. Source checkouts (npm link) upgrade via git, GitHub installs
// reinstall from GitHub, registry installs via npm.
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fetchJsonVia } from './net.js';

const PKG_NAME = 'fahy-cli';
const REPO = 'emmanagellon/fahy-cli';
const REGISTRY_LATEST = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const GH_MANIFEST = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
const GH_INSTALL = `github:${REPO}`;

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

// Newest published version. Prefers the live GitHub manifest; falls back to
// npm for a post-publication world. Throws if neither answers.
export async function latestVersion({ timeoutMs = 8000, debug } = {}) {
  try {
    const pkg = await fetchJsonVia(GH_MANIFEST, { timeoutMs, userAgent: PKG_NAME, debug });
    const v = pkg?.version;
    if (typeof v !== 'string' || !v) throw new Error('manifest replied without a version');
    return v;
  } catch (e) {
    if (debug) console.error(`[update] github manifest failed (${e.message}); trying npm`);
    const pkg = await fetchJsonVia(REGISTRY_LATEST, { timeoutMs, userAgent: PKG_NAME, debug });
    const v = pkg?.version;
    if (typeof v !== 'string' || !v) throw new Error('registry replied without a version');
    return v;
  }
}

// Which npm spec to reinstall from: GitHub for a github: install (different
// `resolved` shape than a plain registry package), the registry otherwise.
function installSpec(wanted) {
  try {
    const listed = execSync('npm ls -g fahy-cli --json', { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    if (new RegExp(`github\\.com/${REPO.replace('/', '\\/')}`, 'i').test(listed)) return GH_INSTALL;
  } catch {}
  return wanted === 'latest' ? PKG_NAME : `${PKG_NAME}@${wanted}`;
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
  const spec = installSpec(wanted);
  const r = spawnSync('npm', ['install', '-g', spec], { shell: false, stdio });
  if (r.status === 0) {
    const asTxt = spec.startsWith('github:') ? 'the latest GitHub build' : wanted;
    return { ok: true, method: spec.startsWith('github:') ? 'github' : 'npm', message: `Updated to ${asTxt}. Restart fahy to use it.` };
  }
  return { ok: false, method: 'npm', message: `npm install -g ${spec} failed${detail(r)} — retry with fahy upgrade.` };
}