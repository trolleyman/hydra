package sandbox

import (
	"hash/fnv"
	"strconv"
	"strings"

	"github.com/trolleyman/hydra/internal/statepath"
)

const (
	productionScopeUnitPrefix = "hydra-"
	instanceScopeUnitPrefix   = "hydra-instance-"
)

// scopeUnitPrefix namespaces every transient unit by state root so one
// development daemon cannot stop or reuse another daemon's live scopes.
func scopeUnitPrefix() string {
	namespace := statepath.RuntimeIsolationKey()
	if namespace == "" {
		return productionScopeUnitPrefix
	}
	return instanceScopeUnitPrefix + ScopeHash(namespace) + "-"
}

func scopeBelongsToCurrentInstance(unit string) bool {
	prefix := scopeUnitPrefix()
	if prefix == productionScopeUnitPrefix {
		return strings.HasPrefix(unit, prefix) && !strings.HasPrefix(unit, instanceScopeUnitPrefix)
	}
	return strings.HasPrefix(unit, prefix)
}

// ScopeCPUWeight and ScopeIOWeight are the default relative cgroup weights
// applied to a workload scope when its project's config leaves them unset. They
// sit below systemd's default of 100 so the daemon and interactive work win
// CPU/IO under contention - a runaway sandbox (e.g. a screenshot render spinning
// up headless Chrome) yields instead of starving the box. Weights are soft: they
// only bite under contention, so idle capacity is still fully usable. Per-project
// config (see the config package's ResolveResourceLimits, which fills these
// defaults into a ScopeLimits) overrides them; 0 disables the respective
// property. They are read when a scope is created.
var (
	ScopeCPUWeight = 50
	ScopeIOWeight  = 50
)

const (
	// Conservative per-scope ceilings. Parent slices add aggregate ceilings, so
	// several individually compliant workloads cannot multiply past the machine
	// budget.
	DefaultWorkloadIOReadBandwidthMax  = 80
	DefaultWorkloadIOWriteBandwidthMax = 40

	DefaultMachineIOReadBandwidthMax     = 160
	DefaultMachineIOWriteBandwidthMax    = 80
	DefaultBackgroundIOReadBandwidthMax  = 80
	DefaultBackgroundIOWriteBandwidthMax = 40
)

// ScopeClass selects the aggregate slice a workload belongs to. Every scope is
// placed under hydra.slice; background scopes are placed in its tighter
// hydra-background.slice child.
type ScopeClass uint8

const (
	ScopeInteractive ScopeClass = iota
	ScopeBackground
)

// AggregateLimits are the machine-wide ceilings applied to the parent Hydra
// slices. They are configured separately from per-workload ScopeLimits because
// one daemon serves many projects and only user config may set machine policy.
type AggregateLimits struct {
	MachineCPUQuota, MachineIOReadBandwidthMax, MachineIOWriteBandwidthMax          int
	BackgroundCPUQuota, BackgroundIOReadBandwidthMax, BackgroundIOWriteBandwidthMax int
}

func DefaultAggregateLimits(logicalCPUs int) AggregateLimits {
	return AggregateLimits{
		MachineCPUQuota:               DefaultMachineCPUQuota(logicalCPUs),
		MachineIOReadBandwidthMax:     DefaultMachineIOReadBandwidthMax,
		MachineIOWriteBandwidthMax:    DefaultMachineIOWriteBandwidthMax,
		BackgroundCPUQuota:            DefaultBackgroundCPUQuota(logicalCPUs),
		BackgroundIOReadBandwidthMax:  DefaultBackgroundIOReadBandwidthMax,
		BackgroundIOWriteBandwidthMax: DefaultBackgroundIOWriteBandwidthMax,
	}
}

// DefaultWorkloadCPUQuota allows about half of a small machine, capped at four
// logical CPUs so one workload cannot saturate a large workstation.
func DefaultWorkloadCPUQuota(logicalCPUs int) int {
	return clampCPUQuota(logicalCPUs*50, 100, 400)
}

// DefaultMachineCPUQuota is the aggregate Hydra ceiling: half the host's
// logical CPUs, capped at sixteen logical CPUs.
func DefaultMachineCPUQuota(logicalCPUs int) int {
	return clampCPUQuota(logicalCPUs*50, 100, 1600)
}

