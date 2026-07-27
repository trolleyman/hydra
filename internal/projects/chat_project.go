package projects

import (
	"fmt"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// ChatProjectID is the fixed project ID of the built-in chat project.
//
// The leading underscore is load-bearing: sanitizeID maps every non-alphanumeric
// character to a hyphen and trims hyphens from both ends, so a *generated* ID
// always matches [a-z0-9-] with no leading hyphen. An underscore is therefore
// unreachable by the generator, which makes this ID collision-proof by
// construction rather than by a reserved-names list. See docs/chat-project.md.
const ChatProjectID = "_chat"

// ChatProjectName is the display name of the built-in chat project.
const ChatProjectName = "Chat"

// chatProjectIcon is seeded into the project's config.toml so it gets a real
// glyph instead of the default hashed letter box - which, for an ID starting
// with "_", would render a coloured square containing an underscore.
const chatProjectIcon = "MessageSquare"

const chatReadme = `# Chat

This is Hydra's built-in chat project - a real git repository that Hydra created
and owns, so you can start a conversation without pointing Hydra at one of your
repos first.

Each conversation you start here becomes a branch, exactly like a head in any
other project. Anything you or an agent writes is yours to keep; merging a head
back into this branch archives that conversation's files.

Hydra recreates this repository if you delete it, but it will not touch commits
you have made.
`

// chatConfigTOML is the seeded .hydra/config.toml. Written once, at creation, so
// changing the icon later (Settings -> project icon) is never clobbered.
const chatConfigTOML = `# Hydra's built-in chat project.
# This is an ordinary project config - edit it like any other.
icon = "` + chatProjectIcon + `"
`

// ChatPath returns the directory holding the built-in chat repository:
// $XDG_DATA_HOME/hydra/chat, defaulting to ~/.local/share/hydra/chat.
//
// It lives under the *data* dir rather than state or cache because it holds
// notes the user writes and may want backed up; only Hydra's own bookkeeping
// (projects.json, the instance UUID) belongs in the config dir.
func ChatPath() (string, error) {
	if dir := os.Getenv("XDG_DATA_HOME"); dir != "" {
		return filepath.Join(dir, "hydra", "chat"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get home dir: %w", err))
	}
	return filepath.Join(home, ".local", "share", "hydra", "chat"), nil
}

// EnsureChatProject creates the chat repository if it is missing and registers
// it under ChatProjectID, returning the registered project.
//
// It is idempotent and safe to call on every boot. It must run *before* the
// server starts serving: every route and endpoint resolves a project through
// GetByID, so a lazily-created chat project would 404 against its own URL on
// first navigation.
func (m *Manager) EnsureChatProject() (ProjectInfo, error) {
	path, err := ChatPath()
	if err != nil {
		return ProjectInfo{}, errtrace.Wrap(err)
	}
	if err := ensureChatRepo(path); err != nil {
		return ProjectInfo{}, errtrace.Wrap(err)
	}
	if norm, err := NormalizePath(path); err == nil {
		path = norm
	}
	return errtrace.Wrap2(m.upsertBuiltin(ChatProjectID, path, ChatProjectName))
}

// ensureChatRepo makes path a git repository with at least one commit. An
// existing repository is left alone apart from the unborn-HEAD case, so a user's
// own commits and working tree are never disturbed.
func ensureChatRepo(path string) error {
	if err := git.InitRepo(path); err != nil {
		return errtrace.Wrap(err)
	}
	if git.HasCommits(path) {
		return nil
	}
	// A freshly initialised repo has an unborn HEAD, and `git worktree add`
	// cannot branch from that - so no head could ever spawn here without this.
	if err := writeIfMissing(filepath.Join(path, "README.md"), chatReadme); err != nil {
		return errtrace.Wrap(err)
	}
	cfg := filepath.Join(path, ".hydra", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfg), 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create .hydra dir: %w", err))
	}
	if err := writeIfMissing(cfg, chatConfigTOML); err != nil {
		return errtrace.Wrap(err)
	}
	if err := git.CommitAll(path, "Initialise Hydra chat project"); err != nil {
		return errtrace.Wrap(err)
	}
	return nil
}

// writeIfMissing writes content to path only when nothing is there yet.
func writeIfMissing(path, content string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return errtrace.Wrap(fmt.Errorf("write %s: %w", filepath.Base(path), err))
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
	changed := false

	// Drop built-ins left behind by an older release under a different ID (i.e.
	// the built-in was renamed). Without this the stale entry keeps its Builtin
	// flag and shows up as a second pinned row pointing at an abandoned dir.
	kept := m.projects[:0]
	for _, existing := range m.projects {
		if existing.Builtin && existing.ID != id {
			changed = true
			continue
		}
		kept = append(kept, existing)
	}
	m.projects = kept

	// Adopt any existing entry for this ID or path. The path case covers a user
	// who registered the directory by hand before it became built-in: rewriting
	// the entry in place is better than ending up with two.
	found := false
	for i := range m.projects {
		if m.projects[i].ID == id || paths.ComparePaths(m.projects[i].Path, path) {
			found = true
			if m.projects[i] != p {
				m.projects[i] = p
				changed = true
			}
			break
		}
	}
	if !found {
		m.projects = append(m.projects, p)
		changed = true
	}

	if changed {
		if err := m.save(); err != nil {
			return ProjectInfo{}, errtrace.Wrap(err)
		}
	}
	return p, nil
}

// HasUserProjects reports whether the user has registered any project of their
// own. Built-ins do not count: the chat project always exists, so a bare
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
