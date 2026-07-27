package projects

import (
	"strings"
	"testing"
)

// seed builds a Manager holding the given project IDs, in order.
func seed(t *testing.T, ids ...string) *Manager {
	t.Helper()
	m := newTestManager(t)
	for _, id := range ids {
		m.projects = append(m.projects, ProjectInfo{ID: id, Path: "/tmp/" + id, Name: id})
	}
	return m
}

func order(m *Manager) string {
	ids := make([]string, 0, len(m.projects))
	for _, p := range m.ListProjects() {
		ids = append(ids, p.ID)
	}
	return strings.Join(ids, ",")
}

func TestReorderProjects(t *testing.T) {
	cases := []struct {
		name string
		ids  []string
		want string
	}{
		{"full order", []string{"c", "a", "b"}, "c,a,b"},
		// A client whose list predates a just-added project must not lose it.
		{"omitted keep relative order at the end", []string{"c"}, "c,a,b"},
		{"unknown ids ignored", []string{"zz", "b", "a"}, "b,a,c"},
		{"duplicates collapse", []string{"b", "b", "a"}, "b,a,c"},
		{"empty is a no-op", nil, "a,b,c"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := seed(t, "a", "b", "c")
			if err := m.ReorderProjects(tc.ids); err != nil {
				t.Fatalf("ReorderProjects: %v", err)
			}
			if got := order(m); got != tc.want {
				t.Errorf("order = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestReorderProjectsPersists(t *testing.T) {
	m := seed(t, "a", "b", "c")
	if err := m.ReorderProjects([]string{"c", "b", "a"}); err != nil {
		t.Fatalf("ReorderProjects: %v", err)
	}
	// A fresh Manager over the same file must see the new order - the dropdown's
	// order has to survive a daemon restart to be worth anything.
	reloaded := &Manager{filePath: m.filePath}
	if err := reloaded.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := order(reloaded); got != "c,b,a" {
		t.Errorf("reloaded order = %q, want %q", got, "c,b,a")
	}
}
