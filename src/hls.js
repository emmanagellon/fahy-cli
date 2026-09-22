// Shared HLS master-playlist ladder parser (kunai hls-ladder parity, lite).
// Expands #EXT-X-STREAM-INF rows into ranked {url, quality, rank} variants.
// Rank is normalized to vertical pixels: resolution height when present,
// else bandwidth mapped to an equivalent height (~5 Mbps ≈ 1080).
export function rankQuality(label) {
  const m = /^(\d{3,4})p$/i.exec(String(label || '').trim());
  return m ? parseInt(m[1], 10) : 0;
}

function rankFor({ res, bw }) {
  if (res) return parseInt(res, 10);
  if (bw > 0) return Math.min(2160, Math.max(144, Math.round(bw / 5000)));
  return 0;
}

export function parseLadder(text, masterUrl) {
  const variants = [];
  const lines = String(text || '').split(/\r?\n/);
  let res = '';
  let bw = 0;
  let name = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const r = /RESOLUTION=\d+x(\d+)/i.exec(line)?.[1];
      res = r ? `${r}p` : '';
      const b = /BANDWIDTH=(\d+)/i.exec(line)?.[1];
      bw = b ? parseInt(b, 10) : 0;
      name = /NAME="([^"]+)"/i.exec(line)?.[1]?.trim() || '';
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (!res && !name && !(bw > 0)) continue;
    let abs;
    try {
      abs = new URL(line, masterUrl).toString();
    } catch {
      res = '';
      bw = 0;
      name = '';
      continue;
    }
    const label = name || res || 'auto';
    const rank = rankFor({ res, bw });
    variants.push({ url: abs, quality: label, rank, bandwidth: bw || undefined });
    res = '';
    bw = 0;
    name = '';
  }
  const seen = new Set();
  return variants.filter((v) => (seen.has(v.url) ? false : (seen.add(v.url), true)));
}
