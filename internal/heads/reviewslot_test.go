package heads

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

func TestReviewSessionIDIsASlot(t *testing.T) {
	if got, want := ReviewSessionID("abc"), "abc"+SlotSep+"review"; got != want {
		t.Errorf("ReviewSessionID = %q, want %q", got, want)
	}
	// It must be caught by the head's teardown sweep, and not be spellable as a
	// head ID (the whole point of SlotSep).
	if !strings.HasPrefix(ReviewSessionID("abc"), SlotPrefix("abc")) {
		t.Error("review session is not covered by its head's SlotPrefix sweep")
	}
	if err := ValidateHeadID(ReviewSessionID("abc")); err == nil {
		t.Error("a head could be named as another head's review slot")
	}
}

func TestReviewAgentTypeFollowsChatCapableHeadProvider(t *testing.T) {
	tests := []struct {
		head sandbox.AgentType
		want sandbox.AgentType
	}{
		{sandbox.AgentTypeClaude, sandbox.AgentTypeClaude},
		{sandbox.AgentTypeCodex, sandbox.AgentTypeCodex},
		{sandbox.AgentTypeGemini, sandbox.AgentTypeClaude},
		{sandbox.AgentTypeCopilot, sandbox.AgentTypeClaude},
		{sandbox.AgentTypeBash, sandbox.AgentTypeClaude},
	}
	for _, tt := range tests {
		if got := reviewAgentType(Head{AgentType: tt.head}); got != tt.want {
			t.Errorf("reviewAgentType(%q) = %q, want %q", tt.head, got, tt.want)
		}
	}
}

func TestCodexReviewConversationIDPersistsAcrossRestarts(t *testing.T) {
	root := t.TempDir()
	id := ReviewSessionID("h1")
	if got := readCodexSlotConversationID(root, id); got != "" {
		t.Fatalf("missing conversation ID = %q, want empty", got)
	}
	if err := writeCodexSlotConversationID(root, id, "thread-123"); err != nil {
		t.Fatalf("write conversation ID: %v", err)
	}
	if got := readCodexSlotConversationID(root, id); got != "thread-123" {
		t.Fatalf("conversation ID = %q, want %q", got, "thread-123")
	}
	removeCodexSlotConversationID(root, id)
	if got := readCodexSlotConversationID(root, id); got != "" {
		t.Fatalf("conversation ID after purge = %q, want empty", got)
	}
}

func TestReviewConversationIDDetectsClaudeTranscript(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	worktree := paths.GetReviewCheckoutDirFromProjectRoot(root, "h1")
	dir := filepath.Join(home, ".claude", "projects", paths.ClaudeProjectsSlug(worktree))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := reviewConversationID(root, ReviewSessionID("h1"), worktree, home, sandbox.AgentTypeClaude); got != "" {
		t.Fatalf("missing Claude conversation ID = %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "review-session.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := reviewConversationID(root, ReviewSessionID("h1"), worktree, home, sandbox.AgentTypeClaude); got != "review-session" {
		t.Fatalf("Claude conversation ID = %q, want review-session", got)
	}
}

func TestReviewConversationIDDetectsCodexThread(t *testing.T) {
	root := t.TempDir()
	id := ReviewSessionID("h1")
	if got := reviewConversationID(root, id, "/review", "/home", sandbox.AgentTypeCodex); got != "" {
		t.Fatalf("missing Codex conversation ID = %q", got)
	}
	if err := writeCodexSlotConversationID(root, id, "thread-123"); err != nil {
		t.Fatal(err)
	}
	if got := reviewConversationID(root, id, "/review", "/home", sandbox.AgentTypeCodex); got != "thread-123" {
		t.Fatalf("Codex conversation ID = %q, want thread-123", got)
	}
}

// The reviewer's whole purpose is that it cannot write to the repo. The MCP
// block list is one of the two enforcement layers (the other is
// GitIsolationReadonly at the OS level), so it must cover every host-mediated git
// tool the MCP server exposes - a tool added there and missed here is a silent
// hole, since readonly isolation exists precisely to leave that path open.
func TestReviewBlocksEveryGitTool(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "mcpserver", "gittools.go"))
	if err != nil {
		t.Fatalf("read gittools.go: %v", err)
	}
	// Tool names are declared as `"name": "git_*"` entries in the tool schemas.
	for line := range strings.SplitSeq(string(src), "\n") {
		_, rest, ok := strings.Cut(line, `"name":`)
		if !ok {
			continue
		}
		name := strings.Trim(strings.TrimSpace(rest), `",`)
		if !strings.HasPrefix(name, "git_") {
			continue
		}
		full := "hydra__" + name
		if !slices.Contains(reviewBlockedTools, full) {
			t.Errorf("git tool %q is exposed by the MCP server but not in reviewBlockedTools - the review slot could write to the repo", full)
		}
	}
}

