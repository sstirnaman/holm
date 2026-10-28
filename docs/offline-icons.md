# Offline icons

By default Holm shows app icons by fetching them (through its own `/api/icon/...` cache) from public CDNs. This makes it read them from a local folder instead.

## Where icons come from online

| Prefix in `config.yml` | Library | Fetched from |
|---|---|---|
| none, or `di:` | [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) | `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/<name>.svg` |
| `si:` (and the automatic mono fallback) | [Simple Icons](https://simpleicons.org) | `https://cdn.simpleicons.org/<name>` |
| onboarding slides only | [Lucide](https://lucide.dev) | `https://cdn.jsdelivr.net/npm/lucide-static/icons/<name>.svg` |

Full URLs and `/custom-icons/...` paths are not affected.

## Lookup order

For `/api/icon/<source>/<name>`, Holm tries:

1. `icons/<source>/<name>.svg` (`<source>` is `di`, `si` or `lucide`). For Dashboard Icons a flat `icons/<name>.svg` works too, and `.png` and `.webp` files are accepted as well as `.svg`
2. `si` only: the Simple Icons package that ships inside Holm, in the brand colour (so `si:` icons never need the web)
3. The web, unless `icons.source` is `local`

## Setup

```bash
./scripts/fetch-icons.sh        # reads config.yml and the Popular apps list
```

This downloads the icons you use into `icons/di/` (and the three Lucide icons the onboarding slides need into `icons/lucide/`). Run it again after adding apps. Extra names can be given as arguments: `./scripts/fetch-icons.sh plex lucide:bell`. It prints the names it could not find.

Mount the folder:

```yaml
    volumes:
      - ./icons:/app/icons:ro
```

Optionally forbid the web entirely, in `config.yml`:

```yaml
icons:
  source: local
```

`ICONS_DIR` overrides the folder inside the container (default `/app/icons`).

## If it doesn't seem to work

- **Check the log.** `docker logs <container>` shows one line on the first icon request, either `reading local icons from /app/icons (di, …)` or `no readable folder at /app/icons`. A `can't read <file>` warning means a permission problem: the container runs as uid 1000, so `chmod -R a+rX ./icons`.
- **Browsers keep icons for up to a day.** An icon that was already shown from the web is cached by the browser; hard-refresh (Ctrl+F5) or clear the site's cache once.
- **Names must match.** `hacker-news.svg`, not `Hacker News.svg`. Open `http://<host>:3000/api/icon/di/<name>.svg` to see what Holm returns for a name.

## Getting icons by hand

Save the SVG as `icons/di/<name>.svg`, using the name you put in `config.yml` (lower-case, spaces as hyphens). Icons you add yourself this way also override the online version of the same name.

## Notes

- With `icons.source: local`, a name with no file gives a blank tile. Holm already falls back from a missing mono icon to the coloured one with a grey filter.
- Apps added through the in-app "Popular" picker are saved with their icon name; add any you use to the folder (the script already covers the Popular list).
- Wallpapers and the weather widget have their own online sources, see `wallpapers.source`; weather uses open-meteo.
