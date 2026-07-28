package sandbox

import (
	"os"
	"path/filepath"
	"strings"
)

// HydraignoreName is the .gitignore-style mask file at a project (or worktree)
// root: one glob per line, unioned into the sandbox mask set. It is the
// project-relative spelling of [sandbox] masked_paths, letting a project hide its
// own secret/personal files (`.env*`, `secrets/`, ...) from heads. Masks only ever
// ADD restriction, so honoring a head's own branch copy is safe - a branch can
// restrict itself further but can never unmask anything.
// See docs/non-local-integration.md.
const HydraignoreName = ".hydraignore"

// ProjectRelativeMaskDefaults are shipped mask entries resolved against the
// project root (not $HOME): per-machine secret/state files Hydra itself creates
// and must never let a head read. They are the project-relative analog of the
// home-anchored defaults (~/.ssh, ...). Absent files cost nothing (the builder
// stats and skips them). Mirrored in the gate's credentialRels.
var ProjectRelativeMaskDefaults = []string{
	".hydra/deploy.toml",
	".hydra/config.local.toml",
}

// ResolveMaskedPaths expands the config-resolved mask list into the concrete list
// assigned to Options.MaskedPaths for a head. It:
//   - passes home/absolute entries through unchanged (the sandbox builder expands
//     them against $HOME, exactly as before);
//   - resolves project-relative entries (and simple globs) against the project
//     root and the head's worktree into absolute paths;
//   - adds the shipped ProjectRelativeMaskDefaults;
//   - unions in each line of .hydraignore at projectRoot and worktreePath.
//
// worktreePath may be "" or equal to projectRoot (then only projectRoot is used).
// This mirrors the dual home/absolute-vs-project-relative convention cow_paths
// already has (see isHomeOrAbs). Entries that escape their base via ".." are
// dropped. Result order is stable and de-duplicated.
func ResolveMaskedPaths(projectRoot, worktreePath string, configMasks []string) []string {
	homeAbs := make([]string, 0, len(configMasks))
	var projRel []string
	for _, m := range configMasks {
		t := strings.TrimSpace(m)
		if t == "" {
			continue
		}
		if isHomeOrAbs(t) {
			homeAbs = append(homeAbs, t)
		} else {
			projRel = append(projRel, t)
		}
	}
	projRel = append(projRel, ProjectRelativeMaskDefaults...)

	bases := maskBases(projectRoot, worktreePath)
	for _, base := range bases {
		projRel = append(projRel, readHydraignore(filepath.Join(base, HydraignoreName))...)
	}

	out := make([]string, 0, len(homeAbs)+len(projRel)*len(bases))
	seen := make(map[string]struct{}, cap(out))
	add := func(p string) {
		if p == "" {
			return
		}
		if _, ok := seen[p]; ok {
			return
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	for _, p := range homeAbs {
		add(p)
	}
	for _, base := range bases {
		for _, rel := range projRel {
			for _, abs := range resolveMaskEntry(base, rel) {
				add(abs)
			}
		}
	}
	return out
}

// maskBases returns the roots project-relative mask entries resolve against: the
// real project root (where Hydra's per-machine secret files live, readable by a
// head via host read access) and the head's worktree (a branch's own tracked
// secrets), deduped and dropping empties.
func maskBases(projectRoot, worktreePath string) []string {
	bases := make([]string, 0, 2)
	if projectRoot != "" {
		bases = append(bases, projectRoot)
	}
	if worktreePath != "" && worktreePath != projectRoot {
		bases = append(bases, worktreePath)
	}
	return bases
}

// resolveMaskEntry turns one project-relative mask entry into absolute paths under
// base. A glob (containing *, ?, or [) is expanded via filepath.Glob (only
// existing matches). A plain entry is joined as-is (the builder stats it, so a
// path that does not exist yet is simply skipped there). Entries that escape base
// via ".." are dropped.
func resolveMaskEntry(base, rel string) []string {
	clean := filepath.Clean(rel)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return nil
	}
	full := filepath.Join(base, clean)
	// Guard against a symlink-free escape (Join already cleaned "..").
	if r, err := filepath.Rel(base, full); err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return nil
	}
	if strings.ContainsAny(clean, "*?[") {
		matches, err := filepath.Glob(full)
		if err != nil {
			return nil
		}
		return matches
	}
	return []string{full}
}

// readHydraignore reads a .hydraignore file's glob lines, skipping blank lines and
// #-comments. A missing/unreadable file yields nil.
func readHydraignore(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var globs []string
	for line := range strings.SplitSeq(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		globs = append(globs, line)
	}
	return globs
}
