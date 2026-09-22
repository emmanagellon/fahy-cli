# fahy

Anime, YouTube, and music in your terminal. 

## Features

- **Anime** — AniList search across FMHY sources (hianime, anikoto, anisuge). Direct HLS with soft subtitles and intro/outro auto-skip.
- **YouTube** — Invidious search with yt-dlp fallback.
- **Music** — Search, audio-only playback, radio mixes, and playlists via yt-dlp.

## Install

```powershell
irm https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.sh | bash
```

Installs Node.js 18+, mpv, and yt-dlp when missing, then runs `fahy --doctor` to verify. Alternatives: `npm install -g fahy-cli`, or clone and `npm link`. Uninstall with `fahy uninstall` (`--purge` also deletes local data).

## Usage

```text
fahy                          # shell: type to search, TAB switches mode
fahy -a -S "Frieren" --episode 3    # anime
fahy -y -S "lofi beats"             # youtube
fahy -m -S "bohemian rhapsody"      # music
fahy --offline                 # play completed downloads
fahy --continue                # resume last session
fahy --doctor                  # environment health
fahy --help                    # all flags
```

| Shell        | mpv               |
| ------------ | ----------------- |
| `↑↓` navigate | `space` pause    |
| `enter` select | `←/→` seek       |
| `esc` back   | `q` quit          |
| `?` help     |                   |
| `s` search   |                   |

Playback auto-falls back across providers, ranked by observed reliability and speed. Override with `--set-default-provider`, `--set-priority`, `--provider-health`, or disable fallback with `--no-fallback`.

## Data

Local data lives in `~/.config/fahy-cli/`. No keys or credentials are stored; the optional `YTMUSIC_PROXY` env var is never persisted. mpv and yt-dlp run tracking-free (`--no-config`, `--no-cookies`, `--ignore-config`, `--no-cache-dir`).

## Contributing

```text
npm run check
npm run audit
npm run smoke -- --offline
```

Anime providers backed by the clan engine (anikoto, anisuge) are one `createClanAdapter` call in `src/providers/clan.js`; standalone providers return `{ embedUrl, sources }` per `src/providers/base.js`. Register either in `src/providers/registry.js`.


## License

MIT. Streams come from unaffiliated third-party sources — use per local law and each site's terms.
