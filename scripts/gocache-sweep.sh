#!/usr/bin/env bash
# Trim the Go build cache with a shorter window than the go command's own.
#
# `go` already trims the cache, but only entries unused for 5 days, and only
# once per 24h. On a machine running several Hydra heads that is far too slow:
# each head's builds, `go test ./...` runs, preview servers and artifact
# generations write a couple of GiB an hour, so the 5-day window settles at
# 50GiB+.
#
# This mirrors cmd/go/internal/cache.(*DiskCache).trimSubdir exactly - it
# removes only `<GOCACHE>/<00..ff>/*-a` and `*-d` entries (files, or directories
# for executable entries) whose mtime is older than the cutoff. Go stamps mtime
# on each use (at most hourly), so mtime is "last used" and an evicted entry is
# simply a cache miss on the next build, never a corrupt one. Everything else in
# GOCACHE - trim.txt, README, the fuzz/ corpus - is left alone, which is also
# what the go command does.
#
# Usage:
#   scripts/gocache-sweep.sh [--hours N] [--dry-run]
set -euo pipefail

hours=12
dry_run=0
while [ $# -gt 0 ]; do
	case "$1" in
	--hours) hours="$2"; shift 2 ;;
	--hours=*) hours="${1#*=}"; shift ;;
	--dry-run|-n) dry_run=1; shift ;;
	-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

cache=$(go env GOCACHE)
if [ -z "$cache" ] || [ ! -d "$cache" ]; then
	echo "GOCACHE ($cache) is not a directory" >&2
	exit 1
fi

# Only the 256 hex shard dirs, and only -a/-d entries inside them. -mindepth /
# -maxdepth 1 keeps this off the contents of an executable entry's -d directory,
# so such an entry is removed whole or not at all.
mapfile -t victims < <(
	find "$cache" -mindepth 2 -maxdepth 2 \
		-regex '.*/[0-9a-f][0-9a-f]/[0-9a-f]+-[ad]' \
		-mmin "+$((hours * 60))" -print 2>/dev/null
)

if [ "${#victims[@]}" -eq 0 ]; then
	echo "nothing unused for more than ${hours}h in $cache"
	exit 0
fi

bytes=$(printf '%s\0' "${victims[@]}" | du -sch --files0-from=- 2>/dev/null | tail -1 | cut -f1)

if [ "$dry_run" -eq 1 ]; then
	echo "would remove ${#victims[@]} entries ($bytes) unused for more than ${hours}h from $cache"
	exit 0
fi

printf '%s\0' "${victims[@]}" | xargs -0 rm -rf --
echo "removed ${#victims[@]} entries ($bytes) unused for more than ${hours}h from $cache"
