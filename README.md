# fahy

Anime, YouTube, and music in your terminal. mpv-only, no API keys.

- **Anime** — AniList search across FMHY-listed providers (hianime, anikoto, anisuge), direct HLS with subs and auto-skip.
- **YouTube** — Invidious search with yt-dlp fallback.
- **Music** — yt-dlp search, audio-only player, radio mixes, playlists.

## Install

```powershell
irm https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.sh | bash
```

Scripts install Node.js 18+, mpv, and yt-dlp if missing, then `fahy --doctor` to verify. Alternatives: `npm install -g fahy-cli`, or clone + `npm link`. Remove with `fahy uninstall` (`--purge` also deletes local data).

## Update

```
fahy upgrade                # update to the latest
fahy --doctor               # shows installed vs latest
fahy --auto-update          # show the update policy
fahy --auto-update install  # apply updates automatically
fahy --auto-update off      # never check automatically
```

fahy checks GitHub once a day and prompts when a newer version is out (`notice`, the default) — or applies it in place with `--auto-update install`.

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

Anime providers backed by the AWC/“clan” family engine (anikoto, anisuge) are one `createClanAdapter` call — add a mirror in `src/providers/clan.js`:

1. Register the adapter in `src/providers/registry.js`.
2. Verify: `npm run check && npm run audit && npm run smoke -- --offline`.

Standalone providers implement `resolve(media)` and return `{ embedUrl, sources }` per `src/providers/base.js`. The episode/server list parsers are attribute-driven and deliberately tolerate the family's markup drift between mirrors.

Anime sources still listed on FMHY that are not supported here — animepahe, aniwave, miruro — are Cloudflare-gated or use JS-wall players a headless player can't reach, so they are intentionally omitted rather than shipped as dead links.

## License

MIT. Streams come from unaffiliated third-party sources — use per local law and each site's terms.
