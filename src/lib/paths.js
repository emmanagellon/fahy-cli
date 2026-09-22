// Canonical app paths (single source of truth for every module).
// Renamed fmhy-cli -> fahy-cli: the first run copies the legacy config dir
// (never deletes it) so history/favorites/playlists survive the rename.
// Media dirs start fresh — downloads can be gigabytes, so nothing is moved
// silently; point --download-path at the old folder to keep using it.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';

export const APP_ID = 'fahy-cli';
const LEGACY_ID = 'fmhy-cli';

function migrateDir(newDir, oldDir) {
  try {
    mkdirSync(newDir, { recursive: true });
    if (!existsSync(oldDir)) return;
    for (const e of readdirSync(oldDir)) {
      try {
        const from = join(oldDir, e);
        const to = join(newDir, e);
        if (!existsSync(to) && statSync(from).isFile()) copyFileSync(from, to);
      } catch {}
    }
  } catch {}
}

export function configDir() {
  const dir = join(homedir(), '.config', APP_ID);
  migrateDir(dir, join(homedir(), '.config', LEGACY_ID));
  return dir;
}

export function legacyConfigDir() {
  return join(homedir(), '.config', LEGACY_ID);
}

export function videosDir() {
  return join(homedir(), 'Videos', APP_ID);
}

export function musicDir() {
  return join(homedir(), 'Music', APP_ID);
}
