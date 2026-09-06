package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A symlink<->regular-file conversion is a git "type change": git emits two
// `diff --git a/PATH b/PATH` stanzas for the same path (a deletion of the old
// object and an addition of the new one). parseDiff must collapse them into one
// modified entry so the file tree shows a single row instead of duplicate
// add/delete rows (which also collide as duplicate React keys in the UI).
func TestParseDiffCoalescesSymlinkTypeChange(t *testing.T) {
	// CLAUDE.md: symlink (mode 120000) -> regular file (mode 100644).
	// GEMINI.md: regular file (mode 100644) -> symlink (mode 120000).
	raw := `diff --git a/CLAUDE.md b/CLAUDE.md
deleted file mode 120000
index aaaaaaa..0000000
--- a/CLAUDE.md
+++ /dev/null
@@ -1 +0,0 @@
-GEMINI.md
\ No newline at end of file
diff --git a/CLAUDE.md b/CLAUDE.md
new file mode 100644
index 0000000..bbbbbbb
--- /dev/null
+++ b/CLAUDE.md
@@ -0,0 +1,2 @@
+# Project
+real contents now
diff --git a/GEMINI.md b/GEMINI.md
deleted file mode 100644
index ccccccc..0000000
--- a/GEMINI.md
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
diff --git a/GEMINI.md b/GEMINI.md
new file mode 120000
index 0000000..ddddddd
--- /dev/null
+++ b/GEMINI.md
@@ -0,0 +1 @@
+CLAUDE.md
\ No newline at end of file
`

	files, err := parseDiff(raw)
	if err != nil {
		t.Fatalf("parseDiff: %v", err)
	}

	if len(files) != 2 {
		paths := make([]string, len(files))
		for i, f := range files {
			paths[i] = f.Path
		}
		t.Fatalf("expected 2 coalesced files, got %d: %v", len(files), paths)
	}

	byPath := map[string]DiffFile{}
	for _, f := range files {
		if _, dup := byPath[f.Path]; dup {
			t.Fatalf("path %q appears more than once after coalescing", f.Path)
		}
		byPath[f.Path] = f
	}

	claude := byPath["CLAUDE.md"]
	if claude.ChangeType != "modified" {
		t.Errorf("CLAUDE.md change type = %q, want modified", claude.ChangeType)
	}
	if claude.Additions != 2 || claude.Deletions != 1 {
		t.Errorf("CLAUDE.md +%d -%d, want +2 -1", claude.Additions, claude.Deletions)
	}
	if len(claude.Hunks) != 2 {
		t.Errorf("CLAUDE.md hunks = %d, want 2 (deletion + addition)", len(claude.Hunks))
	}

	gemini := byPath["GEMINI.md"]
	if gemini.ChangeType != "modified" {
		t.Errorf("GEMINI.md change type = %q, want modified", gemini.ChangeType)
	}
	if gemini.Additions != 1 || gemini.Deletions != 2 {
		t.Errorf("GEMINI.md +%d -%d, want +1 -2", gemini.Additions, gemini.Deletions)
	}
}

// A genuine rename keeps a distinct old/new path and must not be coalesced.
func TestParseDiffKeepsRename(t *testing.T) {
	raw := `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`
	files, err := parseDiff(raw)
	if err != nil {
		t.Fatalf("parseDiff: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(files))
	}
	if files[0].ChangeType != "renamed" {
		t.Errorf("change type = %q, want renamed", files[0].ChangeType)
	}
	if files[0].OldPath == nil || *files[0].OldPath != "old.txt" {
		t.Errorf("old path = %v, want old.txt", files[0].OldPath)
	}
	if files[0].Path != "new.txt" {
		t.Errorf("path = %q, want new.txt", files[0].Path)
	}
}

// A diff scoped to a renamed-and-modified file's NEW name must still come back as
// a rename with its real additions/deletions - not as a brand-new add of the
// whole file. git only pairs a rename when both names are in the pathspec, so
// GetDiff widens the pathspec with the old name (regression test for the diff
// viewer showing renamed files as entirely added).
func TestGetDiffScopedRenameKeepsRename(t *testing.T) {
	dir := gitInit(t)
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("old.txt", "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n")
	run("add", ".")
	run("commit", "-qm", "first")
	base, err := ResolveRef(dir, "HEAD")
	if err != nil {
		t.Fatal(err)
	}

	// Rename old.txt -> new.txt and change one line plus add one line: high enough
	// similarity that git detects the rename in an unscoped diff.
	run("mv", "old.txt", "new.txt")
	write("new.txt", "line1\nline2-changed\nline3\nline4\nline5\nline6\nline7\nline8\nline9-added\n")
	run("commit", "-aqm", "rename")
	head, err := ResolveRef(dir, "HEAD")
	if err != nil {
		t.Fatal(err)
	}

	// Scope to the new path only - the case the diff viewer fetches per file.
	files, err := GetDiff(dir, base, head, false, false, "new.txt", 3)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}

	var f *DiffFile
	for i := range files {
		if files[i].Path == "new.txt" {
			f = &files[i]
		}
	}
	if f == nil {
		t.Fatalf("new.txt not in scoped diff; got %d files", len(files))
	}
	if f.ChangeType != "renamed" {
		t.Errorf("change type = %q, want renamed (a scoped diff lost rename detection)", f.ChangeType)
	}
	if f.OldPath == nil || *f.OldPath != "old.txt" {
		t.Errorf("old path = %v, want old.txt", f.OldPath)
	}
	// The real change is +2/-1, not the whole-file add the bug produced.
	if f.Additions != 2 || f.Deletions != 1 {
		t.Errorf("+%d -%d, want +2 -1", f.Additions, f.Deletions)
	}
}

