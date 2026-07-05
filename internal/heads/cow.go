package heads

import (
	"log"
	"os"
	"path/filepath"
	"strings"

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

// cowDirName turns a worktree-relative path into a single flat directory name
// for the COW layer storage (e.g. "pipeline/out" -> "pipeline_out").
func cowDirName(rel string) string {
	return strings.ReplaceAll(filepath.Clean(rel), string(os.PathSeparator), "_")
}

// isHomeOrAbs reports whether a cow_paths entry is home-anchored or absolute
// (rather than worktree-relative): a leading "~", an absolute path, or a
// "$VAR"-prefixed path. These are expanded against HOME/the environment exactly
// like the other sandbox path lists (writable/masked/restore) and overlaid at
// that same path (lower == dest), instead of being mirrored from the project
// root into the worktree.
func isHomeOrAbs(p string) bool {
	return p == "~" || strings.HasPrefix(p, "~/") || filepath.IsAbs(p) || strings.HasPrefix(p, "$")
}

// buildCowMounts resolves the configured cow_paths into sandbox.CowMount specs
// and creates the host directories they need.
//
// An entry is interpreted by the same path convention the other sandbox lists
// use (see isHomeOrAbs):
//   - Worktree-relative (e.g. "pipeline/out"): the read-only source (Lower) is
//     the same path under the project root and the mountpoint (Dest) is that path
//     inside the worktree.
//   - Home/absolute (e.g. "~/.gradle", "/opt/cache"): expanded against HOME and
//     overlaid in place, so Lower == Dest == the resolved path. Reads hit the
//     shared real dir; per-head writes copy up to the upper. On Linux this
//     overlay supersedes any default writable --bind on the same target (see
//     linux.go) - the two cannot coexist.
//
// When writable, each mount also gets a persistent per-head Upper/Work pair so
// the agent can overwrite the files with the writes kept out of the real tree.
// When not writable (bash shells, which share the worktree with a possibly-live
// agent - two overlays must never share one upperdir), Upper/Work are left empty
// so the sandbox layer exposes the source read-only instead.
//
// Entries whose source is missing, or a worktree-relative entry that escapes the
// project root via "..", are skipped with a warning.
func buildCowMounts(projectRoot, worktreePath, home, id string, cowPaths []string, writable bool) []sandbox.CowMount {
	var mounts []sandbox.CowMount
	base := cowBaseDir(projectRoot, id)
	// Drop a "*" .gitignore in .hydra/local/cow so the per-head upper/work layers
	// (which live inside the project root) never show up in the project's git status.
	// Best-effort; matches how worktrees/artifacts/uploads self-ignore.
	if len(cowPaths) > 0 {
		if err := paths.EnsureHydraLocalIgnored(filepath.Dir(base)); err != nil {
			log.Printf("warn: cow_paths: create .gitignore in %s: %v", filepath.Dir(base), err)
		}
	}
	for _, p := range cowPaths {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" || trimmed == "." {
			continue
		}
		var lower, dest, layerName string
		if isHomeOrAbs(trimmed) {
			// Home/absolute overlay: lower == dest == the resolved path itself.
			abs := sandbox.ExpandPath(trimmed, home)
			if !filepath.IsAbs(abs) {
				log.Printf("warn: cow_paths: skipping %q (does not resolve to an absolute path)", p)
				continue
			}
			lower, dest = abs, abs
			layerName = cowDirName(abs)
		} else {
			rel := filepath.Clean(trimmed)
			if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
				log.Printf("warn: cow_paths: skipping %q (relative path must stay inside the worktree)", p)
				continue
			}
			lower = filepath.Join(projectRoot, rel)
			dest = filepath.Join(worktreePath, rel)
			layerName = cowDirName(rel)
		}
		if _, err := os.Stat(lower); err != nil {
			log.Printf("warn: cow_paths: skipping %q (source %s does not exist)", p, lower)
			continue
		}
		// A worktree-relative mountpoint may not exist yet, so create it. For a
		// home/absolute mount dest == lower, which we just confirmed exists - never
		// mkdir the real home path.
		if dest != lower {
			if err := os.MkdirAll(dest, 0o755); err != nil {
				log.Printf("warn: cow_paths: skipping %q (create mountpoint %s: %v)", p, dest, err)
				continue
			}
		}
		m := sandbox.CowMount{Lower: lower, Dest: dest}
		if writable {
			layer := filepath.Join(base, layerName)
			upper := filepath.Join(layer, "upper")
			work := filepath.Join(layer, "work")
			if err := os.MkdirAll(upper, 0o755); err != nil {
				log.Printf("warn: cow_paths: skipping %q (create upper %s: %v)", p, upper, err)
				continue
			}
			if err := os.MkdirAll(work, 0o755); err != nil {
				log.Printf("warn: cow_paths: skipping %q (create work %s: %v)", p, work, err)
				continue
			}
			m.Upper = upper
			m.Work = work
		}
		mounts = append(mounts, m)
	}
	return mounts
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
