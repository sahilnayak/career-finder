#!/bin/sh
# Thin wrapper kept for schedulers that call the shell entry point.
# The pipeline itself lives in scripts/morning.mjs (mode: hot). See docs/SCHEDULING.md.
cd "$(dirname "$0")/.." || exit 2
exec node scripts/morning.mjs --mode hot "$@"
