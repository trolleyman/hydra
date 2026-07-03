package heads

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// maxHeadIDLen caps auto-generated head IDs (the explicit-ID limit in
// ValidateHeadID is looser). Matches the slug length the web UI used to
// generate, so IDs keep looking the same.
const maxHeadIDLen = 40

// ErrInvalidHeadID is wrapped by every ValidateHeadID failure.
var ErrInvalidHeadID = errors.New("invalid head ID")

// headIDRe matches explicitly-provided head IDs. The ID becomes both the
// branch name (hydra/<id>) and the worktree directory name, so it must be a
// valid git ref component and must not be able to escape the worktrees dir.
var headIDRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

// ValidateHeadID rejects explicitly-provided IDs that could not serve as a git
// branch component or worktree directory name. Auto-generated IDs are already
// shaped by slugifyHeadID and need no validation.
func ValidateHeadID(id string) error {
	switch {
	case id == "":
		return errtrace.Wrap(fmt.Errorf("%w: empty", ErrInvalidHeadID))
	case len(id) > 100:
		return errtrace.Wrap(fmt.Errorf("%w: %q is longer than 100 characters", ErrInvalidHeadID, id))
	case !headIDRe.MatchString(id):
		return errtrace.Wrap(fmt.Errorf("%w: %q may only contain letters, digits, '.', '_' and '-', and must start with a letter or digit", ErrInvalidHeadID, id))
	case strings.Contains(id, ".."), strings.HasSuffix(id, "."), strings.HasSuffix(id, ".lock"):
		// git ref-name rules: no "..", no trailing "." or ".lock".
		return errtrace.Wrap(fmt.Errorf("%w: %q is not a valid git branch component", ErrInvalidHeadID, id))
	}
	return nil
}

// HeadExistsError reports a spawn ID collision with an existing head (active
// or archived, possibly in another project) or with leftover git state.
type HeadExistsError struct {
	ID          string
	ProjectPath string // project of the existing head; "" for a bare branch/worktree collision
	SameProject bool
	Archived    bool
}

func (e *HeadExistsError) Error() string {
	switch {
	case e.ProjectPath == "":
		return fmt.Sprintf("branch hydra/%s or its worktree already exists in this repository", e.ID)
	case !e.SameProject:
		return fmt.Sprintf("head ID %q is already used by a head in project %s", e.ID, e.ProjectPath)
	case e.Archived:
		return fmt.Sprintf("head ID %q is already used by an archived head; pick a different ID or replace it (hydra spawn --force)", e.ID)
	default:
		return fmt.Sprintf("head %q already exists in this project", e.ID)
	}
}

// slugifyHeadID turns free text into a head-ID slug: lowercase, path/word
// separators become hyphens, everything else non-alphanumeric is dropped, and
// the result is clamped to maxLen preferring a hyphen boundary. Mirrors the
// slug shape the web UI historically produced, so auto-generated IDs keep
// reading the same.
var (
	slugSeparators = strings.NewReplacer("/", " ", "\\", " ", "_", " ", ".", " ")
	slugDropRe     = regexp.MustCompile(`[^a-z0-9\s-]`)
	slugHyphenRe   = regexp.MustCompile(`[\s-]+`)
)

func slugifyHeadID(text string, maxLen int) string {
	slug := strings.ToLower(slugSeparators.Replace(text))
	slug = slugDropRe.ReplaceAllString(slug, "")
	slug = slugHyphenRe.ReplaceAllString(strings.TrimSpace(slug), "-")
	if len(slug) > maxLen {
		if cut := strings.LastIndex(slug[:maxLen+1], "-"); cut > 0 {
			slug = slug[:cut]
		} else {
			slug = slug[:maxLen]
		}
	}
	return strings.Trim(slug, "-")
}

// GenerateHeadID derives a head-ID slug from the first words of the prompt,
// e.g. "Can you change the tests here to use ..." →
// "can-you-change-the-tests-here-to-use". Returns "" when the prompt has no
// usable characters (the caller falls back to a random ID).
func GenerateHeadID(prompt string) string {
	words := strings.Fields(prompt)
	if len(words) > 8 {
		words = words[:8]
	}
	return slugifyHeadID(strings.Join(words, " "), maxHeadIDLen)
}

// uniqueHeadID returns base if it is free, else the first free "base-2",
// "base-3", ... candidate (base is truncated so candidates stay within
// maxHeadIDLen). If a hundred numbered candidates are somehow all taken it
// falls back to a random hex suffix.
func uniqueHeadID(base string, taken func(string) bool) string {
	if !taken(base) {
		return base
	}
	for i := 2; i < 100; i++ {
		suffix := fmt.Sprintf("-%d", i)
		cand := slugifyHeadID(base, maxHeadIDLen-len(suffix)) + suffix
		if !taken(cand) {
			return cand
		}
	}
	suffix := "-" + randomHeadID()
	return slugifyHeadID(base, maxHeadIDLen-len(suffix)) + suffix
}

// randomHeadID returns the 8-hex-char random ID used when a prompt yields no
// usable slug.
func randomHeadID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is effectively fatal elsewhere; a constant here
		// still gets uniquified by the caller's taken() loop.
		return "head"
	}
	return hex.EncodeToString(b)
}

// headWorktreeExists reports whether the head's worktree directory exists.
func headWorktreeExists(projectRoot, id string) bool {
	_, err := os.Stat(paths.GetWorktreeDirFromProjectRoot(projectRoot, id))
	return err == nil
}

// headIDTaken reports whether an ID is unusable for a new head in projectRoot:
// a DB record exists anywhere (any project, archived included - the ID is a
// global primary key), or the project already has the branch or worktree
// directory (leftover state the DB may not know about).
func headIDTaken(store *db.Store, projectRoot, id string) bool {
	if store != nil {
		if a, err := store.GetAgentAny(id); err != nil || a != nil {
			// A read error counts as taken: better to suffix than to collide.
			return true
		}
	}
	return git.BranchExists(projectRoot, "hydra/"+id) || headWorktreeExists(projectRoot, id)
}

// pickUniqueHeadID derives a free head ID from the prompt for projectRoot,
// falling back to a random ID for prompts with no usable characters.
func pickUniqueHeadID(store *db.Store, projectRoot, prompt string) string {
	base := GenerateHeadID(prompt)
	if base == "" {
		base = randomHeadID()
	}
	return uniqueHeadID(base, func(id string) bool { return headIDTaken(store, projectRoot, id) })
}
