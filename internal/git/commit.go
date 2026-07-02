package git

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"braces.dev/errtrace"
)

// UncommittedFile is one dirty path reported by `git status`.
type UncommittedFile struct {
	Path   string
	Status string // modified|added|deleted|renamed|copied|conflicted|untracked
}

// ListUncommittedFiles returns every path in the repository at dir with
// uncommitted changes (staged, unstaged or untracked), in git's status order.
func ListUncommittedFiles(dir string) ([]UncommittedFile, error) {
	// -z separates entries with NULs and disables path quoting, so paths with
	// spaces or non-ASCII bytes come through verbatim. -uall lists the files
	// inside untracked directories instead of collapsing them to "dir/".
	out, err := gitOutput(dir, "status", "--porcelain=v1", "-z", "-uall")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var files []UncommittedFile
	entries := strings.Split(out, "\x00")
	for i := 0; i < len(entries); i++ {
		e := entries[i]
		if len(e) < 4 {
			continue
		}
		x, y := e[0], e[1]
		files = append(files, UncommittedFile{Path: e[3:], Status: statusLabel(x, y)})
		// A rename/copy entry is followed by the original path as its own
		// NUL-separated field; it belongs to this entry, not the next one.
		if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
			i++
		}
	}
	return files, nil
}

// statusLabel condenses porcelain XY status codes into one UI-facing word.
func statusLabel(x, y byte) string {
	switch {
	case x == '?':
		return "untracked"
	case x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D'):
		return "conflicted"
	}
	c := x
	if c == ' ' {
		c = y
	}
	switch c {
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	default: // M, T and anything exotic read best as a plain modification.
		return "modified"
	}
}

// CommitAll stages every change in the repository at dir (tracked and
// untracked) and commits it with the given message. The author/committer
// identity falls back to Hydra's like Merge, so it works even when the host
// has no git identity configured.
func CommitAll(dir, message, authorName, authorEmail string) error {
	if strings.TrimSpace(message) == "" {
		return errtrace.Wrap(fmt.Errorf("commit message must not be empty"))
	}
	if _, err := gitOutput(dir, "add", "-A"); err != nil {
		return errtrace.Wrap(err)
	}
	if authorName == "" {
		authorName = "Hydra Agent"
	}
	if authorEmail == "" {
		authorEmail = "hydra@trolleyman.org"
	}
	cmd := exec.Command("git", "-C", dir, "commit", "-q", "-m", message)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME="+authorName,
		"GIT_AUTHOR_EMAIL="+authorEmail,
		"GIT_COMMITTER_NAME="+authorName,
		"GIT_COMMITTER_EMAIL="+authorEmail,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git commit: %w: %s", err, strings.TrimSpace(string(out))))
	}
	return nil
}
