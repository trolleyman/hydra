package git

import "testing"

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
