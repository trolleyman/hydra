package http

import "testing"

func TestAbbreviateHome(t *testing.T) {
	cases := []struct {
		name, path, home, want string
	}{
		{"under home", "/home/user/code/hydra", "/home/user", "~/code/hydra"},
		{"exactly home", "/home/user", "/home/user", "~"},
		{"home with trailing slash", "/home/user/code", "/home/user/", "~/code"},
		{"outside home", "/srv/repos/hydra", "/home/user", "/srv/repos/hydra"},
		// A sibling directory sharing the prefix must not be abbreviated -
		// matching is per path component.
		{"prefix but not component", "/home/user2/code", "/home/user", "/home/user2/code"},
		{"empty home", "/home/user/code", "", "/home/user/code"},
		{"root home", "/anything", "/", "/anything"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := abbreviateHome(c.path, c.home); got != c.want {
				t.Errorf("abbreviateHome(%q, %q) = %q, want %q", c.path, c.home, got, c.want)
			}
		})
	}
}
