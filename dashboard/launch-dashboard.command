#!/bin/zsh
cd "$(dirname "$0")/.." || exit 1
exec ./dashboard/career-dashboard -path .
