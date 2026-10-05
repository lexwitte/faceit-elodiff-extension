#!/usr/bin/env bash
# Packs the extension into dist/faceit-elo-diff-<version>.zip for the Chrome Web Store.
# Prints the archive path on success.
set -euo pipefail
cd "$(dirname "$0")/.."

# Only what the extension loads at runtime; README, screenshots and the like stay out.
FILES=(
  manifest.json
  background.js
  content.js
  ping-bridge.js
  ping-main.js
  styles.css
  logo.png
)

for f in "${FILES[@]}"; do
  [[ -f $f ]] || { echo "build-zip: missing $f" >&2; exit 1; }
done

version=$(node -p 'require("./manifest.json").version')
out="dist/faceit-elo-diff-${version}.zip"

mkdir -p dist
rm -f "$out"
# -X drops extra file attributes (uid/gid, timestamps beyond mtime) the store doesn't need.
zip -q -X "$out" "${FILES[@]}"
echo "$out"
