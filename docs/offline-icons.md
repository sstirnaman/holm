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

1. `icon-library/<source>/<name>.svg` (`<source>` is `di`, `si` or `lucide`)
2. `si` only: the Simple Icons package that ships inside Holm, in the brand colour (so `si:` icons never need the web)
3. The web, unless `icons.source` is `local`

## Setup

```bash
./scripts/fetch-icons.sh        # reads config.yml and the Popular apps list
```

This downloads the icons you use into `icon-library/di/` (and the three Lucide icons the onboarding slides need into `icon-library/lucide/`). Run it again after adding apps. Extra names can be given as arguments: `./scripts/fetch-icons.sh plex lucide:bell`. It prints the names it could not find.

Mount the folder:

```yaml
    volumes:
      - ./icon-library:/app/icon-library:ro
```

Optionally forbid the web entirely, in `config.yml`:

```yaml
icons:
  source: local
```

`ICON_LIBRARY_DIR` overrides the folder inside the container.

## Getting icons by hand

Save the SVG as `icon-library/di/<name>.svg`, using the name you put in `config.yml` (lower-case, spaces as hyphens). Icons you add yourself this way also override the online version of the same name.

## Notes

- With `icons.source: local`, a name with no file gives a blank tile. Holm already falls back from a missing mono icon to the coloured one with a grey filter.
- Apps added through the in-app "Popular" picker are saved with their icon name; add any you use to the folder (the script already covers the Popular list).
- Wallpapers and the weather widget have their own online sources, see `wallpapers.source`; weather uses open-meteo.
