//go:build linux

package sandbox

import (
	"bufio"
	"bytes"
	"context"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Transient systemd user scopes wrap each sandboxed workload (agent, preview,
// service, artifact) so its whole process subtree lives in its own cgroup with a
// single kill handle (StopScope) and can't escape by reparenting to systemd when
// the daemon dies. The per-workload cgroup also carries relative CPU/IO weights
// (see ScopeCPUWeight/ScopeIOWeight) so runaway workloads yield to the daemon.
//
// Best-effort: where the user has no systemd session manager the wrapper is
// skipped and the workload runs directly (callers keep the unwrapped spec as a
// fallback). Where scopes work but the cpu/io controllers aren't delegated to the
// user manager, we keep the scope (still useful for reaping) but drop the weight
// properties, so a spawn never fails just because a controller is missing.

var (
	scopeOnce      sync.Once
	scopeOK        bool // transient scopes work at all
	weightsOK      bool // scopes accept CPUWeight/IOWeight properties
	systemdRunPath string
	systemctlPath  string
)

// ScopesAvailable reports (and caches) whether transient systemd user scopes work
// on this host. It runs throwaway no-op scopes once - first with the weight
// properties, then without - so a broken user manager or an undelegated
// controller is caught at detection time rather than when a real workload spawns.
func ScopesAvailable() bool {
	scopeOnce.Do(func() {
		sr, err1 := exec.LookPath("systemd-run")
		sc, err2 := exec.LookPath("systemctl")
		if err1 != nil || err2 != nil {
			return
		}
		systemdRunPath, systemctlPath = sr, sc
		if probeScope(sr, weightProps()...) {
			scopeOK, weightsOK = true, true
			return
		}
		if probeScope(sr) {
			scopeOK = true
			log.Printf("sandbox: systemd scopes work but CPU/IO weight properties were rejected (cpu/io controllers likely not delegated to the user manager); workloads will be reaped but not deprioritised")
			return
		}
		log.Printf("sandbox: systemd user scopes unavailable; workloads run unscoped")
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

// weightProps returns the --property flags for the configured CPU/IO weights.
func weightProps() []string {
	var p []string
	if ScopeCPUWeight > 0 {
		p = append(p, "--property=CPUWeight="+strconv.Itoa(ScopeCPUWeight))
	}
	if ScopeIOWeight > 0 {
		p = append(p, "--property=IOWeight="+strconv.Itoa(ScopeIOWeight))
	}
	return p
}

// WrapScope rewrites spec to run under the transient systemd user scope named
// unit, so its process subtree gets its own cgroup, weight limits and a single
// kill handle. Returns true if the spec was wrapped; false (spec untouched) when
// scopes are unavailable. Any stale unit of the same name is cleared first so
// systemd-run can't fail with "unit already exists".
func WrapScope(unit string, spec *Spec) bool {
	if !ScopesAvailable() {
		return false
	}
	StopScope(unit) // clear a stale same-named unit left by a prior life

	wrapped := []string{systemdRunPath, "--user", "--scope", "--quiet", "--collect", "--unit=" + unit}
	if weightsOK {
		wrapped = append(wrapped, weightProps()...)
	}
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
