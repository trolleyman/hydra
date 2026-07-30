#!/usr/bin/env bash
# Collect everything needed to explain a Hydra stall, over a window, into one
# directory you can hand to someone else.
#
# The one-shot tools each answer half a question. A goroutine dump says whether
# the daemon is stuck but never catches a fast loop; a CPU profile says what
# burns CPU but not what waits on disk; scripts/io-stall.sh attributes the IO but
# says nothing about what the daemon was doing at the time. A stall is only
# explicable when those line up in time, which means sampling all of them across
# the same window rather than running each separately and hoping the symptom
# recurs.
#
# Nothing here needs root. pprof needs HYDRA_PPROF set on the server (see
# internal/cli/pprof.go); without it the system-level half is still collected and
# the run says so rather than failing.
#
# Usage:
#   scripts/hydra-profile.sh [--minutes N] [--url URL] [--out DIR]
#
#   --minutes N   how long to sample, default 5. Run it ACROSS a stall - start it
#                 before you trigger a restart, or leave it running until one
#                 happens. A window with no stall in it proves nothing.
#   --url URL     the server, default http://localhost:26600
#   --out DIR     output directory, default ./hydra-profile-<pid>
#   --pid PID     the daemon's pid, if pgrep cannot find it (io-stall.sh prints it)
#
# The result is a directory of plain text plus two pprof files; see its MANIFEST.

set -uo pipefail

minutes=5
url="http://localhost:26600"
out=""
pid_override=""
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --minutes) minutes="${2:-5}"; shift 2 ;;
    --url) url="${2:-$url}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --pid) pid_override="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# pgrep is not reliable here - it has come back empty on a box where the daemon
# was demonstrably running - so --pid is the override, and scripts/io-stall.sh
# prints the pid in its own output if you need to look it up.
pid="${pid_override:-}"
[ -n "$pid" ] || pid=$(pgrep -x hydra 2>/dev/null | head -1)
[ -n "$pid" ] || pid=$(pgrep -f 'exe/hydra' 2>/dev/null | head -1)
[ -z "$out" ] && out="hydra-profile-${pid:-unknown}"
mkdir -p "$out" || exit 1
out="$(cd "$out" && pwd)"

secs=$(( minutes * 60 ))
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$out/run.log"; }

say "collecting for ${minutes}m into $out"
[ -n "$pid" ] && say "hydra pid $pid" || say "WARNING: no hydra process found - per-process stats will be missing"

# Is pprof reachable? Everything pprof-shaped below is skipped if not, rather
# than leaving empty files that look like a daemon with no goroutines.
pprof_ok=0
if curl -fsS --max-time 5 "$url/debug/pprof/" -o /dev/null 2>/dev/null; then
  pprof_ok=1
  say "pprof reachable at $url"
else
  say "WARNING: pprof not reachable at $url - start the server with HYDRA_PPROF=1 for the daemon-side half"
fi

