package heads

import (
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
	if len([]rune(got)) > maxTitleLen+1 { // +1 for the ellipsis rune
		t.Errorf("DeriveTitle did not clamp length: got %d runes (%q)", len([]rune(got)), got)
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("expected truncated title to end with ellipsis, got %q", got)
	}
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
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeGeneratedTitle(tt.out); got != tt.want {
				t.Errorf("sanitizeGeneratedTitle(%q) = %q, want %q", tt.out, got, tt.want)
			}
		})
	}
}
