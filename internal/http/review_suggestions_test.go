package http

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/forge"
)

func TestParseReviewSuggestionRanges(t *testing.T) {
	t.Run("forge range", func(t *testing.T) {
		got, ok := parseReviewSuggestion(forge.Note{Body: "Please use this:\n\n```suggestion\none\ntwo\n```"}, forge.Thread{Path: "a.go", StartLine: 7, Line: 8})
		if !ok || got.Start != 7 || got.End != 8 || got.Replacement != "one\ntwo" {
			t.Fatalf("suggestion = %+v, %v", got, ok)
		}
	})

	t.Run("GitLab offsets", func(t *testing.T) {
		got, ok := parseReviewSuggestion(forge.Note{Body: "```suggestion:-2+1\nreplacement\n```"}, forge.Thread{Path: "a.go", Line: 10})
		if !ok || got.Start != 8 || got.End != 11 {
			t.Fatalf("suggestion = %+v, %v", got, ok)
		}
	})

	t.Run("ambiguous blocks", func(t *testing.T) {
		_, ok := parseReviewSuggestion(forge.Note{Body: "```suggestion\na\n```\n```suggestion\nb\n```"}, forge.Thread{Path: "a.go", Line: 1})
		if ok {
			t.Fatal("two suggestion blocks should not be applied as one edit")
		}
	})

	t.Run("GitHub source context", func(t *testing.T) {
		got, ok := parseReviewSuggestion(forge.Note{
			Body:     "```suggestion\nnew value\n```",
			DiffHunk: "@@ -7,3 +7,3 @@\n context\n-old value\n+current value\n tail",
		}, forge.Thread{Path: "a.go", Line: 8})
		if !ok || got.Expected == nil || *got.Expected != "current value" {
			t.Fatalf("suggestion source = %+v, %v", got, ok)
		}
	})

	t.Run("GitLab structured payload", func(t *testing.T) {
		got, ok := parseReviewSuggestion(forge.Note{Suggestion: &forge.Suggestion{
			FromLine: 3, ToLine: 4, FromContent: "old\nvalue", ToContent: "new", Appliable: true,
		}}, forge.Thread{Path: "a.go", Line: 4})
		if !ok || got.Start != 3 || got.End != 4 || got.Expected == nil || *got.Expected != "old\nvalue" || got.Replacement != "new" {
			t.Fatalf("structured suggestion = %+v, %v", got, ok)
		}
	})
}

func TestApplySuggestionEditsBatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\nfour\nfive\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	edits := []suggestionEdit{
		{Number: 2, Path: "a.txt", Suggestion: parsedSuggestion{Start: 5, End: 5, Replacement: "FIVE\nsix"}},
		{Number: 1, Path: "a.txt", Suggestion: parsedSuggestion{Start: 2, End: 3, Replacement: "TWO"}},
	}
	if err := applySuggestionEdits(dir, edits); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(data), "one\nTWO\nfour\nFIVE\nsix\n"; got != want {
		t.Fatalf("content = %q, want %q", got, want)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("mode was not preserved: %v, %v", info, err)
	}
}

func TestApplySuggestionEditsRejectsWholeInvalidBatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	original := "one\ntwo\nthree\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	err := applySuggestionEdits(dir, []suggestionEdit{
		{Number: 1, Path: "a.txt", Suggestion: parsedSuggestion{Start: 1, End: 2, Replacement: "first"}},
		{Number: 2, Path: "a.txt", Suggestion: parsedSuggestion{Start: 2, End: 3, Replacement: "second"}},
	})
	if err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("error = %v, want overlap", err)
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil || string(data) != original {
		t.Fatalf("invalid batch changed the file: %q, %v", data, readErr)
	}
}

func TestApplySuggestionEditsRejectsChangedSource(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(path, []byte("current\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	expected := "original"
	err := applySuggestionEdits(dir, []suggestionEdit{{
		Number: 3, Path: "a.txt", Suggestion: parsedSuggestion{Start: 1, End: 1, Replacement: "new", Expected: &expected},
	}})
	if err == nil || !strings.Contains(err.Error(), "is stale") {
		t.Fatalf("error = %v, want stale suggestion", err)
	}
}

func TestApplySuggestionEditsRejectsEscapingSymlink(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("safe\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}
	err := applySuggestionEdits(dir, []suggestionEdit{{Number: 1, Path: "link.txt", Suggestion: parsedSuggestion{Start: 1, End: 1, Replacement: "unsafe"}}})
	if err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("error = %v, want escaping path", err)
	}
}
