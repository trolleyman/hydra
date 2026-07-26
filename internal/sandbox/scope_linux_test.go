//go:build linux

package sandbox

import (
	"reflect"
	"testing"
)

// withControllers sets the per-controller delegation flags for the duration of a
// test and restores them after, so allProps can be exercised as a pure function
// regardless of what the host's user manager actually delegates.
func withControllers(t *testing.T, cpu, io, memory, pids bool) {
	t.Helper()
	oc, oi, om, op := cpuOK, ioOK, memoryOK, pidsOK
	cpuOK, ioOK, memoryOK, pidsOK = cpu, io, memory, pids
	t.Cleanup(func() { cpuOK, ioOK, memoryOK, pidsOK = oc, oi, om, op })
}

func TestAllProps(t *testing.T) {
	limits := ScopeLimits{CPUWeight: 30, IOWeight: 40, CPUQuota: 200, MemoryMax: 2048, TasksMax: 512}

	// All controllers delegated: every set field emits its property.
	withControllers(t, true, true, true, true)
	got := allProps(limits)
	want := []string{
		"--property=CPUWeight=30",
		"--property=CPUQuota=200%",
		"--property=IOWeight=40",
		"--property=MemoryMax=2048M",
		"--property=TasksMax=512",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("allProps (all delegated):\n got %v\nwant %v", got, want)
	}
}

func TestAllPropsOmitsUnset(t *testing.T) {
	withControllers(t, true, true, true, true)
	// A field <= 0 emits nothing; a zero-value ScopeLimits emits no properties.
	if got := allProps(ScopeLimits{}); len(got) != 0 {
		t.Errorf("zero ScopeLimits: want no props, got %v", got)
	}
	got := allProps(ScopeLimits{CPUWeight: 50, MemoryMax: 1024})
	want := []string{"--property=CPUWeight=50", "--property=MemoryMax=1024M"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("partial ScopeLimits:\n got %v\nwant %v", got, want)
	}
}

func TestAllPropsDropsUndelegatedControllers(t *testing.T) {
	limits := ScopeLimits{CPUWeight: 30, IOWeight: 40, CPUQuota: 200, MemoryMax: 2048, TasksMax: 512}
	// cpu + io not delegated: their properties (CPUWeight/CPUQuota/IOWeight) are
	// dropped so systemd-run never rejects the whole spawn; memory/pids survive.
	withControllers(t, false, false, true, true)
	got := allProps(limits)
	want := []string{"--property=MemoryMax=2048M", "--property=TasksMax=512"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("allProps (cpu/io undelegated):\n got %v\nwant %v", got, want)
	}
}
