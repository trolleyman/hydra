package sandbox

import (
	"hash/fnv"
	"strconv"
	"strings"
)

// scopeUnitPrefix namespaces every transient unit we create so SweepOrphanScopes
// can find our leftovers without touching unrelated user scopes.
const scopeUnitPrefix = "hydra-"

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
}

// ScopeUnit builds the transient scope unit name for a workload kind + id, e.g.
// ScopeUnit("preview", "my-head") -> "hydra-preview-my-head.scope". Pass an empty
// kind for the agent itself -> "hydra-my-head.scope".
func ScopeUnit(kind, id string) string {
	name := scopeUnitPrefix
	if kind != "" {
		name += kind + "-"
	}
	return name + sanitizeUnit(id) + ".scope"
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
