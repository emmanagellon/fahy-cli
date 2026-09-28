// Provider adapter interface (kunai-inspired).
// Every provider: { id, name, site, kinds: ['anime'|'youtube'|'music'],
//   direct: bool, search?(query, opts) -> tracks[], resolve(media, opts) -> { embedUrl, sources[] } }
// sources[] = [{ url, quality, type: 'hls'|'mp4'|'embed'|'youtube'|'music',
//   provider, direct?, headers?, audioOnly?, subFile?, skip?, subMissing? }]
// Keep adapters small + swappable — FMHY sites die/change domains weekly,
// so adding a new one = drop a new file + register it in ./registry.js.

export function embedSource(url, provider) {
  return { url, quality: 'auto (embed)', type: 'embed', provider, direct: false, audioOnly: false };
}

export async function fetchJson(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || timeoutMs);
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) fahy-cli',
        Accept: 'application/json, text/plain, */*',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`HTTP ${res.status} for ${url}${snippet ? ` — ${snippet}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
