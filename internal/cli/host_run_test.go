package cli

import (
	"strings"
	"testing"
)

func TestHostRunCommandText(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "single argument is already a script",
			args: []string{"echo hi; echo bye"},
			want: "echo hi; echo bye",
		},
		{
			name: "plain words need no quoting",
			args: []string{"go", "test", "./..."},
			want: "go test ./...",
		},
		{
			name: "a word with spaces stays one word",
			args: []string{"git", "commit", "-m", "hello world"},
			want: "git commit -m 'hello world'",
		},
		{
			name: "shell metacharacters are quoted, not interpreted",
			args: []string{"grep", "-E", ":266[0-9][0-9]", "ports.txt"},
			want: `grep -E ':266[0-9][0-9]' ports.txt`,
		},
		{
			name: "a literal single quote survives",
			args: []string{"echo", "it's"},
			want: `echo 'it'\''s'`,
		},
		{
			name: "an empty word is preserved",
			args: []string{"test", "-z", ""},
			want: "test -z ''",
		},
		{
			name: "bash -c is unwrapped to its script",
			args: []string{"bash", "-c", "echo one; echo two"},
			want: "echo one; echo two",
		},
		{
			name: "bash -lc and an absolute bash path unwrap too",
			args: []string{"/usr/bin/bash", "-lc", "ss -Hltn | grep 266"},
			want: "ss -Hltn | grep 266",
		},
		{
			name: "bash -c with trailing $0/$1 words is not unwrapped",
			args: []string{"bash", "-c", "echo $1", "argv0", "one"},
			want: "bash -c 'echo $1' argv0 one",
		},
		{
			name: "sh -c keeps its wrapper (different dialect)",
			args: []string{"sh", "-c", "echo hi"},
			want: "sh -c 'echo hi'",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hostRunCommandText(tt.args); got != tt.want {
				t.Errorf("hostRunCommandText(%q) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func TestTakeWhyFlag(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantWhy  string
		wantRest []string
	}{
		{"absent", []string{"--", "ls"}, "", []string{"--", "ls"}},
		{"separate value", []string{"--why", "because", "--", "ls"}, "because", []string{"--", "ls"}},
		{"equals form", []string{"--why=because", "--", "ls"}, "because", []string{"--", "ls"}},
		{"description alias", []string{"--description", "because", "ls"}, "because", []string{"ls"}},
		{"trimmed", []string{"--why", "  spaced  ", "ls"}, "spaced", []string{"ls"}},
		{"empty value is no explanation", []string{"--why=", "ls"}, "", []string{"ls"}},
		// Only the FRONT of the argv is scanned: past the command, --why is the
		// command's own argument and must survive untouched.
		{"inside the command", []string{"--", "mytool", "--why", "x"}, "", []string{"--", "mytool", "--why", "x"}},
		{"unflagged command wins", []string{"echo", "--why", "x"}, "", []string{"echo", "--why", "x"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			why, rest, errMsg := takeWhyFlag(tc.args)
			if errMsg != "" {
				t.Fatalf("unexpected error: %s", errMsg)
			}
			if why != tc.wantWhy {
				t.Errorf("why = %q, want %q", why, tc.wantWhy)
			}
			if strings.Join(rest, "\x00") != strings.Join(tc.wantRest, "\x00") {
				t.Errorf("rest = %q, want %q", rest, tc.wantRest)
			}
		})
	}
}

func TestTakeWhyFlagMissingValue(t *testing.T) {
	if _, _, errMsg := takeWhyFlag([]string{"--why"}); errMsg == "" {
		t.Error("a trailing --why with no value should be reported as a usage error")
	}
}

// A long explanation is capped: it rides in an approval card and an OS
// notification, neither of which can show an essay.
func TestTakeWhyFlagCapsLength(t *testing.T) {
	why, _, errMsg := takeWhyFlag([]string{"--why", strings.Repeat("x", maxWhyLen*2), "ls"})
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if len(why) > maxWhyLen+3 {
		t.Errorf("why length = %d, want it capped near %d", len(why), maxWhyLen)
	}
	if !strings.HasSuffix(why, "...") {
		t.Errorf("a truncated explanation should be marked with an ellipsis, got %q", why[max(0, len(why)-10):])
	}
}

func TestFirstLine(t *testing.T) {
	if got := firstLine("one\ntwo"); got != "one" {
		t.Errorf("firstLine = %q, want %q", got, "one")
	}
	if got := firstLine("only"); got != "only" {
		t.Errorf("firstLine = %q, want %q", got, "only")
	}
}
