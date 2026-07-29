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
	withIOMax(t, cpu, io, io, memory, pids)
}

// withIOMax is withControllers with the per-device cap probe (ioMaxOK) set
// independently of IOWeight's, which is the combination that matters: the caps
// are the half that still works when weight-based control is inert.
func withIOMax(t *testing.T, cpu, io, ioMax, memory, pids bool) {
	t.Helper()
	oc, oi, ox, om, op := cpuOK, ioOK, ioMaxOK, memoryOK, pidsOK
	cpuOK, ioOK, ioMaxOK, memoryOK, pidsOK = cpu, io, ioMax, memory, pids
	t.Cleanup(func() { cpuOK, ioOK, ioMaxOK, memoryOK, pidsOK = oc, oi, ox, om, op })
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

// The bandwidth caps are per-device, so they only emit with a path to resolve.
func TestAllPropsIOBandwidthCaps(t *testing.T) {
	withControllers(t, true, true, true, true)
	limits := ScopeLimits{IOPath: "/srv/proj", IOReadBandwidthMax: 200, IOWriteBandwidthMax: 100}
	got := allProps(limits)
	want := []string{
		"--property=IOReadBandwidthMax=/srv/proj 200M",
		"--property=IOWriteBandwidthMax=/srv/proj 100M",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("bandwidth caps:\n got %v\nwant %v", got, want)
	}

	// No path: nothing to resolve to a device, so both caps are dropped rather
	// than emitted against a guess.
	if got := allProps(ScopeLimits{IOReadBandwidthMax: 200, IOWriteBandwidthMax: 100}); len(got) != 0 {
		t.Errorf("caps without a path: want none, got %v", got)
	}
}

// The whole point of the caps is that they survive where IOWeight does not, so
// the two must not share a gate.
func TestAllPropsCapsSurviveWithoutIOWeight(t *testing.T) {
	limits := ScopeLimits{IOWeight: 40, IOPath: "/srv/proj", IOWriteBandwidthMax: 100}
	withIOMax(t, false, false, true, false, false)
	got := allProps(limits)
	want := []string{"--property=IOWriteBandwidthMax=/srv/proj 100M"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("caps without IOWeight:\n got %v\nwant %v", got, want)
	}
}
