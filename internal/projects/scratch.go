package projects

import (
	"fmt"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// ScratchProjectID is the fixed project ID of the built-in scratch project.
//
// The leading underscore is load-bearing: sanitizeID maps every non-alphanumeric
// character to a hyphen and trims hyphens from both ends, so a *generated* ID
// always matches [a-z0-9-] with no leading hyphen. An underscore is therefore
// unreachable by the generator, which makes this ID collision-proof by
// construction rather than by a reserved-names list. See docs/scratch-project.md.
const ScratchProjectID = "_scratch"

// ScratchProjectName is the display name of the built-in scratch project.
const ScratchProjectName = "Scratch"

const scratchReadme = `# Scratch

This is Hydra's built-in scratch project - a real git repository that Hydra
created and owns, so you can start a conversation without pointing Hydra at one
of your repos first.

Each conversation you start here becomes a branch, exactly like a head in any
other project. Anything you or an agent writes is yours to keep; merging a head
back into this branch archives that conversation's files.

Hydra recreates this repository if you delete it, but it will not touch commits
you have made.
`

// ScratchPath returns the directory holding the built-in scratch repository:
// $XDG_DATA_HOME/hydra/scratch, defaulting to ~/.local/share/hydra/scratch.
//
// It lives under the *data* dir rather than state or cache because it holds
// notes the user writes and may want backed up; only Hydra's own bookkeeping
// (projects.json, the instance UUID) belongs in the config dir.
func ScratchPath() (string, error) {
	if dir := os.Getenv("XDG_DATA_HOME"); dir != "" {
		return filepath.Join(dir, "hydra", "scratch"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get home dir: %w", err))
	}
	return filepath.Join(home, ".local", "share", "hydra", "scratch"), nil
}

// EnsureScratchProject creates the scratch repository if it is missing and
// registers it under ScratchProjectID, returning the registered project.
//
// It is idempotent and safe to call on every boot. It must run *before* the
// server starts serving: every route and endpoint resolves a project through
// GetByID, so a lazily-created scratch project would 404 against its own URL on
// first navigation.
func (m *Manager) EnsureScratchProject() (ProjectInfo, error) {
	path, err := ScratchPath()
	if err != nil {
		return ProjectInfo{}, errtrace.Wrap(err)
	}
	if err := ensureScratchRepo(path); err != nil {
		return ProjectInfo{}, errtrace.Wrap(err)
	}
	if norm, err := NormalizePath(path); err == nil {
		path = norm
	}
	return errtrace.Wrap2(m.upsertBuiltin(ScratchProjectID, path, ScratchProjectName))
}

// ensureScratchRepo makes path a git repository with at least one commit.
// Existing repositories are left alone apart from the unborn-HEAD case, so a
// user's own commits and working tree are never disturbed.
func ensureScratchRepo(path string) error {
	if err := git.InitRepo(path); err != nil {
		return errtrace.Wrap(err)
	}
	if git.HasCommits(path) {
		return nil
	}
	// A freshly initialised repo has an unborn HEAD, and `git worktree add`
	// cannot branch from that - so no head could ever spawn here without this.
	readme := filepath.Join(path, "README.md")
	if _, err := os.Stat(readme); os.IsNotExist(err) {
		if err := os.WriteFile(readme, []byte(scratchReadme), 0644); err != nil {
			return errtrace.Wrap(fmt.Errorf("write scratch readme: %w", err))
		}
	}
	if err := git.CommitAll(path, "Initialise Hydra scratch project"); err != nil {
		return errtrace.Wrap(err)
	}
	return nil
}

// upsertBuiltin registers (or refreshes) a Hydra-owned project under a fixed ID.
// Unlike AddProject it never derives an ID from the folder name, so the built-in
// keeps its reserved ID and a user project can never be pushed off its own.
func (m *Manager) upsertBuiltin(id, path, name string) (ProjectInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	p := ProjectInfo{ID: id, Path: path, Name: name, Builtin: true}

	// Adopt any existing entry for this ID or path. The path case covers a user
	// who registered the scratch directory by hand before it became built-in:
	// rewriting the entry in place is better than ending up with two.
	for i := range m.projects {
		if m.projects[i].ID == id || paths.ComparePaths(m.projects[i].Path, path) {
			if m.projects[i] == p {
				return p, nil
			}
			prev := m.projects[i]
			m.projects[i] = p
			if err := m.save(); err != nil {
				m.projects[i] = prev
				return ProjectInfo{}, errtrace.Wrap(err)
			}
			return p, nil
		}
	}

	m.projects = append(m.projects, p)
	if err := m.save(); err != nil {
		m.projects = m.projects[:len(m.projects)-1]
		return ProjectInfo{}, errtrace.Wrap(err)
	}
	return p, nil
}

// HasUserProjects reports whether the user has registered any project of their
// own. Built-ins do not count: the scratch project always exists, so a bare
// len(List()) == 0 check would never again be true and first-run states would
// silently stop rendering.
func (m *Manager) HasUserProjects() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.projects {
		if !m.projects[i].Builtin {
			return true
		}
	}
	return false
}
