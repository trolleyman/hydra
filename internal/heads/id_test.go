package heads

import (
	"errors"
	"strings"
	"testing"
)

func TestGenerateHeadID(t *testing.T) {
	tests := []struct {
		prompt, want string
	}{
		// Matches the slug shape the web UI used to generate.
		{"Can you change the tests here to use table-driven style?", "can-you-change-the-tests-here-to-use"},
		{"Fix the bug", "fix-the-bug"},
		{"  Fix   the\n bug  ", "fix-the-bug"},
		// Path/word separators become hyphens instead of being glued together.
		{"fix internal/heads/heads.go spawn_head", "fix-internal-heads-heads-go-spawn-head"},
		// Only the first 8 words contribute.
		{"one two three four five six seven eight nine ten", "one-two-three-four-five-six-seven-eight"},
		// No usable characters → empty (caller falls back to a random ID).
		{"", ""},
		{"???!!!", ""},
		{"日本語のプロンプト", ""},
	}
	for _, tt := range tests {
		if got := GenerateHeadID(tt.prompt); got != tt.want {
			t.Errorf("GenerateHeadID(%q) = %q, want %q", tt.prompt, got, tt.want)
		}
	}
	for _, tt := range tests {
		if got := GenerateHeadID(tt.prompt); len(got) > maxHeadIDLen {
			t.Errorf("GenerateHeadID(%q) = %q longer than %d", tt.prompt, got, maxHeadIDLen)
		}
	}
}

func TestSlugifyHeadIDTruncation(t *testing.T) {
	// Truncation prefers a hyphen boundary and never leaves a trailing hyphen.
	got := slugifyHeadID("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii", 40)
	if len(got) > 40 || strings.HasSuffix(got, "-") {
		t.Fatalf("slugifyHeadID returned %q (len %d)", got, len(got))
	}
	// A single overlong word gets a hard cut.
	if got := slugifyHeadID(strings.Repeat("a", 60), 40); got != strings.Repeat("a", 40) {
		t.Fatalf("hard cut: got %q", got)
	}
}

func TestUniqueHeadID(t *testing.T) {
	taken := map[string]bool{}
	isTaken := func(id string) bool { return taken[id] }

	if got := uniqueHeadID("fix-the-bug", isTaken); got != "fix-the-bug" {
		t.Fatalf("free base: got %q", got)
	}
	taken["fix-the-bug"] = true
	if got := uniqueHeadID("fix-the-bug", isTaken); got != "fix-the-bug-2" {
		t.Fatalf("first collision: got %q", got)
	}
	taken["fix-the-bug-2"] = true
	if got := uniqueHeadID("fix-the-bug", isTaken); got != "fix-the-bug-3" {
		t.Fatalf("second collision: got %q", got)
	}

	// Suffixed candidates stay within maxHeadIDLen (the base is re-truncated).
	long := "one-two-three-four-five-six-seven-eight" // 39 chars: no room for "-2"
	taken[long] = true
	got := uniqueHeadID(long, isTaken)
	if len(got) > maxHeadIDLen || !strings.HasSuffix(got, "-2") {
		t.Fatalf("suffixed candidate %q (len %d)", got, len(got))
	}
}

func TestValidateHeadID(t *testing.T) {
	for _, id := range []string{"fix-the-bug", "a1b2c3d4", "Feature_X.v2", "x"} {
		if err := ValidateHeadID(id); err != nil {
			t.Errorf("ValidateHeadID(%q) = %v, want nil", id, err)
		}
	}
	invalid := []string{
		"",
		"-leading-hyphen", // could be mistaken for a flag
		".hidden",
		"has space",
		"has/slash",
		"../escape",
		"a..b",
		"ends.",
		"ends.lock",
		strings.Repeat("a", 101),
	}
	for _, id := range invalid {
		err := ValidateHeadID(id)
		if err == nil {
			t.Errorf("ValidateHeadID(%q) = nil, want error", id)
		} else if !errors.Is(err, ErrInvalidHeadID) {
			t.Errorf("ValidateHeadID(%q) = %v, want ErrInvalidHeadID", id, err)
		}
	}
}

func TestHeadExistsErrorMessages(t *testing.T) {
	tests := []struct {
		err  HeadExistsError
		want string
	}{
		{HeadExistsError{ID: "x", ProjectPath: "/p", SameProject: true}, "already exists in this project"},
		{HeadExistsError{ID: "x", ProjectPath: "/p", SameProject: true, Archived: true}, "archived"},
		{HeadExistsError{ID: "x", ProjectPath: "/other"}, "/other"},
		{HeadExistsError{ID: "x"}, "branch hydra/x"},
	}
	for _, tt := range tests {
		if msg := tt.err.Error(); !strings.Contains(msg, tt.want) {
			t.Errorf("HeadExistsError %+v message %q does not mention %q", tt.err, msg, tt.want)
		}
	}
}
