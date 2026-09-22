# fahy
free anime heck yea!
Anime, YouTube, and music in your terminal.

- **Anime** — AniList search + FMHY-listed sources (`hianime`, `animepahe`, `miruro`, `aniwave`, `anikoto`, `anisuge`, `kickassanime`), direct HLS with subs and auto-skip where available.
- **YouTube** — Invidious-pool search with yt-dlp fallback, played in mpv.
- **Music** — yt-dlp search, audio-only mpv daemon, radio mixes, playlists.

No API keys needed for anything.

## Install

```powershell
irm https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.sh | bash
```

Both scripts install everything automatically — Node.js 18+, mpv, yt-dlp —
then install fahy globally and verify with `fahy --doctor`. Options: `-Version` /
`--version`, `-Method npm|source`, `-SkipDeps`, `-DryRun`.

Alternatives: `npm install -g fahy-cli`, or clone + `npm install` + `npm link`. Keep it current with `fahy upgrade`; remove with `fahy uninstall` (`--purge` also deletes local data).

Requires: Node 18+, mpv, yt-dlp.

## Use

`fahy` opens the fullscreen shell: type to search, `TAB` switches Anime / YouTube / Music, `↑↓` + `ENTER` picks, `ESC` goes back, `?` shows keys. In lists `←` goes back and `→` selects; `s` starts a new search from any browse screen. Errors render inline; the session continues. Provider pickers mark the observed-best source (`best`) and failing ones (`unhealthy`).

```powershell
fahy -a -S "Frieren" --episode 3
fahy -y -S "lofi beats"
fahy -m -S "bohemian rhapsody"
fahy --url <youtube-url-or-id> --radio
fahy -a -S "Frieren" --print-url --debug
fahy -m -S "song" --download
fahy --offline            # play completed downloads locally
fahy --history            # tick entries to delete
fahy --continue           # resume latest entry
fahy --playlists
fahy --shuffle on --repeat all --volume 80
fahy --doctor             # environment health
fahy --diagnostics        # last run: providers tried, failures
fahy --check-sources      # diff providers vs live FMHY list (see Sources)
```

`fahy --help` lists everything. In mpv: `space` pause, `←/→` seek, `9/0` volume, `q` quit.

Playback auto-fallbacks across providers (`--set-priority`, `--provider-health`, `--reset-health`; `--no-fallback` pins one). The cycle scores providers by observed reliability + speed (3-strike memory, 24h decay) and converges on the best stable source by itself; a win on another provider while your default is unhealthy migrates the default (logged). YouTube age-restricted videos retry via the Android client automatically.

## Sources

FMHY domains rotate, so providers are checked against the live list at <https://fmhy.net/video>:

```powershell
fahy --check-sources    # health + drift per provider (green/yellow/red)
fahy --update-sources   # + pin the fastest healthy anime provider as default
```

A brand-new FMHY domain is flagged, never auto-patched (new domains usually mean changed page structure, which needs a code change). AnimePahe may probe "unreachable" behind Cloudflare while still resolving fine. The list is re-checked automatically once a day on interactive runs (new sites and drift surface as warnings); a manual check resets the timer.

## Data & security

- Local data lives in `~/.config/fahy-cli/` (`config.json`, `history.json`, `downloads.json`, `favorites.json`). Video downloads default to `~/Videos/fahy-cli`, music to `~/Music/fahy-cli` (`--download-path` overrides).
- No keys, tokens, or credentials exist in this repo or its config — AniList, Invidious, and yt-dlp need none. The only secret-adjacent setting is the optional `YTMUSIC_PROXY` env var (e.g. `socks5://127.0.0.1:9050`); it is never written to disk.
- Every mpv/yt-dlp call runs tracking-free (`--no-cache-dir`, `--no-cookies`, `--ignore-config`). Never commit your `~/.config/fahy-cli/` contents.

## Contribute

1. Copy `src/providers/aniwave.js` → `src/providers/mysite.js`, implement `resolve(media)`.
2. Register it in `src/providers/registry.js`.
3. Verify: `npm run check && npm run audit && npm run smoke -- --offline`, then `node src/index.js -a -S "Naruto" --provider mysite --print-url --debug`.

## License

MIT. Streams come from unaffiliated third-party sources — use per local law and each site's terms.
