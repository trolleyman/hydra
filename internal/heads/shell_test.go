package heads

import "testing"

func TestShellSessionID(t *testing.T) {
	cases := []struct {
		name      string
		head      string
		sandboxed bool
		token     string
		want      string
	}{
		{"sandboxed with token", "abc", true, "bash-123", "abc-shell-bash-123"},
		{"host with token", "abc", false, "bash-123", "abc-shell-host-bash-123"},
		{"no token", "abc", true, "", "abc-shell"},
		{"token sanitized", "abc", true, "../../etc/passwd", "abc-shell-etcpasswd"},
		{"token slashes dropped", "abc", false, "a/b\\c", "abc-shell-host-abc"},
	}
	for _, c := range cases {
		if got := ShellSessionID(c.head, c.sandboxed, c.token); got != c.want {
			t.Errorf("%s: ShellSessionID(%q,%v,%q) = %q, want %q", c.name, c.head, c.sandboxed, c.token, got, c.want)
		}
	}
}

// The KillMatching("<head>-shell") sweep must not catch a different head whose ID
// merely starts with this head's ID (e.g. "foo" vs "foobar"): the "-shell"
// boundary keeps the prefix unambiguous.
func TestShellSessionIDPrefixBoundary(t *testing.T) {
	foo := ShellSessionID("foo", true, "t")
	foobar := ShellSessionID("foobar", true, "t")
	if prefix := "foo" + "-shell"; len(foobar) >= len(prefix) && foobar[:len(prefix)] == prefix {
		t.Errorf("foobar shell %q wrongly matches prefix %q", foobar, prefix)
	}
	if prefix := "foo" + "-shell"; foo[:len(prefix)] != prefix {
		t.Errorf("foo shell %q should match prefix %q", foo, prefix)
	}
}
