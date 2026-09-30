// `fahy history` — a selectable list, not a dump.
//
// Every row is a real entry from the store, and Enter resumes *that* entry:
// the same provider, the same season/episode, and (for anything with a known
// length) the same offset into the video. The whole point is that "continue"
// means continue, not "search for it again and hope".
import { getHistory, historyToMedia } from './store.js';
import { select, canSelect, short } from './tui/select.js';
import { formatDuration } from './metadata.js';

// Sentinel for the destructive row, kept out of the value space of real rows
// (which are indices into the history array).
export const CLEAR_ALL = '__clear__';

// How far in, out of how long. "18m / 24m" reads faster than "75%".
// Units: positionMs is ms, duration is seconds (what the metadata layer gives).
export function historyProgress(e) {
  if (e.completed) return 'done';
  const durSec = Number(e.duration) || 0;
  const posMs = Number(e.positionMs) || 0;
  if (durSec > 0 && posMs > 0) {
    const mins = (ms) => `${Math.floor(ms / 60_000)}m`;
    const durMs = durSec * 1000;
    if (durMs >= 60_000) return `${mins(Math.min(posMs, durMs))} / ${mins(durMs)}`;
  }
  if (posMs > 0) return `${formatDuration(posMs / 1000)} in`;
  return '';
}

// S1E12 for episodic lanes, nothing for movies/YouTube/music — the second
// number in a list should mean something, not repeat the title.
export function historyTag(e) {
  if (e.kind === 'anime' && e.episode) return `E${e.episode}`;
  if (e.kind === 'tv' && e.episode) return `S${e.season || 1}E${e.episode}`;
  return '';
}

export function historyLabel(e) {
  const tag = historyTag(e);
  return tag ? `${e.title} · ${tag}` : e.title || '(untitled)';
}

export function historyHint(e) {
  const bits = [historyProgress(e), e.provider].filter(Boolean);
  return bits.join(' · ');
}

// Relative time beats an ISO string in a list you scan with your eyes.
export function historyWhen(at) {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

// Selector rows. One synthetic row at the bottom clears everything; the
// separator keeps it visually distinct from real entries.
export function historyItems(history) {
  const items = history.map((e, i) => ({ label: historyLabel(e), hint: historyHint(e), value: i }));
  items.push('-');
  items.push({ label: 'Clear all history', hint: 'deletes every entry', value: CLEAR_ALL });
  return items;
}

// Turn a picked row back into a resumable target. Returns null for rows that
// cannot be resumed (a retired lane, or an entry with no identity).
export function resumeTarget(entry) {
  if (!entry) return null;
  const r = historyToMedia(entry);
  if (!r) return null;
  // A finished item restarts rather than seeking into the last few seconds.
  const positionMs = r.completed ? 0 : r.positionMs;
  return { ...r, positionMs: positionMs || null };
}

// Newest first, capped for the list (the full store keeps 200).
export function listHistory(limit = 50) {
  return getHistory().slice(0, limit);
}

// Pick a history row. Resolves { entry, index } or null when the user backs
// out. Non-interactive callers get null — a script must not silently resume
// somebody else's most recent watch.
export async function pickHistory(history = listHistory(), { title = 'History' } = {}) {
  if (!history.length || !canSelect()) return null;
  const picked = await select({ title, items: historyItems(history), maxVisible: 15 });
  if (picked === null || picked === CLEAR_ALL) return null;
  return { entry: history[picked], index: picked };
}

// Row for a specific entry, used by `fahy history --plain` style output.
export function historyLine(e, i) {
  return `${String(i + 1).padStart(2)}. ${historyLabel(e)}${historyHint(e) ? `  (${historyHint(e)})` : ''}  ${short(historyWhen(e.at), 12)}`;
}
