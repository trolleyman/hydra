package heads

import (
	"log"
	"os"
	"path/filepath"

	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// cowBaseDir is where a head's copy-on-write upper/work layers live: under the
// project's .hydra/local and keyed by head ID so writes persist across resumes and
// are cleaned up with the head. The .hydra/local/cow dir self-ignores via a "*"
// .gitignore (see buildCowMounts) so these layers never surface in git status.
func cowBaseDir(projectRoot, id string) string {
	return filepath.Join(paths.GetHydraLocalDirFromProjectRoot(projectRoot), "cow", id)
}

// buildCowMounts resolves a head's configured cow_paths into sandbox.CowMount
// specs, storing each mount's per-head upper/work layers under the head's
// cowBaseDir. It is a thin wrapper over sandbox.ResolveCowMounts (shared with
// artifact generation, see internal/artifacts) that adds the per-head layer
// location and the .gitignore that keeps those layers out of git status.
func buildCowMounts(projectRoot, worktreePath, home, id string, cowPaths []string, writable bool) []sandbox.CowMount {
	base := cowBaseDir(projectRoot, id)
	// Drop a "*" .gitignore in .hydra/local/cow so the per-head upper/work layers
	// (which live inside the project root) never show up in the project's git status.
	// Best-effort; matches how worktrees/artifacts/uploads self-ignore.
	if len(cowPaths) > 0 {
		if err := paths.EnsureHydraLocalIgnored(filepath.Dir(base)); err != nil {
			log.Printf("warn: cow_paths: create .gitignore in %s: %v", filepath.Dir(base), err)
		}
	}
	return sandbox.ResolveCowMounts(projectRoot, worktreePath, home, base, cowPaths, writable)
}

// removeCowDir deletes a head's copy-on-write layers. Best-effort; called during
// head teardown.
func removeCowDir(projectRoot, id string) {
	if projectRoot == "" || id == "" {
		return
	}
	if err := os.RemoveAll(cowBaseDir(projectRoot, id)); err != nil {
		log.Printf("warn: cow_paths: remove layers for %s: %v", id, err)
	}
}
