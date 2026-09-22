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

Anime providers backed by the AWC/“clan” family engines (aniwave, anikoto, anisuge) are one `createClanAdapter` call — add a mirror and pick the sources dialect (`'ajax'` for `aniwaves.ru`, `'server'` for the anikoto/anisuge clone family) in `src/providers/clan.js`:

1. Register the adapter in `src/providers/registry.js`.
2. Verify: `npm run check && npm run audit && npm run smoke -- --offline`.

Standalone providers implement `resolve(media)` and return `{ embedUrl, sources }` per `src/providers/base.js`. The episode/server list parsers are attribute-driven and deliberately tolerate the family's markup drift between mirrors.

KickAssAnime's title index (kaa.lt `/api/anime`) is cached to `~/.config/fahy-cli/kaa-index.json` for 12 hours and refreshed lazily — an empty or stale search resolves again on the next run.

Provider status today: **playable via CLI** — hianime, anikoto, anisuge, kickassanime (direct HLS with subs; federation auto-skips them before trying gated ones). **Browser-gated** — animepahe (Cloudflare on `/api`), miruro (Cloudflare challenge on every mirror and its base64url/gzip pipe API), aniwave (obfuscated echovideo player embed). These three fail fast with a clear message; a real browser or a curl-impersonate install is required to reach them.

## License

MIT. Streams come from unaffiliated third-party sources — use per local law and each site's terms.
