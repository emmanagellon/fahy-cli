# fahy

Anime, YouTube, and music in your terminal. mpv-only, no API keys.

- **Anime** — AniList search across FMHY-listed providers (hianime, animepahe, miruro, aniwave, anikoto, anisuge, kickassanime), direct HLS with subs and auto-skip.
- **YouTube** — Invidious search with yt-dlp fallback.
- **Music** — yt-dlp search, audio-only player, radio mixes, playlists.

## Install

```powershell
irm https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.sh | bash
```

Scripts install Node.js 18+, mpv, and yt-dlp if missing. Alternatives: `npm install -g fahy-cli`, or clone + `npm link`. Update with `fahy upgrade` (or rerun the installer); fahy checks GitHub daily and prompts when a newer version is out. Remove with `fahy uninstall` (`--purge` also deletes local data).

## Use

```powershell
fahy                      # fullscreen shell: type to search, TAB switches mode
fahy -a -S "Frieren" --episode 3
fahy -y -S "lofi beats"
fahy -m -S "bohemian rhapsody"
fahy --offline            # play completed downloads
fahy --continue           # resume last session
fahy --doctor             # environment health
fahy --help               # all flags
```

Keys: `↑↓` navigate, `ENTER` select, `ESC` back, `?` help, `s` new search. In mpv: `space` pause, `←/→` seek, `q` quit.

Playback auto-falls back across providers, scoring them by observed reliability and speed (`--provider-health`, `--set-priority`, `--no-fallback`).

## Data

Local data lives in `~/.config/fahy-cli/`. No keys or credentials are stored; the optional `YTMUSIC_PROXY` env var is never written to disk. mpv and yt-dlp run tracking-free (`--no-cache-dir`, `--no-cookies`, `--ignore-config`).

## Contribute

1. Copy `src/providers/aniwave.js` → `src/providers/mysite.js` and implement `resolve(media)`.
2. Register it in `src/providers/registry.js`.
3. Verify: `npm run check && npm run audit && npm run smoke -- --offline`.

## License

MIT. Streams come from unaffiliated third-party sources — use per local law and each site's terms.
