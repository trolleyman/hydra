#!/usr/bin/env bash
# Find what is stalling the machine on disk I/O.
#
# A machine running several Hydra heads can go unresponsive - the web UI stops
# answering, the desktop freezes - without being short of either CPU or memory.
# The usual cause is disk: enough concurrent write traffic (builds, git, SQLite,
# the chat event logs) that every task on the box spends its time waiting on the
# queue rather than running.
#
# `top` will not show you this. A task blocked in D-state is not using CPU, so
# load average and %CPU both look survivable while nothing actually progresses.
# The kernel measures it directly instead, in /proc/pressure/io (PSI):
#
#   some  - at least one task was stalled waiting on I/O
#   full  - EVERY runnable task was stalled, so the machine did no work at all
#
# `full` is the number that matches the feeling of a freeze. Anything sustained
# above a few percent is worth chasing; double digits is a machine that visibly
# hangs. Compare it against /proc/pressure/{cpu,memory}: if those are ~0 and io
# is not, the problem is disk, and no amount of reading Go stack traces will
# explain it (they will all show goroutines parked in write/fsync - a symptom).
#
# This script prints that pressure either side of a sampling window, then
# attributes the traffic by diffing each process's /proc/<pid>/io counters:
#
#   write_bytes  bytes the process actually sent to the block layer. This is the
#                one that matters - it excludes writes absorbed by the page
#                cache and never written back, so it is real device traffic.
#   read_bytes   same, for reads that missed the cache.
#
# It reads nothing but /proc, so it needs no tooling on the machine (no iotop,
# no sysstat, no bcc). Processes owned by other users only show up when run as
# root; Hydra's daemon, its heads and your desktop session all run as you, so
# plain user works for the cases this was written for.
#
# Usage:
#   scripts/io-stall.sh [seconds] [--top N]
#
#   seconds   sampling window, default 5. Longer is steadier; shorter catches a
#             burst you are watching happen.
#   --top N   how many processes to list per direction, default 10.
#
# Run it WHILE the machine is janky - it measures the window it runs in, so a
# sample taken once things are calm tells you nothing.

set -uo pipefail

secs=5
top=10
while [ $# -gt 0 ]; do
  case "$1" in
    --top) top="${2:-10}"; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) secs="$1"; shift ;;
  esac
done

pressure() {
  local label="$1" f
  echo "== pressure ($label) =="
  for f in cpu io memory; do
    # avg10/avg60/avg300 are percentages of the last 10s/1m/5m spent stalled.
    printf '%-7s %s\n' "$f" "$(sed 's/total=[0-9]*//g' "/proc/pressure/$f" 2>/dev/null | tr '\n' ' ')"
  done
}

# snapshot BYTES_FIELD SYSC_FIELD -> "<pid> <bytes> <syscalls>" per process.
snapshot() {
  local bytes="$1" sysc="$2" p pid line
  for p in /proc/[0-9]*; do
    pid="${p#/proc/}"
    line=$(awk -v b="^$bytes:" -v s="^$sysc:" \
      '$0 ~ b {n=$2} $0 ~ s {c=$2} END {if (n != "") print n, c+0}' "$p/io" 2>/dev/null) || continue
    [ -n "$line" ] && echo "$pid $line"
  done
}

# report LABEL BEFORE AFTER: diff two snapshots and rank the movers by bytes.
#
# The syscall column is why this is here and not just `du`: many small flushed
# writes cost far more queue time than their size suggests, so a process can sit
# near the bottom on KB and still be what everything else is waiting behind.
report() {
  local label="$1" before="$2" after="$3"
  echo "== $label =="
  awk -v top="$top" '
    NR == FNR { kb0[$1] = $2; n0[$1] = $3; next }
    ($1 in kb0) {
      kb = ($2 - kb0[$1]) / 1024
      n  = $3 - n0[$1]
      if (kb > 0 || n > 0) printf "%d\t%d\t%d\n", kb, n, $1
    }
  ' "$before" "$after" | sort -rn | head -n "$top" | while IFS=$'\t' read -r kb n pid; do
    # cmdline is NUL-separated and an agent's can carry an entire system prompt,
    # newlines and all - flatten it or the table is unreadable.
    cmd=$(tr '\0\n\t' '   ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-80)
    [ -n "$cmd" ] || cmd="[$(cat "/proc/$pid/comm" 2>/dev/null || echo "pid $pid")]"
    printf '%9d KB  %8s calls  %7s  %s\n' "$kb" "$n" "$pid" "$cmd"
  done
  echo
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pressure "before"
echo
snapshot write_bytes syscw > "$tmp/w1"
snapshot read_bytes  syscr > "$tmp/r1"
sleep "$secs"
snapshot write_bytes syscw > "$tmp/w2"
snapshot read_bytes  syscr > "$tmp/r2"

report "top disk writers over ${secs}s" "$tmp/w1" "$tmp/w2"
report "top disk readers over ${secs}s" "$tmp/r1" "$tmp/r2"
pressure "after"