func TestReviewCheckoutRefPrefersTheHeadsBranch(t *testing.T) {
	branch := "hydra/abc"
	if got := ReviewCheckoutRef(Head{Branch: &branch, BaseBranch: "main"}); got != branch {
		t.Errorf("ReviewCheckoutRef = %q, want the head's branch %q", got, branch)
	}
	// A head with no branch of its own falls back to what it was based on, rather
	// than leaving the reviewer with nothing to check out.
	if got := ReviewCheckoutRef(Head{BaseBranch: "main"}); got != "main" {
		t.Errorf("ReviewCheckoutRef with no branch = %q, want %q", got, "main")
	}
	empty := ""
	if got := ReviewCheckoutRef(Head{Branch: &empty, BaseBranch: "main"}); got != "main" {
		t.Errorf("ReviewCheckoutRef with an empty branch = %q, want %q", got, "main")
	}
}

// EnsureReviewCheckout must be idempotent, must move an existing tree to a new
// ref rather than recreating it (that is how the reviewer follows the head as it
// commits), and must recover from a checkout directory left behind by a crash.
func TestEnsureReviewCheckout(t *testing.T) {
	root := t.TempDir()
	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run(root, "init", "-b", "main")
	run(root, "config", "user.email", "t@example.com")
	run(root, "config", "user.name", "T")
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("one\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run(root, "add", "-A")
	run(root, "commit", "-m", "one")
	first := run(root, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("two\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run(root, "add", "-A")
	run(root, "commit", "-m", "two")
	second := run(root, "rev-parse", "HEAD")

	dir, err := EnsureReviewCheckout(root, "h1", first)
	if err != nil {
		t.Fatalf("EnsureReviewCheckout: %v", err)
	}
	if want := paths.GetReviewCheckoutDirFromProjectRoot(root, "h1"); dir != want {
		t.Errorf("checkout dir = %q, want %q", dir, want)
	}
	if got := run(dir, "rev-parse", "HEAD"); got != first {
		t.Errorf("checked out %q, want %q", got, first)
	}
	// Detached: the reviewer can never commit, so it must hold no branch.
	if got := run(dir, "rev-parse", "--abbrev-ref", "HEAD"); got != "HEAD" {
		t.Errorf("review checkout is on branch %q, want a detached HEAD", got)
	}

	// Syncing forward reuses the same tree.
	again, err := EnsureReviewCheckout(root, "h1", second)
	if err != nil {
		t.Fatalf("EnsureReviewCheckout (sync): %v", err)
	}
	if again != dir {
		t.Errorf("sync moved the checkout to %q, want the stable path %q", again, dir)
	}
	if got := run(dir, "rev-parse", "HEAD"); got != second {
		t.Errorf("after sync HEAD = %q, want %q", got, second)
	}

	// A directory left behind by a crash (no .git) must be reclaimed, not fatal.
	RemoveReviewCheckout(root, "h1")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "debris"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureReviewCheckout(root, "h1", first); err != nil {
		t.Fatalf("EnsureReviewCheckout over debris: %v", err)
	}
	if got := run(dir, "rev-parse", "HEAD"); got != first {
		t.Errorf("after recovery HEAD = %q, want %q", got, first)
	}

	RemoveReviewCheckout(root, "h1")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("RemoveReviewCheckout left %q behind", dir)
	}
}

// Closing the Review tab reclaims the checkout, and the reviewer's conversation
// has to survive that: it is keyed by the checkout PATH (Claude's transcript dir
// is a slug of it), so a re-open must land on the same path or --continue resumes
// nothing. This is the property that lets a close be cheap AND non-destructive.
func TestKillReviewSessionReclaimsTheCheckoutAtAStablePath(t *testing.T) {
	root := t.TempDir()
	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e",
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run(root, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("one\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run(root, "add", "-A")
	run(root, "commit", "-m", "one")

	dir, err := EnsureReviewCheckout(root, "h1", "main")
	if err != nil {
		t.Fatalf("EnsureReviewCheckout: %v", err)
	}
	tmpDir := ensureHeadTmpDir(root, ReviewSessionID("h1"))
	if tmpDir == "" {
		t.Fatal("ensureHeadTmpDir returned an empty review temp path")
	}

	// No session was ever started for this head, which is the case that must not
	// panic or leave debris - a reviewer opened and closed without the registry
	// ever knowing about it.
	KillReviewSession(session.NewRegistry(), root, "h1")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("closing the reviewer left its checkout at %q", dir)
	}
	if _, err := os.Stat(tmpDir); !os.IsNotExist(err) {
		t.Fatalf("closing the reviewer left its private temp at %q", tmpDir)
	}

	// Re-opening rebuilds the tree at the SAME path - a fresh path would be a
	// fresh transcript, i.e. a reviewer that forgot the conversation.
	again, err := EnsureReviewCheckout(root, "h1", "main")
	if err != nil {
		t.Fatalf("EnsureReviewCheckout after close: %v", err)
	}
	if again != dir {
		t.Errorf("re-opened checkout at %q, want the stable path %q", again, dir)
	}
	if got := run(again, "rev-parse", "--abbrev-ref", "HEAD"); got != "HEAD" {
		t.Errorf("re-opened checkout is on branch %q, want a detached HEAD", got)
	}
}

// The reviewer's checkout must never be the head's worktree: they would share a
// Claude transcript dir (keyed by working directory), and a read-write reviewer
// would race the head's in-flight edits.
func TestReviewCheckoutIsNotTheHeadsWorktree(t *testing.T) {
	root := t.TempDir()
	if review, worktree := paths.GetReviewCheckoutDirFromProjectRoot(root, "h1"), paths.GetWorktreeDirFromProjectRoot(root, "h1"); review == worktree {
		t.Fatalf("review checkout and head worktree are the same path: %q", review)
	}
	if got := paths.ClaudeProjectsSlug(paths.GetReviewCheckoutDirFromProjectRoot(root, "h1")); got == paths.ClaudeProjectsSlug(paths.GetWorktreeDirFromProjectRoot(root, "h1")) {
		t.Error("review checkout and head worktree share a Claude transcript slug")
	}
}

// resolveGitIsolation falls back to "off" when an agent type lacks the git tools,
// so that a head is never left unable to commit. The review slot must NOT go
// through it - being unable to commit is the point - so it passes
// GitIsolationReadonly directly. This pins the fallback's existence, so if it is
// ever removed the reviewer's deliberate bypass can be revisited too.
func TestResolveGitIsolationWouldUnIsolateAReviewer(t *testing.T) {
	if sandbox.AgentSupportsGitTools(sandbox.AgentTypeBash) {
		t.Skip("bash now supports git tools; the fallback this guards against no longer applies")
	}
	cfg := config.Config{}
	if got := resolveGitIsolation(cfg, string(sandbox.AgentTypeBash), string(sandbox.GitIsolationReadonly)); got == sandbox.GitIsolationReadonly {
		t.Skip("resolveGitIsolation no longer downgrades readonly; the review slot could use it directly")
	}
	// The fallback is live, so the reviewer bypassing it is load-bearing rather
	// than incidental. Its second enforcement layer must therefore be populated.
	if len(reviewBlockedTools) == 0 {
		t.Fatal("readonly isolation deliberately leaves the host-mediated git tools open, so the block list must not be empty")
	}
}
