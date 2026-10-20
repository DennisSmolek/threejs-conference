#!/usr/bin/env bash
# Interleaved A/B/n: bench/ab.sh [-r rounds=3] [-s stages] name=url[@k=v,k=v] ...
# Each round runs every arm cold then warm (own Chrome profile per arm), then prints medians.
# @k=v sets localStorage switches for that arm (bench/stages.mjs --storage). -n: no Chrome trace
# (tracing slows rendering several-fold: compare arms within one series, quote absolutes untraced).
set -u
ROUNDS=3; STAGES="load,intro,enter,walk,car"; TRACE=(--trace)
while getopts "r:s:n" o; do case $o in r) ROUNDS=$OPTARG;; s) STAGES=$OPTARG;; n) TRACE=();; *) exit 2;; esac; done
shift $((OPTIND - 1))
cd "$(dirname "$0")/.."
NAMES=()
for i in $(seq 1 "$ROUNDS"); do
  for arm in "$@"; do
    name="${arm%%=*}"; rest="${arm#*=}"; url="${rest%%@*}"; storage=""
    [[ "$rest" == *@* ]] && storage="${rest#*@}"
    [ "$i" = 1 ] && NAMES+=("$name")
    for mode in cold warm; do
      flags=(--name "$name-$mode" --url "$url" --profile "tmp/shader-bench/profile-$name" "${TRACE[@]}" --stages "$STAGES")
      [ "$mode" = warm ] && flags+=(--warm)
      [ -n "$storage" ] && flags+=(--storage "$storage")
      node bench/stages.mjs "${flags[@]}" | grep -E "^\[stages .*(done|TIMED)|WARNING" || true
    done
  done
done
dirs=()
for mode in cold warm; do for n in "${NAMES[@]}"; do dirs+=("tmp/shader-bench/$n-$mode"); done; done
node bench/summarize.mjs "${dirs[@]}"
