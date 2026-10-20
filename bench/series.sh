#!/usr/bin/env bash
# Alternating cold/warm series: bench/series.sh <name> [pairs=3] [extra stages.mjs flags...]
# Writes tmp/shader-bench/<name>-cold and <name>-warm, then prints the medians.
set -u
NAME="$1"; PAIRS="${2:-3}"; shift; shift || true
cd "$(dirname "$0")/.."
for i in $(seq 1 "$PAIRS"); do
  node bench/stages.mjs --name "$NAME-cold" --trace "$@" | grep -v "^\[stages" || true
  node bench/stages.mjs --name "$NAME-warm" --warm --trace "$@" | grep -v "^\[stages" || true
done
node bench/summarize.mjs "tmp/shader-bench/$NAME-cold" "tmp/shader-bench/$NAME-warm"
