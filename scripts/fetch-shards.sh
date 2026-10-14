#!/usr/bin/env bash
# Downloads FineWiki shards into a work dir for `build-wiki-pack.mjs --wait-for-shards`,
# keeping at most AHEAD finished shards there (the build deletes each one after use)
# and pausing while free disk is under MIN_FREE_GB.
#
#   scripts/fetch-shards.sh WORK_DIR URL...        (env: AHEAD=2 MIN_FREE_GB=20)
set -euo pipefail
work=$1; shift
ahead=${AHEAD:-2}
min_free=${MIN_FREE_GB:-20}
mkdir -p "$work"
free_gb() { df -g "$work" | awk 'NR==2 {print $4}'; }
for url in "$@"; do
  name=$(basename "$url")
  [ -f "$work/$name" ] && continue
  while [ "$(find "$work" -name '*.parquet' | wc -l)" -ge "$ahead" ] || [ "$(free_gb)" -lt "$min_free" ]; do sleep 30; done
  echo "[$(date +%H:%M:%S)] fetching $name"
  curl -fsSL -C - --retry 20 --retry-all-errors --retry-delay 10 -o "$work/$name.part" "$url"
  mv "$work/$name.part" "$work/$name"
  echo "[$(date +%H:%M:%S)] fetched $name"
done
