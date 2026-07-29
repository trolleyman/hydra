#!/usr/bin/env bash
# Install gocache-sweep.sh as a repeating systemd user timer.
#
# The sweep is only useful if it repeats - a single run buys back disk, but
# several active Hydra heads refill the build cache at a couple of GiB an hour,
# so it climbs back within a day. This installs the units that keep it capped
# without you thinking about it.
#
# A *user* timer (not a system one) because GOCACHE is per-user, lives under
# $HOME, and needs no privilege to trim. Nothing here touches the system.
#
# Usage:
#   scripts/gocache-sweep-install.sh [--max-size SZ] [--hours N] [--every T]
#   scripts/gocache-sweep-install.sh --uninstall
#   scripts/gocache-sweep-install.sh --print          # show the units, write nothing
#
# Defaults to `--max-size 20G` every hour. The policy flags are passed straight
# through to gocache-sweep.sh, so see its --help for what they mean.
set -euo pipefail

name=gocache-sweep
interval=1h
policy=()
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
uninstall=0
print_only=0

while [ $# -gt 0 ]; do
	case "$1" in
	--max-size|--hours) policy+=("$1" "$2"); shift 2 ;;
	--max-size=*|--hours=*) policy+=("$1"); shift ;;
	--every) interval="$2"; shift 2 ;;
	--every=*) interval="${1#*=}"; shift ;;
	--unit-dir) unit_dir="$2"; shift 2 ;;
	--unit-dir=*) unit_dir="${1#*=}"; shift ;;
	--uninstall) uninstall=1; shift ;;
	--print) print_only=1; shift ;;
	-h|--help) sed -n '2,18p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
[ "${#policy[@]}" -eq 0 ] && policy=(--max-size 20G)

service="$unit_dir/$name.service"
timer="$unit_dir/$name.timer"

have_systemctl() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

if [ "$uninstall" -eq 1 ]; then
	if have_systemctl; then
		systemctl --user disable --now "$name.timer" 2>/dev/null || true
	fi
	rm -f "$service" "$timer"
	have_systemctl && systemctl --user daemon-reload
	echo "removed $name.timer and $name.service"
	exit 0
fi

# Resolve the sweep script next to this one, as an absolute path - a unit file
# has no working directory or PATH to fall back on.
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
sweep="$here/gocache-sweep.sh"
if [ ! -x "$sweep" ]; then
	echo "cannot find an executable gocache-sweep.sh next to this script ($sweep)" >&2
	exit 1
fi

# A unit baked with a worktree path breaks the moment that head is merged or
# killed and its worktree is reclaimed. Install from a durable checkout.
case "$sweep" in
*/.hydra/local/worktrees/*)
	echo "refusing to install: $sweep is inside a Hydra worktree, which is deleted when" >&2
	echo "the head is merged or killed, leaving a timer pointing at nothing." >&2
	echo "Merge this branch and run the installer from the main checkout instead." >&2
	exit 1
	;;
esac

read -r -d '' service_unit <<EOF || true
[Unit]
Description=Trim the Go build cache
Documentation=file:$sweep

[Service]
Type=oneshot
ExecStart=$sweep ${policy[*]}
# The sweep stats every file in the cache - hundreds of thousands of them - so
# keep it out of the way of whatever the heads are actually building.
Nice=10
IOSchedulingClass=idle
EOF

read -r -d '' timer_unit <<EOF || true
[Unit]
Description=Trim the Go build cache every $interval

[Timer]
OnBootSec=5min
OnUnitActiveSec=$interval
# A minute of slack lets systemd batch this with other wakeups.
AccuracySec=1min
# No Persistent= here: it only applies to OnCalendar= timers, and a missed sweep
# needs no catching up - the next one evicts exactly the same entries.

[Install]
WantedBy=timers.target
EOF

if [ "$print_only" -eq 1 ]; then
	echo "# $service"; echo "$service_unit"; echo
	echo "# $timer"; echo "$timer_unit"
	exit 0
fi

mkdir -p "$unit_dir"
printf '%s\n' "$service_unit" >"$service"
printf '%s\n' "$timer_unit" >"$timer"
echo "wrote $service"
echo "wrote $timer"

if ! have_systemctl; then
	echo
	echo "systemctl --user is not reachable from here, so the units were written but not enabled."
	echo "Finish with:"
	echo "  systemctl --user daemon-reload"
	echo "  systemctl --user enable --now $name.timer"
	exit 0
fi

systemctl --user daemon-reload
systemctl --user enable --now "$name.timer"
echo
echo "enabled - $name.sweep runs $sweep ${policy[*]} every $interval"
systemctl --user list-timers "$name.timer" --no-pager 2>/dev/null || true
echo
echo "Note: a user timer only runs while you have a session. To let it run when"
echo "logged out too:  loginctl enable-linger $USER"
echo "Logs:            journalctl --user -u $name.service"
