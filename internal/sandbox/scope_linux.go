//go:build linux

package sandbox

import (
	"bufio"
	"bytes"
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Transient systemd user scopes wrap each sandboxed workload (agent, preview,
// service, artifact) so its whole process subtree lives in its own cgroup with a
// single kill handle (StopScope) and can't escape by reparenting to systemd when
// the daemon dies. The per-workload cgroup also carries CPU/IO weights and
// optional hard caps (see ScopeLimits) so a runaway workload yields to the daemon.
//
// Best-effort: where the user has no systemd session manager the wrapper is
// skipped and the workload runs directly (callers keep the unwrapped spec as a
// fallback). Where scopes work but a given cgroup controller isn't delegated to
// the user manager, we keep the scope (still useful for reaping) but drop that
// controller's properties, so a spawn never fails just because a controller is
// missing. Delegation is probed per controller group at detection time.

var (
	scopeOnce      sync.Once
	scopeOK        bool // transient scopes work at all
	cpuOK          bool // cpu controller delegated (CPUWeight/CPUQuota accepted)
	ioOK           bool // io controller delegated (IOWeight accepted)
	ioMaxOK        bool // io controller accepts per-device caps (IO*BandwidthMax)
	memoryOK       bool // memory controller delegated (MemoryMax accepted)
	pidsOK         bool // pids controller delegated (TasksMax accepted)
	systemdRunPath string
	systemctlPath  string
)

// ScopesAvailable reports (and caches) whether transient systemd user scopes work
// on this host. It runs throwaway no-op scopes once - a bare scope to establish
// they work at all, then one per controller group with a representative property
// - so a broken user manager or an undelegated controller is caught at detection
// time rather than when a real workload spawns. The per-group results gate which
// --property flags allProps emits, so a missing controller drops just its own
// limit instead of failing the whole spawn.
func ScopesAvailable() bool {
	scopeOnce.Do(func() {
		sr, err1 := exec.LookPath("systemd-run")
		sc, err2 := exec.LookPath("systemctl")
		if err1 != nil || err2 != nil {
			return
		}
		systemdRunPath, systemctlPath = sr, sc
		if !probeScope(sr) {
			log.Printf("sandbox: systemd user scopes unavailable; workloads run unscoped")
			return
		}
		scopeOK = true
		// Probe each controller group independently with a throwaway property (the
		// value is immaterial - only whether systemd-run accepts it). cpu covers
		// both CPUWeight and CPUQuota; io covers IOWeight; memory MemoryMax; pids
		// TasksMax. memory/pids are usually delegated by default, cpu/io often not.
		cpuOK = probeScope(sr, "--property=CPUWeight=50")
		ioOK = probeScope(sr, "--property=IOWeight=50")
		// Probed separately from IOWeight: the caps are the same controller but a
		// different property shape (per-device, "<path> <rate>"), and they are the
		// half that still works when weights are inert.
		ioMaxOK = probeScope(sr, "--property=IOWriteBandwidthMax=/ 1G")
		memoryOK = probeScope(sr, "--property=MemoryMax=64M")
		pidsOK = probeScope(sr, "--property=TasksMax=64")
		var dropped []string
		if !cpuOK {
			dropped = append(dropped, "cpu (CPUWeight/CPUQuota)")
		}
		if !ioOK {
			dropped = append(dropped, "io (IOWeight)")
		}
		if !memoryOK {
			dropped = append(dropped, "memory (MemoryMax)")
		}
		if !pidsOK {
			dropped = append(dropped, "pids (TasksMax)")
		}
		if len(dropped) > 0 {
			log.Printf("sandbox: systemd scopes work but these cgroup controllers are not delegated to the user manager, so their limits are skipped: %s", strings.Join(dropped, ", "))
		}
		// A delegated io controller is not the same as a working IOWeight, and the
		// difference is invisible from the property being accepted - so say it out
		// loud rather than letting the default 50 look like protection it isn't.
		if ioOK && !ioWeightEffective() {
			log.Printf("sandbox: cgroup io.weight does nothing on this host (no device using the bfq scheduler, and blk-iocost is unconfigured), so IOWeight is accepted but inert - a heavy workload can still stall the machine. Set [resources] io_write_bandwidth_max (and io_read_bandwidth_max) for a ceiling that bites regardless, or enable bfq/iocost on the host.")
		}
	})
	return scopeOK
}

// probeScope runs a throwaway scope around /bin/true and reports whether it was
// accepted. props lets the caller test optional --property flags.
func probeScope(systemdRun string, props ...string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := append([]string{"--user", "--scope", "--quiet", "--collect"}, props...)
	args = append(args, "--", "true")
	return exec.CommandContext(ctx, systemdRun, args...).Run() == nil
}

// ioWeightEffective reports whether cgroup io.weight can do anything at all on
// this host. Weight-based IO control is implemented by BFQ (per device) or by
// blk-iocost; with neither, io.weight is written, accepted and ignored. Reading
// the two places that decide it is the only way to tell - systemd and the kernel
// both accept the property either way.
func ioWeightEffective() bool {
	// iocost active on any device (io.cost.qos lists configured devices).
	if data, err := os.ReadFile("/sys/fs/cgroup/io.cost.qos"); err == nil && len(bytes.TrimSpace(data)) > 0 {
		return true
	}
	// Or any device whose selected scheduler is bfq ("[bfq]" = currently active).
	scheds, _ := filepath.Glob("/sys/block/*/queue/scheduler")
	for _, s := range scheds {
		if data, err := os.ReadFile(s); err == nil && bytes.Contains(data, []byte("[bfq]")) {
			return true
		}
	}
	return false
}

// allProps returns the --property flags to apply for limits, filtered to the
// controller groups this host actually delegates (see ScopesAvailable). A
// property whose controller isn't delegated is dropped so systemd-run can never
// reject the whole spawn; a field <= 0 is omitted entirely (no limit for it).
func allProps(limits ScopeLimits) []string {
	var p []string
	if cpuOK {
		if limits.CPUWeight > 0 {
			p = append(p, "--property=CPUWeight="+strconv.Itoa(limits.CPUWeight))
		}
		if limits.CPUQuota > 0 {
			p = append(p, "--property=CPUQuota="+strconv.Itoa(limits.CPUQuota)+"%")
		}
	}
	if ioOK && limits.IOWeight > 0 {
		p = append(p, "--property=IOWeight="+strconv.Itoa(limits.IOWeight))
	}
	if ioMaxOK && limits.IOPath != "" {
		if limits.IOReadBandwidthMax > 0 {
			p = append(p, "--property=IOReadBandwidthMax="+limits.IOPath+" "+strconv.Itoa(limits.IOReadBandwidthMax)+"M")
		}
		if limits.IOWriteBandwidthMax > 0 {
			p = append(p, "--property=IOWriteBandwidthMax="+limits.IOPath+" "+strconv.Itoa(limits.IOWriteBandwidthMax)+"M")
		}
	}
	if memoryOK && limits.MemoryMax > 0 {
		p = append(p, "--property=MemoryMax="+strconv.Itoa(limits.MemoryMax)+"M")
	}
	if pidsOK && limits.TasksMax > 0 {
		p = append(p, "--property=TasksMax="+strconv.Itoa(limits.TasksMax))
	}
	return p
}

// WrapScope rewrites spec to run under the transient systemd user scope named
// unit, so its process subtree gets its own cgroup, the resolved resource limits
// and a single kill handle. Returns true if the spec was wrapped; false (spec
// untouched) when scopes are unavailable. Any stale unit of the same name is
// cleared first so systemd-run can't fail with "unit already exists".
func WrapScope(unit string, spec *Spec, limits ScopeLimits) bool {
	if !ScopesAvailable() {
		return false
	}
	StopScope(unit) // clear a stale same-named unit left by a prior life

	wrapped := []string{systemdRunPath, "--user", "--scope", "--quiet", "--collect", "--unit=" + unit}
	wrapped = append(wrapped, allProps(limits)...)
	wrapped = append(wrapped, "--", spec.Path)
	wrapped = append(wrapped, spec.Args[1:]...)
	spec.Path = systemdRunPath
	spec.Args = wrapped
	return true
}

// StopScope stops (and, via --collect, garbage-collects) the transient scope
// unit, reaping every process in its cgroup atomically. Best-effort; safe to call
// for a unit that does not exist.
func StopScope(unit string) {
	if systemctlPath == "" || unit == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, systemctlPath, "--user", "stop", unit).Run()
}

// SweepOrphanScopes stops any leftover hydra-*.scope units from a prior daemon
// that died before draining. Call once at daemon boot, when no workloads are live
// yet, so every such unit is stale. Best-effort.
func SweepOrphanScopes() {
	if !ScopesAvailable() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, systemctlPath, "--user", "list-units", "--all",
		"--plain", "--no-legend", "--type=scope", scopeUnitPrefix+"*.scope").Output()
	if err != nil {
		return
	}
	var units []string
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) > 0 && strings.HasPrefix(f[0], scopeUnitPrefix) && strings.HasSuffix(f[0], ".scope") {
			units = append(units, f[0])
		}
	}
	if len(units) == 0 {
		return
	}
	log.Printf("sandbox: reaping %d orphaned workload scope(s) from a prior daemon: %s", len(units), strings.Join(units, " "))
	_ = exec.CommandContext(ctx, systemctlPath, append([]string{"--user", "stop"}, units...)...).Run()
}
