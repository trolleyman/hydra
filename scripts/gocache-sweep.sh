#!/usr/bin/env bash
# Trim the Go build cache harder than the go command does on its own.
#
# `go` already trims its cache, but only entries unused for 5 days, and it only
# scans once per 24h (cmd/go/internal/cache: trimLimit, trimInterval). On a
# machine running several Hydra heads that is far too slow: each head's builds,
# `go test ./...` runs, preview servers and artifact generations write a couple
# of GiB an hour, so the 5-day window settles at 50GiB+. There is no size cap
# in the go command - no GOCACHELIMIT exists - so this provides one.
#
# Two eviction policies, usable together:
#   --hours N      drop entries unused for more than N hours (like the go
#                  command's own policy, just with a shorter window)
#   --max-size SZ  drop least-recently-used entries until the cache fits in SZ
#                  (what a GOCACHELIMIT would do; a hard bound regardless of
#                  how busy or quiet the machine has been)
#
# Both mirror cmd/go/internal/cache.(*DiskCache).trimSubdir in what they are
# willing to delete: only `<GOCACHE>/<00..ff>/*-a` and `*-d` entries (files, or
# directories for executable entries), and nothing else - trim.txt, README and
# the fuzz/ corpus are left alone, exactly as the go command leaves them. Go
# stamps mtime on each use (at most hourly), so mtime is "last used" and
# evicting an entry only ever costs a rebuild, never a corrupt cache.
#
# Usage:
#   scripts/gocache-sweep.sh [--hours N] [--max-size SZ] [--dry-run]
#
# With no policy flags the default is --hours 12.
set -euo pipefail

hours=""
max_size=""
dry_run=0
while [ $# -gt 0 ]; do
	case "$1" in
	--hours) hours="$2"; shift 2 ;;
	--hours=*) hours="${1#*=}"; shift ;;
	--max-size) max_size="$2"; shift 2 ;;
	--max-size=*) max_size="${1#*=}"; shift ;;
	--dry-run|-n) dry_run=1; shift ;;
	-h|--help) sed -n '2,27p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
if [ -z "$hours" ] && [ -z "$max_size" ]; then
	hours=12
fi

cache=$(go env GOCACHE)
if [ -z "$cache" ] || [ ! -d "$cache" ]; then
	echo "GOCACHE ($cache) is not a directory" >&2
	exit 1
fi

# Parse a human size (20G / 500M / 1T, binary units) into bytes.
to_bytes() {
	local s="${1^^}" n unit
	n="${s%%[KMGT]*}"
	unit="${s#"$n"}"
	case "${unit%IB}" in
	""|B) echo "$n" ;;
	K) echo "$((n * 1024))" ;;
	M) echo "$((n * 1024 ** 2))" ;;
	G) echo "$((n * 1024 ** 3))" ;;
	T) echo "$((n * 1024 ** 4))" ;;
	*) echo "unparseable size: $1" >&2; exit 2 ;;
	esac
}

# iec-i, not iec: the sizes here are binary, so this must print "20GiB" and not
# a "20GB" that reads as decimal.
human() { numfmt --to=iec-i --suffix=B "$1" 2>/dev/null || echo "${1}B"; }

# One pass over the cache. For every file at depth >= 2 emit its allocated size
# (%b is 512-byte blocks actually on disk, which is what df reports - the cache
# is mostly tiny files, so apparent size would undercount badly), plus the mtime
# of the depth-2 entry it belongs to. awk folds contents back onto their
# owning entry, so an executable entry's `-d` directory is weighed and evicted
# as one unit.
scan() {
	find "$cache" -mindepth 2 -printf '%d %T@ %b %p\n' 2>/dev/null | awk -v cache="$cache" '
		BEGIN { clen = length(cache) + 2 }
		{
			depth = $1; mtime = $2; blocks = $3
			path = $0; sub(/^[^ ]+ [^ ]+ [^ ]+ /, "", path)
			rel = substr(path, clen)
			slash = index(rel, "/")
			if (slash == 0) next                      # a shard dir itself
			shard = substr(rel, 1, slash - 1)
			rest = substr(rel, slash + 1)
			slash2 = index(rest, "/")
			name = (slash2 ? substr(rest, 1, slash2 - 1) : rest)
			if (name !~ /-[ad]$/) next                # not a cache entry
			key = cache "/" shard "/" name
			size[key] += blocks * 512
			if (depth == 2) age[key] = mtime          # the entry itself
		}
		END { for (k in age) printf "%.0f\t%d\t%s\n", age[k], size[k], k }
	'
}

now=$(date +%s)
mapfile -t entries < <(scan | sort -rn)   # newest (most recently used) first
if [ "${#entries[@]}" -eq 0 ]; then
	echo "no cache entries under $cache"
	exit 0
fi

# Walk newest -> oldest, marking for eviction. An entry goes if it is older than
# the --hours cutoff, or if everything kept before it already fills --max-size.
cutoff=0
[ -n "$hours" ] && cutoff=$((now - hours * 3600))
limit=0
[ -n "$max_size" ] && limit=$(to_bytes "$max_size")

total=0 kept=0 freed=0 victims=()
for e in "${entries[@]}"; do
	IFS=$'\t' read -r mtime size path <<<"$e"
	total=$((total + size))
	if { [ -n "$hours" ] && [ "$mtime" -lt "$cutoff" ]; } ||
		{ [ -n "$max_size" ] && [ $((kept + size)) -gt "$limit" ]; }; then
		victims+=("$path")
		freed=$((freed + size))
	else
		kept=$((kept + size))
	fi
done

policy="unused for more than ${hours}h"
[ -n "$max_size" ] && policy="over a $(human "$limit") cap"
[ -n "$hours" ] && [ -n "$max_size" ] && policy="unused for more than ${hours}h, or over a $(human "$limit") cap"

if [ "${#victims[@]}" -eq 0 ]; then
	echo "$cache is $(human "$total") - nothing $policy"
	exit 0
fi

if [ "$dry_run" -eq 1 ]; then
	echo "would remove ${#victims[@]} of ${#entries[@]} entries ($(human "$freed")) $policy"
	echo "  $cache: $(human "$total") -> $(human "$kept")"
	exit 0
fi

printf '%s\0' "${victims[@]}" | xargs -0 rm -rf --
echo "removed ${#victims[@]} of ${#entries[@]} entries ($(human "$freed")) $policy"
echo "  $cache: $(human "$total") -> $(human "$kept")"
