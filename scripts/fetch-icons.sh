#!/usr/bin/env bash
# Download the icons your Holm config uses into ./icon-library, so the
# dashboard never has to fetch them from the web.
#
#   ./scripts/fetch-icons.sh                  # everything config.yml + the Popular list use
#   ./scripts/fetch-icons.sh plex lucide:bell # plus any extra names
#
# Sources (the same ones Holm uses online):
#   di:     https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/<name>.svg
#   lucide: https://cdn.jsdelivr.net/npm/lucide-static/icons/<name>.svg
#   si:     not downloaded; Holm bundles the Simple Icons package (see docs/offline-icons.md)
set -u
cd "$(dirname "$0")/.."

OUT="${ICON_LIBRARY_DIR:-icon-library}"
CONFIG="${CONFIG_PATH:-config.yml}"
DI_BASE_URL="${DI_BASE_URL:-https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg}"
LUCIDE_BASE_URL="${LUCIDE_BASE_URL:-https://cdn.jsdelivr.net/npm/lucide-static/icons}"

mkdir -p "$OUT/di" "$OUT/lucide"
ok=0; skipped=0; failed=()

fetch() { # source name
  local source=$1 name=$2 base dest="$OUT/$1/$2.svg"
  [ -s "$dest" ] && { ok=$((ok + 1)); return; }
  case $source in di) base=$DI_BASE_URL ;; lucide) base=$LUCIDE_BASE_URL ;; esac
  if curl -fsSL --max-time 20 "$base/$name.svg" -o "$dest.tmp" 2>/dev/null && [ -s "$dest.tmp" ]; then
    mv "$dest.tmp" "$dest"; ok=$((ok + 1)); echo "  got  $source/$name"
  else
    rm -f "$dest.tmp"; failed+=("$source/$name"); echo "  FAIL $source/$name"
  fi
}

# Same normalisation Holm applies: lower-case, spaces become hyphens.
slug() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -E 's/^ +| +$//g; s/ +/-/g'; }

names=()
# Values of icon: / icon_mono: in config.yml and the Popular apps list.
for f in "$CONFIG" src/lib/popularApps.js; do
  [ -f "$f" ] || continue
  while IFS= read -r v; do names+=("$v"); done < <(
    grep -E '^[[:space:]-]*icon(_mono)?:|[{,][[:space:]]*icon:' "$f" |
      grep -oE "icon(_mono)?:[[:space:]]*[\"'][^\"']+[\"']" |
      sed -E "s/^icon(_mono)?:[[:space:]]*[\"']//; s/[\"']\$//"
  )
done
# Names the onboarding slides use, plus anything given on the command line.
names+=("lucide:shield-check" "lucide:lock" "lucide:check" "$@")

for raw in "${names[@]}"; do
  case $raw in
    http*|/*|si:*) skipped=$((skipped + 1)); continue ;;
    lucide:*) fetch lucide "$(slug "${raw#lucide:}")" ;;
    *) fetch di "$(slug "$(printf '%s' "$raw" | sed -E 's/^(di|sh)://')")" ;;
  esac
done

echo
echo "$ok icons in $OUT, $skipped skipped (URLs, paths and si: names), ${#failed[@]} failed"
if [ ${#failed[@]} -gt 0 ]; then
  printf '  not found: %s\n' "${failed[@]}"
  echo "A bare name that Dashboard Icons lacks needs 'si:<name>' or your own file; see docs/offline-icons.md."
  exit 1
fi
