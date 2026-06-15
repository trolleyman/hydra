package sandbox

import "testing"

func TestParseMiseTrusted(t *testing.T) {
	const root = "/home/u/proj"
	const home = "/home/u"

	cases := []struct {
		name string
		out  string
		want bool
	}{
		{"trusted exact", "/home/u/proj: trusted\n", true},
		{"trusted with tilde", "~/proj: trusted\n", true},
		{"trusted among others", "~/other: untrusted\n/home/u/proj: trusted\n", true},
		{"untrusted", "/home/u/proj: untrusted\n", false},
		{"project absent", "/somewhere/else: trusted\n", false},
		{"empty output", "", false},
		{"whitespace only", "   \n\t\n", false},
		// "weird output" a wedged or unrelated `mise` might emit: no path/status
		// lines, partial lines, or noise that must never be read as trust.
		{"garbage no colon", "blah blah\nnonsense here\n", false},
		{"colon but not our path", "Error: something went wrong: trusted\n", false},
		{"status not trusted word", "/home/u/proj: trusted-ish\n", false},
		{"json-ish noise", `{"path": "/home/u/proj"}` + "\n", false},
		{"path matches but empty status", "/home/u/proj: \n", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseMiseTrusted(tc.out, root, home); got != tc.want {
				t.Errorf("parseMiseTrusted(%q) = %v, want %v", tc.out, got, tc.want)
			}
		})
	}
}

// TestMiseTrustEnvNoOp covers the early returns that don't touch mise at all.
func TestMiseTrustEnvNoOp(t *testing.T) {
	if env := MiseTrustEnv("/p", ""); env != nil {
		t.Errorf("empty runDir: got %v, want nil", env)
	}
	if env := MiseTrustEnv("/p", "/p"); env != nil {
		t.Errorf("runDir == projectRoot: got %v, want nil", env)
	}
}
