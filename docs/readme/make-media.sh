#!/usr/bin/env bash
# Builds the README's GIF and screenshots from a zz-readme run (desktop/e2e/zz-readme.spec.ts):
#   cd desktop && BOAR_TEST_MODELS_DIR=... BOAR_README_DIR=/tmp/readme npx playwright test zz-readme
#   docs/readme/make-media.sh /tmp/readme
# Needs ffmpeg. Overwrites docs/readme/{demo.gif,chat.png,setup.png,knowledge.png,settings.png}.
set -euo pipefail
src=$1
out=$(dirname "$0")
fps=$(cat "$src/frames/fps.txt")
ffmpeg -loglevel error -y -framerate "$fps" -i "$src/frames/%04d.png" \
  -vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  "$out/demo.gif"
for f in chat setup knowledge settings; do cp "$src/$f.png" "$out/$f.png"; done
ls -lh "$out"
