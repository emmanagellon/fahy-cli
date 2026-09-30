# fahy

Anime, movies, TV, YouTube, and music in your terminal.

A run is a **command**: it prints, it asks only when there is a real choice
left, and it exits. There is no full-screen shell.

## Install

```powershell
irm https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.sh | bash
```

## Play

The mode is the command. Type what you want after it.

```text
fahy anime "Frieren"                search, pick a title/season/episode, play
fahy tv "Daybreak" -s 1 -e 1        skip the season and episode prompts
fahy movie "Inception"
fahy yt "lofi beats"                 audio + video
fahy music "lofi beats"              audio only
```

| Mode | Providers |
|------|-----------|
| Anime | hianime, anikoto, anisuge |
| Movie/TV | lookmovie, movy, 7movies, flixer, rive, 67movies |
| YouTube | youtube |
| Music | ytmusic |

Useful play flags (all optional — `fahy help anime` lists them):

| Flag | Effect |
|------|--------|
| `-p, --provider <id>` | use this source instead of asking |
| `-s` / `-e` | season / episode, to script a run |
| `--dub` | prefer the English dub |
| `--print-url` | print the resolved URL and exit, no player |
| `-d, --download` | download with yt-dlp instead of playing |
| `--best` | take the first verified source, never ask |
| `--no-fallback` | only the chosen source, no auto-fallback |
| `--radio` | start a radio mix from the result (yt/music) |

If a source is down, fahy moves to the next one on its own. If a source check
runs long, it is given a deadline and the move is counted as inconclusive
rather than a failure — a slow check never becomes a hang.

When an episode ends you are asked what to do, and the options are the ones
that actually exist: anime and TV offer the next episode, and across a season
boundary that is checked first, so the last episode of a season either offers
the next season or says the show is done. Turn it off entirely with
`fahy autoplay on`. Esc always leaves.

## Resume

```text
fahy history                pick an entry, resume it where you stopped
fahy continue               jump back into the most recent resumable entry
fahy clear-history -y       delete every entry
fahy delete-history <url>   drop specific entries
```

Resume is the same item, not a fresh search: same provider, same season and
episode, and the same offset into the video (for anything with a known length).

The offset comes from mpv itself, checkpointed while you watch, so it survives
Ctrl+C, a closed terminal, or a killed process — not just a clean exit. An
episode counts as finished when mpv says it reached the end, which is why a
finished episode restarts from the beginning rather than from its last
seconds. An attempt that never played leaves no history at all, and re-watching
an episode updates its one row instead of adding a second.

## Everything else

```text
fahy providers              list sources
fahy providers --default anime=hianime
fahy providers --priority "anime=hianime,anikoto"
fahy health                 per-source memory
fahy health --reset hianime
fahy sources                diff the anime adapters against live FMHY and probe
fahy doctor                 check mpv, yt-dlp, transport, config
fahy setup                  guided setup
fahy diagnostics            the last run: what was tried and what failed
fahy downloads | library | prune
fahy favorites | favorite | playlists | playlist-add | playlist-clear
fahy now                    last thing played, plus volume/shuffle/repeat/autoplay
fahy upgrade | uninstall | version
```

## The prompt

There is exactly one interactive surface, and it is temporary: a short list
rendered in place, mounted for one question and gone the moment you answer.
`↑↓` to move, `enter` to pick, `esc` to back out. A lane with one candidate
never asks at all.

## Old flags still work

`fahy -a -S "Frieren"`, `fahy --history`, `fahy --volume 50` and friends are
rewritten to the new form automatically.

## Data

`~/.config/fahy-cli/` — no credentials stored. mpv and yt-dlp run
tracking-free. History is capped and local.

## License

MIT
