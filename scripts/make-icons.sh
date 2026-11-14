#!/bin/bash
# Generates the app icons from build/icon.svg.
#   build/icon.png   1024 px (electron-builder, Linux)
#   build/icon.icns  macOS
#   build/icon.ico   Windows
#   src/assets/icon.png  runtime window/dock icon and viewer page favicon
# Requires: rsvg-convert (librsvg), ImageMagick; iconutil on macOS for .icns.
set -euo pipefail
cd "$(dirname "$0")/.."

SVG=build/icon.svg
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

rsvg-convert -w 1024 -h 1024 "$SVG" -o build/icon.png
rsvg-convert -w 512 -h 512 "$SVG" -o src/assets/icon.png

# Windows .ico: each size is rendered separately from the SVG (sharper at small sizes).
ICO_PARTS=()
for s in 16 24 32 48 64 128 256; do
  rsvg-convert -w $s -h $s "$SVG" -o "$TMP/ico_$s.png"
  ICO_PARTS+=("$TMP/ico_$s.png")
done
magick "${ICO_PARTS[@]}" build/icon.ico

# macOS .icns
if command -v iconutil >/dev/null; then
  SET="$TMP/icon.iconset"
  mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    rsvg-convert -w $s -h $s "$SVG" -o "$SET/icon_${s}x${s}.png"
    rsvg-convert -w $((s * 2)) -h $((s * 2)) "$SVG" -o "$SET/icon_${s}x${s}@2x.png"
  done
  iconutil -c icns "$SET" -o build/icon.icns
fi

echo "Icons generated."
