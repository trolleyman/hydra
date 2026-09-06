package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(sandboxRemoveCmd)
}

// sandboxRemoveCmd gives a Hydra-confined agent a safe spelling for recursive
// scratch cleanup. Codex can reject raw `rm -rf` before the command reaches
// Hydra's outer sandbox, even though that sandbox is the actual filesystem
// boundary. The helper is deliberately narrower than rm: every target must be
// an absolute descendant of this head's worktree or private temporary directory.
var sandboxRemoveCmd = &cobra.Command{
	Use:    "sandbox-remove <absolute-path>...",
	Short:  "Internal: recursively remove paths inside a head's private writable roots",
	Hidden: true,
	Args:   cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return errtrace.Wrap(removeSandboxPaths(args, os.Getenv("HYDRA_WORKTREE"), os.Getenv("TMPDIR")))
	},
}

type sandboxRemoval struct {
	root string
	rel  string
}

// removeSandboxPaths validates the complete request before removing anything.
// os.Root supplies the traversal-safe boundary: a symlink below an allowed root
// cannot redirect RemoveAll outside it between validation and deletion.
func removeSandboxPaths(targets []string, worktree, tempDir string) error {
	roots := uniqueCleanRoots(worktree, tempDir)
	if len(roots) == 0 {
		return errtrace.Errorf("sandbox-remove requires HYDRA_WORKTREE or TMPDIR")
	}

	removals := make([]sandboxRemoval, 0, len(targets))
	for _, target := range targets {
		if !filepath.IsAbs(target) {
			return errtrace.Errorf("sandbox-remove target must be absolute: %q", target)
		}
		cleanTarget := filepath.Clean(target)
		matched := false
		for _, root := range roots {
			rel, err := filepath.Rel(root, cleanTarget)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
				continue
			}
			if rel == "." {
				return errtrace.Errorf("sandbox-remove refuses writable root itself: %q", target)
			}
			removals = append(removals, sandboxRemoval{root: root, rel: rel})
			matched = true
			break
		}
		if !matched {
			return errtrace.Errorf("sandbox-remove target is outside the head worktree and private temporary directory: %q", target)
		}
	}

	for _, removal := range removals {
		root, err := os.OpenRoot(removal.root)
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("open removal root %q: %w", removal.root, err))
		}
		err = root.RemoveAll(removal.rel)
		closeErr := root.Close()
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("remove %q: %w", filepath.Join(removal.root, removal.rel), err))
		}
		if closeErr != nil {
			return errtrace.Wrap(fmt.Errorf("close removal root %q: %w", removal.root, closeErr))
		}
	}
	return nil
}

func uniqueCleanRoots(paths ...string) []string {
	roots := make([]string, 0, len(paths))
	seen := make(map[string]bool, len(paths))
	for _, path := range paths {
		if path == "" || !filepath.IsAbs(path) {
			continue
		}
		path = filepath.Clean(path)
		if !seen[path] {
			seen[path] = true
			roots = append(roots, path)
		}
	}
	return roots
}
