package git

import "strings"

// Branch-name conventions for Hydra heads.
//
// Each head has a public, user-facing branch named `hydra/<id>`. The
// `hydra-wt/<id>` namespace is reserved for the internal branch a head's
// worktree checks out once the branch-split/mirror design lands (see
// USER_BRANCH_PLAN.md); it is deliberately outside the `hydra/` namespace so
// that every `hydra/*` glob and prefix check keeps meaning "one public branch
// per head" and does not double-match the internal branch.
const (
	// BranchPrefix is the ref-name prefix for a head's public branch.
	BranchPrefix = "hydra/"
	// WorktreeBranchPrefix is the ref-name prefix for a head's internal
	// worktree branch (branch-split design; not yet used at runtime).
	WorktreeBranchPrefix = "hydra-wt/"
)

// BranchName returns the public, user-facing branch name for a head id.
func BranchName(id string) string {
	return BranchPrefix + id
}

// WorktreeBranchName returns the internal worktree branch name for a head id.
func WorktreeBranchName(id string) string {
	return WorktreeBranchPrefix + id
}

// IsAgentBranch reports whether name is a head's public branch (`hydra/*`).
// It does NOT match internal worktree branches (`hydra-wt/*`).
func IsAgentBranch(name string) bool {
	return strings.HasPrefix(name, BranchPrefix)
}

// AgentIDFromBranch returns the head id encoded in a public branch name and
// whether name was a public branch. The id is empty when ok is false.
func AgentIDFromBranch(name string) (id string, ok bool) {
	return strings.CutPrefix(name, BranchPrefix)
}