func TestGetBlobDiffShowsOnlyChangesAfterViewedVersion(t *testing.T) {
	dir := gitInit(t)
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	write := func(content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, "review.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("base\n")
	run("add", "review.txt")
	run("commit", "-qm", "base")
	write("base\nfirst reviewed change\n")
	viewedSHA := HeadBlobSHAs(dir, "", []string{"review.txt"})["review.txt"]
	if viewedSHA == "" {
		t.Fatal("working-tree viewed blob was not hashed")
	}
	// The working file can move on after the reviewed version. The earlier
	// hash-object -w must have kept that exact baseline available in Git.
	write("base\nfirst reviewed change\nnew after review\n")
	currentSHA := HeadBlobSHAs(dir, "", []string{"review.txt"})["review.txt"]
	if typ := run("cat-file", "-t", viewedSHA); typ != "blob" {
		t.Fatalf("viewed object type = %q, want blob", typ)
	}

	files, err := GetBlobDiff(dir, viewedSHA, currentSHA, "review.txt", false, 3)
	if err != nil {
		t.Fatalf("GetBlobDiff: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("GetBlobDiff returned %d files, want 1", len(files))
	}
	f := files[0]
	if f.Path != "review.txt" || f.HeadBlobSHA != currentSHA {
		t.Fatalf("file identity = path %q, sha %q; want review.txt, %q", f.Path, f.HeadBlobSHA, currentSHA)
	}
	if f.Additions != 1 || f.Deletions != 0 {
		t.Fatalf("changes since viewed = +%d -%d, want +1 -0", f.Additions, f.Deletions)
	}
	for _, hunk := range f.Hunks {
		for _, line := range hunk.Lines {
			if line.Type != DiffLineContext && line.Content == "first reviewed change" {
				t.Fatal("the already-viewed change appeared as a new change")
			}
		}
	}
}

// TotalLines is filled in from LastLineNum over a full-context diff, on the
// premise that a diff spanning the whole file ends on the file's last line. The
// windowed view's trailing expander counts with it, so if the premise is wrong
// the reader is told the wrong number of hidden lines. Checked against a real
// `git diff -U<huge>`, including the file whose last line has no newline (git
// appends a `\ No newline at end of file` marker line, which carries no line
// number of its own and must not be mistaken for one).
func TestFullContextDiffEndsOnTheLastLine(t *testing.T) {
	dir := gitInit(t)
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	lines := func(n int, changed int, trailingNewline bool) string {
		s := ""
		for i := 1; i <= n; i++ {
			s += "line" + string(rune('0'+i%10))
			if i == changed {
				s += "-changed"
			}
			if i < n || trailingNewline {
				s += "\n"
			}
		}
		return s
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("newline.txt", lines(30, 0, true))
	write("nonewline.txt", lines(30, 0, false))
	run("add", ".")
	run("commit", "-qm", "first")
	base, err := ResolveRef(dir, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	// A change in the middle, so a windowed diff would stop well short of the end.
	write("newline.txt", lines(30, 15, true))
	write("nonewline.txt", lines(30, 15, false))
	run("commit", "-aqm", "second")
	head, err := ResolveRef(dir, "HEAD")
	if err != nil {
		t.Fatal(err)
	}

	files, err := GetDiff(dir, base, head, false, false, "", 1_000_000)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("got %d files, want 2", len(files))
	}
	for _, f := range files {
		if got := f.LastLineNum(); got != 30 {
			t.Errorf("%s: LastLineNum = %d, want 30", f.Path, got)
		}
	}

	// The windowed diff of the same commit stops at the change plus its context -
	// which is precisely why the length has to be carried alongside it.
	windowed, err := GetDiff(dir, base, head, false, false, "", 3)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if got := windowed[0].LastLineNum(); got >= 30 {
		t.Errorf("windowed LastLineNum = %d, want short of the file's 30 lines", got)
	}
}

// A path with a space in it, a rename, and an untracked file - the three shapes
// that broke when the summary was parsed from plain (non -z) porcelain output:
// git quotes and C-escapes the spaced path, and a rename's source path shares
// the entry with its destination.
func TestGetUncommittedSummaryPaths(t *testing.T) {
	dir := gitInit(t)
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("a file.txt", "one\n")
	write("old.txt", "keep\n")
	run("add", ".")
	run("commit", "-qm", "first")

	write("a file.txt", "two\n")
	run("mv", "old.txt", "new.txt")
	write("untracked one.txt", "hi\n")

	s, err := GetUncommittedSummary(dir)
	if err != nil {
		t.Fatalf("GetUncommittedSummary: %v", err)
	}
	if s.TrackedCount != 2 || s.UntrackedCount != 1 {
		t.Fatalf("counts = %d tracked / %d untracked, want 2/1 (files: %v, %v)",
			s.TrackedCount, s.UntrackedCount, s.TrackedFiles, s.UntrackedFiles)
	}
	want := map[string]bool{"a file.txt": true, "old.txt -> new.txt": true}
	for _, f := range s.TrackedFiles {
		if !want[f] {
			t.Errorf("unexpected tracked path %q, want one of %v", f, want)
		}
		delete(want, f)
	}
	if len(want) != 0 {
		t.Errorf("missing tracked paths %v", want)
	}
	if len(s.UntrackedFiles) != 1 || s.UntrackedFiles[0] != "untracked one.txt" {
		t.Errorf("untracked = %v, want [untracked one.txt]", s.UntrackedFiles)
	}
}