# ---- one-off context: the things that explain the numbers later -------------
{
  echo "date: $(date -Is)"
  echo "uptime: $(uptime)"
  echo "nproc: $(nproc)"
  echo
  echo "== memory =="; free -h
  echo
  echo "== filesystems =="; df -h / /home 2>/dev/null | sort -u
  echo
  echo "== mount options (fsync cost depends on these) =="
  grep -E ' (ext4|xfs|btrfs|f2fs) ' /proc/mounts
  echo
  echo "== IO schedulers (io.weight only works under bfq) =="
  for q in /sys/block/*/queue/scheduler; do echo "$q: $(cat "$q" 2>/dev/null)"; done
  echo
  echo "== blk-iocost (empty = io.weight is inert) =="
  cat /sys/fs/cgroup/io.cost.qos 2>/dev/null
  echo
  echo "== cgroup controllers =="
  echo "controllers: $(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null)"
  echo "subtree:     $(cat /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null)"
  echo
  echo "== hydra scopes and their limits =="
  systemctl --user list-units 'hydra-*' --no-legend 2>/dev/null
  for u in $(systemctl --user list-units 'hydra-*' --no-legend 2>/dev/null | awk '{print $1}'); do
    echo "-- $u"
    systemctl --user show "$u" -p IOWeight -p IOReadBandwidthMax -p IOWriteBandwidthMax -p CPUWeight -p MemoryMax 2>/dev/null
  done
} > "$out/context.txt" 2>&1

if [ -n "$pid" ]; then
  { echo "cmdline: $(tr '\0' ' ' < "/proc/$pid/cmdline")"
    echo "open fds: $(ls "/proc/$pid/fd" 2>/dev/null | wc -l)"
    echo
    echo "== what it holds open =="
    ls -l "/proc/$pid/fd" 2>/dev/null | awk '{print $NF}' | sort | uniq -c | sort -rn
  } > "$out/hydra-fds.txt" 2>&1
fi

# ---- the whole-window CPU profile, running alongside the sampling -----------
if [ "$pprof_ok" = 1 ]; then
  curl -fsS --max-time $(( secs + 30 )) "$url/debug/pprof/profile?seconds=$secs" \
    -o "$out/cpu.pprof" 2>>"$out/run.log" &
  cpu_job=$!
  say "CPU profile started (covers the whole window)"
fi

# ---- periodic sampling ------------------------------------------------------
# Each tick spends 10s inside io-stall.sh attributing IO, so the tick is ~15s.
ticks=$(( secs / 15 )); [ "$ticks" -lt 1 ] && ticks=1
for i in $(seq 1 "$ticks"); do
  {
    echo "################ tick $i/$ticks  $(date +%H:%M:%S) ################"
    if [ -n "$pid" ] && [ -r "/proc/$pid/io" ]; then
      echo "-- hydra /proc/$pid/io"; cat "/proc/$pid/io"
    fi
    echo "-- /proc/diskstats (nvme/sd only)"
    awk '$3 ~ /^(nvme|sd)/ {print $3, "reads="$4, "read_ms="$7, "writes="$8, "write_ms="$11, "io_ms="$13}' /proc/diskstats
    echo
  } >> "$out/timeseries.txt" 2>&1
  bash "$here/io-stall.sh" 10 --top 12 >> "$out/timeseries.txt" 2>&1

  # A goroutine dump every tick: cheap, and the one that matters is whichever
  # lands during the stall.
  if [ "$pprof_ok" = 1 ]; then
    curl -fsS --max-time 10 "$url/debug/pprof/goroutine?debug=2" \
      -o "$out/goroutines-$(printf '%02d' "$i").txt" 2>>"$out/run.log"
  fi
  say "tick $i/$ticks done"
done

if [ "$pprof_ok" = 1 ]; then
  wait "${cpu_job:-}" 2>/dev/null
  curl -fsS --max-time 20 "$url/debug/pprof/heap" -o "$out/heap.pprof" 2>>"$out/run.log"
  curl -fsS --max-time 20 "$url/debug/pprof/goroutine?debug=1" -o "$out/goroutine-summary.txt" 2>>"$out/run.log"
fi

cat > "$out/MANIFEST" <<MANIFEST
Hydra profile collected $(date -Is) over ${minutes} minutes.
hydra pid: ${pid:-not found}   pprof: $([ "$pprof_ok" = 1 ] && echo reachable || echo UNAVAILABLE)

context.txt            one-off: memory, filesystems + mount options, IO schedulers,
                       blk-iocost, cgroup controllers, and every hydra-* scope with
                       the resource limits actually in force.
hydra-fds.txt          what the daemon holds open, counted by target. Names the
                       files behind heavy read/write counts.
timeseries.txt         per tick: hydra's /proc/<pid>/io counters, raw diskstats,
                       then io-stall.sh - pressure either side plus the top disk
                       writers and readers by bytes AND syscall count.
                       io "full" is the number that matches a freeze: every task
                       stalled. Compare against cpu/memory pressure - if those are
                       ~0 and io is not, it is disk.
goroutines-NN.txt      full stacks per tick. Look for a state lasting minutes, a
                       climbing count (leak), or waits on locks (contention).
goroutine-summary.txt  the same aggregated by stack.
cpu.pprof              CPU profile spanning the whole window:
                         go tool pprof -top -nodecount=30 cpu.pprof
heap.pprof             live allocations at the end:
                         go tool pprof -top -nodecount=30 heap.pprof
run.log                what this script did, including anything it could not collect.

Not collected (needs root): fsync attribution. If a stall recurs, run
  sudo bpftrace -e 'tracepoint:syscalls:sys_enter_fsync,tracepoint:syscalls:sys_enter_fdatasync { @[comm] = count(); }'
alongside this and save the output here as fsyncs.txt - fsync latency, not
volume, is what stalls an ext4 filesystem machine-wide.
MANIFEST

say "done - $out"
echo
cat "$out/MANIFEST"
