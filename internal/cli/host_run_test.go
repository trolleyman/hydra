package cli

import "testing"

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
