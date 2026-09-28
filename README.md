# fahy

Anime, movies, TV, YouTube, and music in your terminal.

## Install

```powershell
irm https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.sh | bash
```

## Usage

```text
fahy                          # interactive shell
fahy -a -S "Frieren" --episode 3
fahy --movie -S "Inception"
fahy --tv -S "Breaking Bad"
fahy -y -S "lofi beats"
fahy -m -S "bohemian rhapsody"
```

| Mode | Providers |
|------|-----------|
| Anime | hianime, anikoto, anisuge |
| Movie/TV | lookmovie, movy, flixer |
| YouTube | youtube |
| Music | ytmusic |

## Keys

| Shell | mpv |
|-------|-----|
| `↑↓` navigate | `space` pause |
| `enter` select | `←/→` seek |
| `tab` switch mode | `q` quit |
| `esc` back | |
| `s` search | |

## Data

`~/.config/fahy-cli/` — no credentials stored. mpv and yt-dlp run tracking-free.

## License

MIT
