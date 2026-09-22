// Failure classifier — ported from kunai's provider-failure-classifier.ts.
// Every resolve/probe error becomes { class, policy, summary }:
//   policy auto-fallback -> try the next provider automatically
//   policy guided-action  -> stop and tell the user what to do
//   policy no-fallback    -> stop (user cancelled, or unknown + strict mode)
const OFFLINE_PATTERNS = [
  'enotfound', 'eai_again', 'enetunreach', 'getaddrinfo', 'failed to resolve',
  'network is unreachable', 'err_internet_disconnected', 'err_name_not_resolved',
];

const AUTO_FALLBACK = new Set([
  'timeout', 'network', 'rate-limited', 'provider-empty', 'provider-parse', 'expired-stream',
  'sub-dub-mismatch',
]);
const GUIDED = new Set(['blocked', 'offline']);

export function classifyFailure(err, providerId) {
  const message = err?.message ? String(err.message) : String(err ?? 'unknown');
  const lower = message.toLowerCase();
  const statusMatch = /http (\d{3})/i.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  let cls = 'unknown';
  if (err?.name === 'AbortError' || /aborterror/i.test(message)) {
    cls = 'timeout'; // our own fetch wrapper only aborts on timeout
  } else if (/(^|\W)cancelled(\W|$)/i.test(message) || /cancelled by the user/i.test(message)) {
    cls = 'user-cancelled';
  } else if (OFFLINE_PATTERNS.some((p) => lower.includes(p))) {
    cls = 'offline';
  } else if (/timeout|timed out|und_err_connect_timeout/i.test(message)) {
    cls = 'timeout';
  } else if (/rate limit|429/.test(lower)) {
    cls = 'rate-limited';
  } else if (/401|unauthorized|invalid.*(api[_-]?key|key)|bad.*key/i.test(lower)) {
    cls = 'auth';
  } else if (/403|blocked|cloudflare|just a moment|captcha|access denied|challenge/i.test(lower)) {
    cls = 'blocked';
  } else if (/no .*playable|no streams|not found|no entry|no episodes|no episode|no results/i.test(lower)) {
    cls = 'provider-empty';
  } else if (/parse|unexpected token|invalid json|not valid json/i.test(lower)) {
    cls = 'provider-parse';
  } else if (/expired|410 gone|stream expired/i.test(lower)) {
    cls = 'expired-stream';
  } else if (/subtitle.*dub|dub.*subtitle/i.test(lower)) {
    cls = 'sub-dub-mismatch';
  } else if (/fetch failed|network|econnreset|econnrefused|socket hang up|econnaborted/i.test(lower)) {
    cls = 'network';
  } else if (status) {
    if (status === 408 || status === 504) cls = 'timeout';
    else if (status === 429) cls = 'rate-limited';
    else if (status === 401 || status === 403) cls = 'blocked';
    else if (status === 404) cls = 'provider-empty';
    else if (status >= 500) cls = 'network';
  }

  const policy = AUTO_FALLBACK.has(cls) ? 'auto-fallback' : GUIDED.has(cls) ? 'guided-action' : 'no-fallback';
  return { class: cls, policy, summary: userSummary(providerId, cls), detail: message.slice(0, 300) };
}

export function userSummary(providerId, cls) {
  const name = providerId ? prettyName(providerId) : 'Provider';
  switch (cls) {
    case 'timeout': return `${name} timed out.`;
    case 'network': return `${name} had a network issue.`;
    case 'offline': return 'No network — you appear to be offline.';
    case 'rate-limited': return `${name} is rate-limiting requests.`;
    case 'auth': return 'API key rejected (HTTP 401) — check the key for that service.';
    case 'provider-empty': return `${name} returned no playable stream.`;
    case 'provider-parse': return `${name} returned data we could not read.`;
    case 'expired-stream': return `${name} returned an expired stream.`;
    case 'blocked': return `${name} is blocking automated requests right now.`;
    case 'sub-dub-mismatch': return `${name} has no matching sub/dub.`;
    case 'offline-title': return `${name} does not have this episode yet.`;
    case 'user-cancelled': return 'Cancelled.';
    default: return `${name} hit an unexpected issue.`;
  }
}

function prettyName(id) {
  return String(id).split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
