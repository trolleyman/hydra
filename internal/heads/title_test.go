package heads

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeriveTitle(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
		want   string
	}{
		{"empty", "", ""},
		{"whitespace only", "   \n\t  ", ""},
		{"simple", "Fix the login bug", "Fix the login bug"},
		{"first line only", "Refactor auth\nthen test it", "Refactor auth"},
		{"skips blank lines", "\n\n  Add dark mode  ", "Add dark mode"},
		{"strips markdown markers", "## Implement the parser", "Implement the parser"},
		{"strips bullet", "- do the thing", "do the thing"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DeriveTitle(tt.prompt); got != tt.want {
				t.Errorf("DeriveTitle(%q) = %q, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}

func TestDeriveTitleTruncates(t *testing.T) {
	long := strings.Repeat("word ", 40) // ~200 chars
	got := DeriveTitle(long)
	if len([]rune(got)) > maxTitleLen+3 { // +3 for the "..." ellipsis
		t.Errorf("DeriveTitle did not clamp length: got %d runes (%q)", len([]rune(got)), got)
	}
	if !strings.HasSuffix(got, "...") {
		t.Errorf("expected truncated title to end with ellipsis, got %q", got)
	}
}

func TestInlineUploadRefs(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	textPath := write("123-pasted-text-1.txt", "Fix the scaling on the main monitor when it wakes from sleep")
	imgPath := write("456-screenshot.png", "\x89PNG\x00binary")

	t.Run("inlines pasted text", func(t *testing.T) {
		prompt := "Look at this\n\n" + textPath
		got := inlineUploadRefs(prompt, dir)
		want := "Look at this\n\nFix the scaling on the main monitor when it wakes from sleep"
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("reduces image path to filename", func(t *testing.T) {
		got := inlineUploadRefs("See\n\n"+imgPath, dir)
		want := "See\n\n456-screenshot.png"
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("leaves non-upload paths untouched", func(t *testing.T) {
		prompt := "Edit /etc/hosts and src/main.go please"
		if got := inlineUploadRefs(prompt, dir); got != prompt {
			t.Errorf("got %q, want unchanged %q", got, prompt)
		}
	})

	t.Run("missing upload falls back to filename", func(t *testing.T) {
		missing := filepath.Join(dir, "789-gone.txt")
		got := inlineUploadRefs("do it\n\n"+missing, dir)
		want := "do it\n\n789-gone.txt"
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("truncates a large paste", func(t *testing.T) {
		big := write("999-big.txt", strings.Repeat("x", maxInlineUploadBytes*2))
		got := inlineUploadRefs(big, dir)
		if !strings.HasSuffix(got, "\n...") {
			t.Errorf("expected truncation marker, got tail %q", got[len(got)-10:])
		}
		if len(got) > maxInlineUploadBytes+len("\n...") {
			t.Errorf("snippet not bounded: %d bytes", len(got))
		}
	})

	t.Run("empty uploads dir is a no-op", func(t *testing.T) {
		prompt := "hello\n\n" + textPath
		if got := inlineUploadRefs(prompt, ""); got != prompt {
			t.Errorf("got %q, want unchanged", got)
		}
	})
}

func TestSanitizeGeneratedTitle(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want string
	}{
		{"plain", "Fix login bug", "Fix login bug"},
		{"strips quotes", "\"Fix login bug\"", "Fix login bug"},
		{"strips backticks", "`Add dark mode`", "Add dark mode"},
		{"first non-empty line", "\n\nAuth refactor\nignored", "Auth refactor"},
		{"trailing newline", "Title here\n", "Title here"},
		{"empty", "", ""},
		{"whitespace only", "  \n\t\n", ""},
		// Wording is no longer second-guessed: an odd answer is passed through
		// (and clamped) rather than silently dropped. See sanitizeGeneratedTitle.
		{"question is kept", "Which file did you mean?", "Which file did you mean?"},
		{
			"long answer is clamped, not rejected",
			"This task appears to be about fixing the way the main monitor handles scaling on wake",
			"This task appears to be about fixing the way the main...",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeGeneratedTitle(tt.out); got != tt.want {
				t.Errorf("sanitizeGeneratedTitle(%q) = %q, want %q", tt.out, got, tt.want)
			}
		})
	}
}
