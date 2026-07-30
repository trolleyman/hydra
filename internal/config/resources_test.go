package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func iptr(i int) *int { return &i }

// TestResourceLimitsMerge checks per-field last-wins layering: a later layer
// overrides only the fields it sets, leaving the rest inherited (NOT union).
func TestResourceLimitsMerge(t *testing.T) {
	base := ResourceLimits{CPUWeight: iptr(50), IOWeight: iptr(50), MemoryMax: iptr(1024)}
	base.Merge(ResourceLimits{CPUWeight: iptr(20), TasksMax: iptr(256)})

	if base.CPUWeight == nil || *base.CPUWeight != 20 {
		t.Errorf("CPUWeight: want overridden 20, got %v", base.CPUWeight)
	}
	if base.IOWeight == nil || *base.IOWeight != 50 {
		t.Errorf("IOWeight: want inherited 50, got %v", base.IOWeight)
	}
	if base.MemoryMax == nil || *base.MemoryMax != 1024 {
		t.Errorf("MemoryMax: want inherited 1024, got %v", base.MemoryMax)
	}
	if base.TasksMax == nil || *base.TasksMax != 256 {
		t.Errorf("TasksMax: want added 256, got %v", base.TasksMax)
	}
	if base.CPUQuota != nil {
		t.Errorf("CPUQuota: want unset, got %v", base.CPUQuota)
	}
}

// TestConfigMergeResources checks the Config.Merge wiring: layering resources
// through Config (user -> project -> local) is per-field last-wins.
func TestConfigMergeResources(t *testing.T) {
	user := Config{Resources: &ResourceLimits{CPUWeight: iptr(50), IOWeight: iptr(50)}}
	project := Config{Resources: &ResourceLimits{MemoryMax: iptr(2048)}}
	local := Config{Resources: &ResourceLimits{CPUWeight: iptr(30)}}

	merged := user
	merged.Merge(project)
	merged.Merge(local)

	r := merged.Resources
	if r == nil {
		t.Fatal("merged resources is nil")
	}
	if r.CPUWeight == nil || *r.CPUWeight != 30 {
		t.Errorf("CPUWeight: want local override 30, got %v", r.CPUWeight)
	}
	if r.IOWeight == nil || *r.IOWeight != 50 {
		t.Errorf("IOWeight: want inherited 50, got %v", r.IOWeight)
	}
	if r.MemoryMax == nil || *r.MemoryMax != 2048 {
		t.Errorf("MemoryMax: want project 2048, got %v", r.MemoryMax)
	}
}

// TestResolveResourceLimits checks safe built-in caps are filled while explicit
// values (including zero to opt out) win.
func TestResolveResourceLimits(t *testing.T) {
	// nil Resources: machine-scaled CPU plus conservative IO ceilings.
	got := Config{}.ResolveResourceLimits("/srv/proj")
	want := sandbox.ScopeLimits{
		CPUWeight:           sandbox.ScopeCPUWeight,
		IOWeight:            sandbox.ScopeIOWeight,
		CPUQuota:            sandbox.DefaultWorkloadCPUQuota(runtime.NumCPU()),
		IOPath:              "/srv/proj",
		IOReadBandwidthMax:  sandbox.DefaultWorkloadIOReadBandwidthMax,
		IOWriteBandwidthMax: sandbox.DefaultWorkloadIOWriteBandwidthMax,
	}
	if got != want {
		t.Errorf("nil resources: got %+v, want %+v", got, want)
	}

	// Explicit values override defaults; caps come through; unset weight falls to
	// the default.
	got = Config{Resources: &ResourceLimits{
		CPUWeight:           iptr(20),
		CPUQuota:            iptr(200),
		MemoryMax:           iptr(2048),
		TasksMax:            iptr(512),
		IOReadBandwidthMax:  iptr(200),
		IOWriteBandwidthMax: iptr(100),
	}}.ResolveResourceLimits("/srv/proj")
	want = sandbox.ScopeLimits{
		CPUWeight:           20,
		IOWeight:            sandbox.ScopeIOWeight,
		CPUQuota:            200,
		MemoryMax:           2048,
		TasksMax:            512,
		IOPath:              "/srv/proj",
		IOReadBandwidthMax:  200,
		IOWriteBandwidthMax: 100,
	}
	if got != want {
		t.Errorf("explicit resources: got %+v, want %+v", got, want)
	}

	// An explicit zero remains the opt-out spelling at any config layer.
	got = Config{Resources: &ResourceLimits{
		CPUQuota:            iptr(0),
		IOReadBandwidthMax:  iptr(0),
		IOWriteBandwidthMax: iptr(0),
	}}.ResolveResourceLimits("/srv/proj")
	if got.CPUQuota != 0 || got.IOReadBandwidthMax != 0 || got.IOWriteBandwidthMax != 0 {
		t.Errorf("explicit zero should disable defaults, got %+v", got)
	}
}

func TestResolveAggregateResourceLimits(t *testing.T) {
	got := (Config{}).ResolveAggregateResourceLimits()
	want := sandbox.DefaultAggregateLimits(runtime.NumCPU())
	if got != want {
		t.Fatalf("defaults got %+v, want %+v", got, want)
	}

	got = (Config{Resources: &ResourceLimits{
		MachineCPUQuota:              iptr(800),
		MachineIOWriteBandwidthMax:   iptr(0),
		BackgroundIOReadBandwidthMax: iptr(25),
	}}).ResolveAggregateResourceLimits()
	if got.MachineCPUQuota != 800 || got.MachineIOWriteBandwidthMax != 0 ||
		got.BackgroundIOReadBandwidthMax != 25 {
		t.Fatalf("overrides not retained: %+v", got)
	}
	if got.BackgroundCPUQuota != want.BackgroundCPUQuota {
		t.Fatalf("unset field lost default: %+v", got)
	}
}

// TestRenderConfigEmitsResources verifies renderConfig writes a real [resources]
// table from cfg.Resources (only the set fields) and that it reloads to the same
// values - the round-trip the Settings resource-limits editor relies on.
func TestRenderConfigEmitsResources(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	cfg := Config{Resources: &ResourceLimits{
		CPUWeight: iptr(30),
		MemoryMax: iptr(2048),
	}}
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "[resources]") || !strings.Contains(got, "cpu_weight = 30") {
		t.Fatalf("expected a real [resources] table, got:\n%s", got)
	}
	if !strings.Contains(got, "memory_max = 2048") {
		t.Errorf("expected memory_max = 2048, got:\n%s", got)
	}
	// A field left nil must not be written (so it keeps inheriting the layer below).
	if strings.Contains(got, "tasks_max =") || strings.Contains(got, "cpu_quota =") {
		t.Errorf("unset fields should not be emitted:\n%s", got)
	}

	reloaded, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Resources == nil {
		t.Fatal("reloaded resources is nil")
	}
	if reloaded.Resources.CPUWeight == nil || *reloaded.Resources.CPUWeight != 30 {
		t.Errorf("reloaded CPUWeight: want 30, got %v", reloaded.Resources.CPUWeight)
	}
	if reloaded.Resources.MemoryMax == nil || *reloaded.Resources.MemoryMax != 2048 {
		t.Errorf("reloaded MemoryMax: want 2048, got %v", reloaded.Resources.MemoryMax)
	}
	if reloaded.Resources.TasksMax != nil {
		t.Errorf("reloaded TasksMax: want unset, got %v", reloaded.Resources.TasksMax)
	}
}
