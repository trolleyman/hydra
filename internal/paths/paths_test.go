package paths

import "testing"

func TestResolveUserPath(t *testing.T) {
	const home = "/home/tester"
	tests := []struct {
		name string
		in   string
		home string
		want string
	}{
		{"absolute is kept", "/srv/code/hydra", home, "/srv/code/hydra"},
		{"absolute is cleaned", "/srv/code/../code/hydra/", home, "/srv/code/hydra"},
		{"bare tilde is home", "~", home, home},
		{"tilde slash expands", "~/code/hydra", home, "/home/tester/code/hydra"},
		{"tilde slash is cleaned", "~/code/../code/hydra", home, "/home/tester/code/hydra"},
		{"surrounding whitespace is trimmed", "  ~/code/hydra  ", home, "/home/tester/code/hydra"},
		{"relative resolves against home", "code/hydra", home, "/home/tester/code/hydra"},
		{"dot-relative resolves against home", "./code/hydra", home, "/home/tester/code/hydra"},
		{"empty stays empty", "   ", home, ""},
		// Another user's home is not something we can expand, so it is passed
		// through verbatim rather than turned into $HOME/~someone.
		{"other user's home is untouched", "~someone/code", home, "~someone/code"},
		// Without a home directory a tilde has nothing to expand to.
		{"no home leaves tilde alone", "~/code", "", "~/code"},
		{"no home keeps absolute", "/srv/code", "", "/srv/code"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveUserPath(tt.in, tt.home); got != tt.want {
				t.Errorf("resolveUserPath(%q, %q) = %q, want %q", tt.in, tt.home, got, tt.want)
			}
		})
	}
}
