package sandbox

import (
	"log"
	"os"
	"path/filepath"
	"strings"
)

// cowDirName turns a path into a single flat directory name for COW layer storage
// (e.g. "pipeline/out" -> "pipeline_out"), so each mount's upper/work layers get a
// distinct subdir under the layer base.
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

// ResolveCowMounts turns the configured cow_paths into [CowMount] specs and
// creates the host directories they need. It is the shared core behind both a
// head's live-session mounts and an artifact generation's mounts; the caller
// supplies layerBase (where per-mount upper/work layers are created) so each use
// keeps its layers in its own area.
//
// An entry is interpreted by the same path convention the other sandbox lists
// use (see isHomeOrAbs):
//   - Worktree-relative (e.g. "pipeline/out"): the read-only source (Lower) is
//     the same path under projectRoot and the mountpoint (Dest) is that path
//     inside worktreePath.
//   - Home/absolute (e.g. "~/.gradle", "/opt/cache"): expanded against home and
//     overlaid in place, so Lower == Dest == the resolved path. Reads hit the
//     shared real dir; writes copy up to the upper. On Linux this overlay
//     supersedes any default writable --bind on the same target (see linux.go) -
//     the two cannot coexist.
//
// When writable, each mount also gets an Upper/Work pair under layerBase so the
// writes are kept out of the real tree. When not writable (e.g. bash shells that
// share a worktree with a possibly-live agent - two overlays must never share one
// upperdir), Upper/Work are left empty so the sandbox layer exposes the source
// read-only instead.
//
// Entries whose source is missing, or a worktree-relative entry that escapes the
// project root via "..", are skipped with a warning.
func ResolveCowMounts(projectRoot, worktreePath, home, layerBase string, cowPaths []string, writable bool) []CowMount {
	var mounts []CowMount
	for _, p := range cowPaths {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" || trimmed == "." {
			continue
		}
		var lower, dest, layerName string
		if isHomeOrAbs(trimmed) {
			// Home/absolute overlay: lower == dest == the resolved path itself.
			abs := ExpandPath(trimmed, home)
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
		m := CowMount{Lower: lower, Dest: dest}
		if writable {
			layer := filepath.Join(layerBase, layerName)
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