// DefaultBackgroundCPUQuota is shared by every test and artifact: one quarter
// of the host, capped at four logical CPUs.
func DefaultBackgroundCPUQuota(logicalCPUs int) int {
	return clampCPUQuota(logicalCPUs*25, 100, 400)
}

func clampCPUQuota(value, minValue, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

// ScopeLimits are the resolved cgroup resource limits for one workload scope,
// threaded per call site (one daemon serves many projects, so limits cannot be a
// process-global). Config resolves a project's [resources] table into this; the
// sandbox package never reads config, keeping the dependency one-directional.
//
// Weights are soft (only bite under contention); the caps are hard ceilings even
// on an idle box. A field <= 0 means "don't emit that property" - the workload
// inherits no limit for it. A zero-value ScopeLimits therefore emits nothing,
// matching the pre-config behaviour of an unwrapped scope; ResolveResourceLimits
// bakes the weight defaults in so a normal spawn still gets 50/50.
type ScopeLimits struct {
	CPUWeight int // CPUWeight= (1-10000); <=0 omits
	IOWeight  int // IOWeight= (1-10000); <=0 omits
	CPUQuota  int // CPUQuota=<n>% hard cap (200 = 2 cores); <=0 omits
	MemoryMax int // MemoryMax=<n>M hard cap in MB; <=0 omits
	TasksMax  int // TasksMax=<n> process/thread cap; <=0 omits

	// IOPath names the filesystem the bandwidth caps below apply to - systemd
	// resolves it to the backing block device, so it is a plain path (the project
	// root) rather than a device node. Empty drops both caps: io.max is per-device
	// and there is nothing sane to guess.
	IOPath string
	// IOReadBandwidthMax / IOWriteBandwidthMax are hard throughput ceilings in
	// MB/s (systemd IOReadBandwidthMax=/IOWriteBandwidthMax=, i.e. cgroup io.max).
	// <=0 omits.
	//
	// These exist because IOWeight often does nothing. Weight-based IO control is
	// implemented by BFQ or by blk-iocost; on a machine whose NVMe uses the `none`
	// scheduler with iocost unconfigured - a common default - systemd writes
	// io.weight, the kernel accepts it, and it has no effect whatsoever. io.max is
	// blk-throttle, which works on any scheduler with no host setup, so it is the
	// only ceiling that reliably bites. Nothing can detect the inert case from the
	// property being accepted, which is why weights alone are not enough.
	IOReadBandwidthMax  int
	IOWriteBandwidthMax int
}

// ScopeUnit builds the transient scope unit name for a workload kind + id, e.g.
// ScopeUnit("preview", "my-head") -> "hydra-preview-my-head-2f3a1b9c.scope". Pass
// an empty kind for the agent itself -> "hydra-my-head-2f3a1b9c.scope".
//
// The trailing ScopeHash is what makes the name injective. sanitizeUnit is lossy
// (every character systemd disallows collapses to '_'), so distinct ids can
// sanitize to the same name - `foo@shell` (a head's shell slot, see
// heads.SlotSep) and a head explicitly named `foo_shell` both yield `foo_shell`.
// That matters because a same-named unit is not merely confusing: WrapScope
// calls StopScope(unit) first to clear a stale unit from a prior life, so one
// workload starting would tear down the other's *live* cgroup. Hashing the
// unsanitized id keeps the readable name and makes the collision impossible.
func ScopeUnit(kind, id string) string {
	name := scopeUnitPrefix()
	if kind != "" {
		name += kind + "-"
	}
	return name + sanitizeUnit(id) + "-" + ScopeHash(id) + ".scope"
}

// ScopeHash returns a short stable token for s, for use in a scope id that must
// stay bounded and systemd-safe (e.g. a project root path or an on-disk artifact
// dir). Not cryptographic - only needs to avoid collisions between concurrently
// live workloads.
func ScopeHash(s string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return strconv.FormatUint(uint64(h.Sum32()), 16)
}

// sanitizeUnit maps an id to the characters systemd allows in a unit name.
func sanitizeUnit(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			return r
		default:
			return '_'
		}
	}, s)
}
