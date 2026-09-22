import { hianime } from './hianime.js';
import { anikoto } from './anikoto.js';
import { anisuge } from './anisuge.js';
import { kickassanime } from './kickassanime.js';
import { youtube } from './youtube.js';
import { ytmusic } from './ytmusic.js';
import { scoreOf, bestScoredId } from '../store.js';

// Anime adapters are FMHY https://fmhy.net/video sources (hianime, anikoto,
// anisuge, kickassanime). YouTube is FMHY-listed under Video Streaming;
// music rides YouTube via yt-dlp (audio-only mpv).
export const providers = [hianime, anikoto, anisuge, kickassanime, youtube, ytmusic];

export const forKind = (kind) => providers.filter((p) => p.kinds.includes(kind));
export const getProvider = (id) => providers.find((p) => p.id === id);

// Fallback order (kunai providerPriority parity, pure/testable):
// chosen first, then user's priority list, then the rest AUTO-RANKED by
// observed health (reliability, then speed) — the cycle converges on the
// best stable source by itself. Blocked providers sort last but are never
// dropped. Direct streams win ties (subs/skip data beat embeds).
export function orderProviders(chosen, avail, { priority = [], healthBlocked = () => false, strict = false, health = {} } = {}) {
  if (strict) return [chosen];
  const rest = avail.filter((x) => x.id !== chosen.id);
  const pri = [];
  for (const id of priority) {
    const p = rest.find((x) => x.id === id);
    if (p && !pri.includes(p)) pri.push(p);
  }
  const remaining = rest.filter((x) => !pri.includes(x));
  const rankKey = (x) => {
    const s = scoreOf(health[x.id]);
    return {
      blocked: healthBlocked(x.id) ? 1 : 0,
      rel: -s.rel,
      ms: s.ms ?? Number.POSITIVE_INFINITY,
      direct: x.direct ? 0 : 1,
      id: x.id,
    };
  };
  remaining.sort((a, b) => {
    const ra = rankKey(a);
    const rb = rankKey(b);
    return (
      ra.blocked - rb.blocked ||
      ra.rel - rb.rel ||
      ra.ms - rb.ms ||
      ra.direct - rb.direct ||
      (ra.id < rb.id ? -1 : ra.id > rb.id ? 1 : 0)
    );
  });
  return [chosen, ...pri, ...remaining];
}

// Picker tags (what the UI shows next to each provider): the observed-best
// lane member gets 'best', blocked ones get 'unhealthy', the rest null.
// Pure — both the shell picker and flag-mode menus share it.
export function providerTags(list, { health = {}, isBlocked = () => false } = {}) {
  const ids = (list || []).map((x) => x.id);
  const best = bestScoredId(ids, health, isBlocked);
  const tags = {};
  for (const x of list || []) {
    if (isBlocked(x.id)) tags[x.id] = 'unhealthy';
    else if (x.id === best) tags[x.id] = 'best';
    else tags[x.id] = null;
  }
  return tags;
}
